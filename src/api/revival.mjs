// ═══ Revivals: a token that wakes up hours or days after launch ═══
// The launch feed only sees the first hour. This keeps a rolling 72-hour window per mint, in
// 5-minute buckets of what matters (distinct buyers, net SOL, curve progress), and fires on the
// one pattern that is a revival rather than one actor bidding to exit: flat for an hour, then
// distinct buyers at 3x the prior hour's pace with SOL flowing in and the curve moving up.
const MIN = 60_000;

export const REVIVAL_DEFAULTS = Object.freeze({
  windowMs: 72 * 60 * MIN,   // remember a mint this long after its last trade
  bucketMs: 5 * MIN,
  minAgeMs: 60 * MIN,        // younger than this is the launch feed's job
  buyerMultiple: 3,          // 5-minute distinct buyers vs the prior hour's 5-minute average
  minBuyers5m: 6,            // and never fewer than this: 3x of nothing is nothing
  curveDeltaPts: 5,          // curve progress up this many points...
  flatPts: 3,                // ...after moving less than this over the prior hour
});

// ═══ Slow cooks: a token that never went quiet, it is just taking its time ═══
// The stale clock (15 min at the designed settings) throws away everything older than it, on the
// assumption that a token either runs in its first quarter hour or never will. Tokens that grind up
// over an hour are the ones that rule costs us, and they are not revivals: a revival needs an hour of
// flat followed by a 3x burst, and a slow cook is by definition never flat. This is the other
// pattern in the same buckets — still buying, still steady, still going up — and all it buys the
// token is the clock. Every rug rule in gate 1 still judges it, and it enters at its own tier.
export const SLOWCOOK_DEFAULTS = Object.freeze({
  windowMin: 30,         // "still building" is measured over this much of the recent past
  minAgeMs: 10 * MIN,    // younger than this is the launch feed's own job
  minBuyers: 8,          // distinct buyers across the window
  minActiveBuckets: 4,   // of the window's six 5-minute buckets: steady arrival, not one burst
  minCurveDeltaPts: 2,   // and the curve actually moved up, so it is cooking rather than simmering
  minRecentShare: 0.35,  // this share of those buyers arrived in the window's second half
});

export class RevivalTracker {
  constructor(opts = {}) { this.o = { ...REVIVAL_DEFAULTS, ...opts }; this.s = { ...SLOWCOOK_DEFAULTS, ...(opts.slowCook || {}) }; this.mints = new Map(); }

  /** One trade. curvePct is 0..100 bonding-curve progress (or null once graduated). */
  noteTrade(mint, { side, sol = 0, wallet = "", curvePct = null, ts = Date.now() }) {
    if (!mint || (side !== "buy" && side !== "sell")) return;
    let m = this.mints.get(mint);
    if (!m) { m = { buckets: new Map(), lastAt: 0 }; this.mints.set(mint, m); }
    const k = Math.floor(ts / this.o.bucketMs);
    let b = m.buckets.get(k);
    if (!b) { b = { buyers: new Set(), sellers: new Set(), buySol: 0, sellSol: 0, curve: null }; m.buckets.set(k, b); }
    if (side === "buy") { if (wallet) b.buyers.add(wallet); b.buySol += Number(sol) || 0; }
    else { if (wallet) b.sellers.add(wallet); b.sellSol += Number(sol) || 0; }
    if (curvePct != null) b.curve = Number(curvePct);
    m.lastAt = Math.max(m.lastAt, ts);
    if (m.buckets.size > (this.o.windowMs / this.o.bucketMs) + 2) { const cut = k - this.o.windowMs / this.o.bucketMs; for (const kk of m.buckets.keys()) if (kk < cut) m.buckets.delete(kk); }
  }

  active(mint, now = Date.now(), withinMs = 6 * 60 * MIN) { const m = this.mints.get(mint); return !!m && now - m.lastAt <= withinMs; }

