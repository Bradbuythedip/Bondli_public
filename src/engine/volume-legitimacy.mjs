// BONDLI — Volume Legitimacy Scorer
//
// Core insight: PumpFun charges 1% fee on every trade.
// Real volume = real fees accrued per second.
// Higher fee/sec with organic patterns = more legitimate token.
//
// Botted volume red flags:
//   - Uniform trade sizes (CV < 0.2)
//   - Regular timing intervals (CV < 0.3)
//   - Few unique wallets generating bulk of volume
//   - Buy-only volume (no sells = self-bought)
//   - Volume/unique-wallet ratio too high (one wallet doing everything)
//
// Organic volume signals:
//   - Diverse trade sizes (CV > 0.5)
//   - Irregular timing (CV > 0.6)
//   - Many unique wallets
//   - Healthy buy/sell mix
//   - Fee accrual rate scales with age (not just a spike)

const PUMPFUN_FEE_RATE = 0.01; // 1% per trade

/**
 * Calculate fee accrual rate (fees per second) from volume and token age.
 * This is the core legitimacy signal — real projects generate sustained fees.
 *
 * @param {number} volumeSol - Total volume in SOL
 * @param {number} ageSeconds - Token age in seconds
 * @returns {{ feePerSec: number, feeTotal: number, feeRating: string }}
 */
function calcFeeRate(volumeSol, ageSeconds) {
  const feeTotal = volumeSol * PUMPFUN_FEE_RATE;
  const feePerSec = ageSeconds > 0 ? feeTotal / ageSeconds : 0;

  // Rating thresholds (SOL fees per second)
  // Top coins: >0.01 SOL/sec in fees = serious volume
  // Good coins: 0.001–0.01 SOL/sec
  // Low coins: <0.001 SOL/sec
  let feeRating;
  if (feePerSec >= 0.01) feeRating = "ELITE";       // ~1 SOL/sec volume → monster
  else if (feePerSec >= 0.003) feeRating = "HIGH";   // sustained real trading
  else if (feePerSec >= 0.001) feeRating = "MODERATE";
  else if (feePerSec >= 0.0003) feeRating = "LOW";
  else feeRating = "DEAD";

  return { feePerSec, feeTotal, feeRating };
}

/**
 * Detect botted/fake volume patterns from trade data.
 *
 * @param {Object} tradeProfile
 * @param {number} tradeProfile.totalBuys - Total buy count
 * @param {number} tradeProfile.totalSells - Total sell count
 * @param {number} tradeProfile.uniqueBuyers - Unique buyer wallet count
 * @param {number} tradeProfile.uniqueSellers - Unique seller wallet count
 * @param {number[]} [tradeProfile.tradeSizes] - Array of trade sizes in SOL
 * @param {number[]} [tradeProfile.tradeTimestamps] - Array of trade timestamps
 * @param {number} tradeProfile.volumeSol - Total volume in SOL
 * @returns {{ botScore: number, signals: string[], organicScore: number }}
 */
