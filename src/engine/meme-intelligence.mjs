/**
 * ═══════════════════════════════════════════════════════════════
 * MEME INTELLIGENCE ENGINE — Self-Evolving Token Scoring
 * ═══════════════════════════════════════════════════════════════
 *
 * Hybrid architecture:
 *   1. RAG Memory   — vector similarity to past tokens + outcomes
 *   2. Online ML    — streaming model updates on every label
 *   3. Rule Engine  — Tipping Point + System 1/2 heuristics
 *
 * Feedback loop:
 *   Token appears → extract features → score → monitor outcome
 *   → auto-label (graduated? MC multiple? fleet P&L?) → learn
 *   → next token scored better
 *
 * Integration:
 *   const intel = new MemeIntelligence(redis);
 *   // On radar token:
 *   const score = await intel.score(tokenData);
 *   // On outcome (cron or webhook):
 *   await intel.labelOutcome(ca, { graduated: true, peakMcx: 12.5, fleetPnl: 3.2 });
 */

import { pumpCurvePct } from '../autoape/gates/curve.js';

// ═══ FEATURE EXTRACTION ═══
// Converts raw token data into a normalized feature vector

const FEATURE_KEYS = [
  // Tipping Point framework
  "tp_lawOfFew",        // whale concentration in first 50 buys (0-1)
  "tp_stickiness",      // meme phrase memorability score (0-1)
  "tp_context",         // trending topic match (0-1)
  "tp_connectorScore",  // are known influencer wallets buying? (0-1)
  "tp_mavenScore",      // are known alpha wallets buying? (0-1)
  "tp_salesmanScore",   // viral retweet velocity proxy (0-1)

  // System 1/2 (Kahneman)
  "k_cognitiveEase",    // name simplicity + pronounceability (0-1)
  "k_emotionalValence", // humor/outrage/surprise density (0-1)
  "k_anchorBias",       // round-number MC proximity ($1M, $10M) (0-1)
  "k_herdSignal",       // buy count acceleration (0-1)
  "k_lossAversion",     // sell pressure ratio (inverse = bullish) (0-1)
  "k_framingEffect",    // description sentiment polarity (0-1)

  // On-chain velocity
  "oc_buyVelocity1m",   // buys per minute in first minute
  "oc_buyVelocity5m",   // buys per minute in first 5 min
  "oc_uniqueBuyers5m",  // unique wallets buying in 5 min
  "oc_giniCoeff",       // Gini of buy sizes (0=equal, 1=one whale)
  "oc_avgBuySol",       // average buy size in SOL
  "oc_devHoldPct",      // dev wallet hold percentage
  "oc_topHolderPct",    // top 10 holder concentration
  "oc_sellRatio5m",     // sells/buys ratio in 5 min (lower = bullish)
  "oc_mcapSol",         // current mcap in SOL
  "oc_volumeSol5m",     // total volume in SOL first 5 min

  // Social signals
  "so_hasTwitter",      // 0 or 1
  "so_hasTelegram",     // 0 or 1
  "so_hasWebsite",      // 0 or 1
  "so_nameLength",      // character count normalized
  "so_tickerLength",    // ticker length normalized
  "so_hasEmoji",        // name/desc contains emoji
  "so_descLength",      // description length normalized

  // Rug Detection (on-chain patterns)
  "rg_devSellSpeed",    // how fast dev sells after launch (0=held, 1=instant dump)
  "rg_holderConcentration", // top 5 wallets % over time (high = rug risk)
  "rg_coordDumpScore",  // coordinated sell pattern detection (0-1)
  "rg_liqRemovalSpeed", // liquidity drain velocity (0=stable, 1=rapid drain)
  "rg_walletAgeScore",  // avg buyer wallet age (0=fresh wallets, 1=aged)
  "rg_sellWaveDetect",  // detection of sell waves (multiple sells in rapid succession)
  "rg_mcapDropRate",    // mcap drop rate from peak (0=stable, 1=crashed)
  "rg_buyerRetention",  // % of early buyers still holding (0=all dumped, 1=all held)
  "rg_zeroSellFlag",    // token has zero or near-zero organic sells (0=has sells, 1=no sells = likely self-bought rug)
  "rg_buySellImbalance",// extreme buy/sell count imbalance (0=balanced, 1=all buys no sells)
  "rg_fakeVolumeScore", // volume from very few unique wallets recycling SOL (0=organic, 1=fake)
  "rg_gradualRugScore", // gradual buy-only chart over extended period with uniform timing (0=normal, 1=classic bot trap)
  "rg_velocityLinearity", // R² of sparkline linear regression (0=noisy organic, 1=perfect straight line = dev pump)
  "rg_buyTimingRegularity", // coefficient of variation of buy intervals inverted (0=bursty organic, 1=metronome bot)
  "rg_singleWalletDominance", // fraction of total buy volume from top wallet (0=distributed, 1=single entity)
  "rg_devSelfPumpScore", // composite: linear velocity + regular timing + no sells + concentrated (0=clean, 1=certain pump)

  // Chart shape analysis
  "ch_healthScore",     // overall chart health (0=crash, 0.5=neutral, 1=healthy growth)
  "ch_pumpDump",        // pump-and-dump pattern detection (0=none, 1=classic p&d)
  "ch_smoothGrind",     // gradual up with no dips — likely fake/self-bought chart (0=normal, 1=suspiciously smooth)
  "ch_dipRatio",        // ratio of dip candles vs up candles (0=no dips at all, 1=many dips = healthy)
  "ch_staircaseScore",  // monotonically increasing with uniform step sizes = dev self-buying (0=normal, 1=perfect staircase)

  // Cascade & Reflexivity (information cascade + feedback loops)
  "cs_cascadeOnset",    // sequential unique-wallet buys with no intervening sells (0-1)
  "cs_cascadeStrength", // buy size uniformity during cascade (Gini drops = stronger cascade)
  "cs_reflexivity",     // d(buyers)/d(price) * d(price)/d(buyers) feedback loop strength (0-1)
  "cs_curveVelocity",   // bonding curve progress velocity (dPct/dMinute) — fast fill = strong signal
  "cs_attentionShare",  // token volume relative to total observed volume (0-1)

  // SIR Viral Model (epidemiological meme spread)
  "sir_r0",             // basic reproduction number R0: avg new buyers per existing buyer (0-1 normalized)
  "sir_infectRate",     // new unique buyer arrival rate per minute (0-1)
  "sir_recoveryRate",   // seller rate (people "recovering" from meme) (0-1, inverted = bullish)

  // Graduation Frontrunning
  "gf_curveProgress",   // bonding curve % filled (0-1, 0.8+ = near graduation)
  "gf_frontrunSignal",  // combined signal: high curve progress + active cascade (0-1)

  // Attention-Price Divergence
  "apd_attentionGrowth",// is attention (volume, buyers) growing? (0-1)
  "apd_priceFlat",      // is price relatively flat despite attention? (0-1)
  "apd_divergence",     // attention growing + price flat = breakout imminent (0-1)

  // Meta
  "mt_hourOfDay",       // 0-23 normalized to 0-1
  "mt_dayOfWeek",       // 0-6 normalized to 0-1
  "mt_isWeekend",       // 0 or 1
];

