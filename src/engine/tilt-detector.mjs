// BONDLI — Tilt Protection System
//
// After consecutive losses, traders revenge-trade with bigger size and worse judgment.
// Poker solved this problem. Trading hasn't.
//
// TILT SIGNALS:
//   - 3+ losses in 20 minutes
//   - Position sizes increasing after losses (revenge sizing)
//   - Entry threshold dropping (taking worse trades)
//   - Time between trades decreasing (FOMO spray)
//   - Manual overrides of auto-ape rejections increasing
//
// INTERVENTIONS (escalating):
//   Level 1: Warning message
//   Level 2: Force 5-minute cooldown on manual trades
//   Level 3: Reduce all position sizes by 50%
//   Level 4: Pause auto-trading, require manual review

const TILT_WINDOW = 20 * 60_000;     // 20-minute sliding window
const COOLDOWN_DURATION = 5 * 60_000; // 5-minute forced cooldown

export class TiltDetector {
  constructor() {
    this.trades = [];         // [{ time, pnl, size, score, wasOverride, wasManual }]
    this.overrides = [];      // [{ time }] manual overrides of auto-ape rejections
    this.tiltLevel = 0;       // 0-4
    this.cooldownUntil = 0;   // timestamp when cooldown expires
    this.interventions = [];  // history of interventions
    this.sessionPnl = 0;
    this.sessionStart = Date.now();
  }

  /**
   * Record a completed trade.
   */
  recordTrade(trade) {
    this.trades.push({
      time: Date.now(),
      pnl: trade.pnl || 0,
      pnlPct: trade.pnlPct || 0,
      size: trade.size || 0,
      score: trade.score || 0,
      wasOverride: trade.wasOverride || false,
      wasManual: trade.wasManual || false,
    });

    this.sessionPnl += trade.pnl || 0;

    // Keep last 100 trades
    if (this.trades.length > 100) this.trades.shift();

    this._evaluate();
  }

  /**
   * Record a manual override of auto-ape rejection.
   */
  recordOverride() {
    this.overrides.push({ time: Date.now() });
    if (this.overrides.length > 50) this.overrides.shift();
    this._evaluate();
  }

  /**
   * Core tilt detection logic.
   */
  _evaluate() {
    const now = Date.now();
    const windowStart = now - TILT_WINDOW;

    // Recent trades in the tilt window
    const recent = this.trades.filter(t => t.time > windowStart);
    const recentOverrides = this.overrides.filter(o => o.time > windowStart);

    if (recent.length < 2) {
      this.tiltLevel = 0;
      return;
    }

    let signals = 0;

    // Signal 1: Consecutive losses
    const losses = recent.filter(t => t.pnl < 0);
    const consecutiveLosses = this._getConsecutiveLosses(recent);
    if (consecutiveLosses >= 5) signals += 3;
    else if (consecutiveLosses >= 3) signals += 2;
    else if (losses.length >= 4 && losses.length / recent.length > 0.7) signals += 1;

    // Signal 2: Revenge sizing (size increasing after losses)
    if (recent.length >= 4) {
      const lastFew = recent.slice(-4);
      let sizeIncreasing = 0;
      for (let i = 1; i < lastFew.length; i++) {
        if (lastFew[i - 1].pnl < 0 && lastFew[i].size > lastFew[i - 1].size * 1.2) {
          sizeIncreasing++;
        }
      }
      if (sizeIncreasing >= 2) signals += 2;
      else if (sizeIncreasing >= 1) signals += 1;
    }

    // Signal 3: Score quality dropping (taking worse entries)
    if (recent.length >= 3) {
      const scores = recent.map(t => t.score);
      const firstHalf = scores.slice(0, Math.ceil(scores.length / 2));
      const secondHalf = scores.slice(Math.ceil(scores.length / 2));
      const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
      if (avgSecond < avgFirst * 0.7) signals += 2; // quality dropping significantly
      else if (avgSecond < avgFirst * 0.85) signals += 1;
    }

    // Signal 4: Trade frequency increasing (FOMO spray)
    if (recent.length >= 4) {
      const gaps = [];
      for (let i = 1; i < recent.length; i++) {
        gaps.push(recent[i].time - recent[i - 1].time);
      }
      const firstGaps = gaps.slice(0, Math.ceil(gaps.length / 2));
      const lastGaps = gaps.slice(Math.ceil(gaps.length / 2));
      const avgFirst = firstGaps.reduce((a, b) => a + b, 0) / firstGaps.length;
      const avgLast = lastGaps.reduce((a, b) => a + b, 0) / lastGaps.length;
      if (avgLast < avgFirst * 0.4) signals += 2; // trading much faster
      else if (avgLast < avgFirst * 0.6) signals += 1;
    }

    // Signal 5: Override frequency
    if (recentOverrides.length >= 4) signals += 2;
    else if (recentOverrides.length >= 2) signals += 1;

    // Signal 6: Session drawdown
    const sessionDuration = (now - this.sessionStart) / 3600_000; // hours
    if (sessionDuration > 0.5 && this.sessionPnl < -0.5) signals += 2; // down >0.5 SOL in 30min
    else if (sessionDuration > 1 && this.sessionPnl < -1) signals += 3;

    // Map signals to tilt level
    if (signals >= 8) this.tiltLevel = 4;
    else if (signals >= 5) this.tiltLevel = 3;
    else if (signals >= 3) this.tiltLevel = 2;
    else if (signals >= 1) this.tiltLevel = 1;
    else this.tiltLevel = 0;
  }

