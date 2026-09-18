/**
 * ═══════════════════════════════════════════════════════════════
 * RESURGENCE SCANNER — Find Older Coins Having a Second Life
 * ═══════════════════════════════════════════════════════════════
 *
 * Discovers tokens aged 12 hours to 2 years that are showing renewed
 * momentum. Specifically looks for:
 *
 *   1. SMART MONEY INFLOW: S/A-tier wallets accumulating old tokens
 *   2. COMMUNITY GROWTH: Rising holder count, diverse new buyers
 *   3. SOCIAL REVIVAL: New tweets, growing mentions, KOL attention
 *   4. VOLUME SPIKE: Unusual volume relative to recent baseline
 *   5. PRICE REVERSAL: Bottoming pattern with higher lows
 *
 * Scoring weights (sum = 1.0):
 *   smartMoney:     0.25  — strongest alpha signal for revivals
 *   communityGrowth: 0.25 — new diverse holders = organic interest
 *   socialRevival:   0.20 — tweets, mentions, KOL cascade
 *   volumeSpike:     0.15 — unusual volume vs baseline
 *   priceReversal:   0.15 — bottoming / higher lows pattern
 *
 * Data sources:
 *   - DexScreener API (token age, volume, price changes, liquidity)
 *   - Birdeye API (trending older tokens, holder data)
 *   - SmartMoneyTracker (wallet convergence on old tokens)
 *   - X Social Intel (tweet activity for token)
 *
 * ═══════════════════════════════════════════════════════════════
 */

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const BIRDEYE_BASE = "https://public-api.birdeye.so";
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || "";

// Age bounds (ms)
const MIN_AGE_MS = 12 * 60 * 60 * 1000;        // 12 hours
const MAX_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000; // 2 years

// Resurgence scoring weights
const RESURGENCE_WEIGHTS = {
  smartMoney:      0.25,
  communityGrowth: 0.25,
  socialRevival:   0.20,
  volumeSpike:     0.15,
  priceReversal:   0.15,
};

// Age tier bonuses — older coins with real resurgence are rarer and more significant
const AGE_TIER_BONUS = {
  hours:  0.00, // 12h-24h — barely "old", no bonus
  days:   0.05, // 1-7 days
  weeks:  0.10, // 1-4 weeks
  months: 0.15, // 1-6 months — sweet spot for revivals
  old:    0.10, // 6mo-2y — impressive if real, but more risk
};

function getAgeTier(ageMs) {
  if (ageMs < 24 * 3600 * 1000) return "hours";
  if (ageMs < 7 * 24 * 3600 * 1000) return "days";
  if (ageMs < 30 * 24 * 3600 * 1000) return "weeks";
  if (ageMs < 180 * 24 * 3600 * 1000) return "months";
  return "old";
}

// ── Helpers ──
async function jfetch(url, headers = {}, timeout = 10000) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

function birdHeaders() {
  return BIRDEYE_KEY
    ? { "X-API-KEY": BIRDEYE_KEY, Accept: "application/json" }
    : { Accept: "application/json" };
}

// ═══════════════════════════════════════
// DATA FETCHING — Find candidate tokens
// ═══════════════════════════════════════

/**
 * DexScreener: search for Solana tokens with high recent volume
 * that were created >12h ago. Sorted by volume to catch spikes.
 */