function extractFeatures(token) {
  const f = {};
  const t = token || {};
  const trades = t.recentTrades || [];
  const buys = trades.filter(tr => tr.side === "buy" || tr.txType === "buy");
  const sells = trades.filter(tr => tr.side === "sell" || tr.txType === "sell");

  // ─── Tipping Point ───
  // Law of the Few: are a few wallets dominating buys?
  const buyAmounts = buys.map(b => b.solAmount || b.sol || 0);
  f.tp_lawOfFew = gini(buyAmounts);

  // Stickiness: how memorable is the name/ticker?
  const name = (t.name || "").toLowerCase();
  const ticker = (t.ticker || "").toLowerCase();
  const stickyWords = ["doge", "pepe", "shib", "moon", "elon", "trump", "cat", "dog", "frog", "inu", "ai", "gpt", "sol", "bonk", "wojak", "chad", "based", "sigma", "rizz", "skibidi"];
  const stickyHits = stickyWords.filter(w => name.includes(w) || ticker.includes(w)).length;
  f.tp_stickiness = Math.min(1, stickyHits * 0.25 + (ticker.length <= 4 ? 0.2 : 0) + (name.length <= 10 ? 0.1 : 0));

  // Context: time-based (memecoins do better in US evening hours)
  const hour = new Date().getUTCHours();
  const usEveningBoost = (hour >= 22 || hour <= 4) ? 0.3 : (hour >= 14 && hour <= 21) ? 0.2 : 0;
  f.tp_context = usEveningBoost + (t.trendingMatch ? 0.5 : 0);

  // Connector/Maven/Salesman (placeholder — needs wallet labeling DB)
  f.tp_connectorScore = t.knownInfluencerBuys ? Math.min(1, t.knownInfluencerBuys * 0.2) : 0;
  f.tp_mavenScore = t.knownAlphaBuys ? Math.min(1, t.knownAlphaBuys * 0.15) : 0;
  f.tp_salesmanScore = t.retweetVelocity ? Math.min(1, t.retweetVelocity / 50) : 0;

  // ─── System 1/2 (Kahneman) ───
  // Cognitive ease: short, pronounceable, familiar patterns
  const vowels = (name.match(/[aeiou]/gi) || []).length;
  const consonants = (name.match(/[bcdfghjklmnpqrstvwxyz]/gi) || []).length;
  const ratio = vowels / Math.max(1, consonants);
  f.k_cognitiveEase = Math.min(1, (ratio > 0.3 && ratio < 1.5 ? 0.4 : 0) + (name.length <= 8 ? 0.3 : 0) + (ticker.length <= 5 ? 0.3 : 0));

  // Emotional valence: does description trigger emotion?
  const desc = (t.description || "").toLowerCase();
  const emotionWords = ["moon", "rich", "millionaire", "retire", "lambo", "100x", "1000x", "degen", "ape", "send", "pump", "gem", "alpha", "insane", "crazy", "fk", "shit", "holy"];
  const emotionHits = emotionWords.filter(w => desc.includes(w) || name.includes(w)).length;
  f.k_emotionalValence = Math.min(1, emotionHits * 0.15);

  // Anchor bias: proximity to round MC numbers
  const mcap = t.mcapUsd || t.mcapSol * 140 || 0;
  const anchors = [100000, 500000, 1000000, 5000000, 10000000];
  const closestAnchor = anchors.reduce((a, b) => Math.abs(b - mcap) < Math.abs(a - mcap) ? b : a);
  f.k_anchorBias = mcap > 0 ? Math.max(0, 1 - Math.abs(mcap - closestAnchor) / closestAnchor) : 0;

  // Herd signal: buy acceleration
  const recentBuys = buys.slice(-20);
  const olderBuys = buys.slice(-40, -20);
  f.k_herdSignal = olderBuys.length > 0 ? Math.min(1, recentBuys.length / Math.max(1, olderBuys.length) / 3) : 0;

  // Loss aversion (inverse sell pressure = bullish)
  f.k_lossAversion = buys.length > 0 ? Math.max(0, 1 - sells.length / Math.max(1, buys.length)) : 0.5;

  // Framing effect
  const positiveWords = ["guaranteed", "easy", "free", "win", "profit", "safe", "community"];
  f.k_framingEffect = Math.min(1, positiveWords.filter(w => desc.includes(w)).length * 0.2);

  // ─── On-chain velocity ───
  f.oc_buyVelocity1m = Math.min(1, (t.buys1m || buys.length) / 30);
  f.oc_buyVelocity5m = Math.min(1, (t.buys5m || buys.length) / 100);
  f.oc_uniqueBuyers5m = Math.min(1, (t.uniqueBuyers || new Set(buys.map(b => b.wallet)).size) / 50);
  f.oc_giniCoeff = gini(buyAmounts);
  f.oc_avgBuySol = buyAmounts.length > 0 ? Math.min(1, avg(buyAmounts) / 2) : 0;
  f.oc_devHoldPct = Math.min(1, (t.devHoldPct || 0) / 100);
  f.oc_topHolderPct = Math.min(1, (t.topHolderPct || 0) / 100);
  f.oc_sellRatio5m = buys.length > 0 ? Math.min(1, sells.length / Math.max(1, buys.length)) : 0.5;
  f.oc_mcapSol = Math.min(1, (t.mcapSol || 0) / 500);
  f.oc_volumeSol5m = Math.min(1, (t.volumeSol5m || sum(buyAmounts)) / 50);

  // ─── Social ───
  f.so_hasTwitter = t.twitter ? 1 : 0;
  f.so_hasTelegram = t.telegram ? 1 : 0;
  f.so_hasWebsite = t.website ? 1 : 0;
  f.so_nameLength = Math.min(1, name.length / 20);
  f.so_tickerLength = Math.min(1, ticker.length / 10);
  f.so_hasEmoji = /[\u{1F600}-\u{1F9FF}]/u.test(t.name || "") ? 1 : 0;
  f.so_descLength = Math.min(1, (t.description || "").length / 200);

  // ─── Rug Detection (on-chain patterns) ───
  const ageMs = Date.now() - (t.createdAt || Date.now());
  const ageMin = Math.max(1, ageMs / 60000);

  // Dev sell speed: did the dev wallet sell quickly?
  const devWallet = t.devWallet || "";
  const devSells = sells.filter(s => (s.wallet || "").startsWith(devWallet.slice(0, 8)));
  if (devSells.length > 0 && ageMin > 0) {
    const firstDevSellAge = devSells[0]?.time ? (devSells[0].time - (t.createdAt || Date.now())) / 60000 : ageMin;
    f.rg_devSellSpeed = Math.min(1, Math.max(0, 1 - firstDevSellAge / 30)); // sold within 30min = high risk
  } else {
    f.rg_devSellSpeed = 0; // no dev sell = good
  }

  // Holder concentration: top wallets holding too much
  const walletBuys = {};
  buys.forEach(b => {
    const w = b.wallet || "unknown";
    walletBuys[w] = (walletBuys[w] || 0) + (b.solAmount || b.sol || 0);
  });
  const sortedHolders = Object.values(walletBuys).sort((a, b) => b - a);
  const totalBought = sum(sortedHolders);
  const top5Pct = totalBought > 0 ? sum(sortedHolders.slice(0, 5)) / totalBought : 0;
  f.rg_holderConcentration = Math.min(1, top5Pct);

  // Coordinated dump: multiple sells within a narrow time window
  const sellTimes = sells.map(s => s.time || 0).filter(t => t > 0).sort((a, b) => a - b);
  let coordDumps = 0;
  for (let i = 1; i < sellTimes.length; i++) {
    if (sellTimes[i] - sellTimes[i - 1] < 3000) coordDumps++; // sells within 3 seconds
  }
  f.rg_coordDumpScore = sells.length > 2 ? Math.min(1, coordDumps / Math.max(1, sells.length - 1)) : 0;

  // Liquidity removal speed: volume of sells vs buys in recent window
  const recentSells = sells.slice(-10);
  const recentBuysSol = sum(buys.slice(-10).map(b => b.solAmount || b.sol || 0));
  const recentSellsSol = sum(recentSells.map(s => s.solAmount || s.sol || 0));
  f.rg_liqRemovalSpeed = recentBuysSol > 0 ? Math.min(1, recentSellsSol / Math.max(0.01, recentBuysSol)) : 0;

  // Wallet age score: fresh wallets = higher rug risk (uses uniqueBuyers count as proxy)
  const uniqueWallets = new Set(buys.map(b => b.wallet)).size;
  const buyCount = buys.length;
  const walletReuse = buyCount > 0 ? 1 - (uniqueWallets / Math.max(1, buyCount)) : 0;
  f.rg_walletAgeScore = Math.min(1, walletReuse); // high reuse = suspicious

  // Sell wave detection: bursts of sells
  let maxSellBurst = 0;
  for (let i = 0; i < sellTimes.length; i++) {
    let burst = 1;
    for (let j = i + 1; j < sellTimes.length && sellTimes[j] - sellTimes[i] < 10000; j++) {
      burst++;
    }
    maxSellBurst = Math.max(maxSellBurst, burst);
  }
  f.rg_sellWaveDetect = Math.min(1, maxSellBurst / 8); // 8+ sells in 10s = max risk

  // Mcap drop rate from peak
  const spark = t.spark || [];
  if (spark.length > 2) {
    const peakMcap = Math.max(...spark);
    const currentMcap = spark[spark.length - 1] || 0;
    f.rg_mcapDropRate = peakMcap > 0 ? Math.min(1, Math.max(0, 1 - currentMcap / peakMcap)) : 0;
  } else {
    f.rg_mcapDropRate = 0;
  }

  // Buyer retention: are early buyers still around (proxy: sell count vs buy count for early wallets)
  const earlyBuyers = new Set(buys.slice(0, 20).map(b => b.wallet));
  const earlyBuyerSells = sells.filter(s => earlyBuyers.has(s.wallet)).length;
  f.rg_buyerRetention = earlyBuyers.size > 0 ? Math.max(0, 1 - earlyBuyerSells / earlyBuyers.size) : 0.5;

  // ─── Zero sell detection: tokens with no organic sells are almost always rugs ───
  // A healthy token ALWAYS has some profit-taking. Zero sells means either:
  //   1. Dev self-buying to fake activity (will rug when enough liquidity enters)
  //   2. Token is so new nobody has sold yet (but then why is it ranked high?)
  //   3. Freeze authority preventing sells (already caught above)
  // Any token with 10+ buys and 0-1 sells is extremely suspicious.
  const organicSells = sells.filter(s => {
    // Filter out sells from the dev wallet — those are rug pulls, not organic
    const wallet = s.wallet || "";
    return !wallet.startsWith((t.devWallet || "").slice(0, 8));
  });
  if (buys.length >= 5 && organicSells.length === 0) {
    f.rg_zeroSellFlag = 1.0; // absolute red flag: many buys, zero organic sells
  } else if (buys.length >= 10 && organicSells.length <= 1) {
    f.rg_zeroSellFlag = 0.8; // nearly zero sells with significant buy activity
  } else if (buys.length >= 5 && organicSells.length <= 1) {
    f.rg_zeroSellFlag = 0.5; // suspicious
  } else {
    f.rg_zeroSellFlag = 0;
  }

  // Buy/sell imbalance: extreme ratios indicate fake/self-bought activity
  const totalTrades = buys.length + sells.length;
  if (totalTrades > 0) {
    const buyPct = buys.length / totalTrades;
    if (buyPct >= 0.95 && buys.length >= 5) {
      f.rg_buySellImbalance = 1.0; // 95%+ buys = almost certainly fake
    } else if (buyPct >= 0.9 && buys.length >= 5) {
      f.rg_buySellImbalance = 0.7;
    } else if (buyPct >= 0.8 && buys.length >= 10) {
      f.rg_buySellImbalance = 0.4;
    } else {
      f.rg_buySellImbalance = 0;
    }
  } else {
    f.rg_buySellImbalance = 0;
  }

  // Fake volume detection: few unique wallets creating many transactions
  // If 3 wallets account for 80%+ of all buys, volume is likely wash trading
  const uniqueBuyWallets = new Set(buys.map(b => b.wallet)).size;
  const buyersToTxRatio = uniqueBuyWallets / Math.max(1, buys.length);
  if (buys.length >= 8 && buyersToTxRatio < 0.3) {
    f.rg_fakeVolumeScore = Math.min(1, 0.5 + (0.3 - buyersToTxRatio) * 2); // few wallets, many txns
  } else if (buys.length >= 5 && buyersToTxRatio < 0.4) {
    f.rg_fakeVolumeScore = 0.3;
  } else {
    f.rg_fakeVolumeScore = 0;
  }

  // ─── Gradual rug pattern: sustained buy-only activity with uniform timing ───
  // The classic bot trap: dev self-buys from multiple wallets at regular intervals over 5-10+ min.
  // Creates a smooth uptrend that looks like organic momentum but has zero sell pressure.
  // Real organic buying comes in WAVES (FOMO clusters) with intermixed profit-taking.
  // Bot-trap buying comes at REGULAR INTERVALS like a metronome.
  const buyTimes = buys.map(b => b.time || 0).filter(t => t > 0).sort((a, b) => a - b);
  f.rg_gradualRugScore = 0;
  if (buyTimes.length >= 6 && sells.length <= 1) {
    const intervals = [];
    for (let i = 1; i < buyTimes.length; i++) {
      intervals.push(buyTimes[i] - buyTimes[i - 1]);
    }
    const spreadMs = buyTimes[buyTimes.length - 1] - buyTimes[0];
    const spreadMin = spreadMs / 60000;
    // Timing uniformity: low coefficient of variation = suspiciously regular
    const avgInt = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    let timingUniformity = 0;
    if (avgInt > 0) {
      const variance = intervals.reduce((s, d) => s + (d - avgInt) ** 2, 0) / intervals.length;
      const cv = Math.sqrt(variance) / avgInt;
      timingUniformity = Math.max(0, Math.min(1, 1 - cv));
    }
    // Also check that price is monotonically increasing (from spark data)
    const isMonoUp = spark.length >= 5 && spark.every((v, i) => i === 0 || v >= spark[i - 1] * 0.97);

    // Score: long duration + uniform timing + no sells + monotonic up = trap
    if (spreadMin >= 5 && buys.length >= 10 && sells.length === 0 && timingUniformity > 0.4 && isMonoUp) {
      f.rg_gradualRugScore = Math.min(1, 0.7 + timingUniformity * 0.2 + Math.min(0.1, spreadMin / 60));
    } else if (spreadMin >= 3 && buys.length >= 8 && sells.length <= 1 && timingUniformity > 0.3) {
      f.rg_gradualRugScore = Math.min(0.7, 0.4 + timingUniformity * 0.2 + (isMonoUp ? 0.1 : 0));
    } else if (spreadMin >= 2 && buys.length >= 6 && sells.length === 0 && timingUniformity > 0.5 && isMonoUp) {
      f.rg_gradualRugScore = 0.5;
    }
  }

  // ─── Velocity linearity (R²) — straight-line price = dev self-buy ───
  f.rg_velocityLinearity = 0;
  if (spark.length >= 6) {
    const n = spark.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i; sumY += spark[i]; sumXY += i * spark[i]; sumX2 += i * i; sumY2 += spark[i] * spark[i];
    }
    const denom = (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY);
    if (denom > 0) {
      const r = (n * sumXY - sumX * sumY) / Math.sqrt(denom);
      f.rg_velocityLinearity = r * r;
    }
    if (spark[n - 1] <= spark[0]) f.rg_velocityLinearity = 0; // only flag upward
  }

  // ─── Buy timing regularity — metronome = bot ───
  f.rg_buyTimingRegularity = 0;
  if (buyTimes.length >= 6) {
    const intervals = [];
    for (let i = 1; i < buyTimes.length; i++) intervals.push(buyTimes[i] - buyTimes[i - 1]);
    const avgInt = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (avgInt > 0) {
      const variance = intervals.reduce((s, d) => s + (d - avgInt) ** 2, 0) / intervals.length;
      const cv = Math.sqrt(variance) / avgInt;
      f.rg_buyTimingRegularity = Math.max(0, Math.min(1, 1 - cv));
    }
    const priceUp = spark.length >= 3 && spark[spark.length - 1] > spark[0] * 1.2;
    if (!priceUp || buyTimes.length < 6) f.rg_buyTimingRegularity = 0;
  }

  // ─── Single wallet dominance ───
  f.rg_singleWalletDominance = 0;
  const sortedBuyerAmounts = Object.values(walletBuys).sort((a, b) => b - a);
  const totalBuyVol = sortedBuyerAmounts.reduce((s, v) => s + v, 0);
  if (sortedBuyerAmounts.length >= 2 && totalBuyVol > 0) {
    f.rg_singleWalletDominance = sortedBuyerAmounts[0] / totalBuyVol;
    const top2 = (sortedBuyerAmounts[0] + (sortedBuyerAmounts[1] || 0)) / totalBuyVol;
    if (top2 > 0.7 && sortedBuyerAmounts.length >= 3) {
      f.rg_singleWalletDominance = Math.max(f.rg_singleWalletDominance, top2 * 0.9);
    }
  }

  // ─── Composite dev self-pump score ───
  {
    const sigs = [
      f.rg_velocityLinearity > 0.85 ? 1 : f.rg_velocityLinearity > 0.7 ? 0.5 : 0,
      f.rg_buyTimingRegularity > 0.6 ? 1 : f.rg_buyTimingRegularity > 0.4 ? 0.5 : 0,
      (f.rg_zeroSellFlag || 0) > 0.5 ? 1 : (f.rg_buySellImbalance || 0) > 0.6 ? 0.7 : 0,
      f.rg_singleWalletDominance > 0.5 ? 1 : (f.rg_holderConcentration || 0) > 0.6 ? 0.5 : 0,
      (f.ch_smoothGrind || 0) > 0.4 ? 0.5 : (f.ch_staircaseScore || 0) > 0.3 ? 0.5 : 0,
    ];
    const sigCount = sigs.filter(s => s > 0).length;
    const sigSum = sigs.reduce((a, b) => a + b, 0);
    if (sigCount >= 4) f.rg_devSelfPumpScore = Math.min(1, 0.7 + sigSum * 0.06);
    else if (sigCount >= 3) f.rg_devSelfPumpScore = Math.min(0.8, 0.4 + sigSum * 0.08);
    else if (sigCount >= 2 && sigSum >= 1.5) f.rg_devSelfPumpScore = Math.min(0.5, 0.2 + sigSum * 0.1);
    else f.rg_devSelfPumpScore = 0;
  }

  // ─── Chart shape analysis: gradual-up-no-dips detection ───
  if (spark.length >= 5) {
    // Count dips: a "dip" is when spark[i] < spark[i-1]
    let dips = 0;
    let ups = 0;
    let maxConsecutiveUp = 0;
    let consecutiveUp = 0;
    let totalDelta = 0;
    for (let i = 1; i < spark.length; i++) {
      const delta = spark[i] - spark[i - 1];
      totalDelta += Math.abs(delta);
      if (delta < 0) {
        dips++;
        consecutiveUp = 0;
      } else if (delta > 0) {
        ups++;
        consecutiveUp++;
        maxConsecutiveUp = Math.max(maxConsecutiveUp, consecutiveUp);
      }
    }
    const totalMoves = dips + ups;
    // dipRatio: healthy charts have 30-50% dips. 0 dips = suspicious.
    f.ch_dipRatio = totalMoves > 0 ? Math.min(1, dips / totalMoves * 2) : 0;
    // smoothGrind: detects fake charts — long consecutive uptrends + very few dips
    // Real charts ALWAYS have dips. A chart with 80%+ up candles is almost certainly self-bought.
    const upPct = totalMoves > 0 ? ups / totalMoves : 0;
    const isLong = spark.length >= 8;
    const isGrowing = spark[spark.length - 1] > spark[0] * 1.3;
    // High smoothGrind = suspicious: many consecutive ups, very few dips, growing
    if (isLong && isGrowing && upPct > 0.85 && maxConsecutiveUp >= 6) {
      f.ch_smoothGrind = Math.min(1, 0.5 + (upPct - 0.85) * 3 + (maxConsecutiveUp - 6) * 0.05);
    } else if (isLong && isGrowing && upPct > 0.75 && maxConsecutiveUp >= 5) {
      f.ch_smoothGrind = Math.min(0.6, 0.3 + (upPct - 0.75) * 2);
    } else {
      f.ch_smoothGrind = 0;
    }
    // Chart health from meme-intelligence
    const start = spark[0] || 1;
    const peakVal = Math.max(...spark);
    const current = spark[spark.length - 1] || 0;
    const peakIdx = spark.indexOf(peakVal);
    const peakPct = peakIdx / spark.length;
    const multiple = peakVal / start;
    const endRatio = current / (peakVal || 1);
    // Healthy: steady growth with dips, peak late, holding value
    if (multiple > 2 && peakPct > 0.5 && endRatio > 0.4 && dips >= 2) {
      f.ch_healthScore = Math.min(1, 0.6 + multiple * 0.05);
    } else if (peakPct < 0.3 && endRatio < 0.2) {
      f.ch_healthScore = Math.max(0, 0.2);
    } else if (current > start && multiple < 3) {
      f.ch_healthScore = 0.6;
    } else {
      f.ch_healthScore = 0.5;
    }
    // Pump-dump: sharp peak early then crash
    if (multiple > 5 && peakPct < 0.35 && endRatio < 0.25) {
      f.ch_pumpDump = Math.min(1, 0.5 + (1 - endRatio) * 0.3 + (1 - peakPct) * 0.2);
    } else {
      f.ch_pumpDump = 0;
    }
    // penalize smooth grinds in health score — they look good but are fake
    if (f.ch_smoothGrind > 0.5) {
      f.ch_healthScore = Math.max(0, f.ch_healthScore - f.ch_smoothGrind * 0.4);
    }
    // ── STAIRCASE DETECTION ──
    // Classic rug: dev buys from fresh wallets at regular intervals → monotonically
    // increasing chart with uniform step sizes. Real charts have varying steps + pullbacks.
    f.ch_staircaseScore = 0;
    if (spark.length >= 6) {
      const sDeltas = [];
      let sMonotoneUps = 0;
      for (let i = 1; i < spark.length; i++) {
        const d = spark[i] - spark[i - 1];
        if (d > 0) { sMonotoneUps++; sDeltas.push(d); }
      }
      const sMonotoneRatio = sMonotoneUps / (spark.length - 1);
      if (sDeltas.length >= 4) {
        const sAvgDelta = sDeltas.reduce((a, b) => a + b, 0) / sDeltas.length;
        const sVariance = sDeltas.reduce((s, d) => s + (d - sAvgDelta) ** 2, 0) / sDeltas.length;
        const sCv = sAvgDelta > 0 ? Math.sqrt(sVariance) / sAvgDelta : 1;
        if (sMonotoneRatio > 0.8 && sCv < 0.4) {
          f.ch_staircaseScore = Math.min(1, 0.4 + (0.4 - sCv) * 2 + (sMonotoneRatio - 0.8) * 2);
        } else if (sMonotoneRatio > 0.7 && sCv < 0.35) {
          f.ch_staircaseScore = Math.min(0.5, 0.2 + (0.35 - sCv) * 1.5);
        }
      }
    }
    if (f.ch_staircaseScore > 0.4) {
      f.ch_healthScore = Math.max(0, f.ch_healthScore - f.ch_staircaseScore * 0.5);
    }
  } else {
    f.ch_healthScore = 0.5;
    f.ch_pumpDump = 0;
    f.ch_smoothGrind = 0;
    f.ch_dipRatio = 0.5;
    f.ch_staircaseScore = 0;
  }

  // ─── Cascade & Reflexivity (Bikhchandani-Hirshleifer-Welch + Soros) ───

  // Cascade onset: count sequential unique-wallet buys with no intervening sells
  // A cascade = information cascade where each buyer infers "others know something"
  let cascadeLen = 0, maxCascade = 0;
  const cascadeWallets = new Set();
  for (const tr of trades) {
    if ((tr.side === "buy" || tr.txType === "buy") && !cascadeWallets.has(tr.wallet)) {
      cascadeWallets.add(tr.wallet);
      cascadeLen++;
      maxCascade = Math.max(maxCascade, cascadeLen);
    } else if (tr.side === "sell" || tr.txType === "sell") {
      cascadeLen = 0; // cascade breaks on any sell
      cascadeWallets.clear();
    }
  }
  f.cs_cascadeOnset = Math.min(1, maxCascade / 15); // 15+ sequential unique buys = full cascade

  // Cascade strength: during cascade, buy sizes become more uniform (herding = everyone bets similar)
  // Low Gini during cascade = strong herd behavior
  const cascadeBuys = buys.slice(-Math.min(maxCascade, buys.length));
  const cascadeGini = cascadeBuys.length > 2 ? gini(cascadeBuys.map(b => b.solAmount || b.sol || 0)) : 0.5;
  f.cs_cascadeStrength = maxCascade >= 3 ? Math.max(0, 1 - cascadeGini) : 0;

  // Reflexivity: price → attention → buys → price feedback loop
  // Measure as correlation between price increase rate and buy rate increase
  // Proxy: if buy velocity is ACCELERATING while MC is rising, loop is self-reinforcing
  const recentBuysR = buys.slice(-20);
  const olderBuysR = buys.slice(-40, -20);
  const buyAccel = olderBuysR.length > 0 ? recentBuysR.length / Math.max(1, olderBuysR.length) : 1;
  const mcRising = spark.length > 2 ? (spark[spark.length - 1] || 0) > (spark[Math.max(0, spark.length - 4)] || 0) : false;
  f.cs_reflexivity = mcRising && buyAccel > 1.2 ? Math.min(1, (buyAccel - 1) * 0.8) : 0;

  // Bonding curve velocity: how fast is the curve filling?
  // Progress to graduation from the virtual SOL reserve (see gates/curve.js).
  // Track rate of change: dPct/dMinute
  const curveProgress = pumpCurvePct(t.vSolInBondingCurve);
  const curveVelocity = ageMin > 0 ? curveProgress / ageMin : 0;
  // Sweet spot: 0.5-2% per minute = healthy graduation trajectory
  f.cs_curveVelocity = Math.min(1, curveVelocity * 30); // 3.3%/min → 1.0

  // Attention share: this token's volume vs typical token volume
  // Higher = capturing more attention in zero-sum meme market
  const tokenVol = t.volumeSol || sum(buyAmounts);
  f.cs_attentionShare = Math.min(1, tokenVol / 50); // 50 SOL volume = full attention score

  // ─── SIR Viral Model (Epidemiological Meme Spread) ───
  // R0 = basic reproduction number: how many new buyers does each buyer generate?
  // R0 > 2 at the 5-min mark correlates with 3-5x higher graduation rate
  // Model: S(susceptible) → I(infected/buying) → R(recovered/sold)
  {
    // Estimate R0 from buyer arrival rate acceleration
    // Split trades into time windows and measure new-buyer growth rate
    const buyTimes = buys.map(b => b.time || b.timestamp || 0).filter(t => t > 0).sort((a, b) => a - b);
    if (buyTimes.length >= 5) {
      const midpoint = Math.floor(buyTimes.length / 2);
      const earlyWindow = buyTimes.slice(0, midpoint);
      const lateWindow = buyTimes.slice(midpoint);
      const earlySpan = (earlyWindow[earlyWindow.length - 1] - earlyWindow[0]) / 60000 || 1; // minutes
      const lateSpan = (lateWindow[lateWindow.length - 1] - lateWindow[0]) / 60000 || 1;
      const earlyRate = earlyWindow.length / earlySpan; // buyers per minute early
      const lateRate = lateWindow.length / lateSpan;   // buyers per minute late
      // R0 proxy: late rate / early rate — accelerating buyers = viral spread
      const r0Raw = earlyRate > 0 ? lateRate / earlyRate : 1;
      f.sir_r0 = Math.min(1, Math.max(0, (r0Raw - 0.5) / 3)); // R0=0.5→0, R0=2→0.5, R0=3.5→1
      // Infection rate: new unique buyers per minute
      const uniqueBuyerCount = new Set(buys.map(b => b.wallet)).size;
      f.sir_infectRate = Math.min(1, uniqueBuyerCount / Math.max(1, ageMin) / 10); // 10/min = max
      // Recovery rate: sellers per minute (inverted — low selling = still "infected" = bullish)
      const sellRate = sells.length / Math.max(1, ageMin);
      f.sir_recoveryRate = Math.max(0, 1 - Math.min(1, sellRate / 5)); // 5 sells/min = max recovery = bearish
    } else {
      f.sir_r0 = 0;
      f.sir_infectRate = 0;
      f.sir_recoveryRate = 0.5;
    }
  }

  // ─── Graduation Frontrunning ───
  // Tokens at 80%+ bonding curve progress with active cascade = near-guaranteed graduation
  // 15-30% premium available by frontrunning graduation on Raydium
  {
    const curveProgress = pumpCurvePct(t.vSolInBondingCurve);
    f.gf_curveProgress = Math.min(1, curveProgress);
    // Frontrun signal: curve > 80% AND (cascade active OR strong buy pressure)
    const cascadeActive = f.cs_cascadeOnset > 0.3;
    const strongBuys = f.oc_buyVelocity5m > 0.3;
    if (curveProgress >= 0.8) {
      const urgency = (curveProgress - 0.8) * 5; // 0.8→0, 1.0→1
      const confidence = cascadeActive ? 0.8 : strongBuys ? 0.5 : 0.2;
      f.gf_frontrunSignal = Math.min(1, urgency * confidence * 2);
    } else if (curveProgress >= 0.6) {
      // Early warning: approaching graduation
      f.gf_frontrunSignal = cascadeActive ? Math.min(0.3, (curveProgress - 0.6) * 1.5) : 0;
    } else {
      f.gf_frontrunSignal = 0;
    }
  }

  // ─── Attention-Price Divergence ───
  // Attention growing + price flat = breakout imminent (55-65% win rate on 15-30% moves in 2-5 min)
  // This is the "coiled spring" — volume accumulating before price catches up
  {
    // Attention growth: compare recent volume/buyer rate to earlier
    const recentBuyCount = buys.slice(-10).length;
    const olderBuyCount = buys.slice(-20, -10).length;
    const attentionGrowth = olderBuyCount > 0 ? recentBuyCount / Math.max(1, olderBuyCount) : 1;
    f.apd_attentionGrowth = Math.min(1, Math.max(0, (attentionGrowth - 0.8) / 2)); // 0.8→0, 2.8→1

    // Price flatness: low volatility in recent spark data
    if (spark.length >= 4) {
      const recentSpark = spark.slice(-4);
      const sparkAvg = recentSpark.reduce((a, b) => a + b, 0) / recentSpark.length;
      const sparkVar = recentSpark.reduce((s, v) => s + Math.abs(v - sparkAvg), 0) / recentSpark.length;
      const sparkCv = sparkAvg > 0 ? sparkVar / sparkAvg : 0;
      f.apd_priceFlat = Math.max(0, 1 - sparkCv * 10); // low CV = price is flat
    } else {
      f.apd_priceFlat = 0.5;
    }

    // Divergence: attention growing AND price flat = imminent breakout
    f.apd_divergence = f.apd_attentionGrowth > 0.3 && f.apd_priceFlat > 0.5
      ? Math.min(1, f.apd_attentionGrowth * f.apd_priceFlat * 1.5)
      : 0;
  }

  // ─── Meta ───
  const now = new Date();
  f.mt_hourOfDay = now.getUTCHours() / 23;
  f.mt_dayOfWeek = now.getUTCDay() / 6;
  f.mt_isWeekend = (now.getUTCDay() === 0 || now.getUTCDay() === 6) ? 1 : 0;

  return f;
}

