/**
 * Background Worker: Trend Poller
 *
 * Polls Twitter/Reddit/Google Trends every 5 minutes.
 * Stores active trends in Redis sorted set `trends:active`.
 * Tracks trend velocity, freshness, and platform spread.
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

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch trending topics from Twitter/X
 */
async function fetchTwitterTrends() {
  try {
    // Twitter API v2 trending topics
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    if (!bearerToken) return [];

    const response = await fetch('https://api.twitter.com/2/trends/by/woeid/1', {
      headers: { 'Authorization': `Bearer ${bearerToken}` }
    });

    if (!response.ok) return [];
    const data = await response.json();

    return (data.data || []).map(trend => ({
      name: trend.name.replace('#', ''),
      volume: trend.tweet_volume || 0,
      platform: 'twitter'
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch trending topics from Reddit
 */
async function fetchRedditTrends() {
  try {
    const subreddits = ['cryptocurrency', 'CryptoMoonShots', 'solana', 'memecoin', 'wallstreetbets'];
    const trends = [];

    for (const sub of subreddits) {
      try {
        const response = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=10`, {
          headers: { 'User-Agent': 'bondli-trend-poller/1.0' }
        });
        if (!response.ok) continue;
        const data = await response.json();

        for (const post of (data?.data?.children || [])) {
          const title = post.data.title;
          // Extract potential token/meme names (capitalized words, $TICKER patterns)
          const tickers = title.match(/\$[A-Z]{2,10}/g) || [];
          const capsWords = title.match(/\b[A-Z]{3,10}\b/g) || [];

          for (const t of [...tickers, ...capsWords]) {
            trends.push({
              name: t.replace('$', ''),
              volume: post.data.score || 0,
              platform: 'reddit'
            });
          }
        }
      } catch {}
    }

    return trends;
  } catch {
    return [];
  }
}

/**
 * Main poll cycle
 */
async function pollTrends() {
  const r = await getRedis();
  if (!r) {
    console.error('[trend-poller] No Redis connection');
    return;
  }

  try {
    // Fetch from all platforms in parallel
    const [twitterTrends, redditTrends] = await Promise.allSettled([
      fetchTwitterTrends(),
      fetchRedditTrends()
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

    const allTrends = [...twitterTrends, ...redditTrends];

    // Aggregate by trend name
    const trendMap = new Map();
    for (const trend of allTrends) {
      const key = trend.name.toLowerCase();
      if (!trendMap.has(key)) {
        trendMap.set(key, { name: trend.name, volume: 0, platforms: new Set() });
      }
      const entry = trendMap.get(key);
      entry.volume += trend.volume;
      entry.platforms.add(trend.platform);
    }

    // Update Redis
    for (const [key, trend] of trendMap) {
      // Add to active trends sorted set (score = volume)
      await r.zAdd('trends:active', { score: trend.volume, value: trend.name });

      // Track platforms
      for (const platform of trend.platforms) {
        await r.sAdd(`trend:platforms:${trend.name}`, platform);
      }

      // Set first-seen timestamp if new
      const firstSeen = await r.get(`trend:first_seen:${trend.name}`);
      if (!firstSeen) {
        await r.set(`trend:first_seen:${trend.name}`, String(Date.now()), { EX: 86400 * 7 });
      }

      // Compute velocity (change from previous poll)
      const prevVolume = parseInt(await r.get(`trend:prev_volume:${trend.name}`) || '0');
      const velocity = trend.volume - prevVolume;
      await r.set(`trend:velocity:${trend.name}`, String(velocity), { EX: 600 });
      await r.set(`trend:prev_volume:${trend.name}`, String(trend.volume), { EX: 600 });

      // Set TTL on platform sets
      await r.expire(`trend:platforms:${trend.name}`, 86400);
    }

    // Expire old trends (keep top 200)
    const totalTrends = await r.zCard('trends:active');
    if (totalTrends > 200) {
      await r.zRemRangeByRank('trends:active', 0, totalTrends - 201);
    }

    console.log(`[trend-poller] Updated ${trendMap.size} trends from ${allTrends.length} sources`);
  } catch (err) {
    console.error('[trend-poller] Error:', err.message);
  }
}

/**
 * Start the trend poller
 */
export function startTrendPoller() {
  console.log('[trend-poller] Starting (interval: 5min)');
  pollTrends(); // Initial poll
  return setInterval(pollTrends, POLL_INTERVAL);
}

export default { startTrendPoller, pollTrends };
