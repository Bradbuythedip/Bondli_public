/**
 * Module 5: Influencer Cascade
 *
 * KOL mention propagation: micro (5K-20K) discover first → ~6h lag → mid-tier (20K-100K)
 * amplifies → top-tier (100K+) creates FOMO cascades (30-50% price jumps).
 *
 * DexCheck tracks 542+ influencers. CoinDesk: KOLs receive pre-launch allocations.
 *
 * Target: real-time via background worker
 */

import { createClient } from 'redis';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let redis = null;
let kolData = null;

function getKolData() {
  if (!kolData) {
    kolData = JSON.parse(readFileSync(join(__dirname, 'data/kol-list.json'), 'utf8'));
  }
  return kolData;
}

async function getRedis() {
  if (!redis) {
    redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    redis.on('error', () => {});
    try { await redis.connect(); } catch { redis = null; }
  }
  return redis;
}

const WEIGHTS = {
  cascadeStage: 0.30,
  preAccumulation: 0.20,
  velocity: 0.15,
  kolQuality: 0.15,
  cascadeDepth: 0.10,
  sentiment: 0.10
};

/**
 * Classify the cascade stage based on which KOL tiers have mentioned
 */
async function scoreCascadeStage(tokenAddress) {
  try {
    const r = await getRedis();
    if (!r) return { score: 0.5, stage: 'unknown', tiers: [] };

    const mentions = await r.zRangeWithScores(`kol:mentions:${tokenAddress}`, 0, -1);
    if (!mentions || mentions.length === 0) return { score: 0, stage: 'none', tiers: [] };

    const kol = getKolData();
    const tierThresholds = kol.tierThresholds;
    const tiersPresent = new Set();

    // Build account lookup
    const accountTiers = new Map();
    for (const [tier, data] of Object.entries(kol.tiers)) {
      for (const account of data.accounts) {
        accountTiers.set(account.handle.toLowerCase(), tier);
      }
    }

    for (const { value: handle } of mentions) {
      const tier = accountTiers.get(handle.toLowerCase());
      if (tier) tiersPresent.add(tier);
    }

    const tiers = [...tiersPresent];

    // Classify stage
    let stage, score;

    if (tiersPresent.has('tier4') && !tiersPresent.has('tier3') && !tiersPresent.has('tier2') && !tiersPresent.has('tier1')) {
      stage = 'discovery';
      score = 0.9; // Best entry point
    } else if ((tiersPresent.has('tier4') || tiersPresent.has('tier3')) && !tiersPresent.has('tier1')) {
      stage = 'amplification';
      score = 0.7;
    } else if (tiersPresent.has('tier2') || tiersPresent.has('tier1')) {
      // Check if all tiers saturated
      if (tiersPresent.size >= 3) {
        stage = 'exhaustion';
        score = 0.1;
      } else {
        stage = 'fomo';
        score = 0.3;
      }
    } else {
      stage = 'early';
      score = 0.5;
    }

    return { score, stage, tiers, mentionCount: mentions.length };
  } catch {
    return { score: 0.5, stage: 'unknown', tiers: [] };
  }
}

/**
 * Cascade velocity - d(mentions)/dt across KOLs
 */
async function scoreCascadeVelocity(tokenAddress) {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    // Compare mention count now vs 5 min ago
    const currentCount = await r.zCard(`kol:mentions:${tokenAddress}`);
    const prevCount = parseInt(await r.get(`kol:mentions:prev:${tokenAddress}`) || '0');

    const delta = currentCount - prevCount;

    if (delta > 10) return 1.0;  // accelerating fast
    if (delta > 5) return 0.8;
    if (delta > 2) return 0.6;
    if (delta > 0) return 0.4;
    if (delta === 0) return 0.2; // stagnant
    return 0.1;                   // declining
  } catch {
    return 0.5;
  }
}

/**
 * KOL quality score - weighted average historical win rate
 */
async function scoreKolQuality(tokenAddress) {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const mentions = await r.zRangeWithScores(`kol:mentions:${tokenAddress}`, 0, -1);
    if (!mentions || mentions.length === 0) return 0;

    const kol = getKolData();
    const accountMap = new Map();
    for (const data of Object.values(kol.tiers)) {
      for (const account of data.accounts) {
        accountMap.set(account.handle.toLowerCase(), account);
      }
    }

    let totalWeight = 0;
    let weightedWinRate = 0;

    for (const { value: handle } of mentions) {
      const account = accountMap.get(handle.toLowerCase());
      if (account) {
        const weight = Math.log10(account.followers + 1);
        totalWeight += weight;
        weightedWinRate += account.winRate * weight;
      }
    }

    return totalWeight > 0 ? weightedWinRate / totalWeight : 0.5;
  } catch {
    return 0.5;
  }
}

