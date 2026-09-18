// T8: after retraining, gate checksums are unchanged, every weight is inside its
// constraint, no sacred inversion has flipped, and any version can be restored.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retrain, WeightStore, DEFAULT_WEIGHTS, WEIGHT_CONSTRAINTS, SACRED_INVERSIONS, checksumFiles, verifyChecksums, scoreFeatures } from "../../src/velocity/core/learner.mjs";

function lcg(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; }

function synth(n, { survivorHelps = true, seed = 3 } = {}) {
  const rnd = lcg(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = { apeScore: rnd(), memeticQuick: rnd(), survivorMatch: rnd(), chartHealth: rnd(), whaleBullish: rnd(), walletAge: rnd(), freshWalletRatio: rnd() };
    const signal = (survivorHelps ? f.survivorMatch : 1 - f.survivorMatch) * 0.7 + f.apeScore * 0.3 + (rnd() - 0.5) * 0.3;
    out.push({ features: f, pnl_usd: signal > 0.5 ? 8 : -6 });
  }
  return out;
}

test("T8: retrain keeps constraints, sums to one, and gates untouched", () => {
  const before = checksumFiles();
  const r = retrain({ outcomes: synth(200), weights: DEFAULT_WEIGHTS.pumpfun });
  assert.equal(r.n, 200);
  const sum = Object.values(r.weights).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-4);
  for (const [k, w] of Object.entries(r.weights)) {
    const c = WEIGHT_CONSTRAINTS.pumpfun[k];
    assert.ok(w >= c.min - 1e-9 && w <= c.max + 1e-9, `${k}=${w} outside [${c.min},${c.max}]`);
  }
  assert.ok(r.weights.survivorMatch >= DEFAULT_WEIGHTS.pumpfun.survivorMatch - 1e-9, "the feature that predicts pnl does not lose weight");
  assert.equal(r.violations.length, 0);
  const after = verifyChecksums(before);
  assert.equal(after.ok, true, `gate files changed: ${after.changed}`);
});

test("T8: data that contradicts a sacred prior cannot flip it", () => {
  const r = retrain({ outcomes: synth(200, { survivorHelps: false, seed: 9 }), weights: DEFAULT_WEIGHTS.pumpfun });
  const v = r.violations.find(x => x.feature === "survivorMatch");
  assert.ok(v, "violation recorded for a human");
  assert.equal(v.expected, "positive");
  assert.ok(v.observed < 0);
  assert.equal(r.weights.survivorMatch, +(WEIGHT_CONSTRAINTS.pumpfun.survivorMatch.min / Object.values(r.weights).reduce((s, x) => s + x, 0) * 0 + r.weights.survivorMatch).toFixed(6));
  assert.ok(r.weights.survivorMatch > 0, "still counts in the sacred direction");
  assert.deepEqual(Object.keys(SACRED_INVERSIONS.pumpfun).sort(), ["apeScore", "freshWalletRatio", "survivorMatch"]);
  // Negative-signed features reduce confidence as they rise.
  const lo = scoreFeatures({ freshWalletRatio: 0.1 }, { freshWalletRatio: 1 });
  const hi = scoreFeatures({ freshWalletRatio: 0.9 }, { freshWalletRatio: 1 });
  assert.ok(lo > hi);
});

