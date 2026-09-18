// ═══ GATE 2: MINIMUM VIABILITY — Score & Feature Floors (<10ms) ═══
// Tokens passing Gate 1 aren't dangerous, but might be noise.
// Every floor must be met (AND conditions).

// opts: the aggression profile (src/velocity/venues/pumpfun/edge.mjs AGGRESSION); defaults are the designed floors.
export function checkViability(token, qf, scores, dynamics, opts = {}) {
  const { scoreFloor = 45, sybilMax = 0.40, freshWalletMax = 0.80, doaBuyers = 5, minScores = 2, mcapFloor = 4000 } = opts;
  const checks = [];
  const buys = token.buys || 0;
  const ub = token.uniqueBuyers?.size || 0;
  const sells = token.sells || 0;
  const mc = token.mcapUsd || 0;
  const ageMin = (Date.now() - (token.createdAt || Date.now())) / 60000;
  const vol = token.volumeSol || 0;

  // === COMPOSITE SCORE FLOOR ===
  // The token must have passed base scoring. Score is 0-99 (our system).
  // Map: 55/100 composite ≈ score 45 in our 0-99 system
  if ((scores.apeScore || 0) < scoreFloor) checks.push("SCORE_BELOW_FLOOR");

  // === ON-CHAIN ACTIVITY MINIMUM ===
  // Must have at least 5 unique buyers (was 10 in spec, relaxed for pump.fun reality)
  if (ub < doaBuyers && ageMin >= 2) checks.push("DEAD_ON_ARRIVAL");

  // Buy/sell ratio must show demand
  if (buys > 5 && sells > buys * 1.2) checks.push("WEAK_DEMAND");

  // === LIQUIDITY FLOOR ===
  // Bonding curve must have meaningful SOL
  // Below this market cap one order moves the curve too much to get out of; the dial lowers it.
  if (mc < mcapFloor) checks.push("MCAP_BELOW_FLOOR");

  // === SYBIL CHECK ===
  if (qf?._rg_sybilScore > sybilMax) checks.push("HIGH_SYBIL_RISK");

  // === VOLUME LEGITIMACY FLOOR ===
  // Token must have some organic volume activity — fee accrual rate matters
  const volLeg = token._volumeLegitimacy;
  if (volLeg && volLeg.legitimacy === "LIKELY_BOTTED" && ageMin >= 3) {
    checks.push("BOTTED_VOLUME");
  }
  if (volLeg && volLeg.feeRate?.feeRating === "DEAD" && ageMin >= 5 && vol > 0) {
    checks.push("DEAD_FEE_RATE"); // volume exists but fee accrual per second is too low
  }

  // === DYNAMICS GATE ===
  // Must have at least 1 score observation
  const dyn = dynamics;
  const isEarlyMover = ageMin < 2 && mc >= 4000 && mc <= 30000 && ub >= 2;
  if (minScores > 0 && (!dyn || (dyn.scores < minScores && !isEarlyMover))) checks.push("INSUFFICIENT_DATA");

  // Actively crashing = dead
  if (dyn?.trend === "crashing") checks.push("CRASHING_SCORE");

  // === STRUCTURAL DIVERSITY ===
  // Fresh wallets dominating = sybil/dev-buy setup
  if (qf?._rg_freshWalletRatio > freshWalletMax && !isEarlyMover) checks.push("SINGLE_CLUSTER_BUYERS");

  return {
    pass: checks.length === 0,
    checks,
    fatal: false,
  };
}
