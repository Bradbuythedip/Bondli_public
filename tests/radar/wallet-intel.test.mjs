// Wallet intel on synthetic streams: who is smart is decided by the ledger, not by who got lucky.
// Every stream here is built from the same fields the on-chain TradeEvent delivers (mint, wallet,
// side, sol, tokens, slot, timestamp); the clock is injected and advanced by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WalletIntel, wilsonLower, decayWeight, fifoTake, INTEL_DEFAULTS } from "../../src/engine/wallet-intel.mjs";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = 1_800_000_000_000, SLOT0 = 300_000_000, SLOT_MS = 400;
const slotAt = ts => SLOT0 + Math.floor((ts - T0) / SLOT_MS);

/** An intel with a hand-driven clock. `at(ts)` moves the clock; every event carries its own ts too. */
function rig(opts = {}) {
  let now = T0;
  const intel = new WalletIntel({ clock: () => now, ...opts });
  return { intel, at: ts => { now = Math.max(now, ts); return now; }, now: () => now };
}
/** Launch i, twelve hours after the last one, opening at a $6k market cap. */
function launch(r, i, creator = "DEV" + i) {
  const ts = T0 + i * 12 * HOUR, mint = "MINT" + i, slot = slotAt(ts);
  r.at(ts); r.intel.onCreate({ mint, creator, ts, slot }); r.intel.markMcap(mint, 6000, ts);
  return { mint, ts, slot, creator };
}
function buy(r, L, wallet, { after = 30_000, sol = 0.5, tokens = 1e6, slot = null } = {}) {
  const ts = L.ts + after; r.at(ts);
  r.intel.onTrade({ mint: L.mint, wallet, isBuy: true, sol, tokens, ts, slot: slot ?? slotAt(ts), signature: `b:${wallet}:${L.mint}:${after}` });
}
function sell(r, L, wallet, { after, sol, tokens = 1e6 }) {
  const ts = L.ts + after; r.at(ts);
  r.intel.onTrade({ mint: L.mint, wallet, isBuy: false, sol, tokens, ts, slot: slotAt(ts), signature: `s:${wallet}:${L.mint}:${after}` });
}
/** The mint runs: 4x the opening cap ten minutes in. */
function run(r, L, mult = 4) { r.at(L.ts + 10 * MIN); r.intel.markMcap(L.mint, 6000 * mult, L.ts + 10 * MIN); }

test("pure parts: Wilson lower bound, decay, FIFO", () => {
  assert.ok(wilsonLower(5, 5) < wilsonLower(70, 100), "5/5 must not outrank 70/100");
  assert.ok(wilsonLower(70, 100) > 0.6 && wilsonLower(70, 100) < 0.7);
  assert.equal(wilsonLower(0, 0), 0);
  assert.equal(decayWeight(0, 14 * DAY), 1);
  assert.ok(Math.abs(decayWeight(14 * DAY, 14 * DAY) - 0.5) < 1e-12);
  assert.equal(decayWeight(-5, 14 * DAY), 1, "a clock skew is not a boost");
  const lots = [{ t: 100, c: 0.001 }, { t: 50, c: 0.002 }];
  assert.deepEqual(fifoTake(lots, 120), { matched: 120, cost: 100 * 0.001 + 20 * 0.002 });
  assert.equal(lots.length, 1); assert.ok(Math.abs(lots[0].t - 30) < 1e-9, "the second lot is what is left");
  const more = fifoTake(lots, 500); assert.ok(Math.abs(more.matched - 30) < 1e-9, "cannot match tokens never bought"); assert.equal(lots.length, 0);
});

