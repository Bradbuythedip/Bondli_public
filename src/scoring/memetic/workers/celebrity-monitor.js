/**
 * Background Worker: Celebrity Monitor
 *
 * Monitors curated 200 celebrity/influencer accounts every 60 seconds.
 * Detects crypto-related mentions and stores celebrity:mention:{keyword} in Redis.
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

const POLL_INTERVAL = 60 * 1000; // 60 seconds

// Tier 1 celebrities (market movers)
const TIER1_ACCOUNTS = ['elonmusk', 'realDonaldTrump'];
// Subset for frequent monitoring
const PRIORITY_ACCOUNTS = [
  ...TIER1_ACCOUNTS,
  'VitalikButerin', 'CZ_Binance', 'brian_armstrong'
];

/**
 * Check if a tweet contains crypto token mentions
 */
function extractCryptoMentions(text) {
  const mentions = [];

  // $TICKER pattern
  const tickers = text.match(/\$([A-Za-z]{2,10})/g) || [];
  for (const t of tickers) {
    mentions.push(t.replace('$', '').toLowerCase());
  }

  // Crypto keywords that might become tokens
  const cryptoPatterns = [
    /kekius/i, /maximus/i, /doge/i, /pepe/i,
    /bitcoin/i, /ethereum/i, /solana/i
  ];

  for (const pattern of cryptoPatterns) {
    const match = text.match(pattern);
    if (match) mentions.push(match[0].toLowerCase());
  }

  return [...new Set(mentions)];
}

/**
 * Poll celebrity accounts for crypto mentions
 */
async function pollCelebrities() {
  const r = await getRedis();
  if (!r) return;

  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (!bearerToken) return;

  try {
    for (const handle of PRIORITY_ACCOUNTS) {
      try {
        const response = await fetch(
          `https://api.twitter.com/2/tweets/search/recent?query=from:${handle}&max_results=5&tweet.fields=created_at`,
          { headers: { 'Authorization': `Bearer ${bearerToken}` } }
        );

        if (!response.ok) continue;
        const data = await response.json();

        for (const tweet of (data.data || [])) {
          const processedKey = `celebrity:processed:${tweet.id}`;
          if (await r.get(processedKey)) continue;

          const mentions = extractCryptoMentions(tweet.text);
          const tier = TIER1_ACCOUNTS.includes(handle) ? '1' : '2';

          for (const mention of mentions) {
            await r.set(`celebrity:mention:${mention}`, tier, { EX: 86400 });
          }

          await r.set(processedKey, '1', { EX: 86400 });
        }
      } catch {}
    }
  } catch (err) {
    console.error('[celebrity-monitor] Error:', err.message);
  }
}

/**
 * Start the celebrity monitor
 */
export function startCelebrityMonitor() {
  console.log('[celebrity-monitor] Starting (interval: 60s)');
  pollCelebrities();
  return setInterval(pollCelebrities, POLL_INTERVAL);
}

export default { startCelebrityMonitor };