  /** The signal for one mint. createdAt is the token's real launch time. */
  signal(mint, { createdAt, now = Date.now() } = {}) {
    const m = this.mints.get(mint);
    const out = { revival: false, reasons: [], buyers5m: 0, baseline5m: 0, netSol5m: 0, curveDelta: 0, flat: null, ageMs: createdAt ? now - createdAt : null };
    if (!m) { out.reasons.push("NO_TRADES"); return out; }
    if (!createdAt) { out.reasons.push("AGE_UNKNOWN"); return out; }
    if (now - createdAt < this.o.minAgeMs) { out.reasons.push("TOO_YOUNG_FOR_REVIVAL"); return out; }
    const k = Math.floor(now / this.o.bucketMs), per = 60 * MIN / this.o.bucketMs;
    const cur = m.buckets.get(k), prev = m.buckets.get(k - 1);
    // "now" is the current 5 minutes plus whatever of the previous bucket keeps it from being a boundary artefact
    const buyers = new Set([...(cur?.buyers || []), ...(prev?.buyers || [])]);
    out.buyers5m = buyers.size;
    out.netSol5m = +(((cur?.buySol || 0) + (prev?.buySol || 0)) - ((cur?.sellSol || 0) + (prev?.sellSol || 0))).toFixed(4);
    let baseBuyers = 0, first = null, last = null, lo = Infinity, hi = -Infinity;
    for (let i = k - 1 - per; i < k - 1; i++) { const b = m.buckets.get(i); if (!b) continue; baseBuyers += b.buyers.size; if (b.curve != null) { if (first == null) first = b.curve; last = b.curve; lo = Math.min(lo, b.curve); hi = Math.max(hi, b.curve); } }
    out.baseline5m = +(baseBuyers / per).toFixed(2);
    out.flat = first == null ? null : hi - lo <= this.o.flatPts;
    const curveNow = cur?.curve ?? prev?.curve ?? null;
    out.curveDelta = curveNow != null && last != null ? +(curveNow - last).toFixed(1) : 0;
    if (out.buyers5m < this.o.minBuyers5m) out.reasons.push("FEW_BUYERS");
    if (out.buyers5m < this.o.buyerMultiple * Math.max(out.baseline5m, 1)) out.reasons.push("NO_ACCELERATION");
    if (!(out.netSol5m > 0)) out.reasons.push("SOL_FLOWING_OUT");
    if (curveNow != null) { // on the curve: flat then up. Graduated tokens have no curve; buyers and SOL decide.
      if (out.flat === false) out.reasons.push("NOT_FLAT_BEFORE");
      if (out.curveDelta < this.o.curveDeltaPts) out.reasons.push("CURVE_NOT_MOVING");
    }
    out.revival = out.reasons.length === 0;
    return out;
  }

  /** Still cooking? The same buckets, read for steady accumulation rather than a burst after silence. */
  slowCook(mint, { createdAt, now = Date.now() } = {}) {
    const o = this.s;
    const out = { slowCook: false, reasons: [], buyers: 0, activeBuckets: 0, netSol: 0, curveDelta: 0, recentShare: 0, windowMin: o.windowMin, ageMs: createdAt ? now - createdAt : null };
    const m = this.mints.get(mint);
    if (!m) { out.reasons.push("NO_TRADES"); return out; }
    if (!createdAt) { out.reasons.push("AGE_UNKNOWN"); return out; }
    if (now - createdAt < o.minAgeMs) { out.reasons.push("TOO_YOUNG_TO_BE_SLOW"); return out; }
    // The newest bucket starts at `now` and runs forward, so between n-1 and n of these hold past
    // trades depending on where in the bucket we are. minActiveBuckets is set below both.
    const k = Math.floor(now / this.o.bucketMs);
    const n = Math.max(2, Math.round((o.windowMin * MIN) / this.o.bucketMs));
    const mid = k - Math.floor(n / 2) + 1;
    const all = new Set(), recent = new Set();
    let buySol = 0, sellSol = 0, first = null, last = null;
    for (let i = k - n + 1; i <= k; i++) {
      const b = m.buckets.get(i); if (!b) continue;
      if (b.buyers.size) out.activeBuckets++;
      for (const w of b.buyers) { all.add(w); if (i >= mid) recent.add(w); }
      buySol += b.buySol; sellSol += b.sellSol;
      if (b.curve != null) { if (first == null) first = b.curve; last = b.curve; }
    }
    out.buyers = all.size;
    out.netSol = +(buySol - sellSol).toFixed(4);
    out.curveDelta = first != null && last != null ? +(last - first).toFixed(1) : 0;
    out.recentShare = all.size ? +(recent.size / all.size).toFixed(2) : 0;
    if (out.buyers < o.minBuyers) out.reasons.push("FEW_BUYERS");
    if (out.activeBuckets < o.minActiveBuckets) out.reasons.push("ONE_BURST");
    if (!(out.netSol > 0)) out.reasons.push("SOL_FLOWING_OUT");
    // No curve reading means it graduated or the venue does not report one; buyers and SOL decide.
    if (first != null && out.curveDelta < o.minCurveDeltaPts) out.reasons.push("CURVE_NOT_MOVING");
    if (out.recentShare < o.minRecentShare) out.reasons.push("FADING");
    out.slowCook = out.reasons.length === 0;
    return out;
  }

  prune(now = Date.now()) { for (const [mint, m] of this.mints) if (now - m.lastAt > this.o.windowMs) this.mints.delete(mint); }
}

/** The filter on a firing signal: most "revivals" are one actor bidding to exit. */
export function revivalFilter(token, qf, sig) {
  const reasons = [];
  if ((qf?.rg_devSellSpeed || 0) > 0.25) reasons.push("DEV_SELLING_INTO_IT");
  if ((qf?._rg_sybilScore || 0) > 0.4) reasons.push("BUYERS_ONE_SOURCE");
  if ((qf?._rg_freshWalletRatio || 0) > 0.6) reasons.push("BUYERS_FRESH_WALLETS");
  if ((qf?._rg_singleWalletDominance || 0) > 0.5) reasons.push("ONE_WALLET_VOLUME");
  if (token?.graduated && !((token._dexLiquidityUsd || 0) >= 5000)) reasons.push("NO_POOL_LIQUIDITY");
  if (token?._mayhem) reasons.push("MAYHEM");
  if (token?._copyOf) reasons.push("COPYCAT");
  return { pass: reasons.length === 0, reasons };
}