// ═══ PRE-COMPUTED LOOKUP TABLES ═══
// Built once at module load — eliminates string splits and array filters from hot path

const GROUP_FOR_KEY = {};      // "tp_lawOfFew" → "tp"
const KEYS_BY_GROUP = {};      // "tp" → ["tp_lawOfFew", ...]
const KEY_INDEX = {};          // "tp_lawOfFew" → 0 (position in FEATURE_KEYS)
for (let i = 0; i < FEATURE_KEYS.length; i++) {
  const k = FEATURE_KEYS[i];
  const g = k.substring(0, k.indexOf("_")); // faster than split("_")[0]
  GROUP_FOR_KEY[k] = g;
  KEY_INDEX[k] = i;
  if (!KEYS_BY_GROUP[g]) KEYS_BY_GROUP[g] = [];
  KEYS_BY_GROUP[g].push(k);
}
const GROUP_NAMES = Object.keys(KEYS_BY_GROUP); // ["tp","k","oc","rg","so","mt"]

// ═══ SCORING ENGINE ═══
// Combines rule-based frameworks + learned weights

class ScoringEngine {
  constructor() {
    // Initial weights (Tipping Point framework emphasis)
    this.weights = {};
    FEATURE_KEYS.forEach(k => { this.weights[k] = 1.0; });

    // Framework group weights — safety first, rug detection dominates
    this.groupWeights = {
      tp: 1.3,  // Tipping Point
      k: 1.0,   // Kahneman
      oc: 1.5,  // On-chain velocity important
      rg: 3.0,  // Rug detection — HIGHEST weight (losing money > missing plays)
      ch: 2.0,  // Chart pattern analysis — catches fake charts and pump-dumps
      cs: 1.8,  // Cascade & Reflexivity — information cascades are the #1 driver of meme pumps
      sir: 2.0, // SIR Viral Model — R0 > 2 correlates with 3-5x higher grad rate
      gf: 2.5,  // Graduation Frontrunning — near-guaranteed premium at 80%+ curve
      apd: 1.5, // Attention-Price Divergence — coiled spring breakout detection
      so: 0.6,  // Social is noisy
      mt: 0.3,  // Time-of-day is minor
    };

    // Online learning state — higher rate to adapt faster from rug losses
    this.learningRate = 0.08; // Increased from 0.03 — adapt faster to rug patterns and market shifts
    this.trainCount = 0;
    this.accuracy = { correct: 0, total: 0 };
    // Score bracket accuracy: tracks win rate per score range (0-10, 10-20, ..., 90-100)
    this.bracketAccuracy = {};
  }

