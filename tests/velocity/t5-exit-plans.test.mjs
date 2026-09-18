// T5: every entry gets a plan; each layer fires in simulation at its trigger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlan, evaluateExit, markPosition, assertHasPlan, applyExitStamp, BLIND_EXIT_MS, WAVE_TRIM_MIN_GAIN_PCT } from "../../src/velocity/core/exits.mjs";
import { makeEvent } from "../../src/velocity/core/events.mjs";
import { EXIT_PLANS } from "../../src/velocity/core/plans.mjs";

const T0 = 1_700_000_000_000;

function pumpPos(over = {}) {
  const plan = createPlan({ venue: "pumpfun", key: 2, entry: { score: 66 } });
  return { id: "p1", venue: "pumpfun", instrument: "MintA", entryTime: T0, entryMark: 10_000, peak: 10_000, notional_usd: 20, entryScore: 66, plan, ...over };
}
function tick(mcapUsd, over = {}, at = T0 + 60_000) {
  // A normally traded token: 50 buys, and people still arriving after we filled. A fixture with an
  // empty trade list is a token nobody is trading, which is what the DOA test is for -- tests that
  // want that case pass their own list.
  const trades = [{ side: "buy", time: T0 + 500 }, { side: "buy", time: T0 + 3_000 }, { side: "buy", time: T0 + 8_000 }, { side: "sell", time: T0 + 9_000 }, { side: "buy", time: T0 + 20_000 }];
  const token = { ca: "MintA", buys: 50, sells: 10, trades, volumeSol: 20, createdAt: T0 - 120_000, uniqueBuyers: { size: 30 }, mcapUsd, vSolInBondingCurve: 20, ...over.token };
  return makeEvent({ venue: "pumpfun", kind: "tick", id: "MintA", t_venue: at - 100, t_observed: at, payload: { mcapUsd, token, dynamics: over.dynamics || { scores: 5, velocity: 0.05, acceleration: 0, trend: "stable" }, scores: over.scores || { apeScore: 66 }, vSolInBondingCurve: over.curve ?? 20 } });
}

test("T5: every venue/tier key in the table yields a complete plan", () => {
  for (const key of Object.keys(EXIT_PLANS.pumpfun)) {
    const p = createPlan({ venue: "pumpfun", key, entry: { score: 70 } });
    assert.equal(p.venue, "pumpfun");
    assert.ok(p.bondli.stopLoss > 0 && p.bondli.tpLevels.tp1 > 0 && p.max_hold_ms > 0);
    assert.equal(p.worst_case_fraction, 1);
  }
  for (const key of Object.keys(EXIT_PLANS.polymarket)) {
    const p = createPlan({ venue: "polymarket", key, entry: { price: 0.9 } });
    assert.ok(p.mode && p.max_hold_ms > 0);
  }
  const rf = createPlan({ venue: "polymarket", key: "resolved_fact", entry: { price: 0.96 } });
  assert.equal(rf.stop_price, 0.72);
  assert.throws(() => assertHasPlan({ id: "x" }), /no exit plan/);
  assert.throws(() => createPlan({ venue: "pumpfun", key: 9 }), /no exit plan/);
});

