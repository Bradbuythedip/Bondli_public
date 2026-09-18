/**
 * ═══════════════════════════════════════════════════════════════
 * SURVIVORSHIP BIAS ENGINE — Kahneman-Inspired Meme Selection
 * ═══════════════════════════════════════════════════════════════
 *
 * Core insight (Kahneman, Thinking Fast and Slow):
 *   We are biased by survivors. Instead of fighting this bias,
 *   we WEAPONIZE it. Study what made winners WIN at the moment
 *   of their birth — then reject anything that doesn't match.
 *
 * Architecture:
 *   1. SURVIVOR ARCHIVE: stores feature snapshots of tokens at entry time
 *      that went on to graduate, hit 3x+, or generate positive PnL.
 *   2. DEAD ARCHIVE: stores feature snapshots of tokens that rugged,
 *      dumped, or we lost money on.
 *   3. SURVIVOR ARCHETYPE: a composite "ideal winner" built from the
 *      weighted average of all survivors, with dead-zone exclusion.
 *   4. SURVIVAL SCORE: cosine similarity of a new token to the survivor
 *      archetype, penalized by similarity to the dead archetype.
 *   5. DISCRIMINANT FEATURES: which features most separate winners from
 *      losers (Fisher's linear discriminant ratio per feature).
 *
 * The math:
 *   survivorScore = cos(newToken, survivorArchetype) - 0.5 * cos(newToken, deadArchetype)
 *   discriminantWeight[i] = (μ_survivor[i] - μ_dead[i])² / (σ_survivor[i]² + σ_dead[i]²)
 *
 * Integration:
 *   const sb = new SurvivorshipBias(redis);
 *   // On every trade outcome:
 *   sb.recordOutcome(ca, entryFeatures, { won: true, pnlPct: 45, graduated: true });
 *   // On every new token evaluation:
 *   const { survivalScore, matchPct, killSignals } = sb.evaluate(newTokenFeatures);
 *   // survivalScore > 0.3 = looks like a survivor
 *   // killSignals = features that strongly match dead tokens
 */

// Features that matter most for survivorship analysis
// These are the features we track from meme-intelligence.mjs
const SURVIVAL_FEATURES = [
  // On-chain velocity (the clearest separator)
  "oc_buyVelocity1m", "oc_buyVelocity5m", "oc_uniqueBuyers5m",
  "oc_giniCoeff", "oc_avgBuySol", "oc_devHoldPct", "oc_topHolderPct",
  "oc_sellRatio5m", "oc_mcapSol", "oc_volumeSol5m",
  // Rug signals (inverse — survivors have LOW rug scores)
  "rg_devSellSpeed", "rg_holderConcentration", "rg_coordDumpScore",
  "rg_liqRemovalSpeed", "rg_walletAgeScore", "rg_sellWaveDetect",
  "rg_mcapDropRate", "rg_buyerRetention", "rg_zeroSellFlag",
  "rg_buySellImbalance", "rg_fakeVolumeScore",
  // Chart patterns
  "ch_healthScore", "ch_pumpDump", "ch_smoothGrind", "ch_dipRatio", "ch_staircaseScore",
  // Cascade & viral signals
  "cs_cascadeOnset", "cs_cascadeStrength", "cs_reflexivity", "cs_curveVelocity",
  "cs_attentionShare",
  "sir_r0", "sir_infectRate", "sir_recoveryRate",
  // Graduation signals
  "gf_curveProgress", "gf_frontrunSignal",
  // Tipping point
  "tp_lawOfFew", "tp_stickiness", "tp_context",
  // Kahneman heuristics
  "k_cognitiveEase", "k_emotionalValence", "k_herdSignal", "k_lossAversion",
  // Attention divergence
  "apd_attentionGrowth", "apd_priceFlat", "apd_divergence",
];

const FEATURE_COUNT = SURVIVAL_FEATURES.length;

// ═══ SURVIVOR ARCHIVE ═══

class FeatureArchive {
  constructor(maxSize = 500) {
    this.entries = []; // [{ ca, features, outcome, timestamp, weight }]
    this.maxSize = maxSize;
    this._archetypeDirty = true;
    this._archetype = null;   // cached mean vector
    this._variance = null;    // cached variance vector
  }

