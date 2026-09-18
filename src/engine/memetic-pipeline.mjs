/**
 * Memetic Scoring Pipeline (Alchemy-free)
 *
 * Stateless scorer that runs memetic analysis on tokens from PumpPortal WS data.
 * No Alchemy dependency — all metadata comes from PumpPortal create events.
 *
 * Exports:
 *   - scoreTokenMemetic(tokenData) → full 7-module memetic score
 *   - quickFilterMemetic(tokenData) → fast 3-module pre-filter
 *   - startMemeticWorkers() → background trend/KOL/market pollers
 *   - MemeticPipeline class (kept for backward compat, now wraps PF data)
 */

import { scoreVolumeLegitimacy } from './volume-legitimacy.mjs';
import { EventEmitter } from 'events';
import { createClient } from 'redis';
import { scoreMemeticAll, scoreMemeticQuick, logTradeOutcome } from '../scoring/memetic/index.js';
import { recordLaunch, recordGraduation } from '../scoring/memetic/workers/launch-counter.js';
import { registerTokenForTrends } from '../scoring/memetic/workers/competitor-tracker.js';
import { startTrendPoller } from '../scoring/memetic/workers/trend-poller.js';
import { startKolMonitor } from '../scoring/memetic/workers/kol-monitor.js';
import { startMarketPoller } from '../scoring/memetic/workers/market-poller.js';
import { startCelebrityMonitor } from '../scoring/memetic/workers/celebrity-monitor.js';
import { startMindshareTracker } from '../scoring/memetic/workers/mindshare-tracker.js';

// Pre-filter threshold
const QUICK_SCORE_THRESHOLD = 0.40;

// Known rug signals
const KNOWN_RUG_DEVS = new Set();
const STOLEN_ART_HASHES = new Set();

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
 * Load blacklists from Redis (call once at startup)
 */
export async function loadBlacklists() {
  try {
    const r = await getRedis();
    if (!r) return;
    const rugDevs = await r.sMembers('blacklist:rug_devs');
    for (const dev of (rugDevs || [])) KNOWN_RUG_DEVS.add(dev);
    const artHashes = await r.sMembers('blacklist:stolen_art');
    for (const hash of (artHashes || [])) STOLEN_ART_HASHES.add(hash);
    console.log(`[memetic] Loaded ${KNOWN_RUG_DEVS.size} rug devs, ${STOLEN_ART_HASHES.size} stolen art hashes`);
  } catch {}
}

/**
 * Quick pre-filter using fast modules only (<50ms target).
 * Returns { pass, quickScore, reason }
 *
 * @param {Object} token - PumpPortal token data
 * @param {string} token.ca - Token address
 * @param {string} token.name - Token name
 * @param {string} token.ticker - Token symbol
 * @param {string} token.devWallet - Dev wallet address
 */
export async function quickFilterMemetic(token) {
  const { ca, name, ticker, devWallet } = token;

  // Known rug dev
  if (devWallet && KNOWN_RUG_DEVS.has(devWallet)) {
    return { pass: false, reason: 'known_rug_dev', quickScore: 0 };
  }

  // Quick memetic score (linguistic + absurdity + temporal)
  const quickResult = await scoreMemeticQuick({ name: name || '', symbol: ticker || '' });
  if (quickResult.quickScore < QUICK_SCORE_THRESHOLD) {
    return { pass: false, reason: 'low_quick_score', quickScore: quickResult.quickScore };
  }

  return { pass: true, quickScore: quickResult.quickScore, quickResult };
}

/**
 * Full memetic score for a token (<200ms target).
 * Uses PumpPortal data only — no Alchemy calls.
 *
 * @param {Object} token - PumpPortal radar token object
 * @param {string} token.ca - Token address
 * @param {string} token.name - Token name
 * @param {string} token.ticker - Token symbol
 * @param {string} token.description - Token description
 * @param {string} token.image - Token image URI
 * @param {string} token.twitter - Twitter handle
 * @param {string} token.website - Website URL
 * @param {string} token.telegram - Telegram link
 * @param {string} token.devWallet - Dev wallet
 * @param {number} token.buys - Buy count
 * @param {number} token.sells - Sell count
 * @param {number} token.uniqueBuyers - Unique buyer count (or Set)
 * @param {number} token.mcapUsd - Market cap in USD
 * @param {number} token.volumeSol - Volume in SOL
 * @returns {Object} Full memetic score result
 */
