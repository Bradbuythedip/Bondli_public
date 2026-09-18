// ═══ GATE 5: EXECUTION WINDOW — Is There Still Time? (<5ms) ═══
// By the time we've scored and decided, the opportunity may have passed.

// opts: the aggression profile (src/velocity/venues/pumpfun/edge.mjs AGGRESSION); defaults are the designed window.
import { curvePctOf } from "./curve.js";
export function checkExecutionWindow(token, tier, scoreTimestamp, opts = {}) {
  const { curveMax = 0.60, curveMaxSpec = 0.40, spikeSlope = 0.15, blockDecel = true, requireStable = true } = opts;
  const checks = [];
  const mc = token.mcapUsd || 0;
  const spark = token.spark || [];

  // === PRICE MOVEMENT SINCE SCORING ===
  // Check sparkline for recent price action
  if (spark.length >= 4) {
    const recent = spark.slice(-4);
    const peak = Math.max(...spark);
    const cur = spark[spark.length - 1];
    const fromPeak = peak > 0 ? (peak - cur) / peak : 0;
    const recentSlope = recent.length >= 2 ? (recent[recent.length - 1] - recent[0]) / Math.max(1, recent[0]) : 0;

    // If price spiking hard (>15% recent slope at peak), we're buying the top
    if (recentSlope > spikeSlope && cur >= peak * 0.95) {
      // Tier 1 can override spike if score > 70
      if (tier > 1 || (token._apeScore || 0) < 70) {
        checks.push("PRICE_SPIKING");
      }
    }

    // If price collapsed >20% from peak recently, opportunity changed
    if (fromPeak > 0.20 && recentSlope < -0.05) {
      checks.push("PRICE_COLLAPSED");
    }
  }

  // === BONDING CURVE POSITION ===
  const curvePct = curvePctOf(token);
  // Tier 1-2: Enter up to 60% of curve
  if (tier <= 2 && curvePct > curveMax) checks.push("CURVE_TOO_ADVANCED");
  // Tier 3: Enter up to 40% only
  if (tier === 3 && curvePct > curveMaxSpec) checks.push("CURVE_TOO_ADVANCED_SPEC");
  // >90% = graduation play — only Tier 1
  if (curvePct > 0.90 && tier > 1) checks.push("GRADUATION_ONLY_TIER1");

  // === SELL PRESSURE CHECK ===
  // Recent trades showing sell dominance
  if (token.trades && token.trades.length >= 6) {
    const trades = token.trades;
    const mid = Math.floor(trades.length / 2);
    const firstBuys = trades.slice(0, mid).filter(tr => tr.side === "buy").length;
    const secondBuys = trades.slice(mid).filter(tr => tr.side === "buy").length;
    const firstSpan = Math.max(1, ((trades[mid]?.time || Date.now()) - (trades[0]?.time || Date.now())) / 60000);
    const secondSpan = Math.max(0.3, (Date.now() - (trades[mid]?.time || Date.now())) / 60000);

    if (secondBuys / secondSpan < (firstBuys / firstSpan) * 0.5) {
      // Buy rate decelerating — only block for lower tiers
      if (blockDecel && (tier >= 3 || (token._apeScore || 0) < 65)) {
        checks.push("BUY_VELOCITY_DECELERATING");
      }
    }
  }

  // === SCORE FRESHNESS ===
  if (scoreTimestamp && Date.now() - scoreTimestamp > 15000) {
    checks.push("SCORE_STALE");
  }

  // === SCORE STABILITY ===
  // Require score above threshold for 2+ cycles (except early movers)
  const ageMin = (Date.now() - (token.createdAt || Date.now())) / 60000;
  const isEarlyMover = ageMin < 2 && mc <= 30000;
  if (requireStable && token._stabilityCount != null && token._stabilityCount < 2 && !isEarlyMover) {
    checks.push("SCORE_NOT_STABLE");
  }

  return {
    pass: checks.length === 0,
    checks,
    curvePct,
    fatal: false,
  };
}