  add(ca, features, outcome, weight = 1.0) {
    const vec = this._toVector(features);
    const existing = this.entries.findIndex(e => e.ca === ca);
    if (existing >= 0) {
      this.entries[existing] = { ca, vec, outcome, timestamp: Date.now(), weight };
    } else {
      this.entries.push({ ca, vec, outcome, timestamp: Date.now(), weight });
      if (this.entries.length > this.maxSize) this.entries.shift();
    }
    this._archetypeDirty = true;
  }

  // Weighted mean feature vector across all entries
  getArchetype() {
    if (!this._archetypeDirty && this._archetype) return this._archetype;
    if (this.entries.length === 0) return new Float64Array(FEATURE_COUNT);

    const mean = new Float64Array(FEATURE_COUNT);
    let totalWeight = 0;

    for (const entry of this.entries) {
      const w = entry.weight || 1.0;
      totalWeight += w;
      for (let i = 0; i < FEATURE_COUNT; i++) {
        mean[i] += (entry.vec[i] || 0) * w;
      }
    }

    if (totalWeight > 0) {
      for (let i = 0; i < FEATURE_COUNT; i++) mean[i] /= totalWeight;
    }

    this._archetype = mean;
    this._archetypeDirty = false;
    return mean;
  }

  // Variance per feature (for discriminant analysis)
  getVariance() {
    if (this._variance && !this._archetypeDirty) return this._variance;
    if (this.entries.length < 2) return new Float64Array(FEATURE_COUNT).fill(0.01);

    const mean = this.getArchetype();
    const variance = new Float64Array(FEATURE_COUNT);
    let totalWeight = 0;

    for (const entry of this.entries) {
      const w = entry.weight || 1.0;
      totalWeight += w;
      for (let i = 0; i < FEATURE_COUNT; i++) {
        const diff = (entry.vec[i] || 0) - mean[i];
        variance[i] += diff * diff * w;
      }
    }

    if (totalWeight > 0) {
      for (let i = 0; i < FEATURE_COUNT; i++) {
        variance[i] = variance[i] / totalWeight + 0.001; // floor to prevent div-by-zero
      }
    }

    this._variance = variance;
    return variance;
  }

  _toVector(features) {
    const vec = new Float64Array(FEATURE_COUNT);
    for (let i = 0; i < FEATURE_COUNT; i++) {
      vec[i] = features[SURVIVAL_FEATURES[i]] || 0;
    }
    return vec;
  }

  get size() { return this.entries.length; }

  export() {
    return this.entries.map(e => ({
      ca: e.ca,
      vec: Array.from(e.vec),
      outcome: e.outcome,
      timestamp: e.timestamp,
      weight: e.weight,
    }));
  }

  import(data) {
    if (!Array.isArray(data)) return;
    this.entries = data.map(e => ({
      ...e,
      vec: new Float64Array(e.vec || []),
    }));
    this._archetypeDirty = true;
  }
}


// ═══ SURVIVORSHIP BIAS ENGINE ═══

export class SurvivorshipBias {
  constructor(redis = null) {
    this.redis = redis;
    this.survivors = new FeatureArchive(500);     // all winning tokens
    this.dead = new FeatureArchive(500);          // losing tokens
    this.megaWinners = new FeatureArchive(200);   // 10x+ outlier tokens — the 0.01%
    this._discriminantWeights = null;             // Fisher's discriminant per feature
    this._discriminantDirty = true;
    this._minSurvivors = 5;  // need at least 5 survivors before applying filter
    this.stats = {
      totalRecorded: 0,
      survivorCount: 0,
      deadCount: 0,
      megaWinnerCount: 0,
      appliedCount: 0,
      filteredCount: 0,
      avgSurvivorScore: 0,
      avgDeadScore: 0,
    };
    this._restore();
  }

