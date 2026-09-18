#!/usr/bin/env node
// gate-stats: offline calibration for GATE 1 (src/autoape/gates/disqualifiers.js) on the velocity path.
// Live:    node tools/gate-stats.mjs --minutes 30 [--out snap.jsonl] [--url http://127.0.0.1:3001]
// Offline: node tools/gate-stats.mjs --file snap.jsonl
// Polls /api/radar/scored?min=0&limit=200 every 60s, appends each response as one JSONL line, then reports:
//   - rule fire rates as recorded (the features the server computed at snapshot time)
//   - the same with the three features recomputed the way the server computes them now
//     (organic distribution ratio, organic quick-flip share, spike-immune mcap peak)
//   - which single rule, if dropped, would let the most tokens through ("binding" rules)
// Both columns are judged by the CURRENT rule table, so a rule change moves both; only the three
// recomputed features differ between them.
import { appendFileSync, readFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FILE = arg("--file"), OUT = arg("--out", "gate-snapshots.jsonl"), MIN = +arg("--minutes", 10);
// all=1: every token the radar holds, not only those past the base filter, so a runner the filter
// never admitted still shows up in the audit below.
const URL = (arg("--url", "http://127.0.0.1:3001")).replace(/\/$/, "") + "/api/radar/scored?min=0&limit=200&all=1";
const RUN_X = +arg("--runner-x", 3);
const FIRST_SIGHT_MAX = +arg("--first-sight-max", 90_000); // a curve token above this at first sight was not a launch we could have judged // a runner: peak mcap at least this multiple of the mcap when first seen at 2+ min
const MIN_BUYS = +arg("--min-buys", 10), MIN_AGE = +arg("--min-age", 2);

// ── Rule table: one entry per flag in checkDisqualifiers(), same expressions, same order. ──
// c = { age (min, from snapshot ts), vy (isVeryYoung), moderate, minSignals, volLeg }
const RULES = {
  SERIAL_LAUNCHER:      (t, q) => q?._devLaunchCount > 8,
  SERIAL_RUGGER:        (t, q) => q?._namePrevRugged && q._devLaunchCount > 3,
  DEV_SELLING:          (t, q) => q?.rg_devSellSpeed > 0.6,
  DEV_SELF_SNIPE:       (t, q) => q?._rg_devSelfSnipe > 0,
  DEV_HOLDS_SUPPLY:     (t, q) => q?._rg_devHoldPct > 0.10,
  FREEZE_AUTHORITY:     (t) => !!t.freezeAuthority,                         // velocity edge.mjs passes opts.freezeAuthority = !!token.freezeAuthority
  EXTREME_CONCENTRATION:(t, q) => q?.rg_holderConcentration > 0.7 && (t.buys || 0) > 5 && (q?._rg_organicBuyers ?? 99) >= 8 && !(q?._whaleBullish > 0.3),
  DEV_SELF_PUMP:        (t, q) => q?._rg_devSelfPumpScore >= 0.7,
  DEV_PUMP_NO_SELLS:    (t, q) => q?._rg_devSelfPumpScore >= 0.5 && q?._rg_zeroSellFlag >= 0.5,
  LINEAR_PUMP:          (t, q) => q?._rg_velocityLinearity > 0.9 && q?._rg_buySellImbalance > 0.7,
  BOT_PUMP:             (t, q) => q?._rg_buyTimingRegularity > 0.6 && q?._rg_singleWalletDominance > 0.4,
  "MULTI_RUG_SIGNAL_*": (t, q, c) => c.moderate >= c.minSignals,             // code emits MULTI_RUG_SIGNAL_<n>; collapsed here
  COORDINATED_DUMP:     (t, q) => q?.rg_coordDumpScore > 0.5 && q?.rg_sellWaveDetect > 0.5 && (t.sells || 0) > (t.buys || 0) * 0.5,
  PUMP_DUMP:            (t, q, c) => q?._rg_pumpDump > 0.6 && !c.vy,
  SYBIL_ATTACK:         (t, q) => q?._rg_sybilScore > 0.5,
  EARLY_DUMP:           (t, q, c) => q?._rg_earlyDump > 0.6 && c.age < 5,
  QUICK_FLIP:           (t, q) => q?._rg_quickFlipRate > 0.35,
  LIQ_REMOVAL:          (t, q, c) => q?.rg_liqRemovalSpeed > 0.65 && !c.vy,
  SMOOTH_GRIND:         (t, q, c) => q?.ch_smoothGrind > 0.6 && !c.vy,
  NO_DIPS_GRIND:        (t, q, c) => q?.ch_smoothGrind > 0.4 && q?.ch_dipRatio < 0.1 && !c.vy,
  MCAP_CRASHING:        (t, q, c) => q?.rg_mcapDropRate > 0.5 && !c.vy,
  STAIRCASE_CHART:      (t, q, c) => q?.ch_staircaseScore > 0.6 && !c.vy,
  STAIRCASE_FRESH:      (t, q, c) => q?.ch_staircaseScore > 0.4 && q?._rg_freshWalletRatio > 0.6 && !c.vy,
  FRESH_WALLET_RUG:     (t, q, c) => q?._rg_freshWalletRatio > 0.8 && q?._rg_zeroSellFlag > 0.4 && !c.vy,
  FLATLINE_SPIKE:       (t, q, c) => q?.ch_flatlineSpike > 0.5 && !c.vy,
  FLATLINE_NO_SELLS:    (t, q, c) => q?.ch_flatlineSpike > 0.3 && q?._rg_zeroSellFlag > 0.3 && !c.vy,
  FLATLINE_FRESH:       (t, q, c) => q?.ch_flatlineSpike > 0.3 && q?._rg_freshWalletRatio > 0.5 && !c.vy,
  ZERO_SELLS:           (t, q, c) => q?._rg_zeroSellFlag >= 0.8 && !c.vy,
  ZERO_SELLS_FAKE_CHART:(t, q, c) => q?._rg_zeroSellFlag >= 0.5 && (q?.ch_smoothGrind > 0.3 || q?.ch_staircaseScore > 0.3) && !c.vy,
  ALL_BUYS_NO_SELLS:    (t, q, c) => q?._rg_buySellImbalance >= 0.8 && (t.buys || 0) >= 15 && !c.vy,
  BOTTED_VOLUME:        (t, q, c) => !!c.volLeg && c.volLeg.botDetection?.botScore >= 70 && (t.buys || 0) >= 10,
  FAKE_VOLUME_HIGH_SOL: (t, q, c) => !!c.volLeg && c.volLeg.legitimacy === "LIKELY_BOTTED" && (t.volumeSol || 0) > 5,
  BOT_FARM_VOLUME:      (t, q, c) => { const s = c.volLeg?.botDetection?.signals || []; return !!c.volLeg && s.includes("METRONOMIC_TIMING") && s.includes("UNIFORM_TRADE_SIZES"); },
  STOLEN_ART:           (t) => !!t._artworkFlags?.includes("EXACT_DUPLICATE"),
  TOO_LATE:             (t) => !!t.vSolInBondingCurve && t.vSolInBondingCurve / 85 > 0.80,
  STALE:                (t, q, c) => c.age > 15,                              // velocity never passes opts.isRecoveryPlay
  TOO_FEW_BUYERS:       (t) => (t.uniqueBuyers?.size || 0) < 3,
  TOO_YOUNG:            (t, q, c) => c.age < 0.5,
};
const MODERATE = (t, q) => [
  q?.rg_devSellSpeed > 0.35, q?.rg_coordDumpScore > 0.3 && q?.rg_sellWaveDetect > 0.3, q?._rg_sybilScore > 0.3, q?._rg_quickFlipRate > 0.2,
  q?.rg_holderConcentration > 0.65 && (q?._rg_organicBuyers ?? 99) >= 8, q?._rg_earlyDump > 0.3, q?.rg_mcapDropRate > 0.3, q?._rg_pumpDump > 0.35,
  q?.ch_smoothGrind > 0.4, q?.ch_dipRatio < 0.08, q?._rg_zeroSellFlag > 0.5, q?._rg_buySellImbalance > 0.6,
  q?.ch_staircaseScore > 0.4, q?._rg_freshWalletRatio > 0.7, q?.ch_flatlineSpike > 0.3, t._artworkOriginal === false,
  q?._rg_velocityLinearity > 0.8, q?._rg_buyTimingRegularity > 0.5, q?._rg_singleWalletDominance > 0.5,
].filter(Boolean).length;

function evalRules(t, q, ts, skip = null) {
  const age = (ts - (t.createdAt || ts)) / 60000, vy = age < 2 && (t.sells || 0) >= 1;
  const moderate = MODERATE(t, q);
  const c = { age, vy, moderate, minSignals: vy ? 5 : 4, volLeg: t._volumeLegitimacy || q?._volumeLegitimacy };
  return { age, flags: Object.keys(RULES).filter(k => k !== skip && !!RULES[k](t, q, c)) };
}

/** The three features the on-chain trade source broke, recomputed from the snapshot's trade window
 *  the way src/api/server.production.mjs extractQuickFeatures() computes them now. The window is
 *  the last 60 trades (the server keeps 100), so this is an approximation of a fresh collection. */
function recompute(t, q) {
  if (!q) return q;
  const trades = (t.trades || []).filter(tr => !tr.hub);
  const buysT = trades.filter(tr => tr.side === "buy"), sellsT = trades.filter(tr => tr.side === "sell");
  const orgBuySol = buysT.reduce((s, tr) => s + (tr.sol || 0), 0), orgSellSol = sellsT.reduce((s, tr) => s + (tr.sol || 0), 0);
  const all = (t.volumeSol || 0) > 0 ? Math.min(1, (t.sellVolumeSol || 0) / t.volumeSol) : 0;
  const flow = orgBuySol + orgSellSol, totalFlow = (t.volumeSol || 0) + (t.sellVolumeSol || 0);
  const liq = flow >= 0.5 ? orgSellSol / flow : (totalFlow > 0 ? (t.sellVolumeSol || 0) / totalFlow : 0);
  const walletBuys = new Set(buysT.map(tr => tr.wallet).filter(Boolean));
  let quickFlips = 0; const firstBuy = new Map();
  for (const tr of trades) {
    if (tr.side === "buy" && tr.wallet && !firstBuy.has(tr.wallet)) firstBuy.set(tr.wallet, tr.time);
    if (tr.side === "sell" && tr.wallet) { const fb = firstBuy.get(tr.wallet); if (fb && tr.time - fb < 60000) quickFlips++; }
  }
  const quickFlipRate = (t.buys || 0) > 3 ? Math.min(1, quickFlips / Math.max(1, walletBuys.size)) : 0;
  const desc = (t.spark || []).slice().sort((a, b) => b - a);
  const peak = desc.length >= 3 ? desc[1] : (desc[0] || t.mcapUsd);
  const mcapDropRate = peak > 0 ? Math.max(0, (peak - (t.mcapUsd || 0)) / peak) : 0;
  return { ...q, rg_liqRemovalSpeed: liq, _rg_liqRemovalAll: all, _rg_quickFlipRate: quickFlipRate, rg_mcapDropRate: mcapDropRate };
}

// Mirror src/velocity/venues/pumpfun/feed.mjs hydrateToken(): gates read token.uniqueBuyers.size.
const hydrate = r => ({ ...r, uniqueBuyers: { size: typeof r.uniqueBuyers === "number" ? r.uniqueBuyers : r.uniqueBuyers?.size || 0 }, trades: r.trades || [], spark: r.spark || [] });
const pct = (a, p) => a.length ? +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))].toFixed(3) : NaN;
const fmt = (n, d) => (n / Math.max(1, d) * 100).toFixed(1).padStart(5) + "%";
const P = s => s.padEnd(24);