  // Rebuild multiplier cache after weight changes — one Float64Array lookup per feature
  _rebuildCache() {
    this._mCache = new Float64Array(FEATURE_KEYS.length);
    this._mTotal = 0;
    for (let i = 0; i < FEATURE_KEYS.length; i++) {
      const k = FEATURE_KEYS[i];
      const m = (this.weights[k] || 1.0) * (this.groupWeights[GROUP_FOR_KEY[k]] || 1.0);
      this._mCache[i] = m;
      this._mTotal += m;
    }
    // Pre-compute per-group weight sums for sub-score normalization
    this._groupWeightSums = {};
    for (const g of GROUP_NAMES) {
      let s = 0;
      for (const k of KEYS_BY_GROUP[g]) s += this._mCache[KEY_INDEX[k]];
      this._groupWeightSums[g] = s;
    }
  }

  score(features) {
    // Lazy-init multiplier cache
    if (!this._mCache) this._rebuildCache();

    // ── Single pass: weighted sum + per-group sums ──
    // Zero-alloc: reuse pre-allocated group accumulators
    let weightedSum = 0;
    let gs_tp = 0, gs_k = 0, gs_oc = 0, gs_rg = 0, gs_ch = 0, gs_cs = 0, gs_sir = 0, gs_gf = 0, gs_apd = 0, gs_so = 0, gs_mt = 0;
    const mc = this._mCache;

    for (let i = 0; i < FEATURE_KEYS.length; i++) {
      const val = features[FEATURE_KEYS[i]] || 0;
      const wv = val * mc[i];
      weightedSum += wv;
      switch (GROUP_FOR_KEY[FEATURE_KEYS[i]]) {
        case "tp": gs_tp += wv; break;
        case "k":  gs_k  += wv; break;
        case "oc": gs_oc += wv; break;
        case "rg": gs_rg += wv; break;
        case "ch": gs_ch += wv; break;
        case "cs": gs_cs += wv; break;
        case "sir": gs_sir += wv; break;
        case "gf": gs_gf += wv; break;
        case "apd": gs_apd += wv; break;
        case "so": gs_so += wv; break;
        case "mt": gs_mt += wv; break;
      }
    }

    const totalWeight = this._mTotal;
    const rawScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Sub-scores normalized by group weight
    const gws = this._groupWeightSums;
    const s_tp = gws.tp > 0 ? gs_tp / gws.tp : 0;
    const s_k  = gws.k  > 0 ? gs_k  / gws.k  : 0;
    const s_oc = gws.oc > 0 ? gs_oc / gws.oc : 0;
    const s_rg = gws.rg > 0 ? gs_rg / gws.rg : 0;
    const s_ch = gws.ch > 0 ? gs_ch / gws.ch : 0;
    const s_cs = gws.cs > 0 ? gs_cs / gws.cs : 0;
    const s_sir = gws.sir > 0 ? gs_sir / gws.sir : 0;
    const s_gf = gws.gf > 0 ? gs_gf / gws.gf : 0;
    const s_apd = gws.apd > 0 ? gs_apd / gws.apd : 0;
    const s_so = gws.so > 0 ? gs_so / gws.so : 0;
    const s_mt = gws.mt > 0 ? gs_mt / gws.mt : 0;

    // ── Rug penalty (no branches on common path) ──
    const rugRisk = s_rg;
    const rugPenalty = rugRisk < 0.2
      ? (rugRisk * 75 + 0.5) | 0
      : rugRisk < 0.4
        ? (15 + (rugRisk - 0.2) * 100 + 0.5) | 0
        : (35 + (rugRisk - 0.4) * 67 + 0.5) | 0;

    // ── Chart pattern penalty ──
    // smoothGrind is a STRONG rug signal — fake charts with no natural dips
    const chartPenalty = (features.ch_smoothGrind || 0) > 0.5
      ? Math.round((features.ch_smoothGrind - 0.3) * 40)
      : (features.ch_pumpDump || 0) > 0.5
        ? Math.round((features.ch_pumpDump - 0.3) * 25)
        : 0;

    // ── Tipping Point composite ──
    const tippingScore = s_tp * 0.4 + s_k * 0.3 + s_oc * 0.2 + s_so * 0.1;

    // ── Bond probability (enhanced with cascade + reflexivity + SIR + frontrunning) ──
    const bpRaw = tippingScore * 30
      + (features.oc_buyVelocity5m || 0) * 20
      + (features.oc_uniqueBuyers5m || 0) * 15
      + (features.k_herdSignal || 0) * 10
      + (features.cs_cascadeOnset || 0) * 15     // cascade = strong grad signal
      + (features.cs_reflexivity || 0) * 12       // self-reinforcing loop = graduation likely
      + (features.cs_curveVelocity || 0) * 18     // curve filling fast = closest to graduation
      + (features.sir_r0 || 0) * 14               // R0 > 2 = viral spread, high grad correlation
      + (features.sir_infectRate || 0) * 8         // new buyer arrival rate
      + (features.gf_frontrunSignal || 0) * 20     // 80%+ curve + cascade = near-certain graduation
      + (features.apd_divergence || 0) * 10        // attention-price divergence = breakout imminent
      - rugPenalty * 0.8
      - chartPenalty * 0.6;
    const bondProb = bpRaw < 1 ? 1 : bpRaw > 99 ? 99 : (bpRaw + 0.5) | 0;

    // ── Rug flags — direct reads, no array iteration ──
    const rugFlags = [];
    if ((features.rg_devSellSpeed || 0) > 0.2) rugFlags.push("dev_dumping");
    if ((features.rg_holderConcentration || 0) > 0.5) rugFlags.push("whale_concentrated");
    if ((features.rg_coordDumpScore || 0) > 0.2) rugFlags.push("coordinated_sells");
    if ((features.rg_liqRemovalSpeed || 0) > 0.4) rugFlags.push("liquidity_drain");
    if ((features.rg_sellWaveDetect || 0) > 0.3) rugFlags.push("sell_wave");
    if ((features.rg_mcapDropRate || 0) > 0.25) rugFlags.push("mcap_crashing");
    if ((features.rg_buyerRetention || 0) < 0.5) rugFlags.push("early_buyers_fled");
    if ((features.ch_smoothGrind || 0) > 0.5) rugFlags.push("fake_chart_smooth_grind");
    if ((features.ch_dipRatio || 0.5) < 0.1 && (features.ch_smoothGrind || 0) > 0.3) rugFlags.push("no_natural_dips");
    if ((features.ch_staircaseScore || 0) > 0.4) rugFlags.push("staircase_chart");
    if ((features.rg_zeroSellFlag || 0) > 0.5) rugFlags.push("zero_organic_sells");
    if ((features.rg_buySellImbalance || 0) > 0.5) rugFlags.push("extreme_buy_sell_imbalance");
    if ((features.rg_fakeVolumeScore || 0) > 0.4) rugFlags.push("fake_volume_wash_trading");
    if ((features.rg_gradualRugScore || 0) > 0.5) rugFlags.push("gradual_rug_bot_trap");
    if ((features.rg_gradualRugScore || 0) > 0.3 && (features.ch_smoothGrind || 0) > 0.3) rugFlags.push("gradual_rug_smooth_chart");
    if ((features.rg_devSelfPumpScore || 0) > 0.5) rugFlags.push("dev_self_pump");
    if ((features.rg_velocityLinearity || 0) > 0.85 && (features.rg_buySellImbalance || 0) > 0.6) rugFlags.push("linear_pump_no_sells");
    if ((features.rg_buyTimingRegularity || 0) > 0.6) rugFlags.push("metronome_buys");
    if ((features.rg_singleWalletDominance || 0) > 0.5) rugFlags.push("single_wallet_pump");

    // ── Zero sell hard penalty ──
    // A token with many buys and zero sells is the #1 rug pattern
    const zeroSellPenalty = (features.rg_zeroSellFlag || 0) > 0.7
      ? Math.round((features.rg_zeroSellFlag) * 30)
      : (features.rg_buySellImbalance || 0) > 0.5
        ? Math.round((features.rg_buySellImbalance) * 20)
        : 0;

    // ── Gradual rug penalty ──
    // Sustained buy-only activity with uniform timing over minutes = bot trap
    const gradualRugPenalty = (features.rg_gradualRugScore || 0) >= 0.7
      ? Math.round(features.rg_gradualRugScore * 35) // severe: near-certain trap
      : (features.rg_gradualRugScore || 0) >= 0.4
        ? Math.round(features.rg_gradualRugScore * 20)
        : 0;

    // ── Dev self-pump penalty ──
    // Linear velocity + metronome buys + no sells + concentrated = dev self-pump
    const devPumpPenalty = (features.rg_devSelfPumpScore || 0) >= 0.7
      ? Math.round(features.rg_devSelfPumpScore * 40) // severe: near-certain pump
      : (features.rg_devSelfPumpScore || 0) >= 0.4
        ? Math.round(features.rg_devSelfPumpScore * 25)
        : 0;

    const finalScore = (rawScore * 100 + 0.5) | 0;
    const clamped = finalScore - rugPenalty - chartPenalty - zeroSellPenalty - gradualRugPenalty - devPumpPenalty;

    // ── Hard reject: 3+ moderate rug signals = instant block ──
    // This is the CRITICAL safety gate — prevents buying into obvious rugs
    const hardReject = rugFlags.length >= 3
      || (features.rg_zeroSellFlag || 0) >= 0.8
      || ((features.rg_zeroSellFlag || 0) >= 0.5 && (features.ch_smoothGrind || 0) > 0.3)
      || ((features.rg_zeroSellFlag || 0) >= 0.5 && (features.ch_staircaseScore || 0) > 0.3)
      || ((features.rg_buySellImbalance || 0) >= 0.7 && (features.rg_fakeVolumeScore || 0) > 0.3)
      || ((features.ch_staircaseScore || 0) >= 0.6 && (features.rg_buySellImbalance || 0) > 0.5)
      // Gradual rug: sustained buy-only chart with uniform timing = classic bot trap
      || (features.rg_gradualRugScore || 0) >= 0.7
      || ((features.rg_gradualRugScore || 0) >= 0.5 && (features.ch_smoothGrind || 0) > 0.3)
      || ((features.rg_gradualRugScore || 0) >= 0.5 && (features.rg_zeroSellFlag || 0) >= 0.5)
      // Dev self-pump: linear velocity + metronome buys + concentration
      || (features.rg_devSelfPumpScore || 0) >= 0.7
      || ((features.rg_devSelfPumpScore || 0) >= 0.5 && (features.rg_zeroSellFlag || 0) >= 0.5)
      || ((features.rg_velocityLinearity || 0) > 0.9 && (features.rg_buySellImbalance || 0) > 0.7);

    return {
      score: clamped < 0 ? 0 : clamped > 99 ? 99 : clamped,
      tippingScore: (tippingScore * 100 + 0.5) | 0,
      bondProb,
      rugScore: (rugRisk * 100 + 0.5) | 0,
      hardReject,
      rugFlags,
      zeroSellPenalty,
      gradualRugPenalty,
      devPumpPenalty,
      subScores: {
        tippingPoint: (s_tp * 100 + 0.5) | 0,
        kahneman: (s_k * 100 + 0.5) | 0,
        onChain: (s_oc * 100 + 0.5) | 0,
        rugDetection: (s_rg * 100 + 0.5) | 0,
        chartPattern: (s_ch * 100 + 0.5) | 0,
        cascade: (s_cs * 100 + 0.5) | 0,
        viral: (s_sir * 100 + 0.5) | 0,
        gradFrontrun: (s_gf * 100 + 0.5) | 0,
        attentionDiv: (s_apd * 100 + 0.5) | 0,
        social: (s_so * 100 + 0.5) | 0,
        timing: (s_mt * 100 + 0.5) | 0,
      },
      chartPenalty,
      confidence: Math.min(99, 40 + ((this.trainCount / 10 + 0.5) | 0)),
      modelVersion: this.trainCount,
    };
  }