  // ─── RECORD A TRADE OUTCOME ───
  // Call this for every token we traded, with features at ENTRY TIME
  recordOutcome(ca, entryFeatures, outcome) {
    // outcome: { won: bool, pnlPct: number, graduated: bool, peakMcx: number }
    if (!entryFeatures || typeof entryFeatures !== "object") return;

    this.stats.totalRecorded++;

    // ═══ POWER-LAW WEIGHTING ═══
    // Meme returns follow Pareto distribution. The 5% of tokens that
    // become 10x+ runners generate >50% of total returns. We need the
    // survivor archetype to be DOMINATED by these outliers, not diluted
    // by marginal 5-10% winners. Weight = log2(1 + mcx) so:
    //   2x winner → weight 1.6    (modest influence)
    //   5x winner → weight 2.6    (strong influence)
    //   10x winner → weight 3.5   (dominates archetype)
    //   50x winner → weight 5.7   (mega outlier shapes the model)
    //   100x winner → weight 6.7  (legendary)
    const mcx = outcome.peakMcx || 1;

    if (outcome.won || outcome.pnlPct > 5 || outcome.graduated) {
      const weight = Math.max(1, Math.log2(1 + Math.max(mcx, 1 + outcome.pnlPct / 100)));
      this.survivors.add(ca, entryFeatures, outcome, weight);
      this.stats.survivorCount = this.survivors.size;

      // ── MEGA-WINNER ARCHIVE — separate archetype for 10x+ tokens ──
      // These are the outliers we're hunting. A dedicated archetype
      // prevents their signal from being diluted by marginal winners.
      if (mcx >= 10 || outcome.pnlPct >= 900) {
        const megaWeight = Math.log2(1 + mcx); // even more weight for bigger wins
        this.megaWinners.add(ca, entryFeatures, outcome, megaWeight);
        this.stats.megaWinnerCount = this.megaWinners.size;
      }
    } else {
      // DEAD: power-law on losses too — big rugs teach more
      const lossPct = Math.abs(outcome.pnlPct || 0);
      const weight = Math.max(1, 1 + lossPct / 50); // -50% → 2.0, -100% → 3.0
      this.dead.add(ca, entryFeatures, outcome, weight);
      this.stats.deadCount = this.dead.size;
    }

    this._discriminantDirty = true;
    this._persist();
  }

