/**
 * ═══════════════════════════════════════════════════════════════
 * BRAD PAPER TRADER — Virtual Portfolio for Cognitive Learning
 * ═══════════════════════════════════════════════════════════════
 *
 * Gives BRAD a virtual bankroll to paper trade with. Every decision
 * BRAD makes gets tracked with P&L, creating a feedback loop:
 *
 *   BRAD evaluates token → paper enters → price moves → paper exits
 *   → outcome recorded → BRAD L2 learns from the outcome → strange
 *   loop fires → strategy/confidence adjusted → better next decision
 *
 * This is how BRAD bootstraps its Hofstadter Index from 0 to meaningful
 * — it needs trade outcomes to trigger meta-cognitive evaluations,
 * which trigger strange loops (downward causation), which increase HI.
 *
 * Paper trading runs continuously alongside real trading. BRAD's L2
 * learns from BOTH paper and real outcomes. When paper win rate
 * exceeds threshold, BRAD can recommend graduating to real SOL.
 */

import bradClient from "./brad-client.mjs";

// ═══ PAPER PORTFOLIO STATE ═══

const DEFAULT_BANKROLL = 10.0; // 10 SOL starting paper bankroll

class PaperPortfolio {
  constructor(bankroll = DEFAULT_BANKROLL) {
    this.startingBankroll = bankroll;
    this.bankroll = bankroll;
    this.positions = new Map(); // ca → { name, entryMcap, entryScore, entrySol, entryTime, bradConfidence, strategy }
    this.closedTrades = []; // { ...position, exitMcap, pnlPct, pnlSol, exitReason, exitTime }
    this.stats = { wins: 0, losses: 0, totalPnlSol: 0, peakBankroll: bankroll, maxDrawdownPct: 0 };
    this._startedAt = Date.now();

    // Learning metrics — what BRAD tracks about its own paper performance
    this.learning = {
      totalEvaluations: 0,
      apesTriggered: 0,
      skipsTriggered: 0,
      vetosTriggered: 0,
      correctApes: 0, // apes that were profitable
      correctSkips: 0, // skips on tokens that went down
      missedAlpha: 0, // skips on tokens that went up >50%
      avgWinPct: 0,
      avgLossPct: 0,
      bestTrade: null,
      worstTrade: null,
      strategyBreakdown: {}, // strategy → { wins, losses, pnl }
      blindSpotsDetected: 0,
      strangeLoopsFired: 0,
    };
  }

  get winRate() {
    const total = this.stats.wins + this.stats.losses;
    return total > 0 ? this.stats.wins / total : 0;
  }

  get totalTrades() {
    return this.stats.wins + this.stats.losses;
  }

  get drawdownPct() {
    return this.stats.peakBankroll > 0
      ? ((this.stats.peakBankroll - this.bankroll) / this.stats.peakBankroll) * 100
      : 0;
  }

  get readyToGraduate() {
    // Graduate when: 20+ trades, >45% win rate, positive PnL, <15% drawdown
    return this.totalTrades >= 20 &&
      this.winRate >= 0.45 &&
      this.stats.totalPnlSol > 0 &&
      this.drawdownPct < 15;
  }

  enterPosition(ca, name, mcap, score, solAmount, bradConfidence, strategy) {
    if (this.positions.has(ca)) return null;
    if (solAmount > this.bankroll) solAmount = this.bankroll * 0.1; // max 10% per trade
    if (solAmount < 0.01) return null;

    this.bankroll -= solAmount;
    const pos = {
      ca, name, entryMcap: mcap, entryScore: score,
      entrySol: solAmount, entryTime: Date.now(),
      bradConfidence, strategy: strategy || "momentum",
      peakMcap: mcap,
    };
    this.positions.set(ca, pos);
    return pos;
  }

