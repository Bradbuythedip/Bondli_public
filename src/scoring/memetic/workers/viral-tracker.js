/**
 * Background Worker: Viral Tracker
 *
 * Monitors for tokens crossing $1M market cap.
 * Tracks time since last viral event for temporal scoring.
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
 * Record a viral event (token crossed $1M cap)
 */
export async function recordViralEvent(tokenAddress, marketCap) {
  try {
    const r = await getRedis();
    if (!r) return;

    await r.set('market:last_viral_timestamp', String(Date.now()), { EX: 86400 });
    await r.set('market:last_viral_token', tokenAddress, { EX: 86400 });
    await r.set('market:last_viral_mcap', String(marketCap), { EX: 86400 });

    // Add to viral history
    await r.zAdd('market:viral_history', {
      score: Date.now(),
      value: JSON.stringify({ tokenAddress, marketCap, timestamp: Date.now() })
    });

    // Keep last 100 viral events
    const count = await r.zCard('market:viral_history');
    if (count > 100) {
      await r.zRemRangeByRank('market:viral_history', 0, count - 101);
    }

    console.log(`[viral-tracker] New viral event: ${tokenAddress} @ $${marketCap}`);
  } catch {}
}

export default { recordViralEvent };
