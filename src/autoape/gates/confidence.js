// ═══ GATE 3: CONFIDENCE CLASSIFICATION — Tier Assignment (<5ms) ═══
// Classify HOW confident we are. Determines position size, execution, fleet role.
// Four tiers: GOD_CANDLE (1), STRONG (2), SPECULATIVE (3), WATCHLIST (4).

// opts.tier3Floor: the score a SPECULATIVE entry needs (aggression profile); 50 as designed.
export function classifyConfidence(token, qf, scores, dynamics, opts = {}) {
  const { tier3Floor = 50 } = opts;
  const apeScore = scores.apeScore || 0;
  const dyn = dynamics;
  const mc = token.mcapUsd || 0;
  const buys = token.buys || 0;
  const ub = token.uniqueBuyers?.size || 0;
  const ageMin = (Date.now() - (token.createdAt || Date.now())) / 60000;
  const sells = token.sells || 0;

  // Score velocity and acceleration
  const vel = dyn?.velocity || 0;
  const acc = dyn?.acceleration || 0;
  const trend = dyn?.trend || "new";

  // Module-level signals
  const memeticQuick = token._memeticQuick || 0;
  const devTier = token._devTier || "";
  const whaleBullish = qf?._whaleBullish || 0;
  const walletAgeScore = qf?.rg_walletAgeScore || 0;
  const chartHealth = qf?.ch_healthScore || 0;
  const devCred = qf?._devCredScore || 0;
  const dexBoosted = !!token._dexBoosted;
  const rugFlags = token._rugFlags?.length || 0;
  const survivorMatch = token._survivorMatch || 0;
  const bullishSignals = token._bullishSignals?.length || 0;

  // Buy velocity (buys per minute)
  const buyVelocity = buys / Math.max(ageMin, 0.5);

  // Reasons for tier classification (for logging)
  const reasons = [];

  // ═══ TIER 1: GOD CANDLE — top ~1% ═══
  if (apeScore >= 75
    && vel > 0 && acc >= 0
    && memeticQuick >= 0.6
    && trend !== "fading" && trend !== "declining" && trend !== "crashing"
    && rugFlags === 0
    && (
      // Structural breakout: whale + aged wallets + high score
      (whaleBullish > 0.3 && walletAgeScore > 0.6 && ub >= 15)
      // Cultural catalyst: boosted + dev credible + high score
      || (dexBoosted && devCred >= 0.7 && apeScore >= 80)
      // Survivor match: looks exactly like past winners
      || (survivorMatch >= 70 && bullishSignals >= 3)
      // Rocket trend with overwhelming signals
      || (trend === "rocket" && apeScore >= 80 && buyVelocity >= 8)
    )
  ) {
    reasons.push("GOD_CANDLE");
    if (whaleBullish > 0.3) reasons.push("whale_bullish");
    if (trend === "rocket") reasons.push("rocket_trend");
    if (survivorMatch >= 70) reasons.push("survivor_match");
    return { tier: 1, label: "GOD_CANDLE", reasons };
  }

  // ═══ TIER 2: STRONG SIGNAL — top ~5% ═══
  if (apeScore >= 62
    && vel >= 0
    && trend !== "crashing" && trend !== "declining"
    && rugFlags <= 1
    && (
      // Cultural timing match
      (dexBoosted && apeScore >= 65)
      // Whale/aged wallet conviction
      || (whaleBullish > 0.2 && walletAgeScore > 0.5)
      // Strong momentum
      || (trend === "rocket" || (trend === "rising" && apeScore >= 65))
      // High survivor match
      || survivorMatch >= 50
      // Dev credibility + chart health
      || (devCred >= 0.6 && chartHealth > 0.5 && ub >= 8)
      // Pure score strength
      || apeScore >= 70
    )
  ) {
    reasons.push("STRONG");
    if (trend === "rocket" || trend === "rising") reasons.push(trend);
    if (whaleBullish > 0.2) reasons.push("whale");
    if (dexBoosted) reasons.push("dexBoosted");
    return { tier: 2, label: "STRONG", reasons };
  }

  // ═══ TIER 3: SPECULATIVE — top ~15% ═══
  if (apeScore >= tier3Floor
    && vel >= -0.05
    && trend !== "crashing"
    && (
      // Has at least one compelling signal
      dexBoosted
      || memeticQuick >= 0.5
      || whaleBullish > 0.1
      || (trend === "rising" || trend === "rocket")
      || survivorMatch >= 30
      || devCred >= 0.5
      || (devTier === "whale_dev" || devTier === "funded_dev")
      || chartHealth > 0.5
      || bullishSignals >= 1
    )
  ) {
    reasons.push("SPECULATIVE");
    return { tier: 3, label: "SPECULATIVE", reasons };
  }

  // ═══ TIER 4: WATCHLIST — interesting but not actionable ═══
  if (apeScore >= 40) {
    reasons.push("WATCHLIST");
    return { tier: 4, label: "WATCHLIST", reasons };
  }

  // Below threshold
  return { tier: 0, label: "REJECT", reasons: ["BELOW_THRESHOLD"] };
}