async function fetchDexScreenerOlderMovers() {
  // Search for pump.fun tokens with volume — DexScreener returns by relevance/volume
  const d = await jfetch(`${DEXSCREENER_BASE}/latest/dex/search?q=pump.fun%20raydium`);
  if (!d?.pairs) return [];

  const now = Date.now();
  const byToken = new Map();

  for (const p of d.pairs) {
    if (p.chainId !== "solana") continue;
    if (!p.fdv || p.fdv < 10000) continue; // min $10K mcap
    if ((p.liquidity?.usd || 0) < 5000) continue; // min $5K liquidity

    const ca = p.baseToken?.address;
    if (!ca) continue;

    // Check age — must be between 12h and 2y
    const ageMs = p.pairCreatedAt ? now - p.pairCreatedAt : 0;
    if (ageMs < MIN_AGE_MS || ageMs > MAX_AGE_MS) continue;

    const existing = byToken.get(ca);
    if (!existing || (p.volume?.h24 || 0) > (existing.volume?.h24 || 0)) {
      byToken.set(ca, p);
    }
  }

  return [...byToken.values()]
    .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
    .slice(0, 40)
    .map(p => ({
      ca: p.baseToken?.address,
      name: p.baseToken?.name || "?",
      ticker: p.baseToken?.symbol || "?",
      priceUsd: parseFloat(p.priceUsd || 0),
      mcapUsd: p.fdv || 0,
      volume24h: p.volume?.h24 || 0,
      volume6h: p.volume?.h6 || 0,
      volume1h: p.volume?.h1 || 0,
      change24h: p.priceChange?.h24 || 0,
      change6h: p.priceChange?.h6 || 0,
      change1h: p.priceChange?.h1 || 0,
      change5m: p.priceChange?.m5 || 0,
      liquidity: p.liquidity?.usd || 0,
      pairCreated: p.pairCreatedAt,
      ageMs: p.pairCreatedAt ? now - p.pairCreatedAt : 0,
      txns24h: p.txns?.h24 || {},
      txns6h: p.txns?.h6 || {},
      txns1h: p.txns?.h1 || {},
      dexUrl: p.url,
      image: p.info?.imageUrl || null,
      website: p.info?.websites?.[0]?.url || null,
      twitter: p.info?.socials?.find(s => s.type === "twitter")?.url || null,
      telegram: p.info?.socials?.find(s => s.type === "telegram")?.url || null,
      source: "dexscreener-older",
    }));
}

/**
 * DexScreener: top boosted tokens that are older than 12h
 */
async function fetchBoostedOlderTokens() {
  const d = await jfetch(`${DEXSCREENER_BASE}/token-boosts/top/v1`);
  if (!d || !Array.isArray(d)) return [];

  const now = Date.now();
  const results = [];

  for (const t of d) {
    if (t.chainId !== "solana") continue;
    // Fetch details for age check (boosted endpoint doesn't have pair age)
    results.push({
      ca: t.tokenAddress,
      name: t.description || t.tokenAddress?.slice(0, 8),
      totalBoostAmount: t.totalAmount || 0,
      icon: t.icon,
      source: "dexscreener-boosted-older",
    });
  }

  return results.slice(0, 20);
}

/**
 * Birdeye: tokens sorted by 24h volume change — catches volume spikes
 */
async function fetchBirdeyeVolumeSpikes() {
  if (!BIRDEYE_KEY) return [];
  const d = await jfetch(
    `${BIRDEYE_BASE}/defi/token_list?sort_by=v24hChangePercent&sort_type=desc&offset=0&limit=50&min_liquidity=5000`,
    birdHeaders()
  );
  if (!d?.data?.tokens) return [];

  const now = Date.now();
  return d.data.tokens
    .filter(t => {
      // We need to check age downstream since Birdeye doesn't always provide creation time
      return (t.v24hUSD || 0) > 1000; // min volume
    })
    .map(t => ({
      ca: t.address,
      name: t.name || "?",
      ticker: t.symbol || "?",
      priceUsd: t.price || 0,
      mcapUsd: t.mc || 0,
      volume24h: t.v24hUSD || 0,
      volumeChange24h: t.v24hChangePercent || 0,
      change24h: t.v24hChangePercent || 0,
      liquidity: t.liquidity || 0,
      image: t.logoURI || null,
      source: "birdeye-volume-spike",
    }));
}

/**
 * Fetch detailed token data from DexScreener for age verification + enrichment
 */
