// ═══ VELOCITY — Meta-governor (DP7) ═══
// Reads the ledger, never the market. Detects the systematic errors BRAD's L2
// names (overconfidence, revenge trading, regime blindness, winner bias, loss
// aversion, recency bias, concentration) plus bondli's tilt levels, and turns
// them into one throttle in [0,1] and one halt flag. It can shrink and stop.
// It can never grow: the caps live in the risk envelope and are not its to touch.

import { TiltDetector } from "../../engine/tilt-detector.mjs";
import { withClock } from "./pipeline.mjs";

// bondli's regime engine says EUPHORIA is 1.5x. A governor cannot amplify, so it is 1.0 here.
export const REGIME_MULT = Object.freeze({ EUPHORIA: 1.0, RISK_ON: 1.0, GRINDING: 0.7, PVP: 0.4, DEAD: 0 });

export class Governor {
  constructor({ ledger, envelope, clock = () => Date.now(), config = {} } = {}) {
    this.ledger = ledger;
    this.env = envelope;
    this.clock = clock;
    this.cfg = {
      dailyFloorThrottle: 0.25,      // the smallest the daily-loss taper shrinks a stake to; never zero
      dailyBreakerMult: 3,           // x the daily limit in one day: a fault, and the only hard stop left
      streakThrottle: { 3: 0.5, 4: 0.25 },
      maxConsecutiveLosses: 5,
      revengeWindowMs: 120_000,
      revengeCount: 2,
      confidenceGapMax: 0.15,
      minOutcomesForCalibration: 20,
      recencyWindow: 5,
      lossAversionRatio: 2.0,
      lookback: 200,
      ...config,
    };
    this.tilt = new TiltDetector();
    this._tiltFed = 0;
    this.last = null;
  }

  _outcomes() {
    return this.ledger.query({ kind: "outcome", limit: this.cfg.lookback });
  }

  _feedTilt(outcomes) {
    // TiltDetector timestamps with Date.now(); pin it to each outcome's time.
    for (const o of outcomes.slice(this._tiltFed)) {
      withClock(o.ts || o.closedAt || this.clock(), () => this.tilt.recordTrade({ pnl: o.pnl_usd, pnlPct: o.pnl_pct, size: o.stake_usd, score: (o.confidence || 0) * 100 }));
    }
    this._tiltFed = outcomes.length;
  }

