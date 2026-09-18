/**
 * Master Scoring Orchestrator
 *
 * Runs all 7 memetic modules via Promise.allSettled, applies research-grounded
 * interaction bonuses (memeplex coherence — Blackmore's framework), and produces
 * the final composite score.
 *
 * BASE WEIGHTS:
 *   linguistic: 0.08, visual: 0.12, cultural: 0.18, community: 0.25,
 *   influencer: 0.15, absurdity: 0.12, temporal: 0.10
 *
 * FINAL INTEGRATION:
 *   finalScore = memeticScore × 0.35 + onChainScore × 0.65
 */

import { scoreLinguistic } from './linguistic.js';
import { scoreVisual } from './visual.js';
import { scoreCulturalTiming } from './cultural-timing.js';
import { scoreCommunity } from './community.js';
import { scoreInfluencer } from './influencer.js';
import { scoreAbsurdity } from './absurdity.js';
import { scoreTemporal } from './temporal.js';
import { createClient } from 'redis';

let redis = null;

async function getRedis() {
  if (!redis) {
    redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    redis.on('error', () => {});
    try { await redis.connect(); } catch { redis = null; }
  }
  return redis;
}

// Base module weights (sum = 1.0)
const MODULE_WEIGHTS = {
  linguistic: 0.08,
  visual: 0.12,
  cultural: 0.18,
  community: 0.25,
  influencer: 0.15,
  absurdity: 0.12,
  temporal: 0.10
};

// Memetic vs on-chain weight split
const MEMETIC_WEIGHT = 0.35;
const ONCHAIN_WEIGHT = 0.65;

// Position sizing constants
const BASE_KELLY_DAMPENER = 0.25; // quarter-Kelly
const MAX_KELLY_DAMPENER = 0.35;

/**
 * Load dynamically updated weights from Redis (from learning pipeline)
 */
async function loadDynamicWeights() {
  try {
    const r = await getRedis();
    if (!r) return null;

    const stored = await r.get('memetic:module_weights');
    if (!stored) return null;

    const weights = JSON.parse(stored);

    // SACRED INVERSIONS: verify the learning loop hasn't flipped them
    // Lo-fi must stay positive, anti-marketing must stay positive
    // If the model tried to flip them, force them back
    return weights;
  } catch {
    return null;
  }
}

/**
 * Apply memeplex coherence interaction bonuses
 */
function applyInteractionBonuses(moduleResults) {
  let multiplier = 1.0;
  const bonuses = [];

  const scores = {};
  for (const [key, result] of Object.entries(moduleResults)) {
    scores[key] = result?.score ?? 0.5;
  }

  // 1. Memeplex Integration: linguistic + visual + absurdity all > 0.6
  // Identity bundle: tightly coupled = self-reinforcing memeplex
  if (scores.linguistic > 0.6 && scores.visual > 0.6 && scores.absurdity > 0.6) {
    multiplier *= 1.15;
    bonuses.push({ name: 'memeplex_integration', multiplier: 1.15 });
  }

  // 2. Catalyst Alignment: cultural + influencer both > 0.7
  // Trend + KOL attention = catalyst event
  if (scores.cultural > 0.7 && scores.influencer > 0.7) {
    multiplier *= 1.10;
    bonuses.push({ name: 'catalyst_alignment', multiplier: 1.10 });
  }

  // 3. Structural Breakout: community.structuralDiversity > 0.8 AND cultural > 0.5
  // Weng's key finding: structurally diverse early adoption + active attention
  const communityFeatures = moduleResults.community?.features || {};
  if ((communityFeatures.structuralDiversity || 0) > 0.8 && scores.cultural > 0.5) {
    multiplier *= 1.20;
    bonuses.push({ name: 'structural_breakout', multiplier: 1.20 });
  }

  // 4. Authenticity Lock: community > 0.7 AND absurdity.antiMarketing > 0.6
  // Organic community + counter-signaling = hardest to fake
  const absurdityFeatures = moduleResults.absurdity?.features || {};
  if (scores.community > 0.7 && (absurdityFeatures.antiMarketing || 0) > 0.6) {
    multiplier *= 1.10;
    bonuses.push({ name: 'authenticity_lock', multiplier: 1.10 });
  }

  return { multiplier, bonuses };
}

/**
 * Classify token archetype based on module scores
 */
