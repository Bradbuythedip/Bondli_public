// T9: kill -9 with an open paper position; restart reconciles from the ledger
// and the paper book, adopts the position with a plan, and exits still fire.
// Also: the engine end to end in paper mode, with every stage in the ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../src/velocity/core/engine.mjs";
import { loadRiskEnvelope } from "../../src/velocity/core/risk.mjs";
import { ScriptedFeed } from "../../src/velocity/core/feed.mjs";
import { makeEvent } from "../../src/velocity/core/events.mjs";
import { makePumpfunEdge } from "../../src/velocity/venues/pumpfun/edge.mjs";
import { PumpfunPaperRouter } from "../../src/velocity/venues/pumpfun/router.mjs";
import { Supervisor } from "../../src/velocity/core/supervisor.mjs";
import { goodCandidatePayload, tickPayload } from "./helpers/fixtures.mjs";

const envelope = loadRiskEnvelope(path.resolve("src/velocity/config/risk.example.json"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "velocity-t9-"));

function mkEngine(dataDir, feed, config = {}) {
  return new Engine({ dataDir, envelope, venues: { pumpfun: { mode: "paper", feed, edge: makePumpfunEdge(), router: new PumpfunPaperRouter({ bookFile: path.join(dataDir, "paper-book-pumpfun.json"), latencyMs: 0 }) } }, config: { saveMs: 600_000, governorMs: 600_000, ...config } });
}

test("T9: SIGKILL with an open position, restart reconciles and exits fire", async () => {
  const dataDir = tmp();
  const child = spawn(process.execPath, [path.resolve("tests/velocity/helpers/crash-runner.mjs"), dataDir], { stdio: ["ignore", "pipe", "inherit"] });
  const posId = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("child never opened a position: " + buf)), 15_000);
    child.stdout.on("data", d => { buf += d; const m = /POSITION_OPEN (\S+)/.exec(buf); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  child.kill("SIGKILL");
  await new Promise(r => child.on("exit", r));

  // The kill tore the snapshot mid-write: the store falls back to defaults, so the
  // ledger and the paper book are the only truth left. The ledger has the fill.
  fs.writeFileSync(path.join(dataDir, "state.json"), '{"version":1,"positions":{"' + posId + '":{"id":"');
  const fills = fs.readFileSync(path.join(dataDir, "ledger.jsonl"), "utf8").split("\n").filter(l => l.includes('"kind":"fill"'));
  assert.equal(fills.length, 1, "child recorded exactly one fill before the kill");
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  const engine = mkEngine(dataDir, feed);
  try {
  const report = await engine.reconcile();
  assert.deepEqual(report.venues.pumpfun.adopted, ["MintCrash"]);
  const pos = engine.store.openPositions("pumpfun")[0];
  assert.equal(pos.id, posId, "adopted under the ledger's own position id");
  assert.ok(pos.plan && pos.plan.bondli.stopLoss > 0, "adopted position carries a plan");
  assert.equal(pos.tier, 2);
  await engine.start({ reconcile: false });

  const crash = makeEvent({ venue: "pumpfun", kind: "tick", id: "MintCrash", t_venue: Date.now() - 50, t_observed: Date.now(), payload: tickPayload("MintCrash", 17_000, { dynamics: { scores: 5, velocity: -0.6, acceleration: -0.2, trend: "crashing" } }) });
  await engine.enqueue(() => engine.onEvent(crash));
  assert.equal(engine.store.openPositions().length, 0, "exit fired on the adopted position");
  const outcome = engine.ledger.query({ kind: "outcome", limit: 1 })[0];
  assert.equal(outcome.reason, "crash-exit");
  assert.equal(outcome.positionId, posId);
  } finally { await engine.stop(); }
});

