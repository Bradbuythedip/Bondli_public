/**
 * Background Worker: Mindshare Tracker
 *
 * Aggregates mention volumes per token hourly.
 * Computes share-of-voice and mindshare velocity.
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

const POLL_INTERVAL = 60 * 60 * 1000; // 1 hour

/**
 * Update mindshare metrics for all tracked tokens
 */
async function updateMindshare() {
  const r = await getRedis();
  if (!r) return;

  try {
    // Get all active token mention counts
    const keys = [];
    for await (const key of r.scanIterator({ MATCH: 'kol:mentions:count:*', COUNT: 100 })) {
      keys.push(key);
    }

    // Calculate total mentions across all tokens
    let totalMentions = 0;
    const tokenMentions = new Map();

    for (const key of keys) {
      const count = parseInt(await r.get(key) || '0');
      const tokenAddress = key.replace('kol:mentions:count:', '');
      tokenMentions.set(tokenAddress, count);
      totalMentions += count;
    }

    if (totalMentions === 0) return;

    // Compute share-of-voice and velocity for each token
    for (const [tokenAddress, mentions] of tokenMentions) {
      const sov = mentions / totalMentions;
      await r.set(`token:sov:${tokenAddress}`, String(sov), { EX: 7200 });

      // Velocity: compare current SOV with previous
      const prevSov = parseFloat(await r.get(`token:sov:prev:${tokenAddress}`) || '0');
      const velocity = sov - prevSov;
      await r.set(`token:mindshare_velocity:${tokenAddress}`, String(velocity), { EX: 7200 });
      await r.set(`token:sov:prev:${tokenAddress}`, String(sov), { EX: 7200 });
    }

    console.log(`[mindshare-tracker] Updated ${tokenMentions.size} tokens, total mentions: ${totalMentions}`);
  } catch (err) {
    console.error('[mindshare-tracker] Error:', err.message);
  }
}

/**
 * Start the mindshare tracker
 */
export function startMindshareTracker() {
  console.log('[mindshare-tracker] Starting (interval: 1h)');
  updateMindshare();
  return setInterval(updateMindshare, POLL_INTERVAL);
}

export default { startMindshareTracker };
