// BONDLI — Trade Attribution ("Why Did I Win/Lose?")
//
// Every platform shows PnL. None explain WHICH signals were right and wrong.
//
// Post-trade analysis on every closed position:
// - What module signals contributed to the win/loss
// - What almost killed it
// - Pattern detection across trade history
// - Personal edge identification

export class TradeAttribution {
  constructor() {
    this.history = [];     // all attributed trades
    this.patterns = {};    // accumulated signal→outcome correlations
    this.MAX_HISTORY = 500;
  }

  /**
   * Generate trade attribution report for a closed position.
   *
   * @param {Object} trade
   * @param {string} trade.ca - Token address
   * @param {string} trade.name - Token name
   * @param {number} trade.entryPrice - Entry price
   * @param {number} trade.exitPrice - Exit price
   * @param {number} trade.pnlPct - PnL percentage
   * @param {number} trade.pnlSol - PnL in SOL
   * @param {number} trade.holdTimeMin - Hold time in minutes
   * @param {Object} trade.entryScores - Scores at entry time
   * @param {Object} trade.exitMetrics - Metrics at exit time
   * @returns {Object} Attribution report
   */
  attribute(trade) {
    const isWin = trade.pnlPct > 0;
    const scores = trade.entryScores || {};
    const exitMetrics = trade.exitMetrics || {};

    // Classify each module's contribution
    const modules = [];

    // Cultural timing
    const culturalScore = scores.culturalTiming || scores.memeticTemporal || 0;
    modules.push({
      name: "Cultural Timing",
      entryScore: culturalScore,
      contribution: this._calcContribution(culturalScore, 0.7, isWin),
      verdict: culturalScore > 0.7 ? "HELPED" : culturalScore > 0.4 ? "NEUTRAL" : "DIDNT_HELP",
    });

    // Community / buyer diversity
    const communityScore = scores.communityStructuralDiversity || scores.buyerDiversityScore || 0;
    modules.push({
      name: "Community Quality",
      entryScore: communityScore,
      contribution: this._calcContribution(communityScore, 0.6, isWin),
      verdict: communityScore > 0.7 ? "HELPED" : communityScore > 0.4 ? "NEUTRAL" : "HURT",
    });

    // Linguistic / name quality
    const linguisticScore = scores.memeticLinguistic || scores.linguistic || 0;
    modules.push({
      name: "Linguistic Quality",
      entryScore: linguisticScore,
      contribution: this._calcContribution(linguisticScore, 0.6, isWin),
      verdict: linguisticScore > 0.7 ? "HELPED" : "NEUTRAL",
    });

    // Influencer / KOL signal
    const kolScore = scores.influencer || scores.kolMentions || 0;
    modules.push({
      name: "Influencer Signal",
      entryScore: kolScore,
      contribution: this._calcContribution(kolScore, 0.5, isWin),
      verdict: kolScore > 0.5 ? "HELPED" : "ABSENT",
    });

    // Volume legitimacy
    const volScore = scores.volumeLegitimacy?.organicScore || scores.organicScore || 0;
    modules.push({
      name: "Volume Legitimacy",
      entryScore: volScore,
      contribution: this._calcContribution(volScore, 0.6, isWin),
      verdict: volScore > 0.7 ? "HELPED" : volScore < 0.3 ? "HURT" : "NEUTRAL",
    });

    // Meta/narrative boost
    const metaBoost = scores.metaBoost || 0;
    modules.push({
      name: "Narrative Meta",
      entryScore: metaBoost / 30, // normalize
      contribution: this._calcContribution(metaBoost / 30, 0.3, isWin),
      verdict: metaBoost > 10 ? "HELPED" : metaBoost > 0 ? "NEUTRAL" : "ABSENT",
    });

    // Visual quality
    const visualScore = scores.visual || scores.artworkScore || 0;
    modules.push({
      name: "Visual Quality",
      entryScore: visualScore,
      contribution: this._calcContribution(visualScore, 0.5, isWin),
      verdict: visualScore > 0.6 ? "HELPED" : "NEUTRAL",
    });

    // Sort by contribution
    modules.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    const helped = modules.filter(m => m.verdict === "HELPED");
    const hurt = modules.filter(m => m.verdict === "HURT");
    const wasOverride = trade.wasOverride || false;

    // Generate narrative lesson
    let lesson;
    if (isWin && helped.length > 0) {
      lesson = `This trade was a ${helped[0].name.toLowerCase()} play. ${helped.length > 1 ? helped[1].name + " also contributed." : ""}`;
    } else if (!isWin && hurt.length > 0) {
      lesson = `Loss driven by weak ${hurt[0].name.toLowerCase()}. ${hurt.length > 1 ? hurt[1].name + " was also a problem." : ""}`;
    } else if (!isWin && wasOverride) {
      lesson = "You manually overrode auto-ape rejection for this trade. The system was right.";
    } else {
      lesson = isWin ? "Multiple factors aligned for this win." : "No single factor dominated this loss. Consider market regime.";
    }

    const report = {
      ca: trade.ca,
      name: trade.name,
      pnlPct: trade.pnlPct,
      pnlSol: trade.pnlSol,
      holdTimeMin: trade.holdTimeMin,
      isWin,
      modules,
      helped: helped.map(m => m.name),
      hurt: hurt.map(m => m.name),
      lesson,
      wasOverride,
      timestamp: Date.now(),
    };

    // Record for pattern analysis
    this.history.push(report);
    if (this.history.length > this.MAX_HISTORY) this.history.shift();
    this._updatePatterns(report);

    return report;
  }