async function collect() {
  const end = Date.now() + MIN * 60000; let n = 0;
  while (Date.now() < end) {
    try { const r = await fetch(URL, { signal: AbortSignal.timeout(15000) }); const j = await r.json(); appendFileSync(OUT, JSON.stringify(j) + "\n"); n++;
      console.error(`[${new Date().toISOString()}] snapshot ${n}: ${j.count} tokens -> ${OUT}`); }
    catch (e) { console.error("poll failed:", e.message); }
    if (Date.now() < end) await new Promise(r => setTimeout(r, 60000));
  }
  return OUT;
}

/** Fire rates and pass sets over every qualifying token-snapshot, for one feature view. */
function tally(rows, gate, featuresOf) {
  const fire = Object.fromEntries(Object.keys(RULES).map(k => [k, 0]));
  const pass1 = new Set(), pass2 = new Set(), pass3 = new Set(), dropOne = Object.fromEntries(Object.keys(RULES).map(k => [k, new Set()]));
  const g2 = {}, g3 = {}, tiers = {}; let passed1 = 0, passed2 = 0, mayhem = 0, copycats = 0;
  let mismatch = 0; const mmEx = [], waivedCount = {};
  for (const { t, r, ts } of rows) {
    if (t._mayhem) { mayhem++; continue; } // never looked at
    if (t._copyOf) { copycats++; continue; } // an advert, never a trade
    const q = featuresOf(t, r.qf);
    const { flags } = evalRules(t, q, ts);
    for (const f of flags) fire[f]++;
    // Which single rule stands between this token and gate 1? Only rules that fired matter.
    if (flags.length === 1) dropOne[flags[0]].add(t.ca);
    if (flags.length === 2 && flags.includes("MULTI_RUG_SIGNAL_*")) { const other = flags.find(f => f !== "MULTI_RUG_SIGNAL_*"); if (other && !evalRules(t, q, ts, other).flags.length) dropOne[other].add(t.ca); }
    if (gate) { // the real gates with Date.now pinned to the snapshot time so offline replay ages correctly
      const now = Date.now; Date.now = () => ts;
      try {
        // The replica models the designed rules, so the cross-check judges at defaults; the pass counts
        // use the judge the bot trades on at the chosen aggression (knobs and the momentum waiver).
        const g1d = gate.d.checkDisqualifiers(t, q, { freezeAuthority: !!t.freezeAuthority });
        const real = g1d.flags.map(f => f.startsWith("MULTI_RUG_SIGNAL_") ? "MULTI_RUG_SIGNAL_*" : f).sort().join(",");
        if (real !== flags.slice().sort().join(",")) { mismatch++; if (mmEx.length < 5) mmEx.push(`${t.ca?.slice(0, 8)} real=[${real}] replica=[${flags}]`); }
        const g1 = gate.d.checkDisqualifiers(t, q, { ...gate.opts, freezeAuthority: !!t.freezeAuthority });
        for (const w of g1.waived || []) waivedCount[w] = (waivedCount[w] || 0) + 1;
        if (g1.pass) {
          pass1.add(t.ca); passed1++;
          const vi = gate.v.checkViability(t, q, r.scores || {}, r.dynamics, gate.opts);
          for (const c of vi.checks) g2[c] = (g2[c] || 0) + 1;
          if (vi.pass) {
            pass2.add(t.ca); passed2++;
            const conf = gate.c.classifyConfidence(t, q, r.scores || {}, r.dynamics, gate.opts);
            tiers[conf.tier] = (tiers[conf.tier] || 0) + 1;
            if (conf.tier >= 1 && conf.tier <= 3) {
              const ew = gate.e.checkExecutionWindow({ ...t, _apeScore: r.scores?.apeScore }, conf.tier, r.scores?.scoreTimestamp, gate.opts);
              for (const c of ew.checks) g3[c] = (g3[c] || 0) + 1;
              if (ew.pass) pass3.add(t.ca);
            } else g3[conf.tier === 4 ? "WATCHLIST" : "BELOW_THRESHOLD"] = (g3[conf.tier === 4 ? "WATCHLIST" : "BELOW_THRESHOLD"] || 0) + 1;
          }
        }
      } finally { Date.now = now; }
    } else if (!flags.length) pass1.add(t.ca);
  }
  return { fire, pass1, pass2, pass3, dropOne, mismatch, mmEx, g2, g3, tiers, passed1, passed2, mayhem, copycats, waivedCount };
}