test("T9: paper mode end to end writes every stage and blocks entries on a stale feed", async () => {
  const dataDir = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  const engine = mkEngine(dataDir, feed, { reentryCooldownMs: 0 });
  try {
  await engine.start({ reconcile: true });
  const now = Date.now();
  const cand = makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintE2E", t_venue: now - 100, t_observed: now, payload: goodCandidatePayload("MintE2E") });
  await engine.enqueue(() => engine.onEvent(cand));
  const kinds = engine.ledger.readAll().map(r => r.kind + (r.stage ? ":" + r.stage : ""));
  for (const k of ["reconcile", "governor", "decision", "order:sized", "order:sent", "fill", "order:filled"]) assert.ok(kinds.includes(k), `ledger has ${k}: ${kinds}`);
  const fill = engine.ledger.query({ kind: "fill", limit: 1 })[0];
  assert.ok(fill.plan && fill.plan.key === 2, "fill record carries the plan");
  assert.equal(engine.store.openPositions().length, 1);
  assert.equal(engine.status().positions[0].instrument, "MintE2E");
  assert.ok(feed.watched.has("MintE2E"), "feed watches the held instrument");

  // Same instrument again: refused, nothing sent.
  await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintE2E", t_venue: now, t_observed: now + 10, payload: goodCandidatePayload("MintE2E") })));
  assert.equal(engine.ledger.query({ kind: "order", limit: 1 })[0].reason, "ALREADY_IN_OR_INFLIGHT");

  // Ride mode: +150% takes nothing off the table, so no exit is written on the way up.
  await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "tick", id: "MintE2E", t_venue: now + 500, t_observed: now + 600, payload: tickPayload("MintE2E", 25_000) })));
  assert.equal(engine.ledger.query({ kind: "exit", limit: 1 }).length, 0, "nothing is scalped on the way up");
  assert.equal(engine.store.openPositions().length, 1, "the whole position is still on");
  await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "tick", id: "MintE2E", t_venue: now + 900, t_observed: now + 1000, payload: tickPayload("MintE2E", 4_000) })));
  assert.equal(engine.store.openPositions().length, 0);
  const finalExit = engine.ledger.query({ kind: "exit", limit: 1 })[0];
  assert.equal(finalExit.final, true, "it leaves in one sell, which is what makes the rent reclaimable");
  const outcome = engine.ledger.query({ kind: "outcome", limit: 1 })[0];
  assert.ok(Number.isFinite(outcome.pnl_usd));
  assert.ok(outcome.features, "outcome carries the entry features for the learner");
  // Paper mode: the trade is counted, but against the paper ledger, not the real daily loss budget.
  assert.equal(engine.store.state.day.paperTrades, 1);
  assert.equal(engine.store.state.day.trades, 0, "no real money moved");
  assert.equal(engine.store.state.day.realizedUsd, 0);
  // With no live venue, the limit and the governor still act on the simulated number.
  assert.equal(engine.realizedToday(), engine.store.state.day.paperRealizedUsd);

  // Stale feed blocks new entries; a halt freezes; flatten closes.
  feed.lastEventAt = Date.now() - 60_000; feed.eventsEmitted = 1;
  const sup = new Supervisor({ engine, dataDir });
  await sup.watchdog();
  assert.equal(engine.blocked.pumpfun, "FEED_STALE");
  await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintLate", t_venue: now + 2000, t_observed: now + 2100, payload: goodCandidatePayload("MintLate") })));
  // A halted governor refuses every candidate for one reason, so it says it once per window instead
  // of writing an identical reject per token into the narration the operator reads.
  const stillNoDecision = engine.ledger.query({ kind: "decision", limit: 1 })[0];
  assert.notEqual(stillNoDecision?.instrument, "MintLate", "a halted engine does not judge candidates");
  const notice = engine.ledger.query({ kind: "order", limit: 1 })[0];
  assert.equal(notice.stage, "failed"); assert.match(notice.reason, /HALTED:.*FEED_STALE/);
  // ...and only once: the second candidate inside the window adds no line.
  const seq = notice.seq;
  await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintLate2", t_venue: now + 2200, t_observed: now + 2300, payload: goodCandidatePayload("MintLate2") })));
  assert.equal(engine.ledger.query({ kind: "order", limit: 1 })[0].seq, seq, "one halt line per window, not one per token");
  delete engine.blocked.pumpfun; feed.lastEventAt = Date.now();
  await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintLate", t_venue: now + 3000, t_observed: now + 3100, payload: goodCandidatePayload("MintLate") })));
  assert.equal(engine.store.openPositions().length, 1);
  await engine.halt("freeze", "test");
  await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintFrozen", t_venue: now + 4000, t_observed: now + 4100, payload: goodCandidatePayload("MintFrozen") })));
  assert.equal(engine.store.openPositions().length, 1, "frozen: no new entries");
  fs.writeFileSync(path.join(dataDir, "HALT"), "flatten");
  await sup.watchdog();
  assert.equal(engine.store.openPositions().length, 0, "HALT file flattened");
  assert.equal(engine.ledger.query({ kind: "halt", limit: 1 })[0].by, "file");
  assert.throws(() => engine.resume(), /venue name/);
  engine.resume("pumpfun");
  assert.equal(engine.store.isHalted(), null);
  const why = engine.why("last");
  assert.ok(Array.isArray(why) && why.length >= 1);
  } finally { await engine.stop(); }
});