  // ─── EVALUATE A NEW TOKEN ───
  // Returns: { survivalScore, matchPct, deathMatchPct, netScore, killSignals, boostSignals, shouldApe, confidence }
  evaluate(features) {
    const result = {
      survivalScore: 0,
      matchPct: 0,
      deathMatchPct: 0,
      netScore: 0,
      killSignals: [],
      boostSignals: [],
      shouldApe: true,
      confidence: 0,
      survivorArchetypeSize: this.survivors.size,
      deadArchetypeSize: this.dead.size,
    };

    // Not enough data yet — pass everything through
    if (this.survivors.size < this._minSurvivors) {
      result.confidence = 0;
      return result;
    }

    const vec = this._toVector(features);
    const survivorArchetype = this.survivors.getArchetype();
    const deadArchetype = this.dead.getArchetype();

    // Cosine similarity to survivor archetype
    const survivorSim = this._cosineSim(vec, survivorArchetype);
    // Cosine similarity to dead archetype
    const deadSim = this.dead.size >= 3 ? this._cosineSim(vec, deadArchetype) : 0;

    // Net survival score: how much more does this look like a winner than a loser?
    // Range: roughly -1 to +1
    result.survivalScore = survivorSim - 0.5 * deadSim;
    result.matchPct = Math.round(survivorSim * 100);
    result.deathMatchPct = Math.round(deadSim * 100);
    result.netScore = Math.round(result.survivalScore * 100);

    // Confidence scales with archive size
    const archiveStrength = Math.min(1, this.survivors.size / 30);
    result.confidence = Math.round(archiveStrength * 100);

    // ─── DISCRIMINANT ANALYSIS ───
    // Which features most separate survivors from dead tokens?
    const disc = this._getDiscriminantWeights();
    const featureAnalysis = [];

    for (let i = 0; i < FEATURE_COUNT; i++) {
      const fname = SURVIVAL_FEATURES[i];
      const val = vec[i];
      const survMean = survivorArchetype[i];
      const deadMean = this.dead.size >= 3 ? deadArchetype[i] : 0;
      const dw = disc[i];

      // How far is this feature from the survivor mean vs dead mean?
      const distToSurvivor = Math.abs(val - survMean);
      const distToDead = this.dead.size >= 3 ? Math.abs(val - deadMean) : Infinity;

      featureAnalysis.push({
        name: fname,
        value: val,
        survivorMean: survMean,
        deadMean,
        discriminantPower: dw,
        closerToDead: distToDead < distToSurvivor && dw > 0.1,
        closerToSurvivor: distToSurvivor < distToDead && dw > 0.1,
      });
    }

    // Kill signals: features where this token looks more like dead tokens
    // AND the feature has high discriminant power (actually matters)
    result.killSignals = featureAnalysis
      .filter(f => f.closerToDead && f.discriminantPower > 0.15)
      .sort((a, b) => b.discriminantPower - a.discriminantPower)
      .slice(0, 5)
      .map(f => ({
        feature: f.name,
        value: +f.value.toFixed(3),
        survivorExpected: +f.survivorMean.toFixed(3),
        deadTypical: +f.deadMean.toFixed(3),
        importance: +f.discriminantPower.toFixed(3),
      }));

    // Boost signals: features where this token looks like survivors
    result.boostSignals = featureAnalysis
      .filter(f => f.closerToSurvivor && f.discriminantPower > 0.15)
      .sort((a, b) => b.discriminantPower - a.discriminantPower)
      .slice(0, 5)
      .map(f => ({
        feature: f.name,
        value: +f.value.toFixed(3),
        survivorExpected: +f.survivorMean.toFixed(3),
        importance: +f.discriminantPower.toFixed(3),
      }));

    // ── MEGA-WINNER SIMILARITY — does this look like a 10x+ outlier? ──
    result.megaMatchPct = 0;
    result.isMegaCandidate = false;
    if (this.megaWinners.size >= 3) {
      const megaArchetype = this.megaWinners.getArchetype();
      const megaSim = this._cosineSim(vec, megaArchetype);
      result.megaMatchPct = Math.round(megaSim * 100);
      // If this looks ≥60% like a mega-winner, it's a potential outlier
      if (megaSim >= 0.6) {
        result.isMegaCandidate = true;
        // Boost the survival score — outlier signal overrides marginal survivor data
        result.survivalScore += megaSim * 0.3;
        result.netScore = Math.round(result.survivalScore * 100);
      }
    }

    // ─── DECISION ───
    // Should we ape? Apply survival filter only when confident enough
    if (result.confidence > 30) {
      // Hard kill: very similar to dead archetype AND dissimilar to survivors
      if (result.survivalScore < -0.1 && deadSim > 0.7) {
        result.shouldApe = false;
      }
      // Soft kill: has 3+ high-power kill signals
      if (result.killSignals.length >= 3) {
        const totalKillPower = result.killSignals.reduce((s, k) => s + k.importance, 0);
        if (totalKillPower > 0.8) {
          result.shouldApe = false;
        }
      }
      // Strong survivor match overrides soft kills
      if (survivorSim > 0.8 && result.boostSignals.length >= 3) {
        result.shouldApe = true;
      }
      // MEGA-WINNER OVERRIDE: if it looks like a 10x+, NEVER kill it
      if (result.isMegaCandidate) {
        result.shouldApe = true;
      }
    }

    this.stats.appliedCount++;
    if (!result.shouldApe) this.stats.filteredCount++;

    return result;
  }

  // ─── COMPUTE APE SCORE ADJUSTMENT ───
  // Returns a score modifier (-20 to +20) to add to the existing ape score
  getScoreAdjustment(features) {
    const eval_ = this.evaluate(features);
    if (eval_.confidence < 20) return { adjustment: 0, eval: eval_ };

    // Scale adjustment by confidence and net score
    const confidenceScale = eval_.confidence / 100;
    // netScore range: roughly -100 to +100
    // We want adjustment range: -20 to +20
    let adjustment = Math.round(eval_.netScore * 0.2 * confidenceScale);

    // MEGA-WINNER BONUS: if this token matches the outlier archetype, big boost
    // This is the key to finding the 0.01% — outlier similarity is the strongest signal
    if (eval_.isMegaCandidate) {
      const megaBonus = Math.round((eval_.megaMatchPct - 50) * 0.3); // 60% match → +3, 80% → +9, 95% → +14
      adjustment += megaBonus;
    }

    adjustment = Math.max(-20, Math.min(25, adjustment)); // allow up to +25 for mega candidates

    return { adjustment, eval: eval_ };
  }

