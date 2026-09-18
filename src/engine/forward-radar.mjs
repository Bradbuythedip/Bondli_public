// BONDLI — Forward Cultural Radar
//
// Every tool shows what's trending NOW. Nobody shows what's ABOUT TO trend.
//
// Monitor upstream meme incubation platforms BEFORE memes hit Twitter/crypto:
//   Reddit rising → ~12h to Twitter crossover
//   4chan trending → ~24h to crossover
//   TikTok early viral → ~6-12h to crossover
//
// When corresponding token launches: FIRST MOVER ADVANTAGE

const UPSTREAM_SOURCES = {
  REDDIT: {
    id: "reddit",
    label: "Reddit",
    crossoverHours: 12,       // avg hours until Twitter/crypto crossover
    weight: 1.0,
    color: "#ff4500",
  },
  CHAN: {
    id: "4chan",
    label: "4chan",
    crossoverHours: 24,
    weight: 0.8,
    color: "#789922",
  },
  TIKTOK: {
    id: "tiktok",
    label: "TikTok",
    crossoverHours: 8,
    weight: 1.2,              // TikTok trends cross over fastest
    color: "#00f2ea",
  },
  DISCORD: {
    id: "discord",
    label: "Discord/TG",
    crossoverHours: 6,
    weight: 0.9,
    color: "#5865f2",
  },
};

export class ForwardRadar {
  constructor() {
    // Tracked signals: keyword → { source, firstSeen, velocity, mentions, crossoverEstimate }
    this.signals = new Map();
    this.matched = new Map();    // signals that matched to actual token launches
    this.SIGNAL_TTL = 48 * 3600_000; // expire signals after 48h
  }

  /**
   * Record an upstream signal (from Reddit/4chan/TikTok/Discord monitors).
   *
   * @param {Object} signal
   * @param {string} signal.keyword - Meme keyword/phrase
   * @param {string} signal.source - "reddit" | "4chan" | "tiktok" | "discord"
   * @param {number} signal.mentions - Current mention count
   * @param {number} signal.velocity - Mentions per hour (acceleration)
   * @param {string} [signal.subreddit] - Reddit subreddit
   * @param {string} [signal.context] - Description of the trend
   */
  recordSignal(signal) {
    const key = signal.keyword.toLowerCase().trim();
    const sourceInfo = Object.values(UPSTREAM_SOURCES).find(s => s.id === signal.source) || UPSTREAM_SOURCES.REDDIT;

    const existing = this.signals.get(key) || {
      keyword: key,
      sources: [],
      firstSeen: Date.now(),
      totalMentions: 0,
      peakVelocity: 0,
      crossoverEstimate: null,
      context: signal.context || "",
      matchedTokens: [],
    };

    // Add/update source
    const sourceEntry = existing.sources.find(s => s.source === signal.source);
    if (sourceEntry) {
      sourceEntry.mentions = signal.mentions;
      sourceEntry.velocity = signal.velocity;
      sourceEntry.lastUpdated = Date.now();
    } else {
      existing.sources.push({
        source: signal.source,
        mentions: signal.mentions,
        velocity: signal.velocity,
        subreddit: signal.subreddit,
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
      });
    }

    existing.totalMentions = existing.sources.reduce((s, src) => s + src.mentions, 0);
    existing.peakVelocity = Math.max(existing.peakVelocity, signal.velocity || 0);

    // Estimate crossover time
    const avgCrossover = existing.sources.reduce((s, src) => {
      const info = Object.values(UPSTREAM_SOURCES).find(u => u.id === src.source);
      return s + (info?.crossoverHours || 12);
    }, 0) / existing.sources.length;

    const ageHours = (Date.now() - existing.firstSeen) / 3600_000;
    existing.crossoverEstimate = {
      hoursRemaining: Math.max(0, avgCrossover - ageHours),
      confidence: Math.min(1, existing.sources.length * 0.3 + (existing.peakVelocity > 10 ? 0.3 : 0)),
    };

    if (signal.context) existing.context = signal.context;

    this.signals.set(key, existing);
  }

  /**
   * Check if a new token launch matches any forward radar signals.
   * Call this when a new token appears on pump.fun or Bags.
   *
   * @param {Object} token - { name, ticker, description }
   * @returns {Object|null} Match info if found
   */
  checkMatch(token) {
    const combined = `${token.name || ""} ${token.ticker || ""} ${token.description || ""}`.toLowerCase();

    for (const [keyword, signal] of this.signals) {
      if (combined.includes(keyword) || keyword.includes(token.ticker?.toLowerCase() || "___")) {
        // Match found
        signal.matchedTokens.push({
          ca: token.ca,
          name: token.name,
          matchTime: Date.now(),
          timeSinceSignal: Date.now() - signal.firstSeen,
        });

        this.matched.set(token.ca, {
          keyword,
          signal,
          advantage: "FIRST_MOVER",
          timeSinceSignalHours: +((Date.now() - signal.firstSeen) / 3600_000).toFixed(1),
          sources: signal.sources.map(s => s.source),
        });

        return {
          matched: true,
          keyword,
          totalMentions: signal.totalMentions,
          sources: signal.sources.map(s => ({ source: s.source, mentions: s.mentions })),
          timeSinceSignalHours: +((Date.now() - signal.firstSeen) / 3600_000).toFixed(1),
          context: signal.context,
          scoreDelta: 12, // bonus for forward radar match
        };
      }
    }

    return null;
  }

  /**
   * Get all active forward radar signals for UI display.
   */
  getActiveSignals() {
    const now = Date.now();
    const active = [];

    for (const [keyword, signal] of this.signals) {
      // Skip expired signals
      if (now - signal.firstSeen > this.SIGNAL_TTL) continue;

      const crossover = signal.crossoverEstimate;
      active.push({
        keyword,
        totalMentions: signal.totalMentions,
        peakVelocity: signal.peakVelocity,
        sources: signal.sources.map(s => ({
          source: s.source,
          mentions: s.mentions,
          velocity: s.velocity,
        })),
        ageHours: +((now - signal.firstSeen) / 3600_000).toFixed(1),
        crossoverHoursRemaining: crossover?.hoursRemaining ? +crossover.hoursRemaining.toFixed(1) : null,
        confidence: crossover?.confidence || 0,
        context: signal.context,
        hasTokenMatch: signal.matchedTokens.length > 0,
      });
    }

    // Sort by velocity (hottest signals first)
    return active.sort((a, b) => b.peakVelocity - a.peakVelocity);
  }

  /**
   * Prune expired signals.
   */
  prune() {
    const cutoff = Date.now() - this.SIGNAL_TTL;
    for (const [key, signal] of this.signals) {
      if (signal.firstSeen < cutoff) this.signals.delete(key);
    }
  }
}

export { UPSTREAM_SOURCES };
export default ForwardRadar;
