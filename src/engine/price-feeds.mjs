// BONDLI — Free Price Feed Aggregator
// GeckoTerminal (OHLCV candles) + Jupiter (spot prices) — no API keys needed
//
// Usage:
//   import { getCandles, getSpotPrice, getMultiSpotPrices, analyzeCandles } from './price-feeds.mjs';
//   const candles = await getCandles(poolAddress, '5m');
//   const price   = await getSpotPrice(mintAddress);
//   const analysis = analyzeCandles(candles);

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const JUP_PRICE  = "https://api.jup.ag/price/v2";

// Rate limit: GeckoTerminal ~30 req/min, Jupiter generous
// In-memory cache to avoid hammering
const cache = new Map();
const CACHE_TTL_MS = 30_000; // 30s for spot, overridden for candles

function cached(key, ttl = CACHE_TTL_MS) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}

function setCache(key, data, ttl = CACHE_TTL_MS) {
  cache.set(key, { data, ts: Date.now() });
  // Prune if cache grows too large
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > ttl * 2) cache.delete(k);
    }
  }
}

async function safeFetch(url, timeout = 8000) {
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

// ══════════════════════════════════════
// JUPITER — Spot Prices (free, no key)
// ══════════════════════════════════════

/**
 * Get spot price for a single token mint
 * @param {string} mint - Solana token mint address
 * @returns {Promise<{price: number, mint: string}|null>}
 */
export async function getSpotPrice(mint) {
  const key = `spot:${mint}`;
  const hit = cached(key);
  if (hit) return hit;

  const d = await safeFetch(`${JUP_PRICE}?ids=${mint}`);
  if (!d?.data?.[mint]?.price) return null;

  const result = {
    mint,
    price: parseFloat(d.data[mint].price),
    symbol: d.data[mint].mintSymbol || null,
  };
  setCache(key, result);
  return result;
}

/**
 * Get spot prices for multiple mints in one call (max 100)
 * @param {string[]} mints - Array of mint addresses
 * @returns {Promise<Map<string, number>>} mint → price
 */
export async function getMultiSpotPrices(mints) {
  if (!mints.length) return new Map();

  // Check cache first, only fetch missing
  const prices = new Map();
  const missing = [];
  for (const m of mints) {
    const hit = cached(`spot:${m}`);
    if (hit) prices.set(m, hit.price);
    else missing.push(m);
  }

  if (missing.length > 0) {
    // Jupiter supports comma-separated IDs
    const chunks = [];
    for (let i = 0; i < missing.length; i += 100) {
      chunks.push(missing.slice(i, i + 100));
    }

    for (const chunk of chunks) {
      const d = await safeFetch(`${JUP_PRICE}?ids=${chunk.join(",")}`);
      if (d?.data) {
        for (const [mint, info] of Object.entries(d.data)) {
          if (info?.price) {
            const p = parseFloat(info.price);
            prices.set(mint, p);
            setCache(`spot:${mint}`, { mint, price: p, symbol: info.mintSymbol || null });
          }
        }
      }
    }
  }

  return prices;
}

// ══════════════════════════════════════
// GECKOTERMINAL — OHLCV Candles (free, no key)
// ══════════════════════════════════════

// GeckoTerminal uses pool addresses, not mint addresses
// For Raydium/Orca pools on Solana

/**
 * Fetch OHLCV candles for a pool
 * @param {string} poolAddress - Raydium/Orca pool address
 * @param {string} timeframe - '1m', '5m', '15m', '1h', '4h', '1d'
 * @param {number} limit - Number of candles (max 1000, default 100)
 * @returns {Promise<Array<{time, open, high, low, close, volume}>>}
 */
export async function getCandles(poolAddress, timeframe = "5m", limit = 100) {
  const tfMap = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": "day" };
  const aggregate = tfMap[timeframe] || 5;
  const endpoint = typeof aggregate === "string" ? "day" : "minute";

  const key = `candles:${poolAddress}:${timeframe}`;
  const ttl = timeframe === "1m" ? 15_000 : timeframe === "5m" ? 30_000 : 60_000;
  const hit = cached(key, ttl);
  if (hit) return hit;

  const url = `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${endpoint}` +
    `?aggregate=${typeof aggregate === "string" ? 1 : aggregate}` +
    `&limit=${Math.min(limit, 1000)}` +
    `&currency=usd`;

  const d = await safeFetch(url);
  if (!d?.data?.attributes?.ohlcv_list) return [];

  // GeckoTerminal returns [timestamp, open, high, low, close, volume] newest-first
  const candles = d.data.attributes.ohlcv_list
    .map(([ts, o, h, l, c, v]) => ({
      time: ts,
      open: parseFloat(o),
      high: parseFloat(h),
      low: parseFloat(l),
      close: parseFloat(c),
      volume: parseFloat(v),
    }))
    .reverse(); // oldest first

  setCache(key, candles, ttl);
  return candles;
}

/**
 * Search for a pool address by token mint (needed for GeckoTerminal)
 * @param {string} mint - Token mint address
 * @returns {Promise<{pool: string, dex: string, baseToken: string, quoteToken: string}|null>}
 */
export async function findPool(mint) {
  const key = `pool:${mint}`;
  const hit = cached(key, 300_000); // 5 min cache for pool lookups
  if (hit) return hit;

  const d = await safeFetch(
    `${GECKO_BASE}/networks/solana/tokens/${mint}/pools?page=1`
  );
  if (!d?.data?.length) return null;

  // Pick highest-volume pool
  const best = d.data[0];
  const result = {
    pool: best.attributes?.address,
    dex: best.relationships?.dex?.data?.id || "unknown",
    baseToken: best.relationships?.base_token?.data?.id?.replace("solana_", "") || mint,
    quoteToken: best.relationships?.quote_token?.data?.id?.replace("solana_", "") || "",
    name: best.attributes?.name || "",
  };

  if (result.pool) setCache(key, result, 300_000);
  return result;
}

/**
 * Get candles by mint address (auto-resolves pool)
 * Convenience wrapper: mint → find pool → fetch candles
 * @param {string} mint - Token mint address
 * @param {string} timeframe - '1m', '5m', '15m', '1h', '4h', '1d'
 * @param {number} limit - Number of candles
 * @returns {Promise<Array<{time, open, high, low, close, volume}>>}
 */
export async function getCandlesByMint(mint, timeframe = "5m", limit = 100) {
  const pool = await findPool(mint);
  if (!pool?.pool) return [];
  return getCandles(pool.pool, timeframe, limit);
}

// ══════════════════════════════════════
// CANDLE ANALYSIS — Chart shape scoring
// ══════════════════════════════════════

/**
 * Analyze candle array for chart health, patterns, and momentum
 * Returns scores compatible with meme-intelligence.mjs ch_* features
 * @param {Array} candles - OHLCV candle array
 * @returns {object} Chart analysis scores
 */
export function analyzeCandles(candles) {
  if (!candles || candles.length < 5) {
    return {
      healthScore: 0.5,
      pumpDump: 0,
      smoothGrind: 0,
      dipRatio: 0.5,
      staircaseScore: 0,
      momentum: 0,
      volatility: 0,
      volumeTrend: 0,
      rsi: 50,
    };
  }

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const n = closes.length;

  // ── RSI (14-period or available) ──
  const period = Math.min(14, n - 1);
  let gains = 0, losses = 0;
  for (let i = n - period; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period || 0.001;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  // ── Momentum: % change over last N candles ──
  const momentum = (closes[n - 1] - closes[0]) / (closes[0] || 1);

  // ── Volatility: coefficient of variation ──
  const mean = closes.reduce((a, b) => a + b, 0) / n;
  const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const volatility = Math.sqrt(variance) / (mean || 1);

  // ── Dip ratio: fraction of red candles ──
  let redCount = 0;
  for (let i = 1; i < n; i++) {
    if (closes[i] < closes[i - 1]) redCount++;
  }
  const dipRatio = redCount / (n - 1);

  // ── Pump and dump detection ──
  // Pattern: sharp rise then sharp fall
  let peak = 0, peakIdx = 0;
  for (let i = 0; i < n; i++) {
    if (closes[i] > peak) { peak = closes[i]; peakIdx = i; }
  }
  const riseFromStart = peak / (closes[0] || 1) - 1;
  const fallFromPeak = peakIdx < n - 1 ? 1 - closes[n - 1] / peak : 0;
  // P&D if rises >100% then falls >50% from peak, and peak is in first half
  const pumpDump = (riseFromStart > 1 && fallFromPeak > 0.5 && peakIdx < n * 0.6)
    ? Math.min(1, (riseFromStart * fallFromPeak) / 2) : 0;

  // ── Smooth grind detection (suspicious) ──
  // Monotonically increasing with low volatility = likely self-bought
  let upCount = 0;
  for (let i = 1; i < n; i++) {
    if (closes[i] >= closes[i - 1]) upCount++;
  }
  const upRatio = upCount / (n - 1);
  const smoothGrind = (upRatio > 0.85 && volatility < 0.1) ? Math.min(1, upRatio * (1 - volatility)) : 0;

  // ── Staircase detection: uniform step sizes = bot ──
  const steps = [];
  for (let i = 1; i < n; i++) {
    steps.push(closes[i] - closes[i - 1]);
  }
  const stepMean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const stepVar = steps.reduce((a, b) => a + (b - stepMean) ** 2, 0) / steps.length;
  const stepCV = stepMean !== 0 ? Math.sqrt(stepVar) / Math.abs(stepMean) : 1;
  // Low CV + mostly positive steps = staircase
  const staircaseScore = (stepCV < 0.5 && upRatio > 0.8) ? Math.min(1, (1 - stepCV) * upRatio) : 0;

  // ── Volume trend: is volume increasing or decreasing? ──
  const volFirstHalf = volumes.slice(0, Math.floor(n / 2));
  const volSecondHalf = volumes.slice(Math.floor(n / 2));
  const avgVolFirst = volFirstHalf.reduce((a, b) => a + b, 0) / (volFirstHalf.length || 1);
  const avgVolSecond = volSecondHalf.reduce((a, b) => a + b, 0) / (volSecondHalf.length || 1);
  const volumeTrend = avgVolFirst > 0 ? (avgVolSecond - avgVolFirst) / avgVolFirst : 0;

  // ── Health score: composite ──
  let healthScore = 0.5;
  // Positive momentum is healthy
  if (momentum > 0) healthScore += Math.min(0.2, momentum * 0.5);
  else healthScore += Math.max(-0.3, momentum * 0.3);
  // Some dips are healthy (organic), no dips is suspicious
  if (dipRatio > 0.2 && dipRatio < 0.5) healthScore += 0.1;
  else if (dipRatio < 0.1) healthScore -= 0.1; // no dips = likely fake
  // Moderate RSI is healthy
  if (rsi > 30 && rsi < 70) healthScore += 0.1;
  else if (rsi > 80 || rsi < 20) healthScore -= 0.1;
  // Volume trend up is healthy
  if (volumeTrend > 0.2) healthScore += 0.1;
  // Penalize pump-dump and suspicious patterns
  healthScore -= pumpDump * 0.3;
  healthScore -= smoothGrind * 0.2;
  healthScore -= staircaseScore * 0.2;

  healthScore = Math.max(0, Math.min(1, healthScore));

  return {
    healthScore: Math.round(healthScore * 1000) / 1000,
    pumpDump: Math.round(pumpDump * 1000) / 1000,
    smoothGrind: Math.round(smoothGrind * 1000) / 1000,
    dipRatio: Math.round(dipRatio * 1000) / 1000,
    staircaseScore: Math.round(staircaseScore * 1000) / 1000,
    momentum: Math.round(momentum * 10000) / 10000,
    volatility: Math.round(volatility * 10000) / 10000,
    volumeTrend: Math.round(volumeTrend * 1000) / 1000,
    rsi: Math.round(rsi * 10) / 10,
    candleCount: n,
  };
}

export default {
  getSpotPrice,
  getMultiSpotPrices,
  getCandles,
  getCandlesByMint,
  findPool,
  analyzeCandles,
};
