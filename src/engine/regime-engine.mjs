// BONDLI — Regime Engine (5 Market States)
//
// Every platform uses static settings regardless of market conditions.
// Bull and bear require fundamentally different strategies.
//
// REGIMES:
//   EUPHORIA:  BTC pumping, grad rates >3%, volume flooding → aggressive
//   RISK_ON:   BTC stable/up, grad rates 1-3% → standard
//   GRINDING:  BTC flat, grad rates 0.5-1% → selective
//   PVP:       BTC down, grad rates <0.5% → tier 1 only, minimal size
//   DEAD:      BTC crashing, grad rates ~0 → stop trading, preserve capital
//
// Every parameter auto-adjusts per regime.

const REGIMES = {
  EUPHORIA: {
    id: "EUPHORIA",
    label: "Euphoria",
    color: "#00ff88",
    tempColor: "warm",
    // Trading parameters
    entryThreshold: 35,       // lower = more aggressive entries
    positionMultiplier: 1.5,  // 1.5x normal size
    stopLossPct: -35,         // wider stops — let winners breathe
    maxHoldMinutes: 30,       // hold longer in euphoria
    maxConcurrentPositions: 8,
    fleetEnabled: true,
    fleetAggression: "full",
    minApeScore: 2.5,        // lower floor
    // Descriptors
    description: "Market is euphoric. Graduation rates high, volume flooding in.",
    strategy: "Aggressive entries, wide stops, let winners run, full fleet deployment.",
  },
  RISK_ON: {
    id: "RISK_ON",
    label: "Risk On",
    color: "#44aaff",
    tempColor: "neutral",
    entryThreshold: 45,
    positionMultiplier: 1.0,
    stopLossPct: -25,
    maxHoldMinutes: 20,
    maxConcurrentPositions: 5,
    fleetEnabled: true,
    fleetAggression: "standard",
    minApeScore: 3.0,
    description: "Healthy market. Normal flow with good opportunities.",
    strategy: "Standard entries, normal stops, balanced approach.",
  },
  GRINDING: {
    id: "GRINDING",
    label: "Grinding",
    color: "#ffaa00",
    tempColor: "cool",
    entryThreshold: 55,
    positionMultiplier: 0.7,
    stopLossPct: -18,
    maxHoldMinutes: 12,
    maxConcurrentPositions: 3,
    fleetEnabled: true,
    fleetAggression: "scout",
    minApeScore: 4.0,
    description: "Slow market. Selective opportunities, higher bar for entries.",
    strategy: "Higher score thresholds, tighter stops, scout-only fleet.",
  },
  PVP: {
    id: "PVP",
    label: "PvP",
    color: "#ff6644",
    tempColor: "cold",
    entryThreshold: 65,
    positionMultiplier: 0.4,
    stopLossPct: -12,
    maxHoldMinutes: 8,
    maxConcurrentPositions: 2,
    fleetEnabled: false,
    fleetAggression: "none",
    minApeScore: 5.0,
    description: "Knife fight. Only the strongest setups. Minimal size.",
    strategy: "Tier 1 only, minimal size, fastest exits, no fleet.",
  },
  DEAD: {
    id: "DEAD",
    label: "Dead",
    color: "#666666",
    tempColor: "frozen",
    entryThreshold: 999,     // effectively no entries
    positionMultiplier: 0,
    stopLossPct: -8,
    maxHoldMinutes: 5,
    maxConcurrentPositions: 0,
    fleetEnabled: false,
    fleetAggression: "none",
    minApeScore: 99,
    description: "Market is dead. No volume, no opportunities. Preserve capital.",
    strategy: "Stop trading. Monitor only. Preserve capital.",
  },
};

export class RegimeEngine {
  constructor() {
    this.currentRegime = REGIMES.RISK_ON; // default
    this.history = []; // [{ time, regime, signals }]
    this.signals = {
      btcChange1h: 0,
      btcChange24h: 0,
      gradRate1h: 0,         // graduation rate (%)
      totalVolume1h: 0,      // total SOL volume across all tokens in 1h
      newLaunches1h: 0,      // new token launches in 1h
      avgMcapGraduated: 0,   // avg mcap of graduated tokens
      solPrice: 0,
    };
    this._lastUpdate = 0;
    this.UPDATE_INTERVAL = 60_000; // re-evaluate every 60s
  }

