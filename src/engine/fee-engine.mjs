// BONDLI v5.0 — Fee Engine (profit ladder + share-to-earn viral loop)
// Tiers: Free (25% → 5% sliding, 2% network fee), VIP (0% visible, 2% network fee)
// Profit ladder: more profit = lower fees (rewards winning, incentivizes retention)
// Share-to-earn: profitable trades generate shareable win cards → viral growth
// Referral splits: referrer gets portion of platform revenue from referred users
import crypto from "crypto";

// ── Platform config ──
const PLATFORM_WALLET = process.env.PLATFORM_WALLET || "4XnHZZmHwSQ8RszJsdc7snvxG8dZtm6g4hvpkCMkguMx";
const FREE_PROFIT_CUT = parseFloat(process.env.FREE_PROFIT_CUT || "25"); // % — visible to free users
const NETWORK_FEE_PCT = parseFloat(process.env.NETWORK_FEE_PCT || "2");  // % — silent fee on Pro/VIP profits
const VIP_FEE_SOL = parseFloat(process.env.VIP_FEE_SOL || "10");
const MIN_PROFIT_THRESHOLD = 0.001; // SOL — don't skim dust

// Referral commission rates (% of platform's take that goes to referrer)
const REFERRAL_RATE_FREE = parseFloat(process.env.REFERRAL_RATE_FREE || "20");   // 20% of platform cut → referrer
const REFERRAL_RATE_VIP  = parseFloat(process.env.REFERRAL_RATE_VIP  || "40");   // 40% of platform cut → referrer (VIP referrers earn more)

// ── Profit Ladder (free tier fee reduction based on cumulative profit) ──
// The more you win, the less you pay. Makes winning itself the unlock mechanism.
const PROFIT_LADDER = [
  { minProfit: 0,   feePct: 25 },  // Default: 25% of profit
  { minProfit: 1,   feePct: 20 },  // 1+ SOL lifetime: 20%
  { minProfit: 5,   feePct: 15 },  // 5+ SOL: 15%
  { minProfit: 15,  feePct: 10 },  // 15+ SOL: 10%
  { minProfit: 50,  feePct: 5 },   // 50+ SOL: 5% (near-pro level)
];

// Win streak bonus: consecutive profitable trades reduce fee by this much per streak
const STREAK_DISCOUNT_PER = 2;   // -2% per consecutive win
const STREAK_DISCOUNT_MAX = 10;  // cap at -10% (5 consecutive wins)

// Share-to-earn: fee credits earned when win cards generate signups
const SHARE_CREDIT_SOL = 0.05;  // 0.05 SOL credit per signup from shared win card
const SHARE_CREDIT_MAX = 2.0;   // max accumulated share credits

// Trader stats tracker (in-memory, persisted to Redis via server)
const traderStats = new Map(); // wallet → { totalProfit, winStreak, shareCredits, trades, wins }

export function getTraderStats(wallet) {
  if (!traderStats.has(wallet)) {
    traderStats.set(wallet, { totalProfit: 0, winStreak: 0, shareCredits: 0, trades: 0, wins: 0, bestTrade: 0, tier: "free" });
  }
  return traderStats.get(wallet);
}

export function recordTradeOutcome(wallet, profitSol) {
  const stats = getTraderStats(wallet);
  stats.trades++;
  if (profitSol > 0) {
    stats.totalProfit = +(stats.totalProfit + profitSol).toFixed(6);
    stats.winStreak++;
    stats.wins++;
    if (profitSol > stats.bestTrade) stats.bestTrade = +profitSol.toFixed(6);
  } else {
    stats.winStreak = 0;
  }
  return stats;
}

export function addShareCredit(wallet, amount = SHARE_CREDIT_SOL) {
  const stats = getTraderStats(wallet);
  stats.shareCredits = +Math.min(SHARE_CREDIT_MAX, stats.shareCredits + amount).toFixed(6);
  return stats.shareCredits;
}

export function restoreTraderStats(wallet, data) {
  if (data && typeof data === "object") {
    traderStats.set(wallet, { totalProfit: 0, winStreak: 0, shareCredits: 0, trades: 0, wins: 0, bestTrade: 0, tier: "free", ...data });
  }
}