test("T5: pump.fun layers fire at their triggers", () => {
  // Layer 1: crashing score
  let pos = pumpPos();
  markPosition(pos, tick(10_500));
  // A crashing score with the price still up is not a crash: the score is derived off snapshots and
  // leaving costs a full round trip, so the price has to agree before the money moves.
  assert.equal(evaluateExit(pos, tick(10_500, { dynamics: { scores: 4, velocity: -0.5, acceleration: -0.1, trend: "crashing" } })), null, "+5% and 'crashing': held");
  let r = evaluateExit(pos, tick(9_800, { dynamics: { scores: 4, velocity: -0.5, acceleration: -0.1, trend: "crashing" } }));
  assert.equal(r.action, "SELL"); assert.equal(r.reason, "crash-exit"); assert.equal(r.layer, 1);
  // Layer 3: ride mode takes no partial profit on the way up — +40% is held, not scalped
  pos = pumpPos();
  assert.equal(evaluateExit(pos, tick(14_000)), null, "nothing is sold at +40%: the ladder is gone");
  // it comes out in one sell when it gives back its trail: peak +40%, 55% of the gain kept -> out at +22%
  markPosition(pos, tick(14_000));
  r = evaluateExit(pos, tick(12_100));
  assert.equal(r.action, "SELL"); assert.equal(r.pct, 100); assert.equal(r.reason, "RIDE-trail");
  // Layer 2: SL2 full exit past twice the stop
  pos = pumpPos();
  r = evaluateExit(pos, tick(7_000));
  assert.equal(r.action, "SELL"); assert.equal(r.reason, "SL2"); assert.equal(r.layer, 2);
  // Layer 2: SL1 partial at the stop
  pos = pumpPos();
  r = evaluateExit(pos, tick(8_700));
  assert.equal(r.action, "PARTIAL_SELL"); assert.equal(r.reason, "SL1");
  // Layer 4: graduation. Progress is (vSol - 30) / 85, so >90% needs vSol past 106.5, not 76.5:
  // at vSol 80 the token is only 59% of the way and must not be force-sold.
  pos = pumpPos();
  assert.equal(evaluateExit(pos, tick(11_000, { curve: 80, token: { vSolInBondingCurve: 80 } })), null, "59% along is not graduating");
  pos = pumpPos();
  r = evaluateExit(pos, tick(11_000, { curve: 108, token: { vSolInBondingCurve: 108 } }));
  assert.equal(r.layer, 4);
  // Max hold from the static table
  pos = pumpPos();
  r = evaluateExit(pos, tick(10_500, {}, T0 + 16 * 60_000));
  assert.equal(r.action, "SELL"); assert.ok(/MAX_HOLD/.test(r.reason));
  // Runner: widen TPs is a plan adjustment, not an order
  pos = pumpPos();
  const before = pos.plan.bondli.tpLevels.tp1;
  r = evaluateExit(pos, tick(10_800, { dynamics: { scores: 5, velocity: 0.4, acceleration: 0.05, trend: "rocket" } }));
  assert.equal(r, null);
  assert.ok(pos._bondli.exitPlan.tpLevels.tp1 > before);
  assert.equal(pos.planAdjustments.length, 1);
});

test("T5: polymarket plans redeem, stop, target, and time out", () => {
  const rf = { id: "q1", venue: "polymarket", instrument: "A1", entryTime: T0, entryMark: 0.96, notional_usd: 50, plan: createPlan({ venue: "polymarket", key: "resolved_fact", entry: { price: 0.96 } }) };
  const mk = (payload, at = T0 + 1000) => makeEvent({ venue: "polymarket", kind: "tick", id: "A1", t_venue: at - 10, t_observed: at, payload });
  assert.equal(evaluateExit(rf, mk({ price: 0.97 })), null);
  assert.equal(evaluateExit(rf, mk({ price: 0.5 })).reason, "STOP");
  assert.equal(evaluateExit(rf, mk({ resolved: true, outcome: "Yes" })).action, "REDEEM");
  assert.equal(evaluateExit(rf, mk({ price: 0.97 }, T0 + 15 * 24 * 3_600_000)).reason, "MAX_HOLD");
  const sq = { id: "q2", venue: "polymarket", instrument: "B1", entryTime: T0, entryMark: 0.5, notional_usd: 50, plan: createPlan({ venue: "polymarket", key: "stale_quote", entry: { price: 0.5 } }) };
  assert.equal(evaluateExit(sq, mk({ price: 0.54 })).reason, "TARGET");
  assert.equal(evaluateExit(sq, mk({ price: 0.47 })).reason, "STOP");
  markPosition(sq, mk({ price: 0.52 }));
  assert.equal(sq.unrealized_usd, 2);
});

test("T5: ride mode holds all the way up and exits once, and the trail widens with the run", () => {
  // +80% peak: below 100%, so 55% of the gain is kept -> the exit trigger sits at +44%
  let pos = pumpPos();
  markPosition(pos, tick(18_000));
  assert.equal(evaluateExit(pos, tick(15_000)), null, "+50% and still above the trail: held");
  let r = evaluateExit(pos, tick(14_000));
  assert.equal(r?.reason, "RIDE-trail"); assert.equal(r.action, "SELL"); assert.equal(r.pct, 100);

  // +400% peak: 70% of the gain is kept, so it may breathe all the way back to +280% before it goes
  pos = pumpPos();
  markPosition(pos, tick(50_000));
  assert.equal(evaluateExit(pos, tick(40_000)), null, "+300% off a +400% peak is still inside the trail");
  r = evaluateExit(pos, tick(37_000));
  assert.ok(r?.reason === "RIDE-trail", "+270% finally trips it");

  // the trail can never book a loss: a +30% peak that round-trips exits at the floor, not below entry
  pos = pumpPos();
  markPosition(pos, tick(13_000));
  r = evaluateExit(pos, tick(10_500));
  assert.equal(r?.reason, "RIDE-trail");
  assert.ok(r.detail.includes("out at +5%"), r.detail);

  // below the arm there is no trail at all: only the stop loss can take it out
  pos = pumpPos();
  markPosition(pos, tick(11_500));
  assert.equal(evaluateExit(pos, tick(10_100)), null, "+1% after a +15% peak: not armed, still held");
});