// The daily loss limit halts the engine. The operator can clear that halt without removing the
// brake: the loss booked so far stops counting against today, so the next halt is a full limit away.
test("T9: forgiving the day's loss resets the taper and the breaker, not the P&L", async () => {
  const dataDir = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  const engine = mkEngine(dataDir, feed);
  const limit = envelope.daily_loss_limit_usd;
  // Paper venue, so the paper day is what the governor reads.
  engine.store.state.day.paperRealizedUsd = -limit;
  engine.evaluateGovernor();
  assert.equal(engine.verdict.halt, false, "the limit tapers, it does not halt");
  const throttled = engine.verdict.throttle;
  assert.ok(throttled < 1 && throttled > 0, `tapered to ${throttled}`);

  const r = engine.acknowledgeDailyLimit();
  assert.equal(r.ok, true);
  assert.equal(r.forgiven, limit);
  assert.equal(engine.store.state.day.paperRealizedUsd, -limit, "the P&L the operator reads is untouched");
  assert.equal(engine.verdict.throttle, 1, "stakes back to full size");

  // A 3x day is still a hard stop, and it counts from the forgiven point, not from zero.
  engine.store.state.day.paperRealizedUsd = -limit * 3;
  engine.evaluateGovernor();
  assert.equal(engine.verdict.halt, false, "2x more loss since the ack is not yet a fault");
  engine.store.state.day.paperRealizedUsd = -limit * 4;
  engine.evaluateGovernor();
  assert.equal(engine.verdict.halt, true);
  assert.equal(engine.verdict.haltReason, "daily_breaker");

  // The day roll clears the acknowledgement with the rest of the day.
  engine.store.state.day.date = "1999-01-01";
  engine.store.rollDay();
  assert.equal(engine.store.state.day.lossAckUsd, 0);
});

// A PONS curve that graduates moves to a Uniswap V4 pool the router cannot sell into, and it never
// un-graduates. Retrying that sell forever held a concurrency slot for the life of the process --
// with two slots, half the bot's throughput lost to one dead token.
test("T9: a sell that can never succeed releases the position instead of holding the slot forever", async () => {
  const dataDir = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  const engine = mkEngine(dataDir, feed, { reentryCooldownMs: 0 });
  try {
    await engine.start({ reconcile: true });
    const now = Date.now();
    await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintGrad", t_venue: now - 100, t_observed: now, payload: goodCandidatePayload("MintGrad") })));
    const pos = engine.store.openPositions()[0];
    assert.ok(pos, "a position to strand");

    // The venue now refuses this sell terminally, and will do so on every retry.
    const router = engine.venues.pumpfun.router;
    router.close = async () => ({ ok: false, failure: { code: "GRADUATED", reason: "the curve has graduated to a Uniswap V4 pool" } });

    const r = await engine.enqueue(() => engine.closePosition(pos, 100, "TEST"));
    assert.equal(r.ok, false, "the sell still failed: nothing was invented");
    assert.equal(engine.store.openPositions().length, 0, "the slot is free again");

    const exits = engine.ledger.query({ kind: "exit", limit: 5 });
    const released = exits.find(e => e.reason === "RELEASED");
    assert.ok(released, "the release is on the record");
    assert.equal(released.by, "engine");
    assert.match(released.detail, /GRADUATED/);
    assert.equal(released.proceeds_usd, 0);
    // No P&L and no outcome: nothing was realized, and teaching the learner a loss that did not
    // happen is exactly the FLAT_AT_VENUE mistake.
    assert.equal(engine.ledger.query({ kind: "outcome", limit: 5 }).filter(o => o.instrument === "MintGrad").length, 0);
    assert.equal(engine.store.state.day.paperRealizedUsd, 0);
  } finally { await engine.stop(); }
});

