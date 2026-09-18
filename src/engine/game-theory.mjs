// BONDLI v3.0 — Bayesian Game Theory Engine
// Models opponent behavior, adjusts strategy based on observed patterns

export class GameTheory {
  constructor() {
    // Opponent archetypes with prior probabilities
    this.archetypes = {
      sniper:     { prior: 0.25, aggression: 0.9, holdTime: 30,   sellThreshold: 1.5 },
      accumulator:{ prior: 0.20, aggression: 0.3, holdTime: 300,  sellThreshold: 3.0 },
      whale:      { prior: 0.10, aggression: 0.7, holdTime: 120,  sellThreshold: 2.0 },
      retail:     { prior: 0.35, aggression: 0.4, holdTime: 600,  sellThreshold: 2.5 },
      bot:        { prior: 0.10, aggression: 0.95, holdTime: 10,  sellThreshold: 1.2 },
    };
    this.observations = [];
    this.posteriors = {};
  }

  // Observe a trade and update beliefs
  observe(trade) {
    this.observations.push({
      ...trade,
      timestamp: Date.now(),
    });
    this._updatePosteriors(trade);
  }

  _updatePosteriors(trade) {
    const { wallet, side, solAmount, elapsed } = trade;
    if (!this.posteriors[wallet]) {
      this.posteriors[wallet] = { ...this.archetypes };
    }

    const p = this.posteriors[wallet];
    let total = 0;

    for (const [type, arch] of Object.entries(p)) {
      // Likelihood based on trade characteristics
      let likelihood = 1.0;

      // Size signal
      if (solAmount > 5)       likelihood *= type === "whale" ? 3.0 : 0.5;
      else if (solAmount < 0.1) likelihood *= type === "sniper" || type === "bot" ? 2.0 : 0.8;

      // Speed signal
      if (elapsed < 5000)      likelihood *= type === "bot" || type === "sniper" ? 3.0 : 0.3;
      else if (elapsed > 60000) likelihood *= type === "retail" || type === "accumulator" ? 2.0 : 0.5;

      // Side signal
      if (side === "sell" && elapsed < 30000) likelihood *= type === "sniper" || type === "bot" ? 2.5 : 0.6;

      arch.posterior = (arch.posterior || arch.prior) * likelihood;
      total += arch.posterior;
    }

    // Normalize
    for (const arch of Object.values(p)) {
      arch.posterior = arch.posterior / total;
    }
  }

  // Get dominant archetype for a wallet
  classify(wallet) {
    const p = this.posteriors[wallet];
    if (!p) return { type: "unknown", confidence: 0 };
    let best = null, bestProb = 0;
    for (const [type, arch] of Object.entries(p)) {
      if ((arch.posterior || arch.prior) > bestProb) {
        bestProb = arch.posterior || arch.prior;
        best = type;
      }
    }
    return { type: best, confidence: bestProb };
  }

  // Recommend action based on opponent distribution
  recommend(mint) {
    const mintTrades = this.observations.filter(o => o.mint === mint);
    if (mintTrades.length < 3) return { action: "wait", reason: "insufficient data" };

    const recentBuys = mintTrades.filter(t => t.side === "buy" && Date.now() - t.timestamp < 60000);
    const recentSells = mintTrades.filter(t => t.side === "sell" && Date.now() - t.timestamp < 60000);

    const buyPressure = recentBuys.reduce((s, t) => s + t.solAmount, 0);
    const sellPressure = recentSells.reduce((s, t) => s + t.solAmount, 0);
    const ratio = buyPressure / Math.max(sellPressure, 0.001);

    if (ratio > 3)   return { action: "buy",  reason: "strong buy pressure", ratio };
    if (ratio > 1.5) return { action: "hold", reason: "moderate buy pressure", ratio };
    if (ratio < 0.5) return { action: "sell", reason: "heavy selling detected", ratio };
    return { action: "hold", reason: "balanced", ratio };
  }

  // Get summary stats
  summary() {
    return {
      totalObservations: this.observations.length,
      trackedWallets: Object.keys(this.posteriors).length,
      recentActivity: this.observations.filter(o => Date.now() - o.timestamp < 300000).length,
    };
  }
}

export default GameTheory;