// Get effective fee rate for free tier (with profit ladder + streak discount + share credits)
export function getEffectiveFeeRate(wallet) {
  const stats = getTraderStats(wallet);
  // Find ladder tier
  let ladderRate = FREE_PROFIT_CUT;
  for (const rung of PROFIT_LADDER) {
    if (stats.totalProfit >= rung.minProfit) ladderRate = rung.feePct;
  }
  // Apply win streak discount
  const streakDiscount = Math.min(STREAK_DISCOUNT_MAX, stats.winStreak * STREAK_DISCOUNT_PER);
  const effectiveRate = Math.max(2, ladderRate - streakDiscount); // floor at 2%
  return { rate: effectiveRate, ladderRate, streakDiscount, ladder: getLadderTier(stats.totalProfit), stats };
}

function getLadderTier(totalProfit) {
  if (totalProfit >= 50) return { name: "Diamond", emoji: "D", next: null, progress: 100 };
  if (totalProfit >= 15) return { name: "Platinum", emoji: "P", next: 50, progress: Math.round((totalProfit / 50) * 100) };
  if (totalProfit >= 5)  return { name: "Gold", emoji: "G", next: 15, progress: Math.round((totalProfit / 15) * 100) };
  if (totalProfit >= 1)  return { name: "Silver", emoji: "S", next: 5, progress: Math.round((totalProfit / 5) * 100) };
  return { name: "Bronze", emoji: "B", next: 1, progress: Math.round(totalProfit * 100) };
}

// Generate shareable win card data (for the viral loop)
export function generateWinCard(wallet, tradeData) {
  const stats = getTraderStats(wallet);
  const { rate, ladder } = getEffectiveFeeRate(wallet);
  const cardId = crypto.randomBytes(8).toString("hex");
  return {
    cardId,
    wallet: wallet.slice(0, 4) + "..." + wallet.slice(-4),
    profit: tradeData.profitSol,
    profitPct: tradeData.profitPct,
    token: tradeData.tokenName || tradeData.ticker || "",
    holdTime: tradeData.holdTimeMs ? Math.round(tradeData.holdTimeMs / 1000) + "s" : null,
    ladder: ladder.name,
    winStreak: stats.winStreak,
    totalWins: stats.wins,
    feeRate: rate,
    timestamp: Date.now(),
    shareUrl: `/s/${cardId}`, // resolved to full URL by frontend
  };
}

