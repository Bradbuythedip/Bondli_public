// ═══ RECOVERY & RE-ENTRY LOGIC ═══
// Handles watchlist promotion, missed opportunity re-entry, and post-exit re-entry.

// Check if a watchlisted token should be promoted
import { curvePctOf } from "./gates/curve.js";
export function checkWatchlistPromotion(token, dynamics, scores) {
  const apeScore = scores.apeScore || 0;
  const dyn = dynamics;
  if (!dyn || dyn.scores < 3) return { promote: false };

  // Score improved to Tier 3+ threshold
  if (apeScore >= 50 && (dyn.trend === "rising" || dyn.trend === "rocket")) {
    return {
      promote: true,
      reason: "score_improved",
      detail: `score ${apeScore} trend:${dyn.trend}`,
    };
  }

  return { promote: false };
}

// Check if a previously missed token (Gate 5 reject) is viable for re-entry
export function checkMissedReentry(token, dynamics, qf) {
  const mc = token.mcapUsd || 0;
  const dyn = dynamics;
  if (!dyn || dyn.scores < 3) return { reenter: false };

  const spark = token.spark || [];
  const recentPeak = spark.length > 3 ? Math.max(...spark.slice(-10)) : mc;
  const dippedFromPeak = recentPeak > 0 ? ((recentPeak - mc) / recentPeak) * 100 : 0;

  // Criteria: price pulled back 15%+, score still strong, community holding
  const isRecovering = dyn.trend === "rising" || dyn.trend === "rocket";
  const curvePct = curvePctOf(token);

  if (isRecovering && dippedFromPeak >= 15 && mc > 5000 && curvePct < 0.70) {
    return {
      reenter: true,
      reason: "dip_recovery",
      detail: `dip ${dippedFromPeak.toFixed(0)}% trend:${dyn.trend}`,
      sizeTier: 3, // always re-enter at speculative sizing
    };
  }

  return { reenter: false };
}

// Check if a previously exited position should be re-entered
export function checkPostExitReentry(ca, token, dynamics, soldTime, originalTier) {
  if (!token || !dynamics) return { reenter: false };
  const dyn = dynamics;

  // Must wait at least 2 minutes after sell (was 5 in spec, 2 in current code)
  if (Date.now() - soldTime < 120000) return { reenter: false };
  // Max one re-entry per token per 24 hours
  // (tracked externally via cooldown map)

  const mc = token.mcapUsd || 0;
  const spark = token.spark || [];
  const recentPeak = spark.length > 3 ? Math.max(...spark.slice(-10)) : mc;
  const dippedFromPeak = recentPeak > 0 ? ((recentPeak - mc) / recentPeak) * 100 : 0;

  const isRecovering = dyn.trend === "rising" || dyn.trend === "rocket";

  // Dip + recovery = re-entry opportunity
  if (isRecovering && dippedFromPeak >= 15 && mc > 5000 && dyn.scores >= 3) {
    return {
      reenter: true,
      reason: "dip_reentry",
      detail: `dip ${dippedFromPeak.toFixed(0)}% trend:${dyn.trend} mc:$${Math.round(mc)}`,
      // Re-enter one tier lower than original (e.g., Tier 2 → Tier 3 sizing)
      sizeTier: Math.min(3, (originalTier || 2) + 1),
      solMultiplier: 0.5, // half-size re-entry
    };
  }

  return { reenter: false };
}

// DCA into existing positions on dips with recovery signals
export function checkDipDCA(pos, token, dynamics) {
  if (!token || !dynamics) return { dca: false };
  if (pos.isMoonbag || (pos.slHit || 0) >= 1) return { dca: false };
  if ((pos.dcaBuys || 0) >= 2) return { dca: false }; // max 2 DCA buys

  const mc = token.mcapUsd || 0;
  if (pos.entryMcap <= 0 || mc <= 0) return { dca: false };

  const fromPeak = pos.peakMcap > 0 ? ((pos.peakMcap - mc) / pos.peakMcap) * 100 : 0;
  const dyn = dynamics;
  const isRecovering = dyn.scores >= 3 && (dyn.trend === "rising" || dyn.trend === "rocket");

  // Dip criteria: MC dropped 20%+ from peak AND score is now recovering
  if (fromPeak >= 20 && isRecovering) {
    return {
      dca: true,
      reason: "dip_dca",
      detail: `dip ${fromPeak.toFixed(0)}% trend:${dyn.trend}`,
      solMultiplier: 0.5, // half-size DCA
    };
  }

  return { dca: false };
}