test("a wallet that buys early on runners and sells later outranks one that snipes the create slot and exits in 30s", () => {
  const r = rig();
  let last = null;
  for (let i = 0; i < 25; i++) {
    const L = launch(r, i); last = L;
    buy(r, L, "SNIPER", { after: 200, slot: L.slot });               // the creation slot itself
    buy(r, L, "EARLY", { after: 30_000 });                            // 30s in: early, not sniped
    sell(r, L, "SNIPER", { after: 30_000, sol: 0.8 });                // out in 30 seconds, profitably
    run(r, L);
    sell(r, L, "EARLY", { after: 20 * MIN, sol: 1.5 });               // rode the run, out after 20 minutes
  }
  const early = r.intel.walletScore("EARLY"), sniper = r.intel.walletScore("SNIPER");
  assert.equal(early.closed, 25); assert.equal(early.wins, 25);
  assert.deepEqual(early.flags, { sniper: false, cohort: false, fresh: false, wash: false, deployerFunded: null }, JSON.stringify(early));
  assert.equal(early.earlyHitRate, 1, "every early buy was on a mint that later did 3x");
  assert.ok(early.winRateLower > 0.8 && early.winRateLower < 1, `wilson ${early.winRateLower}`);
  assert.ok(early.robustPnlSol30d < early.pnlSol30d, "robust pnl drops the best trade");
  assert.ok(early.pnlSol30d > 20 && early.pnlSol30d < 25, `pnl after fees ${early.pnlSol30d}`);
  assert.equal(early.medianHoldMs, 20 * MIN - 30_000);
  assert.ok(early.score > 0.6, `score ${early.score}`);
  assert.equal(sniper.closed, 25, "the sniper is proven too, and profitable");
  assert.ok(sniper.pnlSol30d > 0);
  assert.equal(sniper.flags.sniper, true); assert.equal(sniper.score, 0, "profitable is not smart");
  assert.ok(sniper.medianHoldMs < 60_000);
  const top = r.intel.top(5);
  assert.equal(top[0].wallet, "EARLY"); assert.ok(!top.some(x => x.wallet === "SNIPER"));
  const sb = r.intel.smartBuyers(last.mint);
  assert.equal(sb.count, 1); assert.equal(sb.wallets[0].wallet, "EARLY"); assert.equal(sb.seen, 2, "the sniper was seen in the window and excluded");
  assert.equal(sb.sumScore, early.score);
  // the hold-time rule alone flags a wallet that is not in the creation slot but never holds a minute
  const r2 = rig();
  for (let i = 0; i < 8; i++) { const L = launch(r2, i); buy(r2, L, "FLIP", { after: 5000 }); sell(r2, L, "FLIP", { after: 25_000, sol: 0.6 }); }
  assert.equal(r2.intel.walletScore("FLIP").flags.sniper, true);
});

test("three wallets that always co-fire are one ring: flagged, penalized, counted once", () => {
  const r = rig();
  let last = null;
  for (let i = 0; i < 25; i++) {
    const L = launch(r, i); last = L;
    buy(r, L, "A", { after: 20_000 }); buy(r, L, "B", { after: 35_000 }); buy(r, L, "C", { after: 50_000 }); // within 60s of each other
    buy(r, L, "SOLO", { after: 4 * MIN });                                                                    // early, alone
    run(r, L);
    for (const w of ["A", "B", "C", "SOLO"]) sell(r, L, w, { after: 20 * MIN, sol: 1.5 });
  }
  const a = r.intel.walletScore("A"), solo = r.intel.walletScore("SOLO");
  assert.equal(a.flags.cohort, true); assert.equal(a.cohort, "A,B,C");
  assert.equal(r.intel.walletScore("C").cohort, "A,B,C", "every member names the same ring");
  assert.equal(solo.flags.cohort, false); assert.equal(solo.cohort, null);
  assert.ok(a.score > 0, "a ring member is not excluded outright"); assert.ok(a.score < solo.score, `ring ${a.score} < solo ${solo.score}`);
  const sb = r.intel.smartBuyers(last.mint);
  assert.equal(sb.seen, 4);
  assert.equal(sb.count, 2, `A+B+C count once, SOLO once: ${JSON.stringify(sb.wallets)}`);
  const ring = sb.wallets.find(x => x.cohort); assert.equal(ring.cohort, 3); assert.equal(ring.members, 3);
  assert.ok(sb.wallets.some(x => x.wallet === "SOLO"));
  // two wallets that happened to overlap on one launch are not a ring
  const r2 = rig();
  for (let i = 0; i < 6; i++) { const L = launch(r2, i); buy(r2, L, "P", { after: 10_000 }); if (i === 0) buy(r2, L, "Q", { after: 20_000 }); }
  assert.equal(r2.intel.walletScore("P").flags.cohort, false);
});

