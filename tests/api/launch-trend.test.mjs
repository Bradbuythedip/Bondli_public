// The line under the launch banner's number. What must hold: it never draws a trend it does not have,
// it never carries one token's history onto another, it stays bounded however long the launch runs,
// and the change it names is the change across the samples it actually drew.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LaunchTrend, LAUNCH_HISTORY_MAX, LAUNCH_SPARK_POINTS } from "../../src/api/launch-trend.mjs";

const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);
/** Feed n readings 15s apart, the way the server's own poll does. */
function fill(t, addr, mcaps, { from = 1_000_000, everyMs = 15_000 } = {}) {
  let now = from;
  for (const m of mcaps) { t.record(addr, { mcapUsd: m }, now); now += everyMs; }
  return now - everyMs;
}

test("T-LT: one reading is not a trend", () => {
  const t = new LaunchTrend();
  assert.equal(t.read(A), null, "nothing recorded");
  t.record(A, { mcapUsd: 9000 }, 1_000_000);
  assert.equal(t.read(A), null, "a single point has no direction");
  t.record(A, { mcapUsd: 11_000 }, 1_015_000);
  assert.ok(t.read(A), "two points is a trend");
});

test("T-LT: nothing without a token, a market cap, or a market cap above zero", () => {
  const t = new LaunchTrend();
  for (const [addr, data] of [["", { mcapUsd: 5000 }], [null, { mcapUsd: 5000 }], [A, null], [A, {}], [A, { mcapUsd: 0 }], [A, { mcapUsd: "n/a" }], [A, { error: "rpc down" }]])
    assert.equal(t.record(addr, data, 1_000_000), false, `${addr} ${JSON.stringify(data)}`);
  assert.equal(t.samples.length, 0);
  assert.equal(t.read(A), null);
});

test("T-LT: a second token starts its own history, and the first one's line is not shown for it", () => {
  const t = new LaunchTrend();
  fill(t, A, [10_000, 12_000, 14_000, 16_000]);
  assert.equal(t.read(A).points, 4);
  assert.equal(t.read(B), null, "B has no history, so B gets no line");
  t.record(B, { mcapUsd: 3000 }, 2_000_000);
  assert.equal(t.read(A), null, "A's line is gone the moment B takes over");
  assert.equal(t.read(B), null, "and B has one point, which is still not a trend");
  t.record(B, { mcapUsd: 4000 }, 2_015_000);
  assert.deepEqual(t.read(B).spark, [3000, 4000]);
});

test("T-LT: the change is measured across the samples, over a period it can name", () => {
  const t = new LaunchTrend();
  fill(t, A, [10_000, 15_000, 20_000, 40_000]);       // 4 points, 15s apart = 45s
  const r = t.read(A);
  assert.deepEqual(r.spark, [10_000, 15_000, 20_000, 40_000]);
  assert.equal(r.changePct, 300, "10k to 40k is +300%");
  assert.equal(r.spanMin, 1, "45 seconds rounds to a minute");
  const d = new LaunchTrend();
  fill(d, A, [40_000, 10_000]);
  assert.equal(d.read(A).changePct, -75, "a fall is negative, not an absolute");
});

test("T-LT: two samples cannot land closer than the minimum gap", () => {
  const t = new LaunchTrend();
  assert.equal(t.record(A, { mcapUsd: 10_000 }, 1_000_000), true);
  assert.equal(t.record(A, { mcapUsd: 11_000 }, 1_002_000), false, "2s later is the same refresh");
  assert.equal(t.record(A, { mcapUsd: 12_000 }, 1_009_999), false);
  assert.equal(t.record(A, { mcapUsd: 13_000 }, 1_010_000), true, "at the gap it counts");
  assert.equal(t.samples.length, 2);
});

test("T-LT: a long launch stays bounded and still draws a fixed-width line ending on the latest point", () => {
  const t = new LaunchTrend();
  const many = Array.from({ length: LAUNCH_HISTORY_MAX + 500 }, (_, i) => 10_000 + i * 10);
  fill(t, A, many);
  assert.equal(t.samples.length, LAUNCH_HISTORY_MAX, "memory does not grow with the launch's age");
  const r = t.read(A);
  assert.equal(r.spark.length, LAUNCH_SPARK_POINTS);
  assert.equal(r.spark[r.spark.length - 1], many[many.length - 1], "the line ends where the number is");
  assert.equal(r.points, LAUNCH_HISTORY_MAX);
  // the oldest sample survived the window, so the change is measured over the window, not all time
  assert.equal(r.changePct, +(((many[many.length - 1] - many[500]) / many[500]) * 100).toFixed(1));
});

test("T-LT: fewer samples than the line is wide draws every one of them, in order", () => {
  const t = new LaunchTrend();
  fill(t, A, [5000, 4000, 6000, 9000, 7000]);
  assert.deepEqual(t.read(A).spark, [5000, 4000, 6000, 9000, 7000]);
});

test("T-LT: a reset clears the line without waiting for a reading", () => {
  const t = new LaunchTrend();
  fill(t, A, [10_000, 20_000]);
  t.reset(B);
  assert.equal(t.read(A), null);
  assert.equal(t.read(B), null);
  assert.equal(t.samples.length, 0);
});