test("T5: the old partial ladder is still there when ride is switched off", async () => {
  const { createExitPlan, checkTrailingExit } = await import("../../src/autoape/exit-plan.js");
  const laddered = createExitPlan(2, 66, { ride: false });
  assert.equal(laddered.tpLevels.ride, false);
  const pos = { tier: 2, entryScore: 66, entryMcap: 10_000, peakMcap: 14_000, tpHit: 0, exitPlan: laddered };
  const r = checkTrailingExit(pos, 40, 0, { ride: false });
  assert.equal(r?.action, "PARTIAL_SELL"); assert.equal(r.reason, "TP1");
  // and ride mode on the same numbers takes nothing off the table
  const riding = createExitPlan(2, 66, {});
  assert.equal(riding.tpLevels.ride, true);
  assert.equal(checkTrailingExit({ ...pos, exitPlan: riding }, 40, 0, {}), null);
});

test("T5: dead money is sold: three minutes flat with no buyers is a STALL exit on a tier-3 plan", () => {
  const plan3 = createPlan({ venue: "pumpfun", key: 3, entry: { score: 60 } });
  assert.equal(plan3.stall_ms, 2 * 60_000);
  const pos = pumpPos({ plan: plan3 });
  // A token people DID join -- so DOA, which is only about nobody arriving, does not own it -- but
  // where the buying then dried up. That is the distinction between the two exits: DOA is "nobody is
  // trading this", STALL is "people are trading it and it is going nowhere".
  const quiet = { token: { trades: [{ side: "buy", time: T0 + 4_000 }, { side: "buy", time: T0 + 9_000 }, { side: "buy", time: T0 + 60_000 }, { side: "sell", time: T0 + 170_000 }] } };
  // one minute in, flat, still being traded: hold (not old enough for the stall)
  assert.equal(evaluateExit(pos, tick(10_300, quiet, T0 + 60_000)), null);
  // past the stall window and going nowhere: the slot is worth more than the drift, so it is sold
  const flat = evaluateExit(pumpPos({ plan: plan3 }), tick(10_300, quiet, T0 + 3 * 60_000 + 1000));
  assert.equal(flat?.reason, "STALL", "flat and quiet no longer holds a slot to max hold");
  // same, drifting down: STALL
  const r = evaluateExit(pos, tick(9_400, quiet, T0 + 3 * 60_000 + 1000));
  assert.equal(r?.action, "SELL"); assert.equal(r.reason, "STALL"); assert.equal(r.pct, 100);
  // three minutes in but buying is alive: hold
  const busy = { token: { trades: Array.from({ length: 6 }, (_, i) => ({ side: "buy", time: T0 + 3 * 60_000 - i * 5000 })) } };
  const pos2 = pumpPos({ plan: plan3 });
  assert.equal(evaluateExit(pos2, tick(10_300, busy, T0 + 3 * 60_000 + 1000)), null);
  // three minutes in, flat now, but it peaked +20% earlier: not dead money, the trail rules own it
  const pos3 = pumpPos({ plan: plan3 });
  evaluateExit(pos3, tick(12_000, quiet, T0 + 60_000));
  assert.notEqual(evaluateExit(pos3, tick(10_300, quiet, T0 + 3 * 60_000 + 1000))?.reason, "STALL");
});

test("T5: a PONS position is sold at 85% curve progress whatever the P&L: the bot cannot sell after graduation", () => {
  const pos = { ...pumpPos({ plan: createPlan({ venue: "pons", key: 3, entry: { score: 60 } }) }), venue: "pons", instrument: "0xabc" };
  const t = (mc, curve) => { const e = tick(mc, { token: { _curvePct: curve, ca: "0xabc" } }); e.venue = "pons"; return e; };
  assert.equal(evaluateExit(pos, t(10_200, 0.5)), null);
  const r = evaluateExit(pos, t(10_200, 0.86));
  assert.equal(r?.action, "SELL"); assert.equal(r.pct, 100); assert.equal(r.reason, "pre-graduation-exit");
});