test("a wash wallet scores 0 even though every round trip is a 'win'", () => {
  const stream = r => { for (let i = 0; i < 30; i++) { const L = launch(r, i); buy(r, L, "WASH", { after: 10_000, sol: 0.5 }); sell(r, L, "WASH", { after: 15_000, sol: 0.52 }); } };
  const r = rig({ minHoldMs: 0 }); stream(r);                       // hold-time rule off, so only the wash rule can zero it
  const w = r.intel.walletScore("WASH");
  assert.equal(w.closed, 30); assert.equal(w.wins, 30, "each five-second round trip nets a hair after fees");
  assert.equal(w.flags.wash, true); assert.equal(w.flags.sniper, false); assert.equal(w.score, 0);
  const off = rig({ minHoldMs: 0, washMinRoundTrips: 1e9 }); stream(off);
  assert.ok(off.intel.walletScore("WASH").score > 0, "without the wash rule this wallet would rank: the rule is what zeroes it");
});

test("an unproven wallet scores 0, never a small positive number", () => {
  const stream = r => { for (let i = 0; i < 5; i++) { const L = launch(r, i); buy(r, L, "LUCKY", { after: 30_000 }); run(r, L); sell(r, L, "LUCKY", { after: 20 * MIN, sol: 3 }); } };
  const r = rig(); stream(r);
  const s = r.intel.walletScore("LUCKY");
  assert.equal(s.closed, 5); assert.equal(s.wins, 5); assert.ok(s.pnlSol30d > 10);
  assert.equal(s.score, 0); assert.equal(INTEL_DEFAULTS.minClosed, 20);
  assert.deepEqual(r.intel.top(10), [], "nothing proven, nothing ranked");
  assert.equal(r.intel.smartBuyers("MINT4").count, 0);
  assert.equal(r.intel.walletScore("NEVER_SEEN").score, 0);
  assert.equal(s.flags.fresh, false, "fresh needs a proven record; this one is simply unproven");
  const r2 = rig({ minClosed: 5 }); stream(r2); r2.at(T0 + 8 * DAY); // old enough not to be a showcase wallet
  assert.ok(r2.intel.walletScore("LUCKY").score > 0, "the same record clears a lower bar: minClosed is the gate");
});

test("a fresh wallet with extraordinary stats is a showcase wallet, until it ages", () => {
  const r = rig({ minClosed: 5 });
  // 20 perfect trades inside three days
  for (let i = 0; i < 20; i++) {
    const ts = T0 + i * 3 * HOUR, mint = "F" + i; r.at(ts); r.intel.onCreate({ mint, creator: "D", ts, slot: slotAt(ts) }); r.intel.markMcap(mint, 6000, ts);
    const L = { mint, ts }; buy(r, L, "NEW", { after: 30_000 }); run(r, L); sell(r, L, "NEW", { after: 20 * MIN, sol: 1.5 });
  }
  const young = r.intel.walletScore("NEW");
  assert.equal(young.flags.fresh, true); assert.equal(young.score, 0);
  r.at(T0 + 8 * DAY);
  const older = r.intel.walletScore("NEW");
  assert.equal(older.flags.fresh, false); assert.ok(older.score > 0, "the record did not change, the age did");
});