async function report(file) {
  let gate = null; // real gates for cross-check + gate-2 pass count (only when run inside the repo)
  try {
    const edge = await import("../src/velocity/venues/pumpfun/edge.mjs");
    const level = Math.max(0, Math.min(3, parseInt(arg("--aggression", "2")) || 0));
    gate = { d: await import("../src/autoape/gates/disqualifiers.js"), v: await import("../src/autoape/gates/viability.js"), c: await import("../src/autoape/gates/confidence.js"), e: await import("../src/autoape/gates/execution-window.js"), opts: edge.AGGRESSION[level], level };
  } catch {}
  const snaps = readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const FIELDS = ["rg_holderConcentration", "rg_coordDumpScore", "rg_devSellSpeed", "_rg_freshWalletRatio", "_rg_sybilScore", "ch_healthScore", "apeScore", "rg_liqRemovalSpeed", "_rg_quickFlipRate", "rg_mcapDropRate"];
  const CW = ["_whaleBullish", "_devLaunchCount", "_namePrevRugged", "_devCredScore", "_walletAgeFresh"], TK = ["_volumeLegitimacy", "_artworkOriginal", "_artworkFlags", "_rugFlags", "_survivorMatch", "_bullishSignals", "_devTier"];
  const rows = [], seen = new Set(), missing = {}, distRec = {}, distNew = {};
  let hubTrades = 0, trades = 0;
  for (const f of FIELDS) { distRec[f] = []; distNew[f] = []; }
  for (const s of snaps) for (const r of s.tokens || []) {
    const t = hydrate(r.token), ts = s.ts || Date.now(), age = (ts - (t.createdAt || ts)) / 60000;
    seen.add(t.ca);
    if ((t.buys || 0) < MIN_BUYS || age < MIN_AGE) continue;
    rows.push({ t, r, ts });
    const q = r.qf, q2 = recompute(t, q);
    for (const f of FIELDS) { const v = f === "apeScore" ? r.scores?.apeScore : q?.[f]; if (typeof v === "number") distRec[f].push(v); const v2 = f === "apeScore" ? r.scores?.apeScore : q2?.[f]; if (typeof v2 === "number") distNew[f].push(v2); }
    for (const f of CW) if (q?.[f] == null || q[f] === 0 || q[f] === -1 || q[f] === false || (f === "_devCredScore" && q[f] === 0.5)) missing["qf." + f] = (missing["qf." + f] || 0) + 1;
    for (const f of TK) if (t[f] == null || (Array.isArray(t[f]) && !t[f].length)) missing["token." + f] = (missing["token." + f] || 0) + 1;
    for (const tr of t.trades) { trades++; if (tr.hub) hubTrades++; }
  }
  const N = rows.length;
  const rec = tally(rows, gate, (t, q) => q);
  const fix = tally(rows, gate, recompute);
  console.log(`\n${file}: ${snaps.length} snapshots, ${seen.size} distinct tokens, ${N} token-snapshots with buys>=${MIN_BUYS} & age>=${MIN_AGE}min\n`);
  console.log("GATE 1 rule fire rate (fraction of qualifying token-snapshots)   recorded | recomputed features");
  const order = Object.keys(RULES).sort((a, b) => fix.fire[b] - fix.fire[a] || rec.fire[b] - rec.fire[a]);
  for (const k of order) console.log(`  ${P(k)} ${fmt(rec.fire[k], N)} (${String(rec.fire[k]).padStart(5)}) | ${fmt(fix.fire[k], N)} (${String(fix.fire[k]).padStart(5)})`);
  console.log("\nFeature percentiles (recorded | recomputed)       p10     p50     p90 |     p10     p50     p90    (n)");
  for (const f of FIELDS) console.log(`  ${P(f)} ${String(pct(distRec[f], .1)).padStart(7)} ${String(pct(distRec[f], .5)).padStart(7)} ${String(pct(distRec[f], .9)).padStart(7)} | ${String(pct(distNew[f], .1)).padStart(7)} ${String(pct(distNew[f], .5)).padStart(7)} ${String(pct(distNew[f], .9)).padStart(7)}  (${distRec[f].length})`);
  console.log(`\nHub-flagged trades: ${fmt(hubTrades, trades)} of ${trades} trades (last 60 per token-snapshot)`);
  console.log("Counterweight / enrichment fields absent or at their fallback value (startAutoTrader-only enrichment):");
  for (const [k, v] of Object.entries(missing).sort((a, b) => b[1] - a[1])) console.log(`  ${P(k)} ${fmt(v, N)}`);
  console.log(`\nTokens passing gate 1 (any qualifying snapshot): recorded ${rec.pass1.size} -> recomputed ${fix.pass1.size}   passing gate 1 AND gate 2: ${gate ? `${rec.pass2.size} -> ${fix.pass2.size}` : "n/a (gates not importable)"}${gate ? `   AND gate 3 (enterable): ${fix.pass3.size}` : ""}`);
  if (fix.mayhem) console.log(`Mayhem token-snapshots skipped (never looked at): ${fix.mayhem}`);
  if (fix.copycats) console.log(`Copycat token-snapshots skipped (same-name adverts): ${fix.copycats}`);
  if (gate && Object.keys(fix.waivedCount).length) console.log(`Momentum waived at aggression ${gate.level} (token-snapshots): ${Object.entries(fix.waivedCount).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("  ")}`);
  if (gate) {
    console.log(`\nGATE 2 (viability) checks among token-snapshots that passed gate 1, aggression ${gate.level} (${fix.passed1} snapshots):`);
    for (const [k, v] of Object.entries(fix.g2).sort((a, b) => b[1] - a[1])) console.log(`  ${P(k)} ${fmt(v, fix.passed1)} (${v})`);
    console.log(`Tiers among those passing gate 2 (${fix.passed2} snapshots): ${Object.entries(fix.tiers).sort().map(([t, n]) => `tier${t}=${n}`).join("  ") || "(none)"}`);
    console.log(`GATE 3 (execution window) checks among tiered snapshots:`);
    for (const [k, v] of Object.entries(fix.g3).sort((a, b) => b[1] - a[1])) console.log(`  ${P(k)} ${v}`);
  }
  console.log("\nBinding rules with recomputed features: distinct tokens that would pass gate 1 if only this rule were dropped");
  const binding = Object.entries(fix.dropOne).map(([k, s]) => [k, s.size]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!binding.length) console.log("  (none: every blocked token trips at least two rules)");
  for (const [k, n] of binding) console.log(`  ${P(k)} +${n}`);
  if (gate) { console.log(`\nReplica vs real checkDisqualifiers mismatches: recorded ${rec.mismatch}/${N}, recomputed ${fix.mismatch}/${N}`); fix.mmEx.forEach(x => console.log("  " + x)); }
  if (gate) runnerAudit(snaps, gate);
}

