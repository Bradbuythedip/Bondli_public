// BONDLI — Velocity-Potential Scoring Engine
// Identifies tokens EARLY: high potential + low velocity = ape before the crowd
//
// MATH:
//   ape_score = potential_score / (velocity_score + ε)
//
//   velocity_score (0-100): how much the token has ALREADY moved
//     - price change acceleration (high = late, low = early)
//     - volume relative to mcap (high ratio = already discovered)
//     - social mention velocity (trending = already crowded)
//
//   potential_score (0-100): how likely it is to pump
//     - liquidity/mcap ratio (higher = healthier, harder to rug)
//     - mcap headroom (lower mcap = more room to grow)
//     - holder quality signals (smart money wallets accumulating)
//     - bonding curve progress (10-40% = sweet spot)
//     - age sweet spot (5min - 2hr = goldilocks zone)
//
//   ε = 5 (floor to avoid div-by-zero and prevent infinite scores on zero-velocity coins)

import { scoreVolumeLegitimacy } from "./volume-legitimacy.mjs";

const EPSILON = 5;

// ── Velocity Score: how much has this token already moved? ──
// Higher = more discovered = we're LATE
function calcVelocity(token) {
  let v = 0;

  // 1. Price acceleration — fast movers are already found
  //    5m change > 20% means candle is already green, we're chasing
  const abs5m = Math.abs(token.change5m || 0);
  const abs1h = Math.abs(token.change1h || 0);
  if (abs5m > 50) v += 35;
  else if (abs5m > 20) v += 25;
  else if (abs5m > 10) v += 15;
  else if (abs5m > 5) v += 8;
  else v += 2; // barely moving = early

  // 2. Volume/Mcap ratio — high means overtraded relative to size
  //    healthy early token: vol/mcap < 0.5
  //    already discovered:  vol/mcap > 2.0
  const volMcapRatio = (token.volume24h || 0) / Math.max(token.mcapUsd || 1, 1);
  if (volMcapRatio > 5) v += 30;
  else if (volMcapRatio > 2) v += 20;
  else if (volMcapRatio > 1) v += 12;
  else if (volMcapRatio > 0.5) v += 6;
  else v += 1;

  // 3. 1h change magnitude — sustained move = already in play
  if (abs1h > 100) v += 25;
  else if (abs1h > 50) v += 18;
  else if (abs1h > 20) v += 10;
  else if (abs1h > 5) v += 4;
  else v += 1;

  // 4. Transaction density (if available)
  //    high buy+sell txn count = already discovered
  const txns = token.txns24h || {};
  const totalTxns = (txns.buys || 0) + (txns.sells || 0);
  if (totalTxns > 500) v += 10;
  else if (totalTxns > 100) v += 5;
  else v += 0;

  return Math.min(100, v);
}

// ── Potential Score: how likely is this to pump? ──
// Higher = better opportunity
function calcPotential(token) {
  let p = 0;

  // 1. Mcap headroom — lower mcap = more room to grow
  //    Sweet spot: $5K-$100K (pre-graduation or just graduated)
  //    pump.fun graduation ≈ $69K MC
  const mcap = token.mcapUsd || 0;
  if (mcap > 0 && mcap < 10000) p += 15;        // super early, risky but huge upside
  else if (mcap < 30000) p += 25;                // pre-graduation sweet spot
  else if (mcap < 70000) p += 30;                // approaching graduation — max potential
  else if (mcap < 150000) p += 22;               // just graduated, still good
  else if (mcap < 500000) p += 12;               // mid-range, moderate upside
  else if (mcap < 2000000) p += 5;               // large cap for meme, limited upside
  else p += 1;                                    // whale territory, skip

  // 2. Liquidity / Mcap ratio — health check
  //    Ratio > 0.10 = good liquidity relative to mcap
  //    Ratio < 0.03 = thin, easy to rug or get slipped
  const liqRatio = (token.liquidity || 0) / Math.max(mcap, 1);
  if (liqRatio > 0.15) p += 20;     // very healthy
  else if (liqRatio > 0.08) p += 15;
  else if (liqRatio > 0.04) p += 10;
  else if (liqRatio > 0.02) p += 5;
  else p += 0;                       // dangerously thin

  // 3. Age sweet spot — too young = untested, too old = dead
  //    Goldilocks: 5 min to 2 hours
  const ageMs = token.pairCreated ? Date.now() - token.pairCreated : null;
  if (ageMs !== null) {
    const ageMin = ageMs / 60000;
    if (ageMin >= 5 && ageMin <= 15) p += 20;       // just launched, activity starting
    else if (ageMin <= 30) p += 18;                  // early discovery window
    else if (ageMin <= 60) p += 14;                  // still in play
    else if (ageMin <= 120) p += 10;                 // getting older
    else if (ageMin <= 360) p += 5;                  // late
    else p += 1;                                     // stale
  } else {
    p += 5; // unknown age, neutral
  }

  // 4. Positive momentum direction (not magnitude)
  //    We WANT slight positive — confirms organic interest starting
  //    Flat/slightly green > deep green (deep green = already pumped)
  const c5m = token.change5m || 0;
  const c1h = token.change1h || 0;
  if (c5m > 0 && c5m < 15 && c1h > 0 && c1h < 30) {
    p += 15; // gentle organic green — perfect entry
  } else if (c5m > 0 && c5m < 30) {
    p += 10; // moving up but not crazy
  } else if (c5m >= -5 && c5m <= 0) {
    p += 8;  // slight pullback — dip buy opportunity
  } else if (c5m < -10) {
    p += 2;  // dumping, risky
  }

  // 5. Buy/sell ratio — more buys than sells = accumulation
  //    BUT: extreme ratios (all buys, zero sells) are a rug pattern, not organic
  const txns = token.txns24h || {};
  const buys = txns.buys || 0;
  const sells = txns.sells || 0;
  if (buys > 0 && sells > 0) {
    const bsRatio = buys / sells;
    if (bsRatio > 10.0 && buys >= 10) p -= 10; // extreme imbalance = likely self-bought trap
    else if (bsRatio > 2.0) p += 15;      // strong accumulation
    else if (bsRatio > 1.3) p += 10;  // healthy buying
    else if (bsRatio > 1.0) p += 5;   // slight edge to buyers
    else if (bsRatio > 0.7) p += 2;   // balanced
    else p += 0;                       // selling pressure
  } else if (buys >= 10 && sells === 0) {
    // All buys, zero sells with significant activity = classic rug trap
    p -= 15;
  }

  // 6. Volume legitimacy — real volume = real fees = legit token
  //    PumpFun fees/sec is the ultimate signal: high fee rate + organic patterns = real
  //    Botted volume with few wallets = instant penalty
  const volLeg = scoreVolumeLegitimacy(token);
  if (volLeg.legitimacy === "REAL_VOLUME") p += 15;       // strong organic volume
  else if (volLeg.legitimacy === "LIKELY_ORGANIC") p += 8;
  else if (volLeg.legitimacy === "SUSPICIOUS") p -= 5;
  else if (volLeg.legitimacy === "LIKELY_BOTTED") p -= 15; // fake volume = danger

  // Extra penalty for high bot detection score
  if (volLeg.botDetection.botScore >= 60) p -= 10;

  // Store for downstream use
  token._volumeLegitimacy = volLeg;

  return Math.min(100, Math.max(0, p));
}