  // ─── FISHER'S LINEAR DISCRIMINANT ───
  // Identifies which features best separate survivors from dead tokens
  _getDiscriminantWeights() {
    if (!this._discriminantDirty && this._discriminantWeights) return this._discriminantWeights;

    const weights = new Float64Array(FEATURE_COUNT);

    if (this.survivors.size < 3 || this.dead.size < 3) {
      this._discriminantWeights = weights;
      return weights;
    }

    const survMean = this.survivors.getArchetype();
    const deadMean = this.dead.getArchetype();
    const survVar = this.survivors.getVariance();
    const deadVar = this.dead.getVariance();

    // Fisher's ratio: (μ1 - μ2)² / (σ1² + σ2²)
    // Higher = better separator between classes
    for (let i = 0; i < FEATURE_COUNT; i++) {
      const meanDiff = survMean[i] - deadMean[i];
      const pooledVar = survVar[i] + deadVar[i];
      weights[i] = pooledVar > 0.001 ? (meanDiff * meanDiff) / pooledVar : 0;
    }

    // Normalize to 0-1 range
    let maxW = 0;
    for (let i = 0; i < FEATURE_COUNT; i++) {
      if (weights[i] > maxW) maxW = weights[i];
    }
    if (maxW > 0) {
      for (let i = 0; i < FEATURE_COUNT; i++) weights[i] /= maxW;
    }

    this._discriminantWeights = weights;
    this._discriminantDirty = false;
    return weights;
  }

  // ─── GET TOP DISCRIMINANT FEATURES ───
  // Shows which features most separate winners from losers
  getTopDiscriminants(n = 10) {
    const disc = this._getDiscriminantWeights();
    const survMean = this.survivors.getArchetype();
    const deadMean = this.dead.size >= 3 ? this.dead.getArchetype() : new Float64Array(FEATURE_COUNT);

    const ranked = [];
    for (let i = 0; i < FEATURE_COUNT; i++) {
      ranked.push({
        feature: SURVIVAL_FEATURES[i],
        power: +disc[i].toFixed(4),
        survivorMean: +survMean[i].toFixed(4),
        deadMean: +deadMean[i].toFixed(4),
        direction: survMean[i] > deadMean[i] ? "higher_wins" : "lower_wins",
      });
    }

    return ranked.sort((a, b) => b.power - a.power).slice(0, n);
  }

  // ─── GET SURVIVOR PROFILE ───
  // Human-readable summary of what winners look like
  getSurvivorProfile() {
    if (this.survivors.size < this._minSurvivors) {
      return { ready: false, message: `Need ${this._minSurvivors - this.survivors.size} more winners to build profile` };
    }

    const archetype = this.survivors.getArchetype();
    const disc = this._getDiscriminantWeights();
    const topFeatures = this.getTopDiscriminants(15);

    // Build narrative profile
    const profile = {
      ready: true,
      sampleSize: this.survivors.size,
      deadSampleSize: this.dead.size,
      topDiscriminants: topFeatures,
      // Summary stats
      typicalSurvivor: {},
      typicalDead: {},
      // Key insights in plain language
      insights: [],
    };

    // Build typed feature ranges for the archetype
    for (let i = 0; i < FEATURE_COUNT; i++) {
      const fname = SURVIVAL_FEATURES[i];
      profile.typicalSurvivor[fname] = +archetype[i].toFixed(4);
    }
    if (this.dead.size >= 3) {
      const deadArch = this.dead.getArchetype();
      for (let i = 0; i < FEATURE_COUNT; i++) {
        profile.typicalDead[SURVIVAL_FEATURES[i]] = +deadArch[i].toFixed(4);
      }
    }

    // Generate plain-language insights from top discriminants
    for (const d of topFeatures.slice(0, 8)) {
      if (d.power < 0.1) continue;
      const insight = this._featureInsight(d.feature, d.survivorMean, d.deadMean, d.direction);
      if (insight) profile.insights.push(insight);
    }

    return profile;
  }

