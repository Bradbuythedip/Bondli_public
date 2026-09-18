// A token that wakes up after an hour flat is a revival; one wallet buying is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RevivalTracker, revivalFilter } from "../../src/api/revival.mjs";

const MIN = 60_000;
function quiet(tr, mint, from, to, curve) { // one buyer every 5 minutes, curve flat
  for (let t = from; t < to; t += 5 * MIN) tr.noteTrade(mint, { side: "buy", sol: 0.05, wallet: "w" + Math.floor(t / (5 * MIN)), curvePct: curve, ts: t });
}

test("revival: flat for an hour then 3x distinct buyers with SOL in and the curve up", () => {
  const tr = new RevivalTracker();
  const t0 = 1_800_000_000_000, created = t0 - 6 * 60 * MIN; // launched 6 hours ago
  quiet(tr, "M", t0 - 65 * MIN, t0 - 5 * MIN, 20);
  assert.deepEqual(tr.signal("M", { createdAt: created, now: t0 - 5 * MIN }).revival, false);
  // the wake-up: 8 distinct buyers in 5 minutes, curve 20 -> 27
  for (let i = 0; i < 8; i++) tr.noteTrade("M", { side: "buy", sol: 0.4, wallet: "new" + i, curvePct: 20 + i, ts: t0 - 4 * MIN + i * 20_000 });
  tr.noteTrade("M", { side: "sell", sol: 0.3, wallet: "w1", curvePct: 27, ts: t0 - 60_000 });
  const s = tr.signal("M", { createdAt: created, now: t0 });
  assert.equal(s.revival, true, JSON.stringify(s));
  assert.equal(s.buyers5m, 8); assert.equal(s.flat, true); assert.ok(s.curveDelta >= 5); assert.ok(s.netSol5m > 0);
  // the same burst on a token launched 20 minutes ago is the launch feed's business
  assert.deepEqual(tr.signal("M", { createdAt: t0 - 20 * MIN, now: t0 }).reasons, ["TOO_YOUNG_FOR_REVIVAL"]);
  assert.deepEqual(tr.signal("M", { now: t0 }).reasons, ["AGE_UNKNOWN"]);
});

test("revival: one wallet buying, SOL flowing out, or a curve that never moves does not fire", () => {
  const tr = new RevivalTracker();
  const t0 = 1_800_000_000_000, created = t0 - 3 * 60 * MIN;
  quiet(tr, "A", t0 - 65 * MIN, t0 - 5 * MIN, 40);
  for (let i = 0; i < 12; i++) tr.noteTrade("A", { side: "buy", sol: 1, wallet: "whale", curvePct: 40 + i, ts: t0 - 3 * MIN + i * 5000 });
  assert.ok(tr.signal("A", { createdAt: created, now: t0 }).reasons.includes("FEW_BUYERS"), "volume from one wallet is one buyer");
  quiet(tr, "B", t0 - 65 * MIN, t0 - 5 * MIN, 40);
  for (let i = 0; i < 8; i++) { tr.noteTrade("B", { side: "buy", sol: 0.1, wallet: "b" + i, curvePct: 46, ts: t0 - 3 * MIN + i * 5000 }); tr.noteTrade("B", { side: "sell", sol: 0.5, wallet: "s" + i, curvePct: 46, ts: t0 - 2 * MIN + i * 5000 }); }
  assert.ok(tr.signal("B", { createdAt: created, now: t0 }).reasons.includes("SOL_FLOWING_OUT"));
  quiet(tr, "C", t0 - 65 * MIN, t0 - 5 * MIN, 40);
  for (let i = 0; i < 8; i++) tr.noteTrade("C", { side: "buy", sol: 0.3, wallet: "c" + i, curvePct: 41, ts: t0 - 3 * MIN + i * 5000 });
  assert.ok(tr.signal("C", { createdAt: created, now: t0 }).reasons.includes("CURVE_NOT_MOVING"));
  // a token that was already climbing all hour is momentum, not a revival
  const tr2 = new RevivalTracker();
  for (let t = t0 - 65 * MIN, c = 10; t < t0 - 5 * MIN; t += 5 * MIN, c += 2) tr2.noteTrade("D", { side: "buy", sol: 0.2, wallet: "d" + t, curvePct: c, ts: t });
  for (let i = 0; i < 8; i++) tr2.noteTrade("D", { side: "buy", sol: 0.3, wallet: "dd" + i, curvePct: 45, ts: t0 - 3 * MIN + i * 5000 });
  assert.ok(tr2.signal("D", { createdAt: created, now: t0 }).reasons.includes("NOT_FLAT_BEFORE"));
  // pruning forgets a mint after the window
  tr.prune(t0 + 73 * 60 * MIN); assert.equal(tr.mints.size, 0);
});

test("revival filter: dev selling, one funding source, or a graduated token with no pool is refused", () => {
  assert.equal(revivalFilter({ graduated: false }, { rg_devSellSpeed: 0.1, _rg_sybilScore: 0.1 }).pass, true);
  assert.deepEqual(revivalFilter({}, { rg_devSellSpeed: 0.5 }).reasons, ["DEV_SELLING_INTO_IT"]);
  assert.deepEqual(revivalFilter({}, { _rg_sybilScore: 0.6 }).reasons, ["BUYERS_ONE_SOURCE"]);
  assert.deepEqual(revivalFilter({ graduated: true }, {}).reasons, ["NO_POOL_LIQUIDITY"]);
  assert.equal(revivalFilter({ graduated: true, _dexLiquidityUsd: 12_000 }, {}).pass, true);
  assert.deepEqual(revivalFilter({ _mayhem: true }, {}).reasons, ["MAYHEM"]);
});