async function fetchTokenDetail(ca) {
  const d = await jfetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${ca}`);
  if (!d?.pairs?.length) return null;
  const p = d.pairs[0];
  const now = Date.now();
  const ageMs = p.pairCreatedAt ? now - p.pairCreatedAt : 0;

  return {
    ca,
    name: p.baseToken?.name || "?",
    ticker: p.baseToken?.symbol || "?",
    priceUsd: parseFloat(p.priceUsd || 0),
    mcapUsd: p.fdv || 0,
    volume24h: p.volume?.h24 || 0,
    volume6h: p.volume?.h6 || 0,
    volume1h: p.volume?.h1 || 0,
    change24h: p.priceChange?.h24 || 0,
    change6h: p.priceChange?.h6 || 0,
    change1h: p.priceChange?.h1 || 0,
    change5m: p.priceChange?.m5 || 0,
    liquidity: p.liquidity?.usd || 0,
    pairCreated: p.pairCreatedAt,
    ageMs,
    txns24h: p.txns?.h24 || {},
    txns6h: p.txns?.h6 || {},
    txns1h: p.txns?.h1 || {},
    dexUrl: p.url,
    image: p.info?.imageUrl || null,
    website: p.info?.websites?.[0]?.url || null,
    twitter: p.info?.socials?.find(s => s.type === "twitter")?.url || null,
    telegram: p.info?.socials?.find(s => s.type === "telegram")?.url || null,
  };
}

// ═══════════════════════════════════════
// RESURGENCE SCORING
// ═══════════════════════════════════════

/**
 * Score a token's resurgence potential.
 *
 * @param {Object} token - Enriched token data
 * @param {Object} opts
 * @param {Object} opts.smartMoneyTracker - SmartMoneyTracker instance
 * @returns {Object} { resurgenceScore, features, signal, ageTier }
 */
function scoreResurgence(token, { smartMoneyTracker = null } = {}) {
  const features = {};
  const now = Date.now();

  // ── 1. SMART MONEY (0.25) ──
  // Check if smart wallets are accumulating this token
  let smartMoneyScore = 0;
  if (smartMoneyTracker) {
    const sm = smartMoneyTracker.getSmartMoneyScore(token.ca);
    smartMoneyScore = sm.score || 0;
    features.smartMoneyWallets = sm.walletCount || 0;
    features.smartMoneyTopTier = sm.topTier || null;
    features.smartMoneyConvergence = sm.convergence || false;
    // Convergence on an OLD token is extremely bullish — bonus
    if (sm.convergence && token.ageMs > 24 * 3600 * 1000) {
      smartMoneyScore = Math.min(1, smartMoneyScore * 1.3);
    }
  }
  features.smartMoney = +smartMoneyScore.toFixed(3);

  // ── 2. COMMUNITY GROWTH (0.25) ──
  // Proxy via transaction diversity: buys vs sells ratio, unique buyer count
  const buys24h = token.txns24h?.buys || 0;
  const sells24h = token.txns24h?.sells || 0;
  const buys6h = token.txns6h?.buys || 0;
  const sells6h = token.txns6h?.sells || 0;
  const buys1h = token.txns1h?.buys || 0;
  const sells1h = token.txns1h?.sells || 0;

  // Buy pressure: more buys than sells = accumulation
  const buyRatio24h = (buys24h + sells24h) > 0 ? buys24h / (buys24h + sells24h) : 0.5;
  const buyRatio1h = (buys1h + sells1h) > 0 ? buys1h / (buys1h + sells1h) : 0.5;

  // Acceleration: 1h buy activity vs 24h average
  const avg1hBuys = buys24h / 24;
  const buyAcceleration = avg1hBuys > 0 ? buys1h / avg1hBuys : 0;

  // Total transaction count as proxy for community size
  const totalTxns = buys24h + sells24h;
  const txnScore = Math.min(1, totalTxns / 500); // 500+ txns in 24h = max

  // Community growth score
  const communityGrowthScore = Math.min(1,
    (buyRatio24h > 0.5 ? (buyRatio24h - 0.5) * 2 : 0) * 0.25 + // buy dominance
    (buyRatio1h > 0.6 ? (buyRatio1h - 0.5) * 2 : 0) * 0.20 +   // recent buy pressure
    Math.min(1, buyAcceleration / 3) * 0.30 +                     // accelerating buys
    txnScore * 0.25                                                // total activity
  );
  features.communityGrowth = +communityGrowthScore.toFixed(3);
  features.buyRatio24h = +buyRatio24h.toFixed(3);
  features.buyRatio1h = +buyRatio1h.toFixed(3);
  features.buyAcceleration = +buyAcceleration.toFixed(2);
  features.totalTxns24h = totalTxns;

  // ── 3. SOCIAL REVIVAL (0.20) ──
  // Check for social presence + activity signals
  let socialScore = 0;

  // Has social links at all (many dead coins lose these)
  const hasTwitter = !!token.twitter;
  const hasTelegram = !!token.telegram;
  const hasWebsite = !!token.website;
  const socialPresence = (hasTwitter ? 0.4 : 0) + (hasTelegram ? 0.3 : 0) + (hasWebsite ? 0.3 : 0);

  // Boosted tokens have active communities paying for visibility
  const boostScore = token.totalBoostAmount ? Math.min(1, token.totalBoostAmount / 500) : 0;

  socialScore = Math.min(1,
    socialPresence * 0.50 +
    boostScore * 0.50
  );

  features.socialRevival = +socialScore.toFixed(3);
  features.hasTwitter = hasTwitter;
  features.hasTelegram = hasTelegram;
  features.hasWebsite = hasWebsite;
  features.boostAmount = token.totalBoostAmount || 0;

  // ── 4. VOLUME SPIKE (0.15) ──
  // Compare recent volume to baseline — a spike indicates renewed interest
  const vol24h = token.volume24h || 0;
  const vol6h = token.volume6h || 0;
  const vol1h = token.volume1h || 0;

  // Volume concentration: if 1h vol is high fraction of 24h vol, activity is recent
  const volConcentration1h = vol24h > 0 ? (vol1h / vol24h) * 24 : 0; // normalized: 1.0 = even, >1 = concentrated
  const volConcentration6h = vol24h > 0 ? (vol6h / vol24h) * 4 : 0;

  // Volume relative to mcap (turnover) — high turnover = active trading
  const turnover = token.mcapUsd > 0 ? vol24h / token.mcapUsd : 0;

  const volumeSpikeScore = Math.min(1,
    Math.min(1, volConcentration1h / 3) * 0.35 +   // recent volume concentration
    Math.min(1, volConcentration6h / 2) * 0.25 +   // 6h volume concentration
    Math.min(1, turnover / 2) * 0.25 +              // turnover ratio
    (vol24h > 50000 ? 0.15 : vol24h > 10000 ? 0.10 : vol24h > 1000 ? 0.05 : 0) // absolute volume floor
  );
  features.volumeSpike = +volumeSpikeScore.toFixed(3);
  features.volume24h = vol24h;
  features.volume1h = vol1h;
  features.volConcentration1h = +volConcentration1h.toFixed(2);
  features.turnover = +turnover.toFixed(3);

  // ── 5. PRICE REVERSAL (0.15) ──
  // Look for bottoming pattern: short-term up, longer-term may still be down
  const c1h = token.change1h || 0;
  const c6h = token.change6h || 0;
  const c24h = token.change24h || 0;
  const c5m = token.change5m || 0;

  // Classic resurgence pattern: 24h may be flat/down, but 1h/6h turning up
  let reversalScore = 0;

  // Short-term momentum (1h positive is key)
  if (c1h > 0) reversalScore += Math.min(0.35, (c1h / 50) * 0.35);
  // 6h momentum
  if (c6h > 0) reversalScore += Math.min(0.25, (c6h / 100) * 0.25);
  // V-shape reversal: 24h down but 1h up = bottoming
  if (c24h < 0 && c1h > 5) reversalScore += 0.20;
  // Acceleration: 5m positive means live momentum
  if (c5m > 0 && c1h > 0) reversalScore += 0.10;
  // Sustained reversal: 6h up AND 1h up
  if (c6h > 5 && c1h > 0) reversalScore += 0.10;

  reversalScore = Math.min(1, reversalScore);
  features.priceReversal = +reversalScore.toFixed(3);
  features.change1h = c1h;
  features.change6h = c6h;
  features.change24h = c24h;

  // ── COMPOSITE SCORE ──
  let baseScore =
    smartMoneyScore * RESURGENCE_WEIGHTS.smartMoney +
    communityGrowthScore * RESURGENCE_WEIGHTS.communityGrowth +
    socialScore * RESURGENCE_WEIGHTS.socialRevival +
    volumeSpikeScore * RESURGENCE_WEIGHTS.volumeSpike +
    reversalScore * RESURGENCE_WEIGHTS.priceReversal;

  // Age tier bonus — older real revivals are rarer
  const ageTier = getAgeTier(token.ageMs);
  const ageBonus = AGE_TIER_BONUS[ageTier] || 0;
  baseScore = Math.min(1, baseScore + ageBonus);

  // Interaction bonus: smart money + community growth both high = very bullish
  if (smartMoneyScore > 0.5 && communityGrowthScore > 0.5) {
    baseScore = Math.min(1, baseScore * 1.15);
    features.bonus = "smart_community_convergence";
  }

  // Interaction bonus: volume spike + price reversal = breakout
  if (volumeSpikeScore > 0.5 && reversalScore > 0.5) {
    baseScore = Math.min(1, baseScore * 1.10);
    features.bonus = features.bonus ? features.bonus + "+breakout_signal" : "breakout_signal";
  }

  // Classify signal
  let signal = "WATCH";
  if (baseScore >= 0.65) signal = "STRONG_RESURGENCE";
  else if (baseScore >= 0.45) signal = "RESURGENCE";
  else if (baseScore >= 0.30) signal = "WATCH";
  else signal = "WEAK";

  // Classify resurgence type
  let resurgenceType = "general";
  if (smartMoneyScore > 0.5 && smartMoneyScore >= communityGrowthScore) resurgenceType = "smart_money_accumulation";
  else if (communityGrowthScore > 0.5 && buyAcceleration > 2) resurgenceType = "community_revival";
  else if (volumeSpikeScore > 0.6 && reversalScore > 0.4) resurgenceType = "volume_breakout";
  else if (socialScore > 0.5) resurgenceType = "social_resurgence";

  return {
    resurgenceScore: +baseScore.toFixed(3),
    features,
    signal,
    ageTier,
    ageBonus,
    resurgenceType,
  };
}

// ═══════════════════════════════════════
// MAIN SCANNER CLASS
// ═══════════════════════════════════════

export class ResurgenceScanner {
  constructor({ redis = null, smartMoneyTracker = null } = {}) {
    this.redis = redis;
    this.smartMoneyTracker = smartMoneyTracker;
    this._cache = {};
    this.CACHE_TTL = 60; // 1 min cache — fresher data for resurgence detection
    this.lastResults = [];
    this.lastScanTime = 0;
  }

  async _getCached(key) {
    if (this.redis) {
      try { const v = await this.redis.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
    }
    const c = this._cache[key];
    if (c && Date.now() - c.ts < this.CACHE_TTL * 1000) return c.data;
    return null;
  }

  async _setCache(key, data) {
    if (this.redis) {
      try { await this.redis.set(key, JSON.stringify(data), { EX: this.CACHE_TTL }); } catch {}
    }
    this._cache[key] = { data, ts: Date.now() };
  }

  /**
   * Main scan: find and score older tokens with resurgence signals.
   * Returns sorted list of scored tokens.
   */
  async scan() {
    const cacheKey = "resurgence:scan";
    const cached = await this._getCached(cacheKey);
    if (cached) {
      this.lastResults = cached.tokens || [];
      return cached;
    }

    const now = Date.now();

    // Fetch candidates from multiple sources in parallel
    const [olderMovers, boosted, volumeSpikes] = await Promise.all([
      fetchDexScreenerOlderMovers().catch(() => []),
      fetchBoostedOlderTokens().catch(() => []),
      fetchBirdeyeVolumeSpikes().catch(() => []),
    ]);

    // Merge and deduplicate by CA
    const seen = new Map();
    for (const list of [olderMovers, volumeSpikes, boosted]) {
      for (const t of list) {
        if (!t.ca) continue;
        // Normalize: boosted tokens use "icon" instead of "image"
        if (t.icon && !t.image) t.image = t.icon;
        const existing = seen.get(t.ca);
        if (!existing || (t.volume24h && !existing.volume24h) || (t.mcapUsd && !existing.mcapUsd)) {
          const merged = { ...existing, ...t };
          // Preserve image from either source
          merged.image = merged.image || existing?.image || t.icon || null;
          seen.set(t.ca, merged);
        }
      }
    }

    // Enrich tokens that need age verification (e.g., from Birdeye which lacks pairCreatedAt)
    const candidates = [...seen.values()];
    const needsEnrichment = candidates.filter(t => !t.ageMs || t.ageMs === 0);
    if (needsEnrichment.length > 0) {
      const enrichBatch = needsEnrichment.slice(0, 15); // limit to avoid rate limits
      const enriched = await Promise.all(
        enrichBatch.map(t => fetchTokenDetail(t.ca).catch(() => null))
      );
      for (const detail of enriched) {
        if (detail && detail.ca) {
          const existing = seen.get(detail.ca);
          seen.set(detail.ca, { ...existing, ...detail });
        }
      }
    }

    // Filter to only tokens in the age range
    const ageFiltered = [...seen.values()].filter(t => {
      return t.ageMs >= MIN_AGE_MS && t.ageMs <= MAX_AGE_MS;
    });

    // Score each token
    const scored = ageFiltered.map(t => {
      const scoring = scoreResurgence(t, { smartMoneyTracker: this.smartMoneyTracker });
      return {
        ...t,
        ...scoring,
        score: scoring.resurgenceScore,
      };
    });

    // Sort by resurgence score
    scored.sort((a, b) => b.resurgenceScore - a.resurgenceScore);

    // Take top 30
    const tokens = scored.slice(0, 30).map(t => {
      // Fallback image: try DexScreener token image URL if we still have nothing
      if (!t.image && t.ca) {
        t.image = `https://dd.dexscreener.com/ds-data/tokens/solana/${t.ca}.png`;
      }
      return t;
    });

    // If scan yielded nothing but we have previous good results, return those
    // (API rate limits / transient failures shouldn't blank out the tab)
    if (tokens.length === 0 && this.lastResults.length > 0) {
      const staleSec = Math.round((now - this.lastScanTime) / 1000);
      return {
        tokens: this.lastResults,
        totalCandidates: 0,
        ageFiltered: 0,
        strongResurgence: this.lastResults.filter(t => t.signal === "STRONG_RESURGENCE").length,
        resurgence: this.lastResults.filter(t => t.signal === "RESURGENCE").length,
        scannedAt: this.lastScanTime,
        stale: true,
        staleSec,
      };
    }

    const result = {
      tokens,
      totalCandidates: candidates.length,
      ageFiltered: ageFiltered.length,
      strongResurgence: tokens.filter(t => t.signal === "STRONG_RESURGENCE").length,
      resurgence: tokens.filter(t => t.signal === "RESURGENCE").length,
      scannedAt: now,
    };

    this.lastResults = tokens;
    this.lastScanTime = now;
    await this._setCache(cacheKey, result);
    return result;
  }

  /**
   * Get a single token's resurgence score with fresh data.
   */
  async scoreToken(ca) {
    const detail = await fetchTokenDetail(ca);
    if (!detail) return null;
    if (detail.ageMs < MIN_AGE_MS || detail.ageMs > MAX_AGE_MS) {
      return { error: "Token age out of range", ageMs: detail.ageMs };
    }
    return {
      ...detail,
      ...scoreResurgence(detail, { smartMoneyTracker: this.smartMoneyTracker }),
    };
  }
}

export { scoreResurgence, RESURGENCE_WEIGHTS, MIN_AGE_MS, MAX_AGE_MS };
export default ResurgenceScanner;