  _featureInsight(feature, survVal, deadVal, direction) {
    const labels = {
      "oc_buyVelocity5m": { name: "Buy velocity (5m)", unit: "/min" },
      "oc_uniqueBuyers5m": { name: "Unique buyers (5m)", unit: "" },
      "oc_giniCoeff": { name: "Buy size equality", unit: "" },
      "oc_avgBuySol": { name: "Avg buy size", unit: " SOL" },
      "oc_devHoldPct": { name: "Dev hold %", unit: "%" },
      "oc_topHolderPct": { name: "Top holder %", unit: "%" },
      "oc_sellRatio5m": { name: "Sell ratio (5m)", unit: "" },
      "rg_buyerRetention": { name: "Buyer retention", unit: "" },
      "rg_holderConcentration": { name: "Holder concentration", unit: "" },
      "rg_zeroSellFlag": { name: "Zero sell flag", unit: "" },
      "rg_fakeVolumeScore": { name: "Fake volume", unit: "" },
      "ch_healthScore": { name: "Chart health", unit: "" },
      "ch_smoothGrind": { name: "Smooth grind (fake)", unit: "" },
      "ch_dipRatio": { name: "Natural dips", unit: "" },
      "cs_cascadeOnset": { name: "Buy cascade", unit: "" },
      "cs_reflexivity": { name: "Reflexivity loop", unit: "" },
      "sir_r0": { name: "Viral R0", unit: "" },
      "sir_infectRate": { name: "New buyer rate", unit: "" },
      "k_cognitiveEase": { name: "Name memorability", unit: "" },
      "tp_stickiness": { name: "Meme stickiness", unit: "" },
      "gf_curveProgress": { name: "Curve progress", unit: "%" },
      "apd_divergence": { name: "Attention-price gap", unit: "" },
    };

    const label = labels[feature];
    if (!label) return `${feature}: survivors=${survVal.toFixed(3)} dead=${deadVal.toFixed(3)} (${direction})`;

    const sv = (survVal * 100).toFixed(0);
    const dv = (deadVal * 100).toFixed(0);

    if (direction === "higher_wins") {
      return `Winners have HIGHER ${label.name}: ${sv}% vs losers ${dv}%`;
    } else {
      return `Winners have LOWER ${label.name}: ${sv}% vs losers ${dv}%`;
    }
  }

  // ─── GET FULL STATS ───
  getStats() {
    return {
      ...this.stats,
      survivorArchetypeReady: this.survivors.size >= this._minSurvivors,
      deadArchetypeReady: this.dead.size >= 3,
      megaWinnerArchetypeReady: this.megaWinners.size >= 3,
      megaWinnerCount: this.megaWinners.size,
      topDiscriminants: this.getTopDiscriminants(5),
      filterRate: this.stats.appliedCount > 0
        ? +(this.stats.filteredCount / this.stats.appliedCount * 100).toFixed(1) + "%"
        : "N/A",
    };
  }

  // ─── PERSISTENCE ───
  async _persist() {
    if (!this.redis) return;
    try {
      const data = {
        survivors: this.survivors.export(),
        dead: this.dead.export(),
        megaWinners: this.megaWinners.export(),
        stats: this.stats,
      };
      await this.redis.set("survivorship:data", JSON.stringify(data), { EX: 604800 }); // 7 day TTL
    } catch (e) {
      console.error("[SURVIVORSHIP] Persist error:", e.message);
    }
  }

  async _restore() {
    if (!this.redis) return;
    try {
      const raw = await this.redis.get("survivorship:data");
      if (raw) {
        const data = JSON.parse(raw);
        if (data.survivors) this.survivors.import(data.survivors);
        if (data.dead) this.dead.import(data.dead);
        if (data.megaWinners) this.megaWinners.import(data.megaWinners);
        if (data.stats) this.stats = { ...this.stats, ...data.stats };
        console.log(`[SURVIVORSHIP] Restored: ${this.survivors.size} survivors, ${this.dead.size} dead, ${this.megaWinners.size} mega-winners`);
      }
    } catch (e) {
      console.error("[SURVIVORSHIP] Restore error:", e.message);
    }
  }

  // ─── UTILITIES ───
  _toVector(features) {
    const vec = new Float64Array(FEATURE_COUNT);
    for (let i = 0; i < FEATURE_COUNT; i++) {
      vec[i] = features[SURVIVAL_FEATURES[i]] || 0;
    }
    return vec;
  }

  _cosineSim(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < FEATURE_COUNT; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom > 0 ? dot / denom : 0;
  }
}

export { SURVIVAL_FEATURES };
export default SurvivorshipBias;
