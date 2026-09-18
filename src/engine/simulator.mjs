// BONDLI — Simulation Mode (Paper Trading)
//
// Every new user's first trade is live money into the most adversarial market in crypto.
// No paper trading exists on any platform. Until now.
//
// Same WS feed, same scoring pipeline, same auto-ape gates — fake execution.
// Virtual P&L tracked in memory (or Redis for persistence).
//
// Transition: "You've simulated 50 trades with a 52% win rate. Ready to go live?"

export class Simulator {
  constructor() {
    this.enabled = false;
    this.positions = new Map();  // ca → { entryPrice, entryMcap, size, entryTime, scores }
    this.closedTrades = [];      // history of closed simulated trades
    this.balance = 1.0;          // virtual SOL balance
    this.initialBalance = 1.0;
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      bestTrade: 0,
      worstTrade: 0,
      avgHoldMin: 0,
    };
  }

  /**
   * Enable simulation mode with initial virtual balance.
   */
  enable(initialSol = 1.0) {
    this.enabled = true;
    this.balance = initialSol;
    this.initialBalance = initialSol;
    this.positions.clear();
    this.closedTrades = [];
    this.stats = { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, bestTrade: 0, worstTrade: 0, avgHoldMin: 0 };
    console.log(`[SIM] Simulation mode enabled with ${initialSol} virtual SOL`);
    return { enabled: true, balance: initialSol };
  }

  /**
   * Disable simulation mode.
   */
  disable() {
    this.enabled = false;
    return this.getReport();
  }

  /**
   * Simulate a buy (virtual entry).
   */
  buy(token, solAmount, scores = {}) {
    if (!this.enabled) return null;
    if (solAmount > this.balance) {
      return { error: "INSUFFICIENT_BALANCE", balance: this.balance, requested: solAmount };
    }

    const ca = token.ca || token.mint;
    if (this.positions.has(ca)) {
      return { error: "ALREADY_IN_POSITION", ca };
    }

    this.balance -= solAmount;
    this.positions.set(ca, {
      ca,
      name: token.name || token.ticker || ca.slice(0, 8),
      entryPrice: token.priceUsd || 0,
      entryMcap: token.mcapUsd || 0,
      size: solAmount,
      entryTime: Date.now(),
      scores: { ...scores },
      peakMcap: token.mcapUsd || 0,
    });

    return {
      action: "SIM_BUY",
      ca,
      name: token.name,
      size: solAmount,
      entryMcap: token.mcapUsd,
      balance: +this.balance.toFixed(4),
    };
  }

  /**
   * Simulate a sell (virtual exit).
   */
  sell(ca, token, sellPct = 100) {
    if (!this.enabled) return null;

    const pos = this.positions.get(ca);
    if (!pos) return { error: "NO_POSITION", ca };

    const currentMcap = token?.mcapUsd || pos.entryMcap;
    const changePct = pos.entryMcap > 0 ? ((currentMcap - pos.entryMcap) / pos.entryMcap) * 100 : 0;
    const pnlSol = pos.size * (changePct / 100);
    const holdTimeMin = (Date.now() - pos.entryTime) / 60_000;
    const sellAmount = pos.size * (sellPct / 100);

    // Return SOL to balance
    this.balance += sellAmount + (sellAmount * changePct / 100);

    const trade = {
      ca,
      name: pos.name,
      entryMcap: pos.entryMcap,
      exitMcap: currentMcap,
      size: sellAmount,
      pnlPct: +changePct.toFixed(2),
      pnlSol: +pnlSol.toFixed(4),
      holdTimeMin: +holdTimeMin.toFixed(1),
      entryScores: pos.scores,
      timestamp: Date.now(),
      isWin: changePct > 0,
    };

    this.closedTrades.push(trade);
    this.stats.totalTrades++;
    this.stats.totalPnl += pnlSol;
    if (changePct > 0) this.stats.wins++;
    else this.stats.losses++;
    this.stats.bestTrade = Math.max(this.stats.bestTrade, changePct);
    this.stats.worstTrade = Math.min(this.stats.worstTrade, changePct);

    if (sellPct >= 100) {
      this.positions.delete(ca);
    } else {
      pos.size -= sellAmount;
    }

    return {
      action: "SIM_SELL",
      ...trade,
      balance: +this.balance.toFixed(4),
    };
  }

  /**
   * Update peak mcap for trailing stop simulation.
   */
  updatePosition(ca, token) {
    const pos = this.positions.get(ca);
    if (pos && token.mcapUsd) {
      pos.peakMcap = Math.max(pos.peakMcap, token.mcapUsd);
    }
  }

  /**
   * Get current simulation status.
   */
  getStatus() {
    const openPositions = [...this.positions.values()].map(p => ({
      ca: p.ca,
      name: p.name,
      size: p.size,
      entryMcap: p.entryMcap,
      holdMin: +((Date.now() - p.entryTime) / 60_000).toFixed(1),
    }));

    return {
      enabled: this.enabled,
      balance: +this.balance.toFixed(4),
      initialBalance: this.initialBalance,
      totalPnl: +this.stats.totalPnl.toFixed(4),
      totalPnlPct: +(((this.balance - this.initialBalance) / this.initialBalance) * 100).toFixed(1),
      openPositions,
      stats: this._calcStats(),
    };
  }

  /**
   * Get full simulation report (for transition to live).
   */
  getReport() {
    const stats = this._calcStats();
    const readyForLive = stats.totalTrades >= 20 && stats.winRate > 40;

    return {
      ...stats,
      balance: +this.balance.toFixed(4),
      initialBalance: this.initialBalance,
      recentTrades: this.closedTrades.slice(-10).reverse(),
      readyForLive,
      message: readyForLive
        ? `You've simulated ${stats.totalTrades} trades with a ${stats.winRate}% win rate. Ready to go live? Your settings will transfer.`
        : `Keep practicing. ${Math.max(0, 20 - stats.totalTrades)} more trades recommended before going live.`,
    };
  }

  _calcStats() {
    const total = this.stats.totalTrades || 1;
    const avgHold = this.closedTrades.length > 0
      ? this.closedTrades.reduce((s, t) => s + t.holdTimeMin, 0) / this.closedTrades.length
      : 0;

    return {
      totalTrades: this.stats.totalTrades,
      wins: this.stats.wins,
      losses: this.stats.losses,
      winRate: +((this.stats.wins / total) * 100).toFixed(1),
      totalPnl: +this.stats.totalPnl.toFixed(4),
      bestTrade: +this.stats.bestTrade.toFixed(1),
      worstTrade: +this.stats.worstTrade.toFixed(1),
      avgHoldMin: +avgHold.toFixed(1),
      sharpe: this._calcSharpe(),
    };
  }

  _calcSharpe() {
    if (this.closedTrades.length < 3) return 0;
    const returns = this.closedTrades.map(t => t.pnlPct);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    return std > 0 ? +(mean / std).toFixed(2) : 0;
  }
}

export default Simulator;