test("smartBuyers counts only qualified wallets inside the window, and never a creation-slot buy", () => {
  const r = rig();
  const prove = (w, after) => { for (let i = 0; i < 24; i++) { const L = launch(r, i); buy(r, L, w, { after }); run(r, L); sell(r, L, w, { after: 20 * MIN, sol: 1.5 }); } };
  prove("GOOD", 20_000);
  prove("GOOD2", 25_000);
  const L = launch(r, 30);
  buy(r, L, "GOOD", { after: 20_000 });
  buy(r, L, "ROOKIE", { after: 30_000 });                 // no record
  buy(r, L, "GOOD2", { after: 8 * MIN });                  // proven, but late
  buy(r, L, "LATE_SNIPE", { after: 100, slot: L.slot + 1 });
  const s = r.intel.smartBuyers(L.mint);
  assert.equal(s.seen, 3); assert.equal(s.count, 1); assert.equal(s.wallets[0].wallet, "GOOD"); assert.equal(s.sumSol, 0.5);
  assert.equal(r.intel.smartBuyers(L.mint, { windowMs: 10 * MIN }).count, 2, "a wider window admits the late proven buyer");
  assert.equal(r.intel.smartBuyers(L.mint, { sinceTs: L.ts + 5 * MIN, windowMs: 5 * MIN }).count, 1, "a shifted window sees only GOOD2");
  assert.equal(r.intel.smartBuyers(L.mint, { threshold: 0.99 }).count, 0);
  assert.equal(r.intel.smartBuyers("UNKNOWN").count, 0);
  // a proven wallet that snipes this one launch does not count on it: the rule is per buy, not per wallet
  const L2 = launch(r, 31); buy(r, L2, "GOOD", { after: 100, slot: L2.slot });
  assert.equal(r.intel.smartBuyers(L2.mint).count, 0); assert.equal(r.intel.smartBuyers(L2.mint).seen, 1);
});

test("early hits: a run or a graduation after the buy is a hit, a flat mint is not; a forced close at 24h is realized", () => {
  const r = rig({ minClosed: 3 });
  const A = launch(r, 0); buy(r, A, "W", { after: 60_000 });                                  // runs 4x
  run(r, A); sell(r, A, "W", { after: 30 * MIN, sol: 1.6 });
  const B = launch(r, 1); buy(r, B, "W", { after: 60_000 }); sell(r, B, "W", { after: 30 * MIN, sol: 0.45 }); // never moved
  const C = launch(r, 2); buy(r, C, "W", { after: 60_000 }); r.at(C.ts + HOUR); r.intel.onGraduated(C.mint, C.ts + HOUR); // graduated, still held
  const D = launch(r, 3); buy(r, D, "W", { after: 10 * MIN });                                // not early (10 min)
  r.at(D.ts + 20 * MIN); r.intel.markMcap(D.mint, 60_000, D.ts + 20 * MIN);
  let s = r.intel.walletScore("W");
  assert.equal(s.earlyBuys, 3); assert.equal(s.earlyHits, 2); assert.equal(s.closed, 2);
  assert.equal(r.intel.status().openPositions, 2);
  r.at(D.ts + 25 * HOUR); r.intel.status();
  s = r.intel.walletScore("W");
  assert.equal(s.closed, 4, "C and D were closed by the clock");
  assert.equal(r.intel.status().openPositions, 0);
  assert.ok(s.pnlSol30d < 1.6 - 0.5 - 0.5, "the two unsold positions are sunk cost, not free");
  assert.equal(s.wins, 1);
  const closes = r.intel.wallets.get("W").closes;
  assert.ok(closes.every(c => Number.isFinite(c.pnl)));
  // a sell of tokens we never saw bought carries no pnl
  r.intel.onTrade({ mint: "GHOST", wallet: "W", isBuy: false, sol: 5, tokens: 1e6, ts: r.now() });
  assert.equal(r.intel.status().ignoredSells, 1);
  assert.equal(r.intel.walletScore("W").pnlSol30d, s.pnlSol30d);
});

test("deployer-funded is a flag only when a funder lookup is injected; absent, it is unknown", () => {
  const funders = { INSIDER: "DEV0", CLEAN: "EXCHANGE" };
  const r = rig({ minClosed: 5, fundedBy: w => funders[w] ?? null });
  for (let i = 0; i < 16; i++) {
    const L = launch(r, i, "DEV0"); // the same deployer every time, over a week so age is not the reason
    buy(r, L, "INSIDER", { after: 30_000 }); buy(r, L, "CLEAN", { after: 40_000 }); run(r, L);
    sell(r, L, "INSIDER", { after: 20 * MIN, sol: 1.5 }); sell(r, L, "CLEAN", { after: 20 * MIN, sol: 1.5 });
  }
  const ins = r.intel.walletScore("INSIDER"), clean = r.intel.walletScore("CLEAN");
  assert.equal(ins.flags.deployerFunded, true); assert.equal(ins.score, 0);
  assert.equal(clean.flags.deployerFunded, false); assert.ok(clean.score > 0);
  assert.equal(clean.flags.fresh, false);
  assert.equal(r.intel.smartBuyers("MINT15").count, 1);
  const r2 = rig({ minClosed: 5 });
  const L = launch(r2, 0, "DEV0"); buy(r2, L, "INSIDER", { after: 30_000 });
  assert.equal(r2.intel.walletScore("INSIDER").flags.deployerFunded, null);
  assert.equal(r2.intel.walletScore("NOBODY").flags.deployerFunded, null);
});