  exitPosition(ca, currentMcap, reason) {
    const pos = this.positions.get(ca);
    if (!pos) return null;
    this.positions.delete(ca);

    const pnlPct = pos.entryMcap > 0 ? ((currentMcap - pos.entryMcap) / pos.entryMcap) * 100 : 0;
    const pnlSol = pos.entrySol * (pnlPct / 100);
    this.bankroll += pos.entrySol + pnlSol;

    const trade = {
      ...pos, exitMcap: currentMcap, pnlPct: +pnlPct.toFixed(1),
      pnlSol: +pnlSol.toFixed(4), exitReason: reason,
      exitTime: Date.now(), holdTimeMs: Date.now() - pos.entryTime,
    };

    this.closedTrades.push(trade);
    if (this.closedTrades.length > 500) this.closedTrades = this.closedTrades.slice(-500);

    // Update stats
    if (pnlPct > 1) {
      this.stats.wins++;
      this.learning.avgWinPct = (this.learning.avgWinPct * (this.stats.wins - 1) + pnlPct) / this.stats.wins;
    } else if (pnlPct < -1) {
      this.stats.losses++;
      this.learning.avgLossPct = (this.learning.avgLossPct * (this.stats.losses - 1) + pnlPct) / this.stats.losses;
    }

    this.stats.totalPnlSol += pnlSol;
    if (this.bankroll > this.stats.peakBankroll) this.stats.peakBankroll = this.bankroll;
    this.stats.maxDrawdownPct = Math.max(this.stats.maxDrawdownPct, this.drawdownPct);

    // Track best/worst
    if (!this.learning.bestTrade || pnlPct > this.learning.bestTrade.pnlPct) {
      this.learning.bestTrade = { name: pos.name, pnlPct: +pnlPct.toFixed(1), ca };
    }
    if (!this.learning.worstTrade || pnlPct < this.learning.worstTrade.pnlPct) {
      this.learning.worstTrade = { name: pos.name, pnlPct: +pnlPct.toFixed(1), ca };
    }

    // Strategy breakdown
    const strat = pos.strategy || "unknown";
    if (!this.learning.strategyBreakdown[strat]) {
      this.learning.strategyBreakdown[strat] = { wins: 0, losses: 0, pnl: 0 };
    }
    const sb = this.learning.strategyBreakdown[strat];
    if (pnlPct > 1) sb.wins++;
    else if (pnlPct < -1) sb.losses++;
    sb.pnl += pnlSol;

    return trade;
  }

  updatePeaks(ca, currentMcap) {
    const pos = this.positions.get(ca);
    if (pos && currentMcap > pos.peakMcap) {
      pos.peakMcap = currentMcap;
    }
  }

  getSummary() {
    return {
      bankroll: +this.bankroll.toFixed(4),
      startingBankroll: this.startingBankroll,
      pnlSol: +this.stats.totalPnlSol.toFixed(4),
      pnlPct: +((this.bankroll - this.startingBankroll) / this.startingBankroll * 100).toFixed(1),
      openPositions: this.positions.size,
      totalTrades: this.totalTrades,
      winRate: +(this.winRate * 100).toFixed(1),
      wins: this.stats.wins,
      losses: this.stats.losses,
      drawdownPct: +this.drawdownPct.toFixed(1),
      maxDrawdownPct: +this.stats.maxDrawdownPct.toFixed(1),
      readyToGraduate: this.readyToGraduate,
      uptimeMs: Date.now() - this._startedAt,
      learning: this.learning,
      recentTrades: this.closedTrades.slice(-10).reverse(),
      openList: [...this.positions.entries()].map(([ca, p]) => ({
        ca, name: p.name, entryScore: p.entryScore,
        entrySol: p.entrySol, bradConfidence: p.bradConfidence,
        strategy: p.strategy, ageMs: Date.now() - p.entryTime,
      })),
    };
  }
}

// ═══ PAPER TRADER ENGINE ═══

let _portfolio = null;
let _enabled = false;
let _maxPositions = 10;
let _positionSizePct = 0.05; // 5% of bankroll per trade

/**
 * Start BRAD paper trading with a virtual bankroll.
 */
export function startPaperTrading(bankrollSol = DEFAULT_BANKROLL, opts = {}) {
  _portfolio = new PaperPortfolio(bankrollSol);
  _enabled = true;
  _maxPositions = opts.maxPositions || 10;
  _positionSizePct = opts.positionSizePct || 0.05;
  console.log(`[BRAD-PAPER] Started with ${bankrollSol} SOL paper bankroll, max ${_maxPositions} positions`);
  return _portfolio.getSummary();
}

/**
 * Stop paper trading.
 */
export function stopPaperTrading() {
  _enabled = false;
  const summary = _portfolio?.getSummary() || null;
  console.log(`[BRAD-PAPER] Stopped. ${summary?.totalTrades || 0} trades, ${summary?.winRate || 0}% win, ${summary?.pnlSol || 0} SOL PnL`);
  return summary;
}

/**
 * Process a token through BRAD's paper trading logic.
 * Called from the scan loop for every scored token.
 *
 * Returns a paper trade decision if BRAD wants to enter.
 */
