// ═══ VELOCITY — Bounded learner (DP8) ═══
// Learns only the ranking weight vector that the edge's confidence reads.
// Kill gates are not learnable and are checksummed. Every weight stays inside
// its constraint, sacred directions can never flip, every version is kept,
// and any version can be restored. bondli's memetic learning pipeline pattern
// (permutation importance, 20% blend, WEIGHT_CONSTRAINTS, SACRED_INVERSIONS),
// promoted from a scorer detail to a design rule.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const DEFAULT_WEIGHTS = Object.freeze({
  pumpfun: Object.freeze({ apeScore: 0.30, memeticQuick: 0.15, survivorMatch: 0.10, chartHealth: 0.10, whaleBullish: 0.10, walletAge: 0.05, freshWalletRatio: 0.05, smartMoney: 0.10, waveLeader: 0.05 }),
});

// Signs are fixed here, not learned: a "negative" feature counts against confidence.
export const FEATURE_SIGNS = Object.freeze({
  pumpfun: Object.freeze({ apeScore: 1, memeticQuick: 1, survivorMatch: 1, chartHealth: 1, whaleBullish: 1, walletAge: 1, freshWalletRatio: -1, smartMoney: 1, waveLeader: 1 }),
});

export const WEIGHT_CONSTRAINTS = Object.freeze({
  pumpfun: Object.freeze({
    apeScore: Object.freeze({ min: 0.25, max: 0.60 }),
    memeticQuick: Object.freeze({ min: 0.05, max: 0.30 }),
    survivorMatch: Object.freeze({ min: 0.05, max: 0.35 }),
    chartHealth: Object.freeze({ min: 0.03, max: 0.25 }),
    whaleBullish: Object.freeze({ min: 0.03, max: 0.25 }),
    walletAge: Object.freeze({ min: 0.02, max: 0.15 }),
    freshWalletRatio: Object.freeze({ min: 0.02, max: 0.15 }),
    smartMoney: Object.freeze({ min: 0.03, max: 0.30 }),
    // Waves are also what a paid shill campaign looks like, so this can never grow into a main signal.
    waveLeader: Object.freeze({ min: 0.02, max: 0.15 }),
  }),
});

// Sacred: the learning loop may never make these count the other way.
export const SACRED_INVERSIONS = Object.freeze({
  // smartMoney is deliberately NOT sacred: labelled wallets get baited (buy, be copied, sell into
  // the copiers), so the data may honestly show it counting the other way for a while, and the
  // learner must be allowed to say so. Its floor in WEIGHT_CONSTRAINTS keeps it from being dropped.
  pumpfun: Object.freeze({ survivorMatch: "positive", apeScore: "positive", freshWalletRatio: "negative" }),
});

/** Ranking score in [0,1]: signed weighted sum, negatives measured as (1 - feature). */
// A feature that is null/undefined is MISSING, not zero: the radar's live path does not compute
// the memetic, survivor, whale and wallet-age enrichments, and counting them as 0 dragged every
// candidate's confidence under the floor. The weights renormalise over what is present.
export function scoreFeatures(features, weights, signs = FEATURE_SIGNS.pumpfun) {
  let s = 0, wsum = 0;
  for (const [k, w] of Object.entries(weights)) {
    const raw = features?.[k];
    if (raw == null || Number.isNaN(Number(raw))) continue;
    const f = Math.min(1, Math.max(0, Number(raw)));
    s += w * ((signs[k] ?? 1) < 0 ? 1 - f : f);
    wsum += w;
  }
  return wsum > 0 ? s / wsum : 0;
}