// A curve that refuses every sell is, from here, indistinguishable from one that cannot be sold.
// Retrying forever held the slot AND raised a fresh error banner every few seconds, so the operator
// dismissed one and the next arrived: the error could not be cleared while its cause was still being
// made. After enough identical refusals the position is released and the cause goes away.
test("T9: a sell that keeps failing the same way is given up on, so the error stops being remade", async () => {
  const dataDir = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  const engine = mkEngine(dataDir, feed, { reentryCooldownMs: 0, releaseAfterFailures: 3 });
  try {
    await engine.start({ reconcile: true });
    const now = Date.now();
    await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintStuck", t_venue: now - 100, t_observed: now, payload: goodCandidatePayload("MintStuck") })));
    const pos = engine.store.openPositions()[0];
    assert.ok(pos);

    const router = engine.venues.pumpfun.router;
    router.close = async () => ({ ok: false, failure: { code: "REVERT", reason: "sell would revert (custom error 0x42301c23)" } });

    // The first refusals are retried: a revert really can be an RPC having a bad minute.
    await engine.enqueue(() => engine.closePosition(pos, 100, "TEST"));
    assert.equal(engine.store.openPositions().length, 1);
    assert.equal(pos.lastExitError.count, 1);
    await engine.enqueue(() => engine.closePosition(pos, 100, "TEST"));
    assert.equal(pos.lastExitError.count, 2);
    assert.equal(engine.store.openPositions().length, 1, "not given up on too early");

    // The third identical answer settles it.
    await engine.enqueue(() => engine.closePosition(pos, 100, "TEST"));
    assert.equal(engine.store.openPositions().length, 0, "the slot is free and the error has no source left");
    const released = engine.ledger.query({ kind: "exit", limit: 8 }).find(e => e.reason === "RELEASED");
    assert.ok(released); assert.equal(released.by, "engine"); assert.match(released.detail, /REVERT/);
    assert.equal(engine.ledger.query({ kind: "outcome", limit: 8 }).filter(o => o.instrument === "MintStuck").length, 0, "no invented P&L");
  } finally { await engine.stop(); }
});

// A different failure means the situation changed, so the tally starts again rather than counting
// unrelated bad minutes toward giving up on a position that is still perfectly sellable.
test("T9: the give-up tally counts one repeated failure, not a mix of different ones", async () => {
  const dataDir = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  const engine = mkEngine(dataDir, feed, { reentryCooldownMs: 0, releaseAfterFailures: 3 });
  try {
    await engine.start({ reconcile: true });
    const now = Date.now();
    await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintMixed", t_venue: now - 100, t_observed: now, payload: goodCandidatePayload("MintMixed") })));
    const pos = engine.store.openPositions()[0];
    const router = engine.venues.pumpfun.router;
    let code = "REVERT";
    router.close = async () => ({ ok: false, failure: { code, reason: `${code} happened` } });

    await engine.enqueue(() => engine.closePosition(pos, 100, "TEST"));
    await engine.enqueue(() => engine.closePosition(pos, 100, "TEST"));
    assert.equal(pos.lastExitError.count, 2);
    code = "SEND_FAILED";
    await engine.enqueue(() => engine.closePosition(pos, 100, "TEST"));
    assert.equal(pos.lastExitError.count, 1, "a different answer restarts the tally");
    assert.equal(engine.store.openPositions().length, 1, "and the position is still being tried");
  } finally { await engine.stop(); }
});

