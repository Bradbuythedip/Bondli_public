// BONDLI — Honest Performance Benchmarking
//
// No platform tells you how you actually compare to the base rate.
// Radical transparency about actual edge.
//
// YOUR STATS vs PLATFORM BASE RATE:
//   Win rate, avg return, hold time, Sharpe
//   Your best/worst performing signal
//   Override loss rate
//   Percentile ranking

export class Benchmarker {
  constructor() {
    // Platform-wide aggregates (updated from server periodically)
    this.platformStats = {
      medianWinRate: 31,          // %
      medianAvgReturn: -12,       // %
      medianHoldMin: 1.8,
      medianSharpe: -0.3,
      totalTraders: 0,
      totalTrades: 0,
      updatedAt: 0,
    };

    // User's personal stats
    this.userTrades = [];
    this.userOverrides = { total: 0, losses: 0 };
    this.moduleCorrelations = {}; // module → { winCount, lossCount, totalScore }
  }

  /**
   * Update platform-wide stats (called from server sync).
   */
  updatePlatformStats(stats) {
    Object.assign(this.platformStats, stats, { updatedAt: Date.now() });
  }

  /**
   * Record a user trade for benchmarking.
   */
  recordTrade(trade) {
    this.userTrades.push({
      pnlPct: trade.pnlPct || 0,
      pnlSol: trade.pnlSol || 0,
      holdMin: trade.holdTimeMin || 0,
      isWin: (trade.pnlPct || 0) > 0,
      wasOverride: trade.wasOverride || false,
      scores: trade.entryScores || {},
      timestamp: Date.now(),
    });

    if (trade.wasOverride) {
      this.userOverrides.total++;
      if ((trade.pnlPct || 0) <= 0) this.userOverrides.losses++;
    }

    // Track module correlations
    if (trade.entryScores) {
      for (const [key, val] of Object.entries(trade.entryScores)) {
        if (typeof val !== "number") continue;
        if (!this.moduleCorrelations[key]) {
          this.moduleCorrelations[key] = { winCount: 0, lossCount: 0, totalScore: 0, count: 0 };
        }
        const mc = this.moduleCorrelations[key];
        mc.count++;
        mc.totalScore += val;
        if ((trade.pnlPct || 0) > 0) mc.winCount++;
        else mc.lossCount++;
      }
    }

    // Keep last 1000
    if (this.userTrades.length > 1000) this.userTrades.shift();
  }

  /**
   * Generate full benchmark report.
   */
  getBenchmark() {
    const trades = this.userTrades;
    if (trades.length < 3) {
      return { insufficient: true, tradesNeeded: 3 - trades.length };
    }

    const wins = trades.filter(t => t.isWin);
    const winRate = (wins.length / trades.length) * 100;
    const avgReturn = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
    const avgHold = trades.reduce((s, t) => s + t.holdMin, 0) / trades.length;
    const sharpe = this._calcSharpe(trades);

    const ps = this.platformStats;

    // Calculate percentiles (approximate)
    const winRatePercentile = this._estimatePercentile(winRate, ps.medianWinRate, 15);
    const returnPercentile = this._estimatePercentile(avgReturn, ps.medianAvgReturn, 30);
    const sharpePercentile = this._estimatePercentile(sharpe, ps.medianSharpe, 1);

    // Best performing module
    const moduleRanking = Object.entries(this.moduleCorrelations)
      .filter(([, v]) => v.count >= 5)
      .map(([key, v]) => ({
        module: key,
        winRate: +((v.winCount / v.count) * 100).toFixed(1),
        avgScore: +(v.totalScore / v.count).toFixed(2),
        count: v.count,
      }))
      .sort((a, b) => b.winRate - a.winRate);

    // Override analysis
    const overrideLossRate = this.userOverrides.total > 0
      ? +((this.userOverrides.losses / this.userOverrides.total) * 100).toFixed(0)
      : 0;

    // Projected win rate without overrides
    const nonOverrideTrades = trades.filter(t => !t.wasOverride);
    const projectedWinRate = nonOverrideTrades.length > 0
      ? +((nonOverrideTrades.filter(t => t.isWin).length / nonOverrideTrades.length) * 100).toFixed(1)
      : winRate;

    return {
      user: {
        winRate: +winRate.toFixed(1),
        avgReturn: +avgReturn.toFixed(1),
        avgHoldMin: +avgHold.toFixed(1),
        sharpe: +sharpe.toFixed(2),
        totalTrades: trades.length,
      },
      platform: {
        medianWinRate: ps.medianWinRate,
        medianAvgReturn: ps.medianAvgReturn,
        medianHoldMin: ps.medianHoldMin,
        medianSharpe: ps.medianSharpe,
      },
      percentiles: {
        winRate: winRatePercentile,
        avgReturn: returnPercentile,
        sharpe: sharpePercentile,
      },
      bestModule: moduleRanking[0] || null,
      worstModule: moduleRanking[moduleRanking.length - 1] || null,
      overrides: {
        total: this.userOverrides.total,
        losses: this.userOverrides.losses,
        lossRate: overrideLossRate,
        projectedWinRateWithout: projectedWinRate,
        advice: overrideLossRate > 60
          ? `You override auto-ape rejections and lose ${overrideLossRate}% of the time. Stop overriding — your win rate would be ~${projectedWinRate}%.`
          : null,
      },
      summary: this._generateSummary(winRate, winRatePercentile, moduleRanking, overrideLossRate, projectedWinRate),
    };
  }

  _calcSharpe(trades) {
    if (trades.length < 3) return 0;
    const returns = trades.map(t => t.pnlPct);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    return std > 0 ? mean / std : 0;
  }

  _estimatePercentile(userValue, median, spread) {
    // Rough percentile estimate using normal distribution approximation
    const zScore = (userValue - median) / Math.max(spread, 0.01);
    // Approximate CDF
    const percentile = 50 + 50 * Math.tanh(zScore * 0.7);
    return Math.round(Math.min(99, Math.max(1, percentile)));
  }

  _generateSummary(winRate, percentile, modules, overrideLossRate, projectedWr) {
    const parts = [];
    parts.push(`You're in the top ${100 - percentile}% of Bondli traders.`);

    if (modules.length > 0) {
      parts.push(`Your edge is ${modules[0].module} (${modules[0].winRate}% win rate when signal is strong).`);
    }

    if (overrideLossRate > 60) {
      parts.push(`Your leak is manual overrides. If you stopped overriding, your win rate would be ~${projectedWr}%.`);
    }

    return parts.join(" ");
  }

  /**
   * Get leaderboard entry for this user.
   */
  getLeaderboardEntry(userId, displayName) {
    const trades = this.userTrades;
    if (trades.length < 10) return null;

    const wins = trades.filter(t => t.isWin);
    return {
      userId,
      displayName: displayName || `Trader_${userId.slice(0, 6)}`,
      winRate: +((wins.length / trades.length) * 100).toFixed(1),
      totalTrades: trades.length,
      sharpe: +this._calcSharpe(trades).toFixed(2),
      totalPnlSol: +trades.reduce((s, t) => s + (t.pnlSol || 0), 0).toFixed(3),
      bestStreak: this._longestStreak(trades, true),
    };
  }

  _longestStreak(trades, winsOnly) {
    let max = 0, current = 0;
    for (const t of trades) {
      if (winsOnly ? t.isWin : !t.isWin) { current++; max = Math.max(max, current); }
      else current = 0;
    }
    return max;
  }
}

export default Benchmarker;
