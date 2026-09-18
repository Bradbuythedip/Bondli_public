// BONDLI — Attention-Value Divergence (AVR)
//
// Nobody tracks whether a token's social attention matches its market cap.
//
// AVR = attention_share / market_share
//   attention_share = token_mentions / total_memecoin_mentions
//   market_share = token_mcap / total_memecoin_mcap
//
// AVR > 3.0: Undervalued — 3x more attention than price reflects
// AVR = 1.0: Fairly valued relative to attention
// AVR < 0.3: Overvalued — price running ahead of attention. Sell signal.

export class AttentionValueEngine {
  constructor() {
    // Sliding window of mention counts per token
    this.mentionCounts = new Map();  // ca → { count, lastUpdated }
    this.totalMentions = 0;
    this.totalMcap = 0;
    this._lastGlobalUpdate = 0;
    this.WINDOW = 3600_000; // 1h window
  }

  /**
   * Update mention count for a token (called by social monitors).
   */
  recordMentions(ca, count) {
    const existing = this.mentionCounts.get(ca) || { count: 0, lastUpdated: 0 };
    existing.count = count;
    existing.lastUpdated = Date.now();
    this.mentionCounts.set(ca, existing);
  }

  /**
   * Update global market totals (called by market poller).
   */
  updateGlobals(totalMentions, totalMcap) {
    this.totalMentions = totalMentions || this.totalMentions;
    this.totalMcap = totalMcap || this.totalMcap;
    this._lastGlobalUpdate = Date.now();
  }

  /**
   * Calculate AVR for a specific token.
   *
   * @param {string} ca - Token contract address
   * @param {number} mcapUsd - Token market cap in USD
   * @param {number} [mentions] - Override mention count (if not using recorded data)
   * @returns {Object} AVR analysis
   */
  calcAVR(ca, mcapUsd, mentions) {
    const tokenMentions = mentions ?? (this.mentionCounts.get(ca)?.count || 0);
    const totalMentions = Math.max(1, this.totalMentions);
    const totalMcap = Math.max(1, this.totalMcap);

    const attentionShare = tokenMentions / totalMentions;
    const marketShare = mcapUsd / totalMcap;

    // Avoid division by zero
    const avr = marketShare > 0 ? attentionShare / marketShare : 0;

    let signal, description;
    if (avr >= 5.0) {
      signal = "EXTREME_UNDERVALUED";
      description = `${avr.toFixed(1)}x more attention than price reflects. Potential breakout.`;
    } else if (avr >= 3.0) {
      signal = "UNDERVALUED";
      description = `${avr.toFixed(1)}x attention vs price. Market hasn't caught up.`;
    } else if (avr >= 1.5) {
      signal = "SLIGHT_UNDERVALUED";
      description = "Attention slightly above price. Healthy momentum building.";
    } else if (avr >= 0.7) {
      signal = "FAIR_VALUE";
      description = "Attention matches price. Fairly valued.";
    } else if (avr >= 0.3) {
      signal = "OVERVALUED";
      description = "Price running ahead of attention. Consider taking profit.";
    } else {
      signal = "EXTREME_OVERVALUED";
      description = "Price significantly above attention. Sell signal.";
    }

    return {
      avr: +avr.toFixed(3),
      signal,
      description,
      attentionShare: +attentionShare.toFixed(6),
      marketShare: +marketShare.toFixed(6),
      tokenMentions,
      mcapUsd,
      // Scoring integration: bonus/penalty for auto-ape
      scoreDelta: avr >= 3.0 ? 10 : avr >= 1.5 ? 5 : avr >= 0.7 ? 0 : avr >= 0.3 ? -5 : -10,
    };
  }

  /**
   * Batch calculate AVR for multiple tokens (for radar display).
   */
  calcBatch(tokens) {
    return tokens.map(t => ({
      ca: t.ca,
      name: t.name,
      ticker: t.ticker,
      ...this.calcAVR(t.ca, t.mcapUsd || 0),
    }));
  }

  /**
   * Prune stale mention data (older than window).
   */
  prune() {
    const cutoff = Date.now() - this.WINDOW;
    for (const [ca, data] of this.mentionCounts) {
      if (data.lastUpdated < cutoff) this.mentionCounts.delete(ca);
    }
  }
}

export default AttentionValueEngine;