test("snapshot/restore round-trips scores, rings and open positions; the store is written on the persist cadence", async () => {
  const r = rig();
  let last = null;
  for (let i = 0; i < 25; i++) {
    const L = launch(r, i); last = L;
    buy(r, L, "A", { after: 20_000 }); buy(r, L, "B", { after: 35_000 }); buy(r, L, "C", { after: 50_000 }); buy(r, L, "EARLY", { after: 30_000 }); buy(r, L, "SNIPER", { after: 200, slot: L.slot });
    sell(r, L, "SNIPER", { after: 30_000, sol: 0.8 }); run(r, L);
    for (const w of ["A", "B", "C", "EARLY"]) if (i < 24) sell(r, L, w, { after: 20 * MIN, sol: 1.5 }); // launch 24 stays open
  }
  const before = r.intel.top(10), sbBefore = r.intel.smartBuyers(last.mint);
  assert.ok(before.length >= 4 && r.intel.status().openPositions === 4);
  const json = JSON.stringify(r.intel.snapshot());
  const r2 = rig(); r2.at(r.now());
  assert.equal(r2.intel.restore(JSON.parse(json)), true);
  assert.deepEqual(r2.intel.top(10), before);
  assert.deepEqual(r2.intel.smartBuyers(last.mint), sbBefore);
  assert.deepEqual(r2.intel.walletScore("SNIPER"), r.intel.walletScore("SNIPER"));
  assert.equal(r2.intel.status().openPositions, 4);
  // the open positions keep their cost basis across the restore: the same sell closes them the same way
  for (const x of [r, r2]) for (const w of ["A", "B", "C", "EARLY"]) sell(x, last, w, { after: 20 * MIN, sol: 1.5 });
  assert.deepEqual(r2.intel.walletScore("EARLY"), r.intel.walletScore("EARLY"));
  assert.equal(r2.intel.status().openPositions, 0);
  // a pending early entry restored on a mint that later runs is still credited
  const r3 = rig({ minClosed: 3 }); const L = launch(r3, 0); buy(r3, L, "P", { after: 30_000 });
  const r4 = rig({ minClosed: 3 }); r4.at(r3.now()); r4.intel.restore(JSON.parse(JSON.stringify(r3.intel.snapshot())));
  run(r4, L); assert.equal(r4.intel.walletScore("P").earlyHits, 1);
  assert.equal(r4.intel.restore({ v: 99 }), false);
  // persistence: a Map-backed store, written from the stream once per persistEveryMs, read back by load()
  const map = new Map(), store = { get: async k => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); } };
  const r5 = rig({ store, persistEveryMs: 10 * MIN });
  // Interleaved with the clock, so the cadence itself is what is tested: the window runs from the
  // last write, so a trade five minutes after it is silent and one eleven minutes after it writes.
  const L5a = launch(r5, 0); buy(r5, L5a, "X", { after: 30_000 });
  await r5.intel._persisting;
  assert.ok(map.has(INTEL_DEFAULTS.storeKey), "written from onTrade without anyone calling persist()");
  assert.equal(r5.intel.status().persisted, 1);
  r5.at(L5a.ts + 5 * MIN); r5.intel.onTrade({ mint: L5a.mint, wallet: "X2", isBuy: true, sol: 0.1, tokens: 1e6, ts: r5.now(), slot: slotAt(r5.now()), signature: "b:X2" });
  await r5.intel._persisting;
  assert.equal(r5.intel.status().persisted, 1, "inside the window: no second write");
  r5.at(L5a.ts + 11 * MIN); r5.intel.onTrade({ mint: L5a.mint, wallet: "X3", isBuy: true, sol: 0.1, tokens: 1e6, ts: r5.now(), slot: slotAt(r5.now()), signature: "b:X3" });
  await r5.intel._persisting;
  assert.equal(r5.intel.status().persisted, 2, "past the window: the next trade writes");
  sell(r5, L5a, "X", { after: 20 * MIN, sol: 1 });
  await r5.intel.persist();
  const r6 = rig({ store }); r6.at(r5.now());
  assert.equal(await r6.intel.load(), true);
  assert.deepEqual(r6.intel.walletScore("X"), r5.intel.walletScore("X"));
  assert.equal(await rig().intel.load(), false, "no store, nothing to load");
  const broken = rig({ store: { get: async () => "{not json", set: async () => {} } });
  assert.equal(await broken.intel.load(), false);
  const failing = rig({ store: { get: async () => null, set: async () => { throw new Error("redis down"); } }, persistEveryMs: 0 });
  const Lf = launch(failing, 0); buy(failing, Lf, "Y", { after: 1000 }); await failing.intel._persisting;
  assert.equal(failing.intel.status().persistErrors, 1, "a failed write is counted, never thrown into the stream");
});