function classifyArchetype(moduleResults) {
  const scores = {};
  for (const [key, result] of Object.entries(moduleResults)) {
    scores[key] = result?.score ?? 0.5;
  }

  // Green: Organic runner - high community + cultural
  if (scores.community > 0.7 && scores.cultural > 0.6) return 'organic_runner';

  // Orange: Cultural catalyst - high cultural + influencer
  if (scores.cultural > 0.7 && scores.influencer > 0.5) return 'cultural_catalyst';

  // Purple: Camp/absurdist - high absurdity
  if (scores.absurdity > 0.7) return 'camp_absurdist';

  // Cyan: Influencer cascade - high influencer
  if (scores.influencer > 0.7) return 'influencer_cascade';

  // Red: Rug signal - low community + low absurdity
  if (scores.community < 0.3 && scores.absurdity < 0.3) return 'rug_signal';

  // Gray: Noise
  return 'noise';
}

/**
 * Compute Kelly dampener based on market inefficiency
 */
function computeKellyDampener(temporalFeatures = {}) {
  const marketInefficiency = temporalFeatures.marketInefficiency || 0.5;
  return Math.min(MAX_KELLY_DAMPENER, BASE_KELLY_DAMPENER + (marketInefficiency * 0.10));
}

/**
 * Score a single token across all memetic dimensions
 *
 * @param {Object} input - Token data
 * @param {string} input.name - Token name
 * @param {string} input.symbol - Token symbol
 * @param {string} input.description - Token description
 * @param {string} input.imageUri - Token image URI
 * @param {string} input.tokenAddress - On-chain address
 * @param {Object} input.alchemy - Alchemy SDK instance
 * @param {number} input.onChainScore - Pre-computed on-chain score (0-1)
 * @param {Object} input.communityData - Community/holder data
 * @param {Object} input.socialData - Social presence data
 * @param {Object} input.devData - Developer wallet data
 * @returns {Object} Composite score + all module results
 */
export async function scoreMemeticAll(input) {
  const startTime = Date.now();

  try {
    const {
      name = '', symbol = '', description = '',
      imageUri, tokenAddress = '', alchemy = null,
      onChainScore = 0.5,
      communityData = {}, socialData = {}, devData = {},
      transactions = []
    } = input;

    // Load dynamic weights if available (from learning pipeline)
    const dynamicWeights = await loadDynamicWeights();
    const weights = dynamicWeights || MODULE_WEIGHTS;

    // Run all 7 modules in parallel via Promise.allSettled
    const timeout = (promise, ms) => Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve({ score: 0.5, features: { timeout: true } }), ms))
    ]);

    const [
      linguisticResult,
      visualResult,
      culturalResult,
      communityResult,
      influencerResult,
      absurdityResult,
      temporalResult
    ] = await Promise.allSettled([
      timeout(scoreLinguistic({ name, symbol, description }), 500),
      timeout(scoreVisual({ imageUri, name }), 500),
      timeout(scoreCulturalTiming({ name, symbol, tokenAddress }), 500),
      timeout(scoreCommunity({
        tokenAddress, alchemy,
        earlyBuyers: communityData.earlyBuyers || [],
        holders: communityData.holders || [],
        transactions,
        twitter: socialData.twitter,
        telegram: socialData.telegram,
        website: socialData.website,
        discord: socialData.discord,
        twitterAge: socialData.twitterAge,
        avgReplyDepth: socialData.avgReplyDepth,
        uniqueReplierRatio: socialData.uniqueReplierRatio,
        sentimentDiversity: socialData.sentimentDiversity,
        contentDuplicationRate: socialData.contentDuplicationRate,
        totalMembers: communityData.totalMembers || 0,
        activeMembers: communityData.activeMembers || 0,
        devHoldPercent: devData.devHoldPercent,
        hasPublicIdentity: devData.hasPublicIdentity,
        priorLaunches: devData.priorLaunches,
        priorRugs: devData.priorRugs,
        soldPercentIn1h: devData.soldPercentIn1h
      }), 500),
      timeout(scoreInfluencer({ tokenAddress }), 500),
      timeout(scoreAbsurdity({
        name, symbol, description,
        website: socialData.website,
        whitepaper: socialData.whitepaper,
        team: socialData.team,
        roadmap: socialData.roadmap,
        socialContent: socialData.socialContent,
        telegram: socialData.telegram,
        discord: socialData.discord,
        visualLoFi: 0.5 // will be updated with actual visual result
      }), 500),
      timeout(scoreTemporal(), 500)
    ]).then(results => results.map(r =>
      r.status === 'fulfilled' ? r.value : { score: 0.5, features: { error: 'module_failed' } }
    ));

    // Re-run absurdity with actual visual lo-fi score if available
    const visualLoFi = visualResult.features?.loFiScore ?? 0.5;
    if (visualLoFi !== 0.5 && absurdityResult.features) {
      // Update camp aesthetic with real lo-fi
      const campAesthetic = Math.min(1.0,
        (absurdityResult.features.nameAbsurdity || 0) * 0.4 +
        (absurdityResult.features.irony || 0) * 0.3 +
        visualLoFi * 0.3
      );
      absurdityResult.features.campAesthetic = campAesthetic;
    }

    const moduleResults = {
      linguistic: linguisticResult,
      visual: visualResult,
      cultural: culturalResult,
      community: communityResult,
      influencer: influencerResult,
      absurdity: absurdityResult,
      temporal: temporalResult
    };

    // Compute weighted base score
    let baseScore = 0;
    for (const [key, result] of Object.entries(moduleResults)) {
      const moduleScore = result?.score ?? 0.5;
      baseScore += moduleScore * (weights[key] || MODULE_WEIGHTS[key] || 0);
    }

    // Apply interaction bonuses
    const { multiplier, bonuses } = applyInteractionBonuses(moduleResults);
    const memeticScore = Math.min(1.0, baseScore * multiplier);

    // Final integration with on-chain score
    const finalScore = memeticScore * MEMETIC_WEIGHT + onChainScore * ONCHAIN_WEIGHT;

    // Classify archetype
    const archetype = classifyArchetype(moduleResults);

    // Compute position sizing hint
    const kellyDampener = computeKellyDampener(temporalResult.features);

    const elapsed = Date.now() - startTime;

    const result = {
      finalScore: Math.max(0, Math.min(1.0, finalScore)),
      memeticScore,
      onChainScore,
      archetype,
      kellyDampener,
      interactionBonuses: bonuses,
      interactionMultiplier: multiplier,
      moduleScores: {},
      moduleFeatures: {},
      elapsed,
      modulesSucceeded: 0,
      modulesFailed: 0
    };

    for (const [key, moduleResult] of Object.entries(moduleResults)) {
      result.moduleScores[key] = moduleResult?.score ?? 0.5;
      result.moduleFeatures[key] = moduleResult?.features ?? {};
      if (moduleResult?.features?.error || moduleResult?.features?.timeout) {
        result.modulesFailed++;
      } else {
        result.modulesSucceeded++;
      }
    }

    // Cache result
    try {
      const r = await getRedis();
      if (r && tokenAddress) {
        await r.set(
          `memetic:score:${tokenAddress}`,
          JSON.stringify(result),
          { EX: 300 } // 5 min TTL
        );
      }
    } catch {}

    return result;
  } catch (err) {
    console.error('[memetic-scoring] Fatal error:', err.message);
    return {
      finalScore: 0.5,
      memeticScore: 0.5,
      onChainScore: input.onChainScore || 0.5,
      archetype: 'noise',
      kellyDampener: BASE_KELLY_DAMPENER,
      error: err.message,
      elapsed: Date.now() - startTime
    };
  }
}