// ── Main: Ape Score ──
// ape_score = potential / (velocity + ε)
// Range: 0 to ~20 (theoretical max: 100/5 = 20)
// Interpretation:
//   > 5.0  = strong ape signal (high potential, low velocity)
//   3.0-5.0 = moderate signal (worth watching)
//   1.0-3.0 = weak (already moving or low potential)
//   < 1.0  = skip (late or garbage)
function scoreToken(token) {
  const velocity = calcVelocity(token);
  const potential = calcPotential(token);
  const apeScore = potential / (velocity + EPSILON);

  // Pull volume legitimacy computed during calcPotential
  const volLeg = token._volumeLegitimacy || null;

  return {
    ca: token.ca,
    name: token.name,
    ticker: token.ticker,
    apeScore: Math.round(apeScore * 100) / 100,
    velocity,
    potential,
    mcapUsd: token.mcapUsd || 0,
    volume24h: token.volume24h || 0,
    liquidity: token.liquidity || 0,
    change5m: token.change5m || 0,
    change1h: token.change1h || 0,
    change24h: token.change24h || 0,
    ageMin: token.pairCreated ? Math.round((Date.now() - token.pairCreated) / 60000) : null,
    signal: apeScore >= 5.0 ? "STRONG_APE" : apeScore >= 3.0 ? "WATCH" : apeScore >= 1.0 ? "WEAK" : "SKIP",
    // Volume legitimacy — fee accrual rate + organic volume detection
    volumeLegitimacy: volLeg ? {
      score: volLeg.legitimacyScore,
      label: volLeg.legitimacy,
      feePerSec: volLeg.feeRate.feePerSec,
      feeRating: volLeg.feeRate.feeRating,
      botScore: volLeg.botDetection.botScore,
      organicScore: volLeg.botDetection.organicScore,
      botSignals: volLeg.botDetection.signals,
    } : null,
    breakdown: {
      velocity_components: {
        priceAccel: Math.abs(token.change5m || 0),
        volMcapRatio: (token.volume24h || 0) / Math.max(token.mcapUsd || 1, 1),
        hourMagnitude: Math.abs(token.change1h || 0),
      },
      potential_components: {
        mcapHeadroom: token.mcapUsd || 0,
        liqRatio: (token.liquidity || 0) / Math.max(token.mcapUsd || 1, 1),
        momentumDir: token.change5m || 0,
        volumeLegitimacy: volLeg?.legitimacyScore || 0,
      },
    },
  };
}

// Score and rank a list of tokens
function rankTokens(tokens, minApeScore = 1.0) {
  return tokens
    .map(scoreToken)
    .filter(t => t.apeScore >= minApeScore)
    .sort((a, b) => b.apeScore - a.apeScore);
}

export { calcVelocity, calcPotential, scoreToken, rankTokens, EPSILON };
export default rankTokens;