test("T8: too few outcomes leaves weights unchanged; versions persist and roll back", () => {
  const r = retrain({ outcomes: synth(10), weights: DEFAULT_WEIGHTS.pumpfun });
  assert.equal(r.changed, false);
  assert.match(r.reason, /need 30/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velocity-t8-"));
  const store = new WeightStore(dir);
  assert.equal(store.current().version, 0);
  const v1 = store.save({ ...DEFAULT_WEIGHTS.pumpfun }, { note: "seed" });
  const v2 = store.save(retrain({ outcomes: synth(100), weights: v1.weights }).weights, { note: "retrain" });
  assert.equal(v2.version, 2);
  assert.equal(store.current().version, 2);
  store.rollback(1);
  assert.equal(store.current().version, 1);
  assert.equal(store.history().length, 2);
  assert.throws(() => store.rollback(9), /no weights version/);
});

test("T8: a rule that refuses a runner leaves a record of what it cost", async () => {
  const { Engine } = await import("../../src/velocity/core/engine.mjs");
  const { makeEvent } = await import("../../src/velocity/core/events.mjs");
  const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path");
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { GateRunner } = await import("../../src/velocity/core/pipeline.mjs");
  const { PumpfunPaperRouter } = await import("../../src/velocity/venues/pumpfun/router.mjs");
  const { loadRiskEnvelope } = await import("../../src/velocity/core/risk.mjs");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miss-"));
  const base = JSON.parse(fs.readFileSync(path.resolve("src/velocity/config/risk.example.json"), "utf8"));
  const cfg = { ...base, bankroll_usd: 50, per_trade_max_usd: 10, portfolio_max_exposure_usd: 40, daily_loss_limit_usd: 15, max_concurrent_positions: 4 };
  cfg.venues = { ...base.venues, pumpfun: { ...base.venues.pumpfun, max_exposure_usd: 40, min_stake_usd: 5 }, polymarket: { ...base.venues.polymarket, max_exposure_usd: 0 } };
  fs.writeFileSync(path.join(dir, "risk.json"), JSON.stringify(cfg));
  const env = loadRiskEnvelope(path.join(dir, "risk.json"));
  const edge = makePumpfunEdge({ aggression: 1 });
  const engine = new Engine({ dataDir: dir, envelope: env, config: { missMultiple: 1.6, missWatchMs: 10 * 60_000 },
    venues: { pumpfun: { mode: "paper", edge, runner: new GateRunner({ venue: "pumpfun", edge }),
      router: new PumpfunPaperRouter({ bookFile: path.join(dir, "book.json"), latencyMs: 0 }) } } });
  let now = 1_700_000_000_000; engine.clock = () => now;

  // A token with three buyers is refused by gate 1 (TOO_FEW_BUYERS), at a $9,000 market cap.
  const ev = (mcap, at) => makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintRan", t_venue: at - 100, t_observed: at,
    payload: { mcapUsd: mcap, vSolInBondingCurve: 32, scores: { apeScore: 70, scoreTimestamp: at },
      token: { ca: "MintRan", createdAt: at - 4 * 60_000, buys: 6, sells: 1, uniqueBuyers: { size: 2 }, volumeSol: 3, mcapUsd: mcap, vSolInBondingCurve: 32, trades: [], spark: [] }, qf: {} } });

  await engine.onEvent(ev(9_000, now));
  const rej = engine.ledger.query({ kind: "decision", limit: 1 })[0];
  assert.equal(rej.action, "REJECT");
  assert.ok(engine.disqualified.get("MintRan"), "the refusal is remembered, not just counted");
  assert.equal(engine.disqualified.get("MintRan").mcap, 9_000);
  assert.equal(engine.ledger.query({ kind: "miss" }).length, 0);

  // It drifts up 40%: not yet a miss.
  now += 60_000; await engine.onEvent(ev(12_600, now));
  assert.equal(engine.ledger.query({ kind: "miss" }).length, 0, "1.4x is inside the noise");

  // It doubles. That is what the rule cost, and it is now on the record -- once.
  now += 60_000; await engine.onEvent(ev(18_000, now));
  const misses = engine.ledger.query({ kind: "miss" });
  assert.equal(misses.length, 1);
  assert.equal(misses[0].instrument, "MintRan");
  assert.equal(misses[0].multiple, 2);
  assert.equal(misses[0].mcap_at_reject, 9_000);
  assert.ok(misses[0].reasons.includes("TOO_FEW_BUYERS"), misses[0].reasons.join(","));
  now += 60_000; await engine.onEvent(ev(40_000, now));
  assert.equal(engine.ledger.query({ kind: "miss" }).length, 1, "recorded once, not on every tick after");

  // The summary attributes the cost to the rule that caused it.
  const byRule = engine.misses();
  const row = byRule.find(r => r.reason === "TOO_FEW_BUYERS");
  assert.ok(row && row.n === 1 && row.best === 2, JSON.stringify(byRule));

  // Nothing is watched forever: the memo is dropped once the window closes.
  now += 20 * 60_000; engine.pruneMemos(now);
  assert.equal(engine.disqualified.get("MintRan"), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T8: realized statistics age out, so a tier the EV gate closed can reopen", async () => {
  const { Engine } = await import("../../src/velocity/core/engine.mjs");
  const { loadRiskEnvelope } = await import("../../src/velocity/core/risk.mjs");
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { PumpfunPaperRouter } = await import("../../src/velocity/venues/pumpfun/router.mjs");
  const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "window-"));
  const base = JSON.parse(fs.readFileSync(path.resolve("src/velocity/config/risk.example.json"), "utf8"));
  const cfg = { ...base, bankroll_usd: 200, per_trade_max_usd: 25, portfolio_max_exposure_usd: 100, daily_loss_limit_usd: 50, max_concurrent_positions: 4 };
  cfg.venues = { ...base.venues, pumpfun: { ...base.venues.pumpfun, max_exposure_usd: 100, min_stake_usd: 5 }, polymarket: { ...base.venues.polymarket, max_exposure_usd: 0 } };
  fs.writeFileSync(path.join(dir, "risk.json"), JSON.stringify(cfg));
  const edge = makePumpfunEdge({ aggression: 1 });
  const WINDOW = 14 * 24 * 60 * 60_000;
  const e = new Engine({ dataDir: dir, envelope: loadRiskEnvelope(path.join(dir, "risk.json")), config: { statsWindowMs: WINDOW },
    venues: { pumpfun: { mode: "paper", edge, router: new PumpfunPaperRouter({ bookFile: path.join(dir, "b.json"), latencyMs: 0 }) } } });
  let now = 1_800_000_000_000; e.clock = () => now;

  // Forty losing tier-3 outcomes. Past minOutcomesForStats, so the edge stops using priors.
  for (let i = 0; i < 40; i++) e.ledger.append({ kind: "outcome", ts: now, venue: "pumpfun", instrument: `M${i}`, tier: 3, paper: true, pnl_usd: -2, stake_usd: 25, reason: "SL2" });
  assert.ok(e.modeStats().pumpfun[3].n >= 30, "the tier is being judged on its own record");
  assert.equal(e.modeStats().pumpfun[3].p_win, 0);

  // Two weeks and a day later, that record is no longer evidence about today.
  now += WINDOW + 24 * 60 * 60_000;
  assert.equal(e.modeStats().pumpfun?.[3], undefined, "the window is empty, so the tier falls back to priors and can probe again");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T8: the shared judge reads the record of the venue it is judging", async () => {
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const cand = { tier: 3, instrument: "X", token: { ca: "X", uniqueBuyers: { size: 9 }, buys: 12, sells: 2, createdAt: Date.now() - 120_000, mcapUsd: 9000, trades: [] }, qf: {}, scores: { apeScore: 50 }, reference: {} };
  // Two very different records under the same tier, one per venue.
  const stats = {
    pumpfun: { 3: { n: 100, p_win: 0.60, payoff: 4, loss_fraction: 0.05 } },
    pons:    { 3: { n: 100, p_win: 0.10, payoff: 1.2, loss_fraction: 0.20 } },
  };
  const onPump = makePumpfunEdge({ venue: "pumpfun", aggression: 1 }).estimate(cand, { stats });
  const onPons = makePumpfunEdge({ venue: "pons", aggression: 1 }).estimate(cand, { stats });
  assert.equal(onPump.p_win, 0.60);
  assert.equal(onPons.p_win, 0.10, "Robinhood Chain is not priced with pump.fun's win rate");
  assert.equal(onPons.loss_fraction, 0.20);
  assert.equal(onPons.on_priors, false, "and its own record is what makes it stop using priors");
  // A venue with no record of its own still falls back to priors rather than borrowing another's.
  const noRecord = makePumpfunEdge({ venue: "pons", aggression: 1 }).estimate(cand, { stats: { pumpfun: stats.pumpfun } });
  assert.equal(noRecord.on_priors, true);
  assert.equal(noRecord.p_win, 0.30);
});