  // Online learning: update weights based on outcome
  learn(features, outcome) {
    // outcome: { graduated: bool, peakMcx: number, fleetPnl: number }
    const predicted = this.score(features);
    const actual = outcomeToLabel(outcome);
    const error = actual - predicted.score / 100;

    // Gradient update per feature — losses teach 2x faster (asymmetric learning)
    const lossMultiplier = error < 0 ? 2.0 : 1.0;
    for (const key of FEATURE_KEYS) {
      const val = features[key] || 0;
      if (val > 0) {
        this.weights[key] += this.learningRate * lossMultiplier * error * val;
        this.weights[key] = Math.max(0.1, Math.min(5.0, this.weights[key]));
      }
    }

    // Invalidate multiplier cache — weights changed
    this._mCache = null;

    // Track accuracy
    this.trainCount++;
    const predBool = predicted.score >= 50;
    const actualBool = actual >= 0.5;
    if (predBool === actualBool) this.accuracy.correct++;
    this.accuracy.total++;

    // Track per-bracket accuracy (which score ranges actually predict winners?)
    const bracket = Math.floor(predicted.score / 10) * 10; // 0, 10, 20, ..., 90
    if (!this.bracketAccuracy[bracket]) this.bracketAccuracy[bracket] = { wins: 0, losses: 0, totalPnl: 0 };
    if (actualBool) this.bracketAccuracy[bracket].wins++;
    else this.bracketAccuracy[bracket].losses++;
    if (outcome.fleetPnl != null) this.bracketAccuracy[bracket].totalPnl += outcome.fleetPnl;

    return {
      trainCount: this.trainCount,
      error: Math.abs(error),
      accuracy: this.accuracy.total > 0 ? (this.accuracy.correct / this.accuracy.total * 100).toFixed(1) : "N/A",
    };
  }