test("memory stays bounded: no raw trades kept, positions die at 24h, mints at 25h, wallets capped and pruned", () => {
  const r = rig({ maxWallets: 60, maxClosesPerWallet: 20, sweepEveryMs: 0 });
  const wallets = Array.from({ length: 150 }, (_, i) => "W" + i);
  for (let i = 0; i < 400; i++) {
    const ts = T0 + i * 3 * HOUR, mint = "M" + i; r.at(ts); r.intel.onCreate({ mint, creator: "D", ts, slot: slotAt(ts) });
    const L = { mint, ts, slot: slotAt(ts) };
    for (let j = 0; j < 12; j++) { const w = wallets[(i * 7 + j) % wallets.length]; buy(r, L, w, { after: 10_000 + j * 1000 }); if (j % 3) sell(r, L, w, { after: 5 * MIN + j * 1000, sol: 0.4 }); }
    for (let k = 0; k < 20; k++) r.intel.markMcap(mint, 5000 + k, ts + k * MIN);
  }
  r.at(r.now() + 26 * HOUR); r.intel.status();
  const st = r.intel.status();
  assert.equal(st.openPositions, 0, "every position was closed by a sale or by the clock");
  assert.ok(st.forcedCloses > 0);
  assert.equal(st.mints, 0, "a mint is forgotten once its label window is over");
  assert.ok(st.wallets <= 60, `wallets capped: ${st.wallets}`);
  for (const w of r.intel.wallets.values()) {
    assert.ok(w.closes.length <= 20, `closes ring capped: ${w.closes.length}`);
    assert.ok(w.early.length <= INTEL_DEFAULTS.maxEarlyPerWallet);
    assert.ok(Object.keys(w.partners).length <= INTEL_DEFAULTS.maxPartners);
    assert.ok(Object.keys(w.sizes).length <= INTEL_DEFAULTS.maxSizes);
    assert.equal(w.trades, undefined, "no per-trade history on a wallet");
  }
  assert.equal(st.trades, 400 * 12 + 400 * 8, "every trade was counted, none was kept");
  const snap = JSON.stringify(r.intel.snapshot());
  assert.ok(snap.length < 200_000, `snapshot is aggregates, not history: ${snap.length} bytes`);
  // a wallet silent for a month is gone; one still trading is not
  const r2 = rig();
  const L0 = launch(r2, 0); buy(r2, L0, "OLD", { after: 1000 }); buy(r2, L0, "ACTIVE", { after: 2000 });
  for (let i = 1; i < 70; i++) { const L = launch(r2, i); buy(r2, L, "ACTIVE", { after: 1000 }); }
  r2.intel.status();
  assert.equal(r2.intel.wallets.has("OLD"), false); assert.equal(r2.intel.wallets.has("ACTIVE"), true);
});