test("T5: a runner keeps its moonbag, and the moonbag outlives the time limit", () => {
  // peak 4x: past 2x, so the trail sells all but the tier's moonbag instead of everything
  const pos = pumpPos();
  markPosition(pos, tick(40_000));
  const r = evaluateExit(pos, tick(24_000));
  assert.equal(r?.reason, "RIDE-trail"); assert.equal(r.action, "PARTIAL_SELL");
  assert.equal(r.pct, 85, "tier 2 keeps 15%");
  // The mark follows the SELL, not the decision: until 85% has actually left the wallet the position
  // is still a full one, and a full position must keep its stop loss and its time limit.
  assert.deepEqual(r.stamp, { tpHit: 3, isMoonbag: true });
  assert.equal(pos._bondli.isMoonbag, false, "not a moonbag until the sell lands");
  assert.equal(evaluateExit(pos, tick(24_000, {}, T0 + 26 * 60_000))?.reason, "MAX_HOLD", "and the time limit still applies to it");
  applyExitStamp(pos, r.stamp);
  assert.equal(pos._bondli.isMoonbag, true, "the position is now a moonbag");
  // the moonbag is not sold at the plan's time limit
  assert.equal(evaluateExit(pos, tick(24_000, {}, T0 + 26 * 60_000)), null);
  // it dies only when the token does
  assert.equal(evaluateExit(pos, tick(1_900, {}, T0 + 26 * 60_000))?.reason, "moonbag-dead");

  // a token that only made +120% is sold in full: no moon, no moonbag
  const pos3 = pumpPos();
  markPosition(pos3, tick(22_000));
  const r3 = evaluateExit(pos3, tick(13_000));
  assert.equal(r3?.reason, "RIDE-trail"); assert.equal(r3.pct, 100);
});


test("T5: a plan adjustment does not cancel the exit checks, and cannot compound away the stop", () => {
  // A dying position: the live score sits well below the entry score, which makes layer 1 return
  // TIGHTEN_SLS on every tick. That must not stop layer 2 from seeing that the price is 30% down.
  const pos = pumpPos();
  // A 12-point drop off an entry score of 66: enough for TIGHTEN_SLS (10), short of momentum-trim
  // (25) and momentum-exit (30), so layer 1's only output is the adjustment.
  const joinedIn = [{ side: "buy", time: T0 + 2_000 }, { side: "buy", time: T0 + 5_000 }, { side: "buy", time: T0 + 30_000 }];
  const weak = { token: { buys: 40, trades: joinedIn }, scores: { apeScore: 54 }, dynamics: { scores: 3, velocity: -0.02, acceleration: 0, trend: "fading" } };
  const r = evaluateExit(pos, tick(7_000, weak));
  assert.ok(r, "the stop loss is still reached with a plan adjustment pending");
  assert.equal(r.reason, "SL2");

  // With nothing else to do, the adjustment is applied as before.
  const drifting = pumpPos();
  assert.equal(evaluateExit(drifting, tick(9_900, weak)), null, "an adjustment returns no order");
  assert.equal(drifting.planAdjustments.length, 1);
  assert.ok(drifting._bondli.exitPlan.stopLoss < 12, "and it did tighten the stop");

  // Tick after tick after tick: the stop converges to a floor instead of to zero.
  const p2 = pumpPos();
  for (let i = 0; i < 40; i++) evaluateExit(p2, tick(9_900 - i, weak));
  const sl = p2._bondli.exitPlan.stopLoss;
  assert.ok(sl >= 6, `a tier-2 12% stop cannot tighten past half of itself, got ${sl}`);
  // The same for the other direction: a "rocket" cannot walk the targets to the moon.
  const p3 = pumpPos();
  const hot = { token: { buys: 40, trades: [] }, scores: { apeScore: 90 }, dynamics: { scores: 6, velocity: 0.5, acceleration: 0.1, trend: "rocket" } };
  const tp1Before = p3.plan.bondli.tpLevels.tp1;
  for (let i = 0; i < 40; i++) evaluateExit(p3, tick(10_050 + i, hot));
  assert.ok(p3._bondli.exitPlan.tpLevels.tp1 <= tp1Before * 3, `targets are capped at 3x, got ${p3._bondli.exitPlan.tpLevels.tp1}`);
});