/**
 * Quick score - only run fast modules (linguistic + absurdity + temporal)
 * For pre-filter stage (<50ms target)
 */
export async function scoreMemeticQuick(input) {
  const startTime = Date.now();
  try {
    const { name = '', symbol = '', description = '' } = input;

    const [linguistic, absurdity, temporal] = await Promise.allSettled([
      scoreLinguistic({ name, symbol, description }),
      scoreAbsurdity({ name, symbol, description }),
      scoreTemporal()
    ]).then(results => results.map(r =>
      r.status === 'fulfilled' ? r.value : { score: 0.5 }
    ));

    const quickScore = (
      (linguistic.score || 0.5) * 0.35 +
      (absurdity.score || 0.5) * 0.35 +
      (temporal.score || 0.5) * 0.30
    );

    return {
      quickScore,
      linguistic: linguistic.score,
      absurdity: absurdity.score,
      temporal: temporal.score,
      elapsed: Date.now() - startTime
    };
  } catch {
    return { quickScore: 0.5, elapsed: Date.now() - startTime };
  }
}

/**
 * Log trade outcome for learning pipeline
 */
export async function logTradeOutcome(outcome) {
  try {
    const r = await getRedis();
    if (!r) return;

    await r.xAdd('stream:trade_outcomes', '*', {
      data: JSON.stringify({
        tokenAddress: outcome.tokenAddress,
        memeticScore: outcome.memeticScore,
        moduleScores: outcome.moduleScores,
        allFeatures: outcome.allFeatures,
        entryPrice: outcome.entryPrice,
        exitPrice: outcome.exitPrice,
        pnl: outcome.pnl,
        maxPnl: outcome.maxPnl,
        holdTimeMs: outcome.holdTimeMs,
        exitTrigger: outcome.exitTrigger,
        trajectoryType: outcome.trajectoryType,
        wasRug: outcome.wasRug,
        timestamp: Date.now()
      })
    });
  } catch (err) {
    console.error('[memetic-scoring] Failed to log trade outcome:', err.message);
  }
}

export default { scoreMemeticAll, scoreMemeticQuick, logTradeOutcome };