export function paperEvaluate(token, bradEval, scoreDyn) {
  if (!_enabled || !_portfolio) return null;
  _portfolio.learning.totalEvaluations++;

  // If BRAD says APE and we're not already in
  if (bradEval?.action === "APE" && bradEval.confidence >= 0.5) {
    _portfolio.learning.apesTriggered++;

    if (_portfolio.positions.has(token.ca)) return null;
    if (_portfolio.positions.size >= _maxPositions) return null;

    const sizeSol = Math.max(0.01, _portfolio.bankroll * _positionSizePct);
    const pos = _portfolio.enterPosition(
      token.ca,
      token.name || token.ca?.slice(0, 8),
      token.mcapUsd || 0,
      token._apeScore || 0,
      sizeSol,
      bradEval.confidence,
      bradEval.strategy || "momentum",
    );

    if (pos) {
      // Record entry in BRAD's cognitive engine for learning
      if (bradClient.isHealthy()) {
        bradClient.recordEntry({
          ca: token.ca, name: token.name,
          priceSol: 0, sizeSol: sizeSol,
          score: token._apeScore || 0,
          reasoning: ["paper_trade", `conf:${bradEval.confidence.toFixed(2)}`],
        }).catch(() => {});
      }

      return { action: "PAPER_ENTER", ...pos, sizeSol };
    }
  } else if (bradEval?.action === "SKIP") {
    _portfolio.learning.skipsTriggered++;
  }

  return null;
}

/**
 * Check paper positions for exits.
 * Called from the scan loop for every token we hold.
 */
export function paperCheckExit(ca, currentMcap, score, scoreDyn, bradExitEval) {
  if (!_enabled || !_portfolio) return null;

  const pos = _portfolio.positions.get(ca);
  if (!pos) return null;

  _portfolio.updatePeaks(ca, currentMcap);

  const changePct = pos.entryMcap > 0 ? ((currentMcap - pos.entryMcap) / pos.entryMcap) * 100 : 0;
  const fromPeak = pos.peakMcap > 0 ? ((pos.peakMcap - currentMcap) / pos.peakMcap) * 100 : 0;
  const holdTimeMs = Date.now() - pos.entryTime;

  // Exit conditions (mirrors real auto-ape)
  let exitReason = null;

  // BRAD L2 meta-cognitive exit
  if (bradExitEval?.action === "EXIT" && bradExitEval.confidence >= 0.7) {
    exitReason = "brad-exit";
  }
  // Score crashing
  else if (scoreDyn?.trend === "crashing" && scoreDyn.scores >= 3) {
    exitReason = "crash-exit";
  }
  // Stop loss
  else if (changePct <= -15) {
    exitReason = "stop-loss";
  }
  // Max hold time (15 min for paper)
  else if (holdTimeMs > 15 * 60000 && changePct < 20) {
    exitReason = "max-hold";
  }
  // Score floor
  else if (score < 15 && holdTimeMs > 30000) {
    exitReason = "score-floor";
  }
  // Take profit at +50%
  else if (changePct >= 50) {
    exitReason = "take-profit";
  }
  // Trailing stop from peak
  else if (fromPeak > 30 && changePct > 10) {
    exitReason = "trailing-stop";
  }

  if (exitReason) {
    const trade = _portfolio.exitPosition(ca, currentMcap, exitReason);
    if (trade) {
      // Record exit in BRAD for meta-cognitive learning
      if (bradClient.isHealthy()) {
        bradClient.recordExit({
          ca, exitPriceSol: 0, reason: `paper_${exitReason}`,
        }).catch(() => {});
      }
      return { action: "PAPER_EXIT", ...trade };
    }
  }

  return null;
}

/**
 * Get paper trading status + learning metrics.
 */
export function getPaperStatus() {
  if (!_portfolio) return { enabled: false };
  return {
    enabled: _enabled,
    ..._portfolio.getSummary(),
  };
}

/**
 * Check if paper trading is enabled.
 */
export function isPaperEnabled() {
  return _enabled && _portfolio !== null;
}

/**
 * Record a skip outcome — when BRAD skipped a token, track what happened to it.
 * This is how we measure "missed alpha" — tokens BRAD should have aped.
 */
export function recordSkipOutcome(ca, name, entryMcap, currentMcap) {
  if (!_portfolio) return;
  const changePct = entryMcap > 0 ? ((currentMcap - entryMcap) / entryMcap) * 100 : 0;
  if (changePct > 50) {
    _portfolio.learning.missedAlpha++;
  }
}

export default {
  startPaperTrading,
  stopPaperTrading,
  paperEvaluate,
  paperCheckExit,
  getPaperStatus,
  isPaperEnabled,
  recordSkipOutcome,
};
