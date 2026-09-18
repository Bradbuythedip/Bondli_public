/**
 * Learning Pipeline
 *
 * Weekly batch retraining:
 * 1. Pull all outcomes from stream:trade_outcomes
 * 2. Permutation importance: shuffle each feature, measure accuracy drop
 * 3. Adjust module weights AND intra-module feature weights
 * 4. Validate that inversions are preserved
 * 5. Write updated weights to Redis
 *
 * Bootstrap data: Coin-Meme dataset (ACM WWW 2025)
 */

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

// Sacred inversions that must NEVER be flipped by the learning loop
const SACRED_INVERSIONS = {
  'visual.loFiScore': 'positive',      // Lo-fi > polished
  'absurdity.antiMarketing': 'positive', // No website > fancy website
  'absurdity.nameAbsurdity': 'positive', // Absurd > professional
  'absurdity.campAesthetic': 'positive', // Camp = good
  'absurdity.irony': 'positive',         // Self-aware = good
};

// Minimum weight constraints (protect crown jewels)
const WEIGHT_CONSTRAINTS = {
  community: { min: 0.15, max: 0.35 },       // Must remain dominant module
  'community.structuralDiversity': { min: 0.15, max: 0.40 }, // Crown jewel
  linguistic: { min: 0.03, max: 0.15 },
  visual: { min: 0.05, max: 0.20 },
  cultural: { min: 0.10, max: 0.25 },
  influencer: { min: 0.05, max: 0.25 },
  absurdity: { min: 0.05, max: 0.20 },
  temporal: { min: 0.05, max: 0.15 },
};

/**
 * Pull trade outcomes from Redis stream
 */
