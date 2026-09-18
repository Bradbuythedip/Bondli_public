/**
 * ═══════════════════════════════════════════════════════════════
 * DEMAND AUTHENTICITY ENGINE — Is the buying real or manufactured?
 * ═══════════════════════════════════════════════════════════════
 *
 * Every rug follows the same playbook: simulate demand, attract
 * real buyers, pull liquidity. This engine detects the simulation.
 *
 * Five detection layers:
 *   1. TEMPORAL — Are buys bursty (organic) or periodic (bot)?
 *   2. DISTRIBUTION — Are buy amounts diverse or uniform?
 *   3. DIVERSITY — Are buyers unique participants or recycled wallets?
 *   4. QUALITY — Have these wallets traded profitably before?
 *   5. WASH — Are wallets cycling buy→sell→buy to inflate volume?
 *
 * Output: demand_authenticity_score (0 = manufactured, 1 = organic)
 *
 * ═══════════════════════════════════════════════════════════════
 */

export class DemandAuthenticityEngine {
  constructor({ smartWallets = null, smartMoneyTracker = null } = {}) {
    this.smartWallets = smartWallets;
    this.smartMoneyTracker = smartMoneyTracker;

    // Cache: ca → { score, signals, breakdown, updatedAt }
    this.cache = new Map();
    this.CACHE_TTL_MS = 10000; // recompute every 10s (matches scoring loop)

    // Stats
    this.stats = {
      analyzed: 0,
      flagged: 0,         // score < 0.3
      avgScore: 0,
      _scoreSum: 0,
    };
  }

  /**
   * Analyze a token's buy stream and return authenticity assessment.
   *
   * @param {Object} token — radar token object with trades[], uniqueBuyers, buys, sells, volumeSol
   * @returns {{ score: number, signals: string[], breakdown: Object }}
   */
  analyze(token) {
    const ca = token.ca;

    // Check cache
    const cached = this.cache.get(ca);
    if (cached && (Date.now() - cached.updatedAt) < this.CACHE_TTL_MS) {
      return cached;
    }

    const trades = token.trades || [];
    const buys = trades.filter(t => t.side === "buy");

    // Not enough data to judge — return neutral
    if (buys.length < 4) {
      return { score: 0.5, signals: ["insufficient_data"], breakdown: {} };
    }

    const temporal = this._temporalAnalysis(buys);
    const distribution = this._amountDistribution(buys);
    const diversity = this._buyerDiversity(buys, token);
    const quality = this._buyerQuality(buys);
    const wash = this._washTradingDetection(trades);

    // Weighted combination
    const raw = (
      temporal.score * 0.25 +
      distribution.score * 0.20 +
      diversity.score * 0.25 +
      quality.score * 0.15 +
      wash.score * 0.15
    );
    const score = +Math.max(0, Math.min(1, raw)).toFixed(3);

    // Flag specific issues
    const signals = [];
    if (temporal.score < 0.3) signals.push("metronomic_buying");
    if (distribution.score < 0.3) signals.push("uniform_amounts");
    if (diversity.score < 0.3) signals.push("low_buyer_diversity");
    if (quality.score < 0.3) signals.push("unknown_buyers_only");
    if (wash.score < 0.3) signals.push("wash_trading");
    if (temporal.burstiness < -0.3) signals.push("anti_bursty");
    if (diversity.top3Share > 0.8) signals.push("whale_dominated");

    // Update stats
    this.stats.analyzed++;
    this.stats._scoreSum += score;
    this.stats.avgScore = +(this.stats._scoreSum / this.stats.analyzed).toFixed(3);
    if (score < 0.3) this.stats.flagged++;

    const result = {
      score,
      signals,
      breakdown: { temporal, distribution, diversity, quality, wash },
      updatedAt: Date.now(),
    };

    this.cache.set(ca, result);
    return result;
  }

  /**
   * Quick score only — for embedding in feature extraction.
   * Returns just the number, no breakdown.
   */
  quickScore(token) {
    return this.analyze(token).score;
  }

  // ═══════════════════════════════════════
  // LAYER 1: TEMPORAL ANALYSIS
  // ═══════════════════════════════════════
  //
  // Organic buys are bursty: tweet goes out → flood of buys → quiet → next wave.
  // Manufactured buys are periodic: one buy every N seconds, metronomic.
  //
  // Uses coefficient of variation (CV) and burstiness index.
  //   CV < 0.3 → extremely regular (bot)
  //   CV > 1.0 → bursty (organic FOMO)
  //   Burstiness: (σ - μ) / (σ + μ), ranges -1 (periodic) to +1 (bursty)

  _temporalAnalysis(buys) {
    if (buys.length < 3) return { score: 0.5, cv: 0, burstiness: 0 };

    const times = buys.map(b => b.time).sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < times.length; i++) {
      intervals.push(times[i] - times[i - 1]);
    }

    if (intervals.length === 0) return { score: 0.5, cv: 0, burstiness: 0 };

    const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
    const std = Math.sqrt(variance);
    const cv = mean > 0 ? std / mean : 0;

