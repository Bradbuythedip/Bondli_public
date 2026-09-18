// ═══ GATE 4: PORTFOLIO CONSTRAINTS — Risk Management (<5ms) ═══
// Even a Tier 1 god candle gets rejected if portfolio conditions aren't met.

export function checkPortfolioConstraints(tier, positionSize, portfolio, token) {
  const checks = [];

  // === POSITION LIMITS ===
  const maxPositions = portfolio.maxPositions || 8;
  if (portfolio.activePositionCount >= maxPositions) checks.push("MAX_POSITIONS_REACHED");

  // Max positions opened in last 10 minutes (anti-FOMO spray)
  if (portfolio.positionsLast10m >= 3) {
    // Exception: Tier 1 bypasses rate limit (but still respects max positions)
    if (tier > 1) checks.push("ENTRY_RATE_LIMIT");
  }

  // === BANKROLL PROTECTION ===
  // Minimum reserve: always keep enough SOL for 50 transactions in fees
  const feeReserve = 50 * 0.001; // ~0.05 SOL
  if ((portfolio.availableSOL || 0) - positionSize < feeReserve) checks.push("INSUFFICIENT_RESERVE");

  // Max single position: never >5% of total bankroll
  if (portfolio.totalBankroll > 0 && positionSize > portfolio.totalBankroll * 0.05)
    checks.push("POSITION_TOO_LARGE");

  // Daily drawdown circuit breaker: if down >15% today, stop ALL entries
  if (portfolio.dailyPnlPct != null && portfolio.dailyPnlPct < -0.15)
    checks.push("DAILY_DRAWDOWN_BREAKER");

  // Drawdown governor: if drawdown multiplier is 0, halt trading
  if ((portfolio.drawdownMult || 1) <= 0) checks.push("DRAWDOWN_GOVERNOR_HALT");

  // Consecutive loss cooldown: 5 losses in a row → pause 1 hour
  if ((portfolio.consecutiveLosses || 0) >= 5
    && portfolio.lastLossTime
    && Date.now() - portfolio.lastLossTime < 3600000)
    checks.push("LOSS_COOLDOWN");

  // === CORRELATION / CONCENTRATION ===
  // Don't hold more than 2 tokens with the same dev wallet
  if (token.devWallet && portfolio.activePositions) {
    const devCount = portfolio.activePositions.filter(
      p => p.devWallet && p.devWallet === token.devWallet
    ).length;
    if (devCount >= 2) checks.push("SAME_DEV_CONCENTRATION");
  }

  // Don't hold more than 3 tokens with same archetype
  if (token._archetype && portfolio.activePositions) {
    const archCount = portfolio.activePositions.filter(
      p => p.archetype === token._archetype
    ).length;
    if (archCount >= 3) checks.push("ARCHETYPE_CONCENTRATION");
  }

  // === TEMPORAL CONSTRAINTS ===
  // Dead market filter: if graduation rate very low, only allow Tier 1
  if (portfolio.gradRate24h != null && portfolio.gradRate24h < 0.005 && tier > 1)
    checks.push("DEAD_MARKET_FILTER");

  return {
    pass: checks.length === 0,
    checks,
    fatal: false,
  };
}
