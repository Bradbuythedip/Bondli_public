/**
 * Background Worker: Launch Counter
 *
 * Tracks hourly and daily pump.fun launch counts.
 * Maintains 7-day rolling average for launch density scoring.
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
 * Increment launch counter (called on every new token detection)
 */
export async function recordLaunch() {
  try {
    const r = await getRedis();
    if (!r) return;

    const now = Date.now();
    const hourKey = `launches:hour:${Math.floor(now / 3600000)}`;
    const dayKey = `launches:day:${Math.floor(now / 86400000)}`;

    await r.incr(hourKey);
    await r.expire(hourKey, 86400 * 8); // Keep for 8 days

    await r.incr(dayKey);
    await r.expire(dayKey, 86400 * 8);

    // Update current counts
    const hourlyCount = parseInt(await r.get(hourKey) || '0');
    await r.set('market:hourly_launches', String(hourlyCount), { EX: 3600 });

    const dailyCount = parseInt(await r.get(dayKey) || '0');
    await r.set('market:daily_launches', String(dailyCount), { EX: 86400 });

    // Update 7-day average
    await updateRollingAverage(r);
  } catch {}
}

/**
 * Compute 7-day rolling average of hourly launches
 */
async function updateRollingAverage(r) {
  try {
    const now = Date.now();
    let totalLaunches = 0;
    let hoursCounted = 0;

    for (let i = 0; i < 168; i++) { // 7 days × 24 hours
      const hourKey = `launches:hour:${Math.floor((now - i * 3600000) / 3600000)}`;
      const count = parseInt(await r.get(hourKey) || '0');
      if (count > 0) {
        totalLaunches += count;
        hoursCounted++;
      }
    }

    const avgHourly = hoursCounted > 0 ? totalLaunches / hoursCounted : 0;
    await r.set('market:avg_hourly_launches_7d', String(avgHourly), { EX: 3600 });
  } catch {}
}

/**
 * Record a graduation event (token bonding curve completed)
 */
export async function recordGraduation() {
  try {
    const r = await getRedis();
    if (!r) return;

    const dayKey = `graduations:day:${Math.floor(Date.now() / 86400000)}`;
    await r.incr(dayKey);
    await r.expire(dayKey, 86400 * 8);

    // Compute graduation rate = graduations / launches
    const grads = parseInt(await r.get(dayKey) || '0');
    const launches = parseInt(await r.get('market:daily_launches') || '1');
    const rate = grads / Math.max(launches, 1);

    await r.set('market:graduation_rate_24h', String(rate), { EX: 3600 });
  } catch {}
}

export default { recordLaunch, recordGraduation };