    // Burstiness index (Goh & Barabási, 2008)
    const burstiness = (std + mean) > 0 ? (std - mean) / (std + mean) : 0;

    // Also check for suspicious periodicity: are intervals clustered?
    // If the most common interval (rounded to 5s) appears in >40% of buys → bot
    const roundedIntervals = intervals.map(i => Math.round(i / 5000) * 5000);
    const intervalCounts = {};
    for (const ri of roundedIntervals) intervalCounts[ri] = (intervalCounts[ri] || 0) + 1;
    const maxIntervalRepeat = Math.max(...Object.values(intervalCounts));
    const periodicRatio = maxIntervalRepeat / roundedIntervals.length;

    let score;
    if (cv < 0.2) score = 0.1;
    else if (cv < 0.4) score = 0.25;
    else if (cv < 0.7) score = 0.5;
    else if (cv < 1.2) score = 0.75;
    else score = 0.9;

    // Extra penalty for strong periodicity
    if (periodicRatio > 0.5) score *= 0.6;
    else if (periodicRatio > 0.4) score *= 0.8;

    return {
      score: +Math.max(0, Math.min(1, score)).toFixed(3),
      cv: +cv.toFixed(3),
      burstiness: +burstiness.toFixed(3),
      periodicRatio: +periodicRatio.toFixed(3),
    };
  }

  // ═══════════════════════════════════════
  // LAYER 2: AMOUNT DISTRIBUTION
  // ═══════════════════════════════════════
  //
  // Organic buys follow a heavy-tail: many small buys, few large.
  // Bot buys cluster around round numbers or identical amounts.
  //
  // Uses Gini coefficient (inequality) and amount uniqueness.

  _amountDistribution(buys) {
    const amounts = buys.map(b => b.sol).filter(s => s > 0.001);
    if (amounts.length < 3) return { score: 0.5, uniqueRatio: 0, gini: 0 };

    // Uniqueness: round to 0.01 SOL, count distinct values
    const rounded = amounts.map(a => Math.round(a * 100));
    const uniqueAmounts = new Set(rounded);
    const uniqueRatio = uniqueAmounts.size / rounded.length;

    // Gini coefficient
    const sorted = [...amounts].sort((a, b) => a - b);
    const n = sorted.length;
    const totalAmount = sorted.reduce((s, v) => s + v, 0);
    let giniSum = 0;
    for (let i = 0; i < n; i++) {
      giniSum += (2 * (i + 1) - n - 1) * sorted[i];
    }
    const gini = totalAmount > 0 ? giniSum / (n * totalAmount) : 0;

    // Check for dominant amount: >40% of buys at same rounded value
    const amountCounts = {};
    for (const a of rounded) amountCounts[a] = (amountCounts[a] || 0) + 1;
    const maxSameAmount = Math.max(...Object.values(amountCounts));
    const dominantRatio = maxSameAmount / rounded.length;

    // Score: high uniqueRatio + high gini = organic
    let score = uniqueRatio * 0.5 + Math.min(1, gini * 2.5) * 0.5;

    // Penalty for repeated identical amounts
    if (dominantRatio > 0.5) score *= 0.4;
    else if (dominantRatio > 0.35) score *= 0.6;

    return {
      score: +Math.max(0, Math.min(1, score)).toFixed(3),
      uniqueRatio: +uniqueRatio.toFixed(3),
      gini: +gini.toFixed(3),
      dominantRatio: +dominantRatio.toFixed(3),
    };
  }

  // ═══════════════════════════════════════
  // LAYER 3: BUYER DIVERSITY
  // ═══════════════════════════════════════
  //
  // Organic tokens attract diverse participants.
  // Manufactured tokens have few wallets doing many buys,
  // or many fresh wallets each buying once (sybil).

  _buyerDiversity(buys, token) {
    const walletBuys = {};
    const walletSol = {};
    for (const b of buys) {
      if (!b.wallet) continue;
      walletBuys[b.wallet] = (walletBuys[b.wallet] || 0) + 1;
      walletSol[b.wallet] = (walletSol[b.wallet] || 0) + (b.sol || 0);
    }

    const totalWallets = Object.keys(walletBuys).length;
    const totalBuys = buys.filter(b => b.wallet).length;

    if (totalWallets < 2) return { score: 0.2, walletRatio: 0, singleBuyerRatio: 1, top3Share: 1, totalWallets };

    // Wallet-to-buy ratio (1.0 = every buy from different wallet)
    const walletRatio = totalBuys > 0 ? totalWallets / totalBuys : 0;

    // Single-use wallet ratio
    const singleBuyers = Object.values(walletBuys).filter(c => c === 1).length;
    const singleBuyerRatio = totalWallets > 0 ? singleBuyers / totalWallets : 0;

    // Volume concentration: top 3 wallets' share of total SOL
    const totalSol = Object.values(walletSol).reduce((s, v) => s + v, 0);
    const sortedSol = Object.values(walletSol).sort((a, b) => b - a);
    const top3Sol = sortedSol.slice(0, Math.min(3, sortedSol.length)).reduce((s, v) => s + v, 0);
    const top3Share = totalSol > 0 ? top3Sol / totalSol : 1;

    // Score components
    let score = 0;
    // Higher wallet diversity = better
    score += Math.min(1, walletRatio * 1.5) * 0.30;
    // Lower concentration = better
    score += (1 - top3Share) * 0.35;
    // Moderate single-buyer ratio is normal; very high (>80%) with many buys = sybil
    const sybilPenalty = (totalBuys > 10 && singleBuyerRatio > 0.85) ? 0.3 : 0;
    score += (1 - sybilPenalty) * 0.35 * (1 - Math.max(0, singleBuyerRatio - 0.7));

    return {
      score: +Math.max(0, Math.min(1, score)).toFixed(3),
      walletRatio: +walletRatio.toFixed(3),
      singleBuyerRatio: +singleBuyerRatio.toFixed(3),
      top3Share: +top3Share.toFixed(3),
      totalWallets,
    };
  }

  // ═══════════════════════════════════════
  // LAYER 4: BUYER QUALITY
  // ═══════════════════════════════════════
  //
  // Cross-reference buyers against smartWallets.
  // Known profitable traders buying = strong organic signal.
  // All-unknown on a high-buy token = suspicious.

  _buyerQuality(buys) {
    const wallets = [...new Set(buys.map(b => b.wallet).filter(Boolean))];

    if (wallets.length === 0) return { score: 0.5, knownRatio: 0, avgQuality: 0, knownCount: 0 };
    if (!this.smartWallets) return { score: 0.5, knownRatio: 0, avgQuality: 0, knownCount: 0 };

    let knownCount = 0;
    let qualitySum = 0;

    for (const prefix of wallets) {
      const sw = this.smartWallets?.walletStats?.get(prefix);
      if (sw && (sw.buys || 0) >= 2) {
        knownCount++;
        const total = (sw.wins || 0) + (sw.losses || 0);
        const winRate = total > 0 ? (sw.wins || 0) / total : 0;
        qualitySum += winRate;
      }
    }

    const knownRatio = wallets.length > 0 ? knownCount / wallets.length : 0;
    const avgQuality = knownCount > 0 ? qualitySum / knownCount : 0;

    // Baseline: new tokens will naturally have many unknown buyers
    // Don't over-penalize — but reward known good wallets buying
    let score;
    if (wallets.length < 5) {
      // Too few wallets to judge quality reliably
      score = 0.4 + knownRatio * 0.3 + avgQuality * 0.3;
    } else {
      score = 0.2 + knownRatio * 0.4 + avgQuality * 0.4;
    }

    return {
      score: +Math.max(0, Math.min(1, score)).toFixed(3),
      knownRatio: +knownRatio.toFixed(3),
      avgQuality: +avgQuality.toFixed(3),
      knownCount,
      totalWallets: wallets.length,
    };
  }

  // ═══════════════════════════════════════
  // LAYER 5: WASH TRADING DETECTION
  // ═══════════════════════════════════════
  //
  // Detect buy→sell→buy cycling from the same wallet.
  // This inflates both buy count and volume without real demand.

  _washTradingDetection(trades) {
    if (trades.length < 5) return { score: 0.8, washWallets: 0, totalActive: 0, washRatio: 0 };

    // Build trade sequence per wallet
    const walletSeq = {};
    for (const t of trades) {
      if (!t.wallet) continue;
      if (!walletSeq[t.wallet]) walletSeq[t.wallet] = [];
      walletSeq[t.wallet].push(t.side);
    }

    let washWallets = 0;
    let totalActive = 0;

    for (const [, seq] of Object.entries(walletSeq)) {
      if (seq.length < 3) continue;
      totalActive++;

      // Count buy→sell→buy cycles
      let cycles = 0;
      for (let i = 2; i < seq.length; i++) {
        if (seq[i] === "buy" && seq[i - 1] === "sell" && seq[i - 2] === "buy") {
          cycles++;
        }
      }
      // Also count sell→buy→sell (reverse wash)
      for (let i = 2; i < seq.length; i++) {
        if (seq[i] === "sell" && seq[i - 1] === "buy" && seq[i - 2] === "sell") {
          cycles++;
        }
      }
      if (cycles > 0) washWallets++;
    }

    const washRatio = totalActive > 0 ? washWallets / totalActive : 0;

    // Score: no wash = 1.0, 33%+ active wallets washing = 0.0
    const score = Math.max(0, 1 - washRatio * 3);

    return {
      score: +Math.max(0, Math.min(1, score)).toFixed(3),
      washWallets,
      totalActive,
      washRatio: +washRatio.toFixed(3),
    };
  }

  // ═══════════════════════════════════════
  // CACHE & STATS
  // ═══════════════════════════════════════

  cleanup() {
    const now = Date.now();
    const stale = 300000; // 5 min
    for (const [ca, entry] of this.cache) {
      if (now - entry.updatedAt > stale) this.cache.delete(ca);
    }
  }

  getStats() {
    return {
      ...this.stats,
      cacheSize: this.cache.size,
    };
  }
}

export default DemandAuthenticityEngine;