  evaluate({ regime = "RISK_ON", realized_today_usd = 0, open = [] } = {}) {
    const outcomes = this._outcomes();
    this._feedTilt(outcomes);
    const reasons = [];
    const spots = {};
    const mults = [];
    let halt = false, haltReason = null;
    const flag = (name, severity, detail, mult = null) => {
      spots[name] = { triggered: true, severity: +severity.toFixed(2), detail };
      reasons.push(`${name}: ${detail}`);
      if (mult != null) mults.push(mult);
    };
    const stop = (name, detail) => { halt = true; haltReason = haltReason || name; flag(name, 1, detail, 0); };

    // Daily loss: halt before the limit, counting open worst case.
    const limit = this.env.daily_loss_limit_usd;
    const realizedLoss = Math.max(0, -realized_today_usd);
    const openRisk = open.reduce((s, p) => s + (p.notional_usd || 0) * (p.worst_case_fraction ?? 1), 0);
    // A cliff was the wrong shape for this. Halting at 80% of the limit locked the bot out for the
    // rest of the UTC day over a loss it could plausibly have traded back at a smaller size, and it
    // fired on an ordinary bad hour because the limit is sized for a day. It also refused every
    // candidate loudly, which told the operator nothing they could act on.
    //
    // The limit is now a taper, not a gate: from half the limit onwards the stake shrinks smoothly
    // toward dailyFloorThrottle and stays there. Losing more always means betting less, at every
    // point, with no step to game and no lockout to wait out. Open risk counts against the taper the
    // same as realized loss, because money at risk is money that can still be lost today.
    //
    // The one remaining hard stop is a circuit breaker, not a trading rule: dailyBreakerMult times
    // the limit in a single day is not a losing session, it is something broken -- a mispriced venue,
    // a sell path that cannot sell, a feed lying about a price -- and the right response to that is
    // to stop and be looked at.
    const exposure = realizedLoss + openRisk;
    const breaker = limit * this.cfg.dailyBreakerMult;
    if (realizedLoss >= breaker) {
      stop("daily_breaker", `realized loss ${realizedLoss.toFixed(2)} is ${this.cfg.dailyBreakerMult}x the daily limit of ${limit}; that is a fault, not a drawdown`);
    } else if (exposure > limit * 0.5) {
      // 0.5x the limit -> 1.0, 1.0x -> the floor, and flat at the floor beyond that.
      const over = Math.min(1, (exposure / limit - 0.5) / 0.5);
      const mult = 1 - over * (1 - this.cfg.dailyFloorThrottle);
      flag("daily_limit", Math.min(1, exposure / limit),
        `${exposure.toFixed(2)} of the ${limit} daily limit is spent (${realizedLoss.toFixed(2)} realized, ${openRisk.toFixed(2)} still open); stakes at ${Math.round(mult * 100)}%`,
        +mult.toFixed(3));
    }

    // Losing streak: counted and shown, never a brake. On a curve venue the base rate is a 25-35%
    // win rate, so five losses in a row is an ordinary week of Tuesdays; a halt here with no
    // cooldown froze the bot for good after six trades. The daily loss limit is the only money brake.
    let streak = 0;
    for (let i = outcomes.length - 1; i >= 0; i--) { if (outcomes[i].pnl_usd < 0) streak++; else break; }
    if (streak >= 3) spots.losing_streak = { triggered: false, severity: Math.min(1, streak / 8), detail: `${streak} consecutive losses (informational)` };

    // Overconfidence: stated p_win vs realized win rate.
    if (outcomes.length >= this.cfg.minOutcomesForCalibration) {
      const stated = outcomes.reduce((s, o) => s + (Number(o.p_win) || 0), 0) / outcomes.length;
      const realized = outcomes.filter(o => o.pnl_usd > 0).length / outcomes.length;
      const gap = stated - realized;
      // The wider the gap, the smaller the stake: half at the threshold, a quarter when the realized rate
      // is under half the stated one. Size is what the gap costs; entries still happen.
      if (gap > this.cfg.confidenceGapMax) flag("overconfidence", Math.min(1, gap / 0.3), `stated ${stated.toFixed(2)} vs realized ${realized.toFixed(2)}${realized < stated / 2 ? "; the edge is not showing up, sizes cut to a quarter" : ""}`, realized < stated / 2 ? 0.25 : 0.5);
    }

    // Revenge trading: a bigger entry right after a loss, repeatedly.
    const entries = this.ledger.query({ kind: "fill", limit: this.cfg.lookback }).filter(f => f.side === "BUY");
    let revenge = 0;
    for (const o of outcomes.filter(o => o.pnl_usd < 0)) {
      const next = entries.find(e => e.ts > o.ts && e.ts - o.ts <= this.cfg.revengeWindowMs && e.notional_usd > (o.stake_usd || 0) * 1.2);
      if (next) revenge++;
    }
    if (revenge >= this.cfg.revengeCount) flag("revenge_trading", Math.min(1, revenge / 4), `${revenge} larger re-entries within ${this.cfg.revengeWindowMs / 1000}s of a loss`, 0.5);

    // Recency bias: a hot last-few would tempt sizing up; base rate says otherwise.
    if (outcomes.length >= this.cfg.recencyWindow * 4) {
      const recent = outcomes.slice(-this.cfg.recencyWindow);
      const rWin = recent.filter(o => o.pnl_usd > 0).length / recent.length;
      const bWin = outcomes.filter(o => o.pnl_usd > 0).length / outcomes.length;
      if (rWin - bWin > 0.4) flag("recency_bias", rWin - bWin, `last ${recent.length} won ${Math.round(rWin * 100)}% vs base ${Math.round(bWin * 100)}%`, 0.8);
    }

    // Loss aversion / winner bias: losers held far longer than winners.
    const losers = outcomes.filter(o => o.pnl_usd < 0 && o.held_ms), winners = outcomes.filter(o => o.pnl_usd > 0 && o.held_ms);
    if (losers.length >= 5 && winners.length >= 5) {
      const avg = a => a.reduce((s, o) => s + o.held_ms, 0) / a.length;
      const ratio = avg(losers) / Math.max(1, avg(winners));
      if (ratio > this.cfg.lossAversionRatio) flag("loss_aversion", Math.min(1, ratio / 4), `losers held ${ratio.toFixed(1)}x longer than winners`, 0.8);
    }

    // Concentration: informational; the sizer already blocks the group cap.
    const groups = {};
    for (const p of open) if (p.group) groups[p.group] = (groups[p.group] || 0) + 1;
    const crowded = Object.entries(groups).filter(([, n]) => n >= this.env.max_per_group);
    if (crowded.length) flag("concentration_risk", 0.5, `${crowded.map(([g, n]) => `${g}:${n}`).join(", ")} at the per-group cap`);

    // Tilt (bondli): level 3 halves size, level 4 halts.
    const tilt = this.tilt.getStatus();
    // Tilt shrinks size, never stops the bot: the daily limit is the stop.
    if (tilt.tiltLevel >= 4) flag("tilt", 1, `tilt level 4: sizes halved (session pnl ${(tilt.stats?.sessionPnl ?? 0).toFixed(2)} USD)`, 0.5);
    else if (tilt.tiltLevel === 3) flag("tilt", 0.75, "tilt level 3: sizes halved", 0.5);
    else if (tilt.tiltLevel > 0) spots.tilt = { triggered: false, severity: tilt.tiltLevel / 4, detail: `tilt level ${tilt.tiltLevel}` };

    // Regime blindness: the regime sets the ceiling.
    const regimeMult = REGIME_MULT[regime] ?? 1;
    if (regimeMult === 0) stop("regime", `regime ${regime}: no entries`);
    else if (regimeMult < 1) flag("regime", 1 - regimeMult, `regime ${regime} caps activity at ${regimeMult}`, regimeMult);

    const throttle = halt ? 0 : Math.max(0, Math.min(1, ...mults, 1));
    this.last = { throttle: +throttle.toFixed(3), halt, haltReason, reasons, blindSpots: spots, regime, regimeMult, tiltLevel: tilt.tiltLevel, streak, outcomes: outcomes.length, at: this.clock() };
    return this.last;
  }
}
