/**
 * Module 3: Cultural Timing & Attention Economics
 *
 * Newsjacking window in memecoin markets: under 10 minutes.
 * Cross-platform meme migration: 4chan/Telegram → Twitter → Reddit → TikTok → mainstream
 * Shannon entropy of meme token markets: 30-50% below efficient levels.
 *
 * Target: <20ms + background workers
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

const WEIGHTS = {
  trendMatch: 0.15,
  freshness: 0.15,
  migrationStage: 0.15,
  racePosition: 0.10,
  velocity: 0.10,
  celebrity: 0.10,
  crossPlatform: 0.05,
  attentionSaturation: 0.05,
  mindshareVelocity: 0.10,
  sovMcapRatio: 0.05
};

/**
 * Jaro-Winkler similarity between two strings
 */
function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1.0;
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;

  const matchDist = Math.floor(maxLen / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler boost for common prefix (up to 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Fuzzy match token name/symbol against trending topics
 */
async function scoreTrendMatch(name, symbol) {
  try {
    const r = await getRedis();
    if (!r) return { score: 0, matchedTrend: null };

    // Get active trends from Redis (populated by TrendPoller worker)
    const trends = await r.zRangeWithScores('trends:active', 0, -1, { REV: true });
    if (!trends || trends.length === 0) return { score: 0, matchedTrend: null };

    const tokens = [name, symbol].filter(Boolean).map(t => t.toLowerCase());
    let bestScore = 0;
    let matchedTrend = null;

    for (const { value: trend } of trends) {
      const trendLower = trend.toLowerCase();
      for (const token of tokens) {
        // Exact substring
        if (trendLower.includes(token) || token.includes(trendLower)) {
          bestScore = 1.0;
          matchedTrend = trend;
          break;
        }
        // Jaro-Winkler fuzzy
        const sim = jaroWinkler(token, trendLower);
        if (sim > bestScore && sim >= 0.85) {
          bestScore = sim;
          matchedTrend = trend;
        }
      }
      if (bestScore >= 1.0) break;
    }

    return { score: bestScore, matchedTrend };
  } catch {
    return { score: 0, matchedTrend: null };
  }
}

/**
 * Trend velocity - d(mentions)/dt
 */
async function scoreTrendVelocity(trendName) {
  try {
    if (!trendName) return 0;
    const r = await getRedis();
    if (!r) return 0.5;

    const velocity = parseFloat(await r.get(`trend:velocity:${trendName}`) || '0');

    // Normalize: 0→50K mentions/hr = high velocity
    if (velocity > 50000) return 1.0;
    if (velocity > 10000) return 0.8;
    if (velocity > 1000) return 0.6;
    if (velocity > 100) return 0.3;
    return 0.1;
  } catch {
    return 0.5;
  }
}

/**
 * Trend freshness - exponential decay e^(-hours/4)
 */
async function scoreTrendFreshness(trendName) {
  try {
    if (!trendName) return 0;
    const r = await getRedis();
    if (!r) return 0.5;

    const firstSeen = parseInt(await r.get(`trend:first_seen:${trendName}`) || '0');
    if (firstSeen === 0) return 0.5;

    const hoursAgo = (Date.now() - firstSeen) / (1000 * 60 * 60);
    return Math.exp(-hoursAgo / 4);
  } catch {
    return 0.5;
  }
}

/**
 * Launch race position - how many tokens already exist for this trend
 */
async function scoreLaunchRacePosition(trendName, tokenAddress) {
  try {
    if (!trendName) return 0.5;
    const r = await getRedis();
    if (!r) return 0.5;

    const competitors = await r.zCard(`trend:tokens:${trendName}`);
    const rank = await r.zRank(`trend:tokens:${trendName}`, tokenAddress);

    const position = rank !== null ? rank + 1 : competitors + 1;

    if (position === 1) return 1.0;
    if (position === 2) return 0.7;
    if (position <= 4) return 0.4;
    return 0.1;
  } catch {
    return 0.5;
  }
}

/**
 * Cross-platform spread
 */
async function scoreCrossPlatformSpread(trendName) {
  try {
    if (!trendName) return 0;
    const r = await getRedis();
    if (!r) return 0.5;

    const platforms = await r.sMembers(`trend:platforms:${trendName}`);
    const count = platforms ? platforms.length : 0;

    if (count >= 3) return 0.9;
    if (count === 2) return 0.5;
    if (count === 1) return 0.2;
    return 0;
  } catch {
    return 0.5;
  }
}

/**
 * Celebrity/influencer mention detection
 */
async function scoreCelebrityMention(name, symbol) {
  try {
    const r = await getRedis();
    if (!r) return 0;

    // Check if token is linked to celebrity mention
    const tokens = [name, symbol].filter(Boolean).map(t => t.toLowerCase());

    for (const token of tokens) {
      const tier = await r.get(`celebrity:mention:${token}`);
      if (tier === '1') return 1.0; // Musk, Trump
      if (tier === '2') return 0.7; // Top 20 CT
      if (tier === '3') return 0.4; // Top 100 CT
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Migration stage - where in the cross-platform cascade
 * Score peaks when meme is on forums + Twitter but NOT yet Reddit/TikTok
 */
async function scoreMigrationStage(trendName) {
  try {
    if (!trendName) return 0.5;
    const r = await getRedis();
    if (!r) return 0.5;

    const platforms = await r.sMembers(`trend:platforms:${trendName}`);
    if (!platforms || platforms.length === 0) return 0.5;

    const platformSet = new Set(platforms.map(p => p.toLowerCase()));

    const hasOrigin = platformSet.has('4chan') || platformSet.has('telegram');
    const hasTwitter = platformSet.has('twitter') || platformSet.has('x');
    const hasReddit = platformSet.has('reddit');
    const hasTikTok = platformSet.has('tiktok');
    const hasMainstream = platformSet.has('mainstream') || platformSet.has('news');

    // Ideal: origin + twitter, not yet reddit/tiktok
    if (hasOrigin && hasTwitter && !hasReddit && !hasTikTok) return 1.0;
    // Good: just origin
    if (hasOrigin && !hasTwitter && !hasReddit) return 0.8;
    // OK: twitter + reddit, no tiktok yet
    if (hasTwitter && hasReddit && !hasTikTok) return 0.5;
    // Late: already on TikTok/mainstream
    if (hasTikTok || hasMainstream) return 0.2;
    // Twitter only
    if (hasTwitter) return 0.7;

    return 0.5;
  } catch {
    return 0.5;
  }
}

/**
 * Attention saturation - inverse score for market crowding
 */
async function scoreAttentionSaturation() {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const dailyLaunches = parseInt(await r.get('market:daily_launches') || '0');

    // Baseline: 40K-65K tokens/day. 100K+ = saturated
    if (dailyLaunches < 30000) return 1.0;   // very quiet = lots of attention per token
    if (dailyLaunches < 50000) return 0.7;
    if (dailyLaunches < 70000) return 0.5;
    if (dailyLaunches < 100000) return 0.3;
    return 0.1;                                // extremely saturated
  } catch {
    return 0.5;
  }
}

/**
 * Mindshare velocity - rate of change of share-of-voice
 */
async function scoreMindshareVelocity(tokenAddress) {
  try {
    const r = await getRedis();
    if (!r) return 0;

    const velocity = parseFloat(await r.get(`token:mindshare_velocity:${tokenAddress}`) || '0');

    if (velocity > 0.01) return 1.0;   // capturing >1% share and growing
    if (velocity > 0.001) return 0.7;
    if (velocity > 0.0001) return 0.4;
    if (velocity > 0) return 0.2;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Share-of-voice to market cap ratio
 */
async function scoreSOVMcapRatio(tokenAddress) {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const sov = parseFloat(await r.get(`token:sov:${tokenAddress}`) || '0');
    const mcapShare = parseFloat(await r.get(`token:mcap_share:${tokenAddress}`) || '0');

    if (mcapShare === 0 || sov === 0) return 0.5;

    const ratio = sov / mcapShare;
    // Ratio > 2 = undervalued relative to attention
    if (ratio > 5) return 1.0;
    if (ratio > 2) return 0.8;
    if (ratio > 1) return 0.5;
    return 0.3; // overvalued relative to attention
  } catch {
    return 0.5;
  }
}

/**
 * Main scoring function
 */
export async function scoreCulturalTiming(input) {
  try {
    const { name = '', symbol = '', tokenAddress = '' } = input;
    if (!name && !symbol) return { score: 0.5, features: {} };

    // Step 1: Find matching trend
    const { score: trendMatchScore, matchedTrend } = await scoreTrendMatch(name, symbol);

    // Step 2: Run all dependent features in parallel
    const [
      velocity, freshness, racePosition,
      crossPlatform, celebrity, migrationStage,
      attentionSaturation, mindshareVelocity, sovMcapRatio
    ] = await Promise.allSettled([
      scoreTrendVelocity(matchedTrend),
      scoreTrendFreshness(matchedTrend),
      scoreLaunchRacePosition(matchedTrend, tokenAddress),
      scoreCrossPlatformSpread(matchedTrend),
      scoreCelebrityMention(name, symbol),
      scoreMigrationStage(matchedTrend),
      scoreAttentionSaturation(),
      scoreMindshareVelocity(tokenAddress),
      scoreSOVMcapRatio(tokenAddress)
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : 0.5));

    const features = {
      trendMatch: trendMatchScore,
      matchedTrend,
      trendVelocity: velocity,
      trendFreshness: freshness,
      launchRacePosition: racePosition,
      crossPlatformSpread: crossPlatform,
      celebrityMention: celebrity,
      migrationStage,
      attentionSaturation,
      mindshareVelocity,
      sovMcapRatio
    };

    const score = Math.max(0, Math.min(1.0,
      trendMatchScore * WEIGHTS.trendMatch +
      freshness * WEIGHTS.freshness +
      migrationStage * WEIGHTS.migrationStage +
      racePosition * WEIGHTS.racePosition +
      velocity * WEIGHTS.velocity +
      celebrity * WEIGHTS.celebrity +
      crossPlatform * WEIGHTS.crossPlatform +
      attentionSaturation * WEIGHTS.attentionSaturation +
      mindshareVelocity * WEIGHTS.mindshareVelocity +
      sovMcapRatio * WEIGHTS.sovMcapRatio
    ));

    return { score, features };
  } catch (err) {
    console.error('[cultural-timing] Error:', err.message);
    return { score: 0.5, features: { error: err.message } };
  }
}

export default scoreCulturalTiming;
