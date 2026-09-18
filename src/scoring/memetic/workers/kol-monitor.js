/**
 * Background Worker: KOL Monitor
 *
 * Polls 200+ tracked KOL accounts every 30s for token mentions.
 * Extracts token addresses/names, updates kol:mentions:{tokenAddress} sorted set.
 * Daily batch: recalculate rolling win rates.
 */

import { createClient } from 'redis';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let redis = null;

async function getRedis() {
  if (!redis) {
    redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    redis.on('error', () => {});
    try { await redis.connect(); } catch { redis = null; }
  }
  return redis;
}

const POLL_INTERVAL = 30 * 1000; // 30 seconds
const DAILY_BATCH_INTERVAL = 24 * 60 * 60 * 1000;

// Bullish / bearish keyword classifiers
const BULLISH_KEYWORDS = ['gem', 'alpha', 'moon', 'ape', 'runner', 'bullish', 'send it', 'loading', 'accumulate', 'buy', 'long', 'bid', 'easy', 'free money', 'next', '100x', '10x', '1000x'];
const BEARISH_KEYWORDS = ['scam', 'rug', 'avoid', 'dump', 'sus', 'bearish', 'sell', 'short', 'fade', 'rip', 'dead', 'warning', 'fake', 'bot', 'wash'];

function classifySentiment(text) {
  const lower = text.toLowerCase();
  let bullish = 0, bearish = 0;

  for (const kw of BULLISH_KEYWORDS) {
    if (lower.includes(kw)) bullish++;
  }
  for (const kw of BEARISH_KEYWORDS) {
    if (lower.includes(kw)) bearish++;
  }

  if (bullish > bearish) return 'bullish';
  if (bearish > bullish) return 'bearish';
  return 'neutral';
}

/**
 * Extract token mentions from tweet text
 * Looks for $TICKER patterns and Solana addresses
 */
function extractTokenMentions(text) {
  const mentions = [];

  // $TICKER pattern
  const tickers = text.match(/\$([A-Za-z]{2,10})/g) || [];
  for (const t of tickers) {
    mentions.push({ type: 'ticker', value: t.replace('$', '').toUpperCase() });
  }

  // Solana address pattern (base58, 32-44 chars)
  const addresses = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  for (const addr of addresses) {
    if (addr.length >= 32 && addr.length <= 44) {
      mentions.push({ type: 'address', value: addr });
    }
  }

  return mentions;
}

/**
 * Fetch recent tweets from a KOL account
 */
async function fetchKolTweets(handle) {
  try {
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    if (!bearerToken) return [];

    const response = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=from:${handle}&max_results=10&tweet.fields=created_at,public_metrics`,
      { headers: { 'Authorization': `Bearer ${bearerToken}` } }
    );

    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch {
    return [];
  }
}

/**
 * Process a single KOL's recent activity
 */
async function processKol(account, r) {
  const tweets = await fetchKolTweets(account.handle);

  for (const tweet of tweets) {
    // Skip already processed tweets
    const processedKey = `kol:processed:${tweet.id}`;
    const alreadyProcessed = await r.get(processedKey);
    if (alreadyProcessed) continue;

    const mentions = extractTokenMentions(tweet.text);
    const sentiment = classifySentiment(tweet.text);

    for (const mention of mentions) {
      const tokenKey = mention.type === 'address' ? mention.value : `ticker:${mention.value}`;

      // Add to KOL mentions sorted set (score = timestamp)
      await r.zAdd(`kol:mentions:${tokenKey}`, {
        score: Date.now(),
        value: account.handle
      });

      // Update sentiment
      if (sentiment === 'bullish') {
        await r.incr(`kol:sentiment:bullish:${tokenKey}`);
      } else if (sentiment === 'bearish') {
        await r.incr(`kol:sentiment:bearish:${tokenKey}`);
      }

      // Track mention count
      await r.incr(`kol:mentions:count:${tokenKey}`);

      // Set TTLs
      await r.expire(`kol:mentions:${tokenKey}`, 86400);
      await r.expire(`kol:sentiment:bullish:${tokenKey}`, 86400);
      await r.expire(`kol:sentiment:bearish:${tokenKey}`, 86400);
      await r.expire(`kol:mentions:count:${tokenKey}`, 86400);
    }

    // Mark tweet as processed (24h TTL)
    await r.set(processedKey, '1', { EX: 86400 });
  }
}

/**
 * Main poll cycle - check all KOLs
 */
async function pollKols() {
  const r = await getRedis();
  if (!r) return;

  try {
    const kolData = JSON.parse(readFileSync(join(__dirname, '../data/kol-list.json'), 'utf8'));

    // Process all tiers
    for (const tierData of Object.values(kolData.tiers)) {
      for (const account of tierData.accounts) {
        try {
          await processKol(account, r);
        } catch {}
      }
    }

    // Store previous mention counts for velocity calculation
    // (done per-token in the influencer module)

    console.log('[kol-monitor] Poll complete');
  } catch (err) {
    console.error('[kol-monitor] Error:', err.message);
  }
}

/**
 * Daily batch: recalculate win rates from trade outcomes
 */
async function dailyWinRateBatch() {
  const r = await getRedis();
  if (!r) return;

  try {
    // Read trade outcomes and update KOL win rates
    const outcomes = await r.xRange('stream:trade_outcomes', '-', '+', { COUNT: 1000 });

    const kolStats = new Map(); // handle -> { wins, total }

    for (const entry of outcomes) {
      const data = JSON.parse(entry.message.data);
      if (!data.moduleScores?.influencer) continue;

      // Attribution: which KOLs mentioned this token?
      const mentions = await r.zRange(`kol:mentions:${data.tokenAddress}`, 0, -1);
      const isWin = data.pnl > 0;

      for (const handle of mentions) {
        if (!kolStats.has(handle)) kolStats.set(handle, { wins: 0, total: 0 });
        const stats = kolStats.get(handle);
        stats.total++;
        if (isWin) stats.wins++;
      }
    }

    // Update win rates in Redis
    for (const [handle, stats] of kolStats) {
      const winRate = stats.total > 0 ? stats.wins / stats.total : 0.5;
      await r.set(`kol:winrate:${handle}`, String(winRate), { EX: 86400 * 7 });
    }

    console.log(`[kol-monitor] Daily batch: updated ${kolStats.size} KOL win rates`);
  } catch (err) {
    console.error('[kol-monitor] Daily batch error:', err.message);
  }
}

/**
 * Start the KOL monitor
 */
export function startKolMonitor() {
  console.log('[kol-monitor] Starting (interval: 30s)');
  pollKols(); // Initial poll
  const pollTimer = setInterval(pollKols, POLL_INTERVAL);
  const dailyTimer = setInterval(dailyWinRateBatch, DAILY_BATCH_INTERVAL);
  return { pollTimer, dailyTimer };
}

export default { startKolMonitor, pollKols, dailyWinRateBatch };