test("a buy with no cost is not a cost basis: it opens nothing, and the sell after it is ignored", () => {
  const r = rig({ minClosed: 1 });
  const L = launch(r, 0);
  buy(r, L, "W", { after: 30_000, sol: 0 });
  run(r, L);
  sell(r, L, "W", { after: 20 * MIN, sol: 0.3 });
  const st = r.intel.walletScore("W");
  assert.equal(st.closed, 0, "nothing closed: there was never a lot"); assert.equal(st.score, 0);
  assert.equal(r.intel.status().counters?.ignoredBuys ?? r.intel.counters.ignoredBuys, 1);
  assert.equal(r.intel.counters.ignoredSells, 1, "the sell found no lot and was ignored, not credited as profit");
  // The same wallet with a real buy closes a real win.
  const L2 = launch(r, 1);
  buy(r, L2, "W", { after: 30_000, sol: 0.1 }); run(r, L2); sell(r, L2, "W", { after: 20 * MIN, sol: 0.3 });
  assert.equal(r.intel.walletScore("W").closed, 1);
});

test("a staggered ring counts once: the fourth member pairs with some members and not others, and still belongs to the ring", () => {
  const r = rig();
  for (let i = 0; i < 24; i++) {
    const L = launch(r, i);
    buy(r, L, "A", { after: 20_000 }); buy(r, L, "B", { after: 35_000 }); buy(r, L, "C", { after: 50_000 }); buy(r, L, "D", { after: 85_000 });
    buy(r, L, "SOLO", { after: 200_000 }); // inside the early window, outside every ring member's pairing window
    run(r, L);
    for (const w of ["A", "B", "C", "D", "SOLO"]) sell(r, L, w, { after: 20 * MIN, sol: 1.5 });
  }
  // D is 65s behind A, so A and D never pair; B-D and C-D do. Each member's own partner set differs.
  for (const w of ["A", "B", "C", "D"]) assert.equal(r.intel.walletScore(w).flags.cohort, true, `${w} is in the ring`);
  assert.notEqual(r.intel.walletScore("A").cohort, r.intel.walletScore("D").cohort, "their own views of the ring differ");
  assert.equal(r.intel.walletScore("SOLO").flags.cohort, false);
  const L = launch(r, 30);
  for (const w of ["A", "B", "C", "D", "SOLO"]) buy(r, L, w, { after: 30_000 });
  const s = r.intel.smartBuyers(L.mint, { windowMs: 5 * MIN });
  assert.equal(s.count, 2, `the ring once and SOLO: ${JSON.stringify(s.wallets)}`);
  const ring = s.wallets.find(x => x.wallet !== "SOLO");
  assert.equal(ring.members, 4); assert.equal(ring.cohort, 4);
});

test("an early buy is neither hit nor miss until the mint's first day is up", () => {
  const r = rig({ minClosed: 5 });
  for (let i = 0; i < 6; i++) { const L = launch(r, i); buy(r, L, "E", { after: 30_000 }); run(r, L); sell(r, L, "E", { after: 20 * MIN, sol: 1.5 }); }
  const proven = r.intel.walletScore("E");
  assert.equal(proven.earlyHitRate, 1);
  // Ten early buys seconds ago on mints that have not moved yet: no new information, no mark-down.
  for (let i = 10; i < 20; i++) { const ts = r.now() + 1000; r.at(ts); const mint = "FRESH" + i; r.intel.onCreate({ mint, creator: "DEV" + i, ts, slot: slotAt(ts) }); r.intel.markMcap(mint, 6000, ts); r.intel.onTrade({ mint, wallet: "E", isBuy: true, sol: 0.5, tokens: 1e6, ts: ts + 500, slot: slotAt(ts + 500), signature: "b:E:" + i }); }
  const now = r.intel.walletScore("E");
  assert.equal(now.earlyHitRate, 1, "pending entries are not misses"); assert.equal(now.earlyBuys, 6);
  // A day on, still flat: now they are misses.
  r.at(r.now() + 25 * HOUR);
  const later = r.intel.walletScore("E");
  assert.ok(later.earlyHitRate < 1 && later.earlyBuys === 16, JSON.stringify(later));
});