  _calcContribution(score, threshold, isWin) {
    if (isWin) return score > threshold ? score : 0;
    return score < threshold ? -(1 - score) : 0;
  }

  _updatePatterns(report) {
    for (const mod of report.modules) {
      const key = mod.name;
      if (!this.patterns[key]) {
        this.patterns[key] = { wins: 0, losses: 0, totalScore: 0, count: 0 };
      }
      const p = this.patterns[key];
      if (report.isWin) p.wins++;
      else p.losses++;
      p.totalScore += mod.entryScore;
      p.count++;
    }
  }

  /**
   * Get personal edge analysis from trade history.
   */
  getEdgeAnalysis() {
    if (this.history.length < 5) return { insufficient: true, minTrades: 5 };

    const wins = this.history.filter(t => t.isWin);
    const losses = this.history.filter(t => !t.isWin);
    const overrideResults = this.history.filter(t => t.wasOverride);
    const overrideLosses = overrideResults.filter(t => !t.isWin);

    // Find strongest signal correlation
    const moduleEdge = {};
    for (const [name, p] of Object.entries(this.patterns)) {
      const winRate = p.count > 0 ? p.wins / p.count : 0;
      const avgScore = p.count > 0 ? p.totalScore / p.count : 0;
      moduleEdge[name] = { winRate: +(winRate * 100).toFixed(1), avgScore: +avgScore.toFixed(2), count: p.count };
    }

    // Sort by win rate
    const sortedModules = Object.entries(moduleEdge).sort((a, b) => b[1].winRate - a[1].winRate);

    return {
      totalTrades: this.history.length,
      winRate: +((wins.length / this.history.length) * 100).toFixed(1),
      avgPnlPct: +(this.history.reduce((s, t) => s + t.pnlPct, 0) / this.history.length).toFixed(1),
      avgHoldMin: +(this.history.reduce((s, t) => s + (t.holdTimeMin || 0), 0) / this.history.length).toFixed(1),
      bestModule: sortedModules[0] ? { name: sortedModules[0][0], ...sortedModules[0][1] } : null,
      worstModule: sortedModules[sortedModules.length - 1] ? { name: sortedModules[sortedModules.length - 1][0], ...sortedModules[sortedModules.length - 1][1] } : null,
      overrideStats: {
        total: overrideResults.length,
        losses: overrideLosses.length,
        lossRate: overrideResults.length > 0 ? +((overrideLosses.length / overrideResults.length) * 100).toFixed(0) : 0,
      },
      moduleEdge,
    };
  }

  /**
   * Get recent trade reports for UI display.
   */
  getRecentReports(limit = 10) {
    return this.history.slice(-limit).reverse();
  }
}

export default TradeAttribution;
