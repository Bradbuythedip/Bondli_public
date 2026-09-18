/**
 * Background Worker: Market Condition Poller
 *
 * Polls BTC/SOL prices, Fear & Greed Index, graduation rates every 5 minutes.
 * Computes market inefficiency score.
 * Stores all data in Redis for temporal module consumption.
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
 * Fetch BTC and SOL 24h price changes
 * Primary: Jupiter (SOL) + CoinGecko (BTC) — Jupiter is free with generous limits
 */
async function fetchPriceChanges() {
  let solPrice = 0, btcPrice = 0, btcChange = 0, solChange = 0;

  // Jupiter for SOL price (free, no key, no rate limit issues)
  try {
    const r = await fetch('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112',
      { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const d = await r.json();
      solPrice = parseFloat(d?.data?.['So11111111111111111111111111111111111111112']?.price || 0);
    }
  } catch {}

  // CoinGecko for BTC + 24h changes (still needed for BTC data)
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,solana&vs_currencies=usd&include_24hr_change=true',
      { headers: { 'User-Agent': 'bondli-market-poller/1.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (response.ok) {
      const data = await response.json();
      btcChange = data.bitcoin?.usd_24h_change || 0;
      solChange = data.solana?.usd_24h_change || 0;
      btcPrice = data.bitcoin?.usd || 0;
      if (!solPrice) solPrice = data.solana?.usd || 0;
    }
  } catch {}

  if (!solPrice && !btcPrice) return null;
  return { btcChange, solChange, btcPrice, solPrice };
}

/**
 * Fetch Crypto Fear & Greed Index
 */
async function fetchFearGreedIndex() {
  try {
    const response = await fetch('https://api.alternative.me/fng/?limit=1');
    if (!response.ok) return null;
    const data = await response.json();
    return parseInt(data?.data?.[0]?.value || '50');
  } catch {
    return null;
  }
}

/**
 * Compute market inefficiency from recent pump.fun token returns
 * Shannon entropy of return distribution — lower = more inefficient = more edge
 */
async function computeMarketInefficiency(r) {
  try {
    // Get recent trade outcomes
    const outcomes = await r.xRange('stream:trade_outcomes', '-', '+', { COUNT: 100 });
    if (outcomes.length < 10) return 0.5;

    // Bin returns into 10 buckets
    const bins = new Array(10).fill(0);
    for (const entry of outcomes) {
      const data = JSON.parse(entry.message.data);
      const pnl = data.pnl || 0;
      // Map PnL to bin: [-100%, -50%, -20%, -5%, 0%, 5%, 20%, 50%, 100%, 200%+]
      let bin;
      if (pnl < -0.5) bin = 0;
      else if (pnl < -0.2) bin = 1;
      else if (pnl < -0.05) bin = 2;
      else if (pnl < 0) bin = 3;
      else if (pnl < 0.05) bin = 4;
      else if (pnl < 0.2) bin = 5;
      else if (pnl < 0.5) bin = 6;
      else if (pnl < 1.0) bin = 7;
      else if (pnl < 2.0) bin = 8;
      else bin = 9;
      bins[bin]++;
    }

    // Shannon entropy
    const total = bins.reduce((a, b) => a + b, 0);
    if (total === 0) return 0.5;

    let entropy = 0;
    for (const count of bins) {
      if (count === 0) continue;
      const p = count / total;
      entropy -= p * Math.log2(p);
    }

    const maxEntropy = Math.log2(10);
    const normalizedEntropy = entropy / maxEntropy;

    // Inefficiency = 1 - normalized entropy (lower entropy = more predictable = more inefficient markets = more edge)
    return 1 - normalizedEntropy;
  } catch {
    return 0.5;
  }
}

/**
 * Main poll cycle
 */
async function pollMarketConditions() {
  const r = await getRedis();
  if (!r) return;

  try {
    // Fetch all market data in parallel
    const [prices, fgi] = await Promise.allSettled([
      fetchPriceChanges(),
      fetchFearGreedIndex()
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

    // Store price data
    if (prices) {
      await r.set('market:btc_24h_change', String(prices.btcChange), { EX: 600 });
      await r.set('market:sol_24h_change', String(prices.solChange), { EX: 600 });
      await r.set('market:btc_price', String(prices.btcPrice), { EX: 600 });
      await r.set('market:sol_price', String(prices.solPrice), { EX: 600 });
    }

    // Store Fear & Greed
    if (fgi !== null) {
      await r.set('market:fear_greed_index', String(fgi), { EX: 600 });
    }

    // Compute and store market inefficiency
    const inefficiency = await computeMarketInefficiency(r);
    await r.set('market:inefficiency_score', String(inefficiency), { EX: 600 });

    console.log(`[market-poller] BTC: ${prices?.btcChange?.toFixed(1)}%, SOL: ${prices?.solChange?.toFixed(1)}%, FGI: ${fgi}, Inefficiency: ${inefficiency.toFixed(2)}`);
  } catch (err) {
    console.error('[market-poller] Error:', err.message);
  }
}

/**
 * Start the market condition poller
 */
export function startMarketPoller() {
  console.log('[market-poller] Starting (interval: 5min)');
  pollMarketConditions(); // Initial poll
  return setInterval(pollMarketConditions, POLL_INTERVAL);
}

export default { startMarketPoller, pollMarketConditions };