test("T5: a partial sell that never lands leaves a full position with its stop loss intact", () => {
  const pos = pumpPos();
  markPosition(pos, tick(40_000));            // +300%
  const r = evaluateExit(pos, tick(24_000));  // RIDE-trail: sell 85%, keep a moonbag
  assert.equal(r.action, "PARTIAL_SELL");
  // The sell fails -- no balance, an unconfirmed signature, a revert. Nothing is applied.
  assert.equal(pos._bondli.isMoonbag, false);
  assert.equal(pos._bondli.tpHit, 0);
  // The position still holds everything, so every protection a full position has must still work.
  // 40% down. A real moonbag sits here doing nothing until -80%; a full position must not.
  const out = evaluateExit(pos, tick(6_000));
  assert.ok(out, "a full position 40% down still has an exit");
  assert.ok(!/^moonbag/.test(out.reason), `and it is not being treated as a moonbag: ${out.reason}`);
  const p2 = pumpPos();
  markPosition(p2, tick(40_000)); evaluateExit(p2, tick(24_000));
  assert.equal(evaluateExit(p2, tick(24_000, {}, T0 + 26 * 60_000))?.reason, "MAX_HOLD", "and so does the time limit");
  // The trail is still willing to try again.
  const p3 = pumpPos();
  markPosition(p3, tick(40_000)); evaluateExit(p3, tick(24_000));
  assert.equal(evaluateExit(p3, tick(24_000))?.reason, "RIDE-trail", "and the exit is retried");
});

test("T5: dead on arrival — nobody follows us in, so we leave in seconds", () => {
  const plan3 = createPlan({ venue: "pumpfun", key: 3, entry: { score: 60 } });
  assert.equal(plan3.doa_ms, 12_000);
  const at = ms => T0 + ms;
  // Our own fill, and nothing after it.
  const alone = { token: { trades: [{ side: "buy", time: T0 + 200 }] } };

  // Too young: the price at five seconds is our own impact, and that is not evidence either way.
  assert.equal(evaluateExit(pumpPos({ plan: plan3 }), tick(10_050, alone, at(5_000))), null);
  // Twelve seconds in, one buy (ours), price flat: gone.
  const r = evaluateExit(pumpPos({ plan: plan3 }), tick(10_050, alone, at(12_500)));
  assert.equal(r?.reason, "DOA"); assert.equal(r.pct, 100);
  assert.match(r.detail, /^13s, 1 joined/);

  // The crowd arrived: held, whatever the price is doing.
  const joined = { token: { trades: [{ side: "buy", time: T0 + 200 }, { side: "buy", time: T0 + 4_000 }, { side: "buy", time: T0 + 9_000 }] } };
  assert.equal(evaluateExit(pumpPos({ plan: plan3 }), tick(10_050, joined, at(12_500))), null, "three buyers is participation");

  // Nobody joined, but it is moving on its own: held. This is the case a blanket time cut would kill.
  assert.equal(evaluateExit(pumpPos({ plan: plan3 }), tick(11_500, alone, at(12_500))), null, "+15% is not dead");

  // A position that already peaked past the band is the trail's, not DOA's.
  const ran = pumpPos({ plan: plan3 });
  markPosition(ran, tick(11_000, alone, at(6_000)));
  assert.notEqual(evaluateExit(ran, tick(10_050, alone, at(12_500)))?.reason, "DOA");

  // Conviction buys time: tier 1 gets 30 seconds where tier 3 got 12.
  const plan1 = createPlan({ venue: "pumpfun", key: 1, entry: { score: 90 } });
  assert.equal(plan1.doa_ms, 30_000);
  assert.equal(evaluateExit(pumpPos({ plan: plan1 }), tick(10_050, alone, at(12_500))), null);
  assert.equal(evaluateExit(pumpPos({ plan: plan1 }), tick(10_050, alone, at(31_000)))?.reason, "DOA");
});