  _getConsecutiveLosses(trades) {
    let max = 0;
    let current = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      if (trades[i].pnl < 0) {
        current++;
        max = Math.max(max, current);
      } else {
        break; // only count from the end (most recent streak)
      }
    }
    return max;
  }

  /**
   * Get current tilt status and any active interventions.
   */
  getStatus() {
    const now = Date.now();
    const inCooldown = now < this.cooldownUntil;
    const recent = this.trades.filter(t => t.time > now - TILT_WINDOW);
    const losses = recent.filter(t => t.pnl < 0);
    const consecutiveLosses = this._getConsecutiveLosses(recent);

    const intervention = this._getIntervention();

    return {
      tiltLevel: this.tiltLevel,
      inCooldown,
      cooldownRemaining: inCooldown ? Math.ceil((this.cooldownUntil - now) / 1000) : 0,
      intervention,
      stats: {
        recentTrades: recent.length,
        recentLosses: losses.length,
        consecutiveLosses,
        sessionPnl: +this.sessionPnl.toFixed(4),
        overridesInWindow: this.overrides.filter(o => o.time > now - TILT_WINDOW).length,
      },
    };
  }

  _getIntervention() {
    switch (this.tiltLevel) {
      case 0:
        return null;
      case 1:
        return {
          level: 1,
          action: "WARNING",
          message: `You've had ${this._getConsecutiveLosses(this.trades.filter(t => t.time > Date.now() - TILT_WINDOW))} losses in a row. Your recent entries scored below your average. Consider pausing.`,
          sizeMultiplier: 1.0,
          tradingAllowed: true,
        };
      case 2: {
        if (Date.now() > this.cooldownUntil) {
          this.cooldownUntil = Date.now() + COOLDOWN_DURATION;
        }
        return {
          level: 2,
          action: "COOLDOWN",
          message: "Forced 5-minute cooldown on manual trades. Auto-ape continues normally.",
          sizeMultiplier: 1.0,
          tradingAllowed: true, // auto-ape still works
          manualBlocked: true,
        };
      }
      case 3:
        return {
          level: 3,
          action: "SIZE_REDUCTION",
          message: "All position sizes reduced by 50% for the next 30 minutes.",
          sizeMultiplier: 0.5,
          tradingAllowed: true,
        };
      case 4:
        return {
          level: 4,
          action: "PAUSE",
          message: `You're down ${Math.abs(this.sessionPnl).toFixed(3)} SOL this session. Auto-trading paused. Review your trades before continuing.`,
          sizeMultiplier: 0,
          tradingAllowed: false,
        };
      default:
        return null;
    }
  }

  /**
   * Check if a trade should be allowed right now.
   * Returns { allowed, adjustedSize, reason }
   */
  checkTrade(baseSol, isManual = false) {
    const status = this.getStatus();

    if (!status.intervention) {
      return { allowed: true, adjustedSize: baseSol, reason: null };
    }

    const i = status.intervention;

    // Level 4: block everything
    if (i.level === 4) {
      return { allowed: false, adjustedSize: 0, reason: i.message };
    }

    // Level 2: block manual only
    if (i.level === 2 && isManual && status.inCooldown) {
      return { allowed: false, adjustedSize: 0, reason: `Manual trading paused. ${status.cooldownRemaining}s remaining.` };
    }

    // Level 3: reduce size
    return {
      allowed: true,
      adjustedSize: +(baseSol * i.sizeMultiplier).toFixed(4),
      reason: i.level >= 2 ? i.message : null,
      warning: i.level === 1 ? i.message : null,
    };
  }

  /**
   * Reset tilt state (called when user acknowledges or session resets).
   */
  reset() {
    this.tiltLevel = 0;
    this.cooldownUntil = 0;
    this.sessionPnl = 0;
    this.sessionStart = Date.now();
    this.trades = [];
    this.overrides = [];
  }
}

export default TiltDetector;
