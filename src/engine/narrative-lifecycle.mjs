// BONDLI — Narrative Lifecycle Tracker
//
// Extends meta-engine.mjs with lifecycle staging per narrative.
// Entering an exhausted narrative = throwing money away.
//
// LIFECYCLE STAGES:
//   EMERGING:    <5 tokens, first movers still accumulating → HIGH alpha
//   GROWING:     5-20 tokens, gaining CT attention → GOOD alpha, selective
//   PEAK:        20-50 tokens, everyone talking → LOW alpha, exceptional only
//   EXHAUSTION:  50+ tokens, CT fatigued → NEGATIVE alpha, do not enter
//   NOSTALGIA:   Months later, ironic revival → MODERATE alpha if caught early

const STAGES = {
  EMERGING: {
    id: "EMERGING",
    label: "Emerging",
    color: "#00ff88",
    alphaLevel: "HIGH",
    entryAdvice: "Enter aggressively on quality tokens. First mover advantage.",
    scoreDelta: 15,
  },
  GROWING: {
    id: "GROWING",
    label: "Growing",
    color: "#44aaff",
    alphaLevel: "GOOD",
    entryAdvice: "Enter selectively. First movers starting to take profit.",
    scoreDelta: 8,
  },
  PEAK: {
    id: "PEAK",
    label: "Peak",
    color: "#ffaa00",
    alphaLevel: "LOW",
    entryAdvice: "Only enter exceptional quality. Most new entries = exit liquidity.",
    scoreDelta: -5,
  },
  EXHAUSTION: {
    id: "EXHAUSTION",
    label: "Exhaustion",
    color: "#ff4444",
    alphaLevel: "NEGATIVE",
    entryAdvice: "Do not enter regardless of individual token quality.",
    scoreDelta: -20,
  },
  NOSTALGIA: {
    id: "NOSTALGIA",
    label: "Nostalgia",
    color: "#cc44cc",
    alphaLevel: "MODERATE",
    entryAdvice: "Watch for meta-commentary tokens. Revival play if caught early.",
    scoreDelta: 5,
  },
};

export class NarrativeLifecycleTracker {
  constructor() {
    // narrative_id → { tokens: Set, firstSeen, lastSeen, launches: [timestamps], gradRate, sentiment }
    this.narratives = new Map();
    this.DECAY_WINDOW = 7 * 24 * 3600_000;  // 7 days for lifecycle tracking
    this.NOSTALGIA_GAP = 30 * 24 * 3600_000; // 30 days silence = potential nostalgia play
  }

  /**
   * Record a token launch in a narrative.
   */
  recordLaunch(narrativeId, tokenCa, timestamp = Date.now()) {
    if (!this.narratives.has(narrativeId)) {
      this.narratives.set(narrativeId, {
        tokens: new Set(),
        firstSeen: timestamp,
        lastSeen: timestamp,
        launches: [],
        graduations: 0,
        totalLaunches: 0,
        sentiment: 0, // -1 to 1
      });
    }

    const narr = this.narratives.get(narrativeId);
    narr.tokens.add(tokenCa);
    narr.lastSeen = timestamp;
    narr.launches.push(timestamp);
    narr.totalLaunches++;

    // Keep last 200 launch timestamps
    if (narr.launches.length > 200) narr.launches.shift();
  }

  /**
   * Record a graduation (token reached bonding curve completion).
   */
  recordGraduation(narrativeId) {
    const narr = this.narratives.get(narrativeId);
    if (narr) narr.graduations++;
  }

  /**
   * Update sentiment for a narrative (from social monitors).
   * sentiment: -1 (fatigue/negative) to 1 (excitement/positive)
   */
  updateSentiment(narrativeId, sentiment) {
    const narr = this.narratives.get(narrativeId);
    if (narr) {
      // EMA smoothing
      narr.sentiment = narr.sentiment * 0.7 + sentiment * 0.3;
    }
  }

  /**
   * Classify lifecycle stage for a narrative.
   */
  getStage(narrativeId) {
    const narr = this.narratives.get(narrativeId);
    if (!narr) return { stage: STAGES.EMERGING, tokenCount: 0, reason: "No data" };

    const now = Date.now();
    const tokenCount = narr.tokens.size;
    const ageMs = now - narr.firstSeen;
    const ageDays = ageMs / (24 * 3600_000);
    const silenceMs = now - narr.lastSeen;
    const silenceDays = silenceMs / (24 * 3600_000);

    // Recent launch velocity (launches per hour in last 6h)
    const cutoff6h = now - 6 * 3600_000;
    const recentLaunches = narr.launches.filter(t => t > cutoff6h).length;
    const launchVelocity = recentLaunches / 6; // per hour

    // Graduation rate
    const gradRate = narr.totalLaunches > 0 ? (narr.graduations / narr.totalLaunches) * 100 : 0;

    // Nostalgia check: was hot, went silent for 30+ days, now reviving
    if (tokenCount > 20 && silenceDays > 30 && recentLaunches > 0) {
      return {
        stage: STAGES.NOSTALGIA,
        tokenCount,
        launchVelocity,
        gradRate,
        ageDays: +ageDays.toFixed(1),
        silenceDays: +silenceDays.toFixed(1),
        sentiment: narr.sentiment,
        reason: `Revival after ${Math.round(silenceDays)} days of silence.`,
      };
    }

    // Active lifecycle classification
    let stage;
    if (tokenCount < 5) {
      stage = STAGES.EMERGING;
    } else if (tokenCount < 20) {
      stage = STAGES.GROWING;
    } else if (tokenCount < 50) {
      // Check if actually at peak or already exhausting
      if (launchVelocity > 3 || narr.sentiment > 0.3) {
        stage = STAGES.PEAK;
      } else if (narr.sentiment < -0.2 || gradRate < 0.5) {
        stage = STAGES.EXHAUSTION;
      } else {
        stage = STAGES.PEAK;
      }
    } else {
      // 50+ tokens — almost always exhaustion
      if (narr.sentiment > 0.5 && launchVelocity > 5) {
        stage = STAGES.PEAK; // still hot despite saturation
      } else {
        stage = STAGES.EXHAUSTION;
      }
    }

    // Decay: if no new launches in 24h, push toward exhaustion
    if (silenceMs > 24 * 3600_000 && stage.id !== "EMERGING") {
      if (stage.id === "GROWING" || stage.id === "PEAK") {
        stage = STAGES.EXHAUSTION;
      }
    }

    return {
      stage,
      tokenCount,
      launchVelocity: +launchVelocity.toFixed(2),
      gradRate: +gradRate.toFixed(1),
      ageDays: +ageDays.toFixed(1),
      silenceDays: +silenceDays.toFixed(1),
      sentiment: +narr.sentiment.toFixed(2),
      reason: `${stage.label}: ${tokenCount} tokens, ${launchVelocity.toFixed(1)}/hr launch rate, ${gradRate.toFixed(1)}% grad rate.`,
    };
  }

  /**
   * Get lifecycle stages for all tracked narratives.
   */
  getAllStages() {
    const results = [];
    for (const [id] of this.narratives) {
      results.push({ narrativeId: id, ...this.getStage(id) });
    }
    return results.sort((a, b) => b.tokenCount - a.tokenCount);
  }

  /**
   * Get score delta for a token based on its narrative lifecycle.
   * Use in auto-ape scoring.
   */
  getScoreDelta(narrativeId) {
    const { stage } = this.getStage(narrativeId);
    return stage.scoreDelta;
  }
}

export { STAGES };
export default NarrativeLifecycleTracker;