// Pretend money is still a number. With no live venue there is no wallet to measure from, and the
// header used to fall through to the LIVE day counter (which paper never touches) with the paper
// positions filtered out of the open value -- so a paper run read $0.00 whatever it did.
test("T9: a paper run reports its own P&L, as paper, and never touches the wallet number", async () => {
  const dataDir = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  const engine = mkEngine(dataDir, feed, { reentryCooldownMs: 0 });
  try {
    await engine.start({ reconcile: true });
    const now = Date.now();
    await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintPnl", t_venue: now - 100, t_observed: now, payload: goodCandidatePayload("MintPnl") })));
    const pos = engine.store.openPositions()[0];
    assert.ok(pos?.paper, "a paper position");
    // Up 150% and still open (ride mode holds all the way up): the header shows the open gain, on paper.
    await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "tick", id: "MintPnl", t_venue: now + 500, t_observed: now + 600, payload: tickPayload("MintPnl", 25_000) })));
    let p = engine.truePnl();
    assert.equal(p.kind, "paper");
    assert.ok(p.unrealized_usd > 0, `open gain is visible: ${JSON.stringify(p)}`);
    assert.equal(p.since_start_usd, p.unrealized_usd, "nothing closed yet: since-start is the open gain");
    assert.equal(p.wallet_usd, null, "and there is no wallet number to confuse it with");
    // Closed: the realized paper P&L is the number, the live day counter is untouched.
    await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "tick", id: "MintPnl", t_venue: now + 900, t_observed: now + 1000, payload: tickPayload("MintPnl", 4_000) })));
    p = engine.truePnl();
    const out = engine.ledger.query({ kind: "outcome", limit: 1 })[0];
    assert.equal(p.since_start_usd, +out.pnl_usd.toFixed(2));
    assert.equal(p.realized_today_usd, +engine.store.state.day.paperRealizedUsd.toFixed(2));
    assert.equal(p.trades_today, 1);
    assert.equal(engine.store.state.day.realizedUsd, 0, "real money never moved");
    assert.equal(engine.store.state.day.trades, 0);
  } finally { await engine.stop(); }
});

// The closes list must lead with the close that just happened. ledger.query returns the newest N
// records oldest-first, and taking the head of that showed the stale end of the window -- the same
// re-entered ticker three times over, and never the latest fill.
test("T9: closes() leads with the newest close and counts the same trades the header does", async () => {
  const dataDir = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  const engine = mkEngine(dataDir, feed);
  let now = Date.now(); engine.clock = () => now;
  try {
    await engine.start({ reconcile: false });
    // Twelve paper closes, booked directly so the test is about the list and not about sizing:
    // one every five seconds, each losing a little.
    for (let k = 0; k < 12; k++) {
      now += 5000;
      const id = "Mint" + String(k).padStart(2, "0");
      engine._bookExit(
        { id: "p" + k, venue: "pumpfun", instrument: id, status: "open", paper: true, qty: 1, remaining_qty: 1, cost_usd: 10, proceeds_usd: 0, stake_usd: 10, notional_usd: 10, entryTime: now - 12_000, plan: { key: 3 }, reference: { ticker: id } },
        { ok: true, fill: { price: 1, qty: 1, notional_usd: 9.6, fee_usd: 0, t_filled: now, paper: true } }, 100, "DOA");
    }
    const list = engine.closes(8);
    assert.equal(list.length, 8);
    assert.equal(list[0].instrument, "Mint11", "the newest close first");
    assert.equal(list[7].instrument, "Mint04", "the eight newest, not the eight oldest of the last sixteen");
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].ts >= list[i].ts, "newest first, throughout");
    assert.equal(list[0].paper, true);
    const p = engine.truePnl();
    assert.equal(p.kind, "paper");
    assert.equal(p.since_start.trades, 12, "the header's words count the same twelve closes the number does");
    assert.equal(p.since_start.closed_usd, -4.8);
    assert.equal(p.since_start_usd, -4.8);
  } finally { await engine.stop(); }
});