  getStats() {
    return {
      trainCount: this.trainCount,
      accuracy: this.accuracy.total > 10 ? (this.accuracy.correct / this.accuracy.total * 100).toFixed(1) + "%" : "calibrating",
      topFeatures: this.getTopFeatures(10),
      weights: { ...this.weights },
      bracketAccuracy: Object.entries(this.bracketAccuracy).map(([b, d]) => ({
        range: `${b}-${+b + 10}`,
        trades: d.wins + d.losses,
        winRate: d.wins + d.losses > 0 ? +((d.wins / (d.wins + d.losses)) * 100).toFixed(1) : 0,
        totalPnl: +d.totalPnl.toFixed(4),
      })).sort((a, b) => +a.range.split("-")[0] - +b.range.split("-")[0]),
    };
  }

  getTopFeatures(n = 10) {
    return Object.entries(this.weights)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => ({ feature: k, weight: v.toFixed(3) }));
  }

  export() {
    return { weights: this.weights, groupWeights: this.groupWeights, trainCount: this.trainCount, accuracy: this.accuracy, bracketAccuracy: this.bracketAccuracy };
  }

  import(data) {
    if (data.weights) this.weights = data.weights;
    if (data.groupWeights) this.groupWeights = data.groupWeights;
    if (data.trainCount) this.trainCount = data.trainCount;
    if (data.accuracy) this.accuracy = data.accuracy;
    if (data.bracketAccuracy) this.bracketAccuracy = data.bracketAccuracy;
    this._mCache = null; // invalidate cache
  }
}

// ═══ RAG MEMORY — Vector Similarity Store ═══
// In-memory cosine similarity (upgrade to Qdrant/pgvector for production)

class RAGMemory {
  constructor(maxSize = 10000) {
    this.store = [];       // [{ ca, features, outcome, embedding, timestamp }]
    this.maxSize = maxSize;
  }