export async function scoreTokenMemetic(token) {
  const startTime = Date.now();

  try {
    const name = token.name || '';
    const symbol = token.ticker || '';
    const description = (token.description || '').slice(0, 200);
    const imageUri = token.image || '';
    const uniqueBuyers = token.uniqueBuyers instanceof Set ? token.uniqueBuyers.size : (token.uniqueBuyers || 0);

    // Register for trend tracking (non-blocking)
    registerTokenForTrends(token.ca, name, symbol).catch(() => {});
    recordLaunch().catch(() => {});

    // Compute a lightweight on-chain score from PumpPortal trade data
    const buys = token.buys || 0;
    const sells = token.sells || 0;
    const totalTxns = buys + sells;
    const buyRatio = totalTxns > 0 ? buys / totalTxns : 0.5;
    const mcap = token.mcapUsd || 0;

    // Volume legitimacy — fee accrual rate + organic volume detection
    const volLeg = scoreVolumeLegitimacy(token);
    token._volumeLegitimacy = volLeg;
    const volLegScore = volLeg.legitimacyScore / 100; // normalize to 0-1

    // On-chain heuristic: buy pressure + unique buyers + mcap sweet spot + volume legitimacy
    const buyPressureScore = Math.min(1, buyRatio * 1.2);
    const buyerDiversityScore = Math.min(1, uniqueBuyers / 20);
    const mcapScore = mcap > 0 && mcap < 100000 ? 0.7 : mcap >= 100000 && mcap < 500000 ? 0.5 : 0.3;
    // Volume legitimacy gets 20% weight — real volume is a strong signal
    const onChainScore = Math.min(1, buyPressureScore * 0.30 + buyerDiversityScore * 0.25 + mcapScore * 0.25 + volLegScore * 0.20);

    const scoreResult = await scoreMemeticAll({
      name, symbol, description, imageUri,
      tokenAddress: token.ca,
      alchemy: null, // No Alchemy
      onChainScore,
      communityData: {
        totalMembers: uniqueBuyers,
        activeMembers: Math.round(uniqueBuyers * 0.7),
      },
      socialData: {
        twitter: token.twitter || undefined,
        telegram: token.telegram || undefined,
        website: token.website || undefined,
      },
      devData: {},
    });

    return {
      ...scoreResult,
      elapsed: Date.now() - startTime,
      onChainScore,
      volumeLegitimacy: {
        score: volLeg.legitimacyScore,
        label: volLeg.legitimacy,
        feePerSec: volLeg.feeRate.feePerSec,
        feeRating: volLeg.feeRate.feeRating,
        botScore: volLeg.botDetection.botScore,
        organicScore: volLeg.botDetection.organicScore,
        botSignals: volLeg.botDetection.signals,
      },
    };
  } catch (err) {
    console.error('[memetic] scoreTokenMemetic error:', err.message);
    return {
      finalScore: 0.5,
      memeticScore: 0.5,
      archetype: 'noise',
      moduleScores: {},
      interactionBonuses: [],
      elapsed: Date.now() - startTime,
    };
  }
}

/**
 * Start background workers (trend poller, KOL monitor, etc.)
 * Returns array of timer IDs for cleanup.
 */
export function startMemeticWorkers() {
  const workers = [];
  try {
    workers.push(startTrendPoller());
    workers.push(startMarketPoller());
    workers.push(startCelebrityMonitor());
    workers.push(startMindshareTracker());
    const kolTimers = startKolMonitor();
    workers.push(kolTimers.pollTimer);
    workers.push(kolTimers.dailyTimer);
    console.log('[memetic] Background workers started');
  } catch (err) {
    console.error('[memetic] Error starting workers:', err.message);
  }
  return workers;
}

/**
 * MemeticPipeline class — backward-compatible wrapper.
 * Now accepts PumpPortal token data directly instead of Alchemy events.
 */
export class MemeticPipeline extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.workers = [];
    this.stats = {
      tokensScanned: 0,
      tokensPreFiltered: 0,
      tokensFullScored: 0,
      startTime: Date.now()
    };
  }

  async start() {
    console.log('[memetic] Pipeline started (PumpPortal mode — no Alchemy)');
    await loadBlacklists();
    this.workers = startMemeticWorkers();
    this.emit('started');
  }

  /**
   * Score a token from PumpPortal data. Called by server when a new token
   * is created or when scoring is needed.
   */
  async scoreToken(token) {
    this.stats.tokensScanned++;

    // Quick filter first
    const filter = await quickFilterMemetic(token);
    if (!filter.pass) {
      this.emit('token_filtered', {
        tokenAddress: token.ca, name: token.name, symbol: token.ticker,
        reason: filter.reason, quickScore: filter.quickScore
      });
      return null;
    }
    this.stats.tokensPreFiltered++;

    // Full score
    const result = await scoreTokenMemetic(token);
    this.stats.tokensFullScored++;

    return result;
  }

  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime,
    };
  }

  async shutdown() {
    for (const timer of this.workers) {
      if (timer) clearInterval(timer);
    }
    if (redis) await redis.quit().catch(() => {});
    this.emit('stopped');
  }
}

export { logTradeOutcome, recordGraduation, scoreMemeticQuick };
export default MemeticPipeline;