function detectBotVolume(tradeProfile) {
  const {
    totalBuys = 0, totalSells = 0,
    uniqueBuyers = 0, uniqueSellers = 0,
    tradeSizes = [], tradeTimestamps = [],
    volumeSol = 0,
  } = tradeProfile;

  const signals = [];
  let botScore = 0;
  const totalTrades = totalBuys + totalSells;

  if (totalTrades < 3) {
    return { botScore: 0, signals: ["INSUFFICIENT_DATA"], organicScore: 0.5 };
  }

  // ── 1. Wallet concentration: volume per unique wallet ──
  // Organic: many wallets each doing modest volume
  // Botted: few wallets generating enormous volume
  const uniqueWallets = uniqueBuyers + uniqueSellers;
  const volPerWallet = uniqueWallets > 0 ? volumeSol / uniqueWallets : volumeSol;
  const tradesPerWallet = uniqueWallets > 0 ? totalTrades / uniqueWallets : totalTrades;

  if (tradesPerWallet > 15) {
    signals.push("WHALE_WALLET_SPAM");
    botScore += 25;
  } else if (tradesPerWallet > 8) {
    signals.push("HIGH_TRADES_PER_WALLET");
    botScore += 12;
  }

  if (uniqueBuyers > 0 && uniqueBuyers <= 3 && totalBuys >= 10) {
    signals.push("FEW_WALLETS_MANY_BUYS");
    botScore += 30;
  }

  // ── 2. Trade size uniformity ──
  // Bots use fixed or near-fixed trade sizes
  // Real traders have varied sizes
  if (tradeSizes.length >= 5) {
    const avgSize = tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length;
    if (avgSize > 0) {
      const variance = tradeSizes.reduce((s, v) => s + (v - avgSize) ** 2, 0) / tradeSizes.length;
      const cv = Math.sqrt(variance) / avgSize;
      if (cv < 0.15) {
        signals.push("UNIFORM_TRADE_SIZES");
        botScore += 30;
      } else if (cv < 0.25) {
        signals.push("SIMILAR_TRADE_SIZES");
        botScore += 15;
      }
      // Bonus for diverse sizes — organic signal
      if (cv > 0.8) {
        botScore -= 5;
      }
    }
  }

  // ── 3. Timing regularity ──
  // Bots fire at metronomic intervals
  // Real traders are random
  if (tradeTimestamps.length >= 5) {
    const sorted = [...tradeTimestamps].sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(sorted[i] - sorted[i - 1]);
    }
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (avgInterval > 0) {
      const variance = intervals.reduce((s, d) => s + (d - avgInterval) ** 2, 0) / intervals.length;
      const cv = Math.sqrt(variance) / avgInterval;
      if (cv < 0.2) {
        signals.push("METRONOMIC_TIMING");
        botScore += 25;
      } else if (cv < 0.35) {
        signals.push("REGULAR_TIMING");
        botScore += 10;
      }
    }

    // Burst detection: many trades in very short window then silence
    const totalSpan = sorted[sorted.length - 1] - sorted[0];
    if (totalSpan > 0) {
      // Check if >60% of trades happen in <20% of the time span
      const windowSize = totalSpan * 0.2;
      let maxInWindow = 0;
      for (let i = 0; i < sorted.length; i++) {
        let count = 0;
        for (let j = i; j < sorted.length && sorted[j] - sorted[i] <= windowSize; j++) {
          count++;
        }
        maxInWindow = Math.max(maxInWindow, count);
      }
      if (maxInWindow / sorted.length > 0.7 && sorted.length >= 8) {
        signals.push("VOLUME_BURST_CLUSTER");
        botScore += 15;
      }
    }
  }

  // ── 4. Buy/sell imbalance ──
  // Real volume has sells too — people taking profit
  // All buys, no sells = self-bought pump
  if (totalBuys >= 8 && totalSells === 0) {
    signals.push("ZERO_SELL_VOLUME");
    botScore += 20;
  } else if (totalBuys >= 10 && totalSells <= 1) {
    signals.push("NEAR_ZERO_SELL_VOLUME");
    botScore += 12;
  }

  // Healthy sell ratio is actually a GOOD sign (organic churn)
  if (totalBuys > 5 && totalSells > 0) {
    const sellRatio = totalSells / totalBuys;
    if (sellRatio >= 0.15 && sellRatio <= 0.6) {
      // Healthy organic range — some profit taking but not dumping
      botScore -= 8;
    }
  }

  // ── 5. Buyer diversity relative to volume ──
  // Real high-volume tokens have proportionally more unique buyers
  if (volumeSol > 5 && uniqueBuyers < 5) {
    signals.push("HIGH_VOL_LOW_DIVERSITY");
    botScore += 20;
  } else if (volumeSol > 20 && uniqueBuyers < 10) {
    signals.push("EXTREME_VOL_LOW_DIVERSITY");
    botScore += 25;
  }

  // Good diversity signal
  if (uniqueBuyers >= 15 && totalBuys >= 20) {
    botScore -= 10;
  }

  botScore = Math.max(0, Math.min(100, botScore));
  const organicScore = Math.max(0, Math.min(1, 1 - botScore / 100));

  return { botScore, signals, organicScore };
}