  // Store a token + features + outcome
  add(ca, features, outcome = null) {
    const embedding = featuresToVector(features);
    const entry = { ca, features, outcome, embedding, timestamp: Date.now() };

    // Deduplicate
    const idx = this.store.findIndex(e => e.ca === ca);
    if (idx >= 0) {
      this.store[idx] = { ...this.store[idx], ...entry, outcome: outcome || this.store[idx].outcome };
    } else {
      this.store.push(entry);
      if (this.store.length > this.maxSize) {
        this.store.shift(); // FIFO eviction
      }
    }
  }

  // Update outcome for an existing token
  updateOutcome(ca, outcome) {
    const entry = this.store.find(e => e.ca === ca);
    if (entry) {
      entry.outcome = { ...entry.outcome, ...outcome };
      return true;
    }
    return false;
  }

  // Find K most similar past tokens
  findSimilar(features, k = 5) {
    if (this.store.length === 0) return [];
    const query = featuresToVector(features);

    const scored = this.store
      .filter(e => e.outcome)  // Only tokens with known outcomes
      .map(e => ({
        ...e,
        similarity: cosineSim(query, e.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);

    return scored.map(s => ({
      ca: s.ca,
      similarity: (s.similarity * 100).toFixed(1) + "%",
      outcome: s.outcome,
      age: Math.round((Date.now() - s.timestamp) / 3600000) + "h ago",
    }));
  }

  getStats() {
    const withOutcome = this.store.filter(e => e.outcome).length;
    const graduated = this.store.filter(e => e.outcome?.graduated).length;
    // Also count tokens that graduated by other signals (mcap, bonding curve, etc.)
    const gradBySignal = this.store.filter(e => e.graduated || e.features?.graduated).length;
    const totalGrad = Math.max(graduated, gradBySignal);
    // Use whichever denominator is available: labeled outcomes first, then total tokens
    let graduationRate;
    if (withOutcome > 0) {
      graduationRate = (graduated / withOutcome * 100).toFixed(1) + "%";
    } else if (this.store.length > 0 && totalGrad > 0) {
      graduationRate = (totalGrad / this.store.length * 100).toFixed(1) + "%";
    } else {
      graduationRate = "0%";
    }
    return {
      total: this.store.length,
      labeled: withOutcome,
      graduated: totalGrad,
      graduationRate,
    };
  }

  // Export for Redis persistence
  export() { return this.store; }
  import(data) { if (Array.isArray(data)) this.store = data; }
}

// ═══ OUTCOME MONITOR — Auto-labels tokens ═══

class OutcomeMonitor {
  constructor() {
    this.pending = new Map();  // ca → { features, scoreResult, timestamp, checks: [] }
    this.checkIntervals = [
      { delay: 30 * 60 * 1000, label: "30m" },
      { delay: 2 * 60 * 60 * 1000, label: "2h" },
      { delay: 6 * 60 * 60 * 1000, label: "6h" },
      { delay: 24 * 60 * 60 * 1000, label: "24h" },
    ];
  }

  // Register a token to monitor
  track(ca, features, scoreResult) {
    this.pending.set(ca, {
      features,
      scoreResult,
      timestamp: Date.now(),
      launchMcap: features.oc_mcapSol || 0,
      checks: [],
    });
  }

  // Called periodically (e.g., every 5 min) with current token data
  // Returns outcomes ready for labeling
  check(currentTokens) {
    const now = Date.now();
    const outcomes = [];

    for (const [ca, entry] of this.pending) {
      const age = now - entry.timestamp;

      for (const interval of this.checkIntervals) {
        if (age >= interval.delay && !entry.checks.includes(interval.label)) {
          entry.checks.push(interval.label);

          // Find current data for this token
          const current = currentTokens.find(t => t.ca === ca);
          if (current) {
            const outcome = {
              ca,
              checkPoint: interval.label,
              graduated: !!(current.graduated || current.raydiumPool),
              peakMcx: entry.launchMcap > 0 ? (current.mcapSol || 0) / (entry.launchMcap * 140) : 0,
              currentMcap: current.mcapUsd || 0,
              alive: !current.rugged && (current.mcapUsd || 0) > 1000,
              holderCount: current.holders || 0,
            };
            outcomes.push(outcome);
          }
        }
      }

      // Clean up after 24h
      if (age > 25 * 60 * 60 * 1000) {
        this.pending.delete(ca);
      }
    }

    return outcomes;
  }

  getStats() {
    return {
      tracking: this.pending.size,
      oldest: this.pending.size > 0 ? Math.round((Date.now() - Math.min(...[...this.pending.values()].map(e => e.timestamp))) / 3600000) + "h" : "N/A",
    };
  }
}

// ═══ MAIN INTELLIGENCE CLASS ═══

export class MemeIntelligence {
  constructor(redis = null, metaTracker = null) {
    this.redis = redis;
    this.scorer = new ScoringEngine();
    this.memory = new RAGMemory(10000);
    this.monitor = new OutcomeMonitor();
    this.meta = metaTracker;  // MetaTracker from meta-engine.mjs (optional)
    this.eventLog = [];    // Last 100 events
    this.startTime = Date.now();

    // Try to restore state from Redis
    this._restore();
  }

  // ─── SCORE A TOKEN ───
  async score(tokenData) {
    const features = extractFeatures(tokenData);
    const scoreResult = this.scorer.score(features);

    // RAG: find similar past tokens
    const similar = this.memory.findSimilar(features, 5);

    // RAG boost: if similar tokens graduated, boost score
    if (similar.length > 0) {
      const graduatedSimilar = similar.filter(s => s.outcome?.graduated);
      const ragBoost = graduatedSimilar.length / similar.length;
      scoreResult.ragBoost = Math.round(ragBoost * 20);
      scoreResult.score = Math.min(99, scoreResult.score + scoreResult.ragBoost);
      scoreResult.bondProb = Math.min(99, scoreResult.bondProb + Math.round(ragBoost * 10));
    }

    scoreResult.similar = similar;
    scoreResult.features = features;

    // ── META BOOST: adjust score based on current narrative heat ──
    if (this.meta) {
      const metaResult = this.meta.getMetaBoost(tokenData);
      scoreResult.metaBoost = metaResult.boost;
      scoreResult.narrative = metaResult.narrative;
      scoreResult.narrativeName = metaResult.narrativeName;
      scoreResult.metaHeat = metaResult.heat;
      if (metaResult.boost > 0) {
        scoreResult.score = Math.min(99, scoreResult.score + metaResult.boost);
        scoreResult.bondProb = Math.min(99, scoreResult.bondProb + Math.round(metaResult.boost * 0.6));
      }
      // Record sighting for meta tracking
      this.meta.recordSighting(tokenData);
    }

    // Store in memory + monitor
    this.memory.add(tokenData.ca, features);
    this.monitor.track(tokenData.ca, features, scoreResult);

    this._log("score", { ca: tokenData.ca, score: scoreResult.score, bondProb: scoreResult.bondProb, meta: scoreResult.narrative });

    return scoreResult;
  }

  // ─── LABEL AN OUTCOME ───
  async labelOutcome(ca, outcome) {
    // Update memory
    this.memory.updateOutcome(ca, outcome);

    // Find features for this token
    const entry = this.memory.store.find(e => e.ca === ca);
    if (entry?.features) {
      // Online learning
      const learnResult = this.scorer.learn(entry.features, outcome);
      this._log("learn", { ca, outcome, ...learnResult });

      // Record outcome in meta tracker (narrative-level learning)
      if (this.meta) {
        this.meta.record(
          { ca, name: entry.name || ca, ticker: entry.ticker || "", description: entry.description || "" },
          { graduated: outcome.graduated, pnl: outcome.fleetPnl || 0, mcapMultiple: outcome.peakMcx || 0 }
        );
      }

      // Persist weights
      await this._persist();

      return learnResult;
    }
    return null;
  }

  // ─── CHECK PENDING OUTCOMES ───
  // Call this periodically with current radar data
  async checkOutcomes(currentTokens) {
    const outcomes = this.monitor.check(currentTokens);

    for (const outcome of outcomes) {
      await this.labelOutcome(outcome.ca, outcome);
    }

    return outcomes;
  }

  // ─── GET FULL STATS ───
  getStats() {
    return {
      uptime: Math.round((Date.now() - this.startTime) / 3600000) + "h",
      scorer: this.scorer.getStats(),
      memory: this.memory.getStats(),
      monitor: this.monitor.getStats(),
      meta: this.meta ? this.meta.getCurrentMeta() : null,
      recentEvents: this.eventLog.slice(-20),
    };
  }

  // ─── PERSISTENCE ───
  async _persist() {
    if (!this.redis) return;
    try {
      await this.redis.set("intel:weights", JSON.stringify(this.scorer.export()), { EX: 604800 });
      // Memory is large — persist only last 1000
      const recent = this.memory.store.slice(-1000).map(e => ({ ca: e.ca, features: e.features, outcome: e.outcome, timestamp: e.timestamp }));
      await this.redis.set("intel:memory", JSON.stringify(recent), { EX: 604800 });
    } catch (e) {
      console.error("[INTEL] Persist error:", e.message);
    }
  }

  async _restore() {
    if (!this.redis) return;
    try {
      const weights = await this.redis.get("intel:weights");
      if (weights) {
        this.scorer.import(JSON.parse(weights));
        console.log(`[INTEL] Restored scorer: ${this.scorer.trainCount} training samples`);
      }
      const memory = await this.redis.get("intel:memory");
      if (memory) {
        const entries = JSON.parse(memory);
        for (const e of entries) {
          this.memory.add(e.ca, e.features, e.outcome);
        }
        console.log(`[INTEL] Restored memory: ${entries.length} tokens`);
      }
    } catch (e) {
      console.error("[INTEL] Restore error:", e.message);
    }
  }

  _log(type, data) {
    this.eventLog.push({ type, data, time: Date.now() });
    if (this.eventLog.length > 100) this.eventLog.shift();
  }
}

// ═══ UTILITY FUNCTIONS ═══

function gini(values) {
  if (!values || values.length < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = avg(sorted);
  if (mean === 0) return 0;
  let sumDiff = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sumDiff += Math.abs(sorted[i] - sorted[j]);
    }
  }
  return Math.min(1, sumDiff / (2 * n * n * mean));
}

function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function featuresToVector(features) {
  return FEATURE_KEYS.map(k => features[k] || 0);
}

function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

function outcomeToLabel(outcome) {
  if (!outcome) return 0.5;
  let score = 0.25; // base — slightly skeptical default
  if (outcome.graduated) score += 0.4;
  if (outcome.peakMcx > 5) score += 0.15;
  if (outcome.peakMcx > 10) score += 0.1;
  if (outcome.alive) score += 0.1;
  // Rug pull penalties — HEAVY so model learns from losses fast
  if (outcome.rugged) score -= 0.7;
  if (outcome.mcapDropPct > 80) score -= 0.4;
  if (outcome.mcapDropPct > 50) score -= 0.2;
  if (outcome.devDumped) score -= 0.5;
  return Math.max(0, Math.min(1, score));
}

// ═══ EXPRESS ROUTE HELPERS ═══
// Add these to your server.js:
//
//   import { MemeIntelligence } from "./engine/meme-intelligence.mjs";
//   const intel = new MemeIntelligence(redis);
//
//   app.get("/api/intel/score/:ca", async (req, res) => {
//     const tokenData = radarTokens.find(t => t.ca === req.params.ca) || { ca: req.params.ca };
//     const result = await intel.score(tokenData);
//     res.json(result);
//   });
//
//   app.get("/api/intel/stats", (req, res) => res.json(intel.getStats()));
//
//   // In your radar update loop:
//   setInterval(async () => {
//     const outcomes = await intel.checkOutcomes(currentRadarTokens);
//     if (outcomes.length > 0) console.log(`[INTEL] Labeled ${outcomes.length} outcomes`);
//   }, 5 * 60 * 1000);
//
//   // Score every new token that enters radar:
//   onNewRadarToken(async (token) => {
//     token.intelScore = await intel.score(token);
//   });

// ═══ SCORE DYNAMICS — Velocity & Acceleration ═══
// Axiom: a token's fate is encoded not in its score, but in the *derivatives* of its score.
//
// Physics of rug pulls:
//   - Score decelerating (d²S/dt² < 0) while still positive = the pump is losing energy.
//     Like a ball thrown upward — still rising, but gravity is winning. Get out before the peak.
//   - Sharp negative velocity spike (dS/dt << 0) = something broke. Instant exit signal.
//   - Score accelerating upward (d²S/dt² > 0) = momentum building. Runner — let it ride.
//
// The score itself is a lagging indicator. The derivatives are *leading* indicators.
// By the time the score drops below threshold, you've already lost. The acceleration
// told you 2 cycles ago.

class ScoreDynamics {
  constructor(maxTokens = 5000) {
    this.history = new Map(); // ca → { scores: [{s, t}], v, a, impulse }
    this.maxTokens = maxTokens;
  }

  // Record a score observation. Returns { velocity, acceleration, trend }
  // velocity: points per second (positive = improving)
  // acceleration: change in velocity per second (positive = momentum building)
  // trend: "rocket" | "rising" | "fading" | "crashing" | "stable"
  record(ca, score) {
    const now = Date.now();
    let entry = this.history.get(ca);
    if (!entry) {
      entry = { scores: [], v: 0, a: 0, impulse: 0 };
      this.history.set(ca, entry);
      // Evict oldest if at capacity
      if (this.history.size > this.maxTokens) {
        const oldest = this.history.keys().next().value;
        this.history.delete(oldest);
      }
    }

    const scores = entry.scores;
    scores.push({ s: score, t: now });

    // Keep only last 6 observations (enough for 2nd derivative)
    if (scores.length > 6) scores.shift();

    if (scores.length < 2) {
      entry.v = 0;
      entry.a = 0;
      entry.impulse = 0;
      return { velocity: 0, acceleration: 0, impulse: 0, ivRatio: 0, momentum: "nascent", trend: "stable", scores: scores.length };
    }

    // ── Compute velocity: weighted linear regression on recent points ──
    // More recent points get more weight (exponential decay)
    const n = scores.length;
    const latest = scores[n - 1];
    const prev = scores[n - 2];
    const dt = (latest.t - prev.t) / 1000; // seconds

    // Instantaneous velocity (points per second)
    const v = dt > 0 ? (latest.s - prev.s) / dt : 0;

    // Smoothed velocity (EMA with previous to reduce noise)
    entry.v = entry.v === 0 ? v : entry.v * 0.3 + v * 0.7;

    // ── Compute acceleration: change in velocity ──
    if (scores.length >= 3) {
      const pp = scores[n - 3];
      const dtPrev = (prev.t - pp.t) / 1000;
      const vPrev = dtPrev > 0 ? (prev.s - pp.s) / dtPrev : 0;
      const aDt = (latest.t - pp.t) / 1000;
      const rawA = aDt > 0 ? (v - vPrev) / aDt : 0;
      entry.a = entry.a === 0 ? rawA : entry.a * 0.3 + rawA * 0.7;
    }

    // ── Impulse: area under velocity curve (trapezoidal integration) ──
    // Impulse = accumulated |velocity| × dt — measures total energy delivered.
    // High impulse + high velocity = sustained runner. Low impulse + high velocity = flash pump.
    const dtImpulse = (latest.t - prev.t) / 1000;
    const trapArea = dtImpulse > 0 ? ((Math.abs(entry.v) + Math.abs(v)) / 2) * dtImpulse : 0;
    entry.impulse = (entry.impulse || 0) + trapArea;
    // Decay impulse slowly so stale tokens don't accumulate forever (half-life ~5 min)
    const decayFactor = Math.exp(-dtImpulse / 300);
    entry.impulse *= decayFactor;
    entry.impulse += trapArea;

    // ── Impulse/Velocity ratio: sustained vs flash ──
    // High ratio = large accumulated area relative to current speed = sustained momentum
    // Low ratio = speed spike with no history = flash pump / unsustained
    const absV = Math.abs(entry.v);
    const ivRatio = absV > 0.01 ? entry.impulse / absV : 0;

    // ── Momentum classification (using impulse + velocity together) ──
    let momentum;
    if (entry.v > 0.1 && ivRatio > 30) momentum = "sustained";       // big area, still fast = strong runner
    else if (entry.v > 0.2 && ivRatio < 10) momentum = "flash";       // fast but no history = flash pump
    else if (entry.v < -0.1 && entry.impulse > 20) momentum = "exhausted"; // was big, now falling = momentum exhaustion
    else if (entry.v > 0.05 && ivRatio > 15) momentum = "building";   // moderate area, rising = early runner
    else if (entry.v < -0.05) momentum = "fading";
    else momentum = "nascent";

    // ── Classify trend ──
    let trend;
    if (entry.v > 0.3 && entry.a > 0.01) trend = "rocket";       // accelerating upward
    else if (entry.v > 0.1) trend = "rising";                      // steady climb
    else if (entry.v > 0 && entry.a < -0.01) trend = "fading";     // still up but decelerating
    else if (entry.v < -0.3) trend = "crashing";                   // falling fast
    else if (entry.v < -0.05) trend = "declining";                  // drifting down
    else trend = "stable";

    return {
      velocity: +entry.v.toFixed(4),
      acceleration: +entry.a.toFixed(6),
      impulse: +entry.impulse.toFixed(2),
      ivRatio: +ivRatio.toFixed(1),
      momentum,
      trend,
      scores: n,
    };
  }

  // Get current dynamics for a token (without recording new score)
  get(ca) {
    const entry = this.history.get(ca);
    if (!entry) return null;
    const n = entry.scores.length;
    const absV = Math.abs(entry.v);
    const ivRatio = absV > 0.01 ? (entry.impulse || 0) / absV : 0;
    let momentum;
    if (entry.v > 0.1 && ivRatio > 30) momentum = "sustained";
    else if (entry.v > 0.2 && ivRatio < 10) momentum = "flash";
    else if (entry.v < -0.1 && (entry.impulse || 0) > 20) momentum = "exhausted";
    else if (entry.v > 0.05 && ivRatio > 15) momentum = "building";
    else if (entry.v < -0.05) momentum = "fading";
    else momentum = "nascent";
    return {
      velocity: +entry.v.toFixed(4),
      acceleration: +entry.a.toFixed(6),
      impulse: +(entry.impulse || 0).toFixed(2),
      ivRatio: +ivRatio.toFixed(1),
      momentum,
      trend: entry.v > 0.3 && entry.a > 0.01 ? "rocket"
        : entry.v > 0.1 ? "rising"
        : entry.v > 0 && entry.a < -0.01 ? "fading"
        : entry.v < -0.3 ? "crashing"
        : entry.v < -0.05 ? "declining"
        : "stable",
      lastScore: n > 0 ? entry.scores[n - 1].s : 0,
      scores: n,
    };
  }

  // Prune tokens not seen in 30 minutes
  prune() {
    const cutoff = Date.now() - 1800000;
    for (const [ca, entry] of this.history) {
      const last = entry.scores[entry.scores.length - 1];
      if (!last || last.t < cutoff) this.history.delete(ca);
    }
  }
}

export default MemeIntelligence;
export { extractFeatures, ScoringEngine, RAGMemory, OutcomeMonitor, ScoreDynamics, FEATURE_KEYS };