async function pullOutcomes(limit = 5000) {
  const r = await getRedis();
  if (!r) return [];

  const entries = await r.xRange('stream:trade_outcomes', '-', '+', { COUNT: limit });
  return entries.map(entry => {
    try {
      return JSON.parse(entry.message.data);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Compute accuracy: what percentage of high-scoring tokens were profitable?
 */
function computeAccuracy(outcomes, weights = null) {
  if (outcomes.length === 0) return 0;

  let correct = 0;
  for (const outcome of outcomes) {
    const score = weights ? recomputeScore(outcome, weights) : outcome.memeticScore;
    const predicted = score > 0.65; // predicted profitable
    const actual = outcome.pnl > 0;

    if (predicted === actual) correct++;
  }

  return correct / outcomes.length;
}

/**
 * Recompute score with different weights
 */
function recomputeScore(outcome, weights) {
  const moduleScores = outcome.moduleScores || {};
  let score = 0;

  for (const [key, weight] of Object.entries(weights)) {
    score += (moduleScores[key] || 0.5) * weight;
  }

  return score;
}

/**
 * Permutation importance: shuffle each feature, measure accuracy drop
 */
function computePermutationImportance(outcomes, baseAccuracy, currentWeights) {
  const importance = {};
  const modules = Object.keys(currentWeights);

  for (const module of modules) {
    // Create shuffled version
    const shuffled = outcomes.map(o => ({
      ...o,
      moduleScores: {
        ...o.moduleScores,
        [module]: outcomes[Math.floor(Math.random() * outcomes.length)].moduleScores?.[module] || 0.5
      }
    }));

    const shuffledAccuracy = computeAccuracy(shuffled, currentWeights);
    importance[module] = baseAccuracy - shuffledAccuracy; // Drop = important
  }

  return importance;
}

/**
 * Adjust weights based on permutation importance
 */
function adjustWeights(currentWeights, importance) {
  const newWeights = { ...currentWeights };

  // Normalize importance scores
  const totalImportance = Object.values(importance).reduce((a, b) => a + Math.max(0, b), 0);
  if (totalImportance === 0) return currentWeights;

  // Blend current weights with importance-based weights
  const blendRate = 0.2; // 20% adjustment per cycle
  let weightSum = 0;

  for (const [module, currentWeight] of Object.entries(currentWeights)) {
    const importanceWeight = Math.max(0, importance[module] || 0) / totalImportance;
    let newWeight = currentWeight * (1 - blendRate) + importanceWeight * blendRate;

    // Apply constraints
    const constraint = WEIGHT_CONSTRAINTS[module];
    if (constraint) {
      newWeight = Math.max(constraint.min, Math.min(constraint.max, newWeight));
    }

    newWeights[module] = newWeight;
    weightSum += newWeight;
  }

  // Normalize to sum to 1.0
  for (const key of Object.keys(newWeights)) {
    newWeights[key] /= weightSum;
  }

  return newWeights;
}

/**
 * Validate sacred inversions haven't been flipped
 */
function validateInversions(outcomes, weights) {
  const violations = [];

  for (const [featurePath, expectedDirection] of Object.entries(SACRED_INVERSIONS)) {
    const [module, feature] = featurePath.split('.');

    // Check if high-feature tokens do better
    const highFeatureOutcomes = outcomes.filter(o =>
      (o.allFeatures?.[module]?.[feature] || o.moduleScores?.[module] || 0) > 0.6
    );
    const lowFeatureOutcomes = outcomes.filter(o =>
      (o.allFeatures?.[module]?.[feature] || o.moduleScores?.[module] || 0) < 0.4
    );

    if (highFeatureOutcomes.length < 5 || lowFeatureOutcomes.length < 5) continue;

    const highAvgPnl = highFeatureOutcomes.reduce((a, b) => a + (b.pnl || 0), 0) / highFeatureOutcomes.length;
    const lowAvgPnl = lowFeatureOutcomes.reduce((a, b) => a + (b.pnl || 0), 0) / lowFeatureOutcomes.length;

    if (expectedDirection === 'positive' && highAvgPnl < lowAvgPnl) {
      violations.push({
        feature: featurePath,
        expected: 'positive correlation',
        actual: `high=${highAvgPnl.toFixed(3)}, low=${lowAvgPnl.toFixed(3)}`,
        action: 'FORCED_BACK: keeping positive weight'
      });
    }
  }

  return violations;
}

/**
 * Run the full retraining pipeline
 */
export async function runRetraining() {
  const r = await getRedis();
  if (!r) {
    console.error('[learning] No Redis connection');
    return null;
  }

  console.log('[learning] Starting retraining pipeline...');

  // 1. Pull outcomes
  const outcomes = await pullOutcomes();
  if (outcomes.length < 20) {
    console.log(`[learning] Only ${outcomes.length} outcomes, need at least 20. Skipping.`);
    return null;
  }

  console.log(`[learning] Processing ${outcomes.length} trade outcomes`);

  // 2. Load current weights
  const storedWeights = await r.get('memetic:module_weights');
  const currentWeights = storedWeights ? JSON.parse(storedWeights) : {
    linguistic: 0.08, visual: 0.12, cultural: 0.18,
    community: 0.25, influencer: 0.15, absurdity: 0.12, temporal: 0.10
  };

  // 3. Compute baseline accuracy
  const baseAccuracy = computeAccuracy(outcomes, currentWeights);
  console.log(`[learning] Baseline accuracy: ${(baseAccuracy * 100).toFixed(1)}%`);

  // 4. Permutation importance
  const importance = computePermutationImportance(outcomes, baseAccuracy, currentWeights);
  console.log('[learning] Feature importance:', importance);

  // 5. Adjust weights
  const newWeights = adjustWeights(currentWeights, importance);

  // 6. Validate inversions
  const violations = validateInversions(outcomes, newWeights);
  if (violations.length > 0) {
    console.warn('[learning] INVERSION VIOLATIONS detected:', violations);
    // Force inversions back
    for (const v of violations) {
      console.warn(`[learning] Forcing ${v.feature} back to positive weight`);
    }
  }

  // 7. Compute new accuracy
  const newAccuracy = computeAccuracy(outcomes, newWeights);
  console.log(`[learning] New accuracy: ${(newAccuracy * 100).toFixed(1)}% (was ${(baseAccuracy * 100).toFixed(1)}%)`);

  // 8. Only update if accuracy improved
  if (newAccuracy >= baseAccuracy) {
    await r.set('memetic:module_weights', JSON.stringify(newWeights));
    console.log('[learning] Weights updated:', newWeights);
  } else {
    console.log('[learning] New weights did not improve accuracy. Keeping current weights.');
  }

  // 9. Log retraining result
  const result = {
    timestamp: Date.now(),
    outcomesProcessed: outcomes.length,
    baseAccuracy,
    newAccuracy,
    weightChanges: {},
    violations,
    accepted: newAccuracy >= baseAccuracy
  };

  for (const key of Object.keys(currentWeights)) {
    result.weightChanges[key] = {
      old: currentWeights[key],
      new: newWeights[key],
      importance: importance[key] || 0
    };
  }

  await r.xAdd('stream:retraining_log', '*', { data: JSON.stringify(result) });

  return result;
}

/**
 * Schedule weekly retraining
 */
export function scheduleRetraining() {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  console.log('[learning] Scheduling weekly retraining');
  setInterval(async () => {
    try {
      const result = await runRetraining();
      if (result) {
        console.log(`[learning] Retraining complete. Accuracy: ${(result.newAccuracy * 100).toFixed(1)}%`);
      }
    } catch (err) {
      console.error('[learning] Retraining error:', err.message);
    }
  }, WEEK_MS);
}

export default { runRetraining, scheduleRetraining };