// A held token whose price cannot be read is the worst kind of position: every price rule -- the
// stop loss, the crash exit, the trail -- needs a price, so none of them can fire, and the only
// thing left is a blind time exit minutes later. That is how a 12% stop realized 64% losses.
test("T5: a position with no readable price is sold on that fact after a short grace", () => {
  const now = 1_700_000_000_000;
  const plan = createPlan({ venue: "pons", key: 2, entry: { score: 70 } });
  const pos = { id: "p1", venue: "pons", instrument: "0xdead", plan, entryMark: 20_000, peak: 20_000, entryTime: now, notional_usd: 10 };
  const blind = (at) => ({ venue: "pons", kind: "tick", id: "0xdead", t_observed: at, payload: { unreadable: true, token: { ca: "0xdead" } } });

  // The grace holds: a single failed read is a blip, not a fault.
  assert.equal(evaluateExit(pos, blind(now + 1_000), { now: now + 1_000 }), null);
  assert.equal(evaluateExit(pos, blind(now + 30_000), { now: now + 30_000 }), null);
  // Past the grace it sells, well before this plan's 3-minute stall and 15-minute max hold.
  const out = evaluateExit(pos, blind(now + BLIND_EXIT_MS + 1_000), { now: now + BLIND_EXIT_MS + 1_000 });
  assert.equal(out?.action, "SELL");
  assert.equal(out.pct, 100);
  assert.equal(out.reason, "blind-exit");
  assert.ok(BLIND_EXIT_MS < plan.stall_ms, "blind is worse than stalled: it must fire first");

  // A real price coming back clears it: the clock restarts rather than carrying the old blindness.
  const readable = { venue: "pons", kind: "tick", id: "0xdead", t_observed: now + 50_000, payload: { mcapUsd: 20_000, token: { ca: "0xdead", buys: 50, sells: 5, trades: [{ side: "buy", time: now + 1_000 }, { side: "buy", time: now + 2_000 }, { side: "buy", time: now + 30_000 }], uniqueBuyers: { size: 20 }, createdAt: now - 300_000, mcapUsd: 20_000 }, dynamics: { scores: 5, velocity: 0.05, acceleration: 0, trend: "stable" }, scores: { apeScore: 66 } } };
  assert.equal(evaluateExit(pos, readable, { now: now + 50_000 }), null);
  assert.equal(pos._blindSince, null);
  assert.equal(evaluateExit(pos, blind(now + 60_000), { now: now + 60_000 }), null, "the grace starts again");
});

test("T5: the leader of a fading wave takes half off while it is green, once; a loser, a young wave and a building wave are left to the ladder", () => {
  const at = ms => T0 + ms;
  const withWave = (ev, wave) => ({ ...ev, payload: { ...ev.payload, qf: { _wave: wave } } });
  const fading = { copies: 3, recent: 0, prior: 3, rising: false, fading: true, windowMs: 180_000 };
  const building = { copies: 3, recent: 3, prior: 0, rising: true, fading: false, windowMs: 180_000 };
  // Green, old enough, fading: half off, booked as a reduction so DOA and STALL never revisit it.
  const pos = pumpPos();
  const r = evaluateExit(pos, withWave(tick(12_000, {}, at(7 * 60_000)), fading));
  assert.equal(r?.reason, "wave-fade", JSON.stringify(r)); assert.equal(r.action, "PARTIAL_SELL"); assert.equal(r.pct, 50);
  assert.match(r.detail, /3 copies, none in 3m, \+20%/); assert.equal(r.stamp.tpHit, 1);
  // Only once: the same fading wave a tick later is the ladder's business.
  applyExitStamp(pos, r.stamp);
  assert.notEqual(evaluateExit(pos, withWave(tick(12_100, {}, at(7 * 60_000 + 5_000)), fading))?.reason, "wave-fade");
  // Under the gain floor: not worth a round trip on a fade alone.
  assert.notEqual(evaluateExit(pumpPos(), withWave(tick(10_000 * (1 + (WAVE_TRIM_MIN_GAIN_PCT - 1) / 100), {}, at(7 * 60_000)), fading))?.reason, "wave-fade");
  // A loser is the stop's, never trimmed on a fade.
  assert.notEqual(evaluateExit(pumpPos(), withWave(tick(9_000, {}, at(7 * 60_000)), fading))?.reason, "wave-fade");
  // Too soon: inside the first two windows a quiet window is noise, not a fade.
  assert.notEqual(evaluateExit(pumpPos(), withWave(tick(12_000, {}, at(4 * 60_000)), fading))?.reason, "wave-fade");
  // Still building: ride it.
  assert.notEqual(evaluateExit(pumpPos(), withWave(tick(12_000, {}, at(7 * 60_000)), building))?.reason, "wave-fade");
  // One copy is not a wave.
  assert.notEqual(evaluateExit(pumpPos(), withWave(tick(12_000, {}, at(7 * 60_000)), { ...fading, copies: 1 }))?.reason, "wave-fade");
});