/**
 * Pre-accumulation detection
 * Cross-reference KOL wallets against token holder list
 * If KOL bought BEFORE public mention → tainted signal
 */
async function scorePreAccumulation(tokenAddress) {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const tainted = parseInt(await r.get(`kol:preaccum:${tokenAddress}`) || '0');
    const total = parseInt(await r.get(`kol:mentions:count:${tokenAddress}`) || '1');

    const taintRatio = tainted / Math.max(total, 1);

    // Inverted: 1.0 - risk
    return Math.max(0, 1.0 - taintRatio);
  } catch {
    return 0.5;
  }
}

/**
 * Mention sentiment analysis
 * Classify KOL mentions as bullish or bearish
 */
async function scoreMentionSentiment(tokenAddress) {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const bullish = parseInt(await r.get(`kol:sentiment:bullish:${tokenAddress}`) || '0');
    const bearish = parseInt(await r.get(`kol:sentiment:bearish:${tokenAddress}`) || '0');

    const total = bullish + bearish;
    if (total === 0) return 0.5;

    return bullish / total;
  } catch {
    return 0.5;
  }
}

/**
 * Information cascade depth
 * How many layers deep has the mention cascade spread
 */
async function scoreCascadeDepth(tokenAddress) {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const depth = parseInt(await r.get(`kol:cascade_depth:${tokenAddress}`) || '0');

    if (depth >= 3) return 1.0; // viral cascade
    if (depth === 2) return 0.6; // KOL's followers echoed
    if (depth === 1) return 0.2; // only KOL mentioned
    return 0;
  } catch {
    return 0.5;
  }
}

/**
 * Main scoring function
 */
export async function scoreInfluencer(input) {
  try {
    const { tokenAddress = '' } = input;
    if (!tokenAddress) return { score: 0.5, features: {} };

    // Run all features in parallel
    const [
      cascadeStageResult,
      velocity,
      kolQuality,
      preAccumulation,
      sentiment,
      cascadeDepth
    ] = await Promise.allSettled([
      scoreCascadeStage(tokenAddress),
      scoreCascadeVelocity(tokenAddress),
      scoreKolQuality(tokenAddress),
      scorePreAccumulation(tokenAddress),
      scoreMentionSentiment(tokenAddress),
      scoreCascadeDepth(tokenAddress)
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : 0.5));

    const csResult = typeof cascadeStageResult === 'object' ? cascadeStageResult : { score: 0.5, stage: 'unknown' };

    const features = {
      cascadeStage: csResult.score,
      cascadeStageName: csResult.stage,
      cascadeTiers: csResult.tiers,
      mentionCount: csResult.mentionCount || 0,
      cascadeVelocity: velocity,
      kolQualityScore: kolQuality,
      preAccumulationRisk: 1.0 - (typeof preAccumulation === 'number' ? preAccumulation : 0.5),
      preAccumulationScore: preAccumulation,
      mentionSentiment: sentiment,
      informationCascadeDepth: cascadeDepth
    };

    const cs = csResult.score;
    const pa = typeof preAccumulation === 'number' ? preAccumulation : 0.5;
    const vel = typeof velocity === 'number' ? velocity : 0.5;
    const kq = typeof kolQuality === 'number' ? kolQuality : 0.5;
    const cd = typeof cascadeDepth === 'number' ? cascadeDepth : 0.5;
    const sent = typeof sentiment === 'number' ? sentiment : 0.5;

    const score = Math.max(0, Math.min(1.0,
      cs * WEIGHTS.cascadeStage +
      pa * WEIGHTS.preAccumulation +
      vel * WEIGHTS.velocity +
      kq * WEIGHTS.kolQuality +
      cd * WEIGHTS.cascadeDepth +
      sent * WEIGHTS.sentiment
    ));

    return { score, features };
  } catch (err) {
    console.error('[influencer] Error:', err.message);
    return { score: 0.5, features: { error: err.message } };
  }
}

export default scoreInfluencer;