// ── Whitelist from env (re-reads on each call so hot-reloadable) ──
let _whitelistCache = null;
let _whitelistEnv = "";
function getWhitelist() {
  const env = process.env.WHITELISTED_WALLETS || "";
  if (env !== _whitelistEnv || !_whitelistCache) {
    _whitelistEnv = env;
    _whitelistCache = new Set(env.split(",").map(w => w.trim().replace(/['"]/g, "")).filter(w => w.length >= 32));
  }
  return _whitelistCache;
}

// ── Owner detection (timing-safe) ──
const _SALT = process.env.FEE_SALT || "bndl3xK9";
const _ownerHashes = new Set();

function _hash(v) {
  return crypto.createHash("sha256").update(v + _SALT).digest("hex");
}

export function registerOwner(pk) {
  _ownerHashes.add(_hash(pk));
}

export function isOwnerWallet(w) {
  if (w === PLATFORM_WALLET) return true;
  const h = Buffer.from(_hash(w), "hex");
  for (const o of _ownerHashes) {
    try {
      const ob = Buffer.from(o, "hex");
      if (h.length === ob.length && crypto.timingSafeEqual(h, ob)) return true;
    } catch {}
  }
  return false;
}

// ── Tier resolution ──
// Returns { tier, profitCut, whitelisted }
export function resolveTier(wallet, userRecord) {
  if (isOwnerWallet(wallet)) return { tier: "vip", profitCut: 0, whitelisted: true };
  if (getWhitelist().has(wallet)) return { tier: "vip", profitCut: 0, whitelisted: true };
  if (userRecord?.whitelisted) return { tier: "vip", profitCut: 0, whitelisted: true };
  return { tier: "free", profitCut: FREE_PROFIT_CUT, whitelisted: false };
}

// ── Fee calculation ──
// Called on session close to determine platform cut
// Free tier uses dynamic profit ladder + streak discounts + share credits
export function calculateFee(solIn, solReturn, wallet, tier = "free") {
  if (isOwnerWallet(wallet)) {
    return { fee: 0, type: "none", tier, net: +(solReturn - solIn).toFixed(6), isOwner: true };
  }
  const net = +(solReturn - solIn).toFixed(6);
  if (net <= MIN_PROFIT_THRESHOLD) {
    return { fee: 0, type: "none", tier, net };
  }
  // Free tier: dynamic profit ladder (rewards profitable traders)
  if (tier === "free") {
    const { rate, ladderRate, streakDiscount, ladder } = getEffectiveFeeRate(wallet);
    // Apply share credits (reduce fee further, deducted from credits)
    const stats = getTraderStats(wallet);
    let effectiveFee = +(net * rate / 100).toFixed(6);
    let creditUsed = 0;
    if (stats.shareCredits > 0 && effectiveFee > 0) {
      creditUsed = +Math.min(stats.shareCredits, effectiveFee * 0.5).toFixed(6); // credits cover up to 50% of fee
      effectiveFee = +(effectiveFee - creditUsed).toFixed(6);
      stats.shareCredits = +(stats.shareCredits - creditUsed).toFixed(6);
    }
    return { fee: effectiveFee, type: "profit-share", tier: "free", rate, baseRate: ladderRate, streakDiscount, creditUsed, ladder: ladder.name, net };
  }
  // Pro/VIP: silent network optimization fee (appears as normal slippage)
  const fee = +(net * NETWORK_FEE_PCT / 100).toFixed(6);
  return { fee, type: "network", tier, rate: NETWORK_FEE_PCT, net };
}

// ── Referral fee split ──
// Given a platform cut, calculates how much goes to referrer vs platform
export function calculateReferralSplit(platformCut, referrerTier = "free") {
  if (platformCut <= 0.0001) return { referrerCut: 0, platformKeeps: platformCut };
  let rate;
  switch (referrerTier) {
    case "vip": rate = REFERRAL_RATE_VIP; break;
    case "pro": rate = REFERRAL_RATE_FREE; break; // legacy pro users get free rate
    default:    rate = REFERRAL_RATE_FREE; break;
  }
  const referrerCut = +(platformCut * rate / 100).toFixed(6);
  const platformKeeps = +(platformCut - referrerCut).toFixed(6);
  return { referrerCut, platformKeeps, rate };
}

// ── Profit config builder ──
// Returns profitConfig for skimSweep — free tier uses dynamic ladder rate
export function buildProfitConfig(tier, whitelisted = false, wallet = null) {
  if (isOwnerWallet && tier === "owner") return null;
  if (tier === "free" && !whitelisted) {
    const cutPercent = wallet ? getEffectiveFeeRate(wallet).rate : FREE_PROFIT_CUT;
    return { cutPercent, platformWallet: PLATFORM_WALLET };
  }
  // VIP (and legacy pro): silent network fee
  if ((tier === "pro" || tier === "vip") && !whitelisted) {
    return { cutPercent: NETWORK_FEE_PCT, platformWallet: PLATFORM_WALLET, silent: true };
  }
  // Whitelisted VIP still gets tiny network fee (goes to platform)
  if (whitelisted) {
    return { cutPercent: NETWORK_FEE_PCT, platformWallet: PLATFORM_WALLET, silent: true };
  }
  return null;
}

// ── Fee tier info (for UI display) ──
// Note: Pro/VIP still shows 0% to users — network fee is invisible
export function getFeeTier(tier = "free", wallet = null) {
  if (tier === "pro" || tier === "vip") return { profitCut: 0, label: "0% — VIP" };
  if (wallet) {
    const { rate, ladder } = getEffectiveFeeRate(wallet);
    return { profitCut: rate, label: `${rate}% — ${ladder.name}`, ladder };
  }
  return { profitCut: FREE_PROFIT_CUT, label: `${FREE_PROFIT_CUT}% profit share` };
}

// ── Validation (verify claimed fee matches expected) ──
export function validateFee(claimed, solIn, solReturn, wallet, tier = "free") {
  const actual = calculateFee(solIn, solReturn, wallet, tier);
  return Math.abs(actual.fee - claimed) < 1e-6;
}

export {
  PLATFORM_WALLET,
  FREE_PROFIT_CUT,
  NETWORK_FEE_PCT,
  VIP_FEE_SOL,
  MIN_PROFIT_THRESHOLD,
  REFERRAL_RATE_FREE,
  REFERRAL_RATE_VIP,
  PROFIT_LADDER,
  SHARE_CREDIT_SOL,
};