// ── Runner audit: which runners did the judge miss, and which rule cost the most of them? ──
// A runner is a token whose mcap later reached RUN_X times its mcap at the first snapshot where it was
// 2+ minutes old (and at least $3k). A dud went on to lose half or never made 1.3x. For every runner
// we replay the real judge at the chosen aggression on each snapshot before the peak: enterable on any
// of them = caught; otherwise the gate that blocked it every time is what cost us the trade.
function runnerAudit(snaps, gate) {
  const byCa = new Map(); let skippedAgeUnknown = 0, skippedLate = 0;
  for (const s of snaps) for (const r of s.tokens || []) {
    const t = hydrate(r.token); if (t._mayhem || t._copyOf) continue;
    // A token the radar first met through a trade carries a guessed launch time until the coin API
    // answers; its "age" and "first sight" are fiction and it would show up as a runner that was not one.
    if (t._ageUnknown) { skippedAgeUnknown++; continue; }
    const ts = s.ts || Date.now();
    let e = byCa.get(t.ca); if (!e) { e = { ca: t.ca, name: t.name || t.ticker || t.ca.slice(0, 8), pts: [] }; byCa.set(t.ca, e); }
    e.pts.push({ ts, t, r, age: (ts - (t.createdAt || ts)) / 60000, mc: t.mcapUsd || 0 });
  }
  const runners = [], duds = [];
  for (const e of byCa.values()) {
    e.pts.sort((a, b) => a.ts - b.ts);
    const i0 = e.pts.findIndex(p => p.age >= 2 && p.mc >= 3000); if (i0 < 0 || i0 === e.pts.length - 1) continue;
    // First seen already past the curve (graduated, or a wrapped/major asset the stream echoed): the
    // bot never had a launch to judge, so a later move is not a missed runner.
    if (e.pts[i0].mc > FIRST_SIGHT_MAX) { skippedLate++; continue; }
    const first = e.pts[i0]; let peak = first, last = e.pts[e.pts.length - 1];
    for (const p of e.pts.slice(i0 + 1)) if (p.mc > peak.mc) peak = p;
    const x = peak.mc / first.mc;
    e.first = first; e.peak = peak; e.x = x; e.i0 = i0;
    if (x >= RUN_X) runners.push(e); else if (last.mc <= first.mc * 0.5 || x < 1.3) duds.push(e);
  }
  // judge one token-snapshot with the real gates, clock pinned
  const judge = (p) => {
    const now = Date.now; Date.now = () => p.ts;
    try {
      const t = p.t, q = recompute(t, p.r.qf), sc = p.r.scores || {}, dyn = p.r.dynamics;
      const opts = { ...gate.opts, freezeAuthority: !!t.freezeAuthority };
      const g1 = gate.d.checkDisqualifiers(t, q, opts); if (!g1.pass) return { gate: "rug", reasons: g1.flags.map(f => f.startsWith("MULTI_RUG_SIGNAL_") ? "MULTI_RUG_SIGNAL_*" : f) };
      const vi = gate.v.checkViability(t, q, sc, dyn, gate.opts); if (!vi.pass) return { gate: "viability", reasons: vi.checks };
      const conf = gate.c.classifyConfidence(t, q, sc, dyn, gate.opts); let tier = conf.tier; if (tier === 4 && gate.opts.enterWatchlist) tier = 3;
      if (!(tier >= 1 && tier <= 3)) return { gate: "confidence", reasons: [tier === 4 ? "WATCHLIST" : "BELOW_THRESHOLD"] };
      const ew = gate.e.checkExecutionWindow({ ...t, _apeScore: sc.apeScore }, tier, sc.scoreTimestamp, gate.opts); if (!ew.pass) return { gate: "window", reasons: ew.checks };
      return { gate: null, reasons: [], tier };
    } finally { Date.now = now; }
  };
  // The same base filter the radar applies at this aggression: Degen admits a token earlier.
  const loose = gate.level >= 3;
  const base = (p) => { const t = p.t, ub = t.uniqueBuyers?.size || 0; return loose ? ub >= 2 && (t.buys || 0) >= 3 && p.age >= 0.33 && p.mc >= 2500 : ub >= 3 && (t.sells || 0) >= 1 && (t.buys || 0) >= 5 && p.age >= 0.5 && p.mc >= 4000; };
  const baseWhy = (p) => { const t = p.t, ub = t.uniqueBuyers?.size || 0; return loose ? (ub < 2 ? "BUYERS<2" : (t.buys || 0) < 3 ? "BUYS<3" : p.mc < 2500 ? "MCAP<2.5k" : "AGE<20s") : (ub < 3 ? "BUYERS<3" : (t.buys || 0) < 5 ? "BUYS<5" : (t.sells || 0) < 1 ? "NO_SELL_YET" : p.mc < 4000 ? "MCAP<4k" : "AGE<30s"); };
  const caught = [], missed = [], ruleCost = {}, ruleSaved = {};
  const count = (tab, k) => { tab[k] = (tab[k] || 0) + 1; };
  for (const e of runners) {
    const before = e.pts.slice(e.i0, e.pts.indexOf(e.peak) + 1).filter(p => p !== e.peak);
    let best = null, ok = null;
    for (const p of before) {
      if (!base(p)) { const v = { gate: "base", reasons: [baseWhy(p)] }; if (!best) best = { p, v }; continue; }
      const v = judge(p);
      if (!v.gate) { ok = { p, v }; break; }
      if (!best || best.v.gate === "base" || v.reasons.length < best.v.reasons.length) best = { p, v };
    }
    if (ok) caught.push({ e, at: ok.p }); else { missed.push({ e, best }); if (best) for (const r of best.v.reasons) count(ruleCost, `${best.v.gate}:${r}`); }
  }
  for (const e of duds) { const p = e.first; if (!base(p)) continue; const v = judge(p); if (v.gate) for (const r of v.reasons) count(ruleSaved, `${v.gate}:${r}`); }
  console.log(`
RUNNER AUDIT (aggression ${gate.level}): ${byCa.size} tokens followed, ${runners.length} ran ${RUN_X}x+ from first sight at 2 min, ${duds.length} duds`);
  if (skippedAgeUnknown || skippedLate) console.log(`  left out: ${skippedAgeUnknown} first met through a trade (launch time unknown, so no honest age), ${skippedLate} first seen above $${FIRST_SIGHT_MAX / 1000}k (no launch to judge)`);
  console.log(`  caught (enterable on some snapshot before the peak): ${caught.length}   missed: ${missed.length}`);
  if (missed.length) {
    console.log(`  missed runners, the gate that blocked them on their best snapshot:`);
    const byGate = {}; for (const m of missed) count(byGate, m.best ? m.best.v.gate : "never 2+ min before peak");
    for (const [k, v] of Object.entries(byGate).sort((a, b) => b[1] - a[1])) console.log(`    ${P(k)} ${v}`);
    console.log(`  what each rule cost (missed runners it blocked) vs what it saved (duds it blocked at first sight):`);
    const keys = new Set([...Object.keys(ruleCost), ...Object.keys(ruleSaved)]);
    const table = [...keys].map(k => [k, ruleCost[k] || 0, ruleSaved[k] || 0]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1] || a[2] - b[2]);
    console.log(`    ${P("rule")} cost  saved  saved/cost`);
    for (const [k, c, sv] of table) console.log(`    ${P(k)} ${String(c).padStart(4)}  ${String(sv).padStart(5)}  ${(sv / c).toFixed(1)}`);
    console.log(`  the missed runners themselves (first sight -> peak):`);
    for (const m of missed.sort((a, b) => b.e.x - a.e.x).slice(0, 15)) console.log(`    ${m.e.name.padEnd(16).slice(0, 16)} ${m.e.ca.slice(0, 8)}  $${Math.round(m.e.first.mc / 1000)}k -> $${Math.round(m.e.peak.mc / 1000)}k (${m.e.x.toFixed(1)}x) in ${Math.round((m.e.peak.ts - m.e.first.ts) / 60000)}m  ${m.best ? `${m.best.v.gate}: ${m.best.v.reasons.slice(0, 3).join(", ")}` : "no snapshot to judge"}`);
  }
  if (caught.length) console.log(`  caught: ${caught.slice(0, 10).map(c => `${c.e.name.slice(0, 12)} ${c.e.x.toFixed(1)}x`).join("  ")}`);
}

report(FILE || await collect()).catch(e => { console.error(e); process.exit(1); });