/**
 * Combined volume legitimacy score.
 * Merges fee accrual rate with organic volume detection.
 *
 * @param {Object} token
 * @param {number} token.volumeSol - Total volume in SOL
 * @param {number} token.volume24h - 24h volume (USD, from dexscreener)
 * @param {number} token.mcapUsd - Market cap USD
 * @param {number} [token.pairCreated] - Pair creation timestamp
 * @param {number} [token.createdAt] - Token creation timestamp
 * @param {number} token.buys - Buy count
 * @param {number} token.sells - Sell count
 * @param {number} token.uniqueBuyers - Unique buyer count (number or Set)
 * @param {number} [token.uniqueSellers] - Unique seller count
 * @param {number[]} [token.tradeSizes] - Individual trade sizes
 * @param {number[]} [token.tradeTimestamps] - Individual trade timestamps
 * @returns {Object} Volume legitimacy result
 */
function scoreVolumeLegitimacy(token) {
  const volumeSol = token.volumeSol || 0;
  const created = token.createdAt || token.pairCreated || 0;
  const ageSeconds = created > 0 ? (Date.now() - created) / 1000 : 0;
  const uniqueBuyers = token.uniqueBuyers instanceof Set
    ? token.uniqueBuyers.size
    : (token.uniqueBuyers || 0);
  const uniqueSellers = token.uniqueSellers || 0;

  // Fee accrual rate
  const fees = calcFeeRate(volumeSol, ageSeconds);

  // Bot detection
  const botResult = detectBotVolume({
    totalBuys: token.buys || 0,
    totalSells: token.sells || 0,
    uniqueBuyers,
    uniqueSellers,
    tradeSizes: token.tradeSizes || [],
    tradeTimestamps: token.tradeTimestamps || [],
    volumeSol,
  });

  // ── Composite legitimacy score (0-100) ──
  // Fee rate component (0-40 pts)
  let feePoints = 0;
  if (fees.feeRating === "ELITE") feePoints = 40;
  else if (fees.feeRating === "HIGH") feePoints = 30;
  else if (fees.feeRating === "MODERATE") feePoints = 20;
  else if (fees.feeRating === "LOW") feePoints = 10;
  else feePoints = 2;

  // Organic volume component (0-40 pts)
  const organicPoints = Math.round(botResult.organicScore * 40);

  // Volume/mcap sanity (0-20 pts)
  // Real tokens: vol/mcap ratio is reasonable for their age
  // Fake tokens: volume is suspiciously high relative to mcap and age
  const mcap = token.mcapUsd || 1;
  const volMcapRatio = (token.volume24h || volumeSol * 150) / mcap; // rough USD conversion
  let volMcapPoints = 0;
  if (ageSeconds < 600) {
    // Young tokens — high vol/mcap is normal during launch
    volMcapPoints = volMcapRatio > 0.5 ? 15 : volMcapRatio > 0.1 ? 10 : 5;
  } else {
    // Older tokens — extremely high vol/mcap with few wallets = fake
    if (volMcapRatio > 10 && uniqueBuyers < 10) volMcapPoints = 0;
    else if (volMcapRatio > 5) volMcapPoints = 5;
    else if (volMcapRatio > 2) volMcapPoints = 10;
    else if (volMcapRatio > 0.5) volMcapPoints = 15;
    else if (volMcapRatio > 0.1) volMcapPoints = 12;
    else volMcapPoints = 5; // dead volume
  }

  const legitimacyScore = Math.min(100, feePoints + organicPoints + volMcapPoints);

  // Classification
  let legitimacy;
  if (legitimacyScore >= 75 && botResult.botScore < 20) legitimacy = "REAL_VOLUME";
  else if (legitimacyScore >= 55) legitimacy = "LIKELY_ORGANIC";
  else if (legitimacyScore >= 35) legitimacy = "SUSPICIOUS";
  else legitimacy = "LIKELY_BOTTED";

  return {
    legitimacyScore,
    legitimacy,
    feeRate: fees,
    botDetection: botResult,
    volMcapPoints,
    ageSeconds: Math.round(ageSeconds),
    breakdown: {
      feePoints,
      organicPoints,
      volMcapPoints,
    },
  };
}

export {
  calcFeeRate,
  detectBotVolume,
  scoreVolumeLegitimacy,
  PUMPFUN_FEE_RATE,
};
export default scoreVolumeLegitimacy;