function lcg(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function accuracy(outcomes, weights, signs, threshold) {
  let ok = 0;
  for (const o of outcomes) ok += ((scoreFeatures(o.features, weights, signs) > threshold) === (o.pnl_usd > 0)) ? 1 : 0;
  return outcomes.length ? ok / outcomes.length : 0;
}

/**
 * Retrain from realized outcomes that carry the entry features.
 * Returns the bounded new weights plus what changed and why.
 */
export function retrain({ venue = "pumpfun", outcomes, weights, blendRate = 0.2, threshold = 0.6, seed = 1, minOutcomes = 30 } = {}) {
  const constraints = WEIGHT_CONSTRAINTS[venue];
  const sacred = SACRED_INVERSIONS[venue] || {};
  const signs = FEATURE_SIGNS[venue];
  const current = { ...(weights || DEFAULT_WEIGHTS[venue]) };
  const usable = (outcomes || []).filter(o => o && o.features && Number.isFinite(o.pnl_usd));
  const result = { venue, weights: current, importance: {}, violations: [], accuracyBefore: null, accuracyAfter: null, n: usable.length, changed: false, reason: null };
  if (usable.length < minOutcomes) { result.reason = `need ${minOutcomes} outcomes with features, have ${usable.length}`; return result; }

  const base = accuracy(usable, current, signs, threshold);
  const rnd = lcg(seed);
  const importance = {};
  for (const k of Object.keys(current)) {
    // Permutation importance: replace feature k with another outcome's value, measure the drop.
    const shuffled = usable.map(o => ({ ...o, features: { ...o.features, [k]: usable[Math.floor(rnd() * usable.length)].features[k] } }));
    importance[k] = base - accuracy(shuffled, current, signs, threshold);
  }
  const total = Object.values(importance).reduce((s, v) => s + Math.max(0, v), 0);
  const next = {};
  for (const [k, w] of Object.entries(current)) {
    const share = total > 0 ? Math.max(0, importance[k]) / total : w;
    let nw = w * (1 - blendRate) + share * blendRate;
    const c = constraints?.[k];
    if (c) nw = Math.min(c.max, Math.max(c.min, nw));
    next[k] = nw;
  }
  // Sacred check: direction of realized pnl vs feature must agree with the declared sign.
  for (const [k, dir] of Object.entries(sacred)) {
    const hi = usable.filter(o => (o.features[k] || 0) > 0.6), lo = usable.filter(o => (o.features[k] || 0) < 0.4);
    if (hi.length < 5 || lo.length < 5) continue;
    const mean = a => a.reduce((s, o) => s + o.pnl_usd, 0) / a.length;
    const observed = mean(hi) - mean(lo);
    const wants = dir === "positive" ? 1 : -1;
    if (observed * wants < 0) {
      // The data disagrees with a sacred prior. The prior wins; the weight is pinned to its floor
      // (it still counts in the sacred direction) and the disagreement is logged for a human.
      result.violations.push({ feature: k, expected: dir, observed: +observed.toFixed(4), action: "PINNED_TO_MIN_KEEPING_SIGN" });
      next[k] = constraints?.[k]?.min ?? next[k];
    }
  }
  const sum = Object.values(next).reduce((s, v) => s + v, 0);
  for (const k of Object.keys(next)) next[k] = +(next[k] / sum).toFixed(6);
  result.weights = next;
  result.importance = importance;
  result.accuracyBefore = +base.toFixed(4);
  result.accuracyAfter = +accuracy(usable, next, signs, threshold).toFixed(4);
  result.changed = Object.keys(next).some(k => Math.abs(next[k] - current[k]) > 1e-9);
  return result;
}

export class WeightStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  _file(v) { return path.join(this.dir, `v${v}.json`); }
  current() {
    const cur = path.join(this.dir, "current.json");
    if (!fs.existsSync(cur)) return { version: 0, weights: { ...DEFAULT_WEIGHTS.pumpfun }, meta: { source: "defaults" } };
    return JSON.parse(fs.readFileSync(cur, "utf8"));
  }
  history() {
    return fs.readdirSync(this.dir).filter(f => /^v\d+\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"))).sort((a, b) => a.version - b.version);
  }
  save(weights, meta = {}) {
    const version = (this.history().at(-1)?.version || 0) + 1;
    const rec = { version, weights, meta: { ...meta, savedAt: Date.now() } };
    fs.writeFileSync(this._file(version), JSON.stringify(rec, null, 2));
    this._setCurrent(rec);
    return rec;
  }
  rollback(version) {
    const f = this._file(version);
    if (!fs.existsSync(f)) throw new Error(`no weights version ${version}`);
    const rec = JSON.parse(fs.readFileSync(f, "utf8"));
    this._setCurrent({ ...rec, meta: { ...rec.meta, rolledBackAt: Date.now() } });
    return rec;
  }
  _setCurrent(rec) {
    const tmp = path.join(this.dir, "current.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, path.join(this.dir, "current.json"));
  }
}

// ── Gate integrity ──
const here = path.dirname(fileURLToPath(import.meta.url));
export const GATE_FILES = Object.freeze([
  path.resolve(here, "../../autoape/gates/disqualifiers.js"),
  path.resolve(here, "../../autoape/gates/viability.js"),
  path.resolve(here, "../../autoape/gates/confidence.js"),
  path.resolve(here, "../../autoape/gates/execution-window.js"),
  path.resolve(here, "../../autoape/gates/curve.js"), // four kill gates compare against this arithmetic
  path.resolve(here, "pipeline.mjs"),
  path.resolve(here, "risk.mjs"),
  path.resolve(here, "../venues/pumpfun/edge.mjs"),
  path.resolve(here, "../venues/polymarket/edge.mjs"),
]);

export function checksumFiles(files = GATE_FILES) {
  const out = {};
  for (const f of files) out[path.relative(process.cwd(), f)] = createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  return out;
}

export function verifyChecksums(recorded, files = GATE_FILES) {
  const now = checksumFiles(files);
  const changed = Object.keys(now).filter(k => recorded[k] && recorded[k] !== now[k]);
  return { ok: changed.length === 0, changed, current: now };
}