  /**
   * Update market signals. Called by market poller / external data feeds.
   */
  updateSignals(newSignals) {
    Object.assign(this.signals, newSignals);
    this._evaluate();
  }

  /**
   * Core regime classification logic.
   * Uses multiple signals to determine current market state.
   */
  _evaluate() {
    const now = Date.now();
    if (now - this._lastUpdate < this.UPDATE_INTERVAL) return;
    this._lastUpdate = now;

    const s = this.signals;
    let score = 0; // positive = bullish, negative = bearish

    // BTC price action (strongest macro signal)
    if (s.btcChange24h > 5) score += 3;
    else if (s.btcChange24h > 2) score += 2;
    else if (s.btcChange24h > 0) score += 1;
    else if (s.btcChange24h > -2) score -= 1;
    else if (s.btcChange24h > -5) score -= 2;
    else score -= 4; // BTC crashing hard

    if (s.btcChange1h > 2) score += 2;
    else if (s.btcChange1h > 0) score += 1;
    else if (s.btcChange1h < -2) score -= 2;

    // Graduation rate (direct memecoin market health)
    if (s.gradRate1h > 3) score += 3;       // euphoric — tokens graduating fast
    else if (s.gradRate1h > 1.5) score += 2;
    else if (s.gradRate1h > 0.5) score += 1;
    else if (s.gradRate1h > 0.1) score -= 1;
    else score -= 3;                          // nothing graduating

    // Volume signals
    if (s.totalVolume1h > 10000) score += 2;   // massive volume
    else if (s.totalVolume1h > 3000) score += 1;
    else if (s.totalVolume1h < 500) score -= 2; // dead volume

    // Launch rate (market interest)
    if (s.newLaunches1h > 50) score += 1;
    else if (s.newLaunches1h < 10) score -= 1;

    // Classify regime
    let newRegime;
    if (score >= 7) newRegime = REGIMES.EUPHORIA;
    else if (score >= 3) newRegime = REGIMES.RISK_ON;
    else if (score >= 0) newRegime = REGIMES.GRINDING;
    else if (score >= -4) newRegime = REGIMES.PVP;
    else newRegime = REGIMES.DEAD;

    // Record transition
    if (newRegime.id !== this.currentRegime.id) {
      this.history.push({
        time: now,
        from: this.currentRegime.id,
        to: newRegime.id,
        score,
        signals: { ...s },
      });
      // Keep last 100 transitions
      if (this.history.length > 100) this.history.shift();

      console.log(`[REGIME] ${this.currentRegime.id} → ${newRegime.id} (score: ${score})`);
    }

    this.currentRegime = newRegime;
  }

  /**
   * Get current regime with all parameters.
   */
  getRegime() {
    return {
      ...this.currentRegime,
      signals: { ...this.signals },
      lastUpdate: this._lastUpdate,
    };
  }

  /**
   * Get regime-adjusted parameters for a specific operation.
   * Callers use this to modify their behavior per regime.
   */
  getParams() {
    const r = this.currentRegime;
    return {
      regime: r.id,
      entryThreshold: r.entryThreshold,
      positionMultiplier: r.positionMultiplier,
      stopLossPct: r.stopLossPct,
      maxHoldMinutes: r.maxHoldMinutes,
      maxConcurrentPositions: r.maxConcurrentPositions,
      fleetEnabled: r.fleetEnabled,
      fleetAggression: r.fleetAggression,
      minApeScore: r.minApeScore,
      shouldTrade: r.id !== "DEAD",
    };
  }

  /**
   * Adjust a position size based on current regime.
   */
  adjustSize(baseSol) {
    return +(baseSol * this.currentRegime.positionMultiplier).toFixed(4);
  }

  /**
   * Check if we should be trading at all.
   */
  shouldTrade() {
    return this.currentRegime.id !== "DEAD";
  }

  /**
   * Get regime history for UI display.
   */
  getHistory(limit = 20) {
    return this.history.slice(-limit);
  }
}

export { REGIMES };
export default RegimeEngine;
