/**
 * Background Worker: Competitor Tracker
 *
 * Counts tokens per trend on every new pump.fun token event.
 * Maintains trend:tokens:{trendName} sorted sets for race position scoring.
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

/**
 * Jaro-Winkler similarity (minimal version for matching)
 */
function jaroWinklerSimple(s1, s2) {
  if (s1 === s2) return 1.0;
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  const matchDist = Math.floor(maxLen / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const end = Math.min(i + matchDist + 1, s2.length);
    for (let j = Math.max(0, i - matchDist); j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  const jaro = (matches / s1.length + matches / s2.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Register a new token against active trends
 * Called on every new pump.fun token detection
 */
export async function registerTokenForTrends(tokenAddress, name, symbol) {
  try {
    const r = await getRedis();
    if (!r) return;

    // Get active trends
    const trends = await r.zRange('trends:active', 0, -1);
    if (!trends || trends.length === 0) return;

    const tokens = [name, symbol].filter(Boolean).map(t => t.toLowerCase());

    for (const trend of trends) {
      const trendLower = trend.toLowerCase();
      let matches = false;

      for (const token of tokens) {
        if (trendLower.includes(token) || token.includes(trendLower)) {
          matches = true;
          break;
        }
        if (jaroWinklerSimple(token, trendLower) >= 0.85) {
          matches = true;
          break;
        }
      }

      if (matches) {
        // Add to trend's token list (score = timestamp for ordering)
        await r.zAdd(`trend:tokens:${trend}`, {
          score: Date.now(),
          value: tokenAddress
        });
        await r.expire(`trend:tokens:${trend}`, 86400);
      }
    }
  } catch {}
}

export default { registerTokenForTrends };
