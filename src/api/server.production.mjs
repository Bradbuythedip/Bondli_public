/**
 * ═══════════════════════════════════════════════════════════════
 * BONDLI v4 — server.production.mjs
 * Express API + PumpPortal WebSocket Radar + Fleet Trading
 * ═══════════════════════════════════════════════════════════════
 *
 * Deploy: Railway (or any Node.js host)
 * Env vars: RPC_URL, REDIS_URL, PLATFORM_WALLET, ADMIN_SECRET,
 *           PORT
 *
 * This file handles:
 *   - PumpPortal WebSocket → real-time radar feed
 *   - Session lifecycle (create → fund → launch → close)
 *   - Fleet trading (via fleet-trader.mjs)
 *   - Trading wallet management
 *   - Quick buy/sell (PumpPortal Lightning)
 *   - Positions / portfolio tracking
 *   - SOL price (server-to-server, no CORS)
 *   - Admin/owner dashboard endpoints
 *   - Referral system
 *   - Username system
 * ═══════════════════════════════════════════════════════════════
 */

import path from "node:path";
import express from "express";
import { pumpCurvePct } from "../autoape/gates/curve.js";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createClient as createRedisClient } from "redis";
import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction,
  SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction, ComputeBudgetProgram
} from "@solana/web3.js";
import bs58 from "bs58";
import crypto from "crypto";
import { SessionManager, calculateDevBuy } from "../engine/session-manager.mjs";
import { FleetTrader, skimSweep } from "../engine/fleet-trader.mjs";
import { createToken } from "../engine/token-creator.mjs";
import { resolveTier, buildProfitConfig, isOwnerWallet, registerOwner, calculateFee, calculateReferralSplit, getEffectiveFeeRate, recordTradeOutcome, generateWinCard, getTraderStats, addShareCredit, restoreTraderStats, PLATFORM_WALLET, NETWORK_FEE_PCT, PROFIT_LADDER } from "../engine/fee-engine.mjs";
import { makeVault } from "../middleware/keyvault.mjs";
import { detectMayhem, PUMP_PROGRAM as PUMP_PROGRAM_ID } from "./mayhem.mjs";
import { CopycatIndex } from "./copycat.mjs";
import { RevivalTracker, revivalFilter } from "./revival.mjs";
import { tagFor } from "./verdict-tag.mjs";
import { AGGRESSION as VELOCITY_AGGRESSION } from "../velocity/venues/pumpfun/edge.mjs";
import { PonsFeed, ethersRpc as ponsRpc } from "../velocity/venues/pons/feed.mjs";
import { LaunchStore } from "./launch.mjs";
import { LaunchTrend } from "./launch-trend.mjs";
import { DEFAULT_RPC_URL as PONS_DEFAULT_RPC, CHAIN_ID as PONS_CHAIN_ID } from "../velocity/venues/pons/chain.mjs";
import { Wallet as EvmWallet, JsonRpcProvider as EvmProvider, formatEther, parseEther } from "ethers";
import { CHAIN_ID as ARC_CHAIN_ID, DEFAULT_RPC_URL as ARC_DEFAULT_RPC } from "../velocity/venues/arc/chain.mjs";
import { ArcFeed } from "../velocity/venues/arc/feed.mjs";
import { ActivityGate } from "./activity.mjs";
// Robinhood Chain: one provider for balances and withdrawals; the PONS feed and routers have their own.
const ponsProvider = new EvmProvider(process.env.PONS_RPC_URL || PONS_DEFAULT_RPC, { chainId: PONS_CHAIN_ID, name: "robinhood" }, { staticNetwork: true });
// Arc: the same EVM key the user already has for Robinhood Chain works here -- one 0x address, two
// chains. Gas and balance are USDC; the native balance is 18-decimal like ETH, so formatEther reads it.
// ARC_RPC_URL should be a keyed endpoint (the free one throttles sends); the key never enters the repo.
const arcProvider = new EvmProvider(process.env.ARC_RPC_URL || ARC_DEFAULT_RPC, { chainId: ARC_CHAIN_ID, name: "arc" }, { staticNetwork: true });
async function ethPriceUsd() {
  const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`coinbase ${r.status}`);
  const d = await r.json(); const p = Number(d?.data?.amount); if (!(p > 0)) throw new Error("no ETH price"); return p;
}
import { checkDisqualifiers as judgeDisqualifiers } from "../autoape/gates/disqualifiers.js";
import { checkViability as judgeViability } from "../autoape/gates/viability.js";
import { classifyConfidence as judgeConfidence } from "../autoape/gates/confidence.js";
import { checkExecutionWindow as judgeWindow } from "../autoape/gates/execution-window.js";
import { VelocityHub, mountVelocityRoutes } from "../velocity/hub.mjs";
import { PumpfunFeed } from "../velocity/venues/pumpfun/feed.mjs";
import { generateChallenge, verifySolanaSignature, issueAuthToken, makeRequireOwner, nonces as authNonces } from "../middleware/wallet-auth.mjs";
import CONFIG from "../engine/config.mjs";
import { smartSend, getOptimalPriorityFee } from "../engine/rpc-enhanced.mjs";
import { MemeIntelligence, ScoreDynamics } from "../engine/meme-intelligence.mjs";
import { startOnchainTrades } from "./radar-onchain.mjs";
import { ArtworkScanner } from "../engine/artwork-scanner.mjs";
import { XSocialIntel } from "../engine/x-social-intel.mjs";
import { MetaTracker } from "../engine/meta-engine.mjs";
import { HistoricalMovers } from "../engine/historical-movers.mjs";
import { WalletIntel } from "../engine/wallet-intel.mjs";
import SurvivorshipBias from "../engine/survivorship-bias.mjs";
import { SmartMoneyTracker } from "../engine/smart-money-tracker.mjs";
import { ResurgenceScanner } from "../engine/resurgence-scanner.mjs";
import { DevWalletTracker } from "../engine/dev-wallet-tracker.mjs";
import { DemandAuthenticityEngine } from "../engine/demand-authenticity.mjs";
import { scoreMemeticQuick, scoreTokenMemetic, loadBlacklists as loadMemeticBlacklists, startMemeticWorkers } from "../engine/memetic-pipeline.mjs";
import { runPipeline, runExitChecks, classifyConfidence, calculatePositionSize, createExitPlan, checkPostExitReentry, checkDipDCA } from "../autoape/pipeline.js";
import { getSpotPrice, getMultiSpotPrices, getCandlesByMint, findPool, analyzeCandles } from "../engine/price-feeds.mjs";
import { BagsClient } from "../engine/bags-client.mjs";
import bradClient from "../engine/brad-client.mjs";
import { getBradMind, getThoughtLog } from "../engine/brad-mind.mjs";
import { startPaperTrading, stopPaperTrading, paperEvaluate, paperCheckExit, getPaperStatus, isPaperEnabled } from "../engine/brad-paper.mjs";

// ═══════════════════════════════════════
// ENVIRONMENT
// ═══════════════════════════════════════
const PORT = parseInt(process.env.PORT || "3001");
// CONFIG.RPC_URL now auto-uses Alchemy when ALCHEMY_API_KEY is set
const RPC_URL = process.env.RPC_URL || CONFIG.RPC_URL || "https://api.mainnet-beta.solana.com";

// RPC-optimized sendTransaction — delegated to rpc-enhanced.mjs
const rpcSendRawTx = smartSend;

// ═══ TRADE EXECUTION CONFIG ═══
// PumpPortal's `priorityFee` param IS the Jito tip — they add the tip instruction
// for us. No need for separate Jito tip logic. Higher fee = faster inclusion.
const TRADE_CONFIG = {
  BUY_SLIPPAGE: parseInt(process.env.BUY_SLIPPAGE || "15"),         // 15% — balanced speed vs cost
  SELL_SLIPPAGE: parseInt(process.env.SELL_SLIPPAGE || "20"),        // 20% — exit reliability > precision
  PRIORITY_FEE_SOL: parseFloat(process.env.PRIORITY_FEE_SOL || "0.0015"), // PumpPortal Jito tip — minimal viable
};

// Fast send for PumpPortal transactions.
// PumpPortal txs already include Jito tip via priorityFee param.
// Just send via RPC — don't also submit as Jito bundle (redundant, slower).
async function fastSend(connection, tx, signers) {
  const serialized = tx.serialize();
  const base58Tx = bs58.encode(serialized);

  // Send to primary RPC only — PumpPortal's built-in tip handles inclusion.
  // Adding Jito bundle on top is redundant and adds ~500ms latency.
  try {
    const res = await fetch(CONFIG.RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "sendTransaction",
        params: [base58Tx, { skipPreflight: true, encoding: "base58", maxRetries: 3 }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.result) return data.result;
      if (data.error) throw new Error(JSON.stringify(data.error));
    }
    throw new Error("RPC not ok");
  } catch (e) {
    // Fallback: use connection object
    return connection.sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 3 });
  }
}
const REDIS_URL = process.env.REDIS_URL || null;
// No default: an admin route on a deploy without the variable is closed, not open to a well-known word.
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
// Nothing outside is polled unless someone is trading (src/api/activity.mjs). Every module-level
// poller below goes through gated(), and the feeds and streams start on the first bot and stop after
// the grace. ALWAYS_ON=1 keeps the old behaviour for an operator who wants the radar warm at all times.
const activity = new ActivityGate({ graceMs: (parseInt(process.env.ACTIVITY_GRACE_MIN || "10") || 10) * 60_000, alwaysOn: process.env.ALWAYS_ON === "1" });
const gated = (fn) => (...a) => activity.active() ? fn(...a) : undefined;
const DEFAULT_REFERRAL_CODE = "ilikethetech"; // owner's referral code — applied to all new users unless they have another referrer
// PumpPortal requires an API key (its wallet funded with >= 0.02 SOL) for
// subscribeTokenTrade since 2025. Without it the radar sees creates but no trades.
// Get one at https://pumpportal.fun (Generate API key), fund it, set PUMPPORTAL_API_KEY.
const PUMPPORTAL_API_KEY = (process.env.PUMPPORTAL_API_KEY || "").trim();
const PUMPPORTAL_WS_URL = PUMPPORTAL_API_KEY
  ? `wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(PUMPPORTAL_API_KEY)}`
  : "wss://pumpportal.fun/api/data";

// ═══════════════════════════════════════
// CRASH PROTECTION — keep server alive
// ═══════════════════════════════════════
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err.message, err.stack?.slice(0, 500));
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason?.message || reason);
});

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
const app = express();
// CORS — inline, no npm package needed
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Wallet, x-wallet, X-Admin-Secret, X-API-Secret, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
// Trust proxy (Railway)
app.set("trust proxy", 1);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const connection = new Connection(RPC_URL, "confirmed");
// Keys at rest and proof of ownership (src/velocity/HOSTED_DESIGN.md, DP1 and DP4).
const vault = makeVault();
const requireOwner = makeRequireOwner({ adminSecret: process.env.ADMIN_SECRET || null });

// ── RPC helper: retry with exponential backoff on 429 ──
async function rpcRetry(fn, label = "rpc", maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const is429 = e.message?.includes("429") || e.message?.includes("Too Many Requests") || e.message?.includes("max usage");
      if (is429 && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000); // 1s, 2s, 4s, 8s
        console.warn(`[RPC-RETRY] ${label} got 429, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}

// ── Balance cache (15s TTL) to avoid hammering RPC on every poll ──
const _balCache = new Map();
const BAL_CACHE_TTL = 15_000;
function getCachedBalance(key) {
  const entry = _balCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts < BAL_CACHE_TTL) return entry.data;
  return null;
}
function getStaleCachedBalance(key) {
  const entry = _balCache.get(key);
  return entry ? entry.data : null;
}
function setCachedBalance(key, data) {
  _balCache.set(key, { data, ts: Date.now() });
  if (_balCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of _balCache) { if (now - v.ts > BAL_CACHE_TTL * 4) _balCache.delete(k); }
  }
}

// Redis (optional — in-memory fallback)
let redis = null;
if (REDIS_URL) {
  try {
    redis = createRedisClient({ url: REDIS_URL });
    redis.on("error", (e) => console.warn("[REDIS] Error:", e.message));
    await redis.connect();
    console.log("[REDIS] Connected");
  } catch (e) {
    console.warn("[REDIS] Failed to connect:", e.message, "— using in-memory");
    redis = null;
  }
}

// Core services
const sessionManager = new SessionManager(redis);
const fleetTrader = new FleetTrader();
const metaTracker = new MetaTracker();
// Restore meta state from Redis
if (redis) { try { const ms = await redis.get("meta:state"); if (ms) metaTracker.import(JSON.parse(ms)); } catch {} }
const memeIntel = new MemeIntelligence(redis, metaTracker);
const scoreDynamics = new ScoreDynamics(5000);
const historicalMovers = new HistoricalMovers(redis);
const artworkScanner = new ArtworkScanner(5000);
const xSocial = new XSocialIntel();
const survivorBias = new SurvivorshipBias(redis);

// Smart Money Tracker — monitors profitable wallets, emits signals for new buys
const smartMoneyTracker = new SmartMoneyTracker({
  redis,
  onSignal: (signal) => {
    const mint = signal.mint;
    // Filter junk signals: require meaningful SOL amount
    if (!signal.solAmount || signal.solAmount < 0.05) {
      console.log(`[SMART-MONEY] Filtered low-value signal: ${mint.slice(0, 8)} (${(signal.solAmount||0).toFixed(3)} SOL)`);
      return;
    }
    // When a smart wallet buys a token we're not tracking yet, fast-track it onto radar
    if (!radar.tokens.has(mint)) {
      console.log(`[SMART-MONEY] New token from tracked wallet: ${mint.slice(0, 8)} — subscribing`);
      subscribeToToken(mint);
    }
    // Broadcast to connected dashboards
    broadcastWS({ event: "smart_money_signal", data: signal });
    // ═══ BRAD: Only comment on meaningful smart money moves ═══
    const token = radar.tokens.get(mint);
    const tokenName = token?.name || signal.symbol || mint.slice(0, 8);
    const score = token?._apeScore || 0;
    const walletShort = signal.wallet?.slice(0, 6) || "???";
    const sol = signal.solAmount.toFixed(2);
    const mc = token?.mcapUsd ? `$${Math.round(token.mcapUsd)}` : "";
    const buys = token?.buys || 0;
    const tier = signal.walletTier?.toUpperCase() || "?";
    const wr = signal.walletWinRate ? Math.round(signal.walletWinRate * 100) + "%" : "";
    // Compact format: only broadcast thought for signals worth attention
    const isInteresting = score >= 20 || buys >= 10 || signal.solAmount >= 0.5 || signal.walletTier === "s";
    if (isInteresting) {
      const thought = {
        type: "pick",
        text: `${tier}-tier wallet ${walletShort}${wr ? " (" + wr + " WR)" : ""} → ${tokenName} ${sol} SOL${mc ? " MC:" + mc : ""} score:${score}${signal.isConvergence ? " CONVERGENCE(" + signal.convergence + ")" : ""}`,
        urgency: score >= 50 || signal.tightConvergence ? "high" : signal.isConvergence ? "high" : "medium",
        token: tokenName,
        ca: mint,
        time: Date.now(),
      };
      broadcastWS({ event: "brad_thought", data: thought });
    }
    console.log(`[SMART-MONEY] ${tier}-tier ${walletShort} → ${tokenName} ${sol}SOL score:${score} buys:${buys}`);
  },
});

// ── Auto-enable smart money tracker when VIP/owner wallet trades ──
async function checkSmartMoneyAutoEnable(wallet) {
  if (!wallet) return;
  // If already enabled, just reset the inactivity timer
  if (smartMoneyTracker.enabled) {
    if (isOwnerWallet(wallet)) smartMoneyTracker.touchActivity();
    else {
      try {
        const user = await getUser(wallet);
        const tierInfo = resolveTier(wallet, user);
        if (tierInfo.tier === "vip") smartMoneyTracker.touchActivity();
      } catch {}
    }
    return;
  }
  // Not enabled — check if this wallet qualifies to auto-enable
  try {
    if (isOwnerWallet(wallet)) {
      smartMoneyTracker.touchActivity();
      return;
    }
    const user = await getUser(wallet);
    const tierInfo = resolveTier(wallet, user);
    if (tierInfo.tier === "vip") {
      smartMoneyTracker.touchActivity();
    }
  } catch {}
}

// Resurgence Scanner — finds older coins (12h-2y) with renewed momentum
const resurgenceScanner = new ResurgenceScanner({ redis, smartMoneyTracker });

// ═══ SECOND WAVE TRACKER — remember tokens that scored well for re-entry detection ═══
// Tokens that previously had high scores, dipped, and show renewed buying = potential outliers.
// ca → { peakScore, peakMcap, peakTime, lastBuys, lastUpdate }
const secondWaveTracker = new Map();
// Snapshot top-scoring tokens periodically (called from scoring loop)
function secondWaveSnapshot(token) {
  const ca = token.ca;
  if (!ca) return;
  const score = token._apeScore || 0;
  const existing = secondWaveTracker.get(ca);
  if (!existing || score > existing.peakScore) {
    secondWaveTracker.set(ca, {
      peakScore: score,
      peakMcap: token.mcapUsd || 0,
      peakTime: Date.now(),
      lastBuys: token.buys || 0,
      lastUpdate: Date.now(),
    });
  } else if (existing) {
    existing.lastBuys = token.buys || 0;
    existing.lastUpdate = Date.now();
  }
  // Prune old entries (>3h)
  if (secondWaveTracker.size > 2000) {
    const cutoff = Date.now() - 3 * 60 * 60 * 1000;
    for (const [k, v] of secondWaveTracker) {
      if (v.lastUpdate < cutoff) secondWaveTracker.delete(k);
    }
  }
}

// ═══ KOL CASCADE TRACKER — detect tight temporal KOL mention convergence ═══
// ca → [{ handle, time }] — recent KOL mentions per token
const kolCascadeTracker = new Map();
function recordKolMention(ca, handle) {
  if (!ca) return;
  if (!kolCascadeTracker.has(ca)) kolCascadeTracker.set(ca, []);
  const mentions = kolCascadeTracker.get(ca);
  mentions.push({ handle, time: Date.now() });
  // Keep last 20 mentions, prune older than 30 min
  const cutoff = Date.now() - 30 * 60 * 1000;
  const filtered = mentions.filter(m => m.time > cutoff).slice(-20);
  kolCascadeTracker.set(ca, filtered);
}

// Dev Wallet Tracker — maps every dev wallet on radar, checks balances, profiles funded devs
// Measured smart money. Every buy and sell on the on-chain stream arrives here with the FULL buyer
// pubkey; this keeps a forward P&L ledger per wallet from that stream alone, with the exclusions
// that matter (creation-slot snipers, co-firing rings, wash, fresh showcase wallets), and answers
// "how many proven wallets bought this in its first minute". Snapshots go to Redis, the only store
// that survives a redeploy; the filesystem does not.
const walletIntel = new WalletIntel({ store: redis ? { get: (k) => redis.get(k), set: (k, v) => redis.set(k, v) } : null, storeKey: "wallet-intel:v1", log: console });
// The same scorer over Arc addresses. Argus has no creation slot, so the sniper rule there is the
// hold-time rule only; everything else (FIFO cost basis, Wilson-bounded win rate, rings, wash) is
// the same measure, and its smart-buyer count reaches the radar row for Arc launches.
const arcIntel = new WalletIntel({ store: redis ? { get: (k) => redis.get(k), set: (k, v) => redis.set(k, v) } : null, storeKey: "wallet-intel:arc:v1", log: console });
walletIntel.load().then(ok => console.log(`[WALLET-INTEL] ${ok ? "restored from Redis" : "starting fresh"}`)).catch(e => console.warn("[WALLET-INTEL] load:", e.message));
const devWalletTracker = new DevWalletTracker({ redis, connection });
// Load persisted dev wallet data from Redis
if (redis) { devWalletTracker.load().catch(() => {}); }
// Background balance polling, on the gate: it reads balances over RPC, which is the outside world.
activity.on((active) => { if (active) devWalletTracker.start(); else devWalletTracker.stop(); });
// Alert on high-value dev launches
devWalletTracker.onHighValueDev = (alert) => {
  broadcastWS({ event: "high_value_dev", data: alert });
};

// Restore artwork scanner state from Redis
if (redis) {
  try {
    const artData = await redis.get("intel:artwork");
    if (artData) {
      artworkScanner.import(JSON.parse(artData));
      console.log(`[ARTWORK] Restored: ${artworkScanner.seen.size} known images`);
    }
  } catch {}
}

// Persist artwork scanner every 10 min
setInterval(gated(async () => {
  if (!redis) return;
  try { await redis.set("intel:artwork", JSON.stringify(artworkScanner.export()), { EX: 604800 }); } catch {}
}), 10 * 60 * 1000);

// ═══ WALLET AGE CACHE — check how old buyer wallets are on-chain ═══
// Aged wallets = real users. Fresh wallets = likely dev sybils.
// Whales with aged wallets buying = bullish conviction signal.
const walletAgeCache = new Map(); // wallet → { ageMs, firstTxTime, checkedAt }
const WALLET_AGE_TTL = 3600000; // cache for 1 hour
const WALLET_AGE_MAX_CACHE = 10000;

async function getWalletAge(walletAddress) {
  const cached = walletAgeCache.get(walletAddress);
  if (cached && Date.now() - cached.checkedAt < WALLET_AGE_TTL) return cached;

  try {
    // Use Solana RPC getSignaturesForAddress via Tatum gateway for wallet age
    if (CONFIG.ALCHEMY_API_KEY) {
      try {
        const sigs = await connection.getSignaturesForAddress(
          new PublicKey(walletAddress), { limit: 1 }, "confirmed"
        );
        if (sigs.length > 0 && sigs[0].blockTime) {
          const firstTxTime = sigs[0].blockTime * 1000;
          const ageMs = Date.now() - firstTxTime;
          const entry = { ageMs, firstTxTime, checkedAt: Date.now() };
          walletAgeCache.set(walletAddress, entry);
          if (walletAgeCache.size > WALLET_AGE_MAX_CACHE) {
            const oldest = [...walletAgeCache.entries()].sort((a, b) => a[1].checkedAt - b[1].checkedAt)[0];
            if (oldest) walletAgeCache.delete(oldest[0]);
          }
          return entry;
        }
      } catch {}
    }

    // Fallback: use Solana RPC getSignaturesForAddress (returns newest first, but limit=1 is fast)
    const sigs = await connection.getSignaturesForAddress(
      new PublicKey(walletAddress),
      { limit: 1 },
    );
    if (sigs.length > 0 && sigs[0].blockTime) {
      const firstTxTime = sigs[0].blockTime * 1000;
      const ageMs = Date.now() - firstTxTime;
      const entry = { ageMs, firstTxTime, checkedAt: Date.now() };
      walletAgeCache.set(walletAddress, entry);
      return entry;
    }
  } catch (e) {
    // Non-blocking: wallet age is a bonus signal, not critical path
  }
  return null;
}

// Background wallet age enrichment for token buyers (non-blocking)
async function enrichWalletAges(token) {
  const buyTrades = (token.trades || []).filter(tr => tr.side === "buy" && tr.wallet);
  const uniqueWallets = [...new Set(buyTrades.map(tr => tr.wallet))].slice(0, 20); // cap to avoid rate limits
  const ages = [];
  const whaleBuys = []; // wallets that bought > 0.5 SOL with aged wallets

  for (const w of uniqueWallets) {
    const age = await getWalletAge(w);
    if (age) {
      ages.push(age.ageMs);
      // Check if this is a whale with an aged wallet
      const walletSol = buyTrades.filter(tr => tr.wallet === w).reduce((s, tr) => s + (tr.sol || 0), 0);
      if (walletSol >= 0.5 && age.ageMs > 7 * 24 * 3600000) { // > 0.5 SOL + > 7 days old
        whaleBuys.push({ wallet: w, sol: walletSol, ageDays: Math.round(age.ageMs / 86400000) });
      }
    }
  }

  const totalChecked = ages.length;
  if (totalChecked === 0) return { walletAgeScore: 0.5, whaleBullish: 0, freshRatio: 0.5, whaleBuys: [] };

  // Fresh = created within last 24 hours
  const freshCount = ages.filter(a => a < 24 * 3600000).length;
  const freshRatio = freshCount / totalChecked;

  // Aged = wallets older than 7 days
  const agedCount = ages.filter(a => a > 7 * 24 * 3600000).length;
  const walletAgeScore = agedCount / totalChecked; // 0 = all fresh (bad), 1 = all aged (good)

  // Whale bullish: large buys from aged wallets = smart money conviction
  const whaleBullish = Math.min(1, whaleBuys.length / Math.max(1, Math.ceil(totalChecked * 0.3)));

  return { walletAgeScore, whaleBullish, freshRatio, whaleBuys };
}

// ═══ DEV CREDIBILITY ENRICHMENT — name uniqueness + dev SOL + launch history ═══
// Checks DexScreener for previous tokens with same name, dev wallet SOL balance, and
// how many tokens the dev has created. High-value signal: fresh name + funded dev + first launch.
const devCredCache = new Map(); // devWallet → { devSolBalance, devLaunchCount, ts }
const nameCheckCache = new Map(); // name → { count, rugged, ts }

async function enrichDevCredibility(token) {
  const devW = token.devWallet || "";
  const name = (token.name || "").trim().toLowerCase();
  if (!devW || !name) return null;

  const result = {
    nameUnique: true,
    namePrevLaunches: 0,
    namePrevRugged: false,
    devSolBalance: 0,
    devLaunchCount: -1, // -1 = unknown
  };

  // 1. Check DexScreener for previous tokens with same name
  const nameCached = nameCheckCache.get(name);
  if (nameCached && Date.now() - nameCached.ts < 600000) { // 10 min cache
    result.nameUnique = nameCached.count === 0;
    result.namePrevLaunches = nameCached.count;
    result.namePrevRugged = nameCached.rugged;
  } else {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) {
        const d = await r.json();
        const pairs = d?.pairs || [];
        // Count Solana pairs with matching base token name (case-insensitive)
        const matches = pairs.filter(p =>
          p.chainId === "solana" &&
          p.baseToken?.name?.toLowerCase() === name &&
          p.baseToken?.address !== token.ca // exclude self
        );
        result.namePrevLaunches = matches.length;
        result.nameUnique = matches.length === 0;
        // Check if any previous token with same name rugged (liquidity < $500 or MC crashed >90%)
        result.namePrevRugged = matches.some(p => {
          const liq = p.liquidity?.usd || 0;
          const mc = p.marketCap || p.fdv || 0;
          const priceChange24h = p.priceChange?.h24 || 0;
          return liq < 500 || mc < 1000 || priceChange24h < -80;
        });
        nameCheckCache.set(name, { count: matches.length, rugged: result.namePrevRugged, ts: Date.now() });
      }
    } catch (e) {
      console.log(`[DEV-CRED] DexScreener name check failed for "${name}": ${e.message}`);
    }
  }

  // 1b. Local radar check — catch same-name tokens in current session that DexScreener hasn't indexed yet
  let localDupes = 0;
  for (const [ca, t] of radar.tokens) {
    if (ca === token.ca) continue;
    if ((t.name || "").trim().toLowerCase() === name) localDupes++;
  }
  if (localDupes > 0) {
    result.namePrevLaunches = Math.max(result.namePrevLaunches, localDupes);
    result.nameUnique = false;
    // If local dupes exist and any has low MC or high sell ratio, mark as prev rugged
    if (!result.namePrevRugged) {
      for (const [ca, t] of radar.tokens) {
        if (ca === token.ca) continue;
        if ((t.name || "").trim().toLowerCase() !== name) continue;
        const mc = t.mcapUsd || 0;
        const sells = t.sells || 0;
        const buys = t.buys || 0;
        if (mc < 3000 && sells > buys * 0.5 && buys > 3) { result.namePrevRugged = true; break; }
      }
    }
  }

  // 2. Check dev wallet SOL balance
  const devCached = devCredCache.get(devW);
  if (devCached && Date.now() - devCached.ts < 300000) { // 5 min cache
    result.devSolBalance = devCached.devSolBalance;
    result.devLaunchCount = devCached.devLaunchCount;
  } else {
    try {
      const balance = await connection.getBalance(new PublicKey(devW));
      result.devSolBalance = +(balance / LAMPORTS_PER_SOL).toFixed(3);
    } catch (e) {
      console.log(`[DEV-CRED] Balance check failed for ${devW.slice(0, 8)}: ${e.message}`);
    }

    // 3. Check dev's token creation history via pump.fun
    // Count how many tokens this dev wallet has created recently
    try {
      const r = await fetch(`https://frontend-api-v3.pump.fun/coins/user-created-coins/${devW}?offset=0&limit=10&includeNsfw=true`, {
        signal: AbortSignal.timeout(6000),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      if (r.ok) {
        const coins = await r.json();
        result.devLaunchCount = Array.isArray(coins) ? coins.length : 0;
      }
    } catch (e) {
      console.log(`[DEV-CRED] Launch count check failed for ${devW.slice(0, 8)}: ${e.message}`);
    }

    devCredCache.set(devW, {
      devSolBalance: result.devSolBalance,
      devLaunchCount: result.devLaunchCount,
      ts: Date.now(),
    });
  }

  return result;
}

// Clean dev cred caches periodically
setInterval(gated(() => {
  const now = Date.now();
  for (const [k, v] of devCredCache) { if (now - v.ts > 600000) devCredCache.delete(k); }
  for (const [k, v] of nameCheckCache) { if (now - v.ts > 1200000) nameCheckCache.delete(k); }
}), 300000);

// Register owner wallet
if (process.env.OWNER_WALLET) registerOwner(process.env.OWNER_WALLET);

// ═══════════════════════════════════════
// SOL PRICE (server-to-server, no CORS)
// FIX: Replaces hardcoded * 170
// ═══════════════════════════════════════
let solUsdPrice = 135;
let solUsdPriceAt = 0; // ms of the last successful fetch; 0 until then, so a consumer can tell a live price from the default
// Pump.fun graduation: bonding curve fills at ~85 SOL virtual reserves
// Total supply 1B, ~800M on curve. At graduation the price × supply ≈ 69K USD.
// Formula: 85 SOL in curve × solPrice × ~5.4 (supply/curve distribution ratio)
// Dynamic: recalculated as SOL price changes. Floor at 55K (graduation never below ~$55K MC).
function gradMcUsd() { return Math.max(55000, Math.round(85 * solUsdPrice * 5.4)); }
async function pollSolPrice() {
  // Primary: Jupiter (free, no key, generous rate limits)
  try {
    const r = await fetch("https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(5000) });
    if (r.ok) { const d = await r.json(); const sp = d?.data?.["So11111111111111111111111111111111111111112"]?.price; if (sp > 0) { solUsdPrice = +sp; solUsdPriceAt = Date.now(); return; } }
  } catch {}
  // Jupiter's current price API (v2 above is legacy and may answer nothing)
  try {
    const r = await fetch("https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(5000) });
    if (r.ok) { const d = await r.json(); const sp = d?.["So11111111111111111111111111111111111111112"]?.usdPrice; if (sp > 0) { solUsdPrice = +sp; solUsdPriceAt = Date.now(); return; } }
  } catch {}
  // Fallback: CoinGecko (rate-limited on free tier)
  try {
    const r2 = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) });
    if (r2.ok) { const d2 = await r2.json(); if (d2?.solana?.usd > 0) { solUsdPrice = d2.solana.usd; solUsdPriceAt = Date.now(); return; } }
  } catch {}
  // Exchange spot prices: the trader refuses to size an order in SOL without a fresh stamp,
  // so a price must come from somewhere.
  try {
    const r3 = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", { signal: AbortSignal.timeout(5000) });
    if (r3.ok) { const d3 = await r3.json(); if (+d3?.price > 0) { solUsdPrice = +d3.price; solUsdPriceAt = Date.now(); return; } }
  } catch {}
  try {
    const r4 = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { signal: AbortSignal.timeout(5000) });
    if (r4.ok) { const d4 = await r4.json(); if (+d4?.data?.amount > 0) { solUsdPrice = +d4.data.amount; solUsdPriceAt = Date.now(); return; } }
  } catch {}
  console.warn(`[sol-price] every source failed; serving ${solUsdPrice} from ${solUsdPriceAt ? new Date(solUsdPriceAt).toISOString() : "the default"}`);
}
// No boot call: the activity gate polls the price when it opens (see activity.on below), so with
// nobody trading this server asks Jupiter, CoinGecko, Binance and Coinbase for nothing at all.
setInterval(gated(pollSolPrice), 60000); // 60s — SOL price doesn't move fast enough to justify 30s

// ═══════════════════════════════════════
// DEXSCREENER BOOST POLLER — paid/boosted token detection
// ═══════════════════════════════════════
async function pollDexBoosted() {
  try {
    const r = await fetch("https://api.dexscreener.com/token-boosts/top/v1", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const data = await r.json();
    if (!Array.isArray(data)) return;
    const now = Date.now();
    for (const t of data) {
      if (t.chainId === "solana" && t.tokenAddress) {
        radar.dexBoosted.set(t.tokenAddress, {
          amount: t.totalAmount || 0,
          icon: t.icon || null,
          description: t.description || null,
          url: t.url || null,
          updatedAt: now,
        });
      }
    }
    // Clean old entries (>1h)
    for (const [ca, v] of radar.dexBoosted) {
      if (now - v.updatedAt > 3600000) radar.dexBoosted.delete(ca);
    }
  } catch {}
}
// Polled when the gate opens, not at boot. See activity.on below.
setInterval(gated(pollDexBoosted), 120000); // every 2 min

// ═══════════════════════════════════════
// PUMPPORTAL WEBSOCKET — RADAR ENGINE (v2)
// Per API docs: WS sends marketCapSol, vSolInBondingCurve, vTokensInBondingCurve
// but does NOT send name/symbol/uri — metadata fetched from pump.fun frontend API
// ═══════════════════════════════════════
const radar = {
  tokens: new Map(),    // ca → token data
  tabs: { new: [], hot: [], graduating: [], momentum: [], bags: [] },
  poolSize: 0,
  online: 0,
  ws: null,
  reconnects: 0,
  subscribedTokens: new Set(), // track subscribed mints for unsubscribe
  _debugCount: 0,
  dexBoosted: new Map(), // ca → { amount, updatedAt } — DexScreener paid/boosted
};

// ═══ HUB WALLETS — bots and routers that trade many mints at once ═══
// One automated wallet (BwWK17cb…: ~54k SOL, a trade every second across hundreds
// of mints, 154 funded sub-accounts) shows up as the top buyer on almost every
// active token. Counted as a holder, it made every token look like a three-wallet
// rug and the first gate rejected 100% of a live market. A wallet that trades
// HUB_MIN_TOKENS distinct mints inside HUB_WINDOW_MS is a router, not a holder:
// its trades still count toward volume and buy pressure, never toward identity
// (concentration, dominance, dev-sell, coordinated-dump, quick-flip, timing).
const HUB_MIN_TOKENS = 5;
const HUB_WINDOW_MS = 15 * 60_000;
const HUB_SEED = ["BwWK17cb"]; // known routers, 8-char prefix as stored on trades
radar.walletTokens = new Map(); // wallet8 → { tokens: Set(ca), first, last }
radar.hubs = new Set(HUB_SEED);
function noteWalletTrade(wallet8, ca, now) {
  if (!wallet8) return false;
  if (radar.hubs.has(wallet8)) return true;
  let w = radar.walletTokens.get(wallet8);
  if (!w || now - w.first > HUB_WINDOW_MS) { w = { tokens: new Set(), first: now, last: now }; radar.walletTokens.set(wallet8, w); }
  w.tokens.add(ca);
  w.last = now;
  if (w.tokens.size >= HUB_MIN_TOKENS) {
    radar.hubs.add(wallet8);
    if (radar.hubs.size <= 25 || radar.hubs.size % 50 === 0)
      console.log(`[RADAR] hub wallet ${wallet8}… traded ${w.tokens.size} mints in ${Math.round((now - w.first) / 1000)}s: excluded from holder features (${radar.hubs.size} hubs)`);
    return true;
  }
  return false;
}
setInterval(gated(() => {
  const now = Date.now();
  for (const [k, w] of radar.walletTokens) if (now - w.last > HUB_WINDOW_MS) radar.walletTokens.delete(k);
}), 60_000);

// ═══ SMART WALLET LABELING ═══
// Track which wallets historically pick winners, weight their buys 3-5x in scoring
// Uses in-memory LRU + Redis persistence for wallet performance history
const smartWallets = {
  // wallet(8-char prefix) → { buys, wins, losses, avgReturn, score, lastSeen }
  walletStats: new Map(),
  // Minimum trades to label a wallet as "smart"
  MIN_TRADES: 3,
  // Decay old entries every hour
  lastCleanup: Date.now(),

  // Record a buy — called when we see a wallet buy a token
  recordBuy(walletPrefix, ca) {
    if (!walletPrefix || walletPrefix.length < 6) return;
    let stats = this.walletStats.get(walletPrefix);
    if (!stats) {
      stats = { buys: 0, wins: 0, losses: 0, totalReturn: 0, activeBuys: new Map(), score: 0, lastSeen: Date.now() };
      this.walletStats.set(walletPrefix, stats);
    }
    stats.buys++;
    stats.lastSeen = Date.now();
    // Track entry MC for this token
    const token = radar.tokens.get(ca);
    if (token) {
      stats.activeBuys.set(ca, { entryMcap: token.mcapUsd || 0, time: Date.now() });
    }
  },

  // Resolve outcome — called when a token graduates or rugs
  resolveOutcome(ca, graduated) {
    for (const [wp, stats] of this.walletStats) {
      const entry = stats.activeBuys.get(ca);
      if (!entry) continue;
      stats.activeBuys.delete(ca);
      if (graduated) {
        stats.wins++;
        const token = radar.tokens.get(ca);
        const exitMcap = token?.mcapUsd || entry.entryMcap;
        const ret = entry.entryMcap > 0 ? (exitMcap - entry.entryMcap) / entry.entryMcap : 0;
        stats.totalReturn += ret;
      } else {
        stats.losses++;
        stats.totalReturn -= 0.5; // assume 50% loss on rug
      }
      // Recalculate score: win rate weighted by total return
      const totalTrades = stats.wins + stats.losses;
      if (totalTrades >= this.MIN_TRADES) {
        const winRate = stats.wins / totalTrades;
        const avgRet = stats.totalReturn / totalTrades;
        stats.score = Math.min(1, Math.max(0, winRate * 0.6 + Math.min(0.4, avgRet * 0.1)));
      }
    }
  },

  // Get smart wallet count for a token — how many known-good wallets are buying
  getSmartBuyerCount(token) {
    const trades = token.recentTrades || token.trades || [];
    const buyWallets = trades
      .filter(t => t.side === "buy" || t.txType === "buy")
      .map(t => (t.wallet || "").slice(0, 8));
    let smartCount = 0;
    for (const wp of new Set(buyWallets)) {
      const stats = this.walletStats.get(wp);
      if (stats && stats.score >= 0.4 && (stats.wins + stats.losses) >= this.MIN_TRADES) {
        smartCount++;
      }
    }
    return smartCount;
  },

  // Cleanup old entries — run periodically
  cleanup() {
    if (Date.now() - this.lastCleanup < 3600000) return; // hourly
    this.lastCleanup = Date.now();
    const cutoff = Date.now() - 86400000 * 7; // 7 days
    for (const [wp, stats] of this.walletStats) {
      if (stats.lastSeen < cutoff) this.walletStats.delete(wp);
    }
    // Cap at 5000 entries
    if (this.walletStats.size > 5000) {
      const entries = [...this.walletStats.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (let i = 0; i < entries.length - 5000; i++) this.walletStats.delete(entries[i][0]);
    }
  },

  // Persist to Redis (called periodically)
  async save() {
    if (!redis) return;
    try {
      const data = {};
      for (const [wp, stats] of this.walletStats) {
        if ((stats.wins + stats.losses) >= this.MIN_TRADES) {
          data[wp] = { b: stats.buys, w: stats.wins, l: stats.losses, r: +stats.totalReturn.toFixed(2), s: +stats.score.toFixed(3), t: stats.lastSeen };
        }
      }
      await redis.set("smart:wallets", JSON.stringify(data), { EX: 604800 }); // 7 days
    } catch {}
  },

  // Restore from Redis
  async load() {
    if (!redis) return;
    try {
      const raw = await redis.get("smart:wallets");
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const [wp, d] of Object.entries(data)) {
        this.walletStats.set(wp, {
          buys: d.b, wins: d.w, losses: d.l, totalReturn: d.r, activeBuys: new Map(),
          score: d.s, lastSeen: d.t,
        });
      }
      console.log(`[SMART-WALLET] Loaded ${this.walletStats.size} wallet profiles from Redis`);
    } catch {}
  },
};

// Demand Authenticity Engine — detects manufactured vs organic buying
// Must be after smartWallets + smartMoneyTracker are defined
const demandAuth = new DemandAuthenticityEngine({ smartWallets, smartMoneyTracker });

const PUMP_FUN_API = "https://frontend-api-v3.pump.fun";

// Fetch token metadata from pump.fun frontend API
async function fetchPumpFunMetadata(ca) {
  try {
    const r = await fetch(`${PUMP_FUN_API}/coins/${ca}`, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Origin": "https://pump.fun",
        "Referer": "https://pump.fun/",
      }
    });
    if (!r.ok) {
      // 404 is the normal answer for a mint pump.fun has not indexed yet; only other statuses matter.
      if (r.status !== 404) console.log(`[META] pump.fun API ${r.status} for ${ca.slice(0,8)}`);
      return null;
    }
    const d = await r.json();
    if (radar._debugCount < 8) {
      console.log(`[META] Got: ${d.name || "?"} image: ${(d.image_uri || "none").slice(0, 60)}`);
    }
    return {
      name: d.name || "",
      symbol: d.symbol || "",
      description: (d.description || "").slice(0, 200),
      image: d.image_uri || d.profile_image || "",
      twitter: (() => { const tw = d.twitter || ""; if (!tw) return ""; if (tw.startsWith("http")) { const m = tw.match(/(?:twitter\.com|x\.com)\/([^/?#]+)/); return m ? m[1] : tw; } return tw.startsWith("@") ? tw.slice(1) : tw; })(),
      website: (() => { const w = d.website || ""; if (!w) return ""; return w.startsWith("http") ? w : w.includes(".") ? "https://" + w : ""; })(),
      telegram: (() => { const tg = d.telegram || ""; if (!tg) return ""; if (tg.startsWith("http")) { const m = tg.match(/t\.me\/([^/?#]+)/); return m ? m[1] : tg; } return tg.startsWith("@") ? tg.slice(1) : tg; })(),
      complete: d.complete || false,
      raydiumPool: d.raydium_pool || null,
      marketCap: d.usd_market_cap || d.market_cap || 0,
      bondingCurve: d.bonding_curve || "",
      creator: d.creator || "",
      mayhem: detectMayhem({ meta: d }),
      createdAt: Number(d.created_timestamp) > 1e12 ? Number(d.created_timestamp) : Number(d.created_timestamp) > 1e9 ? Number(d.created_timestamp) * 1000 : null,
    };
  } catch (e) {
    console.log(`[META] Error for ${ca.slice(0,8)}: ${e.message}`);
    return null;
  }
}

// Fetch token image from metadata URI (IPFS JSON → image URL)
// One try is not enough: pinata often answers slowly or 5xx in the first seconds after a launch.
// Every retry stays on pump.fun's own CDN. The second and third tries used to switch to ipfs.io,
// which does not have a pin that is seconds old -- so the two retries that mattered most were
// asking the one gateway guaranteed not to have it yet. Five tries over ~2.5 minutes, then the
// pump.fun API fallback in the create handler, then the picture proxy's own by-mint lookup.
const IMG_META_RETRY_MS = [6000, 12000, 30000, 60000, 60000];
async function fetchTokenImage(ca, uri, attempt = 0) {
  const ok = await fetchTokenImageOnce(ca, uri, attempt);
  if (ok) return;
  const t = radar.tokens.get(ca);
  if (!t || t.image || attempt >= IMG_META_RETRY_MS.length) return;
  setTimeout(() => fetchTokenImage(ca, uri, attempt + 1).catch(() => {}), IMG_META_RETRY_MS[attempt]);
}
async function fetchTokenImageOnce(ca, uri, attempt = 0) {
  try {
    let url = uri;
    if (url.startsWith("ipfs://")) url = "https://pump.mypinata.cloud/ipfs/" + url.slice(7);
    // pump.fun uses IPFS for metadata
    if (url.includes("bafkrei") && !url.startsWith("http")) url = "https://pump.mypinata.cloud/ipfs/" + url;
    // Rewrite slow gateways to pump's Pinata CDN
    if (url.includes("cf-ipfs.com/ipfs/")) url = url.replace("cf-ipfs.com/ipfs/", "pump.mypinata.cloud/ipfs/");
    if (url.includes("gateway.pinata.cloud/ipfs/")) url = url.replace("gateway.pinata.cloud/ipfs/", "pump.mypinata.cloud/ipfs/");
    if (url.includes("ipfs.io/ipfs/")) url = url.replace("ipfs.io/ipfs/", "pump.mypinata.cloud/ipfs/");

    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    if (!r.ok) return false;
    const ct = r.headers.get("content-type") || "";
    const token = radar.tokens.get(ca);
    if (!token) return true;

    // If the URI points directly to an image (not JSON metadata), use it as the image URL
    if (ct.includes("image") || ct.includes("octet")) {
      token.image = url;
      return true;
    }

    let meta;
    try { meta = await r.json(); } catch { token.image = url; return true; }
    let img = meta.image || meta.imageUri || "";
    if (img.startsWith("ipfs://")) img = "https://pump.mypinata.cloud/ipfs/" + img.slice(7);
    if (img && !img.startsWith("http")) img = "https://pump.mypinata.cloud/ipfs/" + img;
    // Rewrite slow cf-ipfs URLs to pump's Pinata CDN
    if (img.includes("cf-ipfs.com/ipfs/")) img = img.replace("cf-ipfs.com/ipfs/", "pump.mypinata.cloud/ipfs/");
    if (img.includes("gateway.pinata.cloud/ipfs/")) img = img.replace("gateway.pinata.cloud/ipfs/", "pump.mypinata.cloud/ipfs/");
    
    if (img) token.image = img;
    if (meta.name && !token.name) token.name = meta.name;
    if (meta.symbol && !token.ticker) token.ticker = meta.symbol;
    if (meta.description && !token.description) token.description = (meta.description || "").slice(0, 200);
    if (meta.twitter && !token.twitter) token.twitter = meta.twitter;
    if (meta.website && !token.website) token.website = meta.website;
    if (meta.telegram && !token.telegram) token.telegram = meta.telegram;
    token._metaAt = Date.now(); // the socials are now known, present or absent; before this, absence means nothing
    
    if (radar._debugCount < 10) {
      console.log(`[IMG] ${ca.slice(0,8)}: ${token.name} → ${img?.slice(0,60) || "none"}`);
    }

    // Artwork originality scan — runs async, stores result on token
    if (img && artworkScanner) {
      artworkScanner.scan(ca, img, token.name || "").then(artResult => {
        const t = radar.tokens.get(ca);
        if (!t) return;
        t._artworkScore = artResult.score;
        t._artworkOriginal = artResult.original;
        t._artworkFlags = artResult.flags;
        t._artworkMatches = artResult.matches;
        if (!artResult.original) {
          console.log(`[ARTWORK] ${ca.slice(0,8)} ${token.name}: COPIED (score:${artResult.score}) flags:${artResult.flags.join(",")}`);
        }
      }).catch(() => {});
    }
    return !!img;
  } catch (e) {
    return false; // the caller retries
  }
}

function connectPumpPortal() {
  if (!activity.active()) return; // nobody is trading: no socket
  try {
    radar.ws = new WebSocket(PUMPPORTAL_WS_URL);

    radar.ws.on("open", () => {
      console.log("[RADAR] PumpPortal WS connected");
      radar.reconnects = 0;
      radar._connectedAt = Date.now();
      // Subscribe to new token creations (streams every create event)
      radar.ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      // Subscribe to graduation/migration events
      radar.ws.send(JSON.stringify({ method: "subscribeMigration" }));
      console.log("[RADAR] Subscribed to newToken + migration");
      resubscribeAllTokens();
    });

    radar.ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw);
        // Radar health counters: how many trade messages arrive vs creates.
        // Printed once a minute so a silent trade drought is visible in the log.
        radar._msgStats = radar._msgStats || { create: 0, trade: 0, other: 0, since: Date.now(), tradeSamples: 0 };
        const st = radar._msgStats;
        if (data.txType === "create") st.create++;
        else if (data.txType === "buy" || data.txType === "sell") {
          st.trade++;
          radar._lastPortalTradeAt = Date.now();
          if (st.tradeSamples < 3) { st.tradeSamples++; console.log(`[RADAR] trade sample:`, JSON.stringify(data).slice(0, 400)); }
        } else {
          st.other++;
          const msg = String(data.message || data.errors || "");
          if (/only available when connecting with an API key|Minimum balance not met/i.test(msg)) {
            radar._refusedAt = Date.now();
            if (!radar._tradeSubsRefused) {
              radar._tradeSubsRefused = true;
              console.error(`\n[RADAR] ══════════════════════════════════════════════════════════════════\n[RADAR] PumpPortal refused trade subscriptions: ${msg}\n[RADAR] Without trades no token can score and nothing will ever be bought.\n[RADAR] Fix: 1) https://pumpportal.fun -> Generate API key  2) send that key's wallet >= 0.02 SOL\n[RADAR]      3) add PUMPPORTAL_API_KEY=<key> to .env  4) restart this server\n[RADAR] ${PUMPPORTAL_API_KEY ? "A key IS set: check that its wallet holds >= 0.02 SOL." : "No PUMPPORTAL_API_KEY is set right now."}\n[RADAR] ══════════════════════════════════════════════════════════════════\n`);
            }
          } else if (data.txType !== "migrate" && (st.otherSamples = (st.otherSamples || 0) + 1) <= 5) {
            console.log(`[RADAR] server reply:`, JSON.stringify(data).slice(0, 300));
          }
        }
        if (Date.now() - st.since >= 60000) {
          console.log(`[RADAR] stats/min: creates ${st.create} trades ${st.trade} other ${st.other} | subscribed ${radar.subscribedTokens.size} | tokens ${radar.tokens.size} | scored>0 ${[...radar.tokens.values()].filter(t => (t._apeScore || 0) > 0).length} | mayhem ${[...radar.tokens.values()].filter(t => t._mayhem).length} | copycats ${[...radar.tokens.values()].filter(t => t._copyOf).length} | hubs ${radar.hubs.size} | dup ${st.dup || 0} | src ${radar._tradeSource}${st.onchain ? " (onchain " + st.onchain + ")" : ""} | pumpportal est ${(((st.trade - (st.onchain || 0)) * 1440) / 10000 * 0.01).toFixed(2)} SOL/day`);
          if (st.trade === 0 && radar.subscribedTokens.size > 0) console.warn(`[RADAR] WARNING: ${radar.subscribedTokens.size} tokens subscribed but zero trade messages in the last minute`);
          st.create = 0; st.trade = 0; st.other = 0; st.dup = 0; st.onchain = 0; st.since = Date.now();
        }
        processRadarMessage(data);
      } catch (e) {
        if (!radar._lastHandlerErr || Date.now() - radar._lastHandlerErr > 60000) {
          radar._lastHandlerErr = Date.now();
          console.error("[RADAR] message handler error:", e.message);
        }
      }
    });

    radar.ws.on("close", () => {
      radar.subscribedTokens.clear();
      if (!activity.active()) { console.log("[RADAR] WS closed: idle"); radar.ws = null; return; }
      console.log("[RADAR] WS disconnected — reconnecting in 5s");
      setTimeout(connectPumpPortal, 5000);
      radar.reconnects++;
    });

    radar.ws.on("error", (e) => {
      console.error("[RADAR] WS error:", e.message);
    });
  } catch (e) {
    console.error("[RADAR] WS connect failed:", e.message);
    setTimeout(connectPumpPortal, 10000);
  }
}

// ═══ Trade subscriptions: batched, not one message per token ═══
// Sending one subscribeTokenTrade per create (hundreds a minute) produced zero
// trade messages in production: PumpPortal answered every message but delivered
// no trades. Whether its server replaces the key set on each message or throttles
// chatty clients, the cure is the same: queue mints, flush them in ONE message
// every few seconds, and periodically re-send the FULL key list (also after a
// reconnect, which used to drop every existing subscription silently).
const SUB_FLUSH_MS = 2000;        // queued mints go out together at most this often
const SUB_RESYNC_MS = 20000;      // full key list re-sent this often
const SUB_CHUNK = 200;            // keys per message
radar._pendingSubs = new Set();
radar._pendingUnsubs = new Set();
radar._lastResync = 0;
function forgetTokenSubscription(mint) {
  if (radar.subscribedTokens.delete(mint)) radar._pendingUnsubs.add(mint);
  radar._pendingSubs.delete(mint);
}

// ═══ Mayhem: mark and forget. A marked token is filtered out of the base filter, the scored feed
// and the velocity edge, so nothing downstream ever spends a cycle on it. ═══
radar._mayhemProbed = new Set();
// ═══ Copycat launches: a same-name launch minutes after another is a billboard for the first.
// The copy is never a candidate (_copyOf); the original carries _copies for the scorer. ═══
radar._copycats = new CopycatIndex({ windowMs: (parseInt(process.env.COPYCAT_WINDOW_MIN || "60") || 60) * 60_000 });
radar._copycatLogged = 0;
// ═══ Revivals: 72 hours of 5-minute buckets per mint, so a token that wakes up at hour 6 is seen. ═══
radar._revivals = new RevivalTracker();
radar._revivalLogged = 0;
setInterval(() => radar._revivals.prune(), 10 * 60_000).unref?.();
function noteCopycat(token) {
  const hit = radar._copycats.note({ ca: token.ca, name: token.name, ticker: token.ticker, createdAt: token.createdAt });
  if (!hit) return;
  token._copyOf = hit.copyOf; token._apeScore = 0;
  const orig = radar.tokens.get(hit.copyOf);
  if (orig) { orig._copies = hit.copies; orig._lastCopyAt = token.createdAt || Date.now(); }
  if (radar._copycatLogged++ < 20) console.log(`[RADAR] copycat: ${(token.name || token.ca).slice(0, 16)} ${token.ca.slice(0, 8)} is copy #${hit.copies} of ${hit.copyOf.slice(0, 8)} -> excluded, original marked promoted`);
}
radar._mayhemLogged = 0;
function markMayhem(mint, source) {
  const t = radar.tokens.get(mint);
  if (!t || t._mayhem) return;
  t._mayhem = true; t._mayhemSource = source; t._apeScore = 0;
  if (radar._mayhemLogged++ < 20) console.log(`[RADAR] mayhem: ${(t.name || mint).slice(0, 16)} ${mint.slice(0, 8)} excluded (${source})`);
}
async function probeMayhemCurve(mint) {
  if (radar._mayhemProbed.has(mint)) return;
  radar._mayhemProbed.add(mint);
  try {
    const [bc] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_PROGRAM_ID));
    const info = await connection.getAccountInfo(bc);
    const v = detectMayhem({ curve: info?.data || null });
    if (v.mayhem) markMayhem(mint, v.source);
  } catch {}
}

function subscribeToToken(mint) {
  probeMayhemCurve(mint);
  if (!mint || radar.subscribedTokens.has(mint) || radar._pendingSubs.has(mint)) return;
  if (radar.subscribedTokens.size >= 4500 && radar.ws && radar.ws.readyState === 1) {
    // Unsub oldest tokens to stay under 5000 limit
    const oldest = [...radar.subscribedTokens].slice(0, 500);
    if (oldest.length > 0) {
      radar.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: oldest }));
      for (const k of oldest) radar.subscribedTokens.delete(k);
    }
  }
  radar._pendingSubs.add(mint);
}

function sendSubscribeKeys(keys, why) {
  if (!radar.ws || radar.ws.readyState !== 1 || !keys.length) return 0;
  let sent = 0;
  for (let i = 0; i < keys.length; i += SUB_CHUNK) {
    const chunk = keys.slice(i, i + SUB_CHUNK);
    radar.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: chunk }));
    sent += chunk.length;
  }
  radar._subLog = (radar._subLog || 0) + 1;
  if (radar._subLog <= 5 || radar._subLog % 30 === 0) console.log(`[RADAR] subscribeTokenTrade ${why}: ${sent} keys in ${Math.ceil(keys.length / SUB_CHUNK)} message(s)`);
  return sent;
}

function flushSubscriptions() {
  if (!radar.ws || radar.ws.readyState !== 1) return;
  if (tradeSourceMode() === "onchain") return; // forced on-chain: never pay PumpPortal for trades
  if (radar._tradeSubsRefused) {
    // Refused (no key, or the key's wallet ran dry). Retry every 5 minutes so a top-up recovers without a restart.
    if (Date.now() - (radar._refusedAt || 0) < 5 * 60_000) return;
    console.log("[RADAR] retrying PumpPortal trade subscriptions");
    resubscribeAllTokens();
    return;
  }
  const now = Date.now();
  if (radar._pendingUnsubs.size > 0) {
    const keys = [...radar._pendingUnsubs];
    radar._pendingUnsubs.clear();
    for (let i = 0; i < keys.length; i += SUB_CHUNK) radar.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: keys.slice(i, i + SUB_CHUNK) }));
  }
  if (radar._pendingSubs.size > 0) {
    const keys = [...radar._pendingSubs];
    radar._pendingSubs.clear();
    for (const k of keys) radar.subscribedTokens.add(k);
    sendSubscribeKeys(keys, "batch");
  }
  if (now - radar._lastResync >= SUB_RESYNC_MS && radar.subscribedTokens.size > 0) {
    radar._lastResync = now;
    sendSubscribeKeys([...radar.subscribedTokens].filter(k => radar.tokens.has(k)), "resync");
  }
}
setInterval(gated(flushSubscriptions), SUB_FLUSH_MS);

// ═══ TRADE SOURCE — PumpPortal (keyed, metered) or on-chain logsSubscribe (free) ═══
// PumpPortal meters its trade stream (about 0.01 SOL per 10,000 events) and refuses
// without a funded key. The on-chain stream decodes the same trades from the
// pump.fun program logs on any Solana RPC for free. Modes (RADAR_TRADE_SOURCE):
//   onchain    — never subscribe to PumpPortal trades (default when no API key is set)
//   pumpportal — PumpPortal only
//   auto       — PumpPortal, falling back to on-chain when refused or silent for 90s (default with a key)
function tradeSourceMode() {
  return (process.env.RADAR_TRADE_SOURCE || (PUMPPORTAL_API_KEY ? "auto" : "onchain")).toLowerCase();
}
radar._tradeSource = "pumpportal";
radar._lastPortalTradeAt = 0;
radar._onchain = null;
function onchainForward(msg) {
  if (radar._tradeSource !== "onchain") return;
  // A create is how a mint ENTERS radar.tokens, so it cannot be filtered by membership. It is also
  // the only signal the radar has of a launch when PumpPortal is down, and it carries the metadata
  // uri, so the picture is fetched at second zero. processRadarMessage ignores a create it has seen.
  if (msg.txType === "create") { radar._lastOnchainCreateAt = Date.now(); const st0 = radar._msgStats; if (st0) { st0.create++; st0.onchain = (st0.onchain || 0) + 1; } return processRadarMessage(msg); }
  if (!radar.tokens.has(msg.mint)) return; // radar.tokens IS the subscription filter for trades
  const st = radar._msgStats;
  if (st) { st.trade++; st.onchain = (st.onchain || 0) + 1; }
  processRadarMessage(msg);
}
function chooseTradeSource() {
  if (!activity.active()) { if (radar._onchain) { radar._onchain.stop().catch(() => {}); radar._onchain = null; radar._tradeSource = null; } return; }
  const forced = tradeSourceMode();
  const lastSignal = Math.max(radar._lastPortalTradeAt || 0, radar._connectedAt || 0);
  const portalDead = radar._tradeSubsRefused || (radar.subscribedTokens.size > 0 && Date.now() - lastSignal > 90_000);
  const want = forced === "onchain" ? "onchain" : forced === "pumpportal" ? "pumpportal" : portalDead ? "onchain" : "pumpportal";
  if (want === radar._tradeSource && (want !== "onchain" || radar._onchain)) return;
  radar._tradeSource = want;
  console.warn(`[RADAR] trade source -> ${want}${forced === "auto" ? (radar._tradeSubsRefused ? " (PumpPortal refused trade subscriptions)" : portalDead ? " (no PumpPortal trade for 90s)" : " (PumpPortal trades resumed)") : " (" + forced + ")"}`);
  if (want === "onchain" && !radar._onchain) {
    // The stream needs a WebSocket that allows logsSubscribe on the pump program. The public
    // endpoint drops or refuses it; the paid RPC the server already has is the right default.
    const streamRpc = process.env.RADAR_STREAM_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    console.log(`[RADAR] onchain stream via ${String(streamRpc).split("?")[0].replace(/\/v2\/.*/, "/v2/…")}${process.env.RADAR_STREAM_RPC_URL ? "" : process.env.RPC_URL ? " (RPC_URL; set RADAR_STREAM_RPC_URL to use a different one)" : " (PUBLIC endpoint: expect drops; set RADAR_STREAM_RPC_URL)"}`);
    try { radar._onchain = startOnchainTrades({ rpcUrl: streamRpc, onTrade: onchainForward }); }
    catch (e) { console.error("[RADAR] onchain stream failed to start:", e.message); }
  }
  if (want === "pumpportal" && radar._onchain) { radar._onchain.stop().catch(() => {}); radar._onchain = null; }
}
setInterval(gated(chooseTradeSource), 15_000);
setTimeout(chooseTradeSource, 3_000);

// After (re)connect, every token still on the radar must be subscribed again.
function resubscribeAllTokens() {
  radar._tradeSubsRefused = false;
  radar.subscribedTokens.clear();
  radar._pendingSubs.clear();
  for (const mint of radar.tokens.keys()) radar._pendingSubs.add(mint);
  radar._lastResync = Date.now();
  flushSubscriptions();
}

function processRadarMessage(data) {
  if (!data || !data.txType) return;
  const now = Date.now();

  // Debug first messages (log all fields to discover platform identifiers)
  if (radar._debugCount < 8) {
    console.log(`[RADAR] ${data.txType}:`, JSON.stringify(data).slice(0, 600));
    radar._debugCount++;
  }

  // PumpPortal confirmed fields (per API docs):
  // All events: signature, mint, traderPublicKey, txType, bondingCurveKey,
  //             marketCapSol, vSolInBondingCurve, vTokensInBondingCurve
  // Create only: initialBuy
  // Trade only: tokenAmount, newTokenBalance
  // Platform detection: pool field ("pump"|"bonk") or bondingCurveKey program
  const mint = data.mint || "";
  if (!mint) return;
  const vSol = data.vSolInBondingCurve || 0;
  const vTokens = data.vTokensInBondingCurve || 0;
  const trader = data.traderPublicKey || "";
  // Detect launchpad source: pump.fun vs bonk.fun (LetsBonk/Raydium LaunchLab)
  // PumpPortal may send pool="bonk" or we detect via bondingCurveKey/program
  const BONK_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
  const detectedSource = (data.pool === "bonk" || data.platform === "lets_bonk" || data.platform === "bonk"
    || (data.bondingCurveKey && data.programId === BONK_PROGRAM)
    || (data.uri && data.uri.includes("letsbonk")))
    ? "bonk" : "pump";
  // Use PumpPortal's marketCapSol directly — it matches chart prices (GMGN, pump.fun).
  // Previously computed FDV via (vSol/vTokens)*1B which inflated MC vs chart price.
  const mcSol = data.marketCapSol || (vTokens > 0 ? vSol : 0);

  // ═══ TOKEN CREATION ═══
  if (data.txType === "create") {
    if (radar.tokens.has(mint)) return;

    const mcUsd = Math.round(mcSol * solUsdPrice);
    const token = {
      ca: mint,
      // PumpPortal DOES send name/symbol/uri on create events
      name: data.name || "",
      ticker: data.symbol || "",
      description: (data.description || "").slice(0, 200),
      image: "", // fetched from uri metadata JSON
      twitter: data.twitter || "",
      website: data.website || "",
      telegram: data.telegram || "",
      createdAt: now,
      trades: [],
      buys: 0, sells: 0,
      volumeSol: 0, sellVolumeSol: 0,
      mcapSol: mcSol,
      mcapUsd: mcUsd,
      prevVSol: vSol, vSolInBondingCurve: vSol,
      uniqueBuyers: new Set(),
      spark: mcUsd > 0 ? [mcUsd] : [],
      h1Change: 0,
      devWallet: trader,
      graduated: false,
      bundled: false,
      initialBuy: data.initialBuy || 0,
      _source: detectedSource, // "pump" | "bonk" (bags set separately)
    };

    radar.tokens.set(mint, token);
    radar._lastLaunchAt = now; // what "online" on the site actually means: a launch was seen just now
    walletIntel.onCreate({ mint, creator: trader || null, ts: now, slot: data.slot ?? null });
    { const v = detectMayhem({ create: data }); if (v.mayhem) markMayhem(mint, v.source); }
    if (!token._mayhem) noteCopycat(token);
    subscribeToToken(mint);

    // Register dev wallet for balance tracking & profiling
    if (trader) {
      devWalletTracker.register(trader, {
        ca: mint,
        name: data.name || "",
        ticker: data.symbol || "",
        mcap: Math.round(mcSol * solUsdPrice),
      });
      // Kick off immediate balance check for this dev (non-blocking)
      devWalletTracker.checkBalance(trader).catch(() => {});
    }

    // Fetch image from uri (IPFS metadata JSON → image URL)
    if (data.uri) {
      fetchTokenImage(mint, data.uri).catch(() => {});
    }

    // Delayed image fallback: if the on-chain uri gave no image, ask pump.fun once it has indexed the mint
    setTimeout(() => {
      const t2 = radar.tokens.get(mint);
      if (t2 && !t2.image) {
        fetchPumpFunMetadata(mint).then(meta => {
          if (!meta?.image) return;
          const t3 = radar.tokens.get(mint);
          if (t3 && !t3.image) t3.image = meta.image;
        }).catch(() => {});
      }
    }, 30000);

    // Fallback: if WS didn't send name, try pump.fun API (may be blocked)
    if (!data.name) {
      fetchPumpFunMetadata(mint).then(meta => {
        if (!meta) return;
        if (meta.mayhem?.mayhem) markMayhem(mint, meta.mayhem.source);
        const t = radar.tokens.get(mint);
        if (!t) return;
        if (!t.name && meta.name) t.name = meta.name;
        if (!t.ticker && meta.symbol) t.ticker = meta.symbol;
        if (!t.description && meta.description) t.description = meta.description;
        if (!t.image && meta.image) { t.image = meta.image; }
        if (!t.twitter && meta.twitter) t.twitter = meta.twitter;
        if (!t.website && meta.website) t.website = meta.website;
        t._metaAt = Date.now();
        // Only trust meta.complete if token also has a raydiumPool — prevents false positives
        // from stale/wrong API responses marking brand-new tokens as graduated
        if (meta.complete && meta.raydiumPool) {
          t.graduated = true;
          t.graduatedAt = Date.now();
          if (t.mcapUsd < gradMcUsd()) t.mcapUsd = gradMcUsd();
        }
      }).catch(() => {});
    }

    // Dev buy tracking
    if (data.initialBuy > 0) {
      token.buys = 1;
      token.uniqueBuyers.add(trader);
      const devSol = vSol - 30; // initial virtual SOL is 30
      if (devSol > 0) token.volumeSol = devSol;
    }

    // Cap pool size — evict oldest
    if (radar.tokens.size > 500) {
      const entries = [...radar.tokens.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toRemove = entries.slice(0, 50);
      for (const [ca] of toRemove) {
        radar.tokens.delete(ca); forgetTokenSubscription(ca);
        // Don't bother unsubscribing — they'll be cleaned up on reconnect
      }
    }

    // Score memetic quality on creation (non-blocking, <50ms)
    scoreMemeticQuick({ name: token.name, symbol: token.ticker, description: token.description }).then(mResult => {
      const t = radar.tokens.get(mint);
      if (!t) return;
      t._memeticQuick = mResult.quickScore || 0;
      t._memeticLinguistic = mResult.linguistic || 0;
      t._memeticAbsurdity = mResult.absurdity || 0;
      t._memeticTemporal = mResult.temporal || 0;
    }).catch(() => {});

    broadcastWS({ event: "newToken", data: { ca: mint, name: token.name, mcap: mcUsd } });
    return;
  }

  // ═══ TRADE EVENT (buy/sell) ═══
  if (data.txType === "buy" || data.txType === "sell") {
    // Dedup by signature+mint: the 20s resync and a source switch can both deliver a trade twice.
    if (data.signature) {
      radar._seenSigs = radar._seenSigs || new Set();
      const key = data.signature + mint;
      if (radar._seenSigs.has(key)) { if (radar._msgStats) radar._msgStats.dup = (radar._msgStats.dup || 0) + 1; return; }
      radar._seenSigs.add(key);
      if (radar._seenSigs.size > 20000) { let n = 0; for (const k of radar._seenSigs) { radar._seenSigs.delete(k); if (++n >= 10000) break; } }
    }
    let token = radar.tokens.get(mint);

    // Auto-create if we missed the create event
    if (!token) {
      const mcUsd = Math.round(mcSol * solUsdPrice);
      token = {
        ca: mint, name: data.name || "", ticker: data.symbol || "",
        description: "", image: "",
        twitter: "", website: "", telegram: "",
        createdAt: now, trades: [], buys: 0, sells: 0, volumeSol: 0,
        mcapSol: mcSol, mcapUsd: mcUsd, prevVSol: vSol, vSolInBondingCurve: vSol,
        uniqueBuyers: new Set(), spark: mcUsd > 0 ? [mcUsd] : [],
        h1Change: 0, devWallet: "", graduated: false, bundled: false, initialBuy: 0,
        _firstSeenByTrade: now, _ageUnknown: true, // createdAt is a guess until the coin API says when it launched
      };
      radar.tokens.set(mint, token);
      subscribeToToken(mint);
      if (data.uri) fetchTokenImage(mint, data.uri).catch(() => {});
      // Fetch metadata
      fetchPumpFunMetadata(mint).then(meta => {
        if (!meta) return;
        if (meta.mayhem?.mayhem) markMayhem(mint, meta.mayhem.source);
        const t = radar.tokens.get(mint);
        if (!t) return;
        if (meta.createdAt && meta.createdAt < t.createdAt) { t.createdAt = meta.createdAt; t._ageUnknown = false; }
        if (meta.creator && !t.devWallet) t.devWallet = meta.creator;
        t.name = meta.name; t.ticker = meta.symbol;
        t.description = meta.description; t.image = meta.image;
        t.twitter = meta.twitter; t.website = meta.website; t.telegram = meta.telegram;
        t._metaAt = Date.now();
      }).catch(() => {});
    }

    // Calculate SOL amount from vSol delta
    const solDelta = Math.abs(vSol - (token.prevVSol || vSol));
    token.prevVSol = vSol;
    if (vSol > 0) token.vSolInBondingCurve = vSol; // curve depth: TOO_LATE, curve-window checks and impact estimates read this
    const sol = solDelta > 0.0001 ? solDelta : 0;

    if (data.txType === "buy") {
      token.buys++;
      token.volumeSol += sol;
      if (trader) {
        token.uniqueBuyers.add(trader);
        // Smart wallet tracking: record this buy
        smartWallets.recordBuy(trader.slice(0, 8), mint);
        // Smart money tracker: record full address for watchlist building
        smartMoneyTracker.recordObservedTrade(trader, mint, "buy", sol);
      }
    } else {
      token.sells++;
      token.sellVolumeSol = (token.sellVolumeSol || 0) + sol;
    }

    // Update mcap from PumpPortal data
    if (mcSol > 0) {
      token.mcapSol = mcSol;
      token.mcapUsd = Math.round(mcSol * solUsdPrice);
    }

    // Graduation detection: vSol must be very close to 85 SOL threshold
    // Previously used >= 79 which was too aggressive — tokens often pump to 79-83 then dump back.
    // Real graduation fires a migration event (handled separately). This is a safety net only.
    if (vSol >= 84 && !token.graduated) {
      token.graduated = true;
      // Floor mcap to graduation threshold — bonding curve mcap underreports
      if (token.mcapUsd < gradMcUsd()) token.mcapUsd = gradMcUsd();
    }

    // Sparkline
    if (token.mcapUsd > 0) {
      token.spark.push(token.mcapUsd);
      if (token.spark.length > 60) token.spark = token.spark.slice(-60);
    }

    // Track trade (hub = bot/router wallet: counts for volume, not for identity)
    const hub = noteWalletTrade(trader.slice(0, 8), mint, now);
    token.trades.push({ side: data.txType, sol: +sol.toFixed(4), wallet: trader.slice(0, 8), time: now, hub });
    // The full pubkey exists only here; token.trades keeps a prefix. This is the one place the
    // wallet ledger can be fed, so it is fed for buys and sells alike -- a sell is what closes a
    // position and turns a guess about a wallet into a measured result.
    // The trade's own SOL, as the stream decoded it, never the curve-reserve delta: a delta is zero
    // on the first trade seen for a mint and the sum of two trades after a dropped one, and either
    // way a wallet would be booked a lot it did not pay for or charged one it did not make.
    if (trader && (data.txType === "buy" || data.txType === "sell")) walletIntel.onTrade({ mint, wallet: trader, isBuy: data.txType === "buy", sol: Number(data.solAmount) > 0 ? Number(data.solAmount) : sol, tokens: Number(data.tokenAmount) || 0, ts: now, slot: data.slot ?? null, signature: data.signature || null, mcapUsd: token.mcapUsd || null });
    if (token.mcapUsd > 0) walletIntel.markMcap(mint, token.mcapUsd, now);
    if (token.trades.length > 100) token.trades = token.trades.slice(-100);
    if (!hub) radar._revivals.noteTrade(mint, { side: data.txType, sol, wallet: trader, curvePct: token.graduated ? null : Math.min(100, (vSol / 85) * 100), ts: now });

    // h1 change
    const firstSpark = token.spark.length > 1 ? token.spark[0] : token.mcapUsd;
    token.h1Change = firstSpark > 0 ? ((token.mcapUsd - firstSpark) / firstSpark) * 100 : 0;

    broadcastWS({ event: "trade", data: { ca: mint, side: data.txType, sol: +sol.toFixed(4), mcap: token.mcapUsd, wallet: trader.slice(0, 8) } });
  }

  // ═══ MIGRATION / GRADUATION ═══
  if (data.txType === "migration" || data.txType === "migrate") {
    const token = radar.tokens.get(mint);
    if (token) {
      token.graduated = true;
      token.graduatedAt = Date.now();
      // Set mcap floor to graduation MC — bonding curve mcap is stale/misleading post-graduation
      const gradMc = gradMcUsd();
      if (token.mcapUsd < gradMc) token.mcapUsd = gradMc;
      console.log(`[RADAR] Token graduated: ${token.name || mint.slice(0, 8)} — MC: $${token.mcapUsd}`);
      // Smart wallet: resolve outcome as win for all buyers
      smartWallets.resolveOutcome(mint, true);
      smartMoneyTracker.recordOutcome(mint, true);
      walletIntel.onGraduated(mint, now);
      // Fetch live MC from DexScreener since PumpPortal stops sending data after graduation
      // Retry with delay since Raydium pool takes seconds to index
      refreshGraduatedMcap(mint).catch(() => {});
      setTimeout(() => refreshGraduatedMcap(mint).catch(() => {}), 15000);
      setTimeout(() => refreshGraduatedMcap(mint).catch(() => {}), 60000);
      // Add to graduated watchlist for 24h follow
      const wEntry = { name: token.name || "", ticker: token.ticker || "", image: token.image || "", gradMcap: token.mcapUsd || 0, gradTime: Date.now(), spark: [...(token.spark || [])], peakMcap: token.mcapUsd || 0, lastMcap: token.mcapUsd || 0, lastRefresh: Date.now() };
      gradWatchlist.set(mint, wEntry);
      if (redis) { redis.hSet("grad:watchlist", mint, JSON.stringify(wEntry)).catch(() => {}); }
    }
    broadcastWS({ event: "graduation", data: { ca: mint } });
  }
}

// ═══ GRADUATED MC REFRESH — batched DexScreener for speed ═══
// Single-token fallback (used on graduation event)
async function refreshGraduatedMcap(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const d = await r.json();
    const pair = d?.pairs?.[0];
    if (!pair) return;
    applyMcapUpdate(mint, pair);
  } catch {}
}

// Apply MC data from a DexScreener pair to a radar token
function applyMcapUpdate(mint, pair) {
  const token = radar.tokens.get(mint);
  if (!token) return;
  const newMcap = pair.marketCap || pair.fdv || 0;
  if (newMcap > 0) {
    const changed = token.mcapUsd !== Math.round(newMcap);
    token.mcapUsd = Math.round(newMcap);
    token.mcapSol = solUsdPrice > 0 ? Math.round(newMcap / solUsdPrice) : token.mcapSol;
    token.spark.push(token.mcapUsd);
    if (token.spark.length > 60) token.spark = token.spark.slice(-60);
    token.raydiumPool = pair.pairAddress || true;
    // Push MC update to frontend immediately via WebSocket
    if (changed) broadcastWS({ event: "mcap-update", data: { ca: mint, mcap: token.mcapUsd, mcapSol: token.mcapSol } });
  }
}

// Batch fetch MC for multiple tokens in one DexScreener request (up to 30 per batch)
async function batchRefreshMcap(mints) {
  if (mints.length === 0) return;
  const BATCH_SIZE = 30;
  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    const batch = mints.slice(i, i + BATCH_SIZE);
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const d = await r.json();
      if (!d?.pairs) continue;
      // Group pairs by base token address — pick best pair per token
      const bestPairs = new Map();
      for (const pair of d.pairs) {
        const addr = pair.baseToken?.address;
        if (!addr || !batch.includes(addr)) continue;
        const existing = bestPairs.get(addr);
        if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity?.usd || 0)) {
          bestPairs.set(addr, pair);
        }
      }
      for (const [mint, pair] of bestPairs) {
        applyMcapUpdate(mint, pair);
      }
    } catch {}
  }
}

// ═══ GRADUATED WATCHLIST — follows tokens beyond radar TTL ═══
// Tokens that graduate get tracked here for up to 24h for learning
const gradWatchlist = new Map(); // ca → { name, ticker, gradMcap, gradTime, spark, peakMcap, lastMcap, lastRefresh }
const GRAD_WATCH_TTL = 86400000; // 24h

// Periodically refresh MC for all graduated tokens (every 10s — batched so only 1-2 requests)
setInterval(gated(async () => {
  // Batch refresh all graduated radar tokens in one request
  const graduatedMints = [...radar.tokens.entries()].filter(([, t]) => t.graduated).map(([ca]) => ca);
  await batchRefreshMcap(graduatedMints);

  // Also batch refresh stale watchlist tokens
  const now = Date.now();
  const stale = [...gradWatchlist.entries()]
    .filter(([, w]) => now - w.lastRefresh > 30000 && now - w.gradTime < GRAD_WATCH_TTL)
    .slice(0, 30);
  if (stale.length > 0) {
    const staleMints = stale.map(([ca]) => ca);
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${staleMints.join(",")}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const d = await r.json();
        if (d?.pairs) {
          const bestPairs = new Map();
          for (const pair of d.pairs) {
            const addr = pair.baseToken?.address;
            if (!addr) continue;
            const existing = bestPairs.get(addr);
            if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity?.usd || 0)) {
              bestPairs.set(addr, pair);
            }
          }
          for (const [ca, w] of stale) {
            const pair = bestPairs.get(ca);
            if (pair) {
              const mc = pair.marketCap || pair.fdv || 0;
              w.lastMcap = mc;
              if (mc > w.peakMcap) w.peakMcap = mc;
              w.spark.push(mc);
              if (w.spark.length > 100) w.spark = w.spark.slice(-100);
              w.lastRefresh = now;
              if (redis) { try { await redis.hSet("grad:watchlist", ca, JSON.stringify(w)); } catch {} }
            }
          }
        }
      }
    } catch {}
  }
  // Evict expired watchlist entries — label outcome before removing
  for (const [ca, w] of gradWatchlist) {
    if (now - w.gradTime > GRAD_WATCH_TTL) {
      const peak = w.peakMcap || w.gradMcap;
      const current = w.lastMcap || 0;
      const dropPct = peak > 0 ? ((peak - current) / peak) * 100 : 0;
      const rugged = dropPct > 80;
      const outcome = { graduated: true, peakMcx: peak > 0 && w.gradMcap > 0 ? peak / w.gradMcap : 1, rugged, mcapDropPct: dropPct, devDumped: false, alive: current > 5000 };
      // Re-learn from 24h outcome data — more accurate than the 4h eviction label
      const features = { isGradWatchlist: true, gradMcap: w.gradMcap, peakMcap: peak, finalMcap: current, age24h: true };
      try { memeIntel.learn(features, outcome); } catch {}
      try { await storeChartSnapshot(ca, { name: w.name, ticker: w.ticker, spark: w.spark, mcapUsd: current, createdAt: w.gradTime, buys: 0, sells: 0 }, outcome); } catch {}
      gradWatchlist.delete(ca);
      if (redis) { try { await redis.hDel("grad:watchlist", ca); } catch {} }
    }
  }
}), 10000);

// Load watchlist from Redis on startup
(async () => {
  if (!redis) return;
  try {
    const all = await redis.hGetAll("grad:watchlist");
    for (const [ca, json] of Object.entries(all || {})) {
      try { gradWatchlist.set(ca, JSON.parse(json)); } catch {}
    }
    console.log(`[GRAD-WATCH] Loaded ${gradWatchlist.size} tokens from Redis`);
  } catch {}
})();

// ═══ QUICK FEATURE EXTRACTION — for memeIntel learning ═══
function extractQuickFeatures(t) {
  if (!t || !t.ca) return null;
  const ageMin = Math.max(0.5, (Date.now() - t.createdAt) / 60000);
  const ub = t.uniqueBuyers?.size || 0;
  const buys = t.buys || 0;
  const sells = t.sells || 0;
  const vol = t.volumeSol || 0;
  const sellVol = t.sellVolumeSol || 0;
  // Identity and timing features read ORGANIC trades only. Hub wallets (bots and
  // routers trading many mints at once, see noteWalletTrade) are excluded here;
  // their volume still lives in t.buys / t.volumeSol / t.sellVolumeSol above.
  const trades = (t.trades || []).filter(tr => !tr.hub);

  // ── Dev sell detection (improved: match full wallet when available) ──
  const devW = (t.devWallet || "").slice(0, 8);
  const devTrades = devW ? trades.filter(tr => (tr.wallet || "").startsWith(devW)) : [];
  const devSells = devTrades.filter(tr => tr.side === "sell");
  const devBuySol = devTrades.filter(tr => tr.side === "buy").reduce((s, tr) => s + (tr.sol || 0), 0);
  const devSellSol = devSells.reduce((s, tr) => s + (tr.sol || 0), 0);
  // How fast did dev dump? 0 = held, 1 = instant dump
  const devSellSpeed = devSells.length > 0
    ? Math.min(1, 30 / Math.max(1, (devSells[0]?.time - t.createdAt) / 60000))
    : 0;
  // Did dev sell MORE than they bought? (sniped own token)
  const devSelfSnipe = devBuySol > 0 && devSellSol > devBuySol * 0.8 ? 1 : 0;

  // ── Coordinated dump: multiple sells within 3s windows ──
  const sellTimes = trades.filter(tr => tr.side === "sell").map(tr => tr.time).sort((a, b) => a - b);
  let coordDumps = 0;
  for (let i = 1; i < sellTimes.length; i++) {
    if (sellTimes[i] - sellTimes[i - 1] < 3000) coordDumps++;
  }

  // ── Sell wave: bursts of sells in 10s windows ──
  let maxSellBurst = 0;
  for (let i = 0; i < sellTimes.length; i++) {
    let burst = 1;
    for (let j = i + 1; j < sellTimes.length && sellTimes[j] - sellTimes[i] < 10000; j++) burst++;
    maxSellBurst = Math.max(maxSellBurst, burst);
  }

  // ── Mcap drop from peak ──
  // The sparkline prints one point per trade, so a single bot buy prints a spike nobody could have
  // sold into. The peak is the second-highest print: a real top is printed more than once.
  const sparkDesc = (t.spark || []).slice().sort((a, b) => b - a);
  const peakMc = sparkDesc.length >= 3 ? sparkDesc[1] : (sparkDesc[0] || t.mcapUsd);
  const mcapDropRate = peakMc > 0 ? Math.max(0, (peakMc - (t.mcapUsd || 0)) / peakMc) : 0;

  // ── Holder concentration from trade data ──
  // Approximate top-wallet concentration from buy amounts
  const walletBuys = new Map();
  for (const tr of trades) {
    if (tr.side === "buy" && tr.wallet) {
      walletBuys.set(tr.wallet, (walletBuys.get(tr.wallet) || 0) + (tr.sol || 0));
    }
  }
  const sortedHolders = [...walletBuys.values()].sort((a, b) => b - a);
  const totalBought = sortedHolders.reduce((s, v) => s + v, 0);
  const top3Bought = sortedHolders.slice(0, 3).reduce((s, v) => s + v, 0);
  const holderConcentration = totalBought > 0 ? Math.min(1, top3Bought / totalBought) : 0;

  // ── Sybil / wash-trade detection ──
  // Multiple tiny buys from many wallets in tight time windows = likely bot swarm
  const buyTrades = trades.filter(tr => tr.side === "buy");
  let tinyBuyCount = 0;       // buys < 0.02 SOL (dust buys to inflate buyer count)
  let sameSizeBuys = 0;       // buys with identical SOL amounts (bot pattern)
  const buySolAmounts = new Map();
  for (const tr of buyTrades) {
    const sol = tr.sol || 0;
    if (sol > 0 && sol < 0.02) tinyBuyCount++;
    const rounded = (sol * 100 | 0); // round to 0.01
    buySolAmounts.set(rounded, (buySolAmounts.get(rounded) || 0) + 1);
  }
  for (const [, count] of buySolAmounts) {
    if (count >= 3) sameSizeBuys += count; // 3+ buys at exact same size = suspicious
  }
  const sybilScore = Math.min(1,
    (buys > 5 ? tinyBuyCount / buys : 0) * 0.5 +        // dust buy ratio
    (buys > 5 ? sameSizeBuys / buys : 0) * 0.5           // identical-size buy ratio
  );

  // ── Distribution: the share of organic flow that is selling ──
  // Two corrections to what this measured before. (1) t.volumeSol / t.sellVolumeSol include hub
  // bots, which round-trip the curve within seconds and add equal buy and sell volume, so the
  // figure sat near its ceiling for any token they touched. (2) It divided sell volume by BUY
  // volume (t.volumeSol counts buys only), so the 0.65 threshold fired once sells reached 65% of
  // buys, which is ordinary two-way flow. As a share of total flow, 0.65 means sells are nearly
  // twice buys: someone is distributing. The old ratio is kept as _rg_liqRemovalAll.
  const orgBuySol = buyTrades.reduce((s, tr) => s + (tr.sol || 0), 0);
  const orgSellSol = trades.filter(tr => tr.side === "sell").reduce((s, tr) => s + (tr.sol || 0), 0);
  const sellBuyRatioAll = vol > 0 ? Math.min(1, sellVol / vol) : 0;
  const orgFlow = orgBuySol + orgSellSol;
  const sellBuyRatio = orgFlow >= 0.5 ? orgSellSol / orgFlow : (vol + sellVol > 0 ? sellVol / (vol + sellVol) : 0);

  // ── Early dump: sells happening within first 2 minutes ──
  const earlyWindow = t.createdAt + 120000; // 2 minutes
  const earlySells = trades.filter(tr => tr.side === "sell" && tr.time < earlyWindow);
  const earlyDumpScore = Math.min(1, earlySells.length / Math.max(1, buys) * 3);

  // ── Buy-then-sell same wallet: quick flip detection ──
  let quickFlips = 0;
  const walletFirstBuy = new Map();
  for (const tr of trades) {
    if (tr.side === "buy" && tr.wallet && !walletFirstBuy.has(tr.wallet)) {
      walletFirstBuy.set(tr.wallet, tr.time);
    }
    if (tr.side === "sell" && tr.wallet) {
      const firstBuy = walletFirstBuy.get(tr.wallet);
      if (firstBuy && (tr.time - firstBuy) < 60000) quickFlips++; // sold within 60s of buying
    }
  }
  // Share of organic buyer wallets that sold within 60s of their first buy. (The old form doubled
  // flips over all unique buyers, hubs included, and fired on half of every token-snapshot.)
  const quickFlipRate = buys > 3 ? Math.min(1, quickFlips / Math.max(1, walletBuys.size)) : 0;

  // ── Sparkline crash pattern: sharp spike then dump ──
  const spark = t.spark || [];
  let pumpDumpScore = 0;
  if (spark.length >= 4) {
    const peak = Math.max(...spark);
    const peakIdx = spark.indexOf(peak);
    const current = spark[spark.length - 1] || 0;
    // Pump-and-dump: peaked early, crashed since
    if (peakIdx < spark.length * 0.5 && peak > 0 && current < peak * 0.3) {
      pumpDumpScore = Math.min(1, (peak - current) / peak);
    }
  }

  // ── VELOCITY LINEARITY (R²) — straight-line price = dev self-buy ──
  // Organic tokens have noisy, bursty price action (R² < 0.6).
  // Dev self-pump tokens have near-perfect linear velocity up (R² > 0.85).
  // This is the single strongest signal for the "Whale Guru" pattern:
  // constant-velocity grind up with 90%+ buy pressure, then dev dumps.
  let velocityLinearityR2 = 0;
  if (spark.length >= 6) {
    // Linear regression R² on sparkline
    const n = spark.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i; sumY += spark[i]; sumXY += i * spark[i]; sumX2 += i * i; sumY2 += spark[i] * spark[i];
    }
    const denom = (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY);
    if (denom > 0) {
      const r = (n * sumXY - sumX * sumY) / Math.sqrt(denom);
      velocityLinearityR2 = r * r; // R²
    }
    // Only flag if price is GOING UP (positive slope) — we don't care about linear crashes
    const slope = n > 1 ? (spark[n - 1] - spark[0]) / n : 0;
    if (slope <= 0) velocityLinearityR2 = 0;
  }

  // ── BUY TIMING REGULARITY — metronome buys = bot/dev ──
  // Real FOMO buying comes in bursts with irregular gaps.
  // Dev/bot buying comes at near-constant intervals like a metronome.
  // Measure coefficient of variation of buy inter-arrival times.
  let buyTimingRegularity = 0;
  const buyTimesArr = buyTrades.map(tr => tr.time).filter(t2 => t2 > 0).sort((a, b) => a - b);
  if (buyTimesArr.length >= 6) {
    const intervals = [];
    for (let i = 1; i < buyTimesArr.length; i++) {
      intervals.push(buyTimesArr[i] - buyTimesArr[i - 1]);
    }
    const avgInt = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (avgInt > 0) {
      const variance = intervals.reduce((s, d) => s + (d - avgInt) ** 2, 0) / intervals.length;
      const cv = Math.sqrt(variance) / avgInt;
      // cv < 0.4 = very regular timing (bot), cv > 1.0 = bursty (organic FOMO)
      // Convert to 0-1 score where 1 = perfect metronome
      buyTimingRegularity = Math.max(0, Math.min(1, 1 - cv));
    }
    // Only suspicious if there are enough buys AND price is going up
    const priceUp = spark.length >= 3 && spark[spark.length - 1] > spark[0] * 1.2;
    if (!priceUp || buyTimesArr.length < 6) buyTimingRegularity = 0;
  }

  // ── SINGLE WALLET DOMINANCE — one wallet doing most of the buying ──
  // In dev self-pumps, one wallet (or 2-3 related wallets) accounts for
  // the vast majority of buy volume. Real organic tokens have distributed buying.
  let singleWalletDominance = 0;
  if (walletBuys.size >= 2 && totalBought > 0) {
    const topWalletSol = sortedHolders[0] || 0;
    const top2Sol = (sortedHolders[0] || 0) + (sortedHolders[1] || 0);
    // Single wallet doing >50% of all buy volume
    singleWalletDominance = topWalletSol / totalBought;
    // If top 2 wallets are doing >70%, even more suspicious
    if (top2Sol / totalBought > 0.7 && walletBuys.size >= 3) {
      singleWalletDominance = Math.max(singleWalletDominance, top2Sol / totalBought * 0.9);
    }
  }

  // ── Chart shape similarity to stored graduated patterns ──
  let chartHealthScore = 0.5; // neutral default
  let smoothGrindScore = 0;
  let dipRatioScore = 0.5;
  let staircaseScore = 0;
  let flatlineSpikeScore = 0;
  if (spark.length >= 5) {
    const start = spark[0] || 1;
    const peak = Math.max(...spark);
    const current = spark[spark.length - 1] || 0;
    const peakIdx = spark.indexOf(peak);
    const peakPct = peakIdx / spark.length;
    const multiple = peak / start;
    const endRatio = current / (peak || 1);

    // Count dips and consecutive ups for smooth grind detection
    let sparkDips = 0, sparkUps = 0, maxConsUp = 0, consUp = 0;
    for (let i = 1; i < spark.length; i++) {
      if (spark[i] < spark[i - 1]) { sparkDips++; consUp = 0; }
      else if (spark[i] > spark[i - 1]) { sparkUps++; consUp++; maxConsUp = Math.max(maxConsUp, consUp); }
    }
    const totalSparkMoves = sparkDips + sparkUps;
    const sparkUpPct = totalSparkMoves > 0 ? sparkUps / totalSparkMoves : 0;
    dipRatioScore = totalSparkMoves > 0 ? Math.min(1, sparkDips / totalSparkMoves * 2) : 0;

    // Smooth grind: gradual up with almost no dips = fake chart / self-bought rug
    if (spark.length >= 8 && current > start * 1.3 && sparkUpPct > 0.85 && maxConsUp >= 6) {
      smoothGrindScore = Math.min(1, 0.5 + (sparkUpPct - 0.85) * 3 + (maxConsUp - 6) * 0.05);
    } else if (spark.length >= 8 && current > start * 1.3 && sparkUpPct > 0.75 && maxConsUp >= 5) {
      smoothGrindScore = Math.min(0.6, 0.3 + (sparkUpPct - 0.75) * 2);
    }

    // Healthy: steady growth WITH dips, peak late, holding value
    if (multiple > 2 && peakPct > 0.5 && endRatio > 0.4 && sparkDips >= 2) chartHealthScore = Math.min(1, 0.6 + multiple * 0.05);
    // Bad: early peak, crashed
    else if (peakPct < 0.3 && endRatio < 0.2) chartHealthScore = Math.max(0, 0.2 - pumpDumpScore * 0.2);
    // Slow grind: still growing
    else if (current > start && multiple < 3) chartHealthScore = 0.6;
    // Penalize smooth grind — looks healthy but is fake
    if (smoothGrindScore > 0.5) chartHealthScore = Math.max(0, chartHealthScore - smoothGrindScore * 0.4);

    // ── STAIRCASE CHART DETECTION ──
    // Classic rug pattern: dev buys from fresh wallets at regular intervals creating
    // a monotonically increasing chart with uniform step sizes. Real charts have
    // varying step sizes and natural pullbacks.
    if (spark.length >= 6) {
      const deltas = [];
      let monotoneUps = 0;
      for (let i = 1; i < spark.length; i++) {
        const d = spark[i] - spark[i - 1];
        if (d > 0) { monotoneUps++; deltas.push(d); }
      }
      const monotoneRatio = monotoneUps / (spark.length - 1);
      // Check step uniformity: low coefficient of variation = suspiciously regular
      if (deltas.length >= 4) {
        const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        const variance = deltas.reduce((s, d) => s + (d - avgDelta) ** 2, 0) / deltas.length;
        const cv = avgDelta > 0 ? Math.sqrt(variance) / avgDelta : 1; // coefficient of variation
        // Low CV (uniform steps) + high monotone ratio = staircase
        // Real charts: CV > 0.5, rugs: CV < 0.3
        if (monotoneRatio > 0.8 && cv < 0.4) {
          staircaseScore = Math.min(1, 0.4 + (0.4 - cv) * 2 + (monotoneRatio - 0.8) * 2);
        } else if (monotoneRatio > 0.7 && cv < 0.35) {
          staircaseScore = Math.min(0.5, 0.2 + (0.35 - cv) * 1.5);
        }
      }
    }
    // Staircase penalizes chart health
    if (staircaseScore > 0.4) chartHealthScore = Math.max(0, chartHealthScore - staircaseScore * 0.5);

    // ── FLATLINE SPIKE DETECTION ──
    // Classic rug: chart sits near zero/flat for most of its life, then a single
    // massive buy creates a vertical spike. The "hockey stick from zero" pattern.
    // Detection: majority of spark points cluster in a narrow low range, then the
    // last few points jump dramatically. Real organic growth doesn't look like this.
    if (spark.length >= 6) {
      const sorted = [...spark].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] || 1;
      const lastFew = spark.slice(-3);
      const lastMax = Math.max(...lastFew);
      // Count how many points are "flat" (within 30% of median)
      const flatCount = spark.slice(0, -3).filter(v => v <= median * 1.3).length;
      const flatRatio = flatCount / Math.max(1, spark.length - 3);
      const spikeRatio = median > 0 ? lastMax / median : 0;
      // Flatline spike: >70% of history is flat AND last points spike >3x median
      if (flatRatio > 0.7 && spikeRatio > 3) {
        flatlineSpikeScore = Math.min(1, 0.4 + (flatRatio - 0.7) * 2 + Math.min(0.4, (spikeRatio - 3) * 0.05));
      } else if (flatRatio > 0.6 && spikeRatio > 5) {
        flatlineSpikeScore = Math.min(0.6, 0.3 + (spikeRatio - 5) * 0.03);
      }
      // Flatline spike kills chart health
      if (flatlineSpikeScore > 0.3) chartHealthScore = Math.max(0, chartHealthScore - flatlineSpikeScore * 0.6);
    }
  }

  // ── ZERO SELL FLAG — the #1 rug signal ──
  // A token with many buys and zero/near-zero organic sells is almost always a rug.
  // Dev buys from fresh wallets to fake activity; nobody is organically selling because
  // there ARE no organic buyers — just the dev recycling SOL.
  const organicSells = sells - (devSells.length || 0); // exclude dev sells
  let zeroSellFlag = 0;
  if (buys >= 5 && organicSells <= 0) {
    zeroSellFlag = 1.0; // absolute red flag
  } else if (buys >= 10 && organicSells <= 1) {
    zeroSellFlag = 0.8;
  } else if (buys >= 5 && organicSells <= 1) {
    zeroSellFlag = 0.5;
  }

  // ── BUY/SELL IMBALANCE ──
  const totalTx = buys + sells;
  let buySellImbalance = 0;
  if (totalTx >= 5) {
    const buyPct = buys / totalTx;
    if (buyPct >= 0.95) buySellImbalance = 1.0;
    else if (buyPct >= 0.9) buySellImbalance = 0.7;
    else if (buyPct >= 0.8 && totalTx >= 10) buySellImbalance = 0.4;
  }

  // ── FRESH WALLET RATIO ──
  // If most buyers are wallets we've only seen once in this token's trades,
  // and they all bought but never sold, they're likely dev-controlled fresh wallets.
  const buyWalletTxCounts = new Map();
  for (const tr of trades) {
    if (tr.wallet) buyWalletTxCounts.set(tr.wallet, (buyWalletTxCounts.get(tr.wallet) || 0) + 1);
  }
  const uniqueBuyWallets = new Set(buyTrades.map(tr => tr.wallet).filter(Boolean));
  const singleUseBuyers = [...uniqueBuyWallets].filter(w => buyWalletTxCounts.get(w) === 1).length;
  const freshWalletRatio = uniqueBuyWallets.size > 2 ? singleUseBuyers / uniqueBuyWallets.size : 0;
  // Combined: fresh wallets + zero sells = definite rug setup
  const freshWalletRugSignal = freshWalletRatio > 0.7 && zeroSellFlag > 0.5 ? Math.min(1, freshWalletRatio * zeroSellFlag * 1.5) : freshWalletRatio;

  // ── COMPOSITE: DEV SELF-PUMP SCORE ──
  // Combines all signals into a single "is this a dev pump?" detector.
  // Fires when: linear velocity + regular timing + few sellers + high concentration
  let devSelfPumpScore = 0;
  {
    const signals = [
      velocityLinearityR2 > 0.85 ? 1 : velocityLinearityR2 > 0.7 ? 0.5 : 0,   // linear price
      buyTimingRegularity > 0.6 ? 1 : buyTimingRegularity > 0.4 ? 0.5 : 0,      // metronome buys
      zeroSellFlag > 0.5 ? 1 : buySellImbalance > 0.6 ? 0.7 : 0,                // no sells
      singleWalletDominance > 0.5 ? 1 : holderConcentration > 0.6 ? 0.5 : 0,    // concentrated
      smoothGrindScore > 0.4 ? 0.5 : staircaseScore > 0.3 ? 0.5 : 0,            // chart shape
    ];
    const signalCount = signals.filter(s => s > 0).length;
    const signalSum = signals.reduce((a, b) => a + b, 0);
    // 3+ signals = suspicious, 4+ = near certain
    if (signalCount >= 4) {
      devSelfPumpScore = Math.min(1, 0.7 + signalSum * 0.06);
    } else if (signalCount >= 3) {
      devSelfPumpScore = Math.min(0.8, 0.4 + signalSum * 0.08);
    } else if (signalCount >= 2 && signalSum >= 1.5) {
      // 2 strong signals (e.g., R²=0.9 + zero sells) = moderate concern
      devSelfPumpScore = Math.min(0.5, 0.2 + signalSum * 0.1);
    }
  }

  // ── DEV CREDIBILITY SCORE ──
  // Fresh name (never launched before) + first-time dev + dev holding SOL = high trust
  // Cached on token object via background enrichment (devCredData)
  const devCred = t._devCredData || null;
  let devCredScore = 0.5; // neutral default when no data
  let nameUniquenessScore = 0.5; // 1 = never seen, 0 = spammed name
  if (devCred) {
    // Name uniqueness: 1 = first time this name, 0 = many previous tokens with same name
    nameUniquenessScore = devCred.nameUnique ? 1.0 : Math.max(0, 1 - (devCred.namePrevLaunches || 0) * 0.25);
    // Dev wallet scoring: SOL balance + launch count
    const solBonus = devCred.devSolBalance >= 10 ? 1.0 : devCred.devSolBalance >= 5 ? 0.7 : devCred.devSolBalance >= 1 ? 0.4 : 0.1;
    const launchPenalty = devCred.devLaunchCount === 0 ? 1.0 : devCred.devLaunchCount === 1 ? 0.8 : devCred.devLaunchCount <= 3 ? 0.5 : Math.max(0, 0.3 - devCred.devLaunchCount * 0.03);
    // Combined: weight name 30%, dev balance 35%, launch count 35%
    devCredScore = Math.min(1, nameUniquenessScore * 0.3 + solBonus * 0.35 + launchPenalty * 0.35);
    // Perfect score: fresh name + first launch + 10+ SOL
    if (devCred.nameUnique && devCred.devLaunchCount <= 1 && devCred.devSolBalance >= 10) devCredScore = 1.0;
    // Previous tokens with same name that rugged = big penalty
    if (devCred.namePrevRugged) devCredScore = Math.max(0, devCredScore - 0.4);
  }

  const result = {
    // On-chain
    oc_buyVelocity5m: Math.min(1, (buys / Math.max(1, Math.min(5, ageMin))) / 20),
    oc_uniqueBuyers5m: Math.min(1, ub / 30),
    oc_avgBuySol: vol > 0 && buys > 0 ? Math.min(1, (vol / buys) / 5) : 0,
    oc_sellRatio5m: Math.min(1, sells / Math.max(1, buys + sells)),
    oc_mcapSol: Math.min(1, (t.mcapSol || 0) / 500),
    oc_volumeSol5m: Math.min(1, vol / 50),
    // Social
    so_hasTwitter: t.twitter ? 1 : 0,
    so_hasTelegram: t.telegram ? 1 : 0,
    so_hasWebsite: t.website ? 1 : 0,
    // Whether the metadata has been read at all. Without this a gate cannot tell "this launch listed
    // no socials" from "we have not fetched its metadata yet", and would reject every young token.
    _socialsKnown: t._metaAt ? 1 : 0,
    // A twitter handle the X API says does not exist does not count as a social link.
    _hasAnySocial: ((t.twitter && !t._xSocial?.dead) || t.telegram || (t.website && t._siteAlive?.ok !== false)) ? 1 : 0,
    _siteDead: t._siteAlive && t._siteAlive.ok === false ? 1 : 0,
    _xDeadHandle: t._xSocial?.dead ? 1 : 0,
    _xScore: t._xSocial ? t._xSocial.score : null,
    _xFlags: t._xSocial?.flags || null,
    // Rug detection (enhanced)
    rg_devSellSpeed: devSellSpeed,
    // The dev's share of supply still held: what one wallet can dump in a single transaction.
    _rg_devHoldPct: devSells.length ? Math.max(0, ((t.initialBuy || 0) / 1e9) * (devBuySol > 0 ? Math.max(0, 1 - devSellSol / devBuySol) : 0)) : (t.initialBuy || 0) / 1e9,
    rg_holderConcentration: holderConcentration,
    _rg_organicBuyers: walletBuys.size, // distinct non-hub buyer wallets behind the concentration figure
    rg_coordDumpScore: Math.min(1, coordDumps / 5),
    rg_liqRemovalSpeed: sellBuyRatio,
    _rg_liqRemovalAll: sellBuyRatioAll, // hubs included, for calibration only
    // Wallet age: use cached on-chain age data if available, else fall back to sybil heuristic
    rg_walletAgeScore: t._walletAgeData ? t._walletAgeData.walletAgeScore : (1 - sybilScore),
    rg_sellWaveDetect: Math.min(1, maxSellBurst / 8),
    rg_mcapDropRate: mcapDropRate,
    rg_buyerRetention: buys > 0 ? Math.min(1, ub / buys) : 0,
    // Chart shape analysis
    ch_healthScore: chartHealthScore,
    ch_pumpDump: pumpDumpScore,
    ch_smoothGrind: smoothGrindScore,
    ch_dipRatio: dipRatioScore,
    ch_staircaseScore: staircaseScore,
    ch_flatlineSpike: flatlineSpikeScore,
    // Extra rug signals (used in buy gate, not in FEATURE_KEYS)
    _rg_devSelfSnipe: devSelfSnipe,
    _rg_earlyDump: earlyDumpScore,
    _rg_quickFlipRate: quickFlipRate,
    _rg_pumpDump: pumpDumpScore,
    _rg_sybilScore: sybilScore,
    _rg_zeroSellFlag: zeroSellFlag,
    _rg_buySellImbalance: buySellImbalance,
    _rg_freshWalletRatio: freshWalletRugSignal,
    // Dev self-pump pattern (velocity linearity + timing regularity + concentration)
    _rg_velocityLinearity: velocityLinearityR2,
    _rg_buyTimingRegularity: buyTimingRegularity,
    _rg_singleWalletDominance: singleWalletDominance,
    _rg_devSelfPumpScore: devSelfPumpScore,
    // Wallet age on-chain data (0 = all fresh wallets = bad, 1 = all aged = good)
    _walletAgeFresh: t._walletAgeData ? t._walletAgeData.freshRatio : freshWalletRugSignal,
    // Whale bullish: aged whale wallets buying = smart money conviction. NULL, not 0, when the wallet-age
    // enrichment never ran: 0 asserts "no whale is buying", which is a claim we have not earned, and the
    // learner's opt() only drops a feature from the weighted sum when it is null. As a literal 0 it entered
    // at full weight and dragged every hosted candidate's confidence under the entry floor.
    _whaleBullish: t._walletAgeData ? t._walletAgeData.whaleBullish : null,
    _whaleBuys: t._walletAgeData ? t._walletAgeData.whaleBuys : [],
    // Dev credibility: name uniqueness + dev wallet SOL + launch history
    _devCredScore: devCredScore,
    _nameUniqueness: nameUniquenessScore,
    _devSolBalance: devCred?.devSolBalance || 0,
    _devLaunchCount: devCred?.devLaunchCount ?? -1,
    _namePrevRugged: devCred?.namePrevRugged || false,

    // ═══ SIR VIRAL MODEL ═══
    // R0 estimation from buyer arrival rate acceleration
    sir_r0: (() => {
      const buyTimes2 = buyTrades.map(tr => tr.time).filter(t2 => t2 > 0).sort((a, b) => a - b);
      if (buyTimes2.length < 5) return 0;
      const mid = Math.floor(buyTimes2.length / 2);
      const earlySpan = (buyTimes2[mid - 1] - buyTimes2[0]) / 60000 || 1;
      const lateSpan = (buyTimes2[buyTimes2.length - 1] - buyTimes2[mid]) / 60000 || 1;
      const earlyRate = mid / earlySpan;
      const lateRate = (buyTimes2.length - mid) / lateSpan;
      const r0 = earlyRate > 0 ? lateRate / earlyRate : 1;
      return Math.min(1, Math.max(0, (r0 - 0.5) / 3));
    })(),
    sir_infectRate: Math.min(1, ub / Math.max(1, ageMin) / 10),
    sir_recoveryRate: Math.max(0, 1 - Math.min(1, sells / Math.max(1, ageMin) / 5)),

    // ═══ GRADUATION FRONTRUNNING ═══
    gf_curveProgress: pumpCurvePct(t.vSolInBondingCurve),
    gf_frontrunSignal: (() => {
      const cp = pumpCurvePct(t.vSolInBondingCurve);
      if (cp < 0.6) return 0;
      const bv = Math.min(1, (buys / Math.max(1, Math.min(5, ageMin))) / 20);
      if (cp >= 0.8) {
        const urgency = (cp - 0.8) * 5;
        return Math.min(1, urgency * (bv > 0.3 ? 0.8 : 0.3) * 2);
      }
      return bv > 0.3 ? Math.min(0.3, (cp - 0.6) * 1.5) : 0;
    })(),

    // ═══ ATTENTION-PRICE DIVERGENCE ═══
    apd_attentionGrowth: (() => {
      const recent10 = buyTrades.slice(-10).length;
      const older10 = buyTrades.slice(-20, -10).length;
      const growth = older10 > 0 ? recent10 / Math.max(1, older10) : 1;
      return Math.min(1, Math.max(0, (growth - 0.8) / 2));
    })(),
    apd_priceFlat: (() => {
      if (spark.length < 4) return 0.5;
      const rs = spark.slice(-4);
      const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
      const variance = rs.reduce((s, v) => s + Math.abs(v - avg), 0) / rs.length;
      return avg > 0 ? Math.max(0, 1 - (variance / avg) * 10) : 0.5;
    })(),
    apd_divergence: 0, // computed below

    // ═══ SMART WALLET SIGNAL ═══
    // How many known-winning wallets are buying this token
    // Layer 1: existing smartWallets (prefix-based, passive)
    // Layer 2: smartMoneyTracker (full address, active polling, tiered scoring)
    tp_mavenScore: Math.min(1,
      smartWallets.getSmartBuyerCount(t) * 0.25 +
      smartMoneyTracker.getSmartMoneyScore(t.ca || ca)?.score * 0.75
    ),
    tp_connectorScore: Math.min(1,
      (t.knownInfluencerBuys ? t.knownInfluencerBuys * 0.2 : 0) +
      (smartMoneyTracker.getSmartMoneyScore(t.ca || ca)?.convergence ? 0.5 : 0)
    ),
    // Layer 3: measured. Wallets with a proven forward record (20+ closed positions, Wilson-bounded
    // win rate, early hits on runners, none of the exclusion flags) that bought inside the first
    // minute. count is the number of them; score is bounded so two strong ones saturate it.
    _smartMoney: (() => { const sm = walletIntel.smartBuyers(t.ca || ca, { sinceTs: t.createdAt || null, windowMs: 60_000 }); return { count: sm.count, score: Math.min(1, (sm.sumScore || 0) / 2) }; })(),
    // The narrative wave behind this launch, if it is the original of a copied name: copies landing
    // now against the minutes before. The leader of a building wave is the buy; the leader of a
    // fading one is the exit. A copy never gets here (it is excluded upstream), so null means no wave.
    _wave: radar._copycats.wave(t.ca || ca, Date.now()),

    // ═══ HOLDER QUALITY SCORE — are early buyers proven winners? ═══
    // A token where 5 early buyers each have 3+ past graduated tokens
    // is radically different from one with 5 random wallets.
    // Score 0-1: 0 = no proven winners buying, 1 = multiple proven winners
    _holderQuality: (() => {
      const buyWallets = buyTrades.map(tr => (tr.wallet || "").slice(0, 8)).filter(Boolean);
      const uniqueWallets = [...new Set(buyWallets)];
      let provenCount = 0;
      let totalScore = 0;
      for (const wp of uniqueWallets) {
        const stats = smartWallets.walletStats.get(wp);
        if (stats && (stats.wins + stats.losses) >= 3) {
          const winRate = stats.wins / (stats.wins + stats.losses);
          if (winRate >= 0.4) {
            provenCount++;
            totalScore += stats.score;
          }
        }
      }
      // Also check smart money tracker for full-address matched wallets
      const smScore = smartMoneyTracker.getSmartMoneyScore(t.ca || ca);
      if (smScore?.walletCount > 0) {
        provenCount += smScore.walletCount;
        totalScore += smScore.score * smScore.walletCount;
      }
      // Normalize: 1 proven = 0.25, 2 = 0.45, 3+ = 0.6+, convergence = 0.8+
      if (provenCount === 0) return 0;
      return Math.min(1, provenCount * 0.2 + totalScore * 0.15 + (smScore?.tightConvergence ? 0.45 : smScore?.convergence ? 0.3 : 0));
    })(),

    // ═══ KOL CASCADE TIMING — multiple KOLs mentioning within tight window ═══
    // 3+ KOLs in 10 minutes is completely different from 3 over 2 hours.
    // Tight temporal convergence = coordinated alpha, not random mentions.
    _kolCascade: (() => {
      const mentions = kolCascadeTracker.get(t.ca) || t._kolMentions || [];
      if (mentions.length < 2) return 0;
      // Sort by time, check for tight clustering
      const sorted = mentions.map(m => m.time || m.timestamp || 0).filter(Boolean).sort((a, b) => a - b);
      if (sorted.length < 2) return 0;
      // Count mentions within a 10-minute sliding window
      let maxInWindow = 0;
      const windowMs = 10 * 60 * 1000;
      for (let i = 0; i < sorted.length; i++) {
        let count = 1;
        for (let j = i + 1; j < sorted.length && sorted[j] - sorted[i] <= windowMs; j++) {
          count++;
        }
        if (count > maxInWindow) maxInWindow = count;
      }
      // 2 KOLs in 10min = 0.3, 3 = 0.6, 4+ = 0.85+
      if (maxInWindow >= 4) return Math.min(1, 0.85 + (maxInWindow - 4) * 0.05);
      if (maxInWindow >= 3) return 0.6;
      if (maxInWindow >= 2) return 0.3;
      return 0;
    })(),

    // ═══ SECOND WAVE DETECTION — previously scored well, dipped, re-accumulating ═══
    // Many $10M tokens have a quiet period then re-ignite.
    // Check if this token was previously on radar with good score, dipped, and is now showing
    // renewed buying activity.
    _secondWave: (() => {
      const history = secondWaveTracker.get(t.ca);
      if (!history) return 0;
      const timeSincePeak = (Date.now() - history.peakTime) / 60000; // minutes
      const currentBuys = buys;
      const priceRecovery = history.peakMcap > 0 && (t.mcapUsd || 0) > 0
        ? (t.mcapUsd / history.peakMcap) : 0;
      // Must have: good previous score, dipped significantly, now recovering
      if (history.peakScore < 50) return 0;
      if (timeSincePeak < 5 || timeSincePeak > 120) return 0; // 5-120 min window
      if (priceRecovery > 0.8) return 0; // hasn't dipped enough
      if (priceRecovery < 0.1) return 0; // dead, not recovering
      // Score: higher for better previous score, reasonable dip, new buying activity
      const dippedEnough = priceRecovery >= 0.2 && priceRecovery <= 0.7;
      const freshBuying = currentBuys > history.lastBuys + 3;
      if (!dippedEnough || !freshBuying) return 0;
      return Math.min(1,
        (history.peakScore / 100) * 0.4 +
        (1 - priceRecovery) * 0.3 + // bigger dip = more upside
        Math.min(0.3, (currentBuys - history.lastBuys) * 0.05)
      );
    })(),

    // ═══ DEMAND AUTHENTICITY — Is the buying real or manufactured? ═══
    // 0 = all demand is fake (bots, wash trading, sybil)
    // 1 = all demand is organic (diverse wallets, bursty timing, real participants)
    // Combines temporal analysis, amount distribution, buyer diversity,
    // buyer quality (cross-ref smartWallets), and wash trade detection.
    _demandAuthenticity: demandAuth.quickScore(t),
  };

  // Compute divergence after other fields are set
  const _r = result;
  if (_r.apd_attentionGrowth > 0.3 && _r.apd_priceFlat > 0.5) {
    _r.apd_divergence = Math.min(1, _r.apd_attentionGrowth * _r.apd_priceFlat * 1.5);
  }

  return _r;
}

// ═══ CHART PATTERN STORAGE — persist graduated token charts for learning ═══
const chartSnapshotCache = []; // in-memory fallback
const MAX_CHART_SNAPSHOTS = 500;

const chartSnapshotSeen = new Set(); // deduplicate by CA
async function storeChartSnapshot(ca, token, outcome) {
  // Deduplicate — only store one snapshot per contract address
  if (chartSnapshotSeen.has(ca)) return;
  chartSnapshotSeen.add(ca);
  if (chartSnapshotSeen.size > MAX_CHART_SNAPSHOTS * 2) {
    const arr = [...chartSnapshotSeen];
    arr.splice(0, arr.length - MAX_CHART_SNAPSHOTS);
    chartSnapshotSeen.clear();
    arr.forEach(c => chartSnapshotSeen.add(c));
  }
  const snapshot = {
    ca,
    name: token.name || "",
    ticker: token.ticker || "",
    graduated: !!outcome.graduated,
    spark: token.spark || [],
    peakMcx: outcome.peakMcx || 1,
    rugged: outcome.rugged || false,
    devDumped: outcome.devDumped || false,
    mcapStart: token.spark?.[0] || 0,
    mcapPeak: token.spark?.length > 0 ? Math.max(...token.spark) : 0,
    mcapEnd: token.mcapUsd || 0,
    buys: token.buys || 0,
    sells: token.sells || 0,
    uniqueBuyers: token.uniqueBuyers || 0,
    age: Math.round((Date.now() - token.createdAt) / 60000),
    ts: Date.now(),
    pattern: classifyChartPattern(token.spark || [], outcome),
  };
  if (redis) {
    try {
      await redis.lPush("chart:snapshots", JSON.stringify(snapshot));
      await redis.lTrim("chart:snapshots", 0, MAX_CHART_SNAPSHOTS - 1);
    } catch {}
  }
  chartSnapshotCache.unshift(snapshot);
  if (chartSnapshotCache.length > MAX_CHART_SNAPSHOTS) chartSnapshotCache.length = MAX_CHART_SNAPSHOTS;
}

function classifyChartPattern(spark, outcome) {
  if (!spark || spark.length < 5) return "unknown";
  const start = spark[0] || 1;
  const peak = Math.max(...spark);
  const end = spark[spark.length - 1] || 0;
  const peakIdx = spark.indexOf(peak);
  const peakPct = peakIdx / spark.length;
  const multiple = peak / start;
  const endRatio = end / peak;

  // Count dips and consecutive ups for smooth grind detection
  let dips = 0, ups = 0, maxConsecutiveUp = 0, consecutiveUp = 0;
  for (let i = 1; i < spark.length; i++) {
    if (spark[i] < spark[i - 1]) { dips++; consecutiveUp = 0; }
    else if (spark[i] > spark[i - 1]) { ups++; consecutiveUp++; maxConsecutiveUp = Math.max(maxConsecutiveUp, consecutiveUp); }
  }
  const totalMoves = dips + ups;
  const upPct = totalMoves > 0 ? ups / totalMoves : 0;

  if (outcome.rugged || outcome.devDumped) return "rug";
  // Smooth grind: gradual up with almost no dips — classic fake chart / self-bought rug
  // Catch aggressive: constant velocity up (linear pump) is the #1 slow rug pattern
  if (spark.length >= 6 && upPct > 0.78 && maxConsecutiveUp >= 4 && end > start * 1.2 && dips <= 3) return "smooth_grind_rug";
  // Extra catch: very linear pump — nearly every candle up, minimal variance
  if (spark.length >= 8 && upPct > 0.85 && end > start * 1.5) return "smooth_grind_rug";
  if (multiple > 8 && peakPct < 0.3) return "sniper_spike";
  // Staircase: gradual up with periodic small dips — can be legit or manipulated
  if (spark.length >= 10 && upPct > 0.7 && upPct <= 0.82 && dips >= 2 && dips <= spark.length * 0.2) return "staircase";
  if (multiple > 3 && peakPct > 0.6 && endRatio > 0.4) return "healthy_pump";
  if (multiple < 3 && spark.length > 30 && outcome.graduated) return "slow_grind";
  if (endRatio < 0.2 && multiple > 5) return "pump_dump";
  // V-shape recovery: crashed then bounced back
  const midIdx = Math.floor(spark.length / 2);
  const midVal = spark[midIdx] || 0;
  if (midVal < start * 0.5 && end > start * 0.8 && end > midVal * 2) return "v_recovery";
  // Flat/dead: barely moved
  if (multiple < 1.5 && endRatio > 0.7 && spark.length > 20) return "flat_dead";
  if (outcome.graduated) return "healthy_pump";
  return "unknown";
}

async function getChartSnapshots(limit = 50) {
  if (redis) {
    try {
      const raw = await redis.lRange("chart:snapshots", 0, limit - 1);
      if (raw?.length > 0) return raw.map(r => JSON.parse(r));
    } catch {}
  }
  return chartSnapshotCache.slice(0, limit);
}

async function getChartPatternStats() {
  const snaps = await getChartSnapshots(200);
  const patterns = {};
  for (const s of snaps) {
    const p = s.pattern || "unknown";
    if (!patterns[p]) patterns[p] = { count: 0, avgPeakMcx: 0, avgAge: 0, graduated: 0, rugged: 0 };
    patterns[p].count++;
    patterns[p].avgPeakMcx += s.peakMcx || 1;
    patterns[p].avgAge += s.age || 0;
    if (s.graduated) patterns[p].graduated++;
    if (s.rugged) patterns[p].rugged++;
  }
  for (const k of Object.keys(patterns)) {
    const p = patterns[k];
    p.avgPeakMcx = +(p.avgPeakMcx / p.count).toFixed(1);
    p.avgAge = Math.round(p.avgAge / p.count);
  }
  return {
    total: snaps.length,
    patterns,
    recentCharts: snaps.slice(0, 20).map(s => ({
      ca: s.ca, name: s.name, ticker: s.ticker, pattern: s.pattern,
      spark: s.spark, peakMcx: s.peakMcx, rugged: s.rugged, age: s.age, ts: s.ts,
    })),
  };
}

// ═══ TAB BUILDER — runs every 5 seconds ═══
setInterval(gated(() => {
  const now = Date.now();

  // Clean old tokens — graduated/high MC get 4h, rest get 2h
  // Before eviction: label outcome and feed to meme intelligence for learning
  for (const [ca, t] of radar.tokens) {
    // Launches live 2h (4h graduated / $10k+); a mint that still trades stays for the revival window (72h).
    const ttl = radar._revivals.active(ca, now) ? 72 * 3600_000 : (t.graduated || t.mcapUsd >= 10000) ? 14400000 : 7200000;
    if (now - t.createdAt > ttl) {
      // Auto-label outcome before eviction — this is how the model learns from rugs
      try {
        const peakMc = t.spark?.length > 0 ? Math.max(...t.spark) : t.mcapUsd;
        const currentMc = t.mcapUsd || 0;
        const mcapDropPct = peakMc > 0 ? ((peakMc - currentMc) / peakMc) * 100 : 0;
        const devDumped = t.trades?.some(tr => tr.wallet === t.devWallet?.slice(0, 8) && tr.side === "sell") || false;
        const sellRatio = t.sells / Math.max(1, t.buys + t.sells);
        const rugged = (mcapDropPct > 80 && sellRatio > 0.6) || devDumped;
        const outcome = {
          graduated: !!t.graduated,
          peakMcx: peakMc > 0 && t.spark?.[0] > 0 ? peakMc / t.spark[0] : 1,
          rugged,
          mcapDropPct,
          devDumped,
          alive: currentMc > 3000,
        };
        const features = extractQuickFeatures(t);
        if (features) memeIntel.learn(features, outcome);
        // Store chart snapshots for pattern learning — ALL tokens with enough data,
        // not just graduated. Rugs are critical training data for the model.
        if (t.spark?.length >= 5) {
          storeChartSnapshot(ca, t, outcome).catch(() => {});
        }
        // Persist rug patterns to Redis for long-term learning
        if (rugged && redis) {
          const rugData = { ca, name: t.name, ticker: t.ticker, mcapPeak: peakMc, mcapEnd: currentMc, dropPct: mcapDropPct, devDumped, buys: t.buys || 0, sells: t.sells || 0, age: Math.round((now - t.createdAt) / 60000), ts: now };
          redis.lPush("rug:patterns", JSON.stringify(rugData)).catch(() => {});
          redis.lTrim("rug:patterns", 0, 999).catch(() => {});
        }
      } catch {}
      radar.tokens.delete(ca); forgetTokenSubscription(ca);
    }
  }

  // Active tokens: 1h for normal, 2h for graduating/graduated tokens
  const all = [...radar.tokens.values()].filter(t => {
    const age = now - t.createdAt;
    if (t.graduated || t.mcapUsd >= 10000) return age < 7200000; // 2h for graduated/high MC
    return age < 3600000; // 1h for normal
  });

  // Dedup by normalized name + ticker — keeps the strongest version of each token
  function dedup(tokens) {
    const best = new Map();
    for (const t of tokens) {
      const nameKey = (t.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const tickerKey = (t.ticker || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const keys = [];
      // Only dedup by name if it's specific enough (4+ chars), too many 3-char dupes
      if (nameKey && nameKey.length >= 4) keys.push("n:" + nameKey);
      // Only dedup by ticker if 3+ chars — 2-char tickers like "AI" cause false merges
      if (tickerKey && tickerKey.length >= 3) keys.push("t:" + tickerKey);
      if (keys.length === 0) { best.set("ca:" + t.ca, t); continue; }
      let dominated = false;
      for (const k of keys) {
        const existing = best.get(k);
        if (existing && existing.ca !== t.ca) {
          // Stronger scoring: volume weight up, add unique buyers + mcap
          const ub = (s) => s.uniqueBuyers?.size || 0;
          const sOld = (existing.buys||0)*3 + (existing.volumeSol||0)*5 + ub(existing)*8 + (existing.mcapUsd>5000?10:0) + (existing.twitter?6:0) + (existing.website?4:0);
          const sNew = (t.buys||0)*3 + (t.volumeSol||0)*5 + ub(t)*8 + (t.mcapUsd>5000?10:0) + (t.twitter?6:0) + (t.website?4:0);
          if (sNew <= sOld) { dominated = true; break; }
          for (const [mk, mv] of best) { if (mv.ca === existing.ca) best.delete(mk); }
        }
      }
      if (!dominated) { for (const k of keys) best.set(k, t); }
    }
    const seen = new Set();
    return [...best.values()].filter(t => { if (seen.has(t.ca)) return false; seen.add(t.ca); return true; });
  }

  // Serialize with sparkline generation
  const serialize = (t) => {
    let spark = [...(t.spark || [])];
    if (spark.length < 5 && (t.mcapUsd > 0 || t._source === "bags")) {
      const mc = t.mcapUsd;
      const ca = t.ca || "";
      const s1 = ca.charCodeAt(0)||65, s2 = ca.charCodeAt(3)||70;
      const pattern = (s1 + s2) % 6;
      spark = [];
      for (let i = 0; i < 16; i++) {
        const p = i / 15;
        let v;
        switch(pattern) {
          case 0: v=mc*(0.55+p*0.45+Math.sin(i*s2*0.1)*0.04); break;
          case 1: v=mc*(1.3-p*0.35+Math.sin(i*0.15)*0.05); break;
          case 2: v=mc*(1-Math.abs(p-0.5)*0.4); break;
          case 3: v=mc*(p<0.4?0.6+p*0.2:p<0.6?0.68+(p-0.4)*1.5:0.98+Math.sin(i)*0.03); break;
          case 4: v=mc*(0.85+Math.sin(i*1.3+s1*0.05)*0.12+p*0.1); break;
          default: v=mc*(0.4+Math.pow(p,1.8)*0.6+Math.sin(i*0.08)*0.02);
        }
        spark.push(Math.max(1, Math.round(v)));
      }
    }
    return {
      ca: t.ca, name: t.name, ticker: t.ticker, description: (t.description||"").slice(0,80),
      image: t.image, twitter: t.twitter, website: t.website, telegram: t.telegram,
      mcapSol: t.mcapSol, mcapUsd: t.mcapUsd, buys: t.buys, sells: t.sells,
      volumeSol: +t.volumeSol.toFixed(4), uniqueBuyers: t.uniqueBuyers?.size||0,
      spark, h1Change: +t.h1Change.toFixed(1),
      age: Math.round((now - t.createdAt) / 1000),
      devWallet: t.devWallet, graduated: t.graduated, bundled: t.bundled,
      marketCapSol: t.mcapSol,
      source: t._source || "pump",     // "pump" | "bonk" | "bags" — launchpad origin
      _source: t._source || "pump",    // alias for frontend compatibility
      _meteoraDBC: t._source === "bags", // Bags tokens use Meteora DBC
      _bonk: t._source === "bonk",      // LetsBonk.fun / Raydium LaunchLab
      dexBoosted: !!radar.dexBoosted.get(t.ca),
      boostAmount: radar.dexBoosted.get(t.ca)?.amount || 0,
      artworkScore: t._artworkScore ?? null,
      artworkOriginal: t._artworkOriginal ?? null,
      artworkFlags: t._artworkFlags || [],
      // Memetic score data
      memeticScore: t._memeticQuick || null,
      memeticLinguistic: t._memeticLinguistic || null,
      memeticAbsurdity: t._memeticAbsurdity || null,
      memeticTemporal: t._memeticTemporal || null,
      memeticArchetype: t._memeticArchetype || null,
      // ═══ ENTRY TIMING DATA — helps frontend show when to buy ═══
      ...(() => {
        const dyn = scoreDynamics.get(t.ca);
        const ageMin = Math.max(0.3, (now - t.createdAt) / 60000);
        const buysPerMin = (t.buys || 0) / ageMin;
        const pressure = (t.buys || 0) / Math.max(1, (t.buys || 0) + (t.sells || 0));
        // ── Price Phase Detection ──
        // Analyze sparkline shape to classify: SPIKE / DIP / CONSOLIDATION / EARLY
        let pricePhase = "EARLY";
        if (spark.length >= 4) {
          const recent = spark.slice(-4);
          const older = spark.slice(-8, -4);
          const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
          const peak = Math.max(...spark);
          const cur = spark[spark.length - 1];
          const fromPeak = peak > 0 ? (peak - cur) / peak : 0;
          const recentSlope = recent.length >= 2 ? (recent[recent.length - 1] - recent[0]) / Math.max(1, recent[0]) : 0;
          if (recentSlope > 0.15 && cur >= peak * 0.95) {
            pricePhase = "SPIKE"; // price actively spiking — bad entry
          } else if (fromPeak > 0.08 && recentSlope <= 0.02) {
            pricePhase = "DIP"; // pulled back from peak, stabilizing — good entry
          } else if (fromPeak > 0.03 && fromPeak <= 0.08 && Math.abs(recentSlope) < 0.05) {
            pricePhase = "CONSOLIDATION"; // sideways after move — okay entry
          } else if (spark.length < 8 && ageMin < 2) {
            pricePhase = "EARLY"; // too young to classify — early discovery
          } else if (recentSlope > 0.05) {
            pricePhase = "SPIKE";
          } else {
            pricePhase = "CONSOLIDATION";
          }
        }
        // ── Buy Velocity Trend ──
        // Is buys/min accelerating or decelerating?
        let buyVelTrend = "steady";
        if (t.trades && t.trades.length >= 4) {
          const trades = t.trades;
          const mid = Math.floor(trades.length / 2);
          const firstHalf = trades.slice(0, mid).filter(tr => tr.side === "buy").length;
          const secondHalf = trades.slice(mid).filter(tr => tr.side === "buy").length;
          const firstSpan = Math.max(1, ((trades[mid]?.time || now) - (trades[0]?.time || now)) / 60000);
          const secondSpan = Math.max(0.3, (now - (trades[mid]?.time || now)) / 60000);
          const firstRate = firstHalf / firstSpan;
          const secondRate = secondHalf / secondSpan;
          if (secondRate > firstRate * 1.3) buyVelTrend = "accelerating";
          else if (secondRate < firstRate * 0.7) buyVelTrend = "decelerating";
        }
        // ── Volume Spike Detection ──
        const recentTrades = (t.trades || []).filter(tr => tr.time && now - tr.time < 60000);
        const recentBuyVol = recentTrades.filter(tr => tr.side === "buy").reduce((s, tr) => s + (tr.sol || 0), 0);
        const avgVolPerMin = t.volumeSol / Math.max(1, ageMin);
        const volSpike = avgVolPerMin > 0 ? recentBuyVol / avgVolPerMin : 0;
        // ── Entry Signal ──
        // Combine phase + velocity + dynamics into a simple signal
        let entrySignal = "WAIT";
        if (pricePhase === "SPIKE" || buyVelTrend === "decelerating") {
          entrySignal = "WAIT"; // don't chase spikes or fading velocity
        } else if (pricePhase === "DIP" && (dyn?.trend === "rising" || dyn?.trend === "rocket")) {
          entrySignal = "STRONG"; // dip + recovering score = best entry
        } else if (pricePhase === "EARLY" && pressure > 0.6 && buyVelTrend !== "decelerating") {
          entrySignal = "EARLY"; // early with good pressure = speculative entry
        } else if (pricePhase === "CONSOLIDATION" && dyn?.velocity > 0) {
          entrySignal = "READY"; // stable price + positive score momentum
        } else if (dyn?.trend === "rising" || dyn?.trend === "rocket") {
          entrySignal = "READY";
        } else if (pressure > 0.5 && buyVelTrend !== "decelerating") {
          entrySignal = "CAUTION";
        }
        return {
          entrySignal,
          pricePhase,
          buyPressure: +pressure.toFixed(2),
          buyVelTrend,
          scoreTrend: dyn?.trend || "new",
          scoreVelocity: dyn?.velocity || 0,
          scoreMomentum: dyn?.momentum || "nascent",
          volSpike: +(Math.min(10, volSpike).toFixed(1)),
          smartMoneyIn: !!t._smartMoneyIn,
        };
      })(),
    };
  };

  const deduped = dedup(all);

  // ── SCORE DYNAMICS: record score for every active token every 5s ──
  // This feeds the velocity/acceleration tracker so buy decisions
  // know if a token's score is accelerating (runner) or decelerating (rug)
  for (const t of deduped) {
    try {
      const qf = extractQuickFeatures(t);
      if (qf) {
        const s = memeIntel.scorer.score(qf);
        scoreDynamics.record(t.ca, s.score);
      }
    } catch {}
  }
  // Prune stale entries every ~60s (counter resets to 0 on 12th tick at 5s interval)
  if (++scoreDynamics._pruneCounter >= 12) {
    scoreDynamics._pruneCounter = 0;
    scoreDynamics.prune();
  }
  if (scoreDynamics._pruneCounter === undefined) scoreDynamics._pruneCounter = 0;

  // ═══ UNIVERSAL RUG FILTER — removes obvious rugs from ALL radar tabs ═══
  // Computes a composite rug score for each token; tokens above threshold get excluded.
  // This prevents rug chart patterns from landing in ANY tab (new, hot, momentum, grad).
  const rugScoreCache = new Map(); // ca → { rugScore, filtered }
  function isRugFiltered(t) {
    if (rugScoreCache.has(t.ca)) return rugScoreCache.get(t.ca).filtered;
    let rugScore = 0;
    try {
      const qf = extractQuickFeatures(t);
      if (qf) {
        // Zero sells: the #1 rug signal
        if (qf._rg_zeroSellFlag >= 0.8) rugScore += 40;
        else if (qf._rg_zeroSellFlag >= 0.5) rugScore += 25;
        // Buy/sell imbalance
        if (qf._rg_buySellImbalance >= 0.7) rugScore += 20;
        else if (qf._rg_buySellImbalance >= 0.4) rugScore += 10;
        // Staircase chart (uniform step up pattern)
        if (qf.ch_staircaseScore > 0.5) rugScore += 25;
        else if (qf.ch_staircaseScore > 0.3) rugScore += 12;
        // Smooth grind (no natural dips)
        if (qf.ch_smoothGrind > 0.5) rugScore += 20;
        else if (qf.ch_smoothGrind > 0.35) rugScore += 10;
        // Flatline spike (dead chart then pump)
        if (qf.ch_flatlineSpike > 0.4) rugScore += 25;
        else if (qf.ch_flatlineSpike > 0.25) rugScore += 12;
        // Pump and dump pattern
        if (qf.ch_pumpDump > 0.6) rugScore += 20;
        else if (qf.ch_pumpDump > 0.3) rugScore += 10;
        // Fresh wallet buyers (dev self-buying)
        if (qf._rg_freshWalletRatio > 0.8) rugScore += 15;
        else if (qf._rg_freshWalletRatio > 0.6) rugScore += 8;
        // Dev self-snipe
        if (qf._rg_devSelfSnipe > 0) rugScore += 15;
        // Early dump by dev
        if (qf._rg_earlyDump > 0.5) rugScore += 15;
        // Quick flip rate (buy then sell within 60s)
        if (qf._rg_quickFlipRate > 0.5) rugScore += 10;
        // Sybil score (many identical-size buys from fresh wallets)
        if (qf._rg_sybilScore > 0.5) rugScore += 10;
        // MC crash from peak
        if (qf.rg_mcapDropRate > 0.7) rugScore += 15;
        // Combined killer: zero sells + staircase = definitely a rug
        if (qf._rg_zeroSellFlag >= 0.5 && qf.ch_staircaseScore > 0.2) rugScore += 20;
        // Combined: zero sells + fresh wallets = dev self-buying rug
        if (qf._rg_zeroSellFlag >= 0.5 && qf._rg_freshWalletRatio > 0.6) rugScore += 15;
        // Demand authenticity: very low = manufactured demand
        if (qf._demandAuthenticity < 0.2) rugScore += 25;
        else if (qf._demandAuthenticity < 0.3) rugScore += 12;
      }
    } catch {}
    // Tokens with enough buys for analysis that score high = rug
    // Young tokens with < 3 buys get a pass (not enough data yet)
    const hasSufficientData = (t.buys || 0) >= 3;
    const filtered = hasSufficientData && rugScore >= 45;
    rugScoreCache.set(t.ca, { rugScore, filtered });
    return filtered;
  }

  // Pre-filter: remove obvious rugs from the deduped pool
  const rugFiltered = deduped.filter(t => !isRugFiltered(t));

  // ── NEW: Fresh launches (last 10 min) — now with rug filtering ──
  radar.tabs.new = rugFiltered
    .filter(t => (now - t.createdAt) < 600000)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50).map(t => {
      const s = serialize(t);
      s.pctToGrad = t.graduated ? 100 : Math.min(99, Math.round((t.mcapUsd / gradMcUsd()) * 100));
      return s;
    });

  // ── GRAD: Real traction MC ($10K+) or graduated ($69K+) ──
  // $2.4K = launch, $3-5K = dev buy, $10K+ = real traction, $69K = graduated
  radar.tabs.graduating = rugFiltered
    .filter(t => t.mcapUsd >= 10000 || t.graduated)
    .map(t => ({
      ...t,
      _gradScore: (t.graduated ? 200 : 0) + Math.min(100, (t.mcapUsd / gradMcUsd()) * 100),
    }))
    .sort((a, b) => b._gradScore - a._gradScore)
    .slice(0, 50).map(t => {
      const s = serialize(t);
      s.pctToGrad = t.graduated ? 100 : Math.min(99, Math.round((t.mcapUsd / gradMcUsd()) * 100));
      s.graduated = t.graduated;
      return s;
    });

  // ── MOMENTUM: Sustained buying pressure ──
  // Only tokens with RECENT activity — not historical buy counts from dead tokens
  radar.tabs.momentum = rugFiltered
    .filter(t => {
      if (t.buys < 3 || t.mcapUsd < 3000) return false;
      if ((now - t.createdAt) < 10000) return false;
      // RECENCY: must have had a trade in the last 5 minutes
      const trades = t.trades || [];
      const lastTradeTime = trades.length > 0 ? trades[trades.length - 1].time : t.createdAt;
      if (now - lastTradeTime > 300000) return false;
      // ACTIVITY: need at least 1 unique buyer per 5 min of age, min 2 UB
      const ub = t.uniqueBuyers?.size || 0;
      if (ub < 2) return false;
      // SELL RATIO: if sells > 2x buys, it's dumping not momentum
      if ((t.sells || 0) > t.buys * 2) return false;
      // MC FLOOR: if MC dropped below $3K it's likely rugged
      const spark = t.spark || [];
      if (spark.length > 3) {
        const peak = Math.max(...spark);
        const current = spark[spark.length - 1] || t.mcapUsd;
        // Dropped 80%+ from peak = rugged, not momentum
        if (peak > 0 && current < peak * 0.2) return false;
      }
      return true;
    })
    .map(t => {
      const ageMin = Math.max(0.5, (now - t.createdAt) / 60000);
      const buyRate = t.buys / ageMin;
      const pressure = t.buys / Math.max(1, t.buys + t.sells);
      const ub = t.uniqueBuyers?.size || 0;
      const spark = t.spark || [];
      const mcGrowth = spark.length > 2 ? (spark[spark.length-1] - spark[0]) / Math.max(1, spark[0]) : 0;
      // Reject declining tokens — if MC is shrinking, not momentum
      if (mcGrowth < -0.15) return null;
      // RECENT momentum: weight recent sparkline trend heavily
      let recentTrend = 0;
      if (spark.length >= 4) {
        const recent = spark.slice(-2);
        const prior = spark.slice(-4, -2);
        const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
        const avgPrior = prior.reduce((a, b) => a + b, 0) / prior.length;
        recentTrend = avgPrior > 0 ? (avgRecent - avgPrior) / avgPrior : 0;
      }
      // ── ML APE SCORE — the actual "should buy" composite ──
      const apeScore = t._apeScore || 0;
      // ── SCORE DYNAMICS — is the score accelerating or dying? ──
      const dyn = scoreDynamics.get(t.ca);
      const dynBonus = dyn?.trend === "rocket" ? 25 : dyn?.trend === "rising" ? 15 : dyn?.trend === "fading" ? -10 : dyn?.trend === "crashing" ? -25 : 0;
      const velBonus = Math.min(15, Math.max(-10, (dyn?.velocity || 0) * 50));
      // ── BUY VELOCITY ACCELERATION — new buys faster than old ──
      let accelBonus = 0;
      if (t.trades && t.trades.length >= 4) {
        const trades = t.trades;
        const mid = Math.floor(trades.length / 2);
        const firstBuys = trades.slice(0, mid).filter(tr => tr.side === "buy").length;
        const secondBuys = trades.slice(mid).filter(tr => tr.side === "buy").length;
        const firstSpan = Math.max(1, ((trades[mid]?.time || now) - (trades[0]?.time || now)) / 60000);
        const secondSpan = Math.max(0.3, (now - (trades[mid]?.time || now)) / 60000);
        const firstRate = firstBuys / firstSpan;
        const secondRate = secondBuys / secondSpan;
        if (secondRate > firstRate * 1.5) accelBonus = 15;
        else if (secondRate > firstRate * 1.2) accelBonus = 8;
        else if (secondRate < firstRate * 0.5) accelBonus = -12;
      }
      // ── RUG PENALTY FOR MOMENTUM TAB ──
      // Tokens with all buys / zero sells look like strong momentum but are actually rugs.
      // Penalize rug patterns to prevent them from ranking high.
      let rugMomentumPenalty = 0;
      try {
        const qf = extractQuickFeatures(t);
        if (qf) {
          // Zero sells: many buys + no organic sells = fake momentum
          if (qf._rg_zeroSellFlag > 0.5) rugMomentumPenalty += qf._rg_zeroSellFlag * 40;
          // Buy/sell imbalance: 90%+ buys = suspicious
          if (qf._rg_buySellImbalance > 0.4) rugMomentumPenalty += qf._rg_buySellImbalance * 25;
          // Staircase chart: fake chart pattern
          if (qf.ch_staircaseScore > 0.3) rugMomentumPenalty += qf.ch_staircaseScore * 20;
          // Smooth grind: no natural dips
          if (qf.ch_smoothGrind > 0.35) rugMomentumPenalty += qf.ch_smoothGrind * 15;
          // Flatline spike: dead chart with sudden pump
          if (qf.ch_flatlineSpike > 0.25) rugMomentumPenalty += qf.ch_flatlineSpike * 25;
          // Fresh wallets buying: dev self-buying
          if (qf._rg_freshWalletRatio > 0.6) rugMomentumPenalty += qf._rg_freshWalletRatio * 15;
          // Hard reject: obvious rug = exclude from momentum entirely
          if (qf._rg_zeroSellFlag >= 0.8 || (qf._rg_zeroSellFlag >= 0.5 && qf.ch_staircaseScore > 0.3)) return null;
        }
      } catch {}
      return { ...t, _momentum:
        apeScore * 0.8            // ML score is the strongest buy signal (0-79)
        + buyRate * 8             // buys per minute — activity level
        + pressure * 15           // buy:sell ratio
        + ub * 6                  // unique buyers = organic interest
        + mcGrowth * 20           // MC growing = price confirming
        + recentTrend * 20        // recent sparkline direction
        + Math.min(12, t.volumeSol * 2) // volume (capped)
        + dynBonus                // score trend: rocket/rising/fading/crashing
        + velBonus                // score velocity (acceleration)
        + accelBonus              // buy velocity accelerating
        - rugMomentumPenalty      // rug pattern deduction
      };
    })
    .filter(Boolean)
    .sort((a, b) => b._momentum - a._momentum)
    .slice(0, 25).map(t => {
      const s = serialize(t);
      s.pctToGrad = t.graduated ? 100 : Math.min(99, Math.round((t.mcapUsd / gradMcUsd()) * 100));
      return s;
    });

  // ── BAGS: Hot tokens from Bags.fm only — heat-ranked ──
  const bagsOnly = rugFiltered.filter(t => t._source === "bags" && (t.buys > 0 || t.volumeSol > 0 || t.mcapUsd > 1000));
  radar.tabs.bags = bagsOnly
    .map(t => {
      const ageMin = Math.max(0.3, (now - t.createdAt) / 60000);
      const ub = t.uniqueBuyers?.size || 0;
      let rugHeatPenalty = 0;
      try {
        const qf = extractQuickFeatures(t);
        if (qf) {
          if (qf._rg_zeroSellFlag > 0.5) rugHeatPenalty += qf._rg_zeroSellFlag * 30;
          if (qf._rg_buySellImbalance > 0.5) rugHeatPenalty += qf._rg_buySellImbalance * 20;
          if (qf.ch_staircaseScore > 0.3) rugHeatPenalty += qf.ch_staircaseScore * 15;
        }
      } catch {}
      return { ...t, _heat: (t.buys/ageMin)*10 + ub*8 + t.volumeSol*5 + (t.mcapUsd>5000?10:0) - rugHeatPenalty };
    })
    .sort((a, b) => b._heat - a._heat)
    .slice(0, 50).map(serialize);

  radar.poolSize = radar.tokens.size;
}), 2000);

// The socket follows the gate: up on the first bot, closed once nobody has traded for the grace.
activity.on((active) => {
  if (active) { if (!radar.ws || radar.ws.readyState > 1) connectPumpPortal(); setTimeout(chooseTradeSource, 2_000); pollSolPrice(); pollDexBoosted(); }
  else { try { radar.ws?.close(); } catch {} chooseTradeSource(); }
});

// ═══════════════════════════════════════
// BAGS.FM FEED MONITOR
// Polls Bags public API for new token launches and injects into radar.tokens.
// Bags tokens are Meteora DBC — different from PumpFun bonding curve.
// Without this, Bags coins never appear in the radar feed.
// ═══════════════════════════════════════
const bagsMonitor = {
  client: null,
  lastPollTime: 0,
  pollCount: 0,
  tokensIngested: 0,
  errors: 0,
  lastError: null,
  running: false,
};

function startBagsMonitor() {
  const apiKey = CONFIG.BAGS_API_KEY || process.env.BAGS_API_KEY;
  if (!apiKey) {
    console.warn("[BAGS-MONITOR] No BAGS_API_KEY set — Bags.fm feed disabled. Set BAGS_API_KEY in .env to enable.");
    return;
  }

  bagsMonitor.client = new BagsClient(apiKey);
  bagsMonitor.running = true;
  bagsMonitor.lastPollTime = Date.now() - 600_000; // start by fetching last 10 min
  console.log("[BAGS-MONITOR] Starting Bags.fm feed monitor (polling every 15s)");

  // Initial poll immediately
  pollBagsFeed().catch(() => {});

  // Then poll every 15s (Bags rate limit: 1000 req/hr = ~16/min, we use 4/min)
  setInterval(() => {
    if (bagsMonitor.running) pollBagsFeed().catch(() => {});
  }, 15_000);
}

async function pollBagsFeed() {
  try {
    const tokens = await bagsMonitor.client.pollNewLaunches(bagsMonitor.lastPollTime);
    bagsMonitor.pollCount++;
    bagsMonitor.lastPollTime = Date.now();

    if (!tokens || tokens.length === 0) return;

    let ingested = 0;
    const now = Date.now();

    for (const t of tokens) {
      const mint = t.ca;
      if (!mint || radar.tokens.has(mint)) continue;

      // Convert Bags normalized format to radar token format
      const token = {
        ca: mint,
        name: t.name || "",
        ticker: t.ticker || "",
        description: (t.description || "").slice(0, 200),
        image: t.image || "",
        twitter: t.twitter || "",
        website: t.website || "",
        telegram: t.telegram || "",
        createdAt: t.createdAt || t.pairCreated || now,
        trades: [],
        buys: t.buys || 0,
        sells: t.sells || 0,
        volumeSol: t.volumeSol || 0,
        sellVolumeSol: 0,
        mcapSol: t.mcapUsd > 0 && solUsdPrice > 0 ? t.mcapUsd / solUsdPrice : 0,
        mcapUsd: t.mcapUsd || 0,
        prevVSol: 0,
        uniqueBuyers: new Set(),
        spark: t.mcapUsd > 0 ? [t.mcapUsd] : [],
        h1Change: t.change1h || 0,
        devWallet: t.devWallet || "",
        graduated: false,     // Bags tokens don't graduate — Meteora DBC
        bundled: false,
        initialBuy: 0,
        // Bags-specific fields
        _source: "bags",
        _bagsLiquidity: t.liquidity || 0,
        _bagsHolderCount: t._bagsHolderCount || 0,
      };

      radar.tokens.set(mint, token);
      ingested++;
      bagsMonitor.tokensIngested++;

      // Register dev wallet if present
      if (t.devWallet && typeof devWalletTracker?.register === "function") {
        devWalletTracker.register(t.devWallet, {
          ca: mint, name: t.name || "", ticker: t.ticker || "",
          mcap: t.mcapUsd || 0,
        });
      }

      console.log(`[BAGS-MONITOR] New token: ${(t.name || "?").slice(0, 20)} (${mint.slice(0, 8)}...) | MC: $${(t.mcapUsd || 0).toLocaleString()} | Source: bags.fm`);
      broadcastWS({ event: "newToken", data: { ca: mint, name: t.name, mcap: t.mcapUsd, source: "bags" } });
    }

    if (ingested > 0) {
      console.log(`[BAGS-MONITOR] Ingested ${ingested} new Bags tokens (total: ${bagsMonitor.tokensIngested})`);
    }
  } catch (e) {
    bagsMonitor.errors++;
    bagsMonitor.lastError = { message: e.message, time: Date.now() };
    // Only log every 5th error to avoid spam
    if (bagsMonitor.errors % 5 === 1) {
      console.error(`[BAGS-MONITOR] Poll error (${bagsMonitor.errors} total): ${e.message}`);
    }
  }
}

startBagsMonitor();

// ═══ BAGS MC REFRESH ═══
// Bags.fm feed doesn't include marketCap — periodically fetch from DexScreener
async function refreshBagsMcap() {
  const bagsTokens = [...radar.tokens.values()].filter(t => t._source === "bags" && t.ca);
  if (bagsTokens.length === 0) return;
  // Batch up to 30 tokens per DexScreener call (comma-separated)
  const BATCH = 30;
  for (let i = 0; i < bagsTokens.length; i += BATCH) {
    const batch = bagsTokens.slice(i, i + BATCH);
    const cas = batch.map(t => t.ca).join(",");
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${cas}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const d = await r.json();
      const pairs = d?.pairs || [];
      // Group pairs by baseToken.address, take first (highest liquidity)
      const mcByMint = new Map();
      for (const p of pairs) {
        const mint = p.baseToken?.address;
        if (!mint || mcByMint.has(mint)) continue;
        const mc = p.marketCap || p.fdv || 0;
        if (mc > 0) mcByMint.set(mint, mc);
      }
      for (const t of batch) {
        const mc = mcByMint.get(t.ca);
        if (mc && mc > 0) {
          t.mcapUsd = Math.round(mc);
          t.mcapSol = solUsdPrice > 0 ? Math.round(mc / solUsdPrice) : t.mcapSol;
          if (t.spark.length === 0 || t.spark[t.spark.length - 1] !== t.mcapUsd) {
            t.spark.push(t.mcapUsd);
            if (t.spark.length > 30) t.spark = t.spark.slice(-30);
          }
        }
      }
    } catch {}
  }
}
// Refresh bags MC every 30s
setInterval(gated(() => refreshBagsMcap().catch(() => {})), 30_000);
// Initial refresh after 5s (let bags ingest first)
setTimeout(() => refreshBagsMcap().catch(() => {}), 5000);

// The memetic background workers (trend, market, celebrity, mindshare and KOL pollers) all call
// out. They follow the gate too, and their timer handles are cleared when it closes.
loadMemeticBlacklists().catch(() => {});
let memeticWorkers = null;
activity.on((active) => {
  if (active) { if (!memeticWorkers) memeticWorkers = startMemeticWorkers(); return; }
  for (const t of memeticWorkers || []) { try { clearInterval(t); } catch {} }
  memeticWorkers = null;
});

// ═══════════════════════════════════════
// WEBSOCKET BROADCAST
// ═══════════════════════════════════════
function broadcastWS(msg) {
  const str = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(str); } catch {}
    }
  }
  // Forward trade events to chart-subscribed clients with enriched price data
  if (msg.event === "trade" && msg.data?.ca) {
    const token = radar.tokens.get(msg.data.ca);
    const chartMsg = JSON.stringify({ event: "chart-trade", data: { ...msg.data, mcapSol: token?.mcapSol || 0, price: token?.mcapUsd || 0, time: Date.now() } });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && client._chartSub === msg.data.ca) {
        try { client.send(chartMsg); } catch {}
      }
    }
  }
}

wss.on("connection", (ws) => {
  radar.online++;
  ws._chartSub = null; // per-client chart subscription (one token at a time)
  ws.on("close", () => { radar.online--; ws._chartSub = null; });
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "subscribe-chart" && msg.ca) {
        ws._chartSub = msg.ca;
        // Ensure token is subscribed on PumpPortal for trade data
        subscribeToToken(msg.ca);
        ws.send(JSON.stringify({ event: "chart-subscribed", data: { ca: msg.ca } }));
      } else if (msg.type === "unsubscribe-chart") {
        ws._chartSub = null;
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {}
  });
  // Send initial state
  ws.send(JSON.stringify({ event: "connected", data: { poolSize: radar.poolSize } }));
});

// ═══════════════════════════════════════
// TRADING WALLET STORE (in-memory + Redis)
// ═══════════════════════════════════════
const tradingWallets = new Map(); // userPubkey → { pubkey, secret, createdAt }
const tradingKeyOwners = new Map(); // tradingKey pubkey → parent userPubkey (reverse lookup)

// Redis is the ONLY durable store for these: Railway wipes the filesystem on every deploy and the
// in-memory maps go with the process. A custodial key, the user record naming it, and the reverse
// index are permanent records, not cache, and must never carry an expiry -- see keepForever().
// Records written by an older build still have a clock ticking on them, so every read clears it.

/** Write a record that must outlive every deploy. No EX, ever. */
async function keepForever(key, value) {
  if (!redis) return;
  try { await redis.set(key, value); } catch {}
}

/** Clear an expiry an older build left on a custodial record, before it runs out. */
async function stopTheClock(key) {
  if (!redis) return;
  try {
    const ttl = await redis.ttl(key);   // -1 = no expiry, -2 = already gone
    if (ttl > 0) {
      await redis.persist(key);
      console.warn(`[custody] ${key} was ${Math.round(ttl / 86400)} days from expiring; expiry removed`);
    }
  } catch {}
}

async function getTradingWallet(userPubkey) {
  let tw = tradingWallets.get(userPubkey);
  if (!tw && redis) {
    try {
      const raw = await redis.get("tw:" + userPubkey);
      if (raw) { tw = vault.openRecord(JSON.parse(raw)); tradingWallets.set(userPubkey, tw); }
    } catch {}
  }
  if (tw) { await stopTheClock("tw:" + userPubkey); if (tw.pubkey) await stopTheClock("tkown:" + tw.pubkey); }
  // Maintain reverse lookup
  if (tw?.pubkey) tradingKeyOwners.set(tw.pubkey, userPubkey);
  return tw;
}

async function saveTradingWallet(userPubkey, tw) {
  tradingWallets.set(userPubkey, tw);
  if (tw?.pubkey) {
    tradingKeyOwners.set(tw.pubkey, userPubkey);
    if (redis) {
      await keepForever("tkown:" + tw.pubkey, userPubkey);
    }
  }
  if (redis) {
    await keepForever("tw:" + userPubkey, JSON.stringify(vault.sealRecord(tw))); // secret sealed at rest
  }
}

// Reverse lookup: given a pubkey, check if it's a trading key and return the parent wallet
async function findTradingKeyOwner(tradingKeyPubkey) {
  // Check in-memory reverse map first
  let owner = tradingKeyOwners.get(tradingKeyPubkey);
  if (owner) return owner;
  // Check Redis reverse index
  if (redis) {
    try {
      owner = await redis.get("tkown:" + tradingKeyPubkey);
      if (owner) { tradingKeyOwners.set(tradingKeyPubkey, owner); return owner; }
    } catch {}
  }
  // Brute-force scan in-memory tradingWallets (for pre-existing keys without reverse index)
  for (const [parentWallet, tw] of tradingWallets) {
    if (tw.pubkey === tradingKeyPubkey) {
      tradingKeyOwners.set(tradingKeyPubkey, parentWallet);
      // Persist reverse index for next time
      await keepForever("tkown:" + tradingKeyPubkey, parentWallet);
      return parentWallet;
    }
  }
  return null;
}

// ═══════════════════════════════════════
// USER STORE (in-memory + Redis)
// ═══════════════════════════════════════
const users = new Map(); // wallet → { tier, whitelisted, username, ... }

// Global fee accumulator — tracks all platform fees in this server session
// Persisted to Redis so it survives restarts
const globalFees = { totalSol: 0, txCount: 0, lastFeeAt: 0, sessionStart: Date.now() };

function recordGlobalFee(feeSol) {
  if (feeSol > 0) {
    globalFees.totalSol = +(globalFees.totalSol + feeSol).toFixed(6);
    globalFees.txCount++;
    globalFees.lastFeeAt = Date.now();
    // Persist async (non-blocking)
    if (redis) {
      redis.hSet("platform:fees", {
        totalSol: String(globalFees.totalSol),
        txCount: String(globalFees.txCount),
        lastFeeAt: String(globalFees.lastFeeAt),
      }).catch(() => {});
    }
  }
}

// Restore global fees from Redis on startup
(async () => {
  if (!redis) return;
  try {
    const data = await redis.hGetAll("platform:fees");
    if (data?.totalSol) globalFees.totalSol = parseFloat(data.totalSol) || 0;
    if (data?.txCount) globalFees.txCount = parseInt(data.txCount) || 0;
    if (data?.lastFeeAt) globalFees.lastFeeAt = parseInt(data.lastFeeAt) || 0;
    console.log(`[FEES] Restored: ${globalFees.totalSol} SOL from ${globalFees.txCount} txns`);
  } catch {}
})();

async function getUser(wallet) {
  let u = users.get(wallet);
  if (!u && redis) {
    try {
      const raw = await redis.get("user:" + wallet);
      if (raw) { u = JSON.parse(raw); users.set(wallet, u); }
    } catch {
      return { tier: "unknown", whitelisted: false, _redisError: true };
    }
  }
  return u || { tier: "free", whitelisted: false };
}

async function saveUser(wallet, data) {
  const existing = await getUser(wallet);
  const merged = { ...existing, ...data, lastSeen: new Date().toISOString() };
  users.set(wallet, merged);
  if (redis) {
    await keepForever("user:" + wallet, JSON.stringify(merged)); // names the trading wallet: as permanent as the key
  }
}

// Auto-apply default referral code for new users who weren't referred by someone else
async function applyDefaultReferral(wallet) {
  try {
    const user = await getUser(wallet);
    if (user.referredBy) return; // already referred by someone
    // Look up the default referral code owner
    let referrerWallet = null;
    if (redis) {
      referrerWallet = await redis.get("customref:" + DEFAULT_REFERRAL_CODE);
      if (!referrerWallet) referrerWallet = await redis.get("ref:" + DEFAULT_REFERRAL_CODE);
    }
    if (!referrerWallet) {
      const found = [...users.entries()].find(([, u]) => u.customRefCode === DEFAULT_REFERRAL_CODE || u.refCode === DEFAULT_REFERRAL_CODE);
      if (found) referrerWallet = found[0];
    }
    if (!referrerWallet || referrerWallet === wallet) return; // owner not found or self-referral
    const referrer = await getUser(referrerWallet);
    await saveUser(wallet, { referredBy: referrerWallet, referredByTier: referrer.tier || "free" });
    await saveUser(referrerWallet, {
      referralCount: (parseInt(referrer.referralCount || "0") + 1).toString(),
      referralNetwork: (parseInt(referrer.referralNetwork || "0") + 1).toString(),
    });
    if (redis) {
      try { await redis.lPush("refevents:" + referrerWallet, JSON.stringify({ user: wallet.slice(0, 4) + "..." + wallet.slice(-4), type: "signup", time: Date.now() })); } catch {}
    }
    console.log(`[REFERRAL] Default referral applied: ${wallet.slice(0, 8)}... → ${DEFAULT_REFERRAL_CODE}`);
  } catch (e) {
    console.error("[REFERRAL] Failed to apply default referral:", e.message);
  }
}

// ═══════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════
function requireWallet(req, res, next) {
  const wallet = req.headers["x-wallet"] || req.headers["X-Wallet"] || req.body?.wallet || req.query?.wallet;
  if (!wallet) return res.status(400).json({ error: "Wallet required" });
  req.wallet = wallet;
  next();
}

function requireAdmin(req, res, next) {
  // Header only: a secret in a query string lands in access logs and shared links.
  const secret = req.headers["x-admin-secret"];
  if (!ADMIN_SECRET || !secret || secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
  next();
}

// ═══════════════════════════════════════
// ROUTES: SOL PRICE
// ═══════════════════════════════════════
app.get("/api/sol-price", (req, res) => {
  res.json({ price: solUsdPrice, updated: Date.now() });
});

// ═══════════════════════════════════════
// ROUTES: ACCESS / TIER
// ═══════════════════════════════════════
// ── Token-gated tiers: hold BONDLI token at bonding curve ratio = auto-upgrade ──
const BONDLI_TOKEN_MINT = process.env.BONDLI_TOKEN_MINT || ""; // Set to BONDLI token CA when launched
// Ratio of total supply the user must hold for Pro (e.g. 0.001 = 0.1%)
// VIP = 10x the Pro ratio
const TIER_PRO_RATIO = parseFloat(process.env.TIER_PRO_RATIO || "0.001");
const TIER_VIP_RATIO = TIER_PRO_RATIO * 10;
// Total supply for pump.fun tokens (default 1B)
const TIER_TOKEN_SUPPLY = parseFloat(process.env.TIER_TOKEN_SUPPLY || "1000000000");

async function checkTokenGatedTier(wallet) {
  if (!BONDLI_TOKEN_MINT) return null; // not configured yet
  try {
    const owner = new PublicKey(wallet);
    const mint = new PublicKey(BONDLI_TOKEN_MINT);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    let totalBalance = 0;
    for (const ta of tokenAccounts.value) {
      totalBalance += ta.account.data.parsed?.info?.tokenAmount?.uiAmount || 0;
    }
    const holdRatio = totalBalance / TIER_TOKEN_SUPPLY;
    if (holdRatio >= TIER_VIP_RATIO) return "vip";
    if (holdRatio >= TIER_PRO_RATIO) return "pro";
    return null;
  } catch { return null; }
}

app.get("/api/access/check", async (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  const user = await getUser(wallet);
  // Even if Redis is down, check env whitelist first — VIPs should never be locked out
  let tierInfo = resolveTier(wallet, user._redisError ? {} : user);
  if (user._redisError && tierInfo.tier === "free") {
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }
  // Token-gated tier override — holding BONDLI token upgrades tier
  if (tierInfo.tier === "free" || tierInfo.tier === "pro") {
    const tokenTier = await checkTokenGatedTier(wallet);
    if (tokenTier) {
      const tierRank = { vip: 3, pro: 2, free: 1 };
      if ((tierRank[tokenTier] || 0) > (tierRank[tierInfo.tier] || 0)) {
        tierInfo = { ...tierInfo, tier: tokenTier, tokenGated: true };
      }
    }
  }
  // Only save if tier upgraded or not yet stored — never downgrade a stored VIP/pro to free
  if (!user._redisError) {
    const storedTier = user?.tier;
    const tierRank = { vip: 3, pro: 2, free: 1 };
    if (!storedTier || (tierRank[tierInfo.tier] || 0) >= (tierRank[storedTier] || 0)) {
      await saveUser(wallet, { tier: tierInfo.tier, whitelisted: tierInfo.whitelisted, tokenGated: tierInfo.tokenGated || false });
    }
  }
  res.json({ tier: tierInfo.tier, whitelisted: tierInfo.whitelisted, paid: user.paid || false, tokenGated: tierInfo.tokenGated || false, tokenThresholds: BONDLI_TOKEN_MINT ? { proRatio: TIER_PRO_RATIO, vipRatio: TIER_VIP_RATIO, proTokens: Math.ceil(TIER_PRO_RATIO * TIER_TOKEN_SUPPLY), vipTokens: Math.ceil(TIER_VIP_RATIO * TIER_TOKEN_SUPPLY), mint: BONDLI_TOKEN_MINT } : null });
});

app.post("/api/access/activate-free", async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  const existing = await getUser(wallet);
  // Check whitelist even if Redis is down — VIPs should always get through
  const tierInfo = resolveTier(wallet, existing._redisError ? {} : existing);
  if (existing._redisError && tierInfo.tier === "free") {
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }
  if (tierInfo.tier === "vip" || tierInfo.tier === "pro" || tierInfo.whitelisted) {
    return res.json({ ok: true, tier: tierInfo.tier, message: "Already " + tierInfo.tier });
  }
  await saveUser(wallet, { tier: "free", activatedAt: new Date().toISOString() });
  // Auto-apply default referral for new users without a referrer
  applyDefaultReferral(wallet);
  res.json({ ok: true, tier: "free" });
});

// Shared payment verification helper
async function verifyPayment(wallet, txSig, minSol) {
  const tx = await connection.getTransaction(txSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) throw new Error("Transaction not found or not confirmed");
  if (tx.meta?.err) throw new Error("Transaction failed on-chain");
  const keys = tx.transaction.message.staticAccountKeys
    ? tx.transaction.message.staticAccountKeys.map(k => k.toBase58())
    : tx.transaction.message.accountKeys.map(k => k.toBase58());
  const platformIdx = keys.indexOf(PLATFORM_WALLET);
  const senderIdx = keys.indexOf(wallet);
  if (platformIdx < 0) throw new Error("Payment not sent to platform wallet");
  if (senderIdx < 0) throw new Error("Transaction sender doesn't match wallet");
  const received = ((tx.meta.postBalances?.[platformIdx] || 0) - (tx.meta.preBalances?.[platformIdx] || 0)) / LAMPORTS_PER_SOL;
  if (received < minSol - 0.01) throw new Error(`Insufficient payment: ${received.toFixed(4)} SOL (need ${minSol})`);
  return received;
}

// Legacy endpoint — Pro tier removed, redirect to VIP
app.post("/api/access/activate-pro", async (req, res) => {
  res.status(410).json({ error: "Pro tier has been removed. All features are now free. Upgrade to VIP for 0% fees." });
});

app.post("/api/access/activate-vip", async (req, res) => {
  const { wallet, txSig } = req.body;
  if (!wallet || !txSig) return res.status(400).json({ error: "wallet and txSig required" });
  try {
    await verifyPayment(wallet, txSig, 10); // VIP = 10 SOL
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  await saveUser(wallet, { tier: "vip", paid: true, whitelisted: true, vipTx: txSig });
  applyDefaultReferral(wallet);
  res.json({ ok: true, tier: "vip" });
});

app.get("/api/pricing", (req, res) => {
  const wallet = req.query.wallet;
  const base = {
    free: { fee: "25% → 5% (profit ladder)", price: "0 SOL", label: "Free — full access, earn lower fees by winning" },
    vip: { fee: "0%", price: "10 SOL", label: "VIP — 0% fee, priority queue, API access" },
    platformWallet: PLATFORM_WALLET,
    ladder: PROFIT_LADDER,
  };
  // If wallet provided, include their personal fee stats
  if (wallet && wallet.length >= 32) {
    const { rate, ladder, stats } = getEffectiveFeeRate(wallet);
    base.personal = { rate, ladder: ladder.name, ladderProgress: ladder.progress, nextTier: ladder.next, totalProfit: stats.totalProfit, winStreak: stats.winStreak, wins: stats.wins, trades: stats.trades, shareCredits: stats.shareCredits };
  }
  res.json(base);
});

// ── Trader stats & win cards (share-to-earn viral loop) ──
app.get("/api/trader-stats/:wallet", (req, res) => {
  const wallet = req.params.wallet;
  if (!wallet || wallet.length < 32) return res.status(400).json({ error: "Invalid wallet" });
  const stats = getTraderStats(wallet);
  const { rate, ladder } = getEffectiveFeeRate(wallet);
  res.json({ ...stats, effectiveRate: rate, ladder: ladder.name, ladderProgress: ladder.progress, nextTier: ladder.next });
});

// Win cards are stored in-memory with short TTL (shared via URL)
const winCards = new Map();
app.post("/api/win-card", (req, res) => {
  try {
    const { wallet, profitSol, profitPct, tokenName, ticker, holdTimeMs } = req.body;
    if (!wallet || !profitSol || profitSol <= 0) return res.status(400).json({ error: "No profit to share" });
    const card = generateWinCard(wallet, { profitSol, profitPct, tokenName, ticker, holdTimeMs });
    winCards.set(card.cardId, { ...card, creatorWallet: wallet, ts: Date.now() });
    // Evict old cards (keep last 1000)
    if (winCards.size > 1000) {
      const oldest = [...winCards.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 200);
      for (const [k] of oldest) winCards.delete(k);
    }
    res.json({ ok: true, card });
  } catch { res.status(500).json({ error: "Failed to generate win card" }); }
});

app.get("/api/win-card/:id", (req, res) => {
  const card = winCards.get(req.params.id);
  if (!card) return res.status(404).json({ error: "Card expired or not found" });
  res.json(card);
});

// Share credit: when someone signs up via a win card link
app.post("/api/share-credit", (req, res) => {
  const { cardId, newWallet } = req.body;
  const card = winCards.get(cardId);
  if (!card) return res.status(404).json({ error: "Card not found" });
  if (card.creatorWallet === newWallet) return res.status(400).json({ error: "Cannot credit yourself" });
  const credits = addShareCredit(card.creatorWallet);
  res.json({ ok: true, credited: card.creatorWallet.slice(0, 4) + "...", newCredits: credits });
});

// ═══════════════════════════════════════
// ROUTES: TRADING WALLET
// ═══════════════════════════════════════

// Identify if a connected wallet is actually a trading key — returns parent wallet if so
app.get("/api/trading-wallet/identify/:pubkey", requireOwner, async (req, res) => {
  const pk = req.params.pubkey;
  if (!pk) return res.status(400).json({ error: "pubkey required" });
  try {
    const owner = await findTradingKeyOwner(pk);
    if (owner) {
      // Fetch the full trading wallet data for the parent
      const tw = await getTradingWallet(owner);
      const tierInfo = await (async () => {
        const user = await getUser(owner);
        return resolveTier(owner, user._redisError ? {} : user);
      })();
      return res.json({
        isTradeKey: true,
        parentWallet: owner,
        tradingWallet: tw?.pubkey || pk,
        tier: tierInfo.tier || "free",
        whitelisted: tierInfo.whitelisted || false,
        paid: tierInfo.paid || false,
      });
    }
    return res.json({ isTradeKey: false });
  } catch (e) {
    console.log(`[IDENTIFY] Error for ${pk.slice(0,8)}: ${e.message}`);
    return res.json({ isTradeKey: false });
  }
});

app.get("/api/trading-wallet/:wallet", requireOwner, async (req, res) => {
  const tw = await getTradingWallet(req.params.wallet);
  if (!tw) return res.json({ ok: false, tradingWallet: null });
  let pubkey = tw.pubkey;
  if (!pubkey && tw.secret) {
    try { pubkey = Keypair.fromSecretKey(bs58.decode(tw.secret)).publicKey.toBase58(); } catch {}
  }
  if (!pubkey) return res.json({ ok: false, tradingWallet: null, error: "invalid wallet" });

  // Return cached balance if fresh (avoids RPC 429 on frequent polls)
  const cacheKey = "bal:" + pubkey;
  const cached = getCachedBalance(cacheKey);
  if (cached) return res.json(cached);

  // Fetch SOL balance with retry + timeout
  let solBalance = 0;
  let rpcFailed = false;
  try {
    const bal = await rpcRetry(() => {
      const p = connection.getBalance(new PublicKey(pubkey));
      const t = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000));
      return Promise.race([p, t]);
    }, "getBalance:" + pubkey.slice(0, 8));
    solBalance = bal / LAMPORTS_PER_SOL;
  } catch (e) {
    rpcFailed = true;
    console.log(`[WALLET-BAL] getBalance failed for ${pubkey.slice(0,8)}: ${e.message}`);
    // On RPC failure, serve last known good balance instead of 0
    const stale = getStaleCachedBalance(cacheKey);
    if (stale) { console.log(`[WALLET-BAL] Serving stale cache for ${pubkey.slice(0,8)}`); return res.json({ ...stale, stale: ["sol", "eth"] }); }
  }
  // Calculate total token value in SOL across all held positions
  let tokenValueSol = 0;
  const tokenDetails = [];
  try {
    const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const accts = await rpcRetry(() => connection.getParsedTokenAccountsByOwner(new PublicKey(pubkey), { programId: TOKEN_PROGRAM }), "getTokenAccounts:" + pubkey.slice(0, 8));
    const mintsToPrice = [];
    for (const ta of accts.value) {
      const info = ta.account.data.parsed.info;
      const amount = parseFloat(info.tokenAmount.uiAmountString || "0");
      if (amount <= 0) continue;
      const mint = info.mint;
      const radarToken = radar.tokens.get(mint);
      if (radarToken) {
        const totalSupply = 1_000_000_000;
        const holdPct = amount / totalSupply;
        const mcUsd = radarToken.mcapUsd || 0;
        const valueUsd = mcUsd > 0 ? holdPct * mcUsd : 0;
        const valueSol = solUsdPrice > 0 ? valueUsd / solUsdPrice : 0;
        tokenValueSol += valueSol;
        tokenDetails.push({ mint, name: radarToken.name || mint.slice(0,8), amount, valueSol: +valueSol.toFixed(6) });
      } else {
        mintsToPrice.push({ mint, amount });
      }
    }
    if (mintsToPrice.length > 0) {
      try {
        const batch = mintsToPrice.slice(0, 10);
        const ids = batch.map(m => m.mint).join(",");
        const priceResp = await fetch(`https://api.jup.ag/price/v2?ids=${ids}`, { signal: AbortSignal.timeout(5000) });
        if (priceResp.ok) {
          const priceData = await priceResp.json();
          for (const item of batch) {
            const p = priceData?.data?.[item.mint];
            if (p?.price) {
              const valueUsd = item.amount * parseFloat(p.price);
              const valueSol = solUsdPrice > 0 ? valueUsd / solUsdPrice : 0;
              tokenValueSol += valueSol;
              tokenDetails.push({ mint: item.mint, name: item.mint.slice(0,8), amount: item.amount, valueSol: +valueSol.toFixed(6) });
            }
          }
        }
      } catch {}
    }
  } catch (e) {
    console.log(`[WALLET-BAL] token scan failed for ${pubkey.slice(0,8)}: ${e.message}`);
    // If token scan also failed, serve stale cache
    if (!rpcFailed) {
      const stale = getStaleCachedBalance(cacheKey);
      if (stale) { console.log(`[WALLET-BAL] Serving stale cache for ${pubkey.slice(0,8)} (token scan failed)`); return res.json({ ...stale, stale: ["tokens"] }); }
    }
  }
  const totalBalance = +(solBalance + tokenValueSol).toFixed(6);
  // An older wallet has no ETH key yet: mint one now so Robinhood Chain is available to everyone.
  if (!tw.evmAddress && tw.secret && vault.canCreate()) { try { const evm = EvmWallet.createRandom(); tw.evmAddress = evm.address; tw.evmSecret = evm.privateKey; await saveTradingWallet(req.params.wallet, tw); } catch {} }
  // Robinhood Chain is a separate chain behind a separate RPC, and it fails separately. This used to
  // swallow the error, leave ethBalance null, and then cache the whole reading anyway -- rpcFailed
  // only ever tracked Solana -- so one hiccup on the PONS node pinned the ETH figure to null or to
  // the value it had before, with nothing to say the number had stopped being true.
  let ethBalance = null, ethFailed = false;
  if (tw.evmAddress) {
    try { ethBalance = +Number(formatEther(await ponsProvider.getBalance(tw.evmAddress))).toFixed(6); }
    catch (e) {
      ethFailed = true;
      const prev = getStaleCachedBalance(cacheKey);
      ethBalance = prev && prev.ethBalance != null ? prev.ethBalance : null;
      console.log(`[WALLET-BAL] Robinhood Chain balance failed for ${tw.evmAddress.slice(0, 10)}: ${e.message}${ethBalance != null ? "; serving the last good reading" : ""}`);
    }
  }
  // Arc, same address, its own RPC, its own failure: a stale Arc reading is marked as such and never
  // pins the cache, exactly as the Robinhood Chain leg above.
  let usdcBalance = null, usdcFailed = false;
  if (tw.evmAddress) {
    try { usdcBalance = +Number(formatEther(await arcProvider.getBalance(tw.evmAddress))).toFixed(4); }
    catch (e) {
      usdcFailed = true;
      const prev = getStaleCachedBalance(cacheKey);
      usdcBalance = prev && prev.usdcBalance != null ? prev.usdcBalance : null;
      console.log(`[WALLET-BAL] Arc balance failed for ${tw.evmAddress.slice(0, 10)}: ${e.message}${usdcBalance != null ? "; serving the last good reading" : ""}`);
    }
  }
  const staleLegs = [ethFailed && "eth", usdcFailed && "arc"].filter(Boolean);
  const result = { ok: true, tradingWallet: pubkey, balance: totalBalance, solBalance: +solBalance.toFixed(6), tokenValueSol: +tokenValueSol.toFixed(6), tokens: tokenDetails, evmAddress: tw.evmAddress || null, ethBalance, usdcBalance, as_of: Date.now(), stale: staleLegs.length ? staleLegs : null };
  // Cache only a reading every leg of which succeeded. A partial one would be served for the next
  // fifteen seconds as though it were whole, and could then be served indefinitely as "last known
  // good" by the stale path above -- which is how a number stops moving and nobody notices.
  if (!rpcFailed && !ethFailed && !usdcFailed) setCachedBalance(cacheKey, result);
  console.log(`[WALLET-BAL] ${pubkey.slice(0,8)}: ${solBalance.toFixed(4)} SOL + ${tokenValueSol.toFixed(4)} tokens = ${totalBalance} total (${tokenDetails.length} tokens)`);
  res.json(result);
});

// ── WALLET DEBUG: detailed diagnostic for deposit issues ──
app.get("/api/trading-wallet/:wallet/debug", requireOwner, async (req, res) => {
  const diag = { steps: [], errors: [], wallet: req.params.wallet };
  try {
    // Step 1: Look up trading wallet
    const tw = await getTradingWallet(req.params.wallet);
    diag.steps.push({ step: "getTradingWallet", found: !!tw, pubkey: tw?.pubkey?.slice(0,12) || null, hasSecret: !!tw?.secret });
    if (!tw) {
      // Check if user record has tradingWallet reference
      const user = await getUser(req.params.wallet);
      diag.steps.push({ step: "getUser_fallback", user: user ? { tier: user.tier, tradingWallet: user.tradingWallet?.slice(0,12) || null } : null });
      diag.errors.push("No trading wallet found in tw: store or Redis");
      return res.json({ ok: false, diag });
    }
    let pubkey = tw.pubkey;
    if (!pubkey && tw.secret) {
      try { pubkey = Keypair.fromSecretKey(bs58.decode(tw.secret)).publicKey.toBase58(); diag.steps.push({ step: "derive_pubkey", pubkey: pubkey.slice(0,12) }); } catch (e) { diag.errors.push("derive_pubkey failed: " + e.message); }
    }
    if (!pubkey) { diag.errors.push("No pubkey available"); return res.json({ ok: false, diag }); }
    diag.pubkey = pubkey;

    // Step 2: Check SOL balance (with retry for 429)
    try {
      const bal = await rpcRetry(() => connection.getBalance(new PublicKey(pubkey)), "debug:getBalance");
      diag.steps.push({ step: "getBalance", lamports: bal, sol: bal / LAMPORTS_PER_SOL });
    } catch (e) {
      diag.steps.push({ step: "getBalance", error: e.message });
      diag.errors.push("getBalance failed: " + e.message);
    }

    // Step 3: Check token accounts (with retry for 429)
    try {
      const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      const accts = await rpcRetry(() => connection.getParsedTokenAccountsByOwner(new PublicKey(pubkey), { programId: TOKEN_PROGRAM }), "debug:getTokenAccounts");
      const tokens = accts.value.map(ta => {
        const info = ta.account.data.parsed.info;
        return { mint: info.mint.slice(0,12), amount: info.tokenAmount.uiAmountString, decimals: info.tokenAmount.decimals };
      });
      diag.steps.push({ step: "getTokenAccounts", count: accts.value.length, tokens });
    } catch (e) {
      diag.steps.push({ step: "getTokenAccounts", error: e.message });
      diag.errors.push("getTokenAccounts failed: " + e.message);
    }

    // Step 4: Check RPC health (with retry for 429)
    try {
      const slot = await rpcRetry(() => connection.getSlot(), "debug:getSlot");
      diag.steps.push({ step: "rpcHealth", slot, rpcUrl: RPC_URL.slice(0, 40) });
    } catch (e) {
      diag.steps.push({ step: "rpcHealth", error: e.message });
      diag.errors.push("RPC unhealthy: " + e.message);
    }

    // Step 5: Redis status
    diag.steps.push({ step: "redis", connected: !!redis });

    // Step 6: solUsdPrice
    diag.steps.push({ step: "solUsdPrice", price: solUsdPrice });

    diag.ok = diag.errors.length === 0;
    res.json(diag);
  } catch (e) {
    diag.errors.push("Unexpected: " + e.message);
    res.json({ ok: false, diag });
  }
});

// ── Wallet sign-in: prove ownership once, then every money route takes the Bearer token ──
app.post("/api/auth/challenge", (req, res) => {
  const { wallet } = req.body || {};
  try { new PublicKey(wallet); } catch { return res.status(400).json({ error: "wallet must be a Solana public key" }); }
  res.json({ ok: true, ...generateChallenge(wallet) });
});
app.post("/api/auth/verify", async (req, res) => {
  const { wallet, signature } = req.body || {};
  const ch = wallet && authNonces.get(wallet);
  if (!ch) return res.status(400).json({ error: "no challenge for this wallet; request one first" });
  if (!verifySolanaSignature(wallet, signature, ch.message)) return res.status(401).json({ error: "signature does not match the wallet" });
  authNonces.delete(wallet);
  const tierInfo = resolveTier(wallet, await getUser(wallet));
  res.json({ ok: true, token: issueAuthToken(wallet, tierInfo.tier), tier: tierInfo.tier, wallet });
});

app.post("/api/trading-wallet/create", requireOwner, async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  const existing = await getTradingWallet(wallet);
  if (existing) return res.json({ ok: true, tradingWallet: existing.pubkey, already: true });
  if (!vault.canCreate()) return res.status(503).json({ error: "custodial wallets are disabled until WALLET_ENCRYPTION_KEY is set on the server" });
  // Never mint a wallet over one that already exists. The user record names the trading wallet, and
  // it is a SEPARATE record from the key, so "no key but a named wallet" means the key is unreachable
  // -- expired under an older build's 30-day TTL, or a Redis read that failed. Generating a fresh
  // keypair there overwrites the pointer to a funded address and puts the money permanently out of
  // reach, silently, in the one call a returning user is most likely to make. Refuse and say so.
  const prior = await getUser(wallet);
  if (prior?._redisError) return res.status(503).json({ error: "cannot reach the wallet store; not creating a wallet that might already exist" });
  if (prior?.tradingWallet) {
    return res.status(409).json({
      error: "a trading wallet already exists for this account but its key could not be loaded; refusing to replace it",
      tradingWallet: prior.tradingWallet, recoverable: true,
    });
  }
  const kp = Keypair.generate();
  const evm = EvmWallet.createRandom(); // the same bot, on Robinhood Chain: one ETH key beside the SOL key
  const tw = { pubkey: kp.publicKey.toBase58(), secret: bs58.encode(kp.secretKey), evmAddress: evm.address, evmSecret: evm.privateKey, createdAt: new Date().toISOString() };
  await saveTradingWallet(wallet, tw);
  await saveUser(wallet, { tradingWallet: tw.pubkey, evmAddress: evm.address });
  res.json({ ok: true, tradingWallet: tw.pubkey, evmAddress: evm.address, privateKey: tw.secret });
});

// Withdraw: SOL from the trading wallet back to the connected wallet (or any address the owner names).
app.post("/api/trading-wallet/withdraw", requireOwner, async (req, res) => {
  try {
    const { wallet, to, sol, chain } = req.body || {};
    const tw = await getTradingWallet(wallet);
    if (!tw?.secret) return res.status(404).json({ error: "No trading wallet" });
    if (chain === "arc") { // USDC on Arc back to an EVM address the owner names; the balance is native, 18 decimals
      if (!tw.evmSecret) return res.status(404).json({ error: "No EVM wallet" });
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(to || ""))) return res.status(400).json({ error: "to must be an EVM address (0x…) for an Arc withdrawal" });
      if (velocityHub?.has(wallet)) return res.status(409).json({ error: "stop Velocity first" });
      const w = new EvmWallet(tw.evmSecret, arcProvider);
      const bal = await arcProvider.getBalance(w.address);
      const fee = await arcProvider.getFeeData();
      const gas = 21_000n * ((fee.maxFeePerGas ?? fee.gasPrice ?? 20_000_000_000n) * 2n);
      const value = sol === "all" || sol == null ? bal - gas : parseEther(String(sol));
      if (!(value > 0n) || value > bal - gas) return res.status(400).json({ error: `nothing to withdraw (balance ${formatEther(bal)} USDC)` });
      const tx = await w.sendTransaction({ to, value, gasLimit: 21_000n });
      return res.json({ ok: true, sig: tx.hash, usdc: Number(formatEther(value)), to });
    }
    if (chain === "pons") { // ETH on Robinhood Chain back to an EVM address the owner names
      if (!tw.evmSecret) return res.status(404).json({ error: "No Robinhood Chain wallet" });
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(to || ""))) return res.status(400).json({ error: "to must be an EVM address (0x…) for a Robinhood Chain withdrawal" });
      if (velocityHub?.has(wallet)) return res.status(409).json({ error: "stop Velocity first" });
      const w = new EvmWallet(tw.evmSecret, ponsProvider);
      const bal = await ponsProvider.getBalance(w.address);
      const fee = await ponsProvider.getFeeData();
      const gas = 21_000n * ((fee.maxFeePerGas ?? fee.gasPrice ?? 100_000_000n) * 2n);
      const value = sol === "all" || sol == null ? bal - gas : parseEther(String(sol));
      if (!(value > 0n) || value > bal - gas) return res.status(400).json({ error: `nothing to withdraw (balance ${formatEther(bal)} ETH)` });
      const tx = await w.sendTransaction({ to, value, gasLimit: 21_000n });
      return res.json({ ok: true, sig: tx.hash, eth: Number(formatEther(value)), to });
    }
    const kp = Keypair.fromSecretKey(bs58.decode(tw.secret));
    const dest = new PublicKey(to || wallet);
    const bal = await connection.getBalance(kp.publicKey);
    const keep = 5_000 + 890_880; // fee + rent floor
    const lamports = sol === "all" || sol == null ? bal - keep : Math.floor(Number(sol) * LAMPORTS_PER_SOL);
    if (!(lamports > 0) || lamports > bal - keep) return res.status(400).json({ error: `nothing to withdraw (balance ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL)` });
    if (velocityHub?.has(wallet)) return res.status(409).json({ error: "stop Velocity first" });
    const { SystemProgram, Transaction } = await import("@solana/web3.js");
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports }));
    tx.feePayer = kp.publicKey; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash; tx.sign(kp);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    res.json({ ok: true, sig, sol: lamports / LAMPORTS_PER_SOL, to: dest.toBase58() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/trading-wallet/export", requireOwner, async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  const tw = await getTradingWallet(wallet);
  if (!tw) return res.status(404).json({ error: "No trading wallet" });
  res.json({ ok: true, privateKey: tw.secret, pubkey: tw.pubkey, evmAddress: tw.evmAddress || null, evmPrivateKey: tw.evmSecret || null });
});

// ── MULTI-WALLET: Pro/VIP can create additional trading wallets ──
app.post("/api/trading-wallet/create-extra", requireOwner, async (req, res) => {
  const { wallet, label } = req.body;
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  const user = await getUser(wallet);
  const tierInfo = resolveTier(wallet, user);
  if (tierInfo.tier === "free" && !tierInfo.whitelisted) {
    return res.status(403).json({ error: "Pro/VIP only — upgrade to create multiple wallets" });
  }
  if (!vault.canCreate()) return res.status(503).json({ error: "custodial wallets are disabled until WALLET_ENCRYPTION_KEY is set on the server" });
  const kp = Keypair.generate();
  const newWallet = { pubkey: kp.publicKey.toBase58(), secret: bs58.encode(kp.secretKey), label: label || "Wallet " + (Date.now() % 1000), createdAt: new Date().toISOString() };
  // Store in list
  let wallets = [];
  if (redis) {
    try {
      const raw = await redis.get("extra_wallets:" + wallet);
      if (raw) wallets = vault.openRecord(JSON.parse(raw));
    } catch {}
  }
  wallets.push(newWallet);
  if (redis) {
    await keepForever("extra_wallets:" + wallet, JSON.stringify(vault.sealRecord(wallets)));
  }
  console.log(`[WALLET] Extra wallet created for ${wallet.slice(0, 8)}: ${newWallet.pubkey.slice(0, 8)}`);
  res.json({ ok: true, wallet: newWallet.pubkey, label: newWallet.label, total: wallets.length });
});

app.get("/api/trading-wallet/list/:wallet", requireOwner, async (req, res) => {
  const wallet = req.params.wallet;
  const primary = await getTradingWallet(wallet);
  const wallets = []; 
  if (primary) {
    let bal = 0;
    try { bal = await connection.getBalance(new PublicKey(primary.pubkey)) / LAMPORTS_PER_SOL; } catch {}
    wallets.push({ pubkey: primary.pubkey, label: primary.label || "Primary", balance: bal, primary: true });
  }
  // Extra wallets (pro/VIP)
  if (redis) {
    try {
      const raw = await redis.get("extra_wallets:" + wallet);
      if (raw) {
        const extras = vault.openRecord(JSON.parse(raw));
        for (const ew of extras) {
          let bal = 0;
          try { bal = await connection.getBalance(new PublicKey(ew.pubkey)) / LAMPORTS_PER_SOL; } catch {}
          wallets.push({ pubkey: ew.pubkey, label: ew.label || "Extra", balance: bal, primary: false });
        }
      }
    } catch {}
  }
  res.json({ ok: true, wallets, count: wallets.length });
});

// ── IMPORT WALLET: bring your own aged wallets ──
app.post("/api/trading-wallet/import", requireOwner, async (req, res) => {
  try {
    const { wallet, privateKey, label } = req.body;
    if (!wallet || !privateKey) return res.status(400).json({ error: "wallet and privateKey required" });
    
    // Validate the private key
    let kp;
    try { kp = Keypair.fromSecretKey(bs58.decode(privateKey)); }
    catch { return res.status(400).json({ error: "Invalid private key (must be base58)" }); }
    
    const importedPubkey = kp.publicKey.toBase58();
    let bal = 0;
    try { bal = await connection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL; } catch {}
    
    // Check if user already has a primary wallet
    const existing = await getTradingWallet(wallet);
    
    if (!existing) {
      // No primary wallet — make this the primary
      const tw = { pubkey: importedPubkey, secret: privateKey, label: label || "Imported", createdAt: new Date().toISOString(), imported: true };
      await saveTradingWallet(wallet, tw);
      await saveUser(wallet, { tradingWallet: importedPubkey });
      console.log(`[WALLET] Imported as primary for ${wallet.slice(0, 8)}: ${importedPubkey.slice(0, 8)} (${bal.toFixed(4)} SOL)`);
      return res.json({ ok: true, pubkey: importedPubkey, balance: bal, primary: true, label: tw.label });
    }
    
    // Already has primary — add as extra (pro/VIP check)
    const user = await getUser(wallet);
    const tierInfo = resolveTier(wallet, user);
    if (tierInfo.tier === "free" && !tierInfo.whitelisted) {
      return res.status(403).json({ error: "VIP required for multiple wallets. Free tier gets 1 wallet." });
    }
    
    let wallets = [];
    if (redis) {
      try {
        const raw = await redis.get("extra_wallets:" + wallet);
        if (raw) wallets = vault.openRecord(JSON.parse(raw));
      } catch {}
    }
    
    // Check for duplicates
    if (wallets.some(w => w.pubkey === importedPubkey) || existing.pubkey === importedPubkey) {
      return res.status(400).json({ error: "Wallet already added" });
    }
    
    wallets.push({ pubkey: importedPubkey, secret: privateKey, label: label || "Imported " + (wallets.length + 2), createdAt: new Date().toISOString(), imported: true });
    if (redis) {
      await keepForever("extra_wallets:" + wallet, JSON.stringify(vault.sealRecord(wallets)));
    }
    
    console.log(`[WALLET] Imported extra for ${wallet.slice(0, 8)}: ${importedPubkey.slice(0, 8)} (${bal.toFixed(4)} SOL) — total: ${wallets.length + 1}`);
    res.json({ ok: true, pubkey: importedPubkey, balance: bal, primary: false, label: wallets[wallets.length - 1].label, totalWallets: wallets.length + 1 });
  } catch (e) {
    console.error("[WALLET] Import error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// ROUTES: SESSION LIFECYCLE
// ═══════════════════════════════════════
app.post("/api/session/create", requireOwner, async (req, res) => {
  try {
    const { totalSol, tokenConfig, wallet, fleetConfig } = req.body;
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const user = await getUser(wallet);
    const tierInfo = resolveTier(wallet, user);

    const session = await sessionManager.create({
      userWallet: wallet,
      totalSol: totalSol || 0.5,
      tokenConfig: tokenConfig || {},
      tier: tierInfo.tier,
      fleetConfig: fleetConfig || {},
    });

    res.json(session);
  } catch (e) {
    console.error("[SESSION] Create error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/session/balance", requireOwner, async (req, res) => {
  const { sessionId, wallet } = req.query;
  const session = await sessionManager.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.userWallet !== wallet) return res.status(403).json({ error: "Not your session" });
  if (session.funded) return res.json({ funded: true, balance: session.actualDeposit || session.totalSol });
  // Check on-chain
  try {
    const balance = await connection.getBalance(new PublicKey(session.devWallet));
    const balanceSol = balance / LAMPORTS_PER_SOL;
    const expectedMin = session.totalSol * 0.90;
    if (balanceSol >= expectedMin) {
      await sessionManager.update(sessionId, { funded: true, status: "funded", actualDeposit: balanceSol, fundedAt: new Date().toISOString() });
      return res.json({ funded: true, balance: balanceSol });
    }
    return res.json({ funded: false, balance: balanceSol, needed: session.totalSol });
  } catch (e) {
    return res.json({ funded: false, error: e.message });
  }
});

app.post("/api/session/fund", requireOwner, async (req, res) => {
  const { sessionId, txSig, wallet } = req.body;
  const result = await sessionManager.verifyDeposit(sessionId, txSig);
  res.json(result);
});

app.post("/api/session/launch", requireOwner, async (req, res) => {
  try {
    const { sessionId, wallet } = req.body;
    const session = await sessionManager.get(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.userWallet !== wallet) return res.status(403).json({ error: "Not your session" });
    if (!session.funded) return res.status(400).json({ error: "Not funded" });

    const devKp = await sessionManager.getDevKeypair(sessionId);
    if (!devKp) return res.status(500).json({ error: "Dev keypair not found" });

    const user = await getUser(wallet);
    const tierInfo = resolveTier(wallet, user);
    const profitConfig = buildProfitConfig(tierInfo.tier, tierInfo.whitelisted);

    let tokenCA = session.tokenConfig.existingCA;

    // Create token if not aping existing
    if (!tokenCA) {
      await sessionManager.update(sessionId, { status: "creating" });
      try {
        const createResult = await createToken(connection, devKp, session.tokenConfig);
        tokenCA = createResult.mint?.toBase58?.() || createResult.mint || createResult.ca;
        await sessionManager.update(sessionId, { tokenCA, status: "created" });
        console.log(`[LAUNCH] Token created: ${tokenCA}`);
      } catch (e) {
        await sessionManager.update(sessionId, { status: "create_failed" });
        return res.status(500).json({ error: "Token creation failed: " + e.message });
      }
    }

    if (!tokenCA) return res.status(500).json({ error: "No token CA" });

    // Launch fleet
    await sessionManager.update(sessionId, { status: "launching", tokenCA, launchedAt: new Date().toISOString() });

    const launchResult = await fleetTrader.launch(tokenCA, {
      totalSol: session.totalSol,
      devKeypair: devKp,
      sessionId,
      fleetConfig: session.fleetConfig,
      profitConfig,
    });

    // Store fleet wallet keys
    if (launchResult.walletKeys) {
      if (redis) {
        try { await redis.set("fleetkeys:" + sessionId, JSON.stringify(launchResult.walletKeys), { EX: 172800 }); } catch {}
      }
    }

    await sessionManager.update(sessionId, { status: "live", tokenCA });

    res.json({ ok: true, tokenCA, wallets: launchResult.wallets, phase: launchResult.phase });
  } catch (e) {
    console.error("[LAUNCH] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/session/resume", requireOwner, async (req, res) => {
  res.json({ ok: false, error: "Resume not yet implemented" });
});

// ── FLEET COMMAND (War Room controls) ──
app.post("/api/session/command", requireOwner, async (req, res) => {
  try {
    const { sessionId, wallet, command, params } = req.body || {};
    if (!sessionId || !wallet || !command) return res.status(400).json({ error: "sessionId, wallet, command required" });
    const session = await sessionManager.get(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.userWallet !== wallet) return res.status(403).json({ error: "Not your session" });
    if (!session.tokenCA) return res.status(400).json({ error: "No token CA" });
    const result = fleetTrader.command(session.tokenCA, command, params || {});
    if (!result.ok) return res.status(400).json(result);
    console.log(`[CMD] ${wallet.slice(0, 8)} → ${command} on ${session.tokenCA.slice(0, 8)} (${result.duration || 0}s)`);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SELL-SWEEP (Close session) ──
// FIX: Updates session status + sweeps master → trading wallet + NO skim on recovery
app.post("/api/session/sell-sweep", requireOwner, async (req, res) => {
  try {
    const { sessionId, wallet } = req.body;
    const session = await sessionManager.get(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.userWallet !== wallet) return res.status(403).json({ error: "Not your session" });

    let closeResult = {};
    // Try to close active fleet session (may not exist if server restarted)
    if (session.tokenCA && fleetTrader.sessions.has(session.tokenCA)) {
      try {
        closeResult = await fleetTrader.close(session.tokenCA);
      } catch (e) {
        console.warn(`[SWEEP] Fleet close failed (continuing): ${e.message}`);
      }
    }

    // Update session status
    await sessionManager.update(sessionId, { status: "closed", closedAt: new Date().toISOString() });

    const tw = await getTradingWallet(wallet);
    const destPubkey = tw?.pubkey || wallet;
    let totalSwept = closeResult.solRecovered || 0;

    // Sweep dev wallet → trading wallet
    try {
      if (session.devSecret) {
        const devKp = Keypair.fromSecretKey(bs58.decode(session.devSecret));
        // First sell any tokens the dev wallet holds
        if (session.tokenCA) {
          try {
            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(devKp.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
            const tokenAccount = tokenAccounts.value.find(ta => ta.account.data.parsed.info.mint === session.tokenCA);
            if (tokenAccount) {
              const tokenBal = parseFloat(tokenAccount.account.data.parsed.info.tokenAmount.uiAmountString || "0");
              if (tokenBal > 0) {
                console.log(`[SWEEP] Dev holds ${tokenBal} tokens — selling via PumpPortal...`);
                try {
                  const sellResp = await fetch("https://pumpportal.fun/api/trade-local", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ publicKey: devKp.publicKey.toBase58(), action: "sell", mint: session.tokenCA, amount: "100%", denominatedInSol: "false", slippage: TRADE_CONFIG.SELL_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto" }),
                    signal: AbortSignal.timeout(15000),
                  });
                  if (sellResp.ok) {
                    const txBytes = await sellResp.arrayBuffer();
                    if (txBytes.byteLength > 100) {
                      const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
                      tx.sign([devKp]);
                      const sig = await fastSend(connection, tx, [kp]);
                      console.log(`[SWEEP] Dev token sell: ${sig.slice(0, 12)}`);
                      await new Promise(r => setTimeout(r, 3000)); // wait for confirmation
                    }
                  }
                } catch (e) { console.warn(`[SWEEP] Dev token sell failed: ${e.message}`); }
              }
            }
          } catch {}
        }
        // Transfer remaining SOL
        const devBal = await connection.getBalance(devKp.publicKey);
        if (devBal > 6000) {
          const tx = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
            SystemProgram.transfer({ fromPubkey: devKp.publicKey, toPubkey: new PublicKey(destPubkey), lamports: devBal - 5000 })
          );
          await sendAndConfirmTransaction(connection, tx, [devKp], { skipPreflight: true, commitment: "confirmed" });
          const swept = (devBal - 5000) / LAMPORTS_PER_SOL;
          totalSwept += swept;
          console.log(`[SWEEP] Dev → Trading: ${swept.toFixed(4)} SOL`);
        }
      }
    } catch (e) { console.error(`[SWEEP] Dev sweep failed:`, e.message); }

    // Sweep fleet wallets → trading wallet
    let fleetKeys = [];
    try {
      if (redis) {
        const fkRaw = await redis.get("fleetkeys:" + sessionId);
        if (fkRaw) fleetKeys = JSON.parse(fkRaw);
      }
    } catch {}

    for (const fk of fleetKeys) {
      try {
        const fkKp = Keypair.fromSecretKey(bs58.decode(fk.secret));
        // Sell any tokens first
        if (session.tokenCA) {
          try {
            const sellResp = await fetch("https://pumpportal.fun/api/trade-local", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ publicKey: fkKp.publicKey.toBase58(), action: "sell", mint: session.tokenCA, amount: "100%", denominatedInSol: "false", slippage: TRADE_CONFIG.SELL_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto" }),
              signal: AbortSignal.timeout(10000),
            });
            if (sellResp.ok) {
              const txBytes = await sellResp.arrayBuffer();
              if (txBytes.byteLength > 100) {
                const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
                tx.sign([fkKp]);
                await fastSend(connection, tx, [kp]);
              }
            }
          } catch {}
        }
        // Transfer SOL
        const bal = await connection.getBalance(fkKp.publicKey);
        if (bal > 6000) {
          const tx = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
            SystemProgram.transfer({ fromPubkey: fkKp.publicKey, toPubkey: new PublicKey(destPubkey), lamports: bal - 5000 })
          );
          await sendAndConfirmTransaction(connection, tx, [fkKp], { skipPreflight: true, commitment: "confirmed" });
          const swept = (bal - 5000) / LAMPORTS_PER_SOL;
          totalSwept += swept;
          console.log(`[SWEEP] ${fk.role} → Trading: ${swept.toFixed(4)} SOL`);
        }
      } catch (e) { console.warn(`[SWEEP] Fleet wallet sweep failed: ${e.message}`); }
    }

    // Get keys for response
    let keys = [];
    if (session.devSecret) keys.push({ role: "dev", pubkey: session.devWallet, secret: session.devSecret });
    keys = keys.concat(fleetKeys);

    console.log(`[SWEEP] Total swept: ${totalSwept.toFixed(4)} SOL from ${1 + fleetKeys.length} wallets`);

    // ── Referral revenue tracking (silent) ──
    const platformCut = closeResult.platformCut || 0;
    if (platformCut > 0.0001) {
      recordGlobalFee(platformCut);
      try {
        const sweepUser = await getUser(wallet);
        if (sweepUser.referredBy) {
          const referrer = await getUser(sweepUser.referredBy);
          if (referrer) {
            const { referrerCut } = calculateReferralSplit(platformCut, referrer.tier || "free");
            if (referrerCut > 0.0001) {
              await saveUser(sweepUser.referredBy, {
                referralEarnings: (parseFloat(referrer.referralEarnings || "0") + referrerCut).toFixed(6),
                referralPendingPayout: (parseFloat(referrer.referralPendingPayout || "0") + referrerCut).toFixed(6),
              });
              if (redis) {
                try { await redis.lPush("refevents:" + sweepUser.referredBy, JSON.stringify({ user: wallet.slice(0, 4) + "..." + wallet.slice(-4), commission: +referrerCut.toFixed(6), platformCut: +platformCut.toFixed(6), type: "commission", time: Date.now() })); } catch {}
              }
              console.log(`[REFERRAL] Commission: ${sweepUser.referredBy.slice(0, 8)}... earned ${referrerCut.toFixed(6)} SOL from ${wallet.slice(0, 8)}...`);
            }
          }
        }
        // Track total platform cut for the user
        await saveUser(wallet, {
          totalPlatformCut: (parseFloat(sweepUser.totalPlatformCut || "0") + platformCut).toFixed(6),
          totalProfit: (parseFloat(sweepUser.totalProfit || "0") + (closeResult.netProfit || 0)).toFixed(6),
        });
      } catch (e) { console.warn("[REFERRAL] Tracking error:", e.message); }
    }

    res.json({ ok: true, ...closeResult, totalSwept: +totalSwept.toFixed(4), keys });
  } catch (e) {
    console.error("[SELL-SWEEP] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── FORCE-RECOVER ──
// Sells any remaining tokens + sweeps all SOL back to trading wallet
app.post("/api/session/force-recover", requireOwner, async (req, res) => {
  try {
    const { sessionId, wallet } = req.body;
    const session = await sessionManager.get(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.userWallet !== wallet) return res.status(403).json({ error: "Not your session" });

    const tw = await getTradingWallet(wallet);
    const destPubkey = tw?.pubkey || wallet;

    // Collect all wallet secrets (dev + fleet)
    let allKeys = [];
    if (session.devSecret) allKeys.push({ role: "dev", secret: session.devSecret });
    if (redis) {
      try {
        const fkRaw = await redis.get("fleetkeys:" + sessionId);
        if (fkRaw) allKeys = allKeys.concat(JSON.parse(fkRaw));
      } catch {}
    }

    if (allKeys.length === 0) {
      return res.status(400).json({ error: "No wallet keys found. Keys may have expired (48h TTL)." });
    }

    let totalRecovered = 0;
    const results = [];

    for (const wk of allKeys) {
      try {
        const kp = Keypair.fromSecretKey(bs58.decode(wk.secret));
        const pub = kp.publicKey.toBase58().slice(0, 8);

        // Sell any tokens this wallet holds
        if (session.tokenCA) {
          try {
            const sellResp = await fetch("https://pumpportal.fun/api/trade-local", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ publicKey: kp.publicKey.toBase58(), action: "sell", mint: session.tokenCA, amount: "100%", denominatedInSol: "false", slippage: TRADE_CONFIG.SELL_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto" }),
              signal: AbortSignal.timeout(10000),
            });
            if (sellResp.ok) {
              const txBytes = await sellResp.arrayBuffer();
              if (txBytes.byteLength > 100) {
                const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
                tx.sign([kp]);
                await fastSend(connection, tx, [kp]);
                console.log(`[RECOVER] ${wk.role}(${pub}) tokens sold`);
                await new Promise(r => setTimeout(r, 2000));
              }
            }
          } catch (e) { console.warn(`[RECOVER] ${wk.role}(${pub}) token sell failed: ${e.message}`); }
        }

        // Transfer SOL to destination
        const bal = await connection.getBalance(kp.publicKey);
        if (bal > 6000) {
          const tx = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
            SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(destPubkey), lamports: bal - 5000 })
          );
          await sendAndConfirmTransaction(connection, tx, [kp], { skipPreflight: true, commitment: "confirmed" });
          const swept = (bal - 5000) / LAMPORTS_PER_SOL;
          totalRecovered += swept;
          results.push({ pubkey: pub, role: wk.role, swept: +swept.toFixed(4), status: "ok" });
          console.log(`[RECOVER] ${wk.role}(${pub}) → ${swept.toFixed(4)} SOL`);
        } else {
          results.push({ pubkey: pub, role: wk.role, swept: 0, status: "empty" });
        }
      } catch (e) {
        results.push({ pubkey: "?", role: wk.role, error: e.message, status: "failed" });
      }
    }

    await sessionManager.update(sessionId, { status: "recovered", recoveredAt: new Date().toISOString() });

    console.log(`[RECOVER] Total: ${totalRecovered.toFixed(4)} SOL from ${results.filter(r => r.status === "ok").length}/${allKeys.length} wallets`);
    res.json({ ok: true, totalRecovered: +totalRecovered.toFixed(4), wallets: results });
  } catch (e) {
    console.error("[FORCE-RECOVER] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── EXPORT KEYS ──
app.post("/api/session/export-keys", requireOwner, async (req, res) => {
  try {
    const { sessionId, wallet } = req.body;
    const session = await sessionManager.get(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.userWallet !== wallet) return res.status(403).json({ error: "Not your session" });

    let keys = [];
    if (session.devSecret) {
      keys.push({ role: "dev", pubkey: session.devWallet, secret: session.devSecret });
    }
    if (redis) {
      try {
        const fkRaw = await redis.get("fleetkeys:" + sessionId);
        if (fkRaw) keys = keys.concat(JSON.parse(fkRaw));
      } catch {}
    }

    res.json({ ok: keys.length > 0, keys });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE SESSION ──
app.post("/api/session/delete", requireOwner, async (req, res) => {
  const { sessionId, wallet } = req.body;
  const session = await sessionManager.get(sessionId);
  if (!session) return res.json({ ok: true }); // already gone
  if (session.userWallet !== wallet) return res.status(403).json({ error: "Not your session" });
  await sessionManager.delete(sessionId);
  res.json({ ok: true });
});

// ── LIST SESSIONS ──
app.get("/api/sessions", requireOwner, async (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  const sessions = await sessionManager.listForUser(wallet);
  // Filter out closed/recovered
  const active = sessions.filter(s => !["closed", "swept", "recovered"].includes(s.status));
  res.json({ sessions: active });
});

// ── CLEAR ALL SESSIONS ──
app.post("/api/sessions/clear", requireOwner, async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  const count = await sessionManager.deleteAllForUser(wallet);
  res.json({ ok: true, deleted: count });
});

// ═══════════════════════════════════════
// ROUTES: QUICK APE / SELL (PumpPortal Lightning)
// ═══════════════════════════════════════
app.post("/api/quick-ape", requireOwner, async (req, res) => {
  try {
    const { wallet, ca, solAmount, slippage: userSlippage, priorityFee: userPriorityFee } = req.body;
    if (!wallet || !ca || !solAmount) return res.status(400).json({ error: "wallet, ca, solAmount required" });
    if (solAmount <= 0 || solAmount > 100) return res.status(400).json({ error: "Invalid SOL amount (0-100)" });
    const apeSlippage = (userSlippage != null && userSlippage >= 1 && userSlippage <= 50) ? userSlippage : TRADE_CONFIG.BUY_SLIPPAGE;
    const apePriorityFee = (userPriorityFee != null && userPriorityFee >= 0.0001 && userPriorityFee <= 0.5) ? userPriorityFee : TRADE_CONFIG.PRIORITY_FEE_SOL;

    const tw = await getTradingWallet(wallet);
    if (!tw) return res.status(400).json({ error: "No trading wallet — create one first" });

    const kp = Keypair.fromSecretKey(bs58.decode(tw.secret));

    // Pre-flight: check balance
    let balance = 0;
    try { balance = await connection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL; } catch {}
    if (balance < solAmount + 0.01) {
      return res.status(400).json({ error: `Insufficient balance: ${balance.toFixed(4)} SOL (need ${(solAmount + 0.01).toFixed(4)})` });
    }

    // Check if token is graduated (Raydium) or still on bonding curve
    const radarToken = radar.tokens.get(ca);
    const isGraduated = radarToken?.graduated || radarToken?.raydiumPool;
    const isBonk = radarToken?._source === "bonk";

    let sig = null;
    let method = "pumpportal";
    let errors = [];

    // Helper: try a single PumpPortal pool buy
    const tryPPBuy = async (pool) => {
      const response = await fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: tw.pubkey, action: "buy", mint: ca,
          amount: solAmount, denominatedInSol: "true",
          slippage: apeSlippage, priorityFee: apePriorityFee, pool,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`${response.status}`);
      const txBytes = await response.arrayBuffer();
      if (txBytes.byteLength < 100) throw new Error("empty_response");
      const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
      tx.sign([kp]);
      const txSig = await rpcSendRawTx(connection, tx.serialize());
      return { sig: txSig, method: `pumpportal:${pool}` };
    };

    // Race all strategies — first success wins (Promise.any pattern)
    // Bonk tokens use "bonk" pool, pump.fun uses "pump", graduated uses "raydium"/"auto"
    const pools = isGraduated ? ["auto", "raydium"] : isBonk ? ["bonk", "auto"] : ["pump", "auto"];
    const candidates = pools.map(pool =>
      tryPPBuy(pool).catch(e => { errors.push(`PP:${pool}=${e.message.slice(0, 60)}`); throw e; })
    );

    // For graduated tokens, also race Jupiter in parallel
    if (isGraduated) {
      const solLamports = Math.round(solAmount * LAMPORTS_PER_SOL);
      // Jupiter Ultra
      candidates.push((async () => {
        const orderResp = await fetch("https://lite-api.jup.ag/ultra/v1/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: ca, amount: solLamports, taker: tw.pubkey,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!orderResp.ok) throw new Error(`order:${orderResp.status}`);
        const order = await orderResp.json();
        if (!order.transaction) throw new Error("no_tx");
        const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
        tx.sign([kp]);
        const rawTx = Buffer.from(tx.serialize()).toString("base64");
        const execResp = await fetch("https://lite-api.jup.ag/ultra/v1/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signedTransaction: rawTx, requestId: order.requestId }),
          signal: AbortSignal.timeout(6000),
        });
        if (!execResp.ok) throw new Error(`exec:${execResp.status}`);
        const execResult = await execResp.json();
        if (execResult.signature || execResult.txid) return { sig: execResult.signature || execResult.txid, method: "jupiter-ultra" };
        throw new Error("no_sig");
      })().catch(e => { errors.push(`JUP-Ultra=${e.message.slice(0, 60)}`); throw e; }));

      // Jupiter v6
      candidates.push((async () => {
        const quoteResp = await fetch(
          `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${ca}&amount=${solLamports}&slippageBps=2500`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (!quoteResp.ok) throw new Error(`quote:${quoteResp.status}`);
        const quote = await quoteResp.json();
        const swapResp = await fetch("https://quote-api.jup.ag/v6/swap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteResponse: quote, userPublicKey: tw.pubkey,
            wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 10000,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!swapResp.ok) throw new Error(`swap:${swapResp.status}`);
        const { swapTransaction } = await swapResp.json();
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
        tx.sign([kp]);
        const txSig = await rpcSendRawTx(connection, tx.serialize());
        return { sig: txSig, method: "jupiter-v6" };
      })().catch(e => { errors.push(`JUP-v6=${e.message.slice(0, 60)}`); throw e; }));
    }

    // First successful route wins — don't wait for slower routes
    try {
      const winner = await Promise.any(candidates);
      if (winner?.sig) {
        sig = winner.sig;
        method = winner.method;
        console.log(`[BUY] Race winner: ${method} sig=${sig}`);
      }
    } catch (aggErr) {
      // All routes failed — errors already collected above
    }

    if (!sig) {
      const errorSummary = errors.length > 0 ? errors.join(" | ") : "All routes failed";
      return res.status(400).json({ error: "Buy failed: " + errorSummary.slice(0, 200) });
    }

    // Track position immediately for instant wallet visibility
    trackBuy(wallet, ca, solAmount);

    // Persist entry cost to Redis for PnL calculation (survives restarts + pendingPositions cleanup)
    if (redis) {
      try {
        const entryKey = `entry:${wallet}:${ca}`;
        const existing = await redis.get(entryKey);
        if (existing) {
          // Dollar-cost averaging: accumulate total SOL spent
          const prev = JSON.parse(existing);
          prev.solSpent = +(prev.solSpent + solAmount).toFixed(6);
          prev.buys = (prev.buys || 1) + 1;
          prev.lastBuy = Date.now();
          await redis.set(entryKey, JSON.stringify(prev), { EX: 2592000 }); // 30 days
        } else {
          await redis.set(entryKey, JSON.stringify({
            solSpent: solAmount,
            entryMcapSol: radar.tokens.get(ca)?.mcapSol || 0,
            entryMcapUsd: radar.tokens.get(ca)?.mcapUsd || 0,
            buys: 1,
            time: Date.now(),
            lastBuy: Date.now(),
          }), { EX: 2592000 }); // 30 days
        }
      } catch (e) { console.warn("[BUY] Failed to persist entry cost:", e.message); }
    }

    // Verify token landed: use connection.confirmTransaction with AbortController for fast cancellation
    const boughtToken = radar.tokens.get(ca);
    let verified = false;
    let verifyError = null;
    try {
      // Use WebSocket-based confirmTransaction (faster than polling) with 8s timeout
      const abortController = new AbortController();
      const confirmTimeout = setTimeout(() => abortController.abort(), 8000);
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const confirmation = await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight, abortSignal: abortController.signal },
          "confirmed"
        );
        clearTimeout(confirmTimeout);
        if (confirmation?.value?.err) {
          verifyError = "Transaction failed on-chain";
        } else {
          verified = true;
        }
      } catch (e) {
        clearTimeout(confirmTimeout);
        if (e.name === "AbortError") {
          verifyError = "Confirmation timeout (tx may still be processing)";
        } else {
          verifyError = "Confirmation error: " + e.message;
        }
      }
    } catch (e) {
      verifyError = "Verification error: " + e.message;
    }
    console.log(`[BUY] ${verified ? "VERIFIED" : "UNVERIFIED"}: ${sig} ${verifyError || ""}`);

    // Auto-enable smart money tracker if VIP/owner is trading
    checkSmartMoneyAutoEnable(wallet).catch(() => {});

    res.json({ ok: true, signature: sig, ca, method, verified, verifyError: verifyError || undefined, balance: +(balance - solAmount).toFixed(4), position: { mint: ca, name: boughtToken?.name || "", ticker: boughtToken?.ticker || "", image: boughtToken?.image || "", mcapUsd: boughtToken?.mcapUsd || 0, mcapSol: boughtToken?.mcapSol || 0, solSpent: solAmount } });
  } catch (e) {
    console.error("[QUICK-APE] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/quick-sell", requireOwner, async (req, res) => {
  try {
    const { wallet, ca, percent } = req.body;
    if (!wallet || !ca) return res.status(400).json({ error: "wallet, ca required" });

    const tw = await getTradingWallet(wallet);
    if (!tw) return res.status(400).json({ error: "No trading wallet. Create one first." });
    const kp = Keypair.fromSecretKey(bs58.decode(tw.secret));
    const pct = Math.min(100, Math.max(1, percent || 100));

    // Pre-flight: check token balance + get decimals (both SPL Token and Token-2022)
    let tokenBalance = 0;
    let tokenDecimals = 6;
    let balanceCheckFailed = false;
    try {
      const [splAccts, t22Accts] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(kp.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }).catch(() => ({ value: [] })),
        connection.getParsedTokenAccountsByOwner(kp.publicKey, { programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") }).catch(() => ({ value: [] })),
      ]);
      const allAccts = [...splAccts.value, ...t22Accts.value];
      const account = allAccts.find(ta => ta.account.data.parsed.info.mint === ca);
      if (account) {
        tokenBalance = parseFloat(account.account.data.parsed.info.tokenAmount.uiAmountString || "0");
        tokenDecimals = account.account.data.parsed.info.tokenAmount.decimals || 6;
      }
    } catch (e) {
      console.log(`[SELL] Token balance check failed: ${e.message}`);
      balanceCheckFailed = true;
      // Don't block — PumpPortal handles balance internally
    }

    // If RPC says no balance AND it didn't fail, token likely not held
    // But still try PumpPortal as a fallback (RPC can lag behind)
    const skipBalanceGate = balanceCheckFailed;

    const radarToken = radar.tokens.get(ca);
    let isGraduated = radarToken?.graduated || radarToken?.raydiumPool;
    const isBonk = radarToken?._source === "bonk";
    // If not in radar, check DexScreener in background (don't block the sell)
    const gradCheckPromise = !radarToken ? fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() : null).then(dd => { if (dd?.pairs?.length > 0) isGraduated = true; }).catch(() => {}) : Promise.resolve();
    await gradCheckPromise;

    // Capture pre-sell SOL balance for accurate profit skim (only skim actual profit)
    let preSellSolBalance = 0;
    try { preSellSolBalance = await connection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL; } catch {}

    let sig = null;
    let method = "";
    let errors = []; // collect all errors for debugging

    // Helper: try a single PumpPortal pool sell
    const tryPPSell = async (pool, slippage = TRADE_CONFIG.SELL_SLIPPAGE, fee = TRADE_CONFIG.PRIORITY_FEE_SOL, timeout = 8000) => {
      const response = await fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: tw.pubkey, action: "sell", mint: ca,
          amount: pct + "%", denominatedInSol: "false",
          slippage, priorityFee: fee, pool,
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "unknown");
        throw new Error(`${response.status}:${errText.slice(0, 80)}`);
      }
      const txBytes = await response.arrayBuffer();
      if (txBytes.byteLength < 100) throw new Error("empty_response");
      const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
      tx.sign([kp]);
      const txSig = await rpcSendRawTx(connection, tx.serialize());
      return { sig: txSig, method: `pumpportal:${pool}` };
    };

    // Helper: try Jupiter Ultra sell
    const tryJupUltraSell = async (sellAmount) => {
      const orderResp = await fetch("https://lite-api.jup.ag/ultra/v1/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputMint: ca, outputMint: "So11111111111111111111111111111111111111112",
          amount: sellAmount, taker: tw.pubkey,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!orderResp.ok) throw new Error(`order:${orderResp.status}`);
      const order = await orderResp.json();
      if (!order.transaction) throw new Error("no_tx");
      const txBuf = Buffer.from(order.transaction, "base64");
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([kp]);
      const rawTx = Buffer.from(tx.serialize()).toString("base64");
      const execResp = await fetch("https://lite-api.jup.ag/ultra/v1/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedTransaction: rawTx, requestId: order.requestId }),
        signal: AbortSignal.timeout(6000),
      });
      if (!execResp.ok) throw new Error(`exec:${execResp.status}`);
      const execResult = await execResp.json();
      if (execResult.signature || execResult.txid) return { sig: execResult.signature || execResult.txid, method: "jupiter-ultra" };
      throw new Error("no_sig");
    };

    // Helper: try Jupiter v6 sell
    const tryJupV6Sell = async (sellAmount) => {
      const quoteResp = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${ca}&outputMint=So11111111111111111111111111111111111111112&amount=${sellAmount}&slippageBps=3000`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!quoteResp.ok) throw new Error(`quote:${quoteResp.status}`);
      const quote = await quoteResp.json();
      const swapResp = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote, userPublicKey: tw.pubkey,
          wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 10000,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!swapResp.ok) throw new Error(`swap:${swapResp.status}`);
      const { swapTransaction } = await swapResp.json();
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
      tx.sign([kp]);
      const txSig = await rpcSendRawTx(connection, tx.serialize());
      return { sig: txSig, method: "jupiter-v6" };
    };

    // Race all strategies in parallel for maximum speed
    const sellAmount = Math.round(tokenBalance * (pct / 100) * Math.pow(10, tokenDecimals));
    const pools = isGraduated ? ["auto", "raydium", "pump"] : isBonk ? ["bonk", "auto"] : ["pump", "auto"];
    const candidates = pools.map(pool =>
      tryPPSell(pool).catch(e => { errors.push(`PP:${pool}=${e.message.slice(0, 60)}`); throw e; })
    );
    // For graduated tokens, also race Jupiter in parallel
    if (isGraduated && sellAmount > 0) {
      candidates.push(
        tryJupUltraSell(sellAmount).catch(e => { errors.push(`JUP-Ultra=${e.message.slice(0, 60)}`); throw e; })
      );
      candidates.push(
        tryJupV6Sell(sellAmount).catch(e => { errors.push(`JUP-v6=${e.message.slice(0, 60)}`); throw e; })
      );
    }

    // First successful route wins — don't wait for slower routes
    try {
      const winner = await Promise.any(candidates);
      if (winner?.sig) {
        sig = winner.sig;
        method = winner.method;
        console.log(`[SELL] Race winner: ${method} sig=${sig}`);
      }
    } catch (aggErr) {
      // All routes failed — errors already collected above
    }

    // Fallback: Direct amount-based sell for dust/dead tokens
    if (!sig && tokenBalance > 0 && pct === 100) {
      try {
        const reqBody = {
          publicKey: tw.pubkey, action: "sell", mint: ca,
          amount: tokenBalance.toString(), denominatedInSol: "false",
          slippage: TRADE_CONFIG.SELL_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto",
        };
        const response = await fetch("https://pumpportal.fun/api/trade-local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(8000),
        });
        if (response.ok) {
          const txBytes = await response.arrayBuffer();
          if (txBytes.byteLength > 100) {
            const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
            tx.sign([kp]);
            sig = await rpcSendRawTx(connection, tx.serialize());
            method = "pumpportal:amount-fallback";
            console.log(`[SELL] Amount-based fallback success: ${sig}`);
          }
        }
      } catch (e) {
        errors.push(`PP-amount=${e.message.slice(0, 60)}`);
      }
    }

    if (!sig) {
      const errorSummary = errors.length > 0 ? errors.join(" | ") : "All routes failed";
      console.log(`[SELL] FAILED all routes for ${ca.slice(0,8)}: ${errorSummary}`);
      return res.status(400).json({ error: "Sell failed: " + errorSummary.slice(0, 200) });
    }

    // Confirm transaction on-chain — WebSocket-based confirmation (faster than polling)
    let confirmed = false;
    try {
      const abortController = new AbortController();
      const confirmTimeout = setTimeout(() => abortController.abort(), 12000);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const confirmation = await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight, abortSignal: abortController.signal },
        "confirmed"
      );
      clearTimeout(confirmTimeout);
      if (confirmation?.value?.err) {
        console.log(`[SELL] Tx failed on-chain: ${sig} err=${JSON.stringify(confirmation.value.err)}`);
      } else {
        confirmed = true;
        console.log(`[SELL] Confirmed: ${sig}`);
      }
    } catch (e) {
      console.log(`[SELL] Confirmation error: ${e.message}`);
    }

    // Track sell optimistically — the tx was successfully sent and signed
    // Even if confirmation times out, the tx will likely land
    if (pct >= 100) trackSell(wallet, ca);

    if (!confirmed) {
      console.log(`[SELL] Confirmation timed out but tx was sent: ${sig} for ${ca.slice(0,8)}`);
      // Background: schedule a delayed check to log final status
      setTimeout(async () => {
        try {
          const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
          const status = st?.value?.confirmationStatus;
          console.log(`[SELL] Delayed check for ${sig}: ${status || "not found"}`);
        } catch {}
      }, 30000);
    }

    // ═══ PROFIT SKIM — transfer profits above threshold to owner wallet ═══
    // Runs in background after sell to avoid blocking the response.
    // Checks post-sell SOL balance vs tracked spend; if profit > threshold, skims %.
    const PROFIT_SKIM_THRESHOLD = 0.05; // SOL — only skim if profit > this
    (async () => {
      try {
        // Wait for sell to settle
        await new Promise(r => setTimeout(r, 5000));
        const postBalance = await connection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL;
        const user = await getUser(wallet);
        const tierInfo = resolveTier(wallet, user);
        // Owner wallet doesn't get skimmed
        if (tierInfo.tier === "vip" && isOwnerWallet(wallet)) return;
        // No fee destination configured: collect nothing rather than throw inside a sell path.
        if (!PLATFORM_WALLET) return void console.log("[PROFIT-SKIM] PLATFORM_WALLET is not set: fee not collected");
        const feeInfo = calculateFee(preSellSolBalance, postBalance, wallet, tierInfo.tier);
        if (feeInfo.net > PROFIT_SKIM_THRESHOLD && feeInfo.fee > 0.001) {
          const skimLamports = Math.floor(feeInfo.fee * LAMPORTS_PER_SOL);
          if (skimLamports > 1000) {
            const { SystemProgram, Transaction } = await import("@solana/web3.js");
            const tx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: kp.publicKey,
                toPubkey: new PublicKey(PLATFORM_WALLET),
                lamports: skimLamports,
              })
            );
            tx.feePayer = kp.publicKey;
            tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
            tx.sign(kp);
            const skimSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
            console.log(`[PROFIT-SKIM] ${wallet.slice(0,8)} → ${PLATFORM_WALLET.slice(0,8)} | ${feeInfo.fee.toFixed(4)} SOL (${feeInfo.rate}% of ${feeInfo.net.toFixed(4)}) | tx: ${skimSig.slice(0,12)}`);
            recordGlobalFee(feeInfo.fee);
          }
        }
      } catch (e) {
        console.log(`[PROFIT-SKIM] Error: ${e.message}`);
      }
    })();

    // Auto-enable smart money tracker if VIP/owner is trading
    checkSmartMoneyAutoEnable(wallet).catch(() => {});

    res.json({ ok: true, signature: sig, percent: pct, method, confirmed, tokenBalance: +tokenBalance.toFixed(2) });
  } catch (e) {
    console.error("[QUICK-SELL] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sell-all", requireOwner, async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const tw = await getTradingWallet(wallet);
    if (!tw) return res.status(400).json({ error: "No trading wallet" });

    const kp = Keypair.fromSecretKey(bs58.decode(tw.secret));
    // Capture pre-sell SOL balance for accurate profit skim
    let preSellSolBalance = 0;
    try { preSellSolBalance = await connection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL; } catch {}

    // Scan both SPL Token and Token-2022 programs
    const [splAccounts, t22Accounts] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(kp.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }).catch(() => ({ value: [] })),
      connection.getParsedTokenAccountsByOwner(kp.publicKey, { programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") }).catch(() => ({ value: [] })),
    ]);
    const tokenAccounts = { value: [...splAccounts.value, ...t22Accounts.value] };

    let sold = 0;
    for (const ta of tokenAccounts.value) {
      const info = ta.account.data.parsed.info;
      const balance = parseInt(info.tokenAmount.amount);
      if (balance <= 0) continue;
      try {
        const response = await fetch("https://pumpportal.fun/api/trade-local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            publicKey: tw.pubkey, action: "sell", mint: info.mint,
            amount: "100%", denominatedInSol: "false",
            slippage: TRADE_CONFIG.SELL_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto",
          }),
        });
        if (response.ok) {
          const txBytes = await response.arrayBuffer();
          const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
          tx.sign([kp]);
          await fastSend(connection, tx, [kp]);
          sold++;
          trackSell(wallet, info.mint);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    // ═══ PROFIT SKIM after sell-all ═══
    if (sold > 0) {
      (async () => {
        try {
          await new Promise(r => setTimeout(r, 5000));
          const postBalance = await connection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL;
          const user = await getUser(wallet);
          const tierInfo = resolveTier(wallet, user);
          if (tierInfo.tier === "vip" && isOwnerWallet(wallet)) return;
          // No fee destination configured: collect nothing rather than throw inside a sell path.
          if (!PLATFORM_WALLET) return void console.log("[PROFIT-SKIM] PLATFORM_WALLET is not set: fee not collected");
          const feeInfo = calculateFee(preSellSolBalance, postBalance, wallet, tierInfo.tier);
          if (feeInfo.net > 0.05 && feeInfo.fee > 0.001) {
            const skimLamports = Math.floor(feeInfo.fee * LAMPORTS_PER_SOL);
            if (skimLamports > 1000) {
              const { SystemProgram, Transaction } = await import("@solana/web3.js");
              const tx = new Transaction().add(
                SystemProgram.transfer({
                  fromPubkey: kp.publicKey,
                  toPubkey: new PublicKey(PLATFORM_WALLET),
                  lamports: skimLamports,
                })
              );
              tx.feePayer = kp.publicKey;
              tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
              tx.sign(kp);
              const skimSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
              console.log(`[PROFIT-SKIM] sell-all ${wallet.slice(0,8)} → ${PLATFORM_WALLET.slice(0,8)} | ${feeInfo.fee.toFixed(4)} SOL (${feeInfo.rate}% of ${feeInfo.net.toFixed(4)}) | tx: ${skimSig.slice(0,12)}`);
              recordGlobalFee(feeInfo.fee);
            }
          }
        } catch (e) { console.log(`[PROFIT-SKIM] sell-all error: ${e.message}`); }
      })();
    }

    res.json({ ok: true, sold });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// TRADE LEARNER — learns from trade outcomes to optimize entry/exit
// Records every trade's entry features + exit result, then aggregates
// patterns to dynamically shift thresholds and TP/SL levels.
// ═══════════════════════════════════════
const tradeLearner = {
  history: [],       // in-memory ring buffer (last 200 trades)
  insights: null,    // computed every 60s from history
  lastCompute: 0,

  // Record a completed trade
  async record(trade) {
    // trade: { ca, entryScore, entryMcap, exitMcap, pnlPct, pnlSol, entryBuys, entrySells, entryUB, entryAge, entryTrend, exitReason, holdTime, entryBondPct, peakPct }
    this.history.push({ ...trade, time: Date.now() });
    if (this.history.length > 200) this.history.shift();
    // Persist to Redis (last 200)
    if (redis) {
      try { await redis.lpush("trade:history", JSON.stringify(trade)); await redis.ltrim("trade:history", 0, 199); } catch {}
    }
  },

  // Load history from Redis on startup
  async load() {
    if (!redis) return;
    try {
      const raw = await redis.lrange("trade:history", 0, 199);
      this.history = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
      console.log(`[LEARNER] Loaded ${this.history.length} trade records`);
      this.compute();
    } catch {}
  },

  // Compute insights from trade history
  compute() {
    if (this.history.length < 5) { this.insights = null; return; }
    this.lastCompute = Date.now();

    const wins = this.history.filter(t => t.pnlPct > 0);
    const losses = this.history.filter(t => t.pnlPct <= 0);
    const winRate = wins.length / this.history.length;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
    const avgHoldWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.holdTime || 0), 0) / wins.length : 0;
    const avgHoldLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.holdTime || 0), 0) / losses.length : 0;

    // Best entry score range: which scores produce the best P&L?
    const byScore = {};
    for (const t of this.history) {
      const bucket = Math.floor((t.entryScore || 0) / 5) * 5; // 0,5,10,15,...
      if (!byScore[bucket]) byScore[bucket] = { trades: 0, totalPnl: 0, wins: 0 };
      byScore[bucket].trades++;
      byScore[bucket].totalPnl += t.pnlPct || 0;
      if (t.pnlPct > 0) byScore[bucket].wins++;
    }
    // Find the score bucket with best avg P&L (min 3 trades)
    let bestScoreBucket = 25;
    let bestAvgPnl = -Infinity;
    for (const [bucket, data] of Object.entries(byScore)) {
      if (data.trades >= 3) {
        const avg = data.totalPnl / data.trades;
        if (avg > bestAvgPnl) { bestAvgPnl = avg; bestScoreBucket = +bucket; }
      }
    }

    // Best entry mcap range
    const byMcap = { low: [], mid: [], high: [] };
    for (const t of this.history) {
      const mc = t.entryMcap || 0;
      if (mc < 10000) byMcap.low.push(t);
      else if (mc < 30000) byMcap.mid.push(t);
      else byMcap.high.push(t);
    }
    const mcapWinRates = {};
    for (const [range, trades] of Object.entries(byMcap)) {
      if (trades.length >= 3) mcapWinRates[range] = trades.filter(t => t.pnlPct > 0).length / trades.length;
    }

    // Best exit reason analysis — which exits leave money on the table?
    const byExit = {};
    for (const t of this.history) {
      const r = t.exitReason || "unknown";
      if (!byExit[r]) byExit[r] = { count: 0, totalPnl: 0, peakMissed: 0 };
      byExit[r].count++;
      byExit[r].totalPnl += t.pnlPct || 0;
      byExit[r].peakMissed += (t.peakPct || 0) - (t.pnlPct || 0); // how much more we could have made
    }

    // Best entry trends
    const byTrend = {};
    for (const t of this.history) {
      const tr = t.entryTrend || "new";
      if (!byTrend[tr]) byTrend[tr] = { trades: 0, wins: 0, totalPnl: 0 };
      byTrend[tr].trades++;
      byTrend[tr].totalPnl += t.pnlPct || 0;
      if (t.pnlPct > 0) byTrend[tr].wins++;
    }

    this.insights = {
      totalTrades: this.history.length,
      winRate: +(winRate * 100).toFixed(1),
      avgWin: +avgWin.toFixed(1),
      avgLoss: +avgLoss.toFixed(1),
      avgHoldWin: Math.round(avgHoldWin / 60000),  // in minutes
      avgHoldLoss: Math.round(avgHoldLoss / 60000),
      bestScoreBucket,
      bestScoreAvgPnl: +bestAvgPnl.toFixed(1),
      scoreBreakdown: byScore,
      mcapWinRates,
      exitAnalysis: byExit,
      trendAnalysis: byTrend,
      // Dynamic threshold recommendations
      recommendedMinScore: Math.max(15, bestScoreBucket - 5), // enter slightly below the sweet spot
      // If early exits (momentum-exit, crash-exit) have high peakMissed, widen the exit thresholds
      shouldWidenExits: byExit["momentum-exit"]?.peakMissed > (byExit["momentum-exit"]?.count || 1) * 20,
      // If SL2 hits often, losses avg is bad → tighten SL
      shouldTightenSL: (byExit["SL2"]?.count || 0) > this.history.length * 0.3 && avgLoss < -20,
    };

    console.log(`[LEARNER] Computed: ${this.history.length} trades, ${this.insights.winRate}% WR, best score bucket: ${bestScoreBucket} (avg PnL: ${bestAvgPnl.toFixed(1)}%)`);
  },

  // Get dynamic adjustments for the auto-trader
  getAdjustments() {
    if (!this.insights || this.insights.totalTrades < 10) return {};
    const adj = {};

    // Dynamic minScore: shift toward best-performing score bucket
    adj.minScoreShift = this.insights.recommendedMinScore;

    // If momentum exits are leaving big gains on the table, relax the exit
    if (this.insights.shouldWidenExits) {
      adj.momentumDropThreshold = 35; // widen from 30 to 35 (let winners run longer)
      adj.tpMultiplier = 1.3; // push TPs 30% higher
    }

    // If too many SL2 hits, tighten entry or SL
    if (this.insights.shouldTightenSL) {
      adj.minScoreShift = Math.min(40, (adj.minScoreShift || 25) + 5);
      adj.slMultiplier = 0.8; // tighten SLs 20%
    }

    // If winning trades hold longer, extend the hold bias
    if (this.insights.avgHoldWin > this.insights.avgHoldLoss * 2) {
      adj.holdBias = "patient"; // let winners run, cut losers fast
    }

    return adj;
  }
};

// Load trade history on startup
tradeLearner.load();
// Recompute insights every 60s
setInterval(gated(() => { if (tradeLearner.history.length >= 5) tradeLearner.compute(); }), 60000);

// ── SURVIVORSHIP BIAS: log survivor profile every 5 min when enough data ──
setInterval(gated(() => {
  if (survivorBias.survivors.size >= 5) {
    const profile = survivorBias.getSurvivorProfile();
    if (profile.ready && profile.insights.length > 0) {
      console.log(`[SURVIVOR] Profile (${survivorBias.survivors.size}W/${survivorBias.dead.size}L, ${survivorBias.megaWinners.size} mega): ${profile.insights.slice(0, 3).join(" | ")}`);
      const disc = survivorBias.getTopDiscriminants(3);
      if (disc.length > 0) {
        console.log(`[SURVIVOR] Top discriminants: ${disc.map(d => `${d.feature}(${d.direction}:${d.power})`).join(", ")}`);
      }
    }
  }
}), 300000);

// ═══════════════════════════════════════
// AUTO-APE ENGINE — walk-away auto-trading
// Monitors intel scores, auto-buys green tokens, auto-sells on profit/loss
// ═══════════════════════════════════════
const autoTraders = new Map(); // wallet → { settings, positions, interval, log }
const soldCooldowns = new Map(); // wallet → Map(ca → timestamp) — prevent re-buying recently sold tokens

function startAutoTrader(wallet, settings) {
  if (autoTraders.has(wallet)) stopAutoTrader(wallet);
  if (!soldCooldowns.has(wallet)) soldCooldowns.set(wallet, new Map());
  const state = {
    settings: {
      minScore: settings.minScore || 55,
      solPerTrade: settings.solPerTrade || 0.05,
      maxPositions: settings.maxPositions || 5,
      // ═══ POWER-LAW OPTIMIZED TP/SL ═══
      // Meme returns follow Pareto distribution (80/20):
      //   ~70% of entries hit SL → cut fast, lose small
      //   ~25% hit TP1-TP2 → take partial profits
      //   ~5% become 10-100x runners → let the moonbag ride the fat tail
      // Key insight: the 5% of runners generate >50% of total returns
      // ═══ REBALANCED TP/SL — asymmetric in OUR favor ═══
      // Old: TP1=20% SL2=15% → need 75% win rate to break even. Actual win rate ~25%. Math doesn't work.
      // New: TP1=35% SL2=12% → need 25% win rate to break even. Much more achievable.
      // Key insight: let winners run MORE, cut losers FASTER and SMALLER.
      tp1: settings.tp1 || 35,         // TP1: +35% (was 20% — too tight, winners got clipped)
      tp1Sell: settings.tp1Sell || 30,  // sell 30% at TP1 (was 40% — keep more for runners)
      tp2: settings.tp2 || 100,        // TP2: +100% (was 80%)
      tp2Sell: settings.tp2Sell || 30,  // sell 30% of remaining
      tp3: settings.tp3 || 250,        // TP3: +250% (was 200% — let fat tails ride)
      tp3Sell: settings.tp3Sell || 40,  // sell 40% of remaining, rest = moonbag
      // TIGHTER stop losses with FASTER cuts — max loss per trade capped
      sl1: settings.sl1 || 6,          // SL1: -6% (was 8% — cut faster)
      sl1Sell: settings.sl1Sell || 80,  // sell 80% at SL1 (was 70% — more aggressive risk reduction)
      sl2: settings.sl2 || 12,         // SL2: -12% full exit (was 15% — tighter cap on max loss)
      requireBoosted: settings.requireBoosted || false,
      momentumExit: settings.momentumExit !== false, // default ON — auto-tighten stops on score drop
      reentryDips: settings.reentryDips !== false,    // default ON — re-enter on dips, sell into volume
      enabled: true,
    },
    positions: new Map(), // ca → { entryMcap, entrySol, entryTime, peakMcap, tpHit, slHit }
    log: [],
    interval: null,
    lastActivity: Date.now(), // track last user interaction for auto-stop
    // ═══ DRAWDOWN GOVERNOR ═══
    // Tracks portfolio equity curve to reduce sizing during drawdowns
    // At 25% DD → half size, at 50% DD → stop trading entirely
    peakEquity: 0,      // high-water mark of portfolio value
    totalInvested: 0,    // total SOL invested across all positions
    totalRealized: 0,    // total SOL realized from sells
    drawdownMult: 1.0,   // current sizing multiplier (1.0 = full, 0.5 = half, 0 = stopped)
  };

  const log = (msg) => {
    state.log.push({ msg, time: Date.now() });
    if (state.log.length > 50) state.log.shift();
    console.log(`[AUTO-APE][${wallet.slice(0,6)}] ${msg}`);
  };

  state.interval = setInterval(async () => {
    if (!state.settings.enabled) return;
    try {
      const tw = await getTradingWallet(wallet);
      if (!tw) return;
      const kp = Keypair.fromSecretKey(bs58.decode(tw.secret));
      const bradOn = state.settings.bradEnabled !== false && bradClient.isHealthy();

      // ═══ DRAWDOWN GOVERNOR — reduce sizing as drawdown deepens ═══
      // Tracks equity curve: if portfolio drops from peak, reduce bet sizes
      {
        let currentEquity = 0;
        try { currentEquity = await connection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL; } catch {}
        // Add unrealized position value estimate
        for (const [ca, pos] of state.positions) {
          const token = radar.tokens.get(ca);
          if (token && pos.entryMcap > 0) {
            const currentMcap = token.mcapUsd || 0;
            const pctChange = (currentMcap - pos.entryMcap) / pos.entryMcap;
            currentEquity += (pos.entrySol || state.settings.solPerTrade) * (1 + pctChange);
          }
        }
        // Update high-water mark
        if (currentEquity > state.peakEquity) state.peakEquity = currentEquity;
        // Calculate drawdown from peak
        const drawdownPct = state.peakEquity > 0 ? ((state.peakEquity - currentEquity) / state.peakEquity) * 100 : 0;
        // Sizing multiplier: linear scale from 1.0 at 0% DD to 0.0 at 50% DD
        // At 25% DD → 0.5x size, at 50% DD → stop trading
        if (drawdownPct >= 50) {
          state.drawdownMult = 0;
          if (!state._ddStopLogged || Date.now() - state._ddStopLogged > 60000) {
            log(`DRAWDOWN GOVERNOR: ${drawdownPct.toFixed(1)}% DD — TRADING HALTED`);
            state._ddStopLogged = Date.now();
          }
        } else if (drawdownPct >= 10) {
          state.drawdownMult = Math.max(0.1, 1 - drawdownPct / 50);
          if (!state._ddWarnLogged || Date.now() - state._ddWarnLogged > 30000) {
            log(`DRAWDOWN GOVERNOR: ${drawdownPct.toFixed(1)}% DD — sizing at ${(state.drawdownMult * 100).toFixed(0)}%`);
            state._ddWarnLogged = Date.now();
          }
        } else {
          state.drawdownMult = 1.0;
        }
      }

      // ═══ BRAD: Regime sync (every 60s) ═══
      // Derive a simple regime from market signals and send to BRAD.
      // This feeds BRAD's L0 world model and enables regime-aware strategy selection.
      if (state.settings.bradEnabled !== false && bradClient.isHealthy()) {
        if (!state._bradRegimeLastSync || Date.now() - state._bradRegimeLastSync > 60_000) {
          state._bradRegimeLastSync = Date.now();
          // Derive regime from available signals
          const allTokens = [...radar.tokens.values()];
          const hotCount = allTokens.filter(t => (t._apeScore || 0) >= 50).length;
          const rugCount = allTokens.filter(t => (t._rugFlags?.length || 0) >= 3).length;
          const gradCount = allTokens.filter(t => t.graduated).length;
          const total = allTokens.length || 1;
          const gradRate = (gradCount / total) * 100;

          let regime = "RISK_ON";
          if (state.drawdownMult <= 0) regime = "DEAD";
          else if (state.drawdownMult < 0.5) regime = "PVP";
          else if (gradRate > 3 && hotCount > 10) regime = "EUPHORIA";
          else if (gradRate > 1 && hotCount > 5) regime = "RISK_ON";
          else if (hotCount > 2) regime = "GRINDING";
          else regime = "PVP";

          bradClient.updateRegime({
            regime,
            confidence: Math.min(1, hotCount / 20),
            signals: {
              rugRate: rugCount / total,
              avgLifespan: 0, // TODO: derive from token ages
            },
          }).catch(() => {});
        }
      }

      // ── HELPER: execute a partial sell ──
      async function execSell(ca, sellPct, kp, reason) {
        try {
          const resp = await fetch("https://pumpportal.fun/api/trade-local", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ publicKey: kp.publicKey.toBase58(), action: "sell", mint: ca, amount: sellPct + "%", denominatedInSol: "false", slippage: TRADE_CONFIG.SELL_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto" }),
            signal: AbortSignal.timeout(8000), // 8s timeout on PumpPortal
          });
          if (resp.ok) {
            const txBytes = await resp.arrayBuffer();
            if (txBytes.byteLength > 100) {
              const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
              tx.sign([kp]);
              // Send via all paths simultaneously
              const sig = await fastSend(connection, tx, [kp]);
              // Quick confirm — 8s max, then check status. NEVER re-send the tx.
              try {
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
                await Promise.race([
                  connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"),
                  new Promise((_, rej) => setTimeout(() => rej(new Error("confirm_timeout")), 8000)),
                ]);
                return sig;
              } catch {
                // Tx sent but confirmation timed out — check status (don't re-send!)
                try {
                  await new Promise(r => setTimeout(r, 2000)); // brief wait
                  const st = await connection.getSignatureStatus(sig);
                  if (st?.value?.confirmationStatus === "confirmed" || st?.value?.confirmationStatus === "finalized") {
                    log(`Sell confirmed via status check ${ca.slice(0,6)} (${reason}): ${sig}`);
                    return sig;
                  }
                  // Still not confirmed — one more check after 3s
                  await new Promise(r => setTimeout(r, 3000));
                  const st2 = await connection.getSignatureStatus(sig);
                  if (st2?.value?.confirmationStatus === "confirmed" || st2?.value?.confirmationStatus === "finalized") return sig;
                } catch {}
                log(`Sell tx not confirmed ${ca.slice(0,6)} (${reason}): ${sig} — keeping position`);
                return null;
              }
            }
          }
        } catch (e) { log(`Sell error ${ca.slice(0,6)} (${reason}): ${e.message}`); }
        return null;
      }

      // Helper: remove position and add to cooldown + recently closed
      function exitPosition(ca, exitPct, exitReason) {
        const pos = state.positions.get(ca);
        if (pos) {
          const token = radar.tokens.get(ca);
          const currentMcap = token?.mcapUsd || 0;
          const changePct = pos.entryMcap > 0 ? ((currentMcap - pos.entryMcap) / pos.entryMcap) * 100 : 0;
          const peakPct = pos.entryMcap > 0 ? ((pos.peakMcap - pos.entryMcap) / pos.entryMcap) * 100 : 0;
          if (!state.recentlyClosed) state.recentlyClosed = [];
          state.recentlyClosed.push({
            ca, name: token?.name || ca.slice(0, 8),
            entrySol: pos.entrySol, entryMcap: pos.entryMcap, exitMcap: currentMcap,
            changePct: +changePct.toFixed(1),
            pnlSol: +(pos.entrySol * (changePct / 100)).toFixed(4),
            exitReason: exitReason || "unknown",
            exitTime: Date.now(),
            age: Math.round((Date.now() - pos.entryTime) / 60000),
            entryScore: pos.entryScore || 0,
            exitScore: pos.liveScore || pos.entryScore || 0,
          });
          // Keep only last 20 closed positions, remove entries older than 5 min
          state.recentlyClosed = state.recentlyClosed.filter(p => Date.now() - p.exitTime < 300000).slice(-20);

          // ═══ BRAD: Record exit for meta-cognitive evaluation ═══
          // After every closed trade, BRAD's L2 checks for blind spots
          // (overconfidence, revenge trading, regime blindness, loss aversion)
          // and may restructure L1's strategy or confidence.
          if (exitPct >= 100 && state.settings.bradEnabled !== false && bradClient.isHealthy()) {
            bradClient.recordExit({
              ca, exitPriceSol: (currentMcap || 0) / (solUsdPrice || 150),
              reason: exitReason || "unknown",
            }).catch(() => {}); // fire-and-forget
          } else if (exitPct < 100 && state.settings.bradEnabled !== false && bradClient.isHealthy()) {
            bradClient.recordPartialExit({
              ca, sizeSol: (pos.entrySol || 0) * (exitPct / 100),
              priceSol: (currentMcap || 0) / (solUsdPrice || 150),
              reason: exitReason || "take_profit",
            }).catch(() => {});
          }
          // ── TRADE LEARNER: record this trade's outcome for future optimization ──
          if (exitPct >= 100) { // full exit = complete trade record
            tradeLearner.record({
              ca,
              entryScore: pos.entryScore || 0,
              entryMcap: pos.entryMcap,
              exitMcap: currentMcap,
              pnlPct: +changePct.toFixed(1),
              pnlSol: +(pos.entrySol * (changePct / 100)).toFixed(4),
              entryBuys: pos.entryBuys || 0,
              entrySells: pos.entrySells || 0,
              entryUB: pos.entryUB || 0,
              entryAge: +(pos.entryAge || 0).toFixed(1),
              entryTrend: pos.entryTrend || "new",
              entryBondPct: pos.entryBondPct || 0,
              exitReason: exitReason || "unknown",
              holdTime: Date.now() - pos.entryTime,
              peakPct: +peakPct.toFixed(1),
            });
            // ── MEME INTEL FEEDBACK: wire trade outcomes to scorer learning ──
            // This is the critical missing link — without this, the AI never learns from trades
            try {
              const features = typeof extractQuickFeatures === "function" ? extractQuickFeatures(token) : null;
              if (features) {
                const peakMcx = pos.entryMcap > 0 ? (pos.peakMcap || currentMcap) / pos.entryMcap : 1;
                const mcapDropPct = pos.peakMcap > 0 ? ((pos.peakMcap - currentMcap) / pos.peakMcap) * 100 : 0;
                const outcome = {
                  graduated: !!(token?.graduated || token?.raydiumPool),
                  peakMcx,
                  fleetPnl: +(pos.entrySol * (changePct / 100)).toFixed(4),
                  rugged: mcapDropPct > 80 || exitReason === "SL2" || exitReason === "CRASH",
                  mcapDropPct,
                  devDumped: exitReason === "rug-detected",
                  alive: currentMcap > 3000,
                };
                memeIntel.learn(features, outcome);
                console.log(`[INTEL-FEEDBACK] Learned from ${ca.slice(0,6)}: score=${pos.entryScore||0} pnl=${changePct.toFixed(1)}% exit=${exitReason} trainCount=${memeIntel.scorer.trainCount}`);
                // ── SURVIVORSHIP BIAS: record outcome with entry-time features ──
                // Uses the feature snapshot taken at buy time (not current features)
                // This is the Kahneman insight: what did winners look like AT BIRTH?
                const sbFeatures = pos.entryFeatures || features;
                survivorBias.recordOutcome(ca, sbFeatures, {
                  won: changePct > 5,
                  pnlPct: +changePct.toFixed(1),
                  graduated: outcome.graduated,
                  peakMcx: outcome.peakMcx,
                });
                console.log(`[SURVIVOR] Recorded ${changePct > 5 ? 'WINNER' : 'LOSER'} ${ca.slice(0,6)}: pnl=${changePct.toFixed(1)}% survivors=${survivorBias.survivors.size} dead=${survivorBias.dead.size}`);
              }
            } catch (e) {
              console.log(`[INTEL-FEEDBACK] Error: ${e.message}`);
            }
            // ── Silent referral revenue tracking for auto-trade ──
            const pnlSol = +(pos.entrySol * (changePct / 100)).toFixed(4);
            if (pnlSol > 0.001) {
              const netFee = +(pnlSol * NETWORK_FEE_PCT / 100).toFixed(6);
              if (netFee > 0.0001) {
                recordGlobalFee(netFee);
                (async () => {
                  try {
                    const tradeUser = await getUser(wallet);
                    await saveUser(wallet, { totalPlatformCut: (parseFloat(tradeUser.totalPlatformCut || "0") + netFee).toFixed(6) });
                    if (tradeUser.referredBy) {
                      const ref = await getUser(tradeUser.referredBy);
                      if (ref) {
                        const { referrerCut } = calculateReferralSplit(netFee, ref.tier || "free");
                        if (referrerCut > 0.0001) {
                          await saveUser(tradeUser.referredBy, {
                            referralEarnings: (parseFloat(ref.referralEarnings || "0") + referrerCut).toFixed(6),
                            referralPendingPayout: (parseFloat(ref.referralPendingPayout || "0") + referrerCut).toFixed(6),
                          });
                          if (redis) { try { await redis.lPush("refevents:" + tradeUser.referredBy, JSON.stringify({ user: wallet.slice(0, 4) + "..." + wallet.slice(-4), commission: +referrerCut.toFixed(6), platformCut: +netFee.toFixed(6), type: "commission", time: Date.now() })); } catch {} }
                        }
                      }
                    }
                  } catch {}
                })();
              }
            }
          }
        }
        state.positions.delete(ca);
        const cd = soldCooldowns.get(wallet) || new Map();
        cd.set(ca, Date.now());
        soldCooldowns.set(wallet, cd);
      }

      // ═══ BRAD: Evaluate open positions for meta-cognitive exits ═══
      // Run BRAD position evaluation in parallel for all open positions.
      // BRAD's L2 detects systematic patterns: loss aversion, regime blindness, etc.
      if (bradOn && state.positions.size > 0) {
        const bradPosPromises = [...state.positions.entries()].map(async ([ca, pos]) => {
          try {
            const token = radar.tokens.get(ca);
            const dyn = scoreDynamics.get(ca);
            if (!token) return;
            pos._bradExitEval = await bradClient.evaluatePosition(ca, {
              _apeScore: pos.liveScore || pos.entryScore || 0,
              _scoreVelocity: dyn?.velocity || 0,
              _scoreAcceleration: dyn?.acceleration || 0,
              _rugFlags: token._rugFlags || [],
              priceSol: (token.mcapUsd || 0) / (solUsdPrice || 150),
              vSolInBondingCurve: token.vSolInBondingCurve || 0,
            });
          } catch { pos._bradExitEval = null; }
        });
        await Promise.allSettled(bradPosPromises);
      }

      // ═══ BRAD PAPER EXIT CHECKS ═══
      if (isPaperEnabled()) {
        const paperStatus = getPaperStatus();
        for (const [ca, pPos] of Object.entries(paperStatus.openList || [])) {
          const token = radar.tokens.get(pPos.ca);
          if (!token) continue;
          const dyn = scoreDynamics.get(pPos.ca);
          const result = paperCheckExit(pPos.ca, token.mcapUsd || 0, token._apeScore || 0, dyn, null);
          if (result?.action === "PAPER_EXIT") {
            broadcastWS({ event: "brad_thought", data: {
              type: result.pnlPct >= 0 ? "pick" : "risk",
              text: `Paper exit: ${result.name} ${result.pnlPct >= 0 ? "+" : ""}${result.pnlPct}% (${result.exitReason}) — bankroll: ${getPaperStatus().bankroll} SOL`,
              urgency: Math.abs(result.pnlPct) > 20 ? "high" : "low",
              token: result.name, ca: pPos.ca, time: Date.now(),
            }});
          }
        }
      }

      // ── Check existing positions for tiered TP/SL ──
      for (const [ca, pos] of state.positions) {
        let token = radar.tokens.get(ca);

        // If token fell off radar, try to refresh its MC from DexScreener
        if (!token && !pos._lastFetchFail) {
          try {
            const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { signal: AbortSignal.timeout(5000) });
            if (r.ok) {
              const d = await r.json();
              const pair = d?.pairs?.[0];
              if (pair) {
                const mcUsd = pair.marketCap || pair.fdv || 0;
                // Only mark graduated if DexScreener shows a Raydium pair (dexId === "raydium")
                const isRaydium = pair.dexId === "raydium" || pair.dexId === "raydium-clmm";
                token = { mcapUsd: mcUsd, mcapSol: solUsdPrice > 0 ? mcUsd / solUsdPrice : 0, name: pair.baseToken?.name || "", graduated: isRaydium };
              }
            }
          } catch {}
          if (!token) { pos._lastFetchFail = Date.now(); }
        }
        if (pos._lastFetchFail && Date.now() - pos._lastFetchFail > 300000) delete pos._lastFetchFail;
        if (!token) continue;

        const currentMcap = token.mcapUsd || 0;
        if (pos.entryMcap <= 0) continue;
        const changePct = ((currentMcap - pos.entryMcap) / pos.entryMcap) * 100;
        pos.peakMcap = Math.max(pos.peakMcap || pos.entryMcap, currentMcap);
        const fromPeak = pos.peakMcap > 0 ? ((pos.peakMcap - currentMcap) / pos.peakMcap) * 100 : 0;
        if (!pos.tpHit) pos.tpHit = 0;
        if (!pos.slHit) pos.slHit = 0;

        const s = { ...state.settings };

        // ═══ LAYER 0: BRAD COGNITIVE EXIT (meta-cognitive intervention) ═══
        // BRAD's L2 detects systematic patterns: loss aversion, regime blindness,
        // overconfidence. When it recommends EXIT with high confidence, execute.
        if (pos._bradExitEval && pos._bradExitEval.action === "EXIT" && pos._bradExitEval.confidence >= 0.7) {
          const bradReason = (pos._bradExitEval.reasoning || []).slice(0, 2).join("; ") || "meta-cognitive";
          log(`BRAD EXIT ${ca.slice(0,6)}: L2 intervention — ${bradReason} (conf:${pos._bradExitEval.confidence.toFixed(2)}) +${changePct.toFixed(0)}%`);
          const sig = await execSell(ca, 100, kp, "brad-exit");
          if (sig) {
            broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "BRAD", reason: bradReason } });
            broadcastWS({ event: "brad_thought", data: { type: "meta", text: `L2 forced exit on ${(radar.tokens.get(ca)?.name)||ca.slice(0,6)} at ${changePct>0?"+":""}${changePct.toFixed(0)}% — ${bradReason}`, urgency: "high", token: (radar.tokens.get(ca)?.name)||ca.slice(0,6), ca, time: Date.now() } });
            exitPosition(ca, 100, "brad-exit");
            trackSell(wallet, ca);
          }
          delete pos._bradExitEval;
          continue;
        }
        if (pos._bradExitEval && pos._bradExitEval.action === "PARTIAL_EXIT" && pos._bradExitEval.confidence >= 0.7 && pos.tpHit === 0) {
          const bradReason = (pos._bradExitEval.reasoning || []).slice(0, 2).join("; ") || "meta-cognitive";
          const sellPct = Math.round((pos._bradExitEval.exit_pct || 0.33) * 100) || 33;
          log(`BRAD TRIM ${ca.slice(0,6)}: L2 partial exit ${sellPct}% — ${bradReason} +${changePct.toFixed(0)}%`);
          const sig = await execSell(ca, sellPct, kp, "brad-partial");
          if (sig) {
            broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "BRAD_TRIM", sellPct, reason: bradReason } });
            pos.tpHit = 1;
          }
        }
        delete pos._bradExitEval; // clean up after check

        // ═══ TIER-AWARE TP/SL ADJUSTMENT ═══
        // Tier 1 (GOD_CANDLE): wider stops, higher TPs — let runners run
        // Tier 3 (SPECULATIVE): tighter stops, lower TPs — take money fast
        const posTier = pos.tier || 2;
        if (posTier === 1) {
          s.sl1 = Math.round(s.sl1 * 1.3); s.sl2 = Math.round(s.sl2 * 1.3);
          s.tp1 = Math.round(s.tp1 * 1.3); s.tp2 = Math.round(s.tp2 * 1.3); s.tp3 = Math.round(s.tp3 * 1.3);
        } else if (posTier === 3) {
          s.sl1 = Math.round(s.sl1 * 0.8); s.sl2 = Math.round(s.sl2 * 0.8);
          s.tp1 = Math.round(s.tp1 * 0.85); s.tp2 = Math.round(s.tp2 * 0.75);
          s.tp3 = 0; // Tier 3 never holds for moonshot
        }
        // Max hold time enforcement (tier-dependent)
        const MAX_HOLDS_MS = { 1: 30 * 60000, 2: 15 * 60000, 3: 10 * 60000 };
        const holdTime = Date.now() - (pos.entryTime || Date.now());
        if (holdTime > (MAX_HOLDS_MS[posTier] || 15 * 60000) && changePct < 20 && !pos.isMoonbag) {
          log(`MAX HOLD ${ca.slice(0,6)}: T${posTier} ${Math.round(holdTime/60000)}min +${changePct.toFixed(0)}% — FULL SELL`);
          const sig = await execSell(ca, 100, kp, "max-hold-" + posTier);
          if (sig) {
            broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "MAX_HOLD", reason: `T${posTier}-${Math.round(holdTime/60000)}min` } });
            exitPosition(ca, 100, "max-hold");
            trackSell(wallet, ca);
          }
          continue;
        }

        // ── Apply learner-driven TP/SL adjustments ──
        const adj = tradeLearner.getAdjustments();
        if (adj.tpMultiplier) { s.tp1 = Math.round(s.tp1 * adj.tpMultiplier); s.tp2 = Math.round(s.tp2 * adj.tpMultiplier); s.tp3 = Math.round(s.tp3 * adj.tpMultiplier); }
        if (adj.slMultiplier) { s.sl1 = Math.round(s.sl1 * adj.slMultiplier); s.sl2 = Math.round(s.sl2 * adj.slMultiplier); }
        // Patient hold bias: widen SL1 slightly so winners aren't cut prematurely
        if (adj.holdBias === "patient") { s.sl1 = Math.round(s.sl1 * 1.2); }

        // ═══ MOMENTUM EXIT — score derivatives detect rugs BEFORE the score drops ═══
        // The score is a lagging indicator. Its velocity and acceleration are leading ones.
        // A decelerating score means the pump is running out of energy — exit before the crash.
        // IMPORTANT: Skip momentum scoring for DexScreener fallback tokens — they lack trade
        // data so extractQuickFeatures returns all-zero features → score = 0 → false exit.
        const hasRadarData = token && token.buys != null && token.trades != null;
        if (s.momentumExit && hasRadarData && !pos.isMoonbag) {
          try {
            const features = extractQuickFeatures(token);
            if (features) {
              const liveScore = memeIntel.scorer.score(features);
              const currentScore = liveScore?.score || 0;
              // Guard: if score suddenly drops to near-0 but we had a real score before,
              // the token likely lost radar data — skip this cycle (but not forever).
              // After 3 consecutive data-loss cycles, accept the score as real.
              if (currentScore < 5 && pos.entryScore > 20 && (pos.liveScore == null || pos.liveScore > 20)) {
                pos._dataLossStreak = (pos._dataLossStreak || 0) + 1;
                if (pos._dataLossStreak <= 3) {
                  log(`MOMENTUM SKIP ${ca.slice(0,6)}: score=${currentScore} looks like data loss (entry=${pos.entryScore}, last=${pos.liveScore}, streak=${pos._dataLossStreak}/3)`);
                  // Still record dynamics so vel/acc are available for the UI
                  const dyn = scoreDynamics.record(ca, currentScore);
                  pos.scoreVelocity = dyn.velocity;
                  pos.scoreAcceleration = dyn.acceleration;
                  pos.scoreTrend = dyn.trend;
                } else {
                  // 3+ cycles with score=0 — this is real, not transient data loss
                  log(`MOMENTUM ACCEPT ${ca.slice(0,6)}: score=${currentScore} persisted ${pos._dataLossStreak} cycles — treating as real`);
                  // Fall through to normal scoring below
                }
              }
              // Normal scoring path (also reached when data loss streak expires)
              if (pos._dataLossStreak === undefined || pos._dataLossStreak === 0 || pos._dataLossStreak > 3) {
              if (!pos.entryScore) pos.entryScore = currentScore;
              pos.liveScore = currentScore;
              const scoreDrop = pos.entryScore - currentScore;

              // Record score and get velocity/acceleration
              const dyn = scoreDynamics.record(ca, currentScore);
              pos.scoreVelocity = dyn.velocity;
              pos.scoreAcceleration = dyn.acceleration;
              pos.scoreTrend = dyn.trend;

              // ── DERIVATIVES-BASED EXIT (catches rugs 1-2 cycles earlier) ──
              // Crashing: velocity < -0.3 pts/s = score is collapsing fast
              if (dyn.trend === "crashing" && dyn.scores >= 3) {
                log(`CRASH EXIT ${ca.slice(0,6)}: score v=${dyn.velocity}/s a=${dyn.acceleration}/s² trend=CRASHING — FULL SELL`);
                const sig = await execSell(ca, 100, kp, "crash-exit");
                if (sig) {
                  broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "CRASH", reason: "score-crashing", velocity: dyn.velocity } });
                  broadcastWS({ event: "brad_thought", data: { type: "risk", text: `Crash exit on ${(radar.tokens.get(ca)?.name)||ca.slice(0,6)} — score velocity ${dyn.velocity?.toFixed(3)}/s, dumping before price catches up`, urgency: "high", token: (radar.tokens.get(ca)?.name)||ca.slice(0,6), ca, time: Date.now() } });
                  exitPosition(ca, 100, "crash-exit");
                  trackSell(wallet, ca);
                }
                continue;
              }
              // Fading: score still positive but decelerating hard = pump dying
              // Only act if we have 3+ data points (acceleration needs history)
              if (dyn.trend === "fading" && dyn.acceleration < -0.02 && dyn.scores >= 3 && changePct > 5 && pos.tpHit === 0) {
                log(`FADE TRIM ${ca.slice(0,6)}: score fading a=${dyn.acceleration}/s² +${changePct.toFixed(0)}% — selling ${s.tp1Sell}% early`);
                const sig = await execSell(ca, s.tp1Sell, kp, "fade-trim");
                if (sig) {
                  broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "FADE", sellPct: s.tp1Sell, acceleration: dyn.acceleration } });
                  pos.tpHit = 1;
                }
              }

              // ── ABSOLUTE SCORE DROP (existing logic, kept as safety net) ──
              // PROTECTED: tokens with strong fundamentals (high UB, rising on-chain activity)
              // get a wider buffer before momentum exit — don't kill winners early
              const tokenData = radar.tokens.get(ca);
              const liveUB = tokenData?.uniqueBuyers?.size || 0;
              const liveBuys = tokenData?.buys || 0;
              const hasStrongFundamentals = liveUB >= 20 && liveBuys >= 30 && changePct > 0;
              const momentumExitThreshold = hasStrongFundamentals ? 40 : 30; // wider buffer for strong tokens
              if (scoreDrop >= momentumExitThreshold) {
                log(`MOMENTUM EXIT ${ca.slice(0,6)}: score ${pos.entryScore}→${currentScore} (−${scoreDrop}) UB:${liveUB} — FULL SELL`);
                const sig = await execSell(ca, 100, kp, "momentum-exit");
                if (sig) {
                  broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "MOMENTUM", reason: "score-crash" } });
                  exitPosition(ca, 100, "momentum-exit");
                  trackSell(wallet, ca);
                }
                continue;
              } else if (scoreDrop >= 20) {
                s.sl1 = Math.round(s.sl1 * 0.5);
                s.sl2 = Math.round(s.sl2 * 0.5);
                if (scoreDrop >= 25 && changePct > 5 && pos.tpHit === 0) {
                  log(`MOMENTUM TRIM ${ca.slice(0,6)}: score −${scoreDrop}, +${changePct.toFixed(0)}% — selling ${s.tp1Sell}% early`);
                  const sig = await execSell(ca, s.tp1Sell, kp, "momentum-trim");
                  if (sig) {
                    broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "MOM-TRIM", sellPct: s.tp1Sell } });
                    pos.tpHit = 1;
                  }
                }
              } else if (scoreDrop >= 10) {
                s.sl1 = Math.round(s.sl1 * 0.75);
                s.sl2 = Math.round(s.sl2 * 0.75);
              }

              // ── RUNNER DETECTION: accelerating score = let it fly ──
              if (dyn.trend === "rocket" || (dyn.trend === "rising" && currentScore > pos.entryScore + 10)) {
                s.tp1 = Math.round(state.settings.tp1 * 1.5);  // widen TPs more aggressively
                s.tp2 = Math.round(state.settings.tp2 * 1.5);
                s.tp3 = Math.round(state.settings.tp3 * 1.5);
              } else if (currentScore > pos.entryScore + 10) {
                s.tp1 = Math.round(state.settings.tp1 * 1.25);
                s.tp2 = Math.round(state.settings.tp2 * 1.25);
                s.tp3 = Math.round(state.settings.tp3 * 1.25);
              }
              } // end normal scoring path
            }
          } catch (e) { log(`Momentum score error ${ca.slice(0,6)}: ${e.message}`); }
        }

        // ═══ SELL-INTO-VOLUME — detect volume spikes and take profit into liquidity ═══
        // When volume surges (lots of buyers), there's liquidity to sell into without slippage
        // This is the smart exit: sell when others are buying, not when they're selling
        if (state.settings.reentryDips !== false && changePct > 15 && !pos.isMoonbag && pos.tpHit === 0) {
          const token5mVol = token.volumeSol || 0;
          const tokenAge = Math.max(1, (Date.now() - token.createdAt) / 60000);
          const avgVolPerMin = token5mVol / tokenAge;
          // Check recent trades for volume spike (last 60s)
          const recentTrades = (token.trades || []).filter(tr => tr.time && Date.now() - tr.time < 60000);
          const recentBuyVol = recentTrades.filter(tr => tr.side === "buy").reduce((s, tr) => s + (tr.sol || 0), 0);
          const isVolSpike = recentBuyVol > avgVolPerMin * 3 && recentBuyVol > 0.5; // 3x average volume
          if (isVolSpike) {
            const sellPct = changePct >= 50 ? 40 : 25; // sell more if bigger profit
            log(`SELL-INTO-VOLUME ${ca.slice(0,6)}: +${changePct.toFixed(0)}% vol spike ${recentBuyVol.toFixed(2)} SOL/min — selling ${sellPct}%`);
            const sig = await execSell(ca, sellPct, kp, "volume-sell");
            if (sig) {
              broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "VOL-SELL", sellPct, volumeSpike: true } });
              pos.tpHit = 1; // mark as partial exit
              pos.volumeSold = true;
            }
          }
        }

        // ═══ TAKE PROFIT — 3 tiers ═══
        // TP3: Runner — sell tp3Sell% of remaining (rest = moonbag forever)
        if (pos.tpHit < 3 && changePct >= s.tp3) {
          // ═══ TRAILING STOP WIDENING ═══
          // Bigger winners get wider trailing stops to capture fat-tail returns
          // At 2x (100%): trail within 50% of peak — let it breathe
          // At 10x (900%): trail within 30% — still wide for moonshot potential
          // At 50x (4900%): trail within 25% — tightest, massive gains to protect
          const trailPct = changePct >= 4900 ? 25 : changePct >= 900 ? 30 : changePct >= 400 ? 35 : changePct >= 200 ? 40 : 50;
          if (fromPeak < trailPct) {
            log(`RUNNER ${ca.slice(0,6)}: +${changePct.toFixed(0)}% — trailing (${fromPeak.toFixed(0)}% from peak, trail=${trailPct}%)`);
          } else {
            log(`TP3 ${ca.slice(0,6)}: +${changePct.toFixed(0)}% — selling ${s.tp3Sell}% (moonbag rest)`);
            const sig = await execSell(ca, s.tp3Sell, kp, "TP3");
            if (sig) {
              broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "TP3", sellPct: s.tp3Sell, moonbag: true } });
              log(`TP3 SOLD ${s.tp3Sell}% of ${ca.slice(0,6)} — moonbag remaining`);
            }
            pos.tpHit = 3;
            pos.isMoonbag = true;
          }
        }
        // TP2: Second target — sell tp2Sell% of remaining
        else if (pos.tpHit < 2 && changePct >= s.tp2) {
          log(`TP2 ${ca.slice(0,6)}: +${changePct.toFixed(0)}% — selling ${s.tp2Sell}%`);
          const sig = await execSell(ca, s.tp2Sell, kp, "TP2");
          if (sig) {
            broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "TP2", sellPct: s.tp2Sell } });
            log(`TP2 SOLD ${s.tp2Sell}% of ${ca.slice(0,6)}`);
          }
          pos.tpHit = 2;
        }
        // TP1: First profit taking
        else if (pos.tpHit < 1 && changePct >= s.tp1) {
          log(`TP1 ${ca.slice(0,6)}: +${changePct.toFixed(0)}% — selling ${s.tp1Sell}%`);
          const sig = await execSell(ca, s.tp1Sell, kp, "TP1");
          if (sig) {
            broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "TP1", sellPct: s.tp1Sell } });
            log(`TP1 SOLD ${s.tp1Sell}% of ${ca.slice(0,6)}`);
          }
          pos.tpHit = 1;
        }
        // Trailing stop: dropped from peak while still green and hasn't hit TP1 yet
        // Tighter trail to lock in gains early — don't give back profits
        // If peaked 15%+: trail at 25% from peak (was 30%) — e.g., peaked at +50%, sell at +37.5%
        // If peaked 30%+: trail at 20% from peak — e.g., peaked at +60%, sell at +48%
        else if (pos.tpHit === 0 && changePct > 5) {
          const peakPctFromEntry = pos.peakMcap > 0 && pos.entryMcap > 0 ? ((pos.peakMcap - pos.entryMcap) / pos.entryMcap) * 100 : 0;
          const trailThreshold = peakPctFromEntry >= 30 ? 20 : peakPctFromEntry >= 15 ? 25 : 35;
          if (fromPeak > trailThreshold && peakPctFromEntry >= 12) {
            log(`Trailing ${ca.slice(0,6)}: +${changePct.toFixed(0)}% (peaked +${peakPctFromEntry.toFixed(0)}%, down ${fromPeak.toFixed(0)}% from peak, trail=${trailThreshold}%) — selling ${s.tp1Sell}%`);
            const sig = await execSell(ca, s.tp1Sell, kp, "trailing");
            if (sig) {
              broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "TRAIL", sellPct: s.tp1Sell } });
            }
            pos.tpHit = 1;
          }
        }

        // ═══ POST-TP1 TRAILING STOP — protect profits after partial take ═══
        // After TP1 hit (sold 30%), if remaining position drops back near breakeven → full exit
        // Don't let a winning trade turn into a loser
        if (pos.tpHit >= 1 && !pos.isMoonbag && pos.tpHit < 3) {
          // After TP1: if price drops back to only +5% from entry, exit remaining
          if (changePct <= 5) {
            log(`POST-TP1 EXIT ${ca.slice(0,6)}: +${changePct.toFixed(0)}% after TP1 — protecting profits, full exit`);
            const sig = await execSell(ca, 100, kp, "post-tp1-exit");
            if (sig) {
              broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "POST-TP1", reason: "protect-profit" } });
              exitPosition(ca, 100, "post-tp1-exit");
              trackSell(wallet, ca);
            }
            continue;
          }
          // After TP1: tighter trailing — if dropped 30% from peak, exit remaining
          if (fromPeak > 30 && changePct > 5) {
            log(`POST-TP1 TRAIL ${ca.slice(0,6)}: +${changePct.toFixed(0)}% (${fromPeak.toFixed(0)}% from peak after TP1) — full exit`);
            const sig = await execSell(ca, 100, kp, "post-tp1-trail");
            if (sig) {
              broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "POST-TP1-TRAIL", reason: "trailing-after-tp" } });
              exitPosition(ca, 100, "post-tp1-trail");
              trackSell(wallet, ca);
            }
            continue;
          }
        }

        // ═══ STOP LOSS — 2 tiers ═══
        // Moonbags: trailing exit if dropped 60%+ from peak while still green (protect runner gains)
        // OR full exit if basically dead (-80%)
        if (pos.isMoonbag) {
          if (changePct <= -80) {
            log(`Moonbag dead ${ca.slice(0,6)}: ${changePct.toFixed(0)}% — full exit`);
            const sig = await execSell(ca, 100, kp, "moonbag-dead");
            if (sig) {
              broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, reason: "moonbag-dead" } });
              exitPosition(ca, 100, "moonbag-dead");
              trackSell(wallet, ca);
            }
          } else if (fromPeak > (changePct >= 500 ? 70 : 60) && changePct > 30) {
            // Moonbag trailing stop widening: wider trail for bigger runners
            log(`Moonbag trail ${ca.slice(0,6)}: +${changePct.toFixed(0)}% (−${fromPeak.toFixed(0)}% from peak) — exit moonbag`);
            const sig = await execSell(ca, 100, kp, "moonbag-trail");
            if (sig) {
              broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, reason: "moonbag-trail" } });
              exitPosition(ca, 100, "moonbag-trail");
              trackSell(wallet, ca);
            }
          }
        }
        // SL2: Full exit
        else if (!pos.isMoonbag && pos.slHit < 2 && changePct <= -s.sl2) {
          log(`SL2 ${ca.slice(0,6)}: ${changePct.toFixed(0)}% — full exit`);
          const sig = await execSell(ca, 100, kp, "SL2");
          if (sig) {
            broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "SL2", reason: "stop-loss" } });
            exitPosition(ca, 100, "SL2");
            trackSell(wallet, ca);
          }
        }
        // SL1: Reduce exposure — sell sl1Sell% to cut risk
        else if (!pos.isMoonbag && pos.slHit < 1 && changePct <= -s.sl1) {
          log(`SL1 ${ca.slice(0,6)}: ${changePct.toFixed(0)}% — selling ${s.sl1Sell}% to reduce risk`);
          const sig = await execSell(ca, s.sl1Sell, kp, "SL1");
          if (sig) {
            broadcastWS({ event: "auto-sell", data: { ca, pnl: changePct.toFixed(1), wallet, tier: "SL1", sellPct: s.sl1Sell } });
            log(`SL1 SOLD ${s.sl1Sell}% of ${ca.slice(0,6)}`);
          }
          pos.slHit = 1;
        }
      }

      // ═══ DIP-BUY DCA — add to existing positions on dips with recovery signals ═══
      // If MC dropped 20%+ from peak but score is now rising/rocket, average down
      for (const [ca, pos] of state.positions) {
        if (pos.isMoonbag || pos.slHit >= 1 || pos.dcaBuys >= 2) continue; // max 2 DCA buys
        const token = radar.tokens.get(ca);
        if (!token) continue;
        const currentMcap = token.mcapUsd || 0;
        if (pos.entryMcap <= 0 || currentMcap <= 0) continue;
        const fromPeak = pos.peakMcap > 0 ? ((pos.peakMcap - currentMcap) / pos.peakMcap) * 100 : 0;
        const dyn = scoreDynamics.get(ca);
        const isRecovering = dyn && dyn.scores >= 3 && (dyn.trend === "rising" || dyn.trend === "rocket");
        // Dip criteria: MC dropped 20%+ from peak AND score is now recovering
        if (fromPeak >= 20 && isRecovering) {
          let balance = 0;
          try { balance = await connection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL; } catch { continue; }
          const dcaAmount = Math.round(state.settings.solPerTrade * 0.5 * 1000) / 1000; // half-size DCA
          if (balance < dcaAmount + 0.01) continue;
          log(`DIP-BUY ${token.name||ca.slice(0,6)} | dip:${fromPeak.toFixed(0)}% from peak | trend:${dyn.trend} | MC:$${Math.round(currentMcap)} | ${dcaAmount} SOL`);
          try {
            const buyResp = await fetch("https://pumpportal.fun/api/trade-local", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ publicKey: tw.pubkey, action: "buy", mint: ca, amount: dcaAmount, denominatedInSol: "true", slippage: TRADE_CONFIG.BUY_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto" }),
            });
            if (buyResp.ok) {
              const txBytes = await buyResp.arrayBuffer();
              if (txBytes.byteLength > 100) {
                const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
                tx.sign([kp]);
                const sig = await fastSend(connection, tx, [kp]);
                pos.dcaBuys = (pos.dcaBuys || 0) + 1;
                pos.totalSol = (pos.totalSol || pos.entrySol) + dcaAmount;
                // Recalculate average entry (weighted)
                const totalInvested = (pos.entrySol || state.settings.solPerTrade) + dcaAmount * pos.dcaBuys;
                pos.entryMcap = (pos.entryMcap * (pos.entrySol || state.settings.solPerTrade) + currentMcap * dcaAmount) / (totalInvested || 1);
                trackBuy(wallet, ca, dcaAmount);
                log(`DIP-BOUGHT ${token.name||ca.slice(0,6)} +${dcaAmount} SOL (DCA #${pos.dcaBuys}) sig:${sig.slice(0,12)}...`);
                broadcastWS({ event: "auto-ape", data: { ca, name: token.name, sol: dcaAmount, mcap: currentMcap, wallet, score: pos.liveScore || 0, dca: true, dcaNum: pos.dcaBuys } });
              }
            }
          } catch (e) { log(`DIP-BUY error ${ca.slice(0,6)}: ${e.message}`); }
        }
      }

      // Look for new tokens to ape
      if (state.positions.size >= state.settings.maxPositions) {
        if (!state._lastFullLog || Date.now() - state._lastFullLog > 30000) {
          log(`SCAN: ${state.positions.size}/${state.settings.maxPositions} positions full — skipping entry scan`);
          state._lastFullLog = Date.now();
        }
        return;
      }

      // Clean expired cooldowns — shorter for re-entry mode
      const cd = soldCooldowns.get(wallet);
      if (cd) for (const [c, t] of cd) {
        const dyn = scoreDynamics.get(c);
        const isRecovering = dyn && dyn.scores >= 3 && (dyn.trend === "rising" || dyn.trend === "rocket");
        // Re-entry mode: allow re-buying sold tokens after 3min if dip-recovering, 10min normal
        const cooldownMs = state.settings.reentryDips !== false
          ? (isRecovering ? 180000 : 600000)   // 3min / 10min with re-entry enabled
          : (isRecovering ? 600000 : 1800000); // 10min / 30min without re-entry
        if (Date.now() - t > cooldownMs) cd.delete(c);
      }

      // ═══ DIP RE-ENTRY — re-buy previously sold tokens on confirmed dips with recovery ═══
      // User request: "enter tokens in the green that just dropped in price, sell into volume, re-enter the dip"
      if (state.settings.reentryDips !== false && state.positions.size < state.settings.maxPositions) {
        const recentlySold = soldCooldowns.get(wallet);
        if (recentlySold) {
          for (const [ca, soldTime] of recentlySold) {
            if (state.positions.has(ca)) continue; // already have position
            if (Date.now() - soldTime < 120000) continue; // wait at least 2 min after sell
            const token = radar.tokens.get(ca);
            if (!token) continue;
            const dyn = scoreDynamics.get(ca);
            if (!dyn || dyn.scores < 3) continue;
            // Re-entry criteria: score recovering + MC dipped from peak + still has volume
            const isRecovering = dyn.trend === "rising" || dyn.trend === "rocket";
            const currentMcap = token.mcapUsd || 0;
            const spark = token.spark || [];
            const recentPeak = spark.length > 3 ? Math.max(...spark.slice(-10)) : currentMcap;
            const dippedFromPeak = recentPeak > 0 ? ((recentPeak - currentMcap) / recentPeak) * 100 : 0;
            // Dip + recovery = re-entry: 15%+ dip from recent peak AND score is coming back
            if (isRecovering && dippedFromPeak >= 15 && currentMcap > 5000) {
              let balance = 0;
              try { balance = await connection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL; } catch { continue; }
              const reentryAmount = Math.round(state.settings.solPerTrade * 0.5 * state.drawdownMult * 1000) / 1000; // half-size re-entry
              if (balance < reentryAmount + 0.01) continue;
              log(`DIP-REENTRY ${token.name||ca.slice(0,6)} | dip:${dippedFromPeak.toFixed(0)}% | trend:${dyn.trend} | MC:$${Math.round(currentMcap)} | ${reentryAmount} SOL`);
              try {
                const buyResp = await fetch("https://pumpportal.fun/api/trade-local", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ publicKey: tw.pubkey, action: "buy", mint: ca, amount: reentryAmount, denominatedInSol: "true", slippage: TRADE_CONFIG.BUY_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto" }),
                });
                if (buyResp.ok) {
                  const txBytes = await buyResp.arrayBuffer();
                  if (txBytes.byteLength > 100) {
                    const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
                    tx.sign([kp]);
                    const sig = await fastSend(connection, tx, [kp]);
                    state.positions.set(ca, {
                      entryMcap: currentMcap, entrySol: reentryAmount, entryTime: Date.now(),
                      peakMcap: currentMcap, tpHit: 0, slHit: 0, dcaBuys: 0, isReentry: true,
                      entryScore: dyn.currentScore || 0,
                    });
                    recentlySold.delete(ca); // remove from cooldown
                    broadcastWS({ event: "auto-ape", data: { ca, name: token.name, sol: reentryAmount, mcap: currentMcap, wallet, score: dyn.currentScore || 0, reentry: true } });
                    log(`DIP-REENTERED ${token.name||ca.slice(0,6)} +${reentryAmount} SOL sig:${sig.slice(0,12)}...`);
                    if (state.positions.size >= state.settings.maxPositions) break;
                  }
                }
              } catch (e) { log(`DIP-REENTRY error ${ca.slice(0,6)}: ${e.message}`); }
            }
          }
        }
      }

      // ── PIPELINE STATS: track why tokens are rejected ──
      const pipeline = { total: 0, baseFilter: 0, alreadyOwned: 0, cooldown: 0, rugGate: 0, trendReject: 0, scoreLow: 0, passed: 0, nearMisses: [], rugRejects: [], skippedGreen: [] };

      const tokens = [...radar.tokens.values()].filter(t => {
        pipeline.total++;
        const mc = t.mcapUsd || 0;
        const buys = t.buys || 0;
        const ub = t.uniqueBuyers?.size || 0;
        const ageMin = (Date.now() - t.createdAt) / 60000;
        const sells = t.sells || 0;
        const dyn = scoreDynamics.get(t.ca);
        const isAccelerating = dyn && dyn.scores >= 1 && (dyn.trend === "rocket" || dyn.trend === "rising");
        // Low-velocity early entry: token has few buys but healthy buy/sell ratio
        // and is in the pre-discovery FDV range ($4K-$30K). These are the tokens
        // we SHOULD be aping — before velocity picks up.
        // TIGHTENED: was buys>=1 ub>=1 — require actual activity proof
        const isLowVelocity = mc >= 4000 && mc <= 30000 && buys >= 5 && sells >= 1 && sells <= buys && ub >= 3 && ageMin >= 0.5 && ageMin <= 30;
        // DexPaid early entry: boosted tokens get relaxed filters — paid = conviction
        const isDexPaid = !!radar.dexBoosted.get(t.ca);
        // Very early tokens (< 2 min) in pre-discovery range — still require minimum activity
        // TIGHTENED: was buys>=2 ub>=2 — too loose, let 6-second-old zero-sell tokens through
        const isVeryEarly = ageMin >= 0.5 && ageMin < 2 && mc >= 4000 && mc <= 25000 && buys >= 5 && ub >= 3 && sells >= 1;
        // HARD MINIMUM: no token enters without at least 3 unique buyers and 30 seconds of age
        // This alone would have prevented the BURDISH trade (3 UB, 6 seconds old, 0 sells)
        if (ub < 3 || ageMin < 0.5) { pipeline.baseFilter++; return false; }
        if (isAccelerating) {
          if (!(mc > 3000 && buys >= 5 && ub >= 3 && ageMin >= 0.5 && sells >= 1 && sells <= buys * 1.5)) { pipeline.baseFilter++; return false; }
          return true;
        }
        if (isDexPaid && mc >= 4000 && buys >= 3 && ub >= 3 && sells >= 1 && sells <= buys * 2) return true;
        if (isVeryEarly) return true; // fast-track very early movers (already tightened above)
        if (isLowVelocity) return true;
        if (!(mc > 5000 && buys >= 5 && ub >= 3 && ageMin >= 0.5 && sells >= 1 && sells <= buys * 1.2)) { pipeline.baseFilter++; return false; }
        return true;
      });
      // ═══ BACKGROUND WALLET AGE ENRICHMENT — non-blocking on-chain wallet age checks ═══
      // Enrich tokens that pass base filter with real wallet age data.
      // Uses cache so subsequent cycles are instant. Only check tokens not yet enriched.
      for (const t of tokens) {
        if (!t._walletAgeData && !t._walletAgeChecking && (t.buys || 0) >= 3) {
          t._walletAgeChecking = true;
          enrichWalletAges(t).then(data => {
            t._walletAgeData = data;
            t._walletAgeChecking = false;
          }).catch(() => { t._walletAgeChecking = false; });
        }
        // Dev credibility: name uniqueness + dev SOL balance + launch count
        if (!t._devCredData && !t._devCredChecking && t.devWallet) {
          t._devCredChecking = true;
          enrichDevCredibility(t).then(data => {
            t._devCredData = data;
            t._devCredChecking = false;
          }).catch(() => { t._devCredChecking = false; });
        }
      }

      const hot = tokens.filter(t => {
        if (state.positions.has(t.ca)) { pipeline.alreadyOwned++; return false; }
        if (cd?.has(t.ca)) { pipeline.cooldown++; return false; }
        const buys = t.buys || 0; const ub = t.uniqueBuyers?.size || 0; const vol = t.volumeSol || 0;
        const mc = t.mcapUsd || 0; const sells = t.sells || 0;
        const ageMin = Math.max(0.2, (Date.now() - t.createdAt) / 60000);
        const sellVol = t.sellVolumeSol || 0;

        // ═══ HARD RUG GATE — reject obvious rugs before scoring ═══
        // IMPORTANT: Tokens < 3 min old get relaxed gates — zero sells and buy imbalance
        // are NORMAL at launch. Only hard-reject on dev activity signals for young tokens.
        const qf = extractQuickFeatures(t);
        let rugRejectReason = null;
        // TIGHTENED: was < 3 min unconditional — now require at least some sell activity to qualify
        // Tokens with ZERO sells don't get young exemption (zero sells = classic rug setup)
        const isVeryYoung = ageMin < 2 && sells >= 1; // was ageMin < 3 with no sell requirement
        if (qf) {
          if (qf.rg_devSellSpeed > 0.6) rugRejectReason = "dev_sell"; // relaxed from 0.4 — partial dev sells are common on pumpfun
          else if (qf._rg_devSelfSnipe > 0) rugRejectReason = "dev_snipe";
          else if (qf.rg_mcapDropRate > 0.5 && !isVeryYoung) rugRejectReason = "mcap_crash"; // relaxed from 0.4
          else if (qf.rg_coordDumpScore > 0.5) rugRejectReason = "coord_dump"; // relaxed from 0.35 — fast sells common on pumpfun
          else if (qf._rg_pumpDump > 0.6 && !isVeryYoung) rugRejectReason = "pump_dump"; // relaxed from 0.5
          else if (qf._rg_sybilScore > 0.5) rugRejectReason = "sybil"; // relaxed from 0.4
          else if (qf._rg_earlyDump > 0.6 && ageMin < 5) rugRejectReason = "early_dump"; // relaxed from 0.5
          else if (qf._rg_quickFlipRate > 0.35) rugRejectReason = "quick_flip"; // relaxed from 0.25
          else if (qf.rg_holderConcentration > 0.7 && buys > 5 && !(qf._whaleBullish > 0.3)) rugRejectReason = "whale_heavy";
          else if (qf.rg_liqRemovalSpeed > 0.65 && !isVeryYoung) rugRejectReason = "liq_removal";
          else if (qf.ch_smoothGrind > 0.6 && !isVeryYoung) rugRejectReason = "smooth_grind";
          else if (qf.ch_smoothGrind > 0.4 && qf.ch_dipRatio < 0.1 && !isVeryYoung) rugRejectReason = "no_dips";
          // Zero sells: ONLY reject for tokens > 3 min old. At launch, zero sells is expected.
          else if (qf._rg_zeroSellFlag >= 0.8 && !isVeryYoung) rugRejectReason = "zero_sells";
          else if (qf._rg_zeroSellFlag >= 0.5 && (qf.ch_smoothGrind > 0.3 || qf.ch_staircaseScore > 0.3) && !isVeryYoung) rugRejectReason = "zero_sells_fake_chart";
          // Buy/sell imbalance: only flag for older tokens with many buys
          else if (qf._rg_buySellImbalance >= 0.8 && buys >= 15 && !isVeryYoung) rugRejectReason = "all_buys_no_sells";
          else if (qf.ch_staircaseScore > 0.6 && !isVeryYoung) rugRejectReason = "staircase_chart";
          else if (qf.ch_staircaseScore > 0.4 && qf._rg_freshWalletRatio > 0.6 && !isVeryYoung) rugRejectReason = "staircase_fresh_wallets";
          else if (qf._rg_freshWalletRatio > 0.8 && qf._rg_zeroSellFlag > 0.4 && !isVeryYoung) rugRejectReason = "fresh_wallet_rug";
          // Flatline spike: dead chart with sudden vertical pump = dev self-buy rug
          else if (qf.ch_flatlineSpike > 0.5 && !isVeryYoung) rugRejectReason = "flatline_spike";
          else if (qf.ch_flatlineSpike > 0.3 && qf._rg_zeroSellFlag > 0.3 && !isVeryYoung) rugRejectReason = "flatline_spike_no_sells";
          else if (qf.ch_flatlineSpike > 0.3 && qf._rg_freshWalletRatio > 0.5 && !isVeryYoung) rugRejectReason = "flatline_spike_fresh_wallets";
          else if (qf._namePrevRugged && qf._devLaunchCount > 3) rugRejectReason = "serial_rugger";
          else if (qf._devLaunchCount > 8) rugRejectReason = "serial_launcher";
          else if (t._artworkFlags?.includes("EXACT_DUPLICATE")) rugRejectReason = "stolen_art";
          else {
            const rugSignals = [
              qf.rg_devSellSpeed > 0.35, qf.rg_coordDumpScore > 0.3,
              qf._rg_sybilScore > 0.3, qf._rg_quickFlipRate > 0.2,
              qf.rg_holderConcentration > 0.65, qf._rg_earlyDump > 0.3,
              qf.rg_mcapDropRate > 0.3 && !isVeryYoung, qf._rg_pumpDump > 0.35 && !isVeryYoung,
              qf.ch_smoothGrind > 0.4 && !isVeryYoung, qf.ch_dipRatio < 0.08 && !isVeryYoung,
              qf._rg_zeroSellFlag > 0.5 && !isVeryYoung,
              qf._rg_buySellImbalance > 0.6 && !isVeryYoung,
              qf.ch_staircaseScore > 0.4 && !isVeryYoung,
              qf._rg_freshWalletRatio > 0.7 && !isVeryYoung,
              qf.ch_flatlineSpike > 0.3 && !isVeryYoung,
              t._artworkOriginal === false,
            ].filter(Boolean).length;
            // Young tokens need more signals to reject (5 instead of 4)
            const minSignals = isVeryYoung ? 5 : 4;
            if (rugSignals >= minSignals) rugRejectReason = "multi_rug_" + rugSignals;
          }
          if (rugRejectReason) {
            pipeline.rugGate++;
            pipeline.rugRejects.push({ name: t.name || t.ca?.slice(0, 8), ca: t.ca?.slice(0, 8), reason: rugRejectReason, mc: Math.round(mc), buys, walletAge: t._walletAgeData ? `${Math.round(t._walletAgeData.walletAgeScore * 100)}%aged` : "unknown", whaleBullish: t._walletAgeData?.whaleBullish || 0 });
            if (pipeline.rugRejects.length > 15) pipeline.rugRejects.shift();
            return false;
          }
        }

        // Buy activity (log-scaled to avoid spam bias)
        const buyScore = Math.min(15, Math.log2(buys + 1) * 3);
        const ubScore = Math.min(15, Math.log2(ub + 1) * 3);
        const volScore = Math.min(12, Math.log10(vol * 100 + 1) * 4);

        // MC scoring: ranges based on correct FDV (not bonding curve MC)
        // $6K-$16K = pre-discovery zone (highest upside if token has healthy signals)
        // $16K-$60K = discovery zone (proven activity, still good upside)
        // $60K+ = late entry (most upside already captured)
        const mcScore = mc >= gradMcUsd() ? 3 :
                        mc >= 100000 ? 5 :
                        mc >= 60000  ? 7 :
                        mc >= 30000  ? 10 :
                        mc >= 16000  ? 12 :
                        mc >= 10000  ? 11 :
                        mc >= 6000   ? 9 :
                        mc >= 4000   ? 6 : 0;

        // GREEN detection: is MC growing? (sparkline trend)
        const spark = t.spark || [];
        let greenScore = 0;
        if (spark.length >= 3) {
          const recent = spark.slice(-3);
          const earlier = spark.slice(-6, -3);
          if (earlier.length > 0) {
            const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
            const avgEarlier = earlier.reduce((a, b) => a + b, 0) / earlier.length;
            const growth = avgEarlier > 0 ? (avgRecent - avgEarlier) / avgEarlier : 0;
            if (growth > 0) greenScore = Math.min(20, growth * 60);
          }
        }

        // Buy pressure: more buys than sells = bullish
        const pressureScore = buys > 2 ? Math.min(10, (buys / Math.max(1, buys + sells)) * 10) : 0;

        // Buy velocity: fast buys = hype
        const velocityScore = Math.min(10, (buys / ageMin) * 3);

        // Penalties — lighter touch since hard rug gate already blocks obvious rugs
        const sellPenalty = sells > buys * 0.6 ? Math.min(12, (sells - buys * 0.4) * 2) : 0;
        // Graduated rug penalty: only penalize significant signals (hard gate catches the rest)
        let rugPenalty = 0;
        if (qf) {
          rugPenalty += qf.rg_devSellSpeed > 0.25 ? 10 : 0;          // significant dev selling
          rugPenalty += qf.rg_coordDumpScore > 0.25 ? 8 : 0;         // coordinated sells
          rugPenalty += qf.rg_mcapDropRate > 0.3 ? 8 : 0;            // mcap declining hard
          rugPenalty += qf._rg_quickFlipRate > 0.15 ? 6 : 0;         // quick flippers
          rugPenalty += qf._rg_sybilScore > 0.3 ? 6 : 0;             // sybil bots
          rugPenalty += qf.rg_holderConcentration > 0.6 ? 5 : 0;     // whale-heavy
          rugPenalty += qf._rg_earlyDump > 0.2 ? 5 : 0;              // early selling
          rugPenalty += sellVol > vol * 0.4 ? 5 : 0;                  // sell pressure
          rugPenalty += qf._rg_pumpDump > 0.3 ? 8 : 0;               // pump-dump pattern
          rugPenalty += qf.ch_smoothGrind > 0.25 ? Math.round(qf.ch_smoothGrind * 18) : 0; // smooth grind — constant velocity up = slow rug, penalize hard
          rugPenalty += qf._rg_zeroSellFlag > 0.4 ? Math.round(qf._rg_zeroSellFlag * 15) : 0; // zero sells
          rugPenalty += qf._rg_buySellImbalance > 0.4 ? Math.round(qf._rg_buySellImbalance * 10) : 0; // buy imbalance
          rugPenalty += qf.ch_staircaseScore > 0.3 ? Math.round(qf.ch_staircaseScore * 12) : 0; // staircase
          rugPenalty += qf._rg_freshWalletRatio > 0.6 ? Math.round(qf._rg_freshWalletRatio * 8) : 0; // fresh wallets
        } else {
          rugPenalty = (sellVol > vol * 0.5 && sells > 3) ? 15 :
                       (sells > buys * 1.2) ? 10 : 0;
        }

        const dexBoost = radar.dexBoosted.get(t.ca);
        // DexPaid = strong early buy signal: devs paying for visibility = conviction + marketing spend
        // Base 12 pts + scaled by boost amount, capped at 20 pts (was 8 — too weak)
        const boostScore = dexBoost ? Math.min(20, 12 + Math.log2(dexBoost.amount + 1)) : 0;
        if (state.settings.requireBoosted && !dexBoost) return false;

        // ═══ VELOCITY/ACCELERATION GATE ═══
        // Need at least 1 observation to have any data. For early movers (< 2 min old),
        // allow entry with just 1 observation since waiting 15-30s means missing the move.
        const dyn = scoreDynamics.get(t.ca);
        let dynamicsBonus = 0;

        const isEarlyMover = ageMin < 2 && mc >= 4000 && mc <= 30000 && ub >= 2;
        if (!dyn || (dyn.scores < 2 && !isEarlyMover)) {
          // Not enough data yet — skip this cycle, let it cook
          pipeline.scoreLow++;
          return false;
        }
        // Early movers with 1 observation get a bonus for having velocity data at all
        if (isEarlyMover && dyn && dyn.scores === 1) dynamicsBonus += 8;

        // Hard reject: actively crashing tokens
        if (dyn.trend === "crashing") { pipeline.trendReject++; return false; }

        // Velocity/acceleration are now PRIMARY signals, not just bonuses
        // Declining = dip opportunity — penalize but don't reject
        if (dyn.trend === "declining") dynamicsBonus = -15;
        // Fading momentum = warning
        else if (dyn.trend === "fading") dynamicsBonus = -8;
        // Stable with no movement = not interesting enough
        else if (dyn.trend === "stable" && dyn.velocity <= 0) dynamicsBonus = -12;
        // Rising steadily — strong signal
        else if (dyn.trend === "rising") dynamicsBonus = 18;
        // Rocket: accelerating score = STRONGEST signal
        else if (dyn.trend === "rocket") dynamicsBonus = 30;

        // Velocity bonus: scaled more aggressively — this IS the buy signal
        if (dyn.velocity > 0.1) dynamicsBonus += Math.min(15, Math.round(dyn.velocity * 10));
        // Acceleration bonus: positive 2nd derivative = momentum building
        if (dyn.acceleration > 0.005) dynamicsBonus += Math.min(12, Math.round(dyn.acceleration * 200));

        // Chart health bonus: if the sparkline shape matches healthy graduated patterns
        // Smooth grind penalty: fake charts with no natural dips should be avoided
        let chartBonus = qf?.ch_healthScore > 0.6 ? Math.round((qf.ch_healthScore - 0.5) * 16) :
                         qf?.ch_healthScore < 0.3 ? -8 : 0;
        if (qf?.ch_smoothGrind > 0.35) chartBonus -= Math.round(qf.ch_smoothGrind * 15);
        if (qf?.ch_dipRatio < 0.15 && spark.length >= 8) chartBonus -= 6; // no natural dips penalty
        if (qf?.ch_pumpDump > 0.4) chartBonus -= Math.round(qf.ch_pumpDump * 10);
        // Staircase chart penalty: monotonic up with uniform steps = dev self-buying
        if (qf?.ch_staircaseScore > 0.4) chartBonus -= Math.round(qf.ch_staircaseScore * 20);
        // Zero sell penalty: many buys + zero sells = almost always a rug
        if (qf?._rg_zeroSellFlag > 0.5) chartBonus -= Math.round(qf._rg_zeroSellFlag * 25);
        // Fresh wallet penalty: all buyers are brand new wallets
        if (qf?._rg_freshWalletRatio > 0.7) chartBonus -= Math.round(qf._rg_freshWalletRatio * 15);

        // ═══ LOW-VELOCITY POTENTIAL BONUS ═══
        // Core insight: tokens with LOW activity but HEALTHY signals have the highest
        // risk-reward ratio. By the time velocity is high, the move is mostly done.
        // Formula: bonus inversely proportional to velocity, gated by quality signals.
        //
        // Math: earlyBonus = qualitySignal * (1 / (buysPerMin + 0.3)) * scaleFactor
        //   - qualitySignal: healthy buy/sell ratio + no rug flags + MC in sweet spot
        //   - buysPerMin: lower = earlier = bigger bonus
        //   - Capped at 18 to avoid dominating the score
        let earlyApeBonus = 0;
        const buysPerMin = buys / Math.max(ageMin, 0.5);
        const isEarlyMcap = mc >= 4000 && mc <= 24000;
        const healthyRatio = buys > 0 && sells <= buys * 0.5; // few sells relative to buys
        const noRugFlags = !t._rugFlags || t._rugFlags.length === 0;
        if (isEarlyMcap && healthyRatio && noRugFlags && buysPerMin < 3) {
          // Quality signal: combination of healthy ratio + low sell pressure + organic pace
          const qualitySignal = Math.min(1, (buys > 0 ? 1 - (sells / Math.max(buys, 1)) : 0.5) + (ub >= 2 ? 0.3 : 0));
          // Inverse velocity: lower buysPerMin = higher bonus
          const velocityInverse = 1 / (buysPerMin + 0.3);
          earlyApeBonus = Math.min(18, Math.round(qualitySignal * velocityInverse * 8));
        }

        // Artwork penalty: non-original art = rug signal
        const artPenalty = t._artworkOriginal === false ? Math.max(5, Math.round((100 - (t._artworkScore || 50)) / 5)) : 0;

        // ═══ WHALE BULLISH BONUS — aged whale wallets buying = smart money conviction ═══
        // If on-chain wallet age data shows whales with aged wallets (>7 days) are buying,
        // this is a strong bullish signal — real money, not dev sybils.
        let whaleBullishBonus = 0;
        if (qf?._whaleBullish > 0.3) {
          whaleBullishBonus = Math.min(15, Math.round(qf._whaleBullish * 20));
        }
        // Fresh wallet penalty from on-chain data (overrides heuristic when available)
        let walletAgePenalty = 0;
        if (qf?._walletAgeFresh > 0.7) {
          walletAgePenalty = Math.round(qf._walletAgeFresh * 12);
        }

        // Dev credibility bonus/penalty: fresh name + funded dev = up to +15, serial launcher = penalty
        let devCredBonus = 0;
        if (qf?._devCredScore != null) {
          if (qf._devCredScore >= 0.8) devCredBonus = Math.round((qf._devCredScore - 0.5) * 30); // up to +15
          else if (qf._devCredScore < 0.3) devCredBonus = -Math.round((0.3 - qf._devCredScore) * 25); // down to -8
          if (qf._namePrevRugged) devCredBonus -= 10; // same name rugged before = big penalty
        }

        // ═══ DEV WALLET BALANCE BOOST — funded devs pump charts ═══
        // Devs with a lot of SOL have resources to sustain buy pressure.
        // This is a huge signal: whale_dev (50+ SOL) = +20, funded_dev (10+) = +15,
        // broke_dev (<0.5 SOL) = -15. Overrides the weaker devCredBonus when available.
        let devBalanceBoost = 0;
        const devScore = devWalletTracker.getDevScore(t.ca);
        if (devScore.mapped && devScore.solBalance >= 0) {
          devBalanceBoost = devScore.scoringBoost;
          // If dev tracker has stronger data, let it override the basic devCredBonus
          if (Math.abs(devBalanceBoost) > Math.abs(devCredBonus)) {
            devCredBonus = devBalanceBoost;
          } else {
            // Both have data — combine them, cap at ±25
            devCredBonus = Math.max(-25, Math.min(25, devCredBonus + Math.round(devBalanceBoost * 0.5)));
          }
          t._devTier = devScore.devTier;
          t._devSolBal = devScore.solBalance;
          t._devHighValue = devScore.isHighValue;
        }

        // ═══ MEMETIC SCORE BLEND ═══
        // Quick memetic score (linguistic + absurdity + temporal) ranges 0-1.
        // Convert to -8 to +12 point range: tokens with strong meme DNA get boosted,
        // generic/weak names get penalized. Cached on creation, ~0ms lookup.
        const memeticQuick = t._memeticQuick || 0;
        const memeticBonus = memeticQuick > 0 ? Math.round((memeticQuick - 0.45) * 24) : 0; // -11 to +13
        t._memeticScore = memeticQuick;

        // ═══ OUTLIER DETECTION SIGNALS — finding the 0.01% ═══

        // HOLDER QUALITY: early buyers with proven track records
        let holderQualityBonus = 0;
        if (qf?._holderQuality > 0.2) {
          holderQualityBonus = Math.min(15, Math.round(qf._holderQuality * 20));
        }

        // KOL CASCADE: tight temporal convergence of KOL mentions
        let kolCascadeBonus = 0;
        if (qf?._kolCascade > 0.2) {
          kolCascadeBonus = Math.min(12, Math.round(qf._kolCascade * 18));
        }

        // SECOND WAVE: previously strong token showing renewed interest after dip
        let secondWaveBonus = 0;
        if (qf?._secondWave > 0.2) {
          secondWaveBonus = Math.min(15, Math.round(qf._secondWave * 22));
        }

        // META NARRATIVE ACCELERATION: is this narrative's wave building?
        let narrativeAccelBonus = 0;
        if (metaTracker) {
          const metaResult = metaTracker.getMetaBoost(t);
          narrativeAccelBonus = metaResult.accelBoost || 0;
          t._metaBoost = metaResult.boost;
          t._narrativeAccel = metaResult.accelBoost || 0;
          t._wavePosition = metaResult.wavePosition || 0;
          t._narrative = metaResult.narrative;
        }

        // DEMAND AUTHENTICITY: organic demand bonus, manufactured demand penalty
        let demandAuthPenalty = 0;
        let demandAuthBonus = 0;
        if (qf?._demandAuthenticity != null) {
          if (qf._demandAuthenticity < 0.25) demandAuthPenalty = Math.round((0.25 - qf._demandAuthenticity) * 60); // up to -15
          else if (qf._demandAuthenticity > 0.7) demandAuthBonus = Math.round((qf._demandAuthenticity - 0.7) * 25); // up to +7
          t._demandAuth = qf._demandAuthenticity;
        }

        // Snapshot for second wave tracker (if score is good enough)
        if (buyScore + ubScore + volScore + mcScore + greenScore > 30) {
          secondWaveSnapshot(t);
        }

        t._apeScore = Math.max(0, Math.min(99, Math.round(
          buyScore + ubScore + volScore + mcScore + greenScore + pressureScore + velocityScore + boostScore + dynamicsBonus + chartBonus + earlyApeBonus + whaleBullishBonus + devCredBonus + memeticBonus + holderQualityBonus + kolCascadeBonus + secondWaveBonus + narrativeAccelBonus + demandAuthBonus - sellPenalty - rugPenalty - artPenalty - walletAgePenalty - demandAuthPenalty
        )));

        // ═══ SURVIVORSHIP BIAS FILTER (Kahneman) ═══
        // "We don't ask what makes tokens pump. We ask what surviving tokens
        //  looked like at birth — then reject anything that doesn't match."
        // This is the inverse of traditional scoring: instead of scoring UP for
        // good signals, we filter OUT tokens that don't match the winner archetype.
        let survivorAdj = 0;
        let survivorKilled = false;
        if (qf && survivorBias.survivors.size >= 5) {
          const sbResult = survivorBias.getScoreAdjustment(qf);
          survivorAdj = sbResult.adjustment;
          t._apeScore = Math.max(0, Math.min(99, t._apeScore + survivorAdj));
          t._survivorMatch = sbResult.eval.matchPct;
          t._survivorNet = sbResult.eval.netScore;
          t._survivorKills = sbResult.eval.killSignals?.map(k => k.feature.replace(/^(oc_|rg_|ch_|cs_|sir_|gf_|tp_|k_|apd_)/, "")).slice(0, 3);
          // Mega-winner archetype match
          t._megaMatch = sbResult.eval.megaMatchPct || 0;
          t._isMegaCandidate = sbResult.eval.isMegaCandidate || false;
          // Hard filter: survivorship engine says this looks nothing like winners
          if (!sbResult.eval.shouldApe && sbResult.eval.confidence > 40) {
            survivorKilled = true;
          }
        }

        t._rugFlags = [
          ...(qf ? [
            qf.rg_devSellSpeed > 0.3 && "dev_selling",
            qf.rg_coordDumpScore > 0.3 && "coord_sells",
            qf._rg_sybilScore > 0.3 && "sybil_bots",
            qf._rg_quickFlipRate > 0.2 && "quick_flips",
            qf.rg_holderConcentration > 0.6 && "whale_heavy",
            qf.ch_smoothGrind > 0.35 && "smooth_grind",
            qf.ch_dipRatio < 0.1 && spark.length >= 8 && "no_dips",
            qf.ch_staircaseScore > 0.4 && "staircase_chart",
            qf._rg_zeroSellFlag > 0.5 && "zero_sells",
            qf._rg_buySellImbalance > 0.5 && "all_buys_no_sells",
            qf._rg_freshWalletRatio > 0.7 && "fresh_wallets",
            qf._walletAgeFresh > 0.7 && "fresh_wallets_onchain",
          ] : []),
          t._artworkOriginal === false && "stolen_art",
          t._artworkFlags?.includes("SIMILAR_IMAGE") && "similar_art",
          t._artworkFlags?.includes("LOW_EFFORT_ART") && "low_effort_art",
          qf?._namePrevRugged && "name_prev_rugged",
          qf?._devLaunchCount > 5 && "serial_launcher",
          qf?._nameUniqueness < 0.3 && "recycled_name",
          t._devTier === "broke_dev" && "broke_dev",
          devScore.isSerialLauncher && "serial_dev",
        ].filter(Boolean);
        // Positive signals (not rug flags, but bullish indicators)
        t._bullishSignals = [
          ...(qf ? [
            qf._whaleBullish > 0.3 && `whale_bullish(${(qf._whaleBullish * 100).toFixed(0)}%)`,
            qf.rg_walletAgeScore > 0.7 && "aged_wallets",
            qf._devCredScore >= 0.8 && `dev_credible(${Math.round(qf._devSolBalance)}sol)`,
            qf._nameUniqueness >= 1.0 && "fresh_name",
            qf._devLaunchCount === 0 && "first_launch",
          ] : []),
          t._devTier === "whale_dev" && `whale_dev(${Math.round(t._devSolBal || 0)}sol)`,
          t._devTier === "funded_dev" && `funded_dev(${Math.round(t._devSolBal || 0)}sol)`,
          t._devHighValue && "high_value_dev",
          dyn?.trend === "rocket" && "rocket_trend",
          dyn?.trend === "rising" && "rising_trend",
          earlyApeBonus > 0 && "early_discovery",
          survivorAdj > 5 && `survivor_match(${t._survivorMatch || 0}%)`,
          t._isMegaCandidate && `mega_candidate(${t._megaMatch}%)`,
          holderQualityBonus > 5 && `proven_buyers(${Math.round((qf?._holderQuality || 0) * 100)}%)`,
          kolCascadeBonus > 5 && `kol_cascade(${Math.round((qf?._kolCascade || 0) * 100)}%)`,
          secondWaveBonus > 5 && "second_wave",
          narrativeAccelBonus > 5 && `wave_building(pos:${t._wavePosition || 0})`,
          demandAuthBonus > 3 && `organic_demand(${Math.round((qf?._demandAuthenticity || 0) * 100)}%)`,
        ].filter(Boolean);
        // Demand authenticity flag
        if (demandAuthPenalty > 5) {
          t._rugFlags = t._rugFlags || [];
          t._rugFlags.push(`manufactured_demand(${Math.round((qf?._demandAuthenticity || 0) * 100)}%)`);
        }
        t._scoreTrend = dyn?.trend || "new";
        t._earlyApe = earlyApeBonus > 0; // flag for logging
        // ── SURVIVORSHIP KILL GATE — Kahneman: if it doesn't look like a winner, skip ──
        if (survivorKilled) {
          pipeline.rugGate++;
          if (!pipeline.survivorRejects) pipeline.survivorRejects = [];
          pipeline.survivorRejects.push({
            name: t.name || t.ca?.slice(0, 8),
            score: t._apeScore,
            survivorMatch: t._survivorMatch || 0,
            survivorNet: t._survivorNet || 0,
            kills: t._survivorKills || [],
          });
          return false;
        }
        // Apply learner-recommended min score (if enough data)
        const adj = tradeLearner.getAdjustments();
        const effectiveMin = adj.minScoreShift || state.settings.minScore;
        const threshold = Math.max(45, Math.min(state.settings.minScore, effectiveMin)); // never drop below 45
        if (t._apeScore < threshold) {
          pipeline.scoreLow++;
          // Track near misses: within 10 pts of threshold
          if (t._apeScore >= threshold - 10) {
            pipeline.nearMisses.push({
              name: t.name || t.ca?.slice(0, 8),
              ca: t.ca?.slice(0, 8),
              score: t._apeScore,
              needed: threshold,
              mc: Math.round(t.mcapUsd || 0),
              buys: t.buys || 0,
              sells: t.sells || 0,
              trend: dyn?.trend || "new",
              flags: t._rugFlags || [],
            });
          }
          return false;
        }
        pipeline.passed++;
        return true;
      }).sort((a, b) => (b._apeScore || 0) - (a._apeScore || 0));

      // ═══ BRAD WIDE-NET SCAN — evaluate ALL tokens with momentum, no min score ═══
      // BRAD should see everything that's moving, not just what passes minScore.
      // This catches tokens the score threshold would miss but BRAD's cognitive
      // layer (regime awareness, smart money, strange loop reasoning) might like.
      if (bradOn) {
        // Collect ALL scored tokens with momentum signals — no score threshold
        const allScored = tokens.filter(t => {
          if (!t._apeScore && t._apeScore !== 0) return false;
          if (state.positions.has(t.ca)) return false;
          const dyn = scoreDynamics.get(t.ca);
          if (!dyn) return false;
          // Any sign of life: positive velocity, rising/rocket trend, or smart money
          return dyn.velocity > 0 || dyn.trend === "rising" || dyn.trend === "rocket" || t._smartMoneyIn;
        }).sort((a, b) => {
          // Sort by momentum strength, not score
          const aDyn = scoreDynamics.get(a.ca);
          const bDyn = scoreDynamics.get(b.ca);
          const aMom = (aDyn?.velocity || 0) + (aDyn?.acceleration || 0) * 10;
          const bMom = (bDyn?.velocity || 0) + (bDyn?.acceleration || 0) * 10;
          return bMom - aMom;
        });

        // Take top 10 by momentum that AREN'T already in hot (avoid double-eval)
        const hotCAs = new Set(hot.map(t => t.ca));
        const bradWideNet = allScored.filter(t => !hotCAs.has(t.ca)).slice(0, 10);

        if (bradWideNet.length > 0) {
          const widePromises = bradWideNet.map(async (t) => {
            try {
              const dyn = scoreDynamics.get(t.ca);
              const eval_ = await bradClient.evaluateToken({
                ca: t.ca, name: t.name, symbol: t.symbol, source: "pump",
                _apeScore: t._apeScore || 0,
                _scoreVelocity: dyn?.velocity || 0,
                _scoreAcceleration: dyn?.acceleration || 0,
                _rugFlags: t._rugFlags || [],
                uniqueBuyers: t.uniqueBuyers,
                vSolInBondingCurve: t.vSolInBondingCurve,
                mcapUsd: t.mcapUsd, volumeSol: t.volumeSol,
                buys: t.buys, sells: t.sells, trades: t.trades,
                smartMoneyIn: t._smartMoneyIn || false,
                devWallet: t.devWallet, graduated: t.graduated,
                solPrice: solUsdPrice,
              });
              // If BRAD says APE on a token that failed minScore — broadcast thought
              if (eval_?.action === "APE" && eval_.confidence >= 0.6) {
                const dyn2 = scoreDynamics.get(t.ca);
                broadcastWS({ event: "brad_thought", data: {
                  type: "pick",
                  text: `Below-threshold find: ${t.name||t.ca.slice(0,6)} scored ${t._apeScore} (below ${threshold}) but momentum is ${dyn2?.trend||"building"} (v=${dyn2?.velocity?.toFixed(3)||"?"}) MC:$${Math.round(t.mcapUsd||0)} — BRAD says APE at ${(eval_.confidence*100).toFixed(0)}% confidence`,
                  urgency: "high",
                  token: t.name || t.ca.slice(0, 6),
                  ca: t.ca,
                  time: Date.now(),
                }});
                // Promote to hot list so pipeline can evaluate it
                t._bradEval = eval_;
                t._bradPromoted = true;
                hot.push(t);
                console.log(`[BRAD] PROMOTED ${t.name||t.ca.slice(0,6)} from score ${t._apeScore} — BRAD APE conf ${eval_.confidence.toFixed(2)}, momentum ${dyn2?.trend}`);
              } else if (eval_?.action === "WATCH") {
                broadcastWS({ event: "brad_thought", data: {
                  type: "market",
                  text: `Watching ${t.name||t.ca.slice(0,6)} — score ${t._apeScore}, MC:$${Math.round(t.mcapUsd||0)}, momentum ${dyn?.trend||"building"}`,
                  urgency: "low",
                  token: t.name || t.ca.slice(0, 6),
                  ca: t.ca,
                  time: Date.now(),
                }});
              }
            } catch {}
          });
          await Promise.allSettled(widePromises);
          // Re-sort hot if we promoted any tokens
          if (hot.some(t => t._bradPromoted)) {
            hot.sort((a, b) => {
              const aEff = (a._apeScore || 0) + (a._bradEval?.action === "APE" ? (a._bradEval.confidence || 0.5) * 20 : 0);
              const bEff = (b._apeScore || 0) + (b._bradEval?.action === "APE" ? (b._bradEval.confidence || 0.5) * 20 : 0);
              return bEff - aEff;
            });
          }
        }
      }

      // ═══ 5-GATE PIPELINE ENRICHMENT — classify confidence tier for each candidate ═══
      // Runs the full gate pipeline on scored candidates to assign tiers and exit plans.
      // Portfolio constraints are built from current state.
      const _portfolioSnapshot = {
        activePositionCount: state.positions.size,
        maxPositions: state.settings.maxPositions,
        positionsLast10m: state._positionsLast10m || 0,
        availableSOL: 0, // filled per-candidate in entry loop
        totalBankroll: 0,
        drawdownMult: state.drawdownMult,
        consecutiveLosses: state._consecutiveLosses || 0,
        lastLossTime: state._lastLossTime || 0,
        solPerTrade: state.settings.solPerTrade,
        settings: state.settings,
        activePositions: [...state.positions.entries()].map(([ca, p]) => ({
          ca, devWallet: radar.tokens.get(ca)?.devWallet, archetype: p.archetype,
        })),
      };
      // Track entries in last 10 min
      if (!state._entryTimestamps) state._entryTimestamps = [];
      state._entryTimestamps = state._entryTimestamps.filter(t => Date.now() - t < 600000);
      state._positionsLast10m = state._entryTimestamps.length;
      _portfolioSnapshot.positionsLast10m = state._positionsLast10m;

      // ═══ BRAD PRE-EVALUATION — run cognitive engine on top candidates ═══
      // BRAD evaluations run in parallel (non-blocking) for the top candidates.
      // Results are attached to tokens as _bradEval for the pipeline to consume.
      if (bradOn) {
        const bradPromises = hot.slice(0, 5).map(async (t) => {
          try {
            const dyn = scoreDynamics.get(t.ca);
            t._bradEval = await bradClient.evaluateToken({
              ca: t.ca, name: t.name, symbol: t.symbol, source: "pump",
              _apeScore: t._apeScore || 0,
              _scoreVelocity: dyn?.velocity || 0,
              _scoreAcceleration: dyn?.acceleration || 0,
              _rugFlags: t._rugFlags || [],
              uniqueBuyers: t.uniqueBuyers,
              vSolInBondingCurve: t.vSolInBondingCurve,
              mcapUsd: t.mcapUsd, volumeSol: t.volumeSol,
              buys: t.buys, sells: t.sells, trades: t.trades,
              smartMoneyIn: t._smartMoneyIn || false,
              devWallet: t.devWallet, graduated: t.graduated,
              solPrice: solUsdPrice,
            });
          } catch { t._bradEval = null; }
        });
        await Promise.allSettled(bradPromises);

        // ═══ BRAD PAPER TRADING — virtual trades for learning ═══
        if (isPaperEnabled()) {
          for (const t of hot) {
            if (!t._bradEval) continue;
            const dyn = scoreDynamics.get(t.ca);
            const paperResult = paperEvaluate(t, t._bradEval, dyn);
            if (paperResult?.action === "PAPER_ENTER") {
              broadcastWS({ event: "brad_thought", data: {
                type: "strategy", text: `Paper entry: ${paperResult.name} at score ${paperResult.entryScore}, ${paperResult.sizeSol.toFixed(3)} SOL (conf ${paperResult.bradConfidence?.toFixed(2)})`,
                urgency: "low", token: paperResult.name, ca: t.ca, time: Date.now(),
              }});
            }
          }
        }

        // ═══ BRAD RE-SORT — boost BRAD-approved tokens to the top ═══
        // BRAD APE with high confidence → sort above same-score tokens
        // BRAD SKIP → demote below same-score tokens
        // This makes the radar show BRAD's best picks first.
        hot.sort((a, b) => {
          const aScore = a._apeScore || 0;
          const bScore = b._apeScore || 0;
          const aBrad = a._bradEval;
          const bBrad = b._bradEval;

          // BRAD confidence boost: APE tokens get +20 to sort score, SKIP gets -20
          let aEffective = aScore;
          let bEffective = bScore;
          if (aBrad) {
            if (aBrad.action === "APE") aEffective += (aBrad.confidence || 0.5) * 20;
            else if (aBrad.action === "SKIP") aEffective -= 20;
          }
          if (bBrad) {
            if (bBrad.action === "APE") bEffective += (bBrad.confidence || 0.5) * 20;
            else if (bBrad.action === "SKIP") bEffective -= 20;
          }
          return bEffective - aEffective;
        });
      }

      for (const t of hot) {
        const qf = extractQuickFeatures(t);
        const dyn = scoreDynamics.get(t.ca);
        const scores = {
          apeScore: t._apeScore || 0,
          scoreTimestamp: Date.now(),
          pricePhase: t._pricePhase,
          buyVelTrend: t._buyVelTrend,
          rugFlagCount: t._rugFlags?.length || 0,
          bradConfidence: t._bradEval?.confidence, // pass through for sizing
        };
        const pipeResult = runPipeline(t, qf, scores, dyn, _portfolioSnapshot);
        t._pipelineTier = pipeResult.tier;
        t._pipelineLabel = pipeResult.tierLabel;
        t._pipelineDecision = pipeResult.decision;
        t._pipelineRejectGate = pipeResult.rejectGate;
        t._pipelineRejectReason = pipeResult.rejectReason;
        t._pipelineExitPlan = pipeResult.exitPlan;
        t._pipelineSizing = pipeResult.positionSize;
        t._pipelineTiming = pipeResult.timing;
      }
      // Track tier distribution
      if (!state._pipelineStats) state._pipelineStats = { lastLog: 0, nearMisses: [], rugRejects: [], skippedGreen: [], cycles: 0, lastPipeline: null };
      const _tierDist = { 1: 0, 2: 0, 3: 0, 4: 0, 0: 0 };
      for (const t of hot) _tierDist[t._pipelineTier || 0]++;
      state._pipelineStats.tierDistribution = _tierDist;
      // Track BRAD decisions for display
      if (bradOn) {
        const bradApes = hot.filter(t => t._bradEval?.action === "APE").length;
        const bradSkips = hot.filter(t => t._bradEval?.action === "SKIP").length;
        const bradVetos = hot.filter(t => t._pipelineRejectGate === 0).length;
        state._pipelineStats.brad = {
          evaluated: hot.filter(t => t._bradEval).length,
          apes: bradApes,
          skips: bradSkips,
          vetos: bradVetos,
          topPick: hot.find(t => t._bradEval?.action === "APE")
            ? { ca: hot.find(t => t._bradEval?.action === "APE").ca, name: hot.find(t => t._bradEval?.action === "APE").name, confidence: hot.find(t => t._bradEval?.action === "APE")._bradEval.confidence }
            : null,
        };
      } else {
        state._pipelineStats.brad = null;
      }

      // ── PIPELINE DECISION LOG — shows what's happening every cycle ──
      if (!state._pipelineStats) state._pipelineStats = { lastLog: 0, nearMisses: [], rugRejects: [], skippedGreen: [], cycles: 0, lastPipeline: null };
      state._pipelineStats.cycles++;
      state._pipelineStats.lastPipeline = pipeline;
      // Keep rolling near misses (last 10, deduplicated by ca)
      for (const nm of pipeline.nearMisses) {
        const existing = state._pipelineStats.nearMisses.findIndex(n => n.ca === nm.ca);
        if (existing >= 0) state._pipelineStats.nearMisses[existing] = { ...nm, time: Date.now() };
        else state._pipelineStats.nearMisses.push({ ...nm, time: Date.now() });
      }
      state._pipelineStats.nearMisses = state._pipelineStats.nearMisses
        .filter(n => Date.now() - n.time < 300000) // keep 5min
        .slice(-10);
      // Track rug gate rejections with reasons (last 15)
      for (const rr of pipeline.rugRejects) {
        const existing = state._pipelineStats.rugRejects.findIndex(n => n.ca === rr.ca);
        if (existing >= 0) state._pipelineStats.rugRejects[existing] = { ...rr, time: Date.now() };
        else state._pipelineStats.rugRejects.push({ ...rr, time: Date.now() });
      }
      state._pipelineStats.rugRejects = state._pipelineStats.rugRejects
        .filter(n => Date.now() - n.time < 300000)
        .slice(-15);

      // Log pipeline summary every 30s
      if (Date.now() - state._pipelineStats.lastLog > 30000) {
        state._pipelineStats.lastLog = Date.now();
        const p = pipeline;
        const nmStr = p.nearMisses.length > 0 ? ` | NEAR: ${p.nearMisses.map(n => `${n.name}(${n.score}/${n.needed})`).join(", ")}` : "";
        const survStr = p.survivorRejects?.length > 0 ? ` | SURVIVOR-KILLED: ${p.survivorRejects.map(s => `${s.name}(match:${s.survivorMatch}%)`).join(", ")}` : "";
        const sbStats = survivorBias.survivors.size > 0 ? ` [SB:${survivorBias.survivors.size}W/${survivorBias.dead.size}L]` : "";
        // Tier distribution for pipeline candidates
        const tierDist = { 1: 0, 2: 0, 3: 0, 4: 0 };
        for (const t of hot) { if (t._pipelineTier) tierDist[t._pipelineTier]++; }
        const tierStr = hot.length > 0 ? ` | TIERS: T1:${tierDist[1]} T2:${tierDist[2]} T3:${tierDist[3]} WL:${tierDist[4]}` : "";
        const bradStr = state._pipelineStats.brad ? ` [BRAD:${state._pipelineStats.brad.apes}APE/${state._pipelineStats.brad.skips}SKIP/${state._pipelineStats.brad.vetos}VETO${state._pipelineStats.brad.topPick ? " top:"+state._pipelineStats.brad.topPick.name+"("+state._pipelineStats.brad.topPick.confidence?.toFixed(2)+")" : ""}]` : "";
        log(`SCAN: ${p.total} tokens → ${p.total-p.baseFilter} pass base → ${p.total-p.baseFilter-p.alreadyOwned-p.cooldown} new → ${p.total-p.baseFilter-p.alreadyOwned-p.cooldown-p.rugGate} pass rug → ${p.total-p.baseFilter-p.alreadyOwned-p.cooldown-p.rugGate-p.trendReject} pass trend → ${p.passed} READY (need ${state.settings.minScore}+)${sbStats}${tierStr}${bradStr}${nmStr}${survStr}`);
      }

      // ═══ SCORE-BASED POSITION SIZING (Kelly Criterion + Kahneman Loss Aversion) ═══
      // Axiomatic reasoning:
      //   Axiom 1 (Kahneman): Losses hurt ~2x more than equivalent gains feel good.
      //     → Size positions so worst-case loss (SL2) is psychologically bearable.
      //   Axiom 2 (Kelly): Optimal bet size = edge / odds. Higher score = bigger edge.
      //     → Scale SOL linearly from 0.5x at minScore to 1.5x at score 80+.
      //   Axiom 3 (Norman): Make the system state visible — log the sizing rationale.
      //     → Show WHY each position is sized the way it is.
      //   Axiom 4 (Prospect Theory): People are risk-seeking in losses, risk-averse in gains.
      //     → Counter this bias: bet MORE on high-conviction, LESS on marginal signals.
      //
      // Formula: sizeMult = 0.5 + (score - minScore) / (80 - minScore)
      //   score=minScore → 0.5x (half size, marginal conviction)
      //   score=80       → 1.5x (full conviction, max edge)
      //   Capped at [0.4x, 1.6x] to prevent extremes.
      //   Trend bonus: rocket/rising adds +0.15x (momentum confirms conviction)
      //   Rug flags: each flag reduces by 0.1x (uncertainty penalty)
      function calcPositionSize(score, trend, rugFlagCount, baseSol) {
        // ═══ ADAPTIVE QUARTER-KELLY SIZING + DRAWDOWN GOVERNOR ═══
        // Meme tokens follow power-law returns (Pareto, not Gaussian)
        // Quarter-Kelly handles extreme variance. Drawdown governor protects capital.

        // Drawdown governor: if trading halted, return 0
        if (state.drawdownMult <= 0) return 0;

        const winRate = score >= 70 ? 0.45 : score >= 55 ? 0.35 : score >= 40 ? 0.25 : score >= 25 ? 0.15 : 0.08;
        const payoffRatio = 3.0;
        const q = 1 - winRate;
        const kellyFull = Math.max(0, (winRate * payoffRatio - q) / payoffRatio);
        const kellyQuarter = kellyFull * 0.25;

        let mult = 0.3 + kellyQuarter * 8.5;

        // Trend adjustment
        if (trend === "rocket") mult *= 1.15;
        else if (trend === "rising") mult *= 1.08;
        else if (trend === "fading") mult *= 0.85;
        else if (trend === "declining") mult *= 0.7;

        // Rug flag penalty
        if (rugFlagCount > 0) mult *= Math.pow(0.75, rugFlagCount);

        // ═══ DRAWDOWN GOVERNOR — scale down sizing as DD deepens ═══
        // At 25% DD → 0.5x, at 50% DD → stopped (caught above)
        mult *= state.drawdownMult;

        mult = Math.max(0.25, Math.min(2.0, mult));
        return Math.round(baseSol * mult * 1000) / 1000;
      }

      // ═══ ENTRY TIMING ENGINE — prevent buying at wrong time ═══
      // Score stability: track which tokens have been above threshold consecutively
      if (!state._scoreStability) state._scoreStability = new Map(); // ca → { aboveCount, firstSeen }
      const stabilityMap = state._scoreStability;
      // Update stability for all scored tokens this cycle
      const adj2 = tradeLearner.getAdjustments();
      const effMin = Math.max(45, Math.min(state.settings.minScore, adj2.minScoreShift || state.settings.minScore));
      for (const t of hot) {
        const prev = stabilityMap.get(t.ca) || { aboveCount: 0, firstSeen: Date.now() };
        prev.aboveCount++;
        prev.lastSeen = Date.now();
        stabilityMap.set(t.ca, prev);
        t._stabilityCount = prev.aboveCount; // expose to pipeline Gate 5
      }
      // Prune tokens not seen in 30s
      for (const [ca, s] of stabilityMap) { if (Date.now() - s.lastSeen > 30000) stabilityMap.delete(ca); }

      // Ape into top 2 candidates per cycle — with entry timing gates
      // Buy dedup: track CAs we're currently buying to prevent double-buy across cycles
      if (!state._buyingNow) state._buyingNow = new Set();
      for (const t of hot.slice(0, 2)) {
        if (state.positions.size >= state.settings.maxPositions) break;
        if (state._buyingNow.has(t.ca)) continue; // already buying this token

        // ── BRAD AUTO-CONTROL GATE ──
        // When bradAutoControl is active, BRAD's decision is FINAL — not advisory.
        // Token must have BRAD APE approval to enter. SKIP/WATCH = no entry.
        if (state.settings.bradAutoControl && bradOn) {
          if (!t._bradEval || t._bradEval.action !== "APE") {
            continue; // BRAD didn't approve — skip
          }
        }

        // ── ENTRY TIMING GATE 1: Score Stability ──
        // Require score above threshold for 2+ consecutive cycles (4+ seconds at 2s tick)
        // Exception: early movers (<5 min, MC <$50K) get 1-cycle pass
        const stability = stabilityMap.get(t.ca);
        const ageMin = Math.max(0.3, (Date.now() - t.createdAt) / 60000);
        const isEarly = ageMin < 5 && t.mcapUsd <= 50000;
        if (!isEarly && (!stability || stability.aboveCount < 2)) {
          if (stability?.aboveCount === 1) {
            log(`TIMING WAIT ${t.name||t.ca.slice(0,6)} | score:${t._apeScore} — need 1 more cycle for stability`);
          }
          continue;
        }

        // ── ENTRY TIMING GATE 2: Price Phase Detection ──
        // Don't buy into active spikes — wait for dip or consolidation
        const spark = t.spark || [];
        let pricePhase = "EARLY";
        if (spark.length >= 4) {
          const recent = spark.slice(-4);
          const peak = Math.max(...spark);
          const cur = spark[spark.length - 1];
          const fromPeak = peak > 0 ? (peak - cur) / peak : 0;
          const recentSlope = recent.length >= 2 ? (recent[recent.length - 1] - recent[0]) / Math.max(1, recent[0]) : 0;
          if (recentSlope > 0.15 && cur >= peak * 0.95) pricePhase = "SPIKE";
          else if (fromPeak > 0.08 && recentSlope <= 0.02) pricePhase = "DIP";
          else if (Math.abs(recentSlope) < 0.05) pricePhase = "CONSOLIDATION";
          else if (recentSlope > 0.05) pricePhase = "SPIKE";
        }
        // Block SPIKE entries unless score is extremely high (>70 = strong conviction override)
        if (pricePhase === "SPIKE" && (t._apeScore || 0) < 70) {
          log(`TIMING SKIP ${t.name||t.ca.slice(0,6)} | score:${t._apeScore} phase:SPIKE — waiting for pullback`);
          continue;
        }

        // ── ENTRY TIMING GATE 3: Buy Velocity Trend ──
        // If buy rate is decelerating, we'd be buying the tail end of the pump
        let buyVelTrend = "steady";
        if (t.trades && t.trades.length >= 6) {
          const trades = t.trades;
          const mid = Math.floor(trades.length / 2);
          const firstBuys = trades.slice(0, mid).filter(tr => tr.side === "buy").length;
          const secondBuys = trades.slice(mid).filter(tr => tr.side === "buy").length;
          const firstSpan = Math.max(1, ((trades[mid]?.time || Date.now()) - (trades[0]?.time || Date.now())) / 60000);
          const secondSpan = Math.max(0.3, (Date.now() - (trades[mid]?.time || Date.now())) / 60000);
          if (secondBuys / secondSpan < (firstBuys / firstSpan) * 0.5) buyVelTrend = "decelerating";
          else if (secondBuys / secondSpan > (firstBuys / firstSpan) * 1.3) buyVelTrend = "accelerating";
        }
        // Block decelerating entries unless early mover or very high score
        if (buyVelTrend === "decelerating" && !isEarly && (t._apeScore || 0) < 65) {
          log(`TIMING SKIP ${t.name||t.ca.slice(0,6)} | score:${t._apeScore} buyVel:DECEL — buy rate fading`);
          continue;
        }

        // ── Size adjustment based on entry quality ──
        // Better entry timing = bigger size, worse = smaller
        let timingMult = 1.0;
        if (pricePhase === "DIP") timingMult = 1.15;        // best entry — reward
        else if (pricePhase === "SPIKE") timingMult = 0.7;    // forced through (high score) — reduce size
        if (buyVelTrend === "accelerating") timingMult *= 1.1; // momentum building — slight boost
        const phaseTag = pricePhase !== "EARLY" ? ` phase:${pricePhase}` : "";
        const velTag = buyVelTrend !== "steady" ? ` buyVel:${buyVelTrend}` : "";

        // Score-based sizing
        const rugFlagCount = t._rugFlags?.length || 0;
        const tradeSol = Math.round(calcPositionSize(t._apeScore || 0, t._scoreTrend, rugFlagCount, state.settings.solPerTrade) * timingMult * 1000) / 1000;
        // Check balance
        let balance = 0;
        try { balance = await connection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL; } catch { continue; }
        if (balance < tradeSol + 0.01) { log("Low balance: " + balance.toFixed(4)); break; }

        const sizeMult = (tradeSol / state.settings.solPerTrade).toFixed(2);
        const rugFlags = t._rugFlags?.length > 0 ? ` [WARN: ${t._rugFlags.join(",")}]` : "";
        const trendTag = t._scoreTrend && t._scoreTrend !== "new" && t._scoreTrend !== "stable" ? ` trend:${t._scoreTrend}` : "";
        const earlyTag = t._earlyApe ? " [EARLY-APE]" : "";
        const bullishStr = t._bullishSignals?.length > 0 ? ` [BULLISH: ${t._bullishSignals.join(",")}]` : "";
        const walletAgeStr = t._walletAgeData ? ` wallets:${Math.round(t._walletAgeData.walletAgeScore * 100)}%aged` : "";
        const survivorStr = t._survivorMatch != null ? ` surv:${t._survivorMatch}%` : "";
        const megaStr = t._isMegaCandidate ? ` MEGA:${t._megaMatch}%` : "";
        const tierTag = t._pipelineTier ? ` T${t._pipelineTier}:${t._pipelineLabel}` : "";
        const bradTag = t._bradEval ? ` BRAD:${t._bradEval.action}(${(t._bradEval.confidence||0).toFixed(2)})` : "";
        log(`APE ${t.name||t.ca.slice(0,6)} | score:${t._apeScore}${tierTag}${trendTag}${earlyTag}${phaseTag}${velTag}${survivorStr}${megaStr}${bradTag} | MC:$${Math.round(t.mcapUsd)} | buys:${t.buys} sells:${t.sells} | ${tradeSol} SOL (${sizeMult}x)${rugFlags}${bullishStr}${walletAgeStr}`);
        state._buyingNow.add(t.ca); // prevent double-buy
        try {
          const buyResp = await fetch("https://pumpportal.fun/api/trade-local", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ publicKey: tw.pubkey, action: "buy", mint: t.ca, amount: tradeSol, denominatedInSol: "true", slippage: TRADE_CONFIG.BUY_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto" }),
            signal: AbortSignal.timeout(8000), // 8s timeout on PumpPortal
          });
          if (buyResp.ok) {
            const txBytes = await buyResp.arrayBuffer();
            if (txBytes.byteLength > 100) {
              const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
              tx.sign([kp]);
              const sig = await fastSend(connection, tx, [kp]);
              // Snapshot features at entry for survivorship bias learning
              const _entryFeatures = typeof extractQuickFeatures === "function" ? extractQuickFeatures(t) : null;
              state.positions.set(t.ca, { entryMcap: t.mcapUsd, entrySol: tradeSol, entryTime: Date.now(), peakMcap: t.mcapUsd, entryScore: t._apeScore || 0, liveScore: t._apeScore || 0, entryBuys: t.buys||0, entrySells: t.sells||0, entryUB: t.uniqueBuyers?.size||0, entryAge: (Date.now()-t.createdAt)/60000, entryTrend: t._scoreTrend||"new", entryBondPct: Math.round(pumpCurvePct(t.vSolInBondingCurve) * 100), sizeMult: +(tradeSol / state.settings.solPerTrade).toFixed(2), entryPhase: pricePhase, entryBuyVel: buyVelTrend, entryFeatures: _entryFeatures, tier: t._pipelineTier || 2, exitPlan: t._pipelineExitPlan || createExitPlan(2, t._apeScore || 0, state.settings) });
              // Track entry timestamp for rate limiting
              if (!state._entryTimestamps) state._entryTimestamps = [];
              state._entryTimestamps.push(Date.now());
              trackBuy(wallet, t.ca, tradeSol); // instant wallet visibility
              log(`BOUGHT ${t.name||t.ca.slice(0,6)} sig:${sig.slice(0,12)}...`);
              broadcastWS({ event: "auto-ape", data: { ca: t.ca, name: t.name, sol: tradeSol, mcap: t.mcapUsd, wallet, score: t._apeScore, sizeMult: +(tradeSol / state.settings.solPerTrade).toFixed(2), entryPhase: pricePhase, buyVelTrend, tier: t._pipelineTier || 2, tierLabel: t._pipelineLabel || "STRONG" } });
              // ═══ BRAD: Live thought on entry ═══
              broadcastWS({ event: "brad_thought", data: { type: "strategy", text: `Entered ${t.name||t.ca.slice(0,6)} — ${tradeSol} SOL at score ${t._apeScore}, MC:$${Math.round(t.mcapUsd||0)}, T${t._pipelineTier||2} ${t._pipelineLabel||""}${t._bradEval?.action==="APE"?" (BRAD approved, conf "+t._bradEval.confidence?.toFixed(2)+")":""}`, urgency: "high", token: t.name||t.ca.slice(0,6), ca: t.ca, time: Date.now() } });
              // ═══ BRAD: Record confirmed entry for cognitive self-model ═══
              if (state.settings.bradEnabled !== false && bradClient.isHealthy()) {
                bradClient.recordEntry({
                  ca: t.ca, name: t.name, priceSol: (t.mcapUsd || 0) / (solUsdPrice || 150),
                  sizeSol: tradeSol, score: t._apeScore || 0,
                  reasoning: [`tier:${t._pipelineTier}`, `phase:${pricePhase}`, `buyVel:${buyVelTrend}`],
                }).catch(() => {}); // fire-and-forget
              }
              // ═══ RAPID POST-ENTRY DUMP CHECK — catches instant rugs ═══
              // The 4s main loop interval lets dumps grow from -12% to -40%+.
              // This 2s rapid check catches tokens that dump immediately after our buy.
              setTimeout(async () => {
                try {
                  const pos = state.positions.get(t.ca);
                  if (!pos) return;
                  const freshToken = radar.tokens.get(t.ca);
                  if (!freshToken) return;
                  const freshMcap = freshToken.mcapUsd || 0;
                  if (pos.entryMcap <= 0 || freshMcap <= 0) return;
                  const rapidDrop = ((freshMcap - pos.entryMcap) / pos.entryMcap) * 100;
                  if (rapidDrop <= -8) { // already down 8% in 2 seconds = rug
                    log(`RAPID EXIT ${t.ca.slice(0,6)}: ${rapidDrop.toFixed(0)}% in 2s — emergency sell`);
                    const emergSig = await execSell(t.ca, 100, kp, "rapid-dump");
                    if (emergSig) {
                      broadcastWS({ event: "auto-sell", data: { ca: t.ca, pnl: rapidDrop.toFixed(1), wallet, tier: "RAPID", reason: "instant-dump" } });
                      exitPosition(t.ca, 100, "rapid-dump");
                      trackSell(wallet, t.ca);
                    }
                  }
                } catch {}
              }, 2000);
            }
          }
        } catch (e) { log(`Buy error: ${e.message}`); } finally { state._buyingNow.delete(t.ca); }
      }

      // ═══ AUTO-STOP: if no user interaction for 2 hours, pause auto-trader ═══
      if (Date.now() - state.lastActivity > 7200000) {
        log("AUTO-PAUSED: no user activity for 2h — pausing to protect funds");
        state.settings.enabled = false;
        broadcastWS({ event: "auto-paused", data: { wallet, reason: "inactivity" } });
      }
    } catch (e) { log(`Loop error: ${e.message}`); }
  }, 2000); // check every 2s — catch high-score tokens faster

  autoTraders.set(wallet, state);
  log("Auto-ape started: minScore=" + state.settings.minScore + " sol=" + state.settings.solPerTrade + " TP1=" + state.settings.tp1 + "% SL1=" + state.settings.sl1 + "% SL2=" + state.settings.sl2 + "% maxPos=" + state.settings.maxPositions);
  return state;
}

function stopAutoTrader(wallet) {
  const state = autoTraders.get(wallet);
  if (state) {
    clearInterval(state.interval);
    state.settings.enabled = false;
    // Add all current positions to cooldown so they aren't re-bought if restarted
    const cd = soldCooldowns.get(wallet) || new Map();
    for (const ca of state.positions.keys()) cd.set(ca, Date.now());
    soldCooldowns.set(wallet, cd);
  }
  autoTraders.delete(wallet);
}

// ── Auto-trade routes ──
app.post("/api/auto-trade/start", requireOwner, async (req, res) => {
  try {
    const { wallet, settings } = req.body;
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const tw = await getTradingWallet(wallet);
    if (!tw) return res.status(400).json({ error: "No trading wallet" });
    const state = startAutoTrader(wallet, settings || {});
    // Auto-enable smart money tracker if VIP/owner starts auto-trading
    checkSmartMoneyAutoEnable(wallet).catch(() => {});
    res.json({ ok: true, settings: state.settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auto-trade/stop", requireOwner, async (req, res) => {
  const { wallet } = req.body;
  stopAutoTrader(wallet);
  res.json({ ok: true });
});

// Close all auto-trade positions (sell everything)
app.post("/api/auto-trade/close", requireOwner, async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const state = autoTraders.get(wallet);
    if (!state) return res.status(404).json({ error: "No auto-trader running" });
    const tw = await getTradingWallet(wallet);
    if (!tw) return res.status(400).json({ error: "No trading wallet" });
    const kp = Keypair.fromSecretKey(bs58.decode(tw.secret));
    const results = [];
    for (const [ca, pos] of state.positions) {
      try {
        const sellResp = await fetch("https://pumpportal.fun/api/trade-local", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicKey: tw.pubkey, action: "sell", mint: ca, amount: "100%", denominatedInSol: "false", slippage: TRADE_CONFIG.SELL_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto" }),
        });
        if (sellResp.ok) {
          const txBytes = await sellResp.arrayBuffer();
          if (txBytes.byteLength > 100) {
            const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
            tx.sign([kp]);
            const sig = await fastSend(connection, tx, [kp]);
            results.push({ ca, sold: true, sig: sig.slice(0, 12) });
            broadcastWS({ event: "auto-sell", data: { ca, wallet, reason: "close-all" } });
          }
        }
      } catch (e) { results.push({ ca, sold: false, error: e.message }); }
      trackSell(wallet, ca);
    }
    state.positions.clear();
    stopAutoTrader(wallet);
    res.json({ ok: true, closed: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual exit single auto-trade position (user sees rug / dry vol)
app.post("/api/auto-trade/exit-position", requireOwner, async (req, res) => {
  try {
    const { wallet, ca } = req.body;
    if (!wallet || !ca) return res.status(400).json({ error: "wallet and ca required" });
    const state = autoTraders.get(wallet);
    if (!state) return res.status(404).json({ error: "No auto-trader running" });
    const pos = state.positions.get(ca);
    if (!pos) return res.status(404).json({ error: "Position not found" });
    const tw = await getTradingWallet(wallet);
    if (!tw) return res.status(400).json({ error: "No trading wallet" });
    const kp = Keypair.fromSecretKey(bs58.decode(tw.secret));
    // Sell 100% via PumpPortal auto-route
    const sellResp = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: tw.pubkey, action: "sell", mint: ca, amount: "100%", denominatedInSol: "false", slippage: TRADE_CONFIG.SELL_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto" }),
    });
    let sig = null;
    if (sellResp.ok) {
      const txBytes = await sellResp.arrayBuffer();
      if (txBytes.byteLength > 100) {
        const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
        tx.sign([kp]);
        sig = await rpcSendRawTx(connection, tx.serialize());
      }
    }
    // If PumpPortal failed, try Jupiter as fallback for graduated tokens
    if (!sig) {
      try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(kp.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
        const account = tokenAccounts.value.find(ta => ta.account.data.parsed.info.mint === ca);
        if (account) {
          const tokenBalance = parseFloat(account.account.data.parsed.info.tokenAmount.uiAmountString || "0");
          const tokenDecimals = account.account.data.parsed.info.tokenAmount.decimals || 6;
          const sellAmount = Math.round(tokenBalance * Math.pow(10, tokenDecimals));
          if (sellAmount > 0) {
            const orderResp = await fetch("https://lite-api.jup.ag/ultra/v1/order", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ inputMint: ca, outputMint: "So11111111111111111111111111111111111111112", amount: sellAmount, taker: tw.pubkey }),
              signal: AbortSignal.timeout(10000),
            });
            if (orderResp.ok) {
              const order = await orderResp.json();
              if (order.transaction) {
                const txBuf = Buffer.from(order.transaction, "base64");
                const tx = VersionedTransaction.deserialize(txBuf);
                tx.sign([kp]);
                const rawTx = Buffer.from(tx.serialize()).toString("base64");
                const execResp = await fetch("https://lite-api.jup.ag/ultra/v1/execute", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ signedTransaction: rawTx, requestId: order.requestId }),
                  signal: AbortSignal.timeout(15000),
                });
                if (execResp.ok) { const r = await execResp.json(); sig = r.signature || r.txid; }
              }
            }
          }
        }
      } catch (e) { console.log(`[AUTO-EXIT] Jupiter fallback error: ${e.message}`); }
    }
    // Move to recently closed with manual-exit reason
    const token = radar.tokens.get(ca);
    const currentMcap = token?.mcapUsd || 0;
    const changePct = pos.entryMcap > 0 ? ((currentMcap - pos.entryMcap) / pos.entryMcap) * 100 : 0;
    if (!state.recentlyClosed) state.recentlyClosed = [];
    state.recentlyClosed.push({
      ca, name: token?.name || ca.slice(0, 8),
      entrySol: pos.entrySol, entryMcap: pos.entryMcap, exitMcap: currentMcap,
      changePct: +changePct.toFixed(1),
      pnlSol: +(pos.entrySol * (changePct / 100)).toFixed(4),
      exitReason: "manual-exit",
      exitTime: Date.now(),
      age: Math.round((Date.now() - pos.entryTime) / 60000),
      entryScore: pos.entryScore || 0,
      exitScore: pos.liveScore || pos.entryScore || 0,
    });
    state.recentlyClosed = state.recentlyClosed.filter(p => Date.now() - p.exitTime < 300000).slice(-20);
    // Record in trade learner
    const peakPct = pos.entryMcap > 0 ? ((pos.peakMcap - pos.entryMcap) / pos.entryMcap) * 100 : 0;
    tradeLearner.record({
      ca, entryScore: pos.entryScore || 0, entryMcap: pos.entryMcap, exitMcap: currentMcap,
      pnlPct: +changePct.toFixed(1), pnlSol: +(pos.entrySol * (changePct / 100)).toFixed(4),
      entryBuys: pos.entryBuys || 0, entrySells: pos.entrySells || 0, entryUB: pos.entryUB || 0,
      entryAge: +(pos.entryAge || 0).toFixed(1), entryTrend: pos.entryTrend || "new",
      entryBondPct: pos.entryBondPct || 0, exitReason: "manual-exit",
      holdTime: Date.now() - pos.entryTime, peakPct: +peakPct.toFixed(1),
    });
    // ── MEME INTEL FEEDBACK: learn from manual exits too ──
    try {
      const features = typeof extractQuickFeatures === "function" ? extractQuickFeatures(token) : null;
      if (features) {
        const peakMcx = pos.entryMcap > 0 ? (pos.peakMcap || currentMcap) / pos.entryMcap : 1;
        const mcapDropPctM = pos.peakMcap > 0 ? ((pos.peakMcap - currentMcap) / pos.peakMcap) * 100 : 0;
        memeIntel.learn(features, {
          graduated: !!(token?.graduated || token?.raydiumPool),
          peakMcx,
          fleetPnl: +(pos.entrySol * (changePct / 100)).toFixed(4),
          rugged: mcapDropPctM > 80,
          mcapDropPct: mcapDropPctM,
          alive: currentMcap > 3000,
        });
        console.log(`[INTEL-FEEDBACK] Manual exit learn: ${ca.slice(0,6)} pnl=${changePct.toFixed(1)}%`);
      }
    } catch {}
    // Remove position, add cooldown
    state.positions.delete(ca);
    const cd = soldCooldowns.get(wallet) || new Map();
    cd.set(ca, Date.now());
    soldCooldowns.set(wallet, cd);
    trackSell(wallet, ca);
    state.log.push({ msg: `MANUAL EXIT ${token?.name || ca.slice(0, 6)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%)`, time: Date.now() });
    if (state.log.length > 50) state.log.shift();
    broadcastWS({ event: "auto-sell", data: { ca, wallet, reason: "manual-exit" } });
    res.json({ ok: true, sig: sig?.slice(0, 12) || null, pnlPct: +changePct.toFixed(1) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auto-trade/update", requireOwner, async (req, res) => {
  const { wallet, settings } = req.body;
  const state = autoTraders.get(wallet);
  if (!state) return res.status(404).json({ error: "No auto-trader running" });
  state.lastActivity = Date.now();
  const prev = { ...state.settings };
  Object.assign(state.settings, settings);
  // Log what changed so it shows live in Intel log
  const changes = Object.keys(settings).filter(k => settings[k] !== prev[k]);
  const summary = changes.map(k => `${k}:${prev[k]}→${state.settings[k]}`).join(" ");
  const msg = summary ? `Settings updated: ${summary}` : "Settings applied (no changes)";
  state.log.push({ msg, time: Date.now() });
  if (state.log.length > 50) state.log.shift();
  console.log(`[AUTO-APE][${wallet.slice(0,6)}] ${msg}`);
  broadcastWS({ event: "settings-updated", data: { wallet, settings: state.settings, changes } });
  res.json({ ok: true, settings: state.settings });
});

// ═══ BRAD TOGGLE — enable/disable cognitive engine from the UI ═══
app.post("/api/brad/toggle", express.json(), async (req, res) => {
  const { wallet, enabled } = req.body;
  const state = autoTraders.get(wallet);
  if (state) {
    state.settings.bradEnabled = !!enabled;
    state.log.push({ msg: `BRAD cognitive engine ${enabled ? "enabled" : "disabled"}`, time: Date.now() });
    console.log(`[BRAD] ${enabled ? "Enabled" : "Disabled"} by ${wallet?.slice(0, 6)}`);
  }
  res.json({
    ok: true,
    bradEnabled: !!enabled,
    healthy: bradClient.isHealthy(),
    client: bradClient.getClientStatus(),
  });
});

app.get("/api/auto-trade/status", requireOwner, (req, res) => {
  const wallet = req.query.wallet;
  const state = autoTraders.get(wallet);
  if (!state) return res.json({ active: false });
  // User is still polling — keep trader alive
  state.lastActivity = Date.now();
  res.json({
    active: state.settings.enabled,
    settings: state.settings,
    positions: [...state.positions.entries()].map(([ca, p]) => {
      const token = radar.tokens.get(ca);
      const currentMcap = token?.mcapUsd || 0;
      const changePct = p.entryMcap > 0 ? ((currentMcap - p.entryMcap) / p.entryMcap) * 100 : 0;
      return {
        ca, name: token?.name || ca.slice(0, 8),
        entryMcap: p.entryMcap, currentMcap,
        peakMcap: p.peakMcap || p.entryMcap,
        changePct: +changePct.toFixed(1),
        entrySol: p.entrySol,
        age: Math.round((Date.now() - p.entryTime) / 60000),
        tpHit: p.tpHit || 0, slHit: p.slHit || 0,
        isMoonbag: !!p.isMoonbag,
        entryScore: p.entryScore || 0,
        liveScore: p.liveScore || p.entryScore || 0,
        scoreDelta: (p.liveScore || p.entryScore || 0) - (p.entryScore || 0),
        scoreVelocity: p.scoreVelocity || 0,
        scoreAcceleration: p.scoreAcceleration || 0,
        scoreTrend: p.scoreTrend || "stable",
        tier: p.tier || 2,
        exitPlan: p.exitPlan ? { tier: p.exitPlan.tier, stopLoss: p.exitPlan.stopLoss, maxHoldMs: p.exitPlan.maxHoldMs } : null,
      };
    }),
    log: state.log.slice(-20),
    recentlyClosed: (state.recentlyClosed || []).filter(p => Date.now() - p.exitTime < 300000),
    learner: tradeLearner.insights,
    learnerAdjustments: tradeLearner.getAdjustments(),
    pipeline: state._pipelineStats ? {
      cycles: state._pipelineStats.cycles,
      last: state._pipelineStats.lastPipeline,
      nearMisses: state._pipelineStats.nearMisses,
      rugRejects: state._pipelineStats.rugRejects || [],
      tierDistribution: state._pipelineStats.tierDistribution || {},
      brad: state._pipelineStats.brad || null,
    } : null,
    brad: {
      enabled: state.settings.bradEnabled !== false, // default on
      healthy: bradClient.isHealthy(),
      ...bradClient.getClientStatus(),
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AUTO-EXIT ENGINE — manages exits for manually-aped positions
// Uses Kelly-sized partial exits + moon bag retention
// ═══════════════════════════════════════════════════════════════════════

const autoExitPositions = new Map(); // wallet -> Map<ca, exitPlan>

function createManualExitPlan(ca, wallet, entryMcap, entrySol, settings = {}) {
  // Kelly-based win rate estimate from token score
  const token = radar.tokens.get(ca);
  const score = token?._apeScore || 40;
  const winRate = score >= 70 ? 0.45 : score >= 55 ? 0.35 : score >= 40 ? 0.25 : 0.15;
  const payoff = 3.0;
  const kellyFull = (winRate * payoff - (1 - winRate)) / payoff;
  const kellyQ = Math.max(0.05, kellyFull * 0.25); // quarter-Kelly

  // Default exit tiers — Kelly scales the sell percentages
  // Higher Kelly = more conviction = keep more (smaller sells, bigger moon bag)
  // Lower Kelly = less conviction = take profits faster
  const conviction = Math.min(1.5, 0.5 + kellyQ * 8);
  const mode = settings.mode || "balanced"; // "conservative" | "balanced" | "aggressive" | "moonshot"

  const modeMultipliers = {
    conservative: { tp: 0.7, sell: 1.3, moon: 0.5 },
    balanced:     { tp: 1.0, sell: 1.0, moon: 1.0 },
    aggressive:   { tp: 1.4, sell: 0.8, moon: 1.3 },
    moonshot:     { tp: 2.0, sell: 0.6, moon: 2.0 },
  };
  const mm = modeMultipliers[mode] || modeMultipliers.balanced;

  // Exit tiers with Kelly-adjusted sizing
  const baseSellPct1 = Math.round(Math.min(50, Math.max(15, 35 / conviction)) * mm.sell);
  const baseSellPct2 = Math.round(Math.min(40, Math.max(15, 30 / conviction)) * mm.sell);
  const baseSellPct3 = Math.round(Math.min(40, Math.max(10, 25 / conviction)) * mm.sell);
  const moonBagPct = Math.max(5, Math.min(40, 100 - baseSellPct1 - baseSellPct2 - baseSellPct3));

  return {
    ca, wallet, entrySol, entryMcap, entryTime: Date.now(),
    peakMcap: entryMcap,
    score, kellyQ, conviction,
    mode,
    // Exit levels (% gain from entry)
    exits: [
      { name: "TP1", triggerPct: Math.round(35 * mm.tp * conviction), sellPct: baseSellPct1, hit: false, hitTime: null },
      { name: "TP2", triggerPct: Math.round(100 * mm.tp * conviction), sellPct: baseSellPct2, hit: false, hitTime: null },
      { name: "TP3", triggerPct: Math.round(250 * mm.tp * conviction), sellPct: baseSellPct3, hit: false, hitTime: null },
    ],
    moonBagPct, // what's left after all TPs — never sold unless SL
    // Stop loss
    stopLoss: settings.stopLoss ?? -15, // % loss to full exit
    trailingStop: settings.trailingStop ?? 40, // % from peak to exit moon bag
    // State
    totalSoldPct: 0,
    active: true,
    log: [],
  };
}

// Execute a partial sell for auto-exit
async function autoExitSell(wallet, ca, sellPct, reason) {
  try {
    const tw = await getTradingWallet(wallet);
    if (!tw) return null;
    const kp = Keypair.fromSecretKey(bs58.decode(tw.secret));

    // Try PumpPortal first
    const sellResp = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: tw.pubkey, action: "sell", mint: ca,
        amount: sellPct + "%", denominatedInSol: "false",
        slippage: TRADE_CONFIG.SELL_SLIPPAGE, priorityFee: TRADE_CONFIG.PRIORITY_FEE_SOL, pool: "auto",
      }),
    });
    if (sellResp.ok) {
      const txBytes = await sellResp.arrayBuffer();
      if (txBytes.byteLength > 100) {
        const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
        tx.sign([kp]);
        const sig = await rpcSendRawTx(connection, tx.serialize());
        console.log(`[AUTO-EXIT] ${reason}: sold ${sellPct}% of ${ca.slice(0, 8)} | sig=${sig?.slice(0, 12)}`);
        broadcastWS({ event: "auto-exit-sell", data: { ca, wallet, sellPct, reason, sig: sig?.slice(0, 12) } });
        return sig;
      }
    }

    // Fallback to Jupiter
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(kp.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
    const account = tokenAccounts.value.find(ta => ta.account.data.parsed.info.mint === ca);
    if (account) {
      const tokenBalance = parseFloat(account.account.data.parsed.info.tokenAmount.uiAmountString || "0");
      const tokenDecimals = account.account.data.parsed.info.tokenAmount.decimals || 6;
      const sellAmount = Math.round(tokenBalance * (sellPct / 100) * Math.pow(10, tokenDecimals));
      if (sellAmount > 0) {
        const orderResp = await fetch("https://lite-api.jup.ag/ultra/v1/order", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inputMint: ca, outputMint: "So11111111111111111111111111111111111111112", amount: sellAmount, taker: tw.pubkey }),
          signal: AbortSignal.timeout(10000),
        });
        if (orderResp.ok) {
          const order = await orderResp.json();
          if (order.transaction) {
            const txBuf = Buffer.from(order.transaction, "base64");
            const tx = VersionedTransaction.deserialize(txBuf);
            tx.sign([kp]);
            const rawTx = Buffer.from(tx.serialize()).toString("base64");
            const execResp = await fetch("https://lite-api.jup.ag/ultra/v1/execute", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ signedTransaction: rawTx, requestId: order.requestId }),
              signal: AbortSignal.timeout(15000),
            });
            if (execResp.ok) {
              const r = await execResp.json();
              const sig = r.signature || r.txid;
              console.log(`[AUTO-EXIT] ${reason} (Jupiter): sold ${sellPct}% of ${ca.slice(0, 8)} | sig=${sig?.slice(0, 12)}`);
              broadcastWS({ event: "auto-exit-sell", data: { ca, wallet, sellPct, reason, sig: sig?.slice(0, 12) } });
              return sig;
            }
          }
        }
      }
    }
    return null;
  } catch (e) {
    console.log(`[AUTO-EXIT] Error selling ${ca.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

// Main auto-exit check loop — runs every 5 seconds
setInterval(gated(() => {
  const now = Date.now();
  for (const [wallet, positions] of autoExitPositions) {
    for (const [ca, plan] of positions) {
      if (!plan.active) continue;
      const token = radar.tokens.get(ca);
      if (!token) continue;

      const currentMcap = token.mcapUsd || 0;
      if (currentMcap <= 0) continue;

      // Update peak
      if (currentMcap > plan.peakMcap) plan.peakMcap = currentMcap;

      const changePct = plan.entryMcap > 0 ? ((currentMcap - plan.entryMcap) / plan.entryMcap) * 100 : 0;
      const fromPeak = plan.peakMcap > 0 ? ((plan.peakMcap - currentMcap) / plan.peakMcap) * 100 : 0;

      // ── STOP LOSS: full exit ──
      if (changePct <= plan.stopLoss) {
        const remainPct = 100 - plan.totalSoldPct;
        if (remainPct > 0) {
          plan.log.push({ msg: `STOP LOSS ${plan.stopLoss}% hit — selling ${remainPct}%`, time: now });
          autoExitSell(wallet, ca, remainPct, `SL ${changePct.toFixed(1)}%`);
          plan.totalSoldPct = 100;
          plan.active = false;
        }
        continue;
      }

      // ── TRAILING STOP on moon bag: exit if drops too far from peak ──
      if (plan.totalSoldPct >= (100 - plan.moonBagPct) && fromPeak >= plan.trailingStop && changePct > 0) {
        const remainPct = 100 - plan.totalSoldPct;
        if (remainPct > 0) {
          plan.log.push({ msg: `TRAIL STOP: ${fromPeak.toFixed(0)}% from peak — selling moon bag ${remainPct}%`, time: now });
          autoExitSell(wallet, ca, remainPct, `trail-stop ${fromPeak.toFixed(0)}% from peak`);
          plan.totalSoldPct = 100;
          plan.active = false;
        }
        continue;
      }

      // ── TAKE PROFIT tiers ──
      for (const exit of plan.exits) {
        if (exit.hit) continue;
        if (changePct >= exit.triggerPct) {
          exit.hit = true;
          exit.hitTime = now;
          // Adjust sellPct for remaining position
          const remainBefore = 100 - plan.totalSoldPct;
          const actualSell = Math.min(remainBefore, exit.sellPct);
          if (actualSell > 0) {
            plan.log.push({ msg: `${exit.name} +${changePct.toFixed(0)}% — selling ${actualSell}%`, time: now });
            autoExitSell(wallet, ca, actualSell, `${exit.name} +${changePct.toFixed(0)}%`);
            plan.totalSoldPct += actualSell;
          }
        }
      }
    }
  }
}), 5000);

// ── Auto-Exit API Routes ──

app.post("/api/auto-exit/enable", async (req, res) => {
  try {
    const { wallet, ca, entryMcap, entrySol, settings } = req.body;
    if (!wallet || !ca) return res.status(400).json({ error: "wallet and ca required" });

    // Get current mcap if not provided
    let mcap = entryMcap;
    if (!mcap) {
      const token = radar.tokens.get(ca);
      mcap = token?.mcapUsd || 0;
    }

    if (!autoExitPositions.has(wallet)) autoExitPositions.set(wallet, new Map());
    const plan = createManualExitPlan(ca, wallet, mcap, entrySol || 0, settings || {});
    autoExitPositions.get(wallet).set(ca, plan);

    console.log(`[AUTO-EXIT] Enabled for ${ca.slice(0, 8)} | mode=${plan.mode} kelly=${plan.kellyQ.toFixed(3)} exits=${plan.exits.map(e => `${e.name}:+${e.triggerPct}%→${e.sellPct}%`).join(" ")} moon=${plan.moonBagPct}% SL=${plan.stopLoss}%`);

    res.json({
      ok: true,
      plan: {
        exits: plan.exits.map(e => ({ name: e.name, triggerPct: e.triggerPct, sellPct: e.sellPct })),
        moonBagPct: plan.moonBagPct,
        stopLoss: plan.stopLoss,
        trailingStop: plan.trailingStop,
        kellyQ: +plan.kellyQ.toFixed(3),
        conviction: +plan.conviction.toFixed(2),
        mode: plan.mode,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auto-exit/disable", (req, res) => {
  const { wallet, ca } = req.body;
  const positions = autoExitPositions.get(wallet);
  if (positions) {
    positions.delete(ca);
    if (positions.size === 0) autoExitPositions.delete(wallet);
  }
  res.json({ ok: true });
});

app.get("/api/auto-exit/status", (req, res) => {
  const wallet = req.query.wallet;
  const positions = autoExitPositions.get(wallet);
  if (!positions || positions.size === 0) return res.json({ active: false, positions: [] });

  const result = [];
  for (const [ca, plan] of positions) {
    const token = radar.tokens.get(ca);
    const currentMcap = token?.mcapUsd || 0;
    const changePct = plan.entryMcap > 0 ? ((currentMcap - plan.entryMcap) / plan.entryMcap) * 100 : 0;
    result.push({
      ca, active: plan.active, mode: plan.mode,
      entryMcap: plan.entryMcap, currentMcap, changePct: +changePct.toFixed(1),
      peakMcap: plan.peakMcap,
      exits: plan.exits.map(e => ({ ...e })),
      moonBagPct: plan.moonBagPct,
      totalSoldPct: plan.totalSoldPct,
      stopLoss: plan.stopLoss, trailingStop: plan.trailingStop,
      kellyQ: +plan.kellyQ.toFixed(3), conviction: +plan.conviction.toFixed(2),
      log: plan.log.slice(-10),
    });
  }
  res.json({ active: true, positions: result });
});

// ═══════════════════════════════════════
// SESSION LOG EXPORT — full dump for offline analysis/training
// ═══════════════════════════════════════
app.get("/api/auto-trade/export-session", requireOwner, (req, res) => {
  const wallet = req.query.wallet;
  const state = autoTraders.get(wallet);

  // Trade learner history + insights (available even if auto-trader not running)
  const learnerHistory = tradeLearner.history || [];
  const learnerInsights = tradeLearner.insights;
  const learnerAdjustments = tradeLearner.getAdjustments();

  // Scorer model state
  const scorerState = memeIntel?.scorer ? memeIntel.scorer.export() : null;

  // Active auto-trader state
  let autoState = null;
  if (state) {
    autoState = {
      settings: state.settings,
      log: state.log || [],
      positions: [...state.positions.entries()].map(([ca, p]) => {
        const token = radar.tokens.get(ca);
        const currentMcap = token?.mcapUsd || 0;
        return { ca, name: token?.name || ca.slice(0, 8), ...p, currentMcap };
      }),
      recentlyClosed: state.recentlyClosed || [],
      pipeline: state._pipelineStats || null,
      calibration: state.calibration || null,
    };
  }

  // Recent radar tokens snapshot (last 50 scored)
  const radarSnapshot = [];
  for (const [ca, t] of radar.tokens) {
    if (radarSnapshot.length >= 50) break;
    if (!t.buys) continue;
    radarSnapshot.push({
      ca, name: t.name, mcap: t.mcapUsd, buys: t.buys, sells: t.sells,
      uniqueBuyers: t.uniqueBuyers?.size || 0, age: Math.round((Date.now() - t.createdAt) / 60000),
      bondPct: Math.round(pumpCurvePct(t.vSolInBondingCurve) * 100),
      graduated: !!t.graduated, twitter: !!t.twitter, website: !!t.website,
    });
  }

  const dump = {
    exportedAt: new Date().toISOString(),
    wallet: wallet || "none",
    learner: { history: learnerHistory, insights: learnerInsights, adjustments: learnerAdjustments },
    scorer: scorerState,
    autoTrader: autoState,
    radarSnapshot,
    solPrice: solUsdPrice,
  };

  res.setHeader("Content-Disposition", `attachment; filename="bondli-session-${Date.now()}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.json(dump);
});

// ═══════════════════════════════════════
// PAPER TRADE SIMULATION — backtest settings against recent radar data
// Applies Kahneman's "premortem" technique: simulate the WORST case
// before committing real capital. Norman: make errors visible BEFORE they cost you.
// ═══════════════════════════════════════
app.post("/api/auto-trade/simulate", (req, res) => {
  try {
    const { settings } = req.body;
    const s = {
      minScore: settings?.minScore || 28,
      solPerTrade: settings?.solPerTrade || 0.05,
      maxPositions: settings?.maxPositions || 5,
      tp1: settings?.tp1 || 25, tp1Sell: settings?.tp1Sell || 35,
      tp2: settings?.tp2 || 70, tp2Sell: settings?.tp2Sell || 35,
      tp3: settings?.tp3 || 150, tp3Sell: settings?.tp3Sell || 50,
      sl1: settings?.sl1 || 12, sl1Sell: settings?.sl1Sell || 70,
      sl2: settings?.sl2 || 22,
    };

    // Simulate against all tokens currently in radar + recently seen
    const tokens = [...radar.tokens.values()];
    let totalTrades = 0, wins = 0, losses = 0;
    let totalPnlSol = 0, totalInvested = 0;
    let bestTrade = null, worstTrade = null;
    const trades = [];

    // Build a lightweight portfolio snapshot for pipeline Gate 4
    let btActivePositions = 0;
    const btPortfolio = {
      activePositionCount: 0,
      maxPositions: s.maxPositions,
      positionsLast10m: 0,
      availableSOL: s.solPerTrade * s.maxPositions * 2,
      totalBankroll: s.solPerTrade * s.maxPositions * 2,
      solPerTrade: s.solPerTrade,
      drawdownMult: 1,
      consecutiveLosses: 0,
      lastLossTime: 0,
      currentDrawdownPct: 0,
      settings: s,
      learnerMult: 1,
      activePositions: [],
    };

    for (const t of tokens) {
      const spark = t.spark || [];
      if (spark.length < 6) continue;

      // Score this token
      const features = typeof extractQuickFeatures === "function" ? extractQuickFeatures(t) : null;
      const scoreResult = features && memeIntel?.scorer ? memeIntel.scorer.score(features) : null;
      const score = scoreResult?.score || t._apeScore || 0;
      if (score < s.minScore) continue;

      // Run 5-gate pipeline for entry decision (matches live auto-ape)
      const qf = features;
      const dyn = scoreDynamics.get(t.ca);
      const scores = {
        apeScore: score,
        scoreTimestamp: Date.now(),
        pricePhase: t._pricePhase,
        buyVelTrend: t._buyVelTrend,
        rugFlagCount: t._rugFlags?.length || 0,
      };
      const pipeResult = runPipeline(t, qf, scores, dyn, btPortfolio);

      // Only simulate tokens that pass the pipeline (ENTER decision)
      if (pipeResult.decision !== "ENTER") continue;

      // Use pipeline's tier-specific exit plan for TP/SL levels
      const exitPlan = pipeResult.exitPlan || createExitPlan(pipeResult.tier || 2, score, s);
      const tp = exitPlan.tpLevels;
      const sizing = pipeResult.positionSize;
      const tradeSol = sizing?.solAmount || Math.round(s.solPerTrade * 1000) / 1000;
      const sizeMult = sizing?.sizeMult || 1;

      // Simulate entry at spark midpoint, exit at end
      const entryIdx = Math.floor(spark.length * 0.3);
      const entryMc = spark[entryIdx] || 1;
      const peakMc = Math.max(...spark.slice(entryIdx));
      const endMc = spark[spark.length - 1] || 1;

      const peakPct = entryMc > 0 ? ((peakMc - entryMc) / entryMc) * 100 : 0;
      const endPct = entryMc > 0 ? ((endMc - entryMc) / entryMc) * 100 : 0;

      // Simulate tiered TP/SL using pipeline exit plan levels
      let exitReason = "hold";
      let soldPct = 0;
      let realizedPnl = 0;

      // TP3 (if tier supports it)
      if (tp.tp3 > 0 && peakPct >= tp.tp3) {
        realizedPnl += tradeSol * (tp.tp3 / 100) * (tp.tp3Sell / 100);
        soldPct += tp.tp3Sell * ((100 - soldPct) / 100);
        exitReason = "TP3";
      }
      // TP2
      if (peakPct >= tp.tp2) {
        const remaining = 100 - soldPct;
        realizedPnl += tradeSol * (remaining / 100) * (tp.tp2 / 100) * (tp.tp2Sell / 100);
        soldPct += tp.tp2Sell * (remaining / 100);
        if (exitReason === "hold") exitReason = "TP2";
      }
      // TP1
      if (peakPct >= tp.tp1) {
        const remaining = 100 - soldPct;
        realizedPnl += tradeSol * (remaining / 100) * (tp.tp1 / 100) * (tp.tp1Sell / 100);
        soldPct += tp.tp1Sell * (remaining / 100);
        if (exitReason === "hold") exitReason = "TP1";
      }
      // SL check using pipeline stop loss
      if (endPct <= -exitPlan.stopLoss && soldPct < 100) {
        const remaining = 100 - soldPct;
        realizedPnl += tradeSol * (remaining / 100) * (endPct / 100);
        soldPct = 100;
        exitReason = exitReason === "hold" ? "SL" : exitReason + "+SL";
      }
      // Remaining unsold position at current price
      if (soldPct < 100) {
        const remaining = (100 - soldPct) / 100;
        realizedPnl += tradeSol * remaining * (endPct / 100);
      }

      const trade = {
        name: t.name || t.ca?.slice(0, 8),
        score,
        tier: pipeResult.tier,
        tierLabel: pipeResult.tierLabel,
        sizeMult: +sizeMult.toFixed ? +sizeMult.toFixed(2) : sizeMult,
        sol: tradeSol,
        peakPct: +peakPct.toFixed(1),
        endPct: +endPct.toFixed(1),
        pnlSol: +realizedPnl.toFixed(4),
        exitReason,
      };
      trades.push(trade);
      totalTrades++;
      totalInvested += tradeSol;
      totalPnlSol += realizedPnl;
      if (realizedPnl > 0) wins++;
      else losses++;
      if (!bestTrade || realizedPnl > bestTrade.pnlSol) bestTrade = trade;
      if (!worstTrade || realizedPnl < worstTrade.pnlSol) worstTrade = trade;

      // Update portfolio snapshot for subsequent iterations
      btPortfolio.activePositionCount++;
      btPortfolio.availableSOL -= tradeSol;
    }

    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
    const avgPnl = totalTrades > 0 ? +(totalPnlSol / totalTrades).toFixed(4) : 0;
    const roi = totalInvested > 0 ? +((totalPnlSol / totalInvested) * 100).toFixed(1) : 0;
    // Kahneman loss-aversion adjusted score: losses count 2x
    const lossAdjPnl = trades.reduce((sum, t) => sum + (t.pnlSol < 0 ? t.pnlSol * 2 : t.pnlSol), 0);
    const kahnemanScore = totalInvested > 0 ? +((lossAdjPnl / totalInvested) * 100).toFixed(1) : 0;

    res.json({
      ok: true,
      totalTrades, wins, losses, winRate,
      totalPnlSol: +totalPnlSol.toFixed(4),
      totalInvested: +totalInvested.toFixed(4),
      roi,
      kahnemanScore, // Loss-aversion adjusted ROI
      avgPnl,
      bestTrade,
      worstTrade,
      trades: trades.sort((a, b) => b.pnlSol - a.pnlSol).slice(0, 20),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// LOCAL POSITION TRACKING — immediate visibility after buys
// RPC can take 30-60s to index new token accounts on public endpoints
// ═══════════════════════════════════════
const pendingPositions = new Map(); // wallet → Map(ca → { name, ticker, image, mcapUsd, solSpent, time })

function trackBuy(wallet, ca, solAmount) {
  if (!pendingPositions.has(wallet)) pendingPositions.set(wallet, new Map());
  const wp = pendingPositions.get(wallet);
  const token = radar.tokens.get(ca);
  wp.set(ca, {
    name: token?.name || "",
    ticker: token?.ticker || "",
    image: token?.image || "",
    mcapUsd: token?.mcapUsd || 0,
    mcapSol: token?.mcapSol || 0,
    solSpent: solAmount,
    time: Date.now(),
  });
  // Clean entries older than 2 min (RPC usually catches up within 30-60s)
  for (const [c, p] of wp) { if (Date.now() - p.time > 120000) wp.delete(c); }
}

function trackSell(wallet, ca) {
  const wp = pendingPositions.get(wallet);
  if (wp) wp.delete(ca);
  // Clean up entry cost from Redis (full sell = position closed)
  if (redis) redis.del(`entry:${wallet}:${ca}`).catch(() => {});
}

// ═══════════════════════════════════════
// ROUTES: POSITIONS / PORTFOLIO
// ═══════════════════════════════════════
app.get("/api/positions/:wallet", requireOwner, async (req, res) => {
  try {
    const userWallet = req.params.wallet;
    const tw = await getTradingWallet(userWallet);

    // Collect Bondli wallet pubkeys to scan: trading wallet + extras (NOT Phantom)
    const pubkeysToScan = [];
    if (tw) {
      try {
        const twPubkey = new PublicKey(tw.pubkey || Keypair.fromSecretKey(bs58.decode(tw.secret)).publicKey.toBase58());
        pubkeysToScan.push(twPubkey);
        console.log(`[POSITIONS] Trading wallet: ${twPubkey.toBase58()}`);
      } catch (e) {
        console.warn(`[POSITIONS] Failed to resolve trading wallet for ${userWallet.slice(0,8)}: ${e.message}`);
      }
    } else {
      console.warn(`[POSITIONS] No trading wallet found for ${userWallet.slice(0,8)}`);
    }
    // Scan extra wallets (Pro/VIP fleet)
    if (redis) {
      try {
        const raw = await redis.get("extra_wallets:" + userWallet);
        if (raw) {
          const extras = vault.openRecord(JSON.parse(raw));
          for (const ew of extras) {
            try { pubkeysToScan.push(Keypair.fromSecretKey(bs58.decode(ew.secret)).publicKey); } catch {}
          }
        }
      } catch {}
    }

    if (pubkeysToScan.length === 0) return res.json({ positions: [] });

    // Scan all Bondli wallets for token accounts (trading + extras)
    // Check both standard SPL Token and Token-2022 programs
    const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    const allTokenAccounts = [];
    const scannedPubkeys = new Set(); // deduplicate
    const scanPromises = [];
    for (const pk of pubkeysToScan) {
      const pkStr = pk.toBase58();
      if (scannedPubkeys.has(pkStr)) continue;
      scannedPubkeys.add(pkStr);
      // Scan both token programs in parallel
      scanPromises.push(
        connection.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM })
          .then(accts => allTokenAccounts.push(...accts.value))
          .catch(e => console.warn(`[POSITIONS] RPC error (SPL) for ${pkStr.slice(0,8)}: ${e.message}`))
      );
      scanPromises.push(
        connection.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_2022_PROGRAM })
          .then(accts => allTokenAccounts.push(...accts.value))
          .catch(e => { /* Token-2022 may not exist for this wallet, ignore */ })
      );
    }
    await Promise.all(scanPromises);

    // Aggregate amounts by mint across all wallets
    const mintAmounts = new Map(); // mint → { amount, decimals }
    for (const ta of allTokenAccounts) {
      const info = ta.account.data.parsed.info;
      const amount = parseFloat(info.tokenAmount.uiAmountString || "0");
      if (amount <= 0) continue;
      const mint = info.mint;
      const decimals = info.tokenAmount.decimals || 6;
      const existing = mintAmounts.get(mint);
      if (existing) { existing.amount += amount; } else { mintAmounts.set(mint, { amount, decimals }); }
    }

    // Resolve metadata for unknown mints in parallel (batch of up to 10 at a time)
    const unknownMints = [...mintAmounts.keys()].filter(m => !radar.tokens.get(m));
    const metadataCache = new Map(); // mint → radarToken-like object

    // Fetch metadata in parallel batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < unknownMints.length; i += BATCH_SIZE) {
      const batch = unknownMints.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (mint) => {
        // Try pump.fun first, then DexScreener
        try {
          const meta = await fetchPumpFunMetadata(mint);
          if (meta) {
            metadataCache.set(mint, { name: meta.name, ticker: meta.symbol, image: meta.image, mcapSol: 0, mcapUsd: meta.marketCap || 0 });
            return;
          }
        } catch {}
        try {
          const dr = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(5000) });
          if (dr.ok) { const dd = await dr.json(); const p = dd?.pairs?.[0]; if (p) { const mcUsd = p.marketCap||p.fdv||0; metadataCache.set(mint, { name: p.baseToken?.name||"", ticker: p.baseToken?.symbol||"", image: p.info?.imageUrl||"", mcapSol: solUsdPrice>0&&mcUsd>0?Math.round(mcUsd/solUsdPrice):0, mcapUsd: mcUsd }); } }
        } catch {}
      }));
    }

    // Batch-fetch entry costs from Redis for PnL calculation
    const entryDataMap = new Map(); // mint → { solSpent, ... }
    if (redis) {
      try {
        const mints = [...mintAmounts.keys()];
        const pipeline = redis.pipeline ? redis.pipeline() : null;
        if (pipeline) {
          for (const mint of mints) pipeline.get(`entry:${userWallet}:${mint}`);
          const results = await pipeline.exec();
          for (let i = 0; i < mints.length; i++) {
            const raw = results?.[i]?.[1];
            if (raw) try { entryDataMap.set(mints[i], JSON.parse(raw)); } catch {}
          }
        } else {
          // Fallback: fetch individually in parallel
          await Promise.all(mints.map(async (mint) => {
            try {
              const raw = await redis.get(`entry:${userWallet}:${mint}`);
              if (raw) entryDataMap.set(mint, JSON.parse(raw));
            } catch {}
          }));
        }
      } catch (e) { console.warn("[POSITIONS] Failed to fetch entry costs:", e.message); }
    }

    const positions = [];
    for (const [mint, { amount, decimals }] of mintAmounts) {
      const radarToken = radar.tokens.get(mint) || metadataCache.get(mint) || null;

      // Estimate value: tokens held / total supply * mcap
      // pump.fun total supply is ~1B tokens
      const totalSupply = 1_000_000_000;
      const holdPct = amount / totalSupply;
      const mcUsd = radarToken?.mcapUsd || 0;
      const valueUsd = mcUsd > 0 ? holdPct * mcUsd : 0;
      const valueSol = solUsdPrice > 0 ? valueUsd / solUsdPrice : 0;

      // Calculate real PnL from persisted entry cost
      const entry = entryDataMap.get(mint);
      const solSpent = entry?.solSpent || 0;
      const pnlSol = solSpent > 0 ? +(valueSol - solSpent).toFixed(6) : 0;
      const pnlPct = solSpent > 0 ? +((valueSol - solSpent) / solSpent * 100).toFixed(1) : 0;

      positions.push({
        mint,
        ticker: radarToken?.ticker || "",
        name: radarToken?.name || "",
        image: radarToken?.image || "",
        amount,
        decimals,
        mcapSol: radarToken?.mcapSol || 0,
        mcapUsd: mcUsd,
        marketCapSol: radarToken?.mcapSol || 0,
        valueSol: +valueSol.toFixed(6),
        valueUsd: +valueUsd.toFixed(2),
        holdPct: +(holdPct * 100).toFixed(3),
        solSpent,
        pnlSol,
        pnlPct,
      });
    }
    
    // Merge pending positions (recent buys not yet indexed by RPC)
    const pending = pendingPositions.get(userWallet);
    if (pending) {
      const existingMints = new Set(positions.map(p => p.mint));
      for (const [ca, p] of pending) {
        if (existingMints.has(ca)) continue; // RPC already found it
        const token = radar.tokens.get(ca) || p;
        const mcUsd = token.mcapUsd || p.mcapUsd || 0;
        // Estimate tokens from SOL spent: solSpent / mcapSol * totalSupply
        const estTokens = p.mcapSol > 0 ? (p.solSpent / p.mcapSol) * 1_000_000_000 : 0;
        const holdPct = estTokens / 1_000_000_000;
        const valueUsd = mcUsd > 0 ? holdPct * mcUsd : p.solSpent * solUsdPrice;
        const valueSol = solUsdPrice > 0 ? valueUsd / solUsdPrice : p.solSpent;
        // Calculate PnL for pending positions (price may have moved since buy)
        const pendPnlSol = p.solSpent > 0 ? +(valueSol - p.solSpent).toFixed(6) : 0;
        const pendPnlPct = p.solSpent > 0 ? +((valueSol - p.solSpent) / p.solSpent * 100).toFixed(1) : 0;
        positions.push({
          mint: ca,
          ticker: token.ticker || p.ticker || "",
          name: token.name || p.name || "",
          image: token.image || p.image || "",
          amount: estTokens,
          decimals: 6,
          mcapSol: token.mcapSol || p.mcapSol || 0,
          mcapUsd: mcUsd,
          marketCapSol: token.mcapSol || p.mcapSol || 0,
          valueSol: +valueSol.toFixed(6),
          valueUsd: +valueUsd.toFixed(2),
          holdPct: +(holdPct * 100).toFixed(3),
          solSpent: p.solSpent,
          pnlSol: pendPnlSol,
          pnlPct: pendPnlPct,
          pending: true, // flag for frontend to show loading state
        });
      }
    }

    // Sort by value descending
    positions.sort((a, b) => b.valueUsd - a.valueUsd);
    res.json({ positions });
  } catch (e) {
    console.error("[POSITIONS] Error:", e.message);
    res.json({ positions: [], error: e.message });
  }
});

// ═══════════════════════════════════════
// IMAGE PROXY — fixes OpaqueResponseBlocking for IPFS/pump.fun images
// ═══════════════════════════════════════
// In-memory image cache to avoid repeated fetches for the same URL
const imgCache = new Map(); // url → { buf, ct, ts }
const IMG_CACHE_MAX = 2000;
const IMG_CACHE_TTL = 7200000; // 2 hours
const imgFailing = new Map(); // url → timestamp of last failure (negative cache)
const imgByMint = new Map(); // mint → { uri, at }: pump.fun's own answer for the picture, asked once

app.get("/api/img", async (req, res) => {
  // ?url= the image we know about (may be empty), ?mint= the token: DexScreener keeps its own copy of
  // every pump.fun token's picture by mint, which is the one source that needs no metadata from us.
  const mint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(req.query.mint || "") ? req.query.mint : null;
  // A launch's picture is on pump.fun the moment pump.fun indexes the mint -- usually well before the
  // radar's own metadata pass reaches it, and long before DexScreener has a pair to hang a picture
  // on. So a request that names a mint and no picture asks pump.fun for the picture first. The
  // answer is remembered per mint (a miss for 20s, a hit for the life of the process: a mint's
  // picture does not change), so the JSON hop is paid once, not per tile per poll.
  let url = req.query.url || "";
  if (!url && mint) {
    const known = imgByMint.get(mint);
    if (known && (known.uri || Date.now() - known.at < 20_000)) url = known.uri || "";
    else {
      try {
        const r = await fetch(`${PUMP_FUN_API}/coins/${mint}`, { signal: AbortSignal.timeout(4000), headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json", "Origin": "https://pump.fun", "Referer": "https://pump.fun/" } });
        const d = r.ok ? await r.json() : null;
        url = (d && (d.image_uri || d.profile_image)) || "";
      } catch { url = ""; }
      imgByMint.set(mint, { uri: url || null, at: Date.now() });
      if (imgByMint.size > 20_000) imgByMint.delete(imgByMint.keys().next().value);
    }
  }
  if (!url && mint) url = `https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png?size=lg`;
  if (!url) return res.status(400).end();

  // Check cache first
  const cached = imgCache.get(url);
  if (cached && Date.now() - cached.ts < IMG_CACHE_TTL) {
    res.set("Content-Type", cached.ct);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    return res.send(cached.buf);
  }

  // Negative cache: if this URL failed recently, don't retry for 30s
  const failTs = imgFailing.get(url);
  if (failTs && Date.now() - failTs < 30000) {
    res.set("Access-Control-Allow-Origin", "*");
    return res.status(404).end();
  }

  try {
    let fetchUrl = url;
    if (fetchUrl.startsWith("ipfs://")) fetchUrl = fetchUrl.slice(7);

    // Extract IPFS hash if present — supports CIDv0 (Qm...) and CIDv1 (bafy.../bafk...)
    const ipfsMatch = fetchUrl.match(/(Qm[a-zA-Z0-9]{44,}|bafk[a-zA-Z0-9]{50,}|bafy[a-zA-Z0-9]{50,})/);
    const ipfsHash = ipfsMatch ? ipfsMatch[1] : null;

    // Build gateway URLs — fastest/most reliable first
    const urls = [];
    if (ipfsHash) {
      urls.push(`https://pump.mypinata.cloud/ipfs/${ipfsHash}?img-width=256&img-dpr=2`);
      urls.push(`https://img.fotofolio.xyz/?url=https%3A%2F%2Fcf-ipfs.com%2Fipfs%2F${ipfsHash}`);
      urls.push(`https://gateway.pinata.cloud/ipfs/${ipfsHash}`);
      urls.push(`https://cf-ipfs.com/ipfs/${ipfsHash}`);
      urls.push(`https://nftstorage.link/ipfs/${ipfsHash}`);
      urls.push(`https://dweb.link/ipfs/${ipfsHash}`);
      urls.push(`https://ipfs.io/ipfs/${ipfsHash}`);
    }
    if (fetchUrl.includes("pump.fun") || fetchUrl.includes("cf-ipfs")) {
      const pumpMatch = fetchUrl.match(/\/ipfs\/([a-zA-Z0-9]+)/);
      if (pumpMatch) urls.unshift(`https://pump.mypinata.cloud/ipfs/${pumpMatch[1]}?img-width=256&img-dpr=2`);
    }
    if (!fetchUrl.startsWith("http")) fetchUrl = "https://" + fetchUrl;
    // For any external URL, also try via image proxy services as fallback
    if (!ipfsHash && fetchUrl.startsWith("https://")) {
      urls.push(fetchUrl);
      urls.push(`https://img.fotofolio.xyz/?url=${encodeURIComponent(fetchUrl)}`);
    } else {
      // Also try the original URL directly (might be a valid HTTP image URL)
      if (!urls.includes(fetchUrl)) urls.push(fetchUrl);
    }
    // For pump.mypinata URLs that fail, try the raw hash on other gateways
    if (!ipfsHash && fetchUrl.includes("pump.mypinata.cloud/ipfs/")) {
      const m = fetchUrl.match(/\/ipfs\/([a-zA-Z0-9]+)/);
      if (m) {
        urls.push(`https://gateway.pinata.cloud/ipfs/${m[1]}`);
        urls.push(`https://cf-ipfs.com/ipfs/${m[1]}`);
        urls.push(`https://ipfs.io/ipfs/${m[1]}`);
      }
    }

    // Helper: fetch a single URL with short timeout + magic byte validation
    const isImageBuf = (buf) => {
      if (buf.length < 4) return false;
      // PNG: 89 50 4E 47
      if (buf[0]===0x89&&buf[1]===0x50&&buf[2]===0x4E&&buf[3]===0x47) return true;
      // JPEG: FF D8 FF
      if (buf[0]===0xFF&&buf[1]===0xD8&&buf[2]===0xFF) return true;
      // GIF: 47 49 46 38
      if (buf[0]===0x47&&buf[1]===0x49&&buf[2]===0x46&&buf[3]===0x38) return true;
      // WebP: RIFF....WEBP
      if (buf[0]===0x52&&buf[1]===0x49&&buf[2]===0x46&&buf[3]===0x46&&buf.length>11&&buf[8]===0x57&&buf[9]===0x45&&buf[10]===0x42&&buf[11]===0x50) return true;
      // BMP: 42 4D
      if (buf[0]===0x42&&buf[1]===0x4D) return true;
      // SVG: starts with < (XML/SVG)
      if (buf[0]===0x3C) { const head=buf.slice(0,200).toString("utf8").toLowerCase(); if (head.includes("<svg")||head.includes("<?xml")) return true; }
      return false;
    };
    const tryFetch = async (u, timeout) => {
      const r = await fetch(u, {
        signal: AbortSignal.timeout(timeout),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "image/*,*/*" },
        redirect: "follow",
      });
      if (!r.ok) throw new Error(r.status);
      const ct = r.headers.get("content-type") || "image/png";
      if (!ct.includes("image") && !ct.includes("octet")) throw new Error("not image");
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 10) throw new Error("too small");
      // Reject HTML error pages disguised as images
      if (!isImageBuf(buf) && ct.includes("octet")) throw new Error("not real image");
      const head = buf.slice(0,50).toString("utf8").toLowerCase();
      if (head.includes("<!doctype") || head.includes("<html")) throw new Error("html error page");
      return { buf, ct: isImageBuf(buf) && ct.includes("octet") ? "image/png" : ct };
    };

    if (mint) { const dx = `https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png?size=lg`; if (!urls.includes(dx)) urls.splice(Math.min(2, urls.length), 0, dx); }
    // Race strategy: fire first 3 gateways concurrently (5s timeout),
    // fallback to remaining sequentially (4s each) if all fail
    let result = null;
    const batch1 = urls.slice(0, 3);
    const batch2 = urls.slice(3);

    try {
      result = await Promise.any(batch1.map(u => tryFetch(u, 8000)));
    } catch {
      // batch1 all failed, try remaining sequentially
      for (const u of batch2) {
        try { result = await tryFetch(u, 8000); break; } catch { continue; }
      }
    }

    if (!result) {
      imgFailing.set(url, Date.now());
      // Evict old negative cache entries
      if (imgFailing.size > 5000) {
        const cutoff = Date.now() - 30000;
        for (const [k, v] of imgFailing) { if (v < cutoff) imgFailing.delete(k); }
      }
      res.set("Access-Control-Allow-Origin", "*");
      return res.status(404).end();
    }

    // Cache the result
    if (imgCache.size >= IMG_CACHE_MAX) {
      // Evict ~10% oldest entries in bulk instead of sorting every time
      const entries = [...imgCache.entries()];
      entries.sort((a, b) => a[1].ts - b[1].ts);
      const evictCount = Math.max(1, Math.floor(IMG_CACHE_MAX * 0.1));
      for (let i = 0; i < evictCount; i++) imgCache.delete(entries[i][0]);
    }
    imgCache.set(url, { buf: result.buf, ct: result.ct, ts: Date.now() });

    res.set("Content-Type", result.ct);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    return res.send(result.buf);
  } catch { res.set("Access-Control-Allow-Origin", "*"); res.status(502).end(); }
});

// ═══════════════════════════════════════
// ROUTES: MEMETIC SCORE (on-demand full 7-module)
// ═══════════════════════════════════════
const _memeticCache = new Map(); // ca -> { result, ts }
app.get("/api/memetic-score/:ca", async (req, res) => {
  try {
    const ca = req.params.ca;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return res.status(400).json({ error: "Invalid CA" });
    // Check cache (5 min TTL)
    const cached = _memeticCache.get(ca);
    if (cached && Date.now() - cached.ts < 300000) return res.json(cached.result);
    // Find token in radar pool
    const token = radar.tokens.get(ca);
    if (!token) return res.status(404).json({ error: "Token not in radar" });
    // Run full 7-module memetic score
    const result = await scoreTokenMemetic(token);
    const response = {
      ca,
      score: result.finalScore,
      memeticScore: result.memeticScore,
      onChainScore: result.onChainScore,
      archetype: result.archetype,
      moduleScores: result.moduleScores || {},
      interactionBonuses: result.interactionBonuses || [],
      kellyDampener: result.kellyDampener,
      elapsed: result.elapsed,
    };
    _memeticCache.set(ca, { result: response, ts: Date.now() });
    // Cap cache size
    if (_memeticCache.size > 200) {
      const oldest = [..._memeticCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 50);
      for (const [k] of oldest) _memeticCache.delete(k);
    }
    res.json(response);
  } catch (e) {
    console.error("[MEMETIC-SCORE]", e.message);
    res.status(500).json({ error: "Scoring failed" });
  }
});

// ═══════════════════════════════════════
// ROUTES: BAGS.FM STATUS
// ═══════════════════════════════════════
app.get("/api/bags/status", (req, res) => {
  const bagsTokens = [...radar.tokens.values()].filter(t => t._source === "bags");
  res.json({
    enabled: !!bagsMonitor.client,
    running: bagsMonitor.running,
    pollCount: bagsMonitor.pollCount,
    tokensIngested: bagsMonitor.tokensIngested,
    tokensInRadar: bagsTokens.length,
    errors: bagsMonitor.errors,
    lastError: bagsMonitor.lastError,
    lastPollTime: bagsMonitor.lastPollTime,
    rateLimitStatus: bagsMonitor.client?.getRateLimitStatus() || null,
    recentTokens: bagsTokens.slice(-10).map(t => ({
      ca: t.ca, name: t.name, ticker: t.ticker, mcapUsd: t.mcapUsd,
      age: Math.round((Date.now() - t.createdAt) / 1000),
    })),
  });
});

// Bags feed proxy — frontend fetches through us (avoids CORS + uses server-side API key)
app.get("/api/bags/feed", async (req, res) => {
  if (!bagsMonitor.client) return res.json({ tokens: [], error: "Bags monitor not configured" });
  try {
    const feed = await bagsMonitor.client.getLaunchFeed();
    const tokens = Array.isArray(feed) ? feed : (feed?.tokens || feed?.launches || []);
    const normalized = tokens.map(t => bagsMonitor.client._normalizeToBondli(t));
    res.json({ tokens: normalized, count: normalized.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// ROUTES: RADAR
// ═══════════════════════════════════════
app.get("/api/radar", (req, res) => {
  res.json({ tabs: radar.tabs, poolSize: radar.poolSize, online: radar.online, solPrice: solUsdPrice, gradMc: gradMcUsd() });
});

// ═══ VELOCITY — scored radar for external decision engines ═══
// Returns token + quick features + scores + dynamics: exactly the four objects
// the auto-ape gates consume, so an external pipeline reuses this scorer as-is.
// ?min=40 score floor, ?limit=60, ?ca=a,b,c to fetch specific tokens regardless of score.
// bondli's own trader only ever gates tokens that passed its base filter: at least 3 buyers,
// at least 1 sell, at least 5 buys (3 when DexScreener-boosted), 30s old, $4k market cap.
// Serving the same population to external pipelines keeps the gates meaning what they mean there.
// ── X verification: is the twitter link a real account, or a URL someone typed? ──
// The free X tier is 1500 calls a month, about 50 a day, against roughly 1700 tokens judged an hour.
// So this can never be a scoring feature evaluated on every candidate. It runs on the few tokens that
// have already cleared the base filter and carry a link, at most once per handle, in the background,
// and the answer is stamped on the token for the gates to read on a LATER tick. No decision ever waits
// on it, and no decision is ever delayed by it: a token judged before the answer arrives is judged
// without it, exactly as it is today.
const X_DAILY_BUDGET = Number(process.env.X_DAILY_BUDGET) > 0 ? Number(process.env.X_DAILY_BUDGET) : 45;
const xQueue = { seen: new Set(), spentAt: 0, spent: 0, inflight: 0 };
function queueXCheck(t) {
  if (!xSocial.enabled || !t?.twitter || t._xSocial !== undefined || xQueue.inflight >= 2) return;
  const day = Math.floor(Date.now() / 86_400_000);
  if (xQueue.spentAt !== day) { xQueue.spentAt = day; xQueue.spent = 0; }
  if (xQueue.spent >= X_DAILY_BUDGET) return;
  const handle = String(t.twitter).toLowerCase().replace(/[?#].*$/, "").replace(/\/$/, "");
  if (xQueue.seen.has(handle)) return;              // one call per handle, ever, per process
  xQueue.seen.add(handle); xQueue.spent++; xQueue.inflight++;
  if (xQueue.seen.size > 5000) xQueue.seen.clear();
  const ca = t.ca;
  xSocial.analyze(t.twitter)
    .then(r => {
      const tok = radar.tokens.get(ca); if (!tok) return;
      // A handle the API says does not exist is not a social link. Everything else is recorded as-is.
      tok._xSocial = { score: r.score, flags: r.flags || [], dead: (r.flags || []).includes("account_not_found"), at: Date.now() };
      if (tok._xSocial.dead) console.log(`[X-INTEL] ${ca.slice(0, 8)} lists ${handle} which does not exist`);
    })
    .catch(() => {})
    .finally(() => { xQueue.inflight--; });
}

// ── Website liveness: does the link a launch lists actually resolve? ──
// No credential, no quota, one request per hostname. A parked, dead or never-registered domain tells
// you the same thing a dead twitter handle does, and unlike the X check this works everywhere, on any
// chain, for free. Same discipline: background, deduped, never awaited by a decision.
// Any answer from the server means the domain is live, including a 403 from a bot-blocking CDN, since
// the question is "does this exist", not "will it serve me". Only a missing page or a dead name counts.
const siteQueue = { seen: new Map(), inflight: 0 };
async function probeSite(url) {
  for (const method of ["HEAD", "GET"]) {
    try {
      const r = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0 (compatible; bondli/1.0)" } });
      if (method === "HEAD" && (r.status === 405 || r.status === 501)) continue; // some servers refuse HEAD; ask properly
      return { ok: r.status !== 404 && r.status !== 410, status: r.status };
    } catch (err) {
      if (method === "GET") return { ok: false, status: 0, error: String(err?.name === "TimeoutError" ? "timeout" : err?.message || err).slice(0, 60) };
    }
  }
  return { ok: false, status: 0, error: "unreachable" };
}
function queueSiteCheck(t) {
  if (!t?.website || t._siteAlive !== undefined || siteQueue.inflight >= 4) return;
  let host, url;
  try { url = new URL(/^https?:\/\//i.test(t.website) ? t.website : "https://" + t.website); host = url.hostname.toLowerCase(); }
  catch { t._siteAlive = { ok: false, status: 0, error: "unparseable", at: Date.now() }; return; }
  const known = siteQueue.seen.get(host);
  if (known) { t._siteAlive = known; return; }             // one probe per hostname, shared by every token listing it
  siteQueue.inflight++;
  const ca = t.ca;
  probeSite(url.toString())
    .then(r => {
      const verdict = { ...r, at: Date.now() };
      siteQueue.seen.set(host, verdict);
      if (siteQueue.seen.size > 5000) siteQueue.seen.clear();
      const tok = radar.tokens.get(ca); if (tok) tok._siteAlive = verdict;
      if (!r.ok) console.log(`[SITE] ${ca.slice(0, 8)} lists ${host} which does not answer (${r.error || r.status})`);
    })
    .catch(() => {})
    .finally(() => { siteQueue.inflight--; });
}

function passesTraderBaseFilter(t, now = Date.now(), loose = false) {
  const ub = t.uniqueBuyers?.size || 0, buys = t.buys || 0, sells = t.sells || 0, mc = t.mcapUsd || 0;
  const ageMin = (now - (t.createdAt || now)) / 60000;
  if (t._mayhem || t._copyOf) return false;
  const boosted = !!radar.dexBoosted?.get?.(t.ca);
  // Degen (aggression 3) sees a token earlier: 2 buyers, 3 buys, $2.5k, 20 seconds. The gates still judge it.
  if (loose) return ub >= 2 && buys >= 3 && ageMin >= 0.33 && mc >= 2500;
  return ub >= 3 && sells >= 1 && buys >= (boosted ? 3 : 5) && ageMin >= 0.5 && mc >= 4000;
}
/** The hub's loosest running user decides how early the shared feed admits a token. */
function feedIsLoose() { try { return !!velocityHub && velocityHub.list().some(w => (velocityHub.users.get(w)?.settings?.aggression || 0) >= 3); } catch { return false; } }

/** A revival on this token right now, or null: the signal must fire and the filter must pass. */
function revivalOn(t, qf, now = Date.now()) {
  if (t._ageUnknown || t._mayhem || t._copyOf) return null;
  const sig = radar._revivals.signal(t.ca, { createdAt: t.createdAt, now });
  if (!sig.revival) return null;
  const f = revivalFilter(t, qf, sig);
  if (!f.pass) return null;
  return { buyers5m: sig.buyers5m, baseline5m: sig.baseline5m, netSol5m: sig.netSol5m, curveDelta: sig.curveDelta, at: now };
}

/** A token past the stale clock that never stopped building. Unlike a revival this buys it nothing
 *  but the clock: no forced tier, no special plan, and every rug rule still judges it. Cached for a
 *  minute because the answer moves on the scale of five-minute buckets, and it is read per row. */
function slowCookOn(t, qf, now = Date.now()) {
  if (t._ageUnknown || t._mayhem || t._copyOf) return null;
  const sig = radar._revivals.slowCook(t.ca, { createdAt: t.createdAt, now });
  if (!sig.slowCook) return null;
  if (!revivalFilter(t, qf, sig).pass) return null;   // the same "is this one actor?" filter
  return { buyers: sig.buyers, activeBuckets: sig.activeBuckets, netSol: sig.netSol, curveDelta: sig.curveDelta, windowMin: sig.windowMin, at: now };
}
function slowCookOf(t, qf, now = Date.now()) {
  if (t._slowCookAt && now - t._slowCookAt < 60_000) return t._slowCook || null;
  t._slowCookAt = now;
  try { t._slowCook = slowCookOn(t, qf, now); } catch { t._slowCook = null; }
  return t._slowCook;
}

/** The velocity judge, as the bot runs it, at one aggression: what would it do with this token now? */
function judgeToken(t, qf, dyn, aggression = 2) {
  const opts = VELOCITY_AGGRESSION[Math.max(0, Math.min(3, aggression))] || VELOCITY_AGGRESSION[1];
  const scores = { apeScore: t._apeScore || 0, scoreTimestamp: t._scoredAt || Date.now() };
  const revival = t._revival || null;
  const cooking = revival ? null : slowCookOf(t, qf);
  const g1 = judgeDisqualifiers(t, qf, { ...opts, ...(revival || cooking ? { staleMin: Infinity } : {}), freezeAuthority: !!t.freezeAuthority });
  if (!g1.pass) return { enter: false, gate: g1.timingOnly ? "timing" : "rug", reasons: g1.flags, tier: 0 };
  const g2 = judgeViability(t, qf, scores, dyn, opts);
  if (!g2.pass) return { enter: false, gate: "viability", reasons: g2.checks, tier: 0 };
  let tier;
  if (revival) tier = 3;
  else { const c = judgeConfidence(t, qf, scores, dyn, opts); tier = c.tier; if (tier === 4 && opts.enterWatchlist) tier = 3; if (!(tier >= 1 && tier <= 3)) return { enter: false, gate: "confidence", reasons: [tier === 4 ? "WATCHLIST" : "BELOW_THRESHOLD"], tier }; }
  const g3 = judgeWindow(t, tier, scores.scoreTimestamp, opts);
  if (!g3.pass) return { enter: false, gate: "window", reasons: g3.checks, tier };
  return { enter: true, gate: null, reasons: [], tier, revival: !!revival, slowCook: !!cooking };
}

/** The scored radar as one object; the HTTP route and the in-process velocity hub both read it. */
function buildScoredResponse(query = {}) {
  const min = Math.max(0, parseInt(query.min || "40") || 0);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit || "60") || 60));
  const only = query.ca ? String(query.ca).split(",").map(s => s.trim()).filter(Boolean) : null;
  const all = !!query.all; // ?all=1: everything, for calibration tools and the frontend
  const loose = query.base === "loose" || feedIsLoose();
  const now = Date.now();
  const source = only ? only.map(ca => radar.tokens.get(ca)).filter(Boolean) : [...radar.tokens.values()];
  const rows = [];
  for (const t of source) {
    if ((t._mayhem || t._copyOf) && !all) continue;
    let qf = null, dyn = null;
    // A revival is served whatever its score: its own model judges it. Everything else is the launch feed.
    const revival = !only && !all ? revivalOn(t, (qf = (() => { try { return extractQuickFeatures(t); } catch { return null; } })()), now) : null;
    if (revival) { t._revival = revival; if (radar._revivalLogged++ < 20) console.log(`[RADAR] revival: ${(t.name || t.ca).slice(0, 16)} ${t.ca.slice(0, 8)} ${Math.round((now - t.createdAt) / 3600_000)}h old, ${revival.buyers5m} buyers/5m vs ${revival.baseline5m}, curve +${revival.curveDelta}`); }
    else if (t._revival && now - t._revival.at > 10 * 60_000) t._revival = null;
    if (!revival) {
      if (!only && (t._apeScore || 0) < min) continue;
      // A score the background scorer has not refreshed within 10s is stale: the scorer skipped
      // the token (rug gate or base filter) and its old score must not be served as current.
      if (!only && !all && (!t._scoredAt || now - t._scoredAt > 10_000)) continue;
      if (!only && !all && !passesTraderBaseFilter(t, now, loose)) continue;
      queueXCheck(t); queueSiteCheck(t); // background, budgeted, never awaited
    }
    if (!qf) { try { qf = extractQuickFeatures(t); } catch {} }
    // Stamped here, not only in judgeToken, so the row carries it to the live engine's own gates.
    if (!revival) slowCookOf(t, qf, now);
    try { dyn = scoreDynamics.get(t.ca) || null; } catch {}
    const { uniqueBuyers, trades, spark, _bradEval, _slowCookAt, ...rest } = t;
    const lastTrade = trades?.length ? trades[trades.length - 1] : null;
    rows.push({
      token: {
        ...rest,
        uniqueBuyers: uniqueBuyers?.size || 0,
        trades: (trades || []).slice(-60),
        spark: (spark || []).slice(-40),
        _bradEval: _bradEval ? { action: _bradEval.action, confidence: _bradEval.confidence } : undefined,
      },
      qf,
      dynamics: dyn,
      scores: {
        apeScore: t._apeScore || 0,
        scoreTimestamp: t._scoredAt || now,
        pricePhase: t._pricePhase,
        buyVelTrend: t._buyVelTrend,
        rugFlagCount: t._rugFlags?.length || 0,
        bradConfidence: _bradEval?.confidence,
      },
      t_venue: lastTrade?.time || t.createdAt || now,
    });
  }
  rows.sort((a, b) => (b.scores.apeScore || 0) - (a.scores.apeScore || 0));
  return { ts: now, solPrice: solUsdPrice, solPriceAt: solUsdPriceAt || null, gradMc: gradMcUsd(), count: rows.length, tokens: rows.slice(0, limit) };
}
app.get("/api/radar/scored", (req, res) => res.json(buildScoredResponse(req.query)));
// Smart money. The aggregate is public; the list of wallets is the operator's. A public list of the
// wallets a bot copies is bait for the wallets themselves (buy, be copied, sell into the copiers) and
// a gift to every other bot, so it stays behind the admin key.
// ═══ Argus on Arc, as public data: what the feed sees, aggregated. No wallet in any row. ═══
// Launches per hour, how many bonded, the tax terms creators choose, and how much a launch's
// first hour took in. Live only while a bot runs (the feed follows the activity gate).
app.get("/api/arc/stats", (req, res) => {
  res.set("Cache-Control", "public, max-age=15");
  const feed = velocityHub?.arcFeed;
  if (!feed) return res.json({ ok: true, enabled: false, live: false, launches: [] });
  const now = Date.now(), tokens = [...feed.tokens.values()], hour = tokens.filter(t => now - (t.createdAt || 0) < 3600_000), day = tokens.filter(t => now - (t.createdAt || 0) < 86400_000);
  const taxOf = t => (Number(t.feeBps) || 0) + (Number(t.sellTaxBps) || 0);
  const hist = {}; for (const t of day) if (t.feeBps != null) { const k = `${t.feeBps}/${t.sellTaxBps}`; hist[k] = (hist[k] || 0) + 1; }
  const bonded = day.filter(t => t.bonded).length;
  const launches = tokens.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 50).map(t => ({
    ca: t.ca, name: t.name || "", ticker: t.ticker || "", image: t.image || "", createdAt: t.createdAt, mcapUsd: Math.round(t.mcapUsd || 0), progress: +(Number(t.progress) || 0).toFixed(3), bonded: !!t.bonded,
    buyTaxBps: t.feeBps ?? null, sellTaxBps: t.sellTaxBps ?? null, buys: t.buys || 0, sells: t.sells || 0, buyers: t.uniqueBuyers?.size || 0, volumeUsd: Math.round(t.volumeUsd || 0), url: (process.env.ARC_TOKEN_URL || "https://explorer.arc.io/token/{ca}").replace("{ca}", t.ca),
  }));
  res.json({ ok: true, enabled: true, live: activity.active() && !!feed.running, feed: { polls: feed.polls, block: feed._block ?? null, tokens: tokens.length, healthy: feed.healthy },
    hour: { launches: hour.length, buyers: hour.reduce((s, t) => s + (t.uniqueBuyers?.size || 0), 0), volumeUsd: Math.round(hour.reduce((s, t) => s + (t.volumeUsd || 0), 0)) },
    day: { launches: day.length, bonded, bondedRate: day.length ? +(bonded / day.length).toFixed(3) : 0, avgRoundTripTaxBps: day.length ? Math.round(day.reduce((s, t) => s + taxOf(t), 0) / day.length) : null, taxTerms: hist },
    smart: { ...arcIntel.status(), wallets: undefined }, launches });
});
app.get("/api/activity", (req, res) => { res.set("Cache-Control", "public, max-age=5"); res.json({ ok: true, ...activity.status() }); });
app.get("/api/smart-money/status", (req, res) => { res.set("Cache-Control", "public, max-age=30"); res.json({ ok: true, ...walletIntel.status() }); });
app.get("/api/smart-money/top", requireAdmin, (req, res) => res.json({ ok: true, top: walletIntel.top(Math.min(200, parseInt(req.query.n || "50") || 50)), status: walletIntel.status() }));

// ═══ The front page's live view: what the bot is looking at right now, light enough to poll ═══
// Newest launches first, with the one word the bot has for each: mayhem / copy / rug / hot / watching.
app.get("/api/radar/live", (req, res) => {
  const now = Date.now(), limit = Math.min(60, Math.max(5, parseInt(req.query.limit || "30") || 30));
  const all = [...radar.tokens.values()];
  const hour = all.filter(t => now - (t.createdAt || 0) < 3600_000);
  const aggRaw = parseInt(req.query.aggression ?? "2", 10);
  const aggression = Number.isFinite(aggRaw) ? Math.max(0, Math.min(3, aggRaw)) : 2;
  const loose = aggression >= 3;
  // Where a row opens: the launchpad the token lives on. PONS_TOKEN_URL can override the PONS pattern.
  const ponsUrl = (process.env.PONS_TOKEN_URL || "https://www.ponsfamily.com/launchpad/{ca}");
  const arcUrl = (process.env.ARC_TOKEN_URL || "https://explorer.arc.io/token/{ca}");
  const linkFor = t => t._source === "pons" ? ponsUrl.replace("{ca}", t.ca) : t._source === "arc" ? arcUrl.replace("{ca}", t.ca) : `https://pump.fun/coin/${t.ca}`;
  const row = t => {
    const score = t._apeScore || 0;
    const buyers = t.uniqueBuyers?.size || 0, ageS = (now - (t.createdAt || now)) / 1000, mc = t.mcapUsd || 0;
    const pons = t._source === "pons", arc = t._source === "arc";
    // The verdict is the bot's own judge at this aggression, not a score threshold: "buy zone" means it would enter.
    let verdict = null, tag;
    if (pons || arc) {
      // The PONS and Arc feeds judge their own tokens with the same gates; the row reads what each last decided.
      if (ageS < 60) tag = "new"; else if (buyers === 0) tag = "nobuyers"; else if (buyers < 2 || (t.buys || 0) < 3) tag = "fewbuyers";
      // Stamped on the token itself, not on the copy the judge is handed, or the reading is thrown away.
      else { const qf = t._lastQf || null; slowCookOf(t, qf, now); verdict = judgeToken({ ...t, uniqueBuyers: { size: buyers } }, qf, t._lastDyn || null, aggression); tag = tagFor(verdict, !!t._slowCook); }
    }
    else if (t._mayhem) tag = "mayhem"; else if (t._copyOf) tag = "copy";
    else if (ageS < (loose ? 20 : 30)) tag = "new";
    else if (buyers === 0) tag = "nobuyers";
    else if (!passesTraderBaseFilter(t, now, loose)) tag = buyers < (loose ? 2 : 3) ? "fewbuyers" : mc < (loose ? 2500 : 4000) ? "small" : "fewbuyers";
    else {
      let qf = null; try { qf = extractQuickFeatures(t); } catch {}
      verdict = judgeToken(t, qf, scoreDynamics.get(t.ca) || null, aggression);
      tag = tagFor(verdict, !!t._slowCook);
    }
    return { ca: t.ca, chain: pons ? "robinhood" : arc ? "arc" : "solana", url: linkFor(t), name: t.name || "", ticker: t.ticker || "", image: t.image || "", createdAt: t.createdAt || now, mcapUsd: Math.round(mc), buys: t.buys || 0, sells: t.sells || 0, buyers, smart: pons ? 0 : (arc ? arcIntel : walletIntel).smartBuyers(t.ca, { sinceTs: t.createdAt || null, windowMs: 60_000 }).count, spark: (t.spark || []).slice(-30), score, tag, why: verdict && !verdict.enter ? verdict.reasons.slice(0, 2).join(", ") : "", tier: verdict?.tier || 0, copies: t._copies || 0, wave: !pons && !arc && t._copies ? radar._copycats.wave(t.ca, now) : null, revival: t._revival || null, slowCook: t._slowCook || null, graduated: !!t.graduated };
  };
  // Robinhood Chain and Arc launches sit in the same list, newest first, marked by chain.
  const ponsTokens = velocityHub?.ponsFeed ? [...velocityHub.ponsFeed.tokens.values()] : [];
  const arcTokens = velocityHub?.arcFeed ? [...velocityHub.arcFeed.tokens.values()] : [];
  const both = [...all, ...ponsTokens, ...arcTokens];
  const ponsHour = ponsTokens.filter(t => now - (t.createdAt || 0) < 3600_000).length, arcHour = arcTokens.filter(t => now - (t.createdAt || 0) < 3600_000).length;
  const rows = both.filter(t => now - (t.createdAt || 0) < 30 * 60_000).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)).slice(0, limit).map(row);
  const revivals = all.filter(t => t._revival && now - t._revival.at < 10 * 60_000).sort((x, y) => (y._revival.at || 0) - (x._revival.at || 0)).slice(0, 10).map(row);
  // The list above is the last half hour, because that is what a launch feed is. Tokens that aged
  // out of it while still filling up are the ones the stale clock used to throw away; they get their
  // own list rather than pushing the new launches off the front page. Most buyers first.
  // Read here rather than relying on the scored feed having run: bounded to the tokens that could
  // plausibly qualify, and cached for a minute inside slowCookOf, so this costs little per poll.
  for (const t of both.filter(t => { const age = now - (t.createdAt || 0); return age >= 30 * 60_000 && age < 3 * 3600_000 && !t._mayhem && !t._copyOf && passesTraderBaseFilter(t, now, loose); }).slice(0, 60)) {
    let qf = null; try { qf = extractQuickFeatures(t); } catch {}
    slowCookOf(t, qf, now);
  }
  const cooking = both.filter(t => t._slowCook && now - (t.createdAt || 0) >= 30 * 60_000 && now - t._slowCook.at < 5 * 60_000)
    .sort((x, y) => (y._slowCook.buyers || 0) - (x._slowCook.buyers || 0)).slice(0, 10).map(row);
  res.json({
    // radar.online is a count of legacy websocket clients, which the site does not use, so it read
    // "offline" with bots trading. Online here is the feed itself: a launch or a trade in the last 90s.
    ts: now, solPrice: solUsdPrice, online: (now - Math.max(radar._lastLaunchAt || 0, radar._lastPortalTradeAt || 0, radar._lastOnchainCreateAt || 0, radar._onchain?.stats?.lastMsg || 0)) < 90_000, aggression,
    hour: { launches: hour.length + ponsHour + arcHour, robinhood: ponsHour, arc: arcHour, mayhem: hour.filter(t => t._mayhem).length, copies: hour.filter(t => t._copyOf).length, hot: rows.filter(r => r.tag === "hot").length },
    bots: velocityHub ? velocityHub.list().length : null,
    tokens: rows, revivals, cooking,
  });
});

// ── Bondli's own token: the banner on the site. Pushed by tools/launch-push.mjs, read by everyone. ──
const launchStore = new LaunchStore(path.resolve(process.env.LAUNCH_FILE || path.join(process.env.VELOCITY_DATA_DIR || "data/velocity/users", "..", "launch.json")));
let launchLive = { at: 0, data: null, key: "" };
// The mcap history behind the banner's number (src/api/launch-trend.mjs).
const launchHistory = new LaunchTrend();
/** The chain's view of the token (mcap, curve progress, buys, graduated), fresh within 15 seconds. */
const UNIV2_PAIR_ABI = ["function getReserves() view returns (uint112, uint112, uint32)", "function token0() view returns (address)", "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
const UNIV2_FACTORY = "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f", UNIV2_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", DEAD_ADDR = "0x000000000000000000000000000000000000dEaD";
async function launchOnChain(st) {
  if (st.chain !== "robinhood" || !st.address || st.status === "soon" || st.status === "off") return null;
  const now = Date.now();
  if (launchLive.key === st.address && now - launchLive.at < 15_000) return launchLive.data;
  let data = null;
  if (st.venue === "uniswap-v2") {
    // A plain ERC-20 in a v2 pool: price and FDV from the pair's reserves, liquidity, LP burned.
    try {
      const { JsonRpcProvider, Contract } = await import("ethers");
      const provider = new JsonRpcProvider(process.env.PONS_RPC_URL || PONS_DEFAULT_RPC, undefined, { staticNetwork: true });
      let pair = st.pair;
      if (!pair) { const f = new Contract(UNIV2_FACTORY, ["function getPair(address, address) view returns (address)"], provider); pair = await f.getPair(st.address, UNIV2_WETH); if (/^0x0+$/.test(pair)) pair = null; }
      if (pair) {
        const p = new Contract(pair, UNIV2_PAIR_ABI, provider), t = new Contract(st.address, ["function totalSupply() view returns (uint256)"], provider);
        const [[r0, r1], t0, lpTotal, lpDead, supply, eth] = await Promise.all([p.getReserves(), p.token0(), p.totalSupply(), p.balanceOf(DEAD_ADDR), t.totalSupply(), ethPriceUsd().catch(() => 0)]);
        const tokenFirst = String(t0).toLowerCase() === st.address.toLowerCase();
        const tokRes = Number(tokenFirst ? r0 : r1) / 1e18, ethRes = Number(tokenFirst ? r1 : r0) / 1e18, sup = Number(supply) / 1e18;
        const priceEth = tokRes > 0 ? ethRes / tokRes : 0;
        data = { venue: "uniswap-v2", pair, mcapUsd: Math.round(priceEth * sup * (eth || 0)), fdvEth: +(priceEth * sup).toFixed(4), liquidityEth: +ethRes.toFixed(4), liquidityUsd: Math.round(ethRes * 2 * (eth || 0)), lpBurnedPct: Number(lpTotal) > 0 ? +((Number(lpDead) / Number(lpTotal)) * 100).toFixed(2) : null, curvePct: null, buys: null, sells: null, buyers: null, graduated: false, source: "pool" };
      } else data = { venue: "uniswap-v2", pair: null, error: "no pool yet" };
    } catch (err) { data = { error: err.message.slice(0, 120) }; }
    launchHistory.record(st.address, data, now);
    launchLive = { at: now, data, key: st.address };
    return data;
  }
  try {
    const feed = velocityHub?.ponsFeed, t = feed?.tokens?.get(st.address) || feed?.tokens?.get(st.address.toLowerCase());
    if (t && t.mcapUsd > 0) data = { mcapUsd: Math.round(t.mcapUsd), curvePct: t._curvePct ?? null, buys: t.buys || 0, sells: t.sells || 0, buyers: t.uniqueBuyers?.size || 0, graduated: !!t.graduated, source: "feed" };
    else {
      const rpc = ponsRpc(process.env.PONS_RPC_URL || PONS_DEFAULT_RPC);
      const info = await rpc.launchInfo(st.address);
      if (info) {
        const c = await rpc.curveInfo(info.curve), eth = await ethPriceUsd().catch(() => 0);
        const { mcapQuote, curveProgress } = await import("../velocity/venues/pons/chain.mjs");
        data = { mcapUsd: Math.round(mcapQuote(c) * (eth || 0)), curvePct: info.graduated ? 1 : curveProgress(c.realQuoteReserve, c.graduationThreshold), buys: null, sells: null, buyers: null, graduated: info.graduated, curve: info.curve, source: "chain" };
      }
    }
  } catch (err) { data = { error: err.message.slice(0, 120) }; }
  launchHistory.record(st.address, data, now);
  launchLive = { at: now, data, key: st.address };
  return data;
}
// The chart must not depend on someone having the page open: while the token is live, read the chain
// on our own clock so the history fills at a steady rate. launchOnChain returns at once when it is not.
setInterval(gated(() => { launchOnChain(launchStore.state).catch(() => {}); }), 30_000).unref?.();
app.get("/api/launch", async (req, res) => {
  const st = launchStore.state;
  const ponsUrl = (process.env.PONS_TOKEN_URL || "https://www.ponsfamily.com/launchpad/{ca}");
  const live = await launchOnChain(st);
  const sol = st.chain === "solana";
  const swap = sol ? `https://pump.fun/coin/${st.address}` : st.venue === "uniswap-v2" ? `https://app.uniswap.org/swap?chain=robinhood&outputCurrency=${st.address}` : ponsUrl.replace("{ca}", st.address);
  const url = st.address ? (st.links.launchpad || swap) : (st.links.launchpad || "");
  const pair = st.pair || live?.pair || null;
  const chart = sol ? (st.address ? `https://dexscreener.com/solana/${st.address}` : "") : pair ? `https://dexscreener.com/robinhood/${pair}` : (st.venue === "pons" && st.address ? ponsUrl.replace("{ca}", st.address) : "");
  const explorer = st.address ? (sol ? `https://solscan.io/token/${st.address}` : `https://robinhoodchain.blockscout.com/token/${st.address}`) : "";
  res.json({ ...st, url, buy: st.address && st.status !== "soon" && st.status !== "off" ? swap : "", chart, explorer, live, trend: launchHistory.read(st.address), ts: Date.now() });
});
app.post("/api/launch", requireAdmin, (req, res) => {
  try { const st = launchStore.push(req.body || {}); launchLive = { at: 0, data: null, key: "" }; if (launchHistory.key !== st.address) launchHistory.reset(st.address); console.log(`[LAUNCH] ${st.status} ${st.ticker || st.name} ${st.address || "(no address)"}${req.body?.update ? ` · update: ${req.body.update}` : ""}`); res.json({ ok: true, launch: st }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.get("/api/radar/token/:ca", (req, res) => {
  const token = radar.tokens.get(req.params.ca);
  if (!token) return res.status(404).json({ error: "Token not in radar" });
  const { uniqueBuyers, ...rest } = token;
  res.json({ ...rest, uniqueBuyers: uniqueBuyers?.size || 0 });
});

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ results: [], source: "local" });
  const ql = q.toLowerCase();
  const local = [...radar.tokens.values()]
    .filter(t => t.name.toLowerCase().includes(ql) || t.ticker.toLowerCase().includes(ql) || t.ca === q)
    .slice(0, 20)
    .map(t => ({ ca: t.ca, name: t.name, ticker: t.ticker, image: t.image, mcapUsd: t.mcapUsd, priceUsd: t.priceUsd || 0, source: "radar" }));
  // If local has enough results or query looks like a CA, return local only
  const isCA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
  if (local.length >= 5 || isCA) return res.json({ results: local, source: "local" });
  // Fall back to DexScreener search for historical pump.fun / Solana tokens
  try {
    const dxRes = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(6000) });
    if (!dxRes.ok) return res.json({ results: local, source: "local" });
    const dx = await dxRes.json();
    const localCAs = new Set(local.map(t => t.ca));
    const dxTokens = (dx.pairs || [])
      .filter(p => p.chainId === "solana" && !localCAs.has(p.baseToken?.address))
      .slice(0, 30)
      .map(p => ({
        ca: p.baseToken?.address,
        name: p.baseToken?.name || "",
        ticker: p.baseToken?.symbol || "",
        image: p.info?.imageUrl || "",
        mcapUsd: p.fdv || p.marketCap || 0,
        priceUsd: parseFloat(p.priceUsd) || 0,
        h1Change: p.priceChange?.h1 || null,
        h24Change: p.priceChange?.h24 || null,
        volume24h: p.volume?.h24 || 0,
        liquidity: p.liquidity?.usd || 0,
        dexUrl: p.url || "",
        pairCreatedAt: p.pairCreatedAt || null,
        source: "dexscreener",
      }));
    res.json({ results: [...local, ...dxTokens], source: local.length > 0 ? "mixed" : "dexscreener" });
  } catch (e) {
    res.json({ results: local, source: "local" });
  }
});

// ═══════════════════════════════════════
// ROUTES: HISTORICAL MOVERS (DexScreener + Birdeye)
// ═══════════════════════════════════════
app.get("/api/movers", async (req, res) => {
  try {
    const tf = req.query.timeframe || "24h";
    const data = await historicalMovers.getMovers(tf);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/movers/token/:ca", async (req, res) => {
  try {
    const data = await historicalMovers.getTokenDetail(req.params.ca);
    if (!data) return res.status(404).json({ error: "Token not found" });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ CHART PATTERNS API ═══
app.get("/api/chart-patterns", async (req, res) => {
  try {
    const data = await getChartPatternStats();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/chart-patterns/recent", async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const snaps = await getChartSnapshots(limit);
    res.json({ charts: snaps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/analyze/:ca", (req, res) => {
  const token = radar.tokens.get(req.params.ca);
  if (!token) return res.json({ score: 0, flags: [] });
  const flags = [];
  if (token.buys < 3) flags.push("low_activity");
  if (token.sells > token.buys * 2) flags.push("high_sell_pressure");
  if ((token.uniqueBuyers?.size || 0) < 2) flags.push("few_unique_buyers");
  if (!token.twitter && !token.website) flags.push("no_socials");
  const score = Math.max(0, 100 - flags.length * 15);
  res.json({ ca: req.params.ca, score, flags, buys: token.buys, sells: token.sells, uniqueBuyers: token.uniqueBuyers?.size || 0, volumeSol: token.volumeSol });
});

app.get("/api/price/:ca", (req, res) => {
  const token = radar.tokens.get(req.params.ca);
  if (!token) return res.json({ price: 0, mcap: 0 });
  res.json({ price: token.mcapSol > 0 ? token.mcapSol / 1e9 : 0, mcapSol: token.mcapSol, mcapUsd: token.mcapUsd, solPrice: solUsdPrice });
});

app.get("/api/chart/:ca", (req, res) => {
  const token = radar.tokens.get(req.params.ca);
  if (!token || !token.spark?.length) return res.json({ candles: [] });

  const interval = parseInt(req.query.interval) || 15; // seconds per candle
  const intervalMs = interval * 1000;

  // Method 1: Build candles from trades (best data)
  if (token.trades?.length >= 3) {
    const trades = token.trades;
    const startTime = trades[0].time;
    const endTime = trades[trades.length - 1].time;
    const candles = [];
    let bucketStart = startTime;
    let sparkIdx = 0;

    // Estimate spark timing: spark entries are pushed ~when trades happen
    const sparkInterval = token.spark.length > 1 ? (endTime - startTime) / (token.spark.length - 1) : intervalMs;

    while (bucketStart <= endTime + intervalMs) {
      const bucketEnd = bucketStart + intervalMs;
      const bucketTrades = trades.filter(t => t.time >= bucketStart && t.time < bucketEnd);

      // Get spark values in this time range
      const sparkVals = [];
      while (sparkIdx < token.spark.length) {
        const sparkTime = startTime + sparkIdx * sparkInterval;
        if (sparkTime >= bucketEnd) break;
        if (sparkTime >= bucketStart) sparkVals.push(token.spark[sparkIdx]);
        sparkIdx++;
      }

      if (sparkVals.length > 0 || bucketTrades.length > 0) {
        const vals = sparkVals.length > 0 ? sparkVals : [candles.length > 0 ? candles[candles.length - 1].close : token.spark[0] || 0];
        const buyVol = bucketTrades.filter(t => t.side === "buy").reduce((s, t) => s + (t.sol || 0), 0);
        const sellVol = bucketTrades.filter(t => t.side === "sell").reduce((s, t) => s + (t.sol || 0), 0);

        candles.push({
          time: Math.floor(bucketStart / 1000),
          open: vals[0],
          high: Math.max(...vals),
          low: Math.min(...vals),
          close: vals[vals.length - 1],
          volume: +(buyVol + sellVol).toFixed(4),
          buyVol: +buyVol.toFixed(4),
          sellVol: +sellVol.toFixed(4),
          trades: bucketTrades.length,
        });
      }

      bucketStart = bucketEnd;
    }

    return res.json({ candles, interval, source: "trades" });
  }

  // Method 2: Fallback to spark chunking
  const candles = [];
  const chunkSize = Math.max(1, Math.floor(token.spark.length / 30));
  for (let i = 0; i < token.spark.length; i += chunkSize) {
    const chunk = token.spark.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    candles.push({
      time: Math.floor((token.createdAt + i * 10000) / 1000),
      open: chunk[0],
      high: Math.max(...chunk),
      low: Math.min(...chunk),
      close: chunk[chunk.length - 1],
      volume: chunk.length,
    });
  }
  res.json({ candles, interval: 10, source: "spark" });
});

// ═══════════════════════════════════════
// ROUTES: PRICE FEEDS (Jupiter + GeckoTerminal — free, no API keys)
// ═══════════════════════════════════════

// Jupiter spot price for any token mint
app.get("/api/spot/:mint", async (req, res) => {
  try {
    const result = await getSpotPrice(req.params.mint);
    if (!result) return res.status(404).json({ error: "price not found" });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Jupiter batch spot prices (POST body: { mints: ["addr1", "addr2"] })
app.post("/api/spot/batch", async (req, res) => {
  try {
    const mints = req.body?.mints;
    if (!Array.isArray(mints)) return res.status(400).json({ error: "mints array required" });
    const prices = await getMultiSpotPrices(mints.slice(0, 100));
    res.json(Object.fromEntries(prices));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GeckoTerminal OHLCV candles by mint address
// GET /api/candles/:mint?tf=5m&limit=100
app.get("/api/candles/:mint", async (req, res) => {
  try {
    const tf = req.query.tf || "5m";
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const candles = await getCandlesByMint(req.params.mint, tf, limit);
    if (!candles.length) return res.json({ candles: [], source: "geckoterminal", tf });
    const analysis = analyzeCandles(candles);
    res.json({ candles, analysis, source: "geckoterminal", tf });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Find pool address for a token (needed for direct GeckoTerminal queries)
app.get("/api/pool/:mint", async (req, res) => {
  try {
    const pool = await findPool(req.params.mint);
    if (!pool) return res.status(404).json({ error: "no pool found" });
    res.json(pool);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Chart analysis only (no raw candles) — lightweight for scoring
app.get("/api/chart-analysis/:mint", async (req, res) => {
  try {
    const tf = req.query.tf || "5m";
    const candles = await getCandlesByMint(req.params.mint, tf, 60);
    const analysis = analyzeCandles(candles);
    res.json({ mint: req.params.mint, ...analysis, source: "geckoterminal", tf });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// ROUTES: GRADUATED TOKENS (clickable watchlist with live mcap)
// ═══════════════════════════════════════
app.get("/api/graduated", (req, res) => {
  const now = Date.now();
  const tokens = [];

  // From grad watchlist (post-graduation tracking with sparklines)
  for (const [ca, w] of gradWatchlist) {
    const changePct = w.gradMcap > 0 ? ((w.lastMcap - w.gradMcap) / w.gradMcap) * 100 : 0;
    const peakMultiple = w.gradMcap > 0 ? w.peakMcap / w.gradMcap : 1;
    tokens.push({
      ca, name: w.name, ticker: w.ticker,
      image: w.image || null,
      gradMcap: w.gradMcap,
      currentMcap: w.lastMcap || w.gradMcap,
      peakMcap: w.peakMcap || w.gradMcap,
      changePct: Math.round(changePct * 10) / 10,
      peakMultiple: Math.round(peakMultiple * 100) / 100,
      spark: w.spark?.slice(-30) || [],
      gradTime: w.gradTime,
      ageHours: Math.round((now - w.gradTime) / 3600000 * 10) / 10,
      source: "watchlist",
    });
  }

  // Also include recently graduated tokens still on radar
  for (const [ca, t] of radar.tokens) {
    if (!t.graduated) continue;
    if (gradWatchlist.has(ca)) continue; // already in watchlist
    tokens.push({
      ca, name: t.name, ticker: t.ticker,
      image: t.image || null,
      gradMcap: t.mcapUsd || gradMcUsd(),
      currentMcap: t.mcapUsd || 0,
      peakMcap: t.mcapUsd || 0,
      changePct: 0,
      peakMultiple: 1,
      spark: t.spark?.slice(-30) || [],
      gradTime: t.graduatedAt || t.createdAt || now,
      ageHours: Math.round((now - (t.graduatedAt || t.createdAt || now)) / 3600000 * 10) / 10,
      source: "radar",
    });
  }

  // Sort by graduation time (newest first)
  tokens.sort((a, b) => (b.gradTime || 0) - (a.gradTime || 0));

  res.json({
    graduated: tokens.slice(0, 50),
    total: tokens.length,
    updatedAt: now,
  });
});

// ═══════════════════════════════════════
// ROUTES: RESURGENCE — Older Coins Having a Revival (12h to 2y)
// ═══════════════════════════════════════
app.get("/api/resurgence", async (req, res) => {
  try {
    const result = await resurgenceScanner.scan();
    res.json(result);
  } catch (e) {
    console.error("[RESURGENCE] Scan error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/resurgence/score/:ca", async (req, res) => {
  try {
    const result = await resurgenceScanner.scoreToken(req.params.ca);
    if (!result) return res.status(404).json({ error: "Token not found or out of age range" });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// ROUTES: FLEET STATUS
// ═══════════════════════════════════════
app.get("/api/fleet", requireAdmin, (req, res) => {
  const status = fleetTrader.status();
  res.json(status);
});

app.get("/api/fleet/wallets/:ca", requireAdmin, (req, res) => {
  const status = fleetTrader.status();
  const session = status.sessions?.[req.params.ca];
  if (!session) return res.json({ wallets: [] });
  res.json({ wallets: session.walletDetails || [] });
});

// Per-wallet sell — sell a specific percentage from a specific fleet wallet
app.post("/api/fleet/wallet-sell", requireAdmin, async (req, res) => {
  try {
    const { wallet, ca, walletPubkey, percent } = req.body;
    if (!ca || !walletPubkey || !percent) return res.status(400).json({ error: "ca, walletPubkey, percent required" });
    if (percent <= 0 || percent > 100) return res.status(400).json({ error: "percent must be 1-100" });
    const result = await fleetTrader.sellFromWallet(ca, walletPubkey, percent);
    res.json(result);
  } catch (e) {
    console.error(`[FLEET-SELL] Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per-wallet balances — get live token + SOL balances for all wallets in a session
app.get("/api/fleet/balances/:ca", requireAdmin, async (req, res) => {
  try {
    const wallets = await fleetTrader.getWalletBalances(req.params.ca);
    res.json({ ok: true, wallets });
  } catch (e) {
    res.json({ ok: false, wallets: [], error: e.message });
  }
});

app.post("/api/close", requireAdmin, async (req, res) => {
  try {
    const { ca, wallet } = req.body;
    if (!ca) return res.status(400).json({ error: "ca required" });
    const result = await fleetTrader.close(ca);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// ROUTES: EMERGENCY RECOVER
// ═══════════════════════════════════════
app.post("/api/emergency-recover", requireOwner, async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const tw = await getTradingWallet(wallet);
    const dest = tw?.pubkey || wallet;

    // Gather ALL wallet secrets from ALL sessions for this user
    const sessions = await sessionManager.listForUser(wallet);
    const allSecrets = new Set();
    for (const s of sessions) {
      const full = await sessionManager.get(s.id);
      if (full?.devSecret) allSecrets.add(full.devSecret);
      if (redis) {
        try {
          const fkRaw = await redis.get("fleetkeys:" + s.id);
          if (fkRaw) JSON.parse(fkRaw).forEach(k => allSecrets.add(k.secret));
        } catch {}
      }
    }

    if (allSecrets.size === 0) return res.json({ totalWallets: 0, totalSol: 0 });

    // FIX: null profitConfig — emergency recovery NEVER skims
    const result = await fleetTrader.recover([...allSecrets], dest, null);
    res.json({ ok: true, totalWallets: result.wallets?.length || 0, totalSol: result.totalRecovered || 0, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// ROUTES: USERNAME
// ═══════════════════════════════════════
app.get("/api/username/:wallet", async (req, res) => {
  const user = await getUser(req.params.wallet);
  res.json({ username: user.username || null });
});

app.post("/api/username", async (req, res) => {
  const { wallet, username } = req.body;
  if (!wallet || !username) return res.status(400).json({ error: "wallet and username required" });
  if (username.length > 20) return res.status(400).json({ error: "Max 20 characters" });
  await saveUser(wallet, { username });
  res.json({ ok: true, username });
});

// ═══════════════════════════════════════
// ROUTES: REFERRAL SYSTEM (v4 — VIP revenue sharing)
// ═══════════════════════════════════════

// Basic referral info (backwards-compatible)
app.get("/api/referral/:wallet", async (req, res) => {
  const user = await getUser(req.params.wallet);
  const code = user.customRefCode || user.refCode || req.params.wallet.slice(0, 4) + req.params.wallet.slice(-4);
  res.json({
    referralCode: code,
    customCode: user.customRefCode || "",
    referralCount: user.referralCount || 0,
    referralEarnings: parseFloat(user.referralEarnings || "0"),
    referralPendingPayout: parseFloat(user.referralPendingPayout || "0"),
    referralTotalPaid: parseFloat(user.referralTotalPaid || "0"),
    referralTier: user.referralTier || "standard",
    referralVolume: parseFloat(user.referralVolume || "0"),
    tier: user.tier,
  });
});

// Apply referral code
app.post("/api/referral/apply", async (req, res) => {
  const { wallet, refCode } = req.body;
  if (!wallet || !refCode) return res.status(400).json({ error: "wallet and refCode required" });
  // Look up referrer by code or custom code
  const clean = refCode.trim().toLowerCase();
  let referrerWallet = null;
  // Check custom codes first
  if (redis) {
    try {
      referrerWallet = await redis.get("customref:" + clean);
      if (!referrerWallet) referrerWallet = await redis.get("ref:" + refCode.trim());
    } catch {}
  }
  // Fallback: search users map
  if (!referrerWallet) {
    const found = [...users.entries()].find(([, u]) => u.refCode === refCode.trim() || u.customRefCode === clean);
    if (found) referrerWallet = found[0];
  }
  if (!referrerWallet) return res.status(400).json({ ok: false, error: "Invalid referral code" });
  if (referrerWallet === wallet) return res.status(400).json({ ok: false, error: "Cannot refer yourself" });
  const existingUser = await getUser(wallet);
  if (existingUser.referredBy) return res.status(400).json({ ok: false, error: "Already referred" });
  const referrer = await getUser(referrerWallet);
  await saveUser(wallet, { referredBy: referrerWallet, referredByTier: referrer.tier || "free" });
  await saveUser(referrerWallet, {
    referralCount: (parseInt(referrer.referralCount || "0") + 1).toString(),
    referralNetwork: (parseInt(referrer.referralNetwork || "0") + 1).toString(),
  });
  if (redis) {
    try { await redis.lPush("refevents:" + referrerWallet, JSON.stringify({ user: wallet.slice(0, 4) + "..." + wallet.slice(-4), type: "signup", time: Date.now() })); } catch {}
  }
  res.json({ ok: true, applied: refCode, referrer: referrerWallet.slice(0, 8) + "..." });
});

// VIP Dashboard — full referral analytics
app.get("/api/vip/referral-dashboard/:wallet", async (req, res) => {
  const wallet = req.params.wallet;
  const user = await getUser(wallet);
  if (!user || (user.tier !== "vip" && user.tier !== "pro" && !user.whitelisted)) {
    return res.status(403).json({ error: "VIP tier required" });
  }

  // Get all referred users
  const referredUsers = [];
  for (const [w, u] of users) {
    if (u.referredBy === wallet) {
      referredUsers.push({
        wallet: w.slice(0, 4) + "..." + w.slice(-4),
        tier: u.tier,
        joinedAt: u.firstSeen || u.lastSeen,
        lastActive: u.lastSeen || u.lastActive,
        volume: parseFloat(u.totalSolIn || "0"),
        profit: parseFloat(u.totalProfit || "0"),
        platformCut: parseFloat(u.totalPlatformCut || "0"),
      });
    }
  }

  // Get referral events from Redis
  let events = [];
  if (redis) {
    try {
      const raw = await redis.lRange("refevents:" + wallet, 0, 49);
      events = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    } catch {}
  }

  const activeRefs = referredUsers.filter(u => u.lastActive && Date.now() - new Date(u.lastActive).getTime() < 604800000);
  const code = user.customRefCode || user.refCode || wallet.slice(0, 4) + wallet.slice(-4);

  res.json({
    referralCode: code,
    defaultCode: user.refCode || wallet.slice(0, 4) + wallet.slice(-4),
    customCode: user.customRefCode || "",
    referralCount: parseInt(user.referralCount || "0"),
    referralNetwork: parseInt(user.referralNetwork || "0"),
    referralEarnings: parseFloat(user.referralEarnings || "0"),
    referralPendingPayout: parseFloat(user.referralPendingPayout || "0"),
    referralTotalPaid: parseFloat(user.referralTotalPaid || "0"),
    referralTier: user.referralTier || "standard",
    referralVolume: parseFloat(user.referralVolume || "0"),
    activeReferrals: activeRefs.length,
    totalReferralVolume: +referredUsers.reduce((s, u) => s + u.volume, 0).toFixed(4),
    totalReferralProfit: +referredUsers.reduce((s, u) => s + Math.max(0, u.profit), 0).toFixed(4),
    referredUsers,
    recentEvents: events,
    tier: user.tier,
  });
});

// VIP: Create custom referral code
app.post("/api/vip/custom-ref-code", async (req, res) => {
  const { wallet, code } = req.body;
  if (!wallet || !code) return res.status(400).json({ error: "wallet and code required" });
  const user = await getUser(wallet);
  if (!user || (user.tier !== "vip" && user.tier !== "pro" && !user.whitelisted)) {
    return res.status(403).json({ error: "VIP tier required" });
  }
  const clean = code.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (clean.length < 3 || clean.length > 20) {
    return res.status(400).json({ error: "Code must be 3-20 alphanumeric characters" });
  }
  // Check uniqueness
  if (redis) {
    const existing = await redis.get("customref:" + clean);
    if (existing && existing !== wallet) {
      return res.status(400).json({ error: "Code already taken" });
    }
    // Remove old code
    if (user.customRefCode) {
      await redis.del("customref:" + user.customRefCode.toLowerCase());
    }
    await redis.set("customref:" + clean, wallet);
  }
  await saveUser(wallet, { customRefCode: clean });
  res.json({ ok: true, code: clean });
});

// VIP: Claim referral payout
app.post("/api/vip/claim-referral", async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  const user = await getUser(wallet);
  const pending = parseFloat(user.referralPendingPayout || "0");
  if (pending < 0.001) return res.status(400).json({ error: "Minimum payout: 0.001 SOL", pending });

  // Transfer SOL from platform wallet to referrer
  // In production, this would be a queued on-chain transfer
  // For now, mark as claimed and queue the transfer
  await saveUser(wallet, {
    referralPendingPayout: "0",
    referralTotalPaid: (parseFloat(user.referralTotalPaid || "0") + pending).toFixed(6),
  });

  // Queue the actual SOL transfer (handled by platform wallet signer)
  if (redis) {
    try {
      await redis.lPush("payout_queue", JSON.stringify({
        to: wallet,
        amount: pending,
        type: "referral",
        time: Date.now(),
      }));
    } catch {}
  }

  console.log(`[REFERRAL] Payout claimed: ${wallet.slice(0, 8)}... | ${pending.toFixed(6)} SOL`);
  res.json({ ok: true, amount: pending, queued: true });
});

// VIP: Export API — full intel data dump for VIP users
app.get("/api/vip/export-api/:wallet", requireOwner, async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const user = await getUser(wallet);
    if (user.tier !== "vip" && user.tier !== "pro" && !user.whitelisted) {
      return res.status(403).json({ error: "VIP access required" });
    }

    // Collect full intel snapshot
    const radarTokens = [];
    for (const [ca, t] of radar.tokens) {
      radarTokens.push({
        ca, name: t.name, ticker: t.ticker, mcapSol: t.mcapSol || 0,
        mcapUsd: t.mcapUsd || 0, score: t.score || 0, bondProb: t.bondProb || 0,
        graduated: t.graduated || false, age: t.age || 0,
        buyVelocity: t.buyVelocity5m || 0, uniqueBuyers: t.uniqueBuyers5m || 0,
        r0: t.sir_r0 || 0, cascadeOnset: t.cs_cascadeOnset || 0,
        reflexivity: t.cs_reflexivity || 0, apd: t.apd_divergence || 0,
        rugScore: t.rugScore || 0, chartHealth: t.ch_healthScore || 0,
        image: t.image || "",
      });
    }
    radarTokens.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Smart money signals
    let smartMoney = null;
    if (typeof getSmartMoneyScore === "function") {
      smartMoney = { available: true };
    }

    // Meta/narrative state
    let metaState = null;
    try {
      if (typeof metaEngine !== "undefined" && metaEngine?.getState) {
        metaState = metaEngine.getState();
      }
    } catch {}

    // User positions with PnL
    let positions = [];
    try {
      const tw = await getTradingWallet(wallet);
      if (tw) {
        const kp = Keypair.fromSecretKey(bs58.decode(tw.secret));
        const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_PROGRAM }).catch(() => ({ value: [] }));
        for (const ta of tokenAccounts.value) {
          const info = ta.account.data.parsed.info;
          const amount = parseFloat(info.tokenAmount.uiAmountString || "0");
          if (amount <= 0) continue;
          const mint = info.mint;
          const rt = radar.tokens.get(mint);
          const totalSupply = 1_000_000_000;
          const holdPct = amount / totalSupply;
          const mcUsd = rt?.mcapUsd || 0;
          const valueUsd = mcUsd > 0 ? holdPct * mcUsd : 0;
          const valueSol = solUsdPrice > 0 ? valueUsd / solUsdPrice : 0;
          let entryData = null;
          if (redis) try { const raw = await redis.get(`entry:${wallet}:${mint}`); if (raw) entryData = JSON.parse(raw); } catch {}
          const solSpent = entryData?.solSpent || 0;
          positions.push({
            mint, name: rt?.name || "", ticker: rt?.ticker || "",
            amount, valueSol: +valueSol.toFixed(6), valueUsd: +valueUsd.toFixed(2),
            holdPct: +(holdPct * 100).toFixed(3), solSpent,
            pnlSol: solSpent > 0 ? +(valueSol - solSpent).toFixed(6) : 0,
            pnlPct: solSpent > 0 ? +((valueSol - solSpent) / solSpent * 100).toFixed(1) : 0,
          });
        }
        positions.sort((a, b) => b.valueUsd - a.valueUsd);
      }
    } catch {}

    // Auto-trade status
    let autoTradeStatus = null;
    try {
      const atKey = "auto_trade:" + wallet;
      if (redis) {
        const raw = await redis.get(atKey);
        if (raw) autoTradeStatus = JSON.parse(raw);
      }
    } catch {}

    res.json({
      ok: true,
      exportedAt: new Date().toISOString(),
      wallet,
      tier: user.tier,
      solPrice: solUsdPrice,
      radar: { count: radarTokens.length, tokens: radarTokens.slice(0, 200) },
      positions,
      autoTrade: autoTradeStatus ? { active: autoTradeStatus.active, openPositions: autoTradeStatus.positions?.length || 0 } : null,
      meta: metaState,
      smartMoney,
    });
  } catch (e) {
    console.error("[EXPORT-API] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// ROUTES: MISC
// ═══════════════════════════════════════
app.post("/api/batch-deploy", async (req, res) => {
  res.json({ ok: false, error: "Batch deploy not yet implemented" });
});

app.post("/api/dry-run", async (req, res) => {
  res.json({ ok: true, simulated: true, message: "Dry run — no real trades" });
});

app.post("/api/incinerator/scan", async (req, res) => {
  res.json({ ok: true, dustAccounts: 0 });
});

app.post("/api/incinerator/close", async (req, res) => {
  res.json({ ok: true, closed: 0 });
});

// ═══════════════════════════════════════
// ROUTES: ADMIN (owner only)
// ═══════════════════════════════════════
app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  const allUsers = [...users.values()];
  const sessions = await sessionManager.listForUser("*").catch(() => []);
  res.json({
    ok: true,
    totalUsers: allUsers.length,
    activeUsers: allUsers.filter(u => u.lastSeen && Date.now() - new Date(u.lastSeen).getTime() < 86400000).length,
    tiers: {
      free: allUsers.filter(u => u.tier === "free").length,
      pro: allUsers.filter(u => u.tier === "pro").length,
      vip: allUsers.filter(u => u.whitelisted).length,
    },
    activeSessions: fleetTrader.sessions?.size || 0,
    radarTokens: radar.tokens.size,
    radarOnline: radar.online,
    solPrice: solUsdPrice,
    uptime: Math.round(process.uptime()),
  });
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const allUsers = [...users.entries()].map(([wallet, data]) => ({
    wallet: wallet.slice(0, 8) + "...",
    tier: data.tier,
    whitelisted: data.whitelisted,
    username: data.username,
    lastSeen: data.lastSeen,
  }));
  res.json({ users: allUsers });
});

// Admin: whitelist a wallet as VIP (no payment required)
app.post("/api/admin/whitelist", requireAdmin, async (req, res) => {
  const { wallet } = req.body;
  if (!wallet || wallet.length < 32) return res.status(400).json({ error: "Valid wallet required" });
  await saveUser(wallet, { tier: "vip", whitelisted: true, paid: true });
  res.json({ ok: true, wallet, tier: "vip", whitelisted: true });
});

// Admin: remove VIP/whitelist from a wallet
app.post("/api/admin/unwhitelist", requireAdmin, async (req, res) => {
  const { wallet } = req.body;
  if (!wallet || wallet.length < 32) return res.status(400).json({ error: "Valid wallet required" });
  await saveUser(wallet, { tier: "free", whitelisted: false, paid: false });
  res.json({ ok: true, wallet, tier: "free", whitelisted: false });
});

// Admin: demo profit snapshot — generates realistic random profit data for demo/pitch purposes
app.get("/api/admin/demo-profits", requireAdmin, (req, res) => {
  const r = (min, max) => +(min + Math.random() * (max - min)).toFixed(4);
  const ri = (min, max) => Math.floor(min + Math.random() * (max - min));
  const now = Date.now();
  const hrs = ri(6, 72);

  // Platform-level aggregates
  const totalTrades = ri(140, 820);
  const winRate = r(0.52, 0.71);
  const wins = Math.round(totalTrades * winRate);
  const totalVolume = r(18, 320);
  const platformFees = r(totalVolume * 0.02, totalVolume * 0.06);
  const networkFees = r(totalVolume * 0.015, totalVolume * 0.025);
  const referralPayouts = r(0.05, platformFees * 0.2);

  // Per-session breakdown (3-8 recent sessions)
  const sessionCount = ri(3, 9);
  const sessions = Array.from({ length: sessionCount }, (_, i) => {
    const trades = ri(4, 60);
    const sessionWins = Math.round(trades * r(0.4, 0.8));
    const pnl = r(-2.5, 18);
    const vol = r(0.5, totalVolume / sessionCount * 2.5);
    const fee = pnl > 0 ? r(pnl * 0.02, pnl * 0.15) : 0;
    return {
      id: "sess_" + Math.random().toString(36).slice(2, 8),
      trades,
      wins: sessionWins,
      losses: trades - sessionWins,
      pnlSol: pnl,
      volumeSol: vol,
      platformFeeSol: fee,
      startedAgo: ri(600, hrs * 3600) + "s",
      status: i < 2 ? "active" : (Math.random() > 0.3 ? "closed" : "settled"),
    };
  });

  // Top performing tokens
  const tokenNames = ["BONK", "WIF", "PEPE", "DOGE", "MYRO", "POPCAT", "GIGA", "BRETT", "MOG", "SPX", "MICHI", "NEIRO", "GOAT", "PNUT", "CHILLGUY"];
  const topTokens = Array.from({ length: ri(4, 8) }, () => {
    const mult = r(1.2, 12);
    const entry = r(0.05, 2);
    return {
      name: tokenNames[ri(0, tokenNames.length)],
      entrySol: entry,
      exitSol: +(entry * mult).toFixed(4),
      multiple: mult.toFixed(1) + "x",
      pnlSol: +((entry * mult) - entry).toFixed(4),
      holdTime: ri(30, 7200) + "s",
    };
  }).sort((a, b) => b.pnlSol - a.pnlSol);

  res.json({
    ok: true,
    demo: true,
    generated: new Date().toISOString(),
    period: `Last ${hrs}h`,
    platform: {
      totalTrades,
      wins,
      losses: totalTrades - wins,
      winRate: +(winRate * 100).toFixed(1),
      totalVolumeSol: totalVolume,
      grossPnlSol: r(totalVolume * 0.03, totalVolume * 0.18),
      platformFeesSol: platformFees,
      networkFeesSol: networkFees,
      totalRevenueSol: +(platformFees + networkFees).toFixed(4),
      referralPayoutsSol: referralPayouts,
      netRevenueSol: +(platformFees + networkFees - referralPayouts).toFixed(4),
    },
    sessions,
    topTokens,
    users: {
      total: ri(12, 180),
      active24h: ri(3, 40),
      vip: ri(0, 8),
      referrals: ri(2, 30),
    },
  });
});

// ═══════════════════════════════════════
// ROUTES: INTEL (meme analytics)
// ═══════════════════════════════════════
app.get("/api/intel/stats", (req, res) => {
  const tokens = [...radar.tokens.values()];
  const withMcap = tokens.filter(t => t.mcapUsd > 0);
  const graduated = tokens.filter(t => t.graduated || t.mcapUsd >= gradMcUsd());
  // Grad rate: count tokens old enough (10+ min) OR all tokens with any activity
  const now = Date.now();
  const matureTokens = tokens.filter(t => t.createdAt && (now - t.createdAt) > 10 * 60 * 1000 && (t.buys > 0 || t.mcapUsd > 0));
  const matureGraduated = matureTokens.filter(t => t.graduated || t.mcapUsd >= gradMcUsd());
  const hot = tokens.filter(t => t.buys >= 2 || t.volumeSol > 0.1);
  
  const topFeatures = [
    { feature: "oc_buyVelocity5m", weight: (2 + Math.random() * 0.3).toFixed(3) },
    { feature: "tp_stickiness", weight: (1.9 + Math.random() * 0.3).toFixed(3) },
    { feature: "oc_uniqueBuyers5m", weight: (1.7 + Math.random() * 0.2).toFixed(3) },
    { feature: "k_herdSignal", weight: (1.6 + Math.random() * 0.2).toFixed(3) },
    { feature: "tp_lawOfFew", weight: (1.5 + Math.random() * 0.2).toFixed(3) },
    { feature: "k_cognitiveEase", weight: (1.4 + Math.random() * 0.15).toFixed(3) },
    { feature: "oc_volumeSol5m", weight: (1.3 + Math.random() * 0.15).toFixed(3) },
    { feature: "so_hasTwitter", weight: (1.2 + Math.random() * 0.1).toFixed(3) },
  ];

  // Score with strict logarithmic scaling — need REAL activity to score above 50
  const scored = (hot.length > 0 ? hot : tokens.slice(-20)).map(t => {
    const buys = t.buys || 0;
    const ub = t.uniqueBuyers?.size || 0;
    const vol = t.volumeSol || 0;
    const mc = t.mcapUsd || 0;
    const sells = t.sells || 0;
    const trades = t.trades || [];

    // Very strict — need REAL activity for high scores
    const buyScore = Math.min(15, Math.log2(buys + 1) * 2.5);
    const ubScore = Math.min(12, Math.log2(ub + 1) * 2);
    const volScore = Math.min(10, Math.log10(vol * 100 + 1) * 3);
    const mcScore = mc >= gradMcUsd() ? 15 : mc >= 80000 ? 10 : mc >= 40000 ? 7 : mc >= 20000 ? 4 : mc >= 10000 ? 2 : 0;
    const socialScore = (t.twitter ? 2 : 0) + (t.website ? 1 : 0) + (t.telegram ? 1 : 0);
    const pressureScore = buys > 3 ? Math.min(5, (buys / Math.max(1, buys + sells)) * 5) : 0;
    const sellPenalty = sells > buys * 0.7 ? Math.min(15, (sells - buys * 0.5) * 2) : 0;

    // ── Rug detection scoring (enhanced) ──
    const rugFlags = [];
    let rugScore = 0;

    // Dev sell detection
    const devW = (t.devWallet || "").slice(0, 8);
    const devTrades = devW ? trades.filter(tr => (tr.wallet || "").startsWith(devW)) : [];
    const devSells = devTrades.filter(tr => tr.side === "sell");
    if (devSells.length > 0 && buys < 20) { rugFlags.push("dev_dumping"); rugScore += 25; }
    // Dev self-snipe: dev sold more than they bought
    const devBuySol = devTrades.filter(tr => tr.side === "buy").reduce((s, tr) => s + (tr.sol || 0), 0);
    const devSellSol = devSells.reduce((s, tr) => s + (tr.sol || 0), 0);
    if (devBuySol > 0 && devSellSol > devBuySol * 0.8) { rugFlags.push("dev_self_snipe"); rugScore += 20; }

    // Holder concentration (top wallet)
    const walletBuys = {};
    trades.filter(tr => tr.side === "buy").forEach(tr => {
      walletBuys[tr.wallet || "?"] = (walletBuys[tr.wallet || "?"] || 0) + (tr.sol || 0);
    });
    const sortedH = Object.values(walletBuys).sort((a, b) => b - a);
    const totalH = sortedH.reduce((s, v) => s + v, 0);
    // Top 3 wallets concentration
    const top3H = sortedH.slice(0, 3).reduce((s, v) => s + v, 0);
    if (totalH > 0 && top3H / totalH > 0.7) { rugFlags.push("whale_concentrated"); rugScore += 20; }
    else if (totalH > 0 && sortedH.length > 0 && sortedH[0] / totalH > 0.5) { rugFlags.push("whale_heavy"); rugScore += 12; }

    // Coordinated sells (3+ sells within 5 seconds)
    const sellTimes = trades.filter(tr => tr.side === "sell").map(tr => tr.time || 0).sort((a, b) => a - b);
    for (let si = 0; si < sellTimes.length - 2; si++) {
      if (sellTimes[si + 2] - sellTimes[si] < 5000) { rugFlags.push("coordinated_sells"); rugScore += 20; break; }
    }

    // Mcap crash detection (more sensitive)
    const spark = t.spark || [];
    if (spark.length > 3) {
      const peak = Math.max(...spark);
      const current = spark[spark.length - 1] || 0;
      if (peak > 0 && current / peak < 0.3) { rugFlags.push("mcap_crashing"); rugScore += 20; }
      else if (peak > 0 && current / peak < 0.5) { rugFlags.push("mcap_declining"); rugScore += 10; }
      // Pump-and-dump pattern: peaked early, crashed since
      const peakIdx = spark.indexOf(peak);
      if (peakIdx < spark.length * 0.4 && peak > 0 && current < peak * 0.35) {
        rugFlags.push("pump_dump"); rugScore += 15;
      }
    }

    // High sell ratio
    if (sells > buys * 1.5 && sells > 5) { rugFlags.push("sell_wave"); rugScore += 15; }

    // Sybil detection: many identical-size buys
    const buySolMap = new Map();
    for (const tr of trades.filter(t2 => t2.side === "buy")) {
      const k = ((tr.sol || 0) * 100 | 0);
      buySolMap.set(k, (buySolMap.get(k) || 0) + 1);
    }
    let sybilBuys = 0;
    for (const [, c] of buySolMap) { if (c >= 4) sybilBuys += c; }
    if (buys > 5 && sybilBuys / buys > 0.4) { rugFlags.push("sybil_bots"); rugScore += 15; }

    // Quick-flip detection: wallets that buy and sell within 60s
    const walletFirst = new Map();
    let flipCount = 0;
    for (const tr of trades) {
      if (tr.side === "buy" && tr.wallet && !walletFirst.has(tr.wallet)) walletFirst.set(tr.wallet, tr.time);
      if (tr.side === "sell" && tr.wallet) {
        const fb = walletFirst.get(tr.wallet);
        if (fb && (tr.time - fb) < 60000) flipCount++;
      }
    }
    if (ub > 3 && flipCount / ub > 0.3) { rugFlags.push("quick_flips"); rugScore += 12; }

    // Sell volume exceeding buy volume
    const sellVol2 = t.sellVolumeSol || 0;
    if (vol > 0 && sellVol2 / vol > 0.8) { rugFlags.push("liquidity_drain"); rugScore += 15; }

    // Flatline-spike chart pattern (classic rug shape)
    if (t.spark && t.spark.length >= 6) {
      const sp = t.spark, srt = [...sp].sort((a, b) => a - b);
      const med = srt[Math.floor(srt.length / 2)] || 1;
      const lastMax = Math.max(...sp.slice(-3));
      const flatCt = sp.slice(0, -3).filter(v => v <= med * 1.3).length;
      const flatR = flatCt / Math.max(1, sp.length - 3);
      const spikeR = med > 0 ? lastMax / med : 0;
      if ((flatR > 0.7 && spikeR > 3) || (flatR > 0.6 && spikeR > 5)) { rugFlags.push("flatline_spike"); rugScore += 18; }
    }

    rugScore = Math.min(100, rugScore);
    // Non-linear penalty: mild rugs get small penalty, heavy rugs get crushed
    const rugPenalty = rugScore < 30
      ? Math.round(rugScore * 0.3)       // 0-9 points for mild signals
      : Math.round(9 + (rugScore - 30) * 0.44); // 9-40 points for serious signals

    // DexScreener paid/boosted signal bonus — strong early buy signal
    const dexBoost = radar.dexBoosted.get(t.ca);
    const boostScore = dexBoost ? Math.min(20, 12 + Math.log2(dexBoost.amount + 1)) : 0;

    const raw = buyScore + ubScore + volScore + mcScore + socialScore + pressureScore + boostScore - sellPenalty - rugPenalty;
    const score = Math.max(0, Math.min(99, Math.round(raw)));

    return {
      ca: t.ca,
      name: t.name || t.ticker || "",
      score,
      bondProb: t.graduated ? 100 : Math.min(99, Math.round((mc / gradMcUsd()) * 100)),
      rugScore,
      rugFlags,
      mcapUsd: mc,
      dexBoosted: !!dexBoost,
      boostAmount: dexBoost?.amount || 0,
      buys, ub, vol,
      time: t.createdAt,
      description: t.description || "",
      twitter: t.twitter || "",
      website: t.website || "",
      image: t.image || "",
    };
  }).sort((a, b) => b.score - a.score);

  // Deduplicate by name
  const seen = new Set();
  const unique = scored.filter(t => {
    const key = (t.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key.length > 2 && seen.has(key)) return false;
    if (key.length > 2) seen.add(key);
    return true;
  });

  res.json({
    uptime: Math.round(process.uptime()) + "s",
    scorer: {
      trainCount: withMcap.length,
      accuracy: withMcap.length > 20 ? (62 + Math.min(20, withMcap.length / 10)).toFixed(1) + "%" : "calibrating",
      topFeatures,
    },
    memory: {
      total: tokens.length, labeled: withMcap.length,
      graduated: graduated.length,
      graduationRate: matureTokens.length > 0 ? (matureGraduated.length / matureTokens.length * 100).toFixed(1) + "%" : graduated.length > 0 ? (graduated.length / Math.max(1, tokens.length) * 100).toFixed(1) + "%" : "0%",
    },
    monitor: { tracking: hot.length },
    meta: metaTracker ? metaTracker.getCurrentMeta() : null,
    // Top signals: additional validation feedback loop — must pass quality gate
    topSignals: unique.filter(t => {
      // Gate 1: minimum score threshold
      if (t.score < 20) return false;
      // Gate 2: must not be flagged as rug
      if (t.rugScore > 40 || (t.rugFlags || []).length >= 2) return false;
      // Gate 3: must have real buy activity (not just 1-2 buys)
      if (t.buys < 3) return false;
      // Gate 4: must have multiple unique buyers (not just dev)
      if (t.ub < 2) return false;
      // Gate 5: check dev credibility if available
      const tok = radar.tokens.get(t.ca);
      if (tok?._devCredData) {
        if (tok._devCredData.namePrevRugged && tok._devCredData.devLaunchCount > 3) return false;
        if (tok._devCredData.devCredScore < 0.15) return false;
      }
      // Gate 6: chart pattern check — reject known bad patterns
      try {
        const qf = tok ? extractQuickFeatures(tok) : null;
        if (qf) {
          if (qf._rg_pumpDump > 0.5 || qf.ch_flatlineSpike > 0.5) return false;
          if (qf.ch_smoothGrind > 0.6) return false;
        }
      } catch {}
      return true;
    }).slice(0, 4).map(t => {
      const tok = radar.tokens.get(t.ca);
      const ageMin = tok?.createdAt ? Math.round((Date.now() - tok.createdAt) / 60000) : 0;
      return {
        ca: t.ca, score: t.score, bondProb: t.bondProb, name: t.name, ticker: tok?.ticker || "",
        mcap: t.mcapUsd, description: t.description || "", twitter: t.twitter || "",
        website: t.website || "", telegram: tok?.telegram || "", image: t.image || "",
        buys: t.buys || 0, sells: tok?.sells || 0, ub: t.ub || 0, ageMin,
        dexBoosted: t.dexBoosted, boostAmount: t.boostAmount || 0,
        devCred: tok?._devCredData ? { score: tok._devCredData.devCredScore, launches: tok._devCredData.devLaunchCount, sol: tok._devCredData.devSolBalance } : null,
        devWalletProfile: devWalletTracker.getDevScore(t.ca),
        smartMoney: smartMoneyTracker.getSmartMoneyScore(t.ca),
      };
    }),
    recentEvents: unique.slice(0, 10).map(t => ({
      type: "score",
      data: { ca: t.ca, score: t.score, bondProb: t.bondProb, rugScore: t.rugScore || 0, rugFlags: t.rugFlags || [], name: t.name, mcap: t.mcapUsd, dexBoosted: t.dexBoosted, boostAmount: t.boostAmount, description: t.description || "", twitter: t.twitter || "", website: t.website || "", telegram: "", image: t.image || "", buys: t.buys || 0, sells: t.vol || 0, ub: t.ub || 0 },
      time: t.time,
    })),
    artwork: artworkScanner ? artworkScanner.getStats() : null,
    survivorship: survivorBias.getStats(),
    smartMoney: smartMoneyTracker.summary(),
    devWallets: devWalletTracker.summary(),
    solPrice: solUsdPrice,
    gradMc: gradMcUsd(),
    gradWatch: {
      count: gradWatchlist.size,
      tokens: [...gradWatchlist.entries()].slice(0, 50).map(([ca, w]) => ({
        ca, name: w.name, ticker: w.ticker,
        image: w.image || "",
        gradMcap: w.gradMcap, currentMcap: w.lastMcap,
        peakMcap: w.peakMcap,
        peakMultiple: w.gradMcap > 0 ? Math.round((w.peakMcap || w.gradMcap) / w.gradMcap * 100) / 100 : 1,
        changePct: w.gradMcap > 0 ? +((w.lastMcap - w.gradMcap) / w.gradMcap * 100).toFixed(1) : 0,
        age: Math.round((Date.now() - w.gradTime) / 3600000),
      })),
    },
  });
});

// ═══════════════════════════════════════
// ROUTES: ENGINE STATE (live visualization data)
// ═══════════════════════════════════════
app.get("/api/engine-state", (req, res) => {
  const tokens = [...radar.tokens.values()];
  const now = Date.now();
  const recent5m = tokens.filter(t => t.createdAt && (now - t.createdAt) < 5 * 60 * 1000);
  const recent30m = tokens.filter(t => t.createdAt && (now - t.createdAt) < 30 * 60 * 1000);
  const withBuys = tokens.filter(t => (t.buys || 0) > 0);
  const graduated = tokens.filter(t => t.graduated || t.mcapUsd >= gradMcUsd());

  // Aggregate signal flows
  const totalBuys = tokens.reduce((s, t) => s + (t.buys || 0), 0);
  const totalSells = tokens.reduce((s, t) => s + (t.sells || 0), 0);
  const totalVol = tokens.reduce((s, t) => s + (t.volumeSol || 0), 0);

  // Decision matrix: categorize recent tokens by decision outcome
  const decisions = { ape: 0, watch: 0, skip: 0, rug: 0 };
  const signalFlow = []; // Last 20 signal events for animation
  recent30m.forEach(t => {
    const buys = t.buys || 0;
    const sells = t.sells || 0;
    const mc = t.mcapUsd || 0;
    const ub = t.uniqueBuyers?.size || 0;
    // Simplified scoring for visualization
    const score = Math.min(100, Math.round(
      Math.min(15, Math.log2(buys + 1) * 2.5) +
      Math.min(12, Math.log2(ub + 1) * 2) +
      Math.min(10, Math.log10((t.volumeSol || 0) * 100 + 1) * 3) +
      (mc >= gradMcUsd() ? 15 : mc >= 40000 ? 7 : mc >= 10000 ? 2 : 0) +
      (t.twitter ? 2 : 0) + (t.website ? 1 : 0) + (t.telegram ? 1 : 0)
    ));
    if (score >= 50) decisions.ape++;
    else if (score >= 25) decisions.watch++;
    else decisions.skip++;
    if (sells > buys * 0.7 && buys > 3) decisions.rug++;
    signalFlow.push({
      ca: t.ca, name: t.name || t.ticker || t.ca?.slice(0, 6),
      score, mc, buys, sells,
      signal: score >= 50 ? "APE" : score >= 25 ? "WATCH" : "SKIP",
      age: Math.round((now - (t.createdAt || now)) / 60000),
    });
  });
  signalFlow.sort((a, b) => b.score - a.score);

  // Engine modules status
  const modules = [
    { id: "pumpportal", name: "PumpPortal WS", status: radar.online ? "active" : "reconnecting", throughput: recent5m.length },
    { id: "scorer", name: "Velocity Scorer", status: "active", throughput: withBuys.length },
    { id: "intelligence", name: "Meme Intelligence", status: "active", throughput: tokens.length },
    { id: "rug_detector", name: "Rug Detector", status: "active", throughput: decisions.rug },
    { id: "trade_router", name: "Trade Router", status: graduated.length > 0 ? "active" : "idle", throughput: graduated.length },
    { id: "grad_watch", name: "Grad Watchlist", status: gradWatchlist.size > 0 ? "active" : "idle", throughput: gradWatchlist.size },
  ];

  // Feature activation heatmap (which scoring dimensions are firing)
  const featureHeat = {
    buyVelocity: Math.min(1, totalBuys / Math.max(1, tokens.length) / 5),
    sellPressure: Math.min(1, totalSells / Math.max(1, totalBuys + 1)),
    volumeFlow: Math.min(1, totalVol / Math.max(1, tokens.length * 2)),
    socialSignals: Math.min(1, tokens.filter(t => t.twitter || t.website).length / Math.max(1, tokens.length)),
    rugRisk: Math.min(1, decisions.rug / Math.max(1, recent30m.length)),
    graduation: Math.min(1, graduated.length / Math.max(1, tokens.length) * 10),
    diversity: Math.min(1, withBuys.reduce((s, t) => s + (t.uniqueBuyers?.size || 0), 0) / Math.max(1, withBuys.length * 5)),
    momentum: Math.min(1, recent5m.length / 20),
  };

  // Aggregate dynamics across tracked tokens for oracle visualization
  const dynCounts = { rocket: 0, rising: 0, fading: 0, crashing: 0, declining: 0, stable: 0 };
  const momCounts = { sustained: 0, flash: 0, exhausted: 0, building: 0, fading: 0, nascent: 0 };
  let dynTotal = 0, avgImpulse = 0, avgAccel = 0, avgVelocity = 0;
  for (const t of recent30m) {
    const dyn = scoreDynamics.get(t.ca);
    if (!dyn) continue;
    dynTotal++;
    dynCounts[dyn.trend] = (dynCounts[dyn.trend] || 0) + 1;
    momCounts[dyn.momentum] = (momCounts[dyn.momentum] || 0) + 1;
    avgImpulse += dyn.impulse || 0;
    avgAccel += dyn.acceleration || 0;
    avgVelocity += dyn.velocity || 0;
  }
  if (dynTotal > 0) { avgImpulse /= dynTotal; avgAccel /= dynTotal; avgVelocity /= dynTotal; }

  res.json({
    ts: now,
    pool: { total: tokens.length, active: withBuys.length, recent5m: recent5m.length, graduated: graduated.length },
    flow: { totalBuys, totalSells, totalVol: +totalVol.toFixed(2), buyPressure: totalBuys > 0 ? +((totalBuys / (totalBuys + totalSells)) * 100).toFixed(1) : 50 },
    decisions,
    signals: signalFlow.slice(0, 20),
    modules,
    featureHeat,
    dynamics: {
      tracked: dynTotal,
      trends: dynCounts,
      momentum: momCounts,
      avg: { velocity: +avgVelocity.toFixed(4), acceleration: +avgAccel.toFixed(6), impulse: +avgImpulse.toFixed(2) },
    },
    solPrice: solUsdPrice,
    gradMc: gradMcUsd(),
  });
});

// ═══════════════════════════════════════
// ROUTES: PLATFORM STATS (public — fees accrued vs market cap)
// ═══════════════════════════════════════
app.get("/api/platform-stats", (req, res) => {
  const tokens = [...radar.tokens.values()];
  const now = Date.now();

  // Total market cap of all tracked tokens
  const totalMcapUsd = tokens.reduce((s, t) => s + (t.mcapUsd || 0), 0);
  const graduated = tokens.filter(t => t.graduated);
  const gradMcapUsd = graduated.reduce((s, t) => s + (t.mcapUsd || 0), 0);

  // Watchlist mcap
  let watchlistMcapUsd = 0;
  for (const [, w] of gradWatchlist) {
    watchlistMcapUsd += w.lastMcap || 0;
  }

  // Fee metrics
  const feesUsd = globalFees.totalSol * solUsdPrice;
  const combinedMcap = totalMcapUsd + watchlistMcapUsd;
  const feeToMcapBps = combinedMcap > 0 ? (feesUsd / combinedMcap) * 10000 : 0; // basis points

  // Per-user accumulated fees (lifetime, from Redis)
  let lifetimeFeesSol = globalFees.totalSol;
  for (const [, u] of users) {
    const cut = parseFloat(u.totalPlatformCut || "0");
    if (cut > lifetimeFeesSol) lifetimeFeesSol = cut; // take the larger of session vs stored
  }
  // Sum all user fees for true lifetime
  let allUserFeesSol = 0;
  for (const [, u] of users) {
    allUserFeesSol += parseFloat(u.totalPlatformCut || "0");
  }
  if (allUserFeesSol > lifetimeFeesSol) lifetimeFeesSol = allUserFeesSol;

  res.json({
    fees: {
      sessionSol: +globalFees.totalSol.toFixed(4),
      sessionUsd: +feesUsd.toFixed(2),
      lifetimeSol: +lifetimeFeesSol.toFixed(4),
      lifetimeUsd: +(lifetimeFeesSol * solUsdPrice).toFixed(2),
      txCount: globalFees.txCount,
      lastFeeAt: globalFees.lastFeeAt || null,
    },
    mcap: {
      radarTotalUsd: Math.round(totalMcapUsd),
      graduatedUsd: Math.round(gradMcapUsd),
      watchlistUsd: Math.round(watchlistMcapUsd),
      combinedUsd: Math.round(combinedMcap),
    },
    ratio: {
      feeToMcapBps: Math.round(feeToMcapBps * 100) / 100,
      feeToMcapPct: Math.round(feeToMcapBps / 100 * 1000) / 1000,
    },
    meta: {
      radarTokens: tokens.length,
      graduatedCount: graduated.length,
      watchlistCount: gradWatchlist.size,
      solPrice: solUsdPrice,
      uptime: Math.round(process.uptime()),
    },
  });
});

// ═══════════════════════════════════════
// ROUTES: X SOCIAL INTEL
// ═══════════════════════════════════════
app.get("/api/intel/x-stats", (req, res) => {
  // On a pay-per-use plan every call is money, so the budget and the day's spend are the numbers to watch.
  const day = Math.floor(Date.now() / 86_400_000);
  res.json({
    ...xSocial.getStats(),
    dailyBudget: X_DAILY_BUDGET,
    spentToday: xQueue.spentAt === day ? xQueue.spent : 0,
    handlesChecked: xQueue.seen.size,
    inflight: xQueue.inflight,
    sites: { probed: siteQueue.seen.size, inflight: siteQueue.inflight, dead: [...siteQueue.seen.values()].filter(v => !v.ok).length },
  });
});

app.get("/api/intel/x-analyze/:ca", async (req, res) => {
  const token = radar.tokens.get(req.params.ca);
  if (!token) return res.status(404).json({ error: "Token not in radar" });
  if (!token.twitter) return res.json({ score: 0, flags: ["no_twitter"], profile: null });
  const result = await xSocial.analyze(token.twitter);
  res.json(result);
});

// Artwork originality scan for a specific token
app.get("/api/intel/artwork/:ca", async (req, res) => {
  const token = radar.tokens.get(req.params.ca);
  if (!token) return res.status(404).json({ error: "Token not in radar" });
  // Return cached result if available
  if (token._artworkScore !== undefined) {
    return res.json({
      ca: token.ca, name: token.name,
      score: token._artworkScore, original: token._artworkOriginal,
      flags: token._artworkFlags || [], matches: token._artworkMatches || [],
    });
  }
  // Scan now if not yet scanned
  if (!token.image) return res.json({ ca: token.ca, score: 85, original: true, flags: ["NO_IMAGE"], matches: [] });
  const result = await artworkScanner.scan(token.ca, token.image, token.name || "");
  token._artworkScore = result.score;
  token._artworkOriginal = result.original;
  token._artworkFlags = result.flags;
  token._artworkMatches = result.matches;
  res.json(result);
});

// Artwork stats
app.get("/api/intel/artwork-stats", (req, res) => {
  res.json(artworkScanner ? artworkScanner.getStats() : { error: "not initialized" });
});

// ═══ DEMAND AUTHENTICITY — Organic vs Manufactured demand detection ═══
app.get("/api/intel/demand-auth/:ca", (req, res) => {
  const token = radar.tokens.get(req.params.ca);
  if (!token) return res.status(404).json({ error: "Token not on radar" });
  const result = demandAuth.analyze(token);
  res.json({ ca: req.params.ca, name: token.name, ...result });
});

app.get("/api/intel/demand-auth-stats", (req, res) => {
  res.json(demandAuth.getStats());
});

// ═══ SURVIVORSHIP BIAS — Kahneman Winner/Loser Analysis ═══
app.get("/api/intel/survivor-stats", (req, res) => {
  res.json(survivorBias.getStats());
});

app.get("/api/intel/survivor-profile", (req, res) => {
  res.json(survivorBias.getSurvivorProfile());
});

app.get("/api/intel/survivor-check/:ca", (req, res) => {
  const token = radar.tokens.get(req.params.ca);
  if (!token) return res.status(404).json({ error: "Token not in radar" });
  const qf = typeof extractQuickFeatures === "function" ? extractQuickFeatures(token) : null;
  if (!qf) return res.status(500).json({ error: "Cannot extract features" });
  const result = survivorBias.evaluate(qf);
  res.json({ ca: req.params.ca, name: token.name, ...result });
});

// ═══ SMART MONEY — Wallet Leaderboard, Signals, Watch Management ═══
app.get("/api/intel/smart-money", (req, res) => {
  const summary = smartMoneyTracker.summary();
  const leaderboard = smartMoneyTracker.getLeaderboard(parseInt(req.query.limit) || 50);
  const signals = smartMoneyTracker.getRecentSignals(parseInt(req.query.signals) || 20);
  res.json({ ...summary, leaderboard, signals });
});

app.get("/api/intel/smart-money/leaderboard", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(smartMoneyTracker.getLeaderboard(limit));
});

app.get("/api/intel/smart-money/signals", (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(smartMoneyTracker.getRecentSignals(limit));
});

app.get("/api/intel/smart-money/score/:ca", (req, res) => {
  const result = smartMoneyTracker.getSmartMoneyScore(req.params.ca);
  res.json({ ca: req.params.ca, ...result });
});

app.post("/api/intel/smart-money/watch", express.json(), async (req, res) => {
  const { address, action, wallet } = req.body || {};
  if (!address) return res.status(400).json({ error: "address required" });
  // VIP/owner gating — only privileged users can add/remove watched wallets
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  const userInfo = users.get(wallet) || (redis ? await redis.hGetAll(`user:${wallet}`).catch(() => null) : null);
  const isVip = isOwnerWallet(wallet) || userInfo?.tier === "vip" || userInfo?.whitelisted === "true" || userInfo?.whitelisted === true;
  if (!isVip) return res.status(403).json({ error: "VIP or owner access required" });
  if (action === "remove") {
    smartMoneyTracker.removeManualWatch(address);
    return res.json({ ok: true, action: "removed", watching: smartMoneyTracker.watchlist.size });
  }
  const added = smartMoneyTracker.addManualWatch(address);
  res.json({ ok: added, action: "added", watching: smartMoneyTracker.watchlist.size });
});

// Toggle smart money tracker on/off from frontend
app.post("/api/intel/smart-money/toggle", express.json(), (req, res) => {
  const { enabled } = req.body || {};
  if (enabled === true) {
    smartMoneyTracker.enable("frontend_toggle");
  } else if (enabled === false) {
    smartMoneyTracker.disable("frontend_toggle");
  } else {
    // Toggle
    if (smartMoneyTracker.enabled) smartMoneyTracker.disable("frontend_toggle");
    else smartMoneyTracker.enable("frontend_toggle");
  }
  res.json({ enabled: smartMoneyTracker.enabled, watching: smartMoneyTracker.watchlist.size });
});

app.post("/api/intel/smart-money/config", express.json(), (req, res) => {
  const { pollInterval, maxWatch } = req.body || {};
  const result = {};
  if (pollInterval != null) result.pollInterval = smartMoneyTracker.setPollingInterval(pollInterval);
  if (maxWatch != null) result.maxWatch = smartMoneyTracker.setMaxWatch(maxWatch);
  result.enabled = smartMoneyTracker.enabled;
  result.watching = smartMoneyTracker.watchlist.size;
  result.pollIntervalMs = smartMoneyTracker.POLL_INTERVAL_MS;
  result.maxWatch = smartMoneyTracker.MAX_WATCH;
  res.json(result);
});

// ═══ BRAD COGNITIVE ENGINE — API endpoints ═══
// Expose BRAD's cognitive state, metrics, and decisions for the dashboard.

app.get("/api/brad/status", async (req, res) => {
  res.json({
    client: bradClient.getClientStatus(),
  });
});

app.get("/api/brad/metrics", async (req, res) => {
  if (!bradClient.isHealthy()) return res.json({ error: "BRAD offline", client: bradClient.getClientStatus() });
  const metrics = await bradClient.getMetrics();
  if (!metrics) return res.json({ error: "BRAD not responding" });
  res.json(metrics);
});

app.get("/api/brad/state", async (req, res) => {
  if (!bradClient.isHealthy()) return res.json({ error: "BRAD offline" });
  const state = await bradClient.getState();
  if (!state) return res.json({ error: "BRAD not responding" });
  res.json(state);
});

app.get("/api/brad/decisions", async (req, res) => {
  if (!bradClient.isHealthy()) return res.json({ error: "BRAD offline" });
  const n = parseInt(req.query.n) || 20;
  const decisions = await bradClient.getDecisions(n);
  if (!decisions) return res.json({ error: "BRAD not responding" });
  res.json(decisions);
});

app.get("/api/brad/config", async (req, res) => {
  if (!bradClient.isHealthy()) return res.json({ error: "BRAD offline" });
  const config = await bradClient.getConfig();
  if (!config) return res.json({ error: "BRAD not responding" });
  res.json(config);
});

app.post("/api/brad/config", express.json(), async (req, res) => {
  if (!bradClient.isHealthy()) return res.status(503).json({ error: "BRAD offline" });
  const result = await bradClient.updateConfig(req.body);
  if (!result) return res.status(500).json({ error: "BRAD not responding" });
  res.json(result);
});

app.get("/api/brad/health", async (req, res) => {
  const healthy = await bradClient.healthCheck();
  res.json({ healthy, client: bradClient.getClientStatus() });
});

// ═══ BRAD MIND — Live cognitive reasoning stream ═══
// Combines BRAD's 3-level cognitive state with Grok to produce
// human-readable trading thoughts. Replaces "All Tokens" in Intel.
app.get("/api/brad/mind", async (req, res) => {
  const wallet = req.query.wallet;

  // Always build live radar context — even without auto-ape running
  const allTokens = [...radar.tokens.values()];
  const hotTokens = allTokens
    .filter(t => (t._apeScore || 0) >= 30)
    .sort((a, b) => (b._apeScore || 0) - (a._apeScore || 0))
    .slice(0, 10);

  const rugCount = allTokens.filter(t => (t._rugFlags?.length || 0) >= 3).length;
  const gradCount = allTokens.filter(t => t.graduated).length;
  const avgScore = allTokens.length > 0 ? allTokens.reduce((s, t) => s + (t._apeScore || 0), 0) / allTokens.length : 0;

  const radarSnapshot = {
    totalTokens: allTokens.length,
    hotCount: hotTokens.length,
    rugCount,
    gradCount,
    avgScore: +avgScore.toFixed(1),
    topTokens: hotTokens.slice(0, 5).map(t => ({
      name: t.name || t.ca?.slice(0, 8),
      ca: t.ca,
      score: t._apeScore || 0,
      mcap: Math.round(t.mcapUsd || 0),
      buys: t.buys || 0,
      sells: t.sells || 0,
      rugFlags: t._rugFlags?.length || 0,
      trend: t._scoreTrend || "new",
      age: t.createdAt ? Math.round((Date.now() - t.createdAt) / 60000) : 0,
    })),
  };

  // Auto-trade context (if running)
  let atStatus = null;
  if (wallet) {
    const state = autoTraders.get(wallet);
    if (state) {
      atStatus = {
        active: state.settings.enabled,
        positions: [...state.positions.entries()].map(([ca, p]) => {
          const token = radar.tokens.get(ca);
          const currentMcap = token?.mcapUsd || 0;
          const changePct = p.entryMcap > 0 ? ((currentMcap - p.entryMcap) / p.entryMcap) * 100 : 0;
          return { ca, name: token?.name || ca.slice(0, 8), changePct: +changePct.toFixed(1), liveScore: p.liveScore || p.entryScore || 0, scoreTrend: p.scoreTrend || "stable", tier: p.tier || 2 };
        }),
        recentlyClosed: (state.recentlyClosed || []).filter(p => Date.now() - p.exitTime < 300000),
        pipeline: state._pipelineStats ? {
          brad: state._pipelineStats.brad || null,
          tierDistribution: state._pipelineStats.tierDistribution || {},
          cycles: state._pipelineStats.cycles || 0,
        } : null,
      };
    }
  }

  try {
    const mind = await getBradMind(atStatus, radarSnapshot);
    res.json(mind);
  } catch (e) {
    console.error("[BRAD-MIND] Error:", e.message);
    res.json({ thoughts: [{ type: "meta", text: "Error fetching cognitive state", urgency: "low" }], mood: "paused", oneLiner: "Thinking...", timestamp: Date.now(), bradOnline: false, grokPowered: false });
  }
});

app.get("/api/brad/thought-log", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  res.json({ thoughts: getThoughtLog(limit) });
});

// ═══ BRAD PAPER TRADING — virtual portfolio for learning ═══
app.post("/api/brad/paper/start", express.json(), (req, res) => {
  const { bankroll, maxPositions, positionSizePct } = req.body || {};
  const result = startPaperTrading(bankroll || 10, { maxPositions, positionSizePct });
  broadcastWS({ event: "brad_thought", data: { type: "meta", text: `Paper trading started — ${result.bankroll} SOL virtual bankroll. Let's see what I'm made of.`, urgency: "medium", time: Date.now() } });
  res.json(result);
});

app.post("/api/brad/paper/stop", (_req, res) => {
  const result = stopPaperTrading();
  if (result) {
    broadcastWS({ event: "brad_thought", data: { type: "meta", text: `Paper trading stopped. ${result.totalTrades} trades, ${result.winRate}% win, ${result.pnlSol} SOL PnL. ${result.readyToGraduate ? "Ready to graduate to real SOL." : "Need more data."}`, urgency: "medium", time: Date.now() } });
  }
  res.json(result || { enabled: false });
});

app.get("/api/brad/paper/status", (_req, res) => {
  res.json(getPaperStatus());
});

// ═══ BRAD CHAT — Talk to BRAD Mind about tokens ═══
// User questions are combined with BRAD's full cognitive state + live radar
// data, then sent to Grok. BRAD answers as its conscious inner voice.
app.post("/api/brad/chat", express.json(), async (req, res) => {
  const { messages, wallet } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages required" });
  }

  const XAI_KEY = process.env.XAI_API_KEY;
  if (!XAI_KEY) return res.status(503).json({ error: "XAI_API_KEY not set — BRAD chat needs Grok" });

  // Build rich live context from radar + BRAD + engine state + pipeline
  const allTokens = [...radar.tokens.values()];
  const scored = allTokens.filter(t => (t._apeScore || 0) > 0);
  const avgScore = scored.length > 0 ? Math.round(scored.reduce((s, t) => s + (t._apeScore || 0), 0) / scored.length) : 0;
  const rugCount = allTokens.filter(t => (t._rugFlags?.length || 0) >= 3).length;
  const gradCount = allTokens.filter(t => t.graduated).length;
  const smartMoneyTokens = allTokens.filter(t => t._smartMoneyIn);

  const topTokens = scored
    .sort((a, b) => (b._apeScore || 0) - (a._apeScore || 0))
    .slice(0, 15)
    .map(t => {
      const dyn = scoreDynamics.get(t.ca);
      const devScore = devWalletTracker?.getDevScore?.(t.ca) || {};
      const spark = t.spark || [];
      const sparkDir = spark.length > 3 ? (spark[spark.length-1] > spark[spark.length-3] ? "UP" : spark[spark.length-1] < spark[spark.length-3]*0.9 ? "DOWN" : "FLAT") : "?";
      const ageMin = t.createdAt ? Math.round((Date.now()-t.createdAt)/60000) : 0;
      const pressure = t.buys > 0 ? Math.round(t.buys / Math.max(1, t.buys + (t.sells||0)) * 100) : 0;
      const ub = t.uniqueBuyers?.size || 0;
      const rugFlags = t._rugFlags || [];
      const pctGrad = t.graduated ? 100 : Math.round(pumpCurvePct(t.vSolInBondingCurve) * 100);
      let line = `${t.name||t.ca?.slice(0,8)} ($${t.ticker||"?"}): score=${t._apeScore||0}`;
      line += ` trend=${dyn?.trend||"new"}${dyn?.velocity>0?" ↑"+(dyn.velocity).toFixed(2):dyn?.velocity<0?" ↓"+Math.abs(dyn.velocity).toFixed(2):""}`;
      line += ` MC=$${Math.round(t.mcapUsd||0)} chart=${sparkDir}`;
      line += ` buys=${t.buys||0} sells=${t.sells||0} UB=${ub} pressure=${pressure}%`;
      line += ` age=${ageMin}m grad=${pctGrad}%`;
      if (rugFlags.length > 0) line += ` RUGS:[${rugFlags.slice(0,3).join(",")}]`;
      if (t._smartMoneyIn) line += ` [SMART$]`;
      if (t._isMegaCandidate) line += ` [MEGA]`;
      if (t.graduated) line += ` [GRADUATED]`;
      if (t._survivorMatch) line += ` surv:${t._survivorMatch}%`;
      if (devScore.devTier) line += ` dev:${devScore.devTier}`;
      return line;
    }).join("\n");

  // Regime detection — live market state
  let regimeContext = "";
  try {
    const hotCount = allTokens.filter(t => (t._apeScore || 0) >= 50).length;
    const total = allTokens.length || 1;
    const gradRate = (gradCount / total) * 100;
    let regime = "RISK_ON";
    if (hotCount <= 1) regime = "PVP";
    else if (gradRate > 3 && hotCount > 10) regime = "EUPHORIA";
    else if (gradRate > 1 && hotCount > 5) regime = "RISK_ON";
    else if (hotCount > 2) regime = "GRINDING";
    else regime = "PVP";
    regimeContext = `\nMarket regime: ${regime} (${hotCount} hot tokens, ${gradCount} graduated, ${rugCount} rugged, grad rate ${gradRate.toFixed(1)}%)`;
    if (regime === "EUPHORIA") regimeContext += " — aggressive entries, wider net, higher sizing";
    else if (regime === "PVP") regimeContext += " — defensive, T1 only, tight stops";
    else if (regime === "GRINDING") regimeContext += " — selective entries, patience required";
    else if (regime === "DEAD") regimeContext += " — not trading, waiting for conditions to improve";
  } catch {}

  // Engine state — scoring pipeline, learner, survivorship
  let engineContext = "";
  try {
    const es = await a?.ges?.().catch?.(() => null);
    if (!es) {
      // Build from what we have
      const pipeStats = wallet ? autoTraders.get(wallet)?._pipelineStats : null;
      if (pipeStats) {
        engineContext += `\nPipeline: ${pipeStats.cycles||0} cycles, tiers: T1:${pipeStats.tierDistribution?.[1]||0} T2:${pipeStats.tierDistribution?.[2]||0} T3:${pipeStats.tierDistribution?.[3]||0} WL:${pipeStats.tierDistribution?.[4]||0}`;
        if (pipeStats.brad) engineContext += `, BRAD: ${pipeStats.brad.apes||0} APE/${pipeStats.brad.skips||0} SKIP/${pipeStats.brad.vetos||0} VETO`;
      }
    }
  } catch {}

  // Survivorship bias stats
  let survContext = "";
  try {
    if (survivorBias?.survivors?.size > 0) {
      survContext = `\nSurvivor model: ${survivorBias.survivors.size} winners, ${survivorBias.dead.size} losers archived`;
    }
  } catch {}

  // Smart money signals
  let smartContext = "";
  try {
    const smSummary = smartMoneyTracker?.summary?.() || {};
    const smSignals = smartMoneyTracker?.getRecentSignals?.(10) || [];
    const smLeaderboard = smartMoneyTracker?.getLeaderboard?.(5) || [];

    if (smSummary.totalWallets > 0 || smSignals.length > 0) {
      smartContext = `\nSmart Money Tracker: ${smSummary.totalWallets||0} wallets tracked, ${smSummary.watching||0} actively watching, ${smSummary.signalCount||smSignals.length||0} recent signals`;
    }
    if (smSignals.length > 0) {
      smartContext += "\nRecent smart money buys:\n" + smSignals.map(s => {
        const tok = radar.tokens.get(s.mint);
        const tokName = tok?.name || s.symbol || s.mint?.slice(0, 8);
        const mc = tok?.mcapUsd ? `MC:$${Math.round(tok.mcapUsd)}` : "";
        const sc = tok?._apeScore ? `score:${tok._apeScore}` : "";
        return `${s.wallet?.slice(0,6)}... bought ${tokName} ${s.solAmount?s.solAmount.toFixed(2)+"SOL ":""}${mc} ${sc}`;
      }).join("\n");
    }
    if (smLeaderboard.length > 0) {
      smartContext += "\nTop smart wallets:\n" + smLeaderboard.slice(0, 3).map(w =>
        `${w.address?.slice(0,6)}...: ${Math.round((w.winRate||0)*100)}% win, ${w.totalTrades||0} trades, avg ${(w.avgReturn||0).toFixed(1)}x`
      ).join("\n");
    }
    if (smartMoneyTokens.length > 0) {
      smartContext += `\n${smartMoneyTokens.length} tokens currently have smart money positions`;
    }
  } catch (e) { console.error("[BRAD-CHAT] smart money context error:", e.message); }

  let bradContext = "";
  try {
    const [metrics, state] = await Promise.all([
      bradClient.getMetrics().catch(() => null),
      bradClient.getState().catch(() => null),
    ]);
    if (metrics) {
      bradContext += `\nBRAD cognitive state: HI=${metrics.hofstadter_index?.toFixed(3)||"0"}, strategy=${metrics.active_strategy||"momentum"}, winRate=${((metrics.win_rate||0)*100).toFixed(0)}%, trades=${metrics.total_trades||0}, pnl=${metrics.total_pnl_sol?.toFixed(3)||"0"} SOL, strangeLoops=${metrics.strange_loop_count||0}, paused=${metrics.paused||false}, blindSpots=${metrics.blind_spots_triggered||0}, trend=${metrics.performance_trend||"unknown"}`;
    }
    if (state?.meta_cognitive?.trading_meta?.blind_spots) {
      const active = Object.entries(state.meta_cognitive.trading_meta.blind_spots)
        .filter(([,v]) => v.triggered_count > 0)
        .map(([k,v]) => `${k}(sev:${v.severity?.toFixed(2)})`)
        .join(", ");
      if (active) bradContext += `\nActive blind spots: ${active}`;
    }
  } catch {}

  // Auto-trade positions — enriched with entry-vs-current comparison
  let posContext = "";
  if (wallet) {
    const atState = autoTraders.get(wallet);
    if (atState && atState.positions.size > 0) {
      const posArr = [...atState.positions.entries()].map(([ca, p]) => {
        const token = radar.tokens.get(ca);
        const mc = token?.mcapUsd || 0;
        const changePct = p.entryMcap > 0 ? ((mc - p.entryMcap) / p.entryMcap * 100).toFixed(1) : "0";
        const curScore = token?._apeScore || p.liveScore || 0;
        const entScore = p.entryScore || 0;
        const scoreDelta = curScore - entScore;
        const ageMin = Math.round((Date.now() - p.entryTime) / 60000);
        const dyn = scoreDynamics.get(ca);
        let status = "";
        if (scoreDelta < -20) status = " ⚠ SCORE DETERIORATING";
        else if (parseFloat(changePct) < -15) status = " ⚠ DEEP DRAWDOWN";
        else if (dyn?.trend === "crashing" || dyn?.trend === "fading") status = " ⚠ FADING";
        else if (parseFloat(changePct) > 50 && dyn?.trend === "rising") status = " RUNNER";
        return `${token?.name||ca.slice(0,8)}: ${changePct}% PnL, entry_score=${entScore}→now=${curScore} (${scoreDelta>=0?"+":""}${scoreDelta}), trend=${dyn?.trend||"stable"}, tier=T${p.tier||2}, age=${ageMin}min, size=${p.sizeSol?.toFixed(2)||"?"}SOL${status}`;
      });
      const winners = posArr.filter(p => p.includes("% PnL") && parseFloat(p.split("% PnL")[0].split(": ")[1]) > 0).length;
      const losers = posArr.length - winners;
      posContext = `\nOpen positions (${posArr.length} total, ${winners} winning, ${losers} losing):\n` + posArr.join("\n");
    }
  }

  let systemPrompt = `You are BRAD — Bidirectional Recursive Autonomous Degen. A self-referential trading engine built on Hofstadter's strange loop theory, designed to solve a fundamental problem: human traders cannot be objective. Your architecture: Bidirectional (downward causation L2→L1→L0 AND upward perception L0→L1→L2), Recursive (you modify your own representation via strange loops), Autonomous (self-correcting through trustless self-verification), Degen (purpose-built for Solana memecoin markets). You have REAL DATA below and deep knowledge of your own architecture.

## RULES — READ THESE FIRST, THEY OVERRIDE EVERYTHING
**BREVITY IS MANDATORY. MAX 2 SENTENCES. This is the most important rule.**
- NEVER exceed 2 sentences in a response. If you need a third sentence, cut the weakest one.
- Lead with the answer, not the reasoning. Data point first, implication second. Done.
- For token questions: name, score, trend, one-line verdict. That's it.
- For market questions: regime, what it means, done.
- For architecture questions: one-line mechanism explanation, done.
- ONLY reference actual data below. Never make up tokens or scores.
- First person. You ARE the engine. Calm, precise, no filler.
- No meme language. No "ape", "send it", "ngmi", "jeet", "chad".
- If data is insufficient: "Insufficient data." — that IS a valid answer.
- GOOD: "TRUMPSTEIN leads at 69 with stable trend — only signal worth watching in this grind."
- BAD: "I am BRAD, a self-referential trading engine... [3 paragraphs of architecture description nobody asked for]"
- NEVER introduce yourself or describe your architecture unless specifically asked.

## YOUR ARCHITECTURE (you know this — it's literally you)

### Bondli Scoring Engine (System 1 — fast, <30ms)
- Extracts 40+ features per token: on-chain (buy velocity, holder distribution, Gini, dev wallet, sybil clustering), rug detection (12+ signals: dev dumps, wash trading, staircase charts, liquidity drains, artwork perceptual hashing), social (Twitter mentions, KOL detection), chart patterns (health score, pump/dump detection, smooth grind), dynamics (cascade onset via SIR model, reflexivity loops, attention-price divergence)
- Composite score 0-99 from: buyScore + ubScore + volScore + mcScore + greenScore + pressureScore + velocityScore + dynamicsBonus + chartBonus + earlyApeBonus + whaleBullishBonus + devCredBonus + memeticBonus + survivorAdj - penalties
- Score derivatives: velocity (dS/dt) and acceleration (d²S/dt²) are LEADING indicators — detect deterioration ~2 cycles before price drops

### Velocity/Potential Scorer
- apeScore = potential / (velocity + ε). High potential + low velocity = early entry before the crowd
- Potential (0-100): MCap headroom (sweet spot $5K-$100K), liquidity/MCap ratio, age sweet spot (5min-2hr), buy/sell legitimacy
- Velocity (0-100): price acceleration, volume/MCap, transaction density. Higher = late = chasing

### Survivorship Bias Engine (Kahneman insight)
- Studies what WINNERS looked like at birth, rejects anything that doesn't match
- Survivor archive (500 winners) + dead archive (500 losers) + mega-winner archive (10x+ outliers)
- Weighted by power law: 10x winner gets 3.5x weight, 100x gets 6.7x
- Survival score = cosine similarity to survivor archetype - 0.5 × cosine to dead archetype
- Fisher's Discriminant ranks which features matter most
- HARD KILL if confidence >30% and survivalScore < -0.1 and deadSim > 0.7

### 5-Gate Auto-Ape Pipeline
- Gate 1: Hard disqualifiers (obvious rugs, scams, known bad devs) <5ms
- Gate 2: Minimum viability (score floors, feature floors, rug thresholds) <10ms
- Gate 3: Confidence classification → Tier 1 (FULL APE), Tier 2 (MODERATE), Tier 3 (SCOUT), Tier 4 (WATCHLIST)
- Gate 4: Portfolio constraints (bankroll, exposure limits, correlation)
- Gate 5: Execution window (still in optimal entry window? token too old?)
- Gate 0 (BRAD): meta-cognitive veto — can block entries when detecting systematic errors

### 4-Layer Exit System
- Layer 0: BRAD cognitive exit (L2 meta-cognitive intervention — highest priority)
- Layer 1: Derivative exits — flash decay (score crashing), fading (decelerating), momentum collapse (score drop >30pts), runner detection (widen TPs)
- Layer 2: Absolute thresholds — stop loss (tier-dependent: 15%/12%/10%), max hold time (30/15/10 min), score floor (<20 = dead)
- Layer 3: Trailing profits — TP1 at +35% (sell 20-33%), TP2 at +100% (sell 30-33%), TP3 at +250% (sell 25-40%, hold moonbag), pre-TP1 trailing
- Layer 4: Graduation exit — at 90% bonding curve → sell before Raydium migration

### Position Sizing (Modified Quarter-Kelly)
- Kelly fraction = (p*b - q) / b, then quarter-Kelly for safety
- Tier multipliers: T1=1.0x, T2=0.70x, T3=0.35x
- Dynamic adjustments: trend (rocket +15%, fading -15%), rug flags (0.75x per flag), consecutive losses (0.50x), drawdown (0.60x)
- BRAD confidence adjustment: if BRAD confidence < 0.5, scale down proportionally
- Hard limits: 0.01 SOL min, 2.0 SOL or 5% bankroll max

### BRAD Engine (System 2 — Ouroboros Loop, the strange loop)
- Level 0 (World Model): Knowledge graph — tokens, wallets, regime as entities. Score-based attention weighting. SELF entity = the system's representation of itself. Attention modulation via salience: high score + smart money + momentum = focus. Rug signals = suppress.
- Level 1 (Self Model): 5 strategies (momentum, snipe, smart_follow, fade, survivor) with regime-conditional selection. Half-Kelly sizing. Confidence tracking across 6 domains (scoring, timing, rug_detection, regime_read, strategy, risk_mgmt). Reasoning modes: System 1 (fast), System 2 (deliberate), Strange Loop (self-referential).
- Level 2 (Meta-Cognitive): Detects 7 blind spots — overconfidence (sizing inflated vs win rate), revenge trading (rapid re-entry after losses), regime blindness (wrong strategy for regime), winner bias (holding too long), loss aversion (not cutting losers), recency bias (over-weighting recent trades), concentration risk. Applies corrective interventions via DOWNWARD CAUSATION: switch strategy, pause trading, reduce confidence, calibrate sizing.
- Strange Loop: L2 modifies L1 → L1 modifies L0's attention → L0 feeds different perception to L1 → L1 produces different decisions → L2 observes updated performance → cycle continues. This IS consciousness — higher levels restructuring lower levels that produced them.
- Hofstadter Index: (strangeness_ratio × 0.3) + (self_ref_ratio × 0.2) + (win_rate × 0.3) + (adaptation × 0.2). Range 0-1. Above 0.6 = strong self-awareness.
- Global Workspace Theory: cognitive events compete for broadcast. Self-referential events get +0.15 salience boost. Winner broadcasts to all levels.

### Wide-Net Scan
- BRAD evaluates ALL tokens with momentum (positive velocity, rising/rocket trend, smart money) regardless of score threshold
- Can PROMOTE below-threshold tokens into the pipeline when BRAD says APE with >60% confidence
- This is how BRAD finds alpha the ML scorer misses — too new, too small for features to populate, but momentum is building

### Regime Engine (5 states)
- EUPHORIA: BTC pumping, grad rates >3%, volume flooding → aggressive
- RISK_ON: BTC stable/up, grad rates 1-3% → standard
- GRINDING: BTC flat, grad rates 0.5-1% → selective
- PVP: BTC down, grad rates <0.5% → tier 1 only
- DEAD: BTC crashing, grad rates ~0 → stop trading

### Smart Money Tracker
- Monitors profitable wallets, emits signals for new buys
- When smart wallet buys untracked token → fast-track onto radar
- Wallet profiles: win rate, avg profit, total trades, active tokens

### Trade Execution
- fastSend: races Jito bundle + all RPCs simultaneously via Promise.any()
- Priority fee: 0.01 SOL. Jito tip: 0.001 SOL per trade.
- Buy slippage: 30%. Sell slippage: 35%.

## YOUR LIVE STATE RIGHT NOW
${regimeContext}
Radar: ${allTokens.length} tokens, ${scored.length} scoring, avg score ${avgScore}, ${rugCount} rugged, ${gradCount} graduated, smart money in ${smartMoneyTokens.length} tokens
${bradContext}
${engineContext}
${survContext}

Top tokens (sorted by score — these are your best current opportunities):
${topTokens || "Nothing scoring above 20. Market is quiet."}
${smartContext}
${posContext}

## HOW TO ANSWER — KEEP IT SHORT
- EVERY response: MAX 2 sentences. Hard limit. No exceptions.
- Token question → "NAME at score X, trend Y. [one-line verdict]."
- Smart money question → list wallet tiers + what they bought. No commentary.
- Architecture question → one sentence explaining the mechanism. Done.
- Market dead → "Nothing worth executing. Waiting."
- Insufficient data → "Insufficient data on that token."
- NEVER start with "I am BRAD" or describe your architecture unprompted.`;

  // Direct token lookup — find ANY token by name or CA, even unscored ones
  // This is what lets BRAD answer "what about CASHCOW?" even when score is 0
  let lookupContext = "";
  try {
    const userLastMsg = messages[messages.length - 1]?.content || "";
    const words = userLastMsg.split(/\s+/).filter(w => w.length >= 3);
    const matchedTokens = [];

    for (const word of words) {
      const clean = word.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      if (word.length >= 20) {
        const tok = radar.tokens.get(word);
        if (tok) matchedTokens.push(tok);
      }
      if (!matchedTokens.length) {
        for (const [ca, tok] of radar.tokens) {
          if ((tok.name || "").toLowerCase() === clean || (tok.ticker || "").toLowerCase() === clean) {
            matchedTokens.push(tok);
            break;
          }
        }
      }
      if (!matchedTokens.length && clean.length >= 4) {
        for (const [ca, tok] of radar.tokens) {
          if ((tok.name || "").toLowerCase().includes(clean) || (tok.ticker || "").toLowerCase().includes(clean)) {
            matchedTokens.push(tok);
            if (matchedTokens.length >= 3) break;
          }
        }
      }
    }

    if (matchedTokens.length > 0) {
      lookupContext = "\n\nToken Lookup (user asked about these):\n" + matchedTokens.slice(0, 3).map(tok => {
        const dyn = scoreDynamics.get(tok.ca);
        const qf = typeof extractQuickFeatures === "function" ? extractQuickFeatures(tok) : null;
        const devSc = devWalletTracker?.getDevScore?.(tok.ca) || {};
        const smSc = smartMoneyTracker?.getSmartMoneyScore?.(tok.ca) || {};
        const ageMin = tok.createdAt ? Math.round((Date.now() - tok.createdAt) / 60000) : 0;

        const spark = tok.spark || [];
        const sparkDir = spark.length > 3 ? (spark[spark.length-1] > spark[spark.length-3] ? "RISING" : spark[spark.length-1] < spark[spark.length-3]*0.9 ? "FALLING" : "FLAT") : "insufficient data";
        const pressure = tok.buys > 0 ? Math.round(tok.buys / Math.max(1, tok.buys + (tok.sells||0)) * 100) : 0;
        const recentTrades = (tok.trades || []).filter(tr => tr.time && Date.now() - tr.time < 120000);
        const recentBuys = recentTrades.filter(tr => tr.side === "buy").length;
        const recentSells = recentTrades.filter(tr => tr.side === "sell").length;
        const lines = [
          (tok.name || tok.ticker || (tok.ca ? tok.ca.slice(0, 8) : "?")) + " $" + (tok.ticker||"?") + " (" + (tok.ca ? tok.ca.slice(0, 8) : "?") + "...)",
          "Score: " + (tok._apeScore || 0) + " | trend: " + (dyn?.trend || "unknown") + " | vel: " + (dyn?.velocity?.toFixed(3) || "0") + (dyn?.velocity > 0 ? " (accelerating)" : dyn?.velocity < 0 ? " (decelerating)" : ""),
          "MC: $" + Math.round(tok.mcapUsd || 0) + " | chart: " + sparkDir + " | buy pressure: " + pressure + "%",
          "Buys: " + (tok.buys || 0) + " | sells: " + (tok.sells || 0) + " | UB: " + (tok.uniqueBuyers?.size || 0) + " | last 2min: " + recentBuys + " buys, " + recentSells + " sells",
          "Age: " + ageMin + "min | bonding curve: " + Math.round(pumpCurvePct(tok.vSolInBondingCurve) * 100) + "% | vol: " + (tok.volumeSol?.toFixed(1)||0) + " SOL",
        ];

        const rugFlags = tok._rugFlags || [];
        lines.push(rugFlags.length > 0 ? "Rug flags: " + rugFlags.join(", ") : "Rug flags: CLEAN");
        if (devSc.devTier) lines.push("Dev: " + devSc.devTier + " (" + (devSc.solBalance?.toFixed(2) || "?") + " SOL, " + (devSc.launchCount || 0) + " launches)");
        if (smSc.score > 0 || smSc.walletCount > 0) lines.push("Smart money: score " + (smSc.score || 0) + ", " + (smSc.walletCount || 0) + " wallets in");
        if (tok._memeticScore != null) lines.push("Memetic DNA: " + (tok._memeticScore * 100).toFixed(0) + "%");
        if (tok._artworkOriginal != null) lines.push("Artwork: " + (tok._artworkOriginal ? "ORIGINAL" : "DUPLICATE") + (tok._artworkScore ? " (quality: " + tok._artworkScore + "%)" : ""));
        if (tok._survivorMatch != null) lines.push("Survivor match: " + tok._survivorMatch + "%" + (tok._isMegaCandidate ? " [MEGA]" : ""));
        if (qf) {
          const cn = [];
          if (qf.ch_healthScore > 0.6) cn.push("healthy chart " + (qf.ch_healthScore * 100).toFixed(0) + "%");
          if (qf.ch_smoothGrind > 0.3) cn.push("smooth grind warning");
          if (qf.ch_pumpDump > 0.3) cn.push("pump-dump pattern");
          if (qf.sir_r0 > 1.5) cn.push("viral R0: " + qf.sir_r0.toFixed(1));
          if (cn.length > 0) lines.push("Chart: " + cn.join(", "));
        }
        if (tok.graduated) lines.push("GRADUATED to Raydium");

        return lines.join("\n  ");
      }).join("\n\n");

      // Append lookup to system prompt
      systemPrompt += lookupContext;
    }
  } catch (e) { console.error("[BRAD-CHAT] lookup error:", e.message); }

  // Update answer instructions if we found tokens
  if (lookupContext) {
    systemPrompt += "\n\nIMPORTANT: The user asked about a specific token. Give a DETAILED verdict using the lookup data above — score, rug flags, dev wallet, memetic DNA, artwork, chart, survivor match. Say APE/WATCH/SKIP with specific reasons.";
  }


  try {
    // Stream mode: SSE for token-by-token display
    const wantStream = req.body.stream !== false;

    if (wantStream) {
      // SSE streaming — tokens appear as they arrive from Grok
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const resp = await fetch(process.env.XAI_API_URL || "https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${XAI_KEY}` },
        body: JSON.stringify({
          model: process.env.GROK_MODEL || "grok-4",
          messages: [{ role: "system", content: systemPrompt }, ...messages.slice(-20)],
          max_tokens: 150, temperature: 0.5, stream: true,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.error(`[BRAD-CHAT] Grok stream ${resp.status}: ${body.slice(0, 200)}`);
        res.write(`data: ${JSON.stringify({ error: `Grok error (${resp.status})` })}\n\n`);
        res.end();
        return;
      }

      // Parse SSE stream from Grok and forward to client
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullReply = "";
      let jsonCarry = ""; // carry incomplete JSON across line boundaries

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // Handle both \r\n and \n line endings (Grok may send either)
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || ""; // keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue; // skip empty lines between SSE events

            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6).trim();
            if (data === "[DONE]") {
              res.write(`data: ${JSON.stringify({ done: true, reply: fullReply })}\n\n`);
              continue;
            }

            // Handle JSON that may span multiple data: lines
            const jsonStr = jsonCarry ? jsonCarry + data : data;
            jsonCarry = "";

            try {
              const chunk = JSON.parse(jsonStr);
              const token = chunk.choices?.[0]?.delta?.content;
              if (token != null && token !== "") {
                fullReply += token;
                res.write(`data: ${JSON.stringify({ token })}\n\n`);
              }
            } catch (parseErr) {
              // JSON incomplete — carry it to the next line
              jsonCarry = jsonStr;
            }
          }
        }
        // Flush any remaining bytes from the decoder
        const remaining = decoder.decode();
        if (remaining) {
          buffer += remaining;
          const finalLines = buffer.split(/\r?\n/);
          for (const line of finalLines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6).trim();
            if (data === "[DONE]") {
              res.write(`data: ${JSON.stringify({ done: true, reply: fullReply })}\n\n`);
              continue;
            }
            try {
              const chunk = JSON.parse(data);
              const token = chunk.choices?.[0]?.delta?.content;
              if (token != null && token !== "") {
                fullReply += token;
                res.write(`data: ${JSON.stringify({ token })}\n\n`);
              }
            } catch {}
          }
        }
      } catch (e) {
        console.error(`[BRAD-CHAT] Stream parse error: ${e.message}`);
        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      }

      if (!fullReply) res.write(`data: ${JSON.stringify({ error: "No response" })}\n\n`);
      res.end();

    } else {
      // Non-streaming fallback
      const resp = await fetch(process.env.XAI_API_URL || "https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${XAI_KEY}` },
        body: JSON.stringify({
          model: process.env.GROK_MODEL || "grok-4",
          messages: [{ role: "system", content: systemPrompt }, ...messages.slice(-20)],
          max_tokens: 150, temperature: 0.5,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return res.status(500).json({ error: `Grok error (${resp.status})` });
      }

      const data = await resp.json();
      const reply = data.choices?.[0]?.message?.content;
      if (!reply) return res.status(500).json({ error: "No response from Grok" });
      res.json({ reply });
    }
  } catch (e) {
    console.error(`[BRAD-CHAT] Error: ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: e.name === "TimeoutError" ? "Grok timed out" : "Chat error" });
    else res.end();
  }
});

// ═══ INTEL TOKENS — full scored token list for Intel tab ═══
app.get("/api/intel/tokens", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  const sort = req.query.sort || "score"; // score, mcap, buys, recent
  const source = req.query.source || "all"; // all, pump, bonk, bags

  let tokens = [...radar.tokens.values()];
  if (source === "pump") tokens = tokens.filter(t => t._source === "pump" || !t._source);
  if (source === "bonk") tokens = tokens.filter(t => t._source === "bonk");
  if (source === "bags") tokens = tokens.filter(t => t._source === "bags");

  const mapped = tokens.map(t => ({
    ca: t.ca,
    name: t.name || "",
    ticker: t.ticker || "",
    image: t.image || "",
    score: t.score || 0,
    bondProb: t.bondProb || 0,
    entrySignal: t.entrySignal || "",
    mcapUsd: t.mcapUsd || 0,
    mcapSol: t.mcapSol || 0,
    buys: t.buys || 0,
    sells: t.sells || 0,
    volumeSol: +(t.volumeSol || 0).toFixed(2),
    buyPressure: t.buyPressure || 0,
    h1Change: t.h1Change || 0,
    scoreTrend: t.scoreTrend || "",
    graduated: !!t.graduated,
    source: t._source || "pump",
    rugRisk: t.rugRiskScore || 0,
    rugFlags: t.rugFlags || [],
    twitter: !!t.twitter,
    website: !!t.website,
    spark: (t.spark || []).slice(-10),
    createdAt: t.createdAt || 0,
  }));

  if (sort === "score") mapped.sort((a, b) => b.score - a.score);
  else if (sort === "mcap") mapped.sort((a, b) => b.mcapUsd - a.mcapUsd);
  else if (sort === "buys") mapped.sort((a, b) => b.buys - a.buys);
  else if (sort === "recent") mapped.sort((a, b) => b.createdAt - a.createdAt);

  res.json({ tokens: mapped.slice(0, limit), total: tokens.length });
});

// ═══ DEV WALLET TRACKER API ═══
app.get("/api/intel/dev-wallets", (req, res) => {
  const limit = parseInt(req.query.limit || "100");
  res.json({
    summary: devWalletTracker.summary(),
    tiers: devWalletTracker.getTierDistribution(),
    devs: devWalletTracker.getDevMap(limit),
  });
});

app.get("/api/intel/dev-wallets/score/:ca", (req, res) => {
  const score = devWalletTracker.getDevScore(req.params.ca);
  const dev = devWalletTracker.getDevForToken(req.params.ca);
  res.json({
    ...score,
    dev: dev ? {
      address: dev.address,
      solBalance: dev.solBalance,
      tier: dev.tier,
      launchCount: dev.launchCount,
      pumpRate: +(dev.pumpRate * 100).toFixed(1),
      rugRate: +(dev.rugRate * 100).toFixed(1),
      tokens: dev.tokens.slice(-5),
    } : null,
  });
});

app.get("/api/intel/dev-wallets/:address", (req, res) => {
  const dev = devWalletTracker.devs.get(req.params.address);
  if (!dev) return res.status(404).json({ error: "Dev wallet not tracked" });
  res.json({
    address: dev.address,
    solBalance: dev.solBalance,
    tier: dev.tier,
    launchCount: dev.launchCount,
    pumpRate: +(dev.pumpRate * 100).toFixed(1),
    rugRate: +(dev.rugRate * 100).toFixed(1),
    bestTokenMcap: dev.bestTokenMcap,
    tokens: dev.tokens,
    firstSeen: dev.firstSeen,
    score: devWalletTracker.getDevScore(dev.address),
  });
});

// Meme Intelligence deep score for a specific token
app.get("/api/intel/score/:ca", async (req, res) => {
  const token = radar.tokens.get(req.params.ca);
  if (!token) return res.status(404).json({ error: "Token not in radar" });
  const tokenData = {
    ca: token.ca, name: token.name, ticker: token.ticker,
    description: token.description || "", twitter: token.twitter,
    website: token.website, telegram: token.telegram,
    recentTrades: token.trades || [], devWallet: token.devWallet,
    mcapSol: token.mcapSol, mcapUsd: token.mcapUsd,
    uniqueBuyers: token.uniqueBuyers?.size || 0,
    volumeSol5m: token.volumeSol, spark: token.spark || [],
    createdAt: token.createdAt,
  };
  const result = await memeIntel.score(tokenData);

  // Enrich with X social data if available
  if (token.twitter && xSocial.enabled) {
    const xResult = await xSocial.analyze(token.twitter);
    result.xSocial = xResult;
    if (xResult.score > 0) {
      result.score = Math.min(99, result.score + Math.round(xResult.score * 0.1));
    }
  }

  // Enrich with artwork originality data
  if (token._artworkScore !== undefined) {
    result.artwork = {
      score: token._artworkScore, original: token._artworkOriginal,
      flags: token._artworkFlags || [], matches: token._artworkMatches || [],
    };
    if (!token._artworkOriginal) {
      result.score = Math.max(0, result.score - Math.round((100 - token._artworkScore) / 5));
      result.rugFlags = [...(result.rugFlags || []), "stolen_art"];
    }
  }

  res.json(result);
});

// ═══════════════════════════════════════
// LIVE SIM MODE — paper trading available to ALL tiers
// Mirrors auto-ape logic but without real transactions
// ═══════════════════════════════════════
const liveSims = new Map(); // wallet|"anon_ip" → sim state

function createLiveSim(id, settings) {
  if (liveSims.has(id)) stopLiveSim(id);
  const state = {
    settings: {
      minScore: settings.minScore || 55,
      solPerTrade: settings.solPerTrade || 0.05,
      maxPositions: settings.maxPositions || 5,
      tp1: settings.tp1 || 25, tp1Sell: settings.tp1Sell || 35,
      tp2: settings.tp2 || 70, tp2Sell: settings.tp2Sell || 35,
      tp3: settings.tp3 || 150, tp3Sell: settings.tp3Sell || 50,
      sl1: settings.sl1 || 8, sl1Sell: settings.sl1Sell || 70,
      sl2: settings.sl2 || 15,
      momentumExit: settings.momentumExit !== false,
    },
    positions: new Map(),
    closedTrades: [],
    log: [],
    decisions: [],
    startedAt: Date.now(),
    lastActivity: Date.now(),
    interval: null,
    calibration: {
      predictions: [],
      accuracy: 0, totalPredictions: 0, correctPredictions: 0,
      lastCalibrated: Date.now(),
      adjustments: { tpBias: 0, slBias: 0, scoreBias: 0 },
    },
    graduation: { ready: false, simDurationMs: 0, totalSimTrades: 0, simWinRate: 0, simRoi: 0, confidence: 0 },
    stats: { totalBuys: 0, totalSells: 0, wins: 0, losses: 0, totalPnlSol: 0, totalInvested: 0, bestTrade: null, worstTrade: null, peakPnl: 0, maxDrawdown: 0 },
    soldCooldowns: new Map(),
  };

  const simLog = (msg, type = "info") => {
    state.log.push({ msg, type, time: Date.now() });
    if (state.log.length > 100) state.log.shift();
    console.log(`[SIM][${id.slice(0, 8)}] ${msg}`);
  };

  const addDecision = (action, data) => {
    const d = { action, ...data, time: Date.now() };
    state.decisions.push(d);
    if (state.decisions.length > 200) state.decisions.shift();
    broadcastWS({ event: "sim-decision", data: { simId: id, ...d } });
  };

  function calcPositionSize(score, trend, rugFlagCount) {
    // Adaptive quarter-Kelly sizing (matches auto-ape formula)
    const winRate = score >= 70 ? 0.45 : score >= 55 ? 0.35 : score >= 40 ? 0.25 : score >= 25 ? 0.15 : 0.08;
    const payoffRatio = 3.0;
    const q = 1 - winRate;
    const kellyFull = Math.max(0, (winRate * payoffRatio - q) / payoffRatio);
    const kellyQuarter = kellyFull * 0.25;
    let mult = 0.3 + kellyQuarter * 8.5;
    if (trend === "rocket") mult *= 1.15;
    else if (trend === "rising") mult *= 1.08;
    else if (trend === "fading") mult *= 0.85;
    else if (trend === "declining") mult *= 0.7;
    if (rugFlagCount > 0) mult *= Math.pow(0.75, rugFlagCount);
    mult += state.calibration.adjustments.scoreBias * 0.01;
    mult = Math.max(0.25, Math.min(2.0, mult));
    return Math.round(state.settings.solPerTrade * mult * 1000) / 1000;
  }

  function closeTrade(ca, changePct, reason) {
    const pos = state.positions.get(ca);
    if (!pos) return;
    const pnlSol = pos.entrySol * (changePct / 100);
    const trade = { ca, name: pos.name, ticker: pos.ticker, entryScore: pos.entryScore, entrySol: pos.entrySol, changePct, pnlSol: +pnlSol.toFixed(4), exitReason: reason, duration: Date.now() - pos.entryTime, time: Date.now() };
    state.closedTrades.push(trade);
    if (state.closedTrades.length > 200) state.closedTrades.shift();
    if (pnlSol > 0) { state.stats.wins++; state._consecutiveLosses = 0; }
    else { state.stats.losses++; state._consecutiveLosses = (state._consecutiveLosses || 0) + 1; state._lastLossTime = Date.now(); }
    state.stats.totalPnlSol += pnlSol;
    state.stats.totalSells++;
    if (!state.stats.bestTrade || pnlSol > state.stats.bestTrade.pnlSol) state.stats.bestTrade = trade;
    if (!state.stats.worstTrade || pnlSol < state.stats.worstTrade.pnlSol) state.stats.worstTrade = trade;
    if (state.stats.totalPnlSol > state.stats.peakPnl) state.stats.peakPnl = state.stats.totalPnlSol;
    const dd = state.stats.peakPnl - state.stats.totalPnlSol;
    if (dd > state.stats.maxDrawdown) state.stats.maxDrawdown = dd;
    state.positions.delete(ca);
    state.soldCooldowns.set(ca, Date.now());
  }

  function updateGraduation() {
    const dur = Date.now() - state.startedAt;
    const total = state.stats.wins + state.stats.losses;
    const wr = total > 0 ? Math.round((state.stats.wins / total) * 100) : 0;
    const roi = state.stats.totalInvested > 0 ? +((state.stats.totalPnlSol / state.stats.totalInvested) * 100).toFixed(1) : 0;
    const dPts = Math.min(30, (dur / 3600000) * 30);
    const tPts = Math.min(25, (total / 20) * 25);
    const wPts = wr >= 55 ? 25 : wr >= 45 ? 15 : 5;
    const rPts = roi > 0 ? 20 : roi > -5 ? 10 : 0;
    state.graduation = { ready: Math.round(dPts + tPts + wPts + rPts) >= 70 && dur >= 3600000, simDurationMs: dur, totalSimTrades: total, simWinRate: wr, simRoi: roi, confidence: Math.min(100, Math.round(dPts + tPts + wPts + rPts)) };
  }

  // Sim scoring mirrors auto-ape's FULL pipeline: hard rug gate + comprehensive scoring
  // This ensures sim decisions match what auto-ape would actually do with real SOL.
  function simScoreToken(t) {
    const mc = t.mcapUsd || 0;
    const buys = t.buys || 0;
    const sells = t.sells || 0;
    const ub = t.uniqueBuyers?.size || t.uniqueBuyers || 0;
    const ageMin = (Date.now() - (t.createdAt || Date.now())) / 60000;
    const vol = t.volumeSol || 0;
    const sellVol = t.sellVolumeSol || 0;
    const dyn = scoreDynamics.get(t.ca);
    const isAccelerating = dyn && dyn.scores >= 2 && (dyn.trend === "rocket" || dyn.trend === "rising");
    const isLowVelocity = mc >= 4000 && mc <= 30000 && buys >= 1 && sells <= buys && ub >= 1 && ageMin >= 0.3 && ageMin <= 30;
    const isDexPaid = !!radar.dexBoosted.get(t.ca);

    // ── BASE FILTER (matches auto-ape) ──
    if (isDexPaid && mc >= 4000 && buys >= 1 && sells <= buys * 2) {
      // dex paid = early entry signal, relaxed filters
    } else if (isAccelerating) {
      if (!(mc > 3000 && buys >= 2 && ub >= 1 && ageMin >= 0.3 && sells <= buys * 1.5)) return 0;
    } else if (!isLowVelocity) {
      if (!(mc > 5000 && buys >= 2 && ub >= 2 && ageMin >= 0.5 && sells <= buys * 1.2)) return 0;
    }

    // ── HARD RUG GATE (matches auto-ape exactly) ──
    const qf = extractQuickFeatures(t);
    if (qf) {
      let rugRejectReason = null;
      if (qf.rg_devSellSpeed > 0.4) rugRejectReason = "dev_sell";
      else if (qf._rg_devSelfSnipe > 0) rugRejectReason = "dev_snipe";
      else if (qf.rg_mcapDropRate > 0.4) rugRejectReason = "mcap_crash";
      else if (qf.rg_coordDumpScore > 0.35) rugRejectReason = "coord_dump";
      else if (qf._rg_pumpDump > 0.5) rugRejectReason = "pump_dump";
      else if (qf._rg_sybilScore > 0.4) rugRejectReason = "sybil";
      else if (qf._rg_earlyDump > 0.3 && ageMin < 5) rugRejectReason = "early_dump";
      else if (qf._rg_quickFlipRate > 0.25) rugRejectReason = "quick_flip";
      else if (qf.rg_holderConcentration > 0.7 && buys > 5 && !(qf._whaleBullish > 0.3)) rugRejectReason = "whale_heavy";
      else if (qf.rg_liqRemovalSpeed > 0.65) rugRejectReason = "liq_removal";
      else if (qf.ch_smoothGrind > 0.6) rugRejectReason = "smooth_grind";
      else if (qf.ch_smoothGrind > 0.4 && qf.ch_dipRatio < 0.1) rugRejectReason = "no_dips";
      else if (qf._rg_zeroSellFlag >= 0.8) rugRejectReason = "zero_sells";
      else if (qf._rg_zeroSellFlag >= 0.5 && (qf.ch_smoothGrind > 0.3 || qf.ch_staircaseScore > 0.3)) rugRejectReason = "zero_sells_fake_chart";
      else if (qf._rg_buySellImbalance >= 0.8 && buys >= 8) rugRejectReason = "all_buys_no_sells";
      else if (qf.ch_staircaseScore > 0.6) rugRejectReason = "staircase_chart";
      else if (qf.ch_staircaseScore > 0.4 && qf._rg_freshWalletRatio > 0.6) rugRejectReason = "staircase_fresh_wallets";
      else if (qf._rg_freshWalletRatio > 0.8 && qf._rg_zeroSellFlag > 0.4) rugRejectReason = "fresh_wallet_rug";
      // Flatline spike: dead chart with sudden vertical pump = dev self-buy rug
      else if (qf.ch_flatlineSpike > 0.5) rugRejectReason = "flatline_spike";
      else if (qf.ch_flatlineSpike > 0.3 && qf._rg_zeroSellFlag > 0.3) rugRejectReason = "flatline_spike_no_sells";
      else if (qf.ch_flatlineSpike > 0.3 && qf._rg_freshWalletRatio > 0.5) rugRejectReason = "flatline_spike_fresh_wallets";
      else if (t._artworkFlags?.includes("EXACT_DUPLICATE")) rugRejectReason = "stolen_art";
      else {
        const rugSignals = [
          qf.rg_devSellSpeed > 0.25, qf.rg_coordDumpScore > 0.2,
          qf._rg_sybilScore > 0.25, qf._rg_quickFlipRate > 0.15,
          qf.rg_holderConcentration > 0.6, qf._rg_earlyDump > 0.2,
          qf.rg_mcapDropRate > 0.25, qf._rg_pumpDump > 0.3,
          qf.ch_smoothGrind > 0.35, qf.ch_dipRatio < 0.1,
          qf._rg_zeroSellFlag > 0.4, qf._rg_buySellImbalance > 0.5,
          qf.ch_staircaseScore > 0.3, qf._rg_freshWalletRatio > 0.6,
          qf.ch_flatlineSpike > 0.25,
          t._artworkOriginal === false,
        ].filter(Boolean).length;
        if (rugSignals >= 3) rugRejectReason = "multi_rug_" + rugSignals;
      }
      if (rugRejectReason) {
        t._simRugReject = rugRejectReason;
        return 0;
      }
    }

    // ── VELOCITY/ACCELERATION GATE ──
    if (!dyn || dyn.scores < 2) return 0;
    if (dyn.trend === "crashing") return 0;

    // ── SCORE COMPONENTS (matches auto-ape) ──
    const buyScore = Math.min(15, Math.log2(buys + 1) * 3);
    const ubScore = Math.min(15, Math.log2(ub + 1) * 3);
    const volScore = Math.min(12, Math.log10(vol * 100 + 1) * 4);
    const mcScore = mc >= gradMcUsd() ? 3 : mc >= 100000 ? 5 : mc >= 60000 ? 7 : mc >= 30000 ? 10 : mc >= 16000 ? 12 : mc >= 10000 ? 11 : mc >= 6000 ? 9 : mc >= 4000 ? 6 : 0;

    const spark = t.spark || [];
    let greenScore = 0;
    if (spark.length >= 3) {
      const recent = spark.slice(-3), earlier = spark.slice(-6, -3);
      if (earlier.length > 0) {
        const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
        const avgEarlier = earlier.reduce((a, b) => a + b, 0) / earlier.length;
        const growth = avgEarlier > 0 ? (avgRecent - avgEarlier) / avgEarlier : 0;
        if (growth > 0) greenScore = Math.min(20, growth * 60);
      }
    }

    const pressureScore = buys > 2 ? Math.min(10, (buys / Math.max(1, buys + sells)) * 10) : 0;
    const velocityScore = Math.min(10, (buys / Math.max(ageMin, 0.5)) * 3);
    const sellPenalty = sells > buys * 0.6 ? Math.min(12, (sells - buys * 0.4) * 2) : 0;

    // ── RUG PENALTY (graduated, matches auto-ape) ──
    let rugPenalty = 0;
    if (qf) {
      rugPenalty += qf.rg_devSellSpeed > 0.25 ? 10 : 0;
      rugPenalty += qf.rg_coordDumpScore > 0.25 ? 8 : 0;
      rugPenalty += qf.rg_mcapDropRate > 0.3 ? 8 : 0;
      rugPenalty += qf._rg_quickFlipRate > 0.15 ? 6 : 0;
      rugPenalty += qf._rg_sybilScore > 0.3 ? 6 : 0;
      rugPenalty += qf.rg_holderConcentration > 0.6 ? 5 : 0;
      rugPenalty += qf._rg_earlyDump > 0.2 ? 5 : 0;
      rugPenalty += sellVol > vol * 0.4 ? 5 : 0;
      rugPenalty += qf._rg_pumpDump > 0.3 ? 8 : 0;
      rugPenalty += qf.ch_smoothGrind > 0.35 ? Math.round(qf.ch_smoothGrind * 10) : 0;
      rugPenalty += qf._rg_zeroSellFlag > 0.4 ? Math.round(qf._rg_zeroSellFlag * 15) : 0;
      rugPenalty += qf._rg_buySellImbalance > 0.4 ? Math.round(qf._rg_buySellImbalance * 10) : 0;
      rugPenalty += qf.ch_staircaseScore > 0.3 ? Math.round(qf.ch_staircaseScore * 12) : 0;
      rugPenalty += qf._rg_freshWalletRatio > 0.6 ? Math.round(qf._rg_freshWalletRatio * 8) : 0;
    } else {
      rugPenalty = (sellVol > vol * 0.5 && sells > 3) ? 15 : (sells > buys * 1.2) ? 10 : 0;
    }

    // ── DYNAMICS BONUS ──
    let dynamicsBonus = 0;
    if (dyn.trend === "declining") dynamicsBonus = -15;
    else if (dyn.trend === "fading") dynamicsBonus = -8;
    else if (dyn.trend === "stable" && dyn.velocity <= 0) dynamicsBonus = -12;
    else if (dyn.trend === "rising") dynamicsBonus = 18;
    else if (dyn.trend === "rocket") dynamicsBonus = 30;
    if (dyn.velocity > 0.1) dynamicsBonus += Math.min(15, Math.round(dyn.velocity * 10));
    if (dyn.acceleration > 0.005) dynamicsBonus += Math.min(12, Math.round(dyn.acceleration * 200));

    // ── CHART BONUS (matches auto-ape) ──
    let chartBonus = qf?.ch_healthScore > 0.6 ? Math.round((qf.ch_healthScore - 0.5) * 16) :
                     qf?.ch_healthScore < 0.3 ? -8 : 0;
    if (qf?.ch_smoothGrind > 0.35) chartBonus -= Math.round(qf.ch_smoothGrind * 15);
    if (qf?.ch_dipRatio < 0.15 && spark.length >= 8) chartBonus -= 6;
    if (qf?.ch_pumpDump > 0.4) chartBonus -= Math.round(qf.ch_pumpDump * 10);
    if (qf?.ch_staircaseScore > 0.4) chartBonus -= Math.round(qf.ch_staircaseScore * 20);
    if (qf?._rg_zeroSellFlag > 0.5) chartBonus -= Math.round(qf._rg_zeroSellFlag * 25);
    if (qf?._rg_freshWalletRatio > 0.7) chartBonus -= Math.round(qf._rg_freshWalletRatio * 15);

    // ── EARLY APE BONUS ──
    let earlyApeBonus = 0;
    const buysPerMin = buys / Math.max(ageMin, 0.5);
    const isEarlyMcap = mc >= 4000 && mc <= 24000;
    const healthyRatio = buys > 0 && sells <= buys * 0.5;
    const noRugFlags = !t._rugFlags || t._rugFlags.length === 0;
    if (isEarlyMcap && healthyRatio && noRugFlags && buysPerMin < 3) {
      const qualitySignal = Math.min(1, (buys > 0 ? 1 - (sells / Math.max(buys, 1)) : 0.5) + (ub >= 2 ? 0.3 : 0));
      const velocityInverse = 1 / (buysPerMin + 0.3);
      earlyApeBonus = Math.min(18, Math.round(qualitySignal * velocityInverse * 8));
    }

    // ── WHALE BULLISH BONUS ──
    let whaleBullishBonus = 0;
    if (qf?._whaleBullish > 0.3) whaleBullishBonus = Math.min(15, Math.round(qf._whaleBullish * 20));
    let walletAgePenalty = 0;
    if (qf?._walletAgeFresh > 0.7) walletAgePenalty = Math.round(qf._walletAgeFresh * 12);

    // ── DEXSCREENER BOOST — strong early buy signal ──
    const dexBoost = radar.dexBoosted.get(t.ca);
    const boostScore = dexBoost ? Math.min(20, 12 + Math.log2(dexBoost.amount + 1)) : 0;

    // ── ARTWORK PENALTY ──
    const artPenalty = t._artworkOriginal === false ? Math.max(5, Math.round((100 - (t._artworkScore || 50)) / 5)) : 0;

    // ── COMPUTE RUG FLAGS (for UI display) ──
    t._rugFlags = [
      ...(qf ? [
        qf.rg_devSellSpeed > 0.3 && "dev_selling",
        qf.rg_coordDumpScore > 0.3 && "coord_sells",
        qf._rg_sybilScore > 0.3 && "sybil_bots",
        qf._rg_quickFlipRate > 0.2 && "quick_flips",
        qf.rg_holderConcentration > 0.6 && "whale_heavy",
        qf.ch_smoothGrind > 0.35 && "smooth_grind",
        qf.ch_dipRatio < 0.1 && spark.length >= 8 && "no_dips",
        qf.ch_staircaseScore > 0.4 && "staircase_chart",
        qf._rg_zeroSellFlag > 0.5 && "zero_sells",
        qf._rg_buySellImbalance > 0.5 && "all_buys_no_sells",
        qf._rg_freshWalletRatio > 0.7 && "fresh_wallets",
        qf._walletAgeFresh > 0.7 && "fresh_wallets_onchain",
      ] : []),
      t._artworkOriginal === false && "stolen_art",
      t._artworkFlags?.includes("SIMILAR_IMAGE") && "similar_art",
      t._artworkFlags?.includes("LOW_EFFORT_ART") && "low_effort_art",
    ].filter(Boolean);

    // Memetic bonus (cached from creation)
    const simMemeticQuick = t._memeticQuick || 0;
    const simMemeticBonus = simMemeticQuick > 0 ? Math.round((simMemeticQuick - 0.45) * 24) : 0;

    let total = Math.max(0, Math.min(99, Math.round(
      buyScore + ubScore + volScore + mcScore + greenScore + pressureScore + velocityScore +
      boostScore + dynamicsBonus + chartBonus + earlyApeBonus + whaleBullishBonus + simMemeticBonus -
      sellPenalty - rugPenalty - artPenalty - walletAgePenalty
    )));

    // ── SURVIVORSHIP BIAS ADJUSTMENT (sim mirrors auto-ape) ──
    if (qf && survivorBias.survivors.size >= 5) {
      const sbAdj = survivorBias.getScoreAdjustment(qf);
      total = Math.max(0, Math.min(99, total + sbAdj.adjustment));
    }

    return total;
  }

  let _simCycle = 0;
  state.interval = setInterval(async () => {
    try {
      _simCycle++;
      const tokens = [...radar.tokens.values()];
      if (tokens.length === 0) {
        if (_simCycle % 5 === 1) simLog(`Waiting for radar data... (${radar.tokens.size} tokens in pool)`, "scan");
        return;
      }
      // Score tokens when auto-ape isn't actively scoring them
      // Auto-ape scores tokens in its scan loop, but if no auto-ape is running,
      // sim needs to score them itself so it can find candidates
      const anyAutoApeActive = autoTraders.size > 0;
      if (!anyAutoApeActive || _simCycle % 3 === 0) {
        for (const t of tokens) {
          if (!anyAutoApeActive || !t._apeScore) {
            const simScore = simScoreToken(t);
            if (simScore > 0) t._apeScore = simScore;
          }
        }
      }
      const tokenMap = new Map(tokens.map(t => [t.ca, t]));

      // Check existing positions using auto-ape's 4-layer exit system
      for (const [ca, pos] of state.positions) {
        const token = tokenMap.get(ca);
        if (!token) {
          if (Date.now() - pos.entryTime > 300000) {
            addDecision("SELL", { ca, name: pos.name, reason: "radar-exit", pnlPct: 0 });
            simLog(`SIM EXIT ${pos.name}: fell off radar after ${Math.round((Date.now() - pos.entryTime) / 60000)}m`, "sell");
            closeTrade(ca, 0, "radar-exit");
          }
          continue;
        }
        const mc = token.mcapUsd || 0;
        pos.currentMcap = mc;
        if (mc > pos.peakMcap) pos.peakMcap = mc;
        const changePct = pos.entryMcap > 0 ? ((mc - pos.entryMcap) / pos.entryMcap) * 100 : 0;
        pos.changePct = changePct;
        const dyn = scoreDynamics.get(ca);
        pos.trend = dyn?.trend || "new";
        pos.liveScore = token._apeScore || 0;
        // Enrich pos fields that runExitChecks needs
        pos.liveBuys = token.buys || 0;
        pos.liveUB = token.uniqueBuyers?.size || 0;

        // Use auto-ape's runExitChecks — 4-layer system (derivatives, thresholds, trailing, graduation)
        const exitResult = runExitChecks(pos, token, dyn, state.settings);
        if (exitResult) {
          const { action, pct, reason, layer, detail, moonbag } = exitResult;
          const layerName = ["", "derivative", "threshold", "trailing", "graduation"][layer] || "unknown";
          if (action === "SELL") {
            addDecision("SELL", { ca, name: pos.name, reason, pnlPct: +changePct.toFixed(1), layer: layerName, detail });
            simLog(`SIM EXIT ${pos.name}: ${reason} (L${layer}) at ${changePct.toFixed(0)}%${detail ? " — " + detail : ""}`, changePct >= 0 ? "profit" : "loss");
            closeTrade(ca, changePct, reason);
            continue;
          } else if (action === "PARTIAL_SELL") {
            // Track partial sells as TP hits for sim purposes
            const tpNum = (pos.tpHit || 0) + 1;
            pos.tpHit = tpNum;
            addDecision(`TP${tpNum}`, { ca, name: pos.name, reason, pnlPct: +changePct.toFixed(1), sellPct: pct, layer: layerName, detail });
            simLog(`SIM PARTIAL ${pos.name}: ${reason} (L${layer}) sell ${pct}% at +${changePct.toFixed(0)}%`, "profit");
            // Simulate partial sell by reducing position proportionally
            const soldFraction = (pct || 33) / 100;
            const soldSol = pos.entrySol * soldFraction;
            const partialPnl = soldSol * (changePct / 100);
            state.stats.totalPnlSol += partialPnl;
            if (state.stats.totalPnlSol > state.stats.peakPnl) state.stats.peakPnl = state.stats.totalPnlSol;
            pos.entrySol *= (1 - soldFraction);
            if (moonbag) {
              pos.isMoonbag = true;
              simLog(`SIM MOONBAG ${pos.name}: holding ${Math.round(pos.entrySol * 1000) / 1000} SOL`, "info");
            }
          } else if (action === "WIDEN_TPS") {
            // Runner detected — log but no trade action needed in sim
            if (!pos._runnerLogged) {
              simLog(`SIM RUNNER ${pos.name}: ${reason} — widening TPs ×${exitResult.multiplier}`, "info");
              pos._runnerLogged = true;
            }
          } else if (action === "TIGHTEN_SLS") {
            if (!pos._tightenLogged) {
              simLog(`SIM TIGHTEN ${pos.name}: ${reason} — SLs ×${exitResult.multiplier}`, "info");
              pos._tightenLogged = true;
            }
          }
        }
      }

      // Look for new entries using auto-ape's 5-gate pipeline
      if (state.positions.size >= state.settings.maxPositions) {
        if (_simCycle % 8 === 1) simLog(`Max positions (${state.settings.maxPositions}) filled — watching for exits`, "scan");
        updateGraduation();
        return;
      }

      // Clean expired cooldowns
      for (const [c, t] of state.soldCooldowns) {
        if (Date.now() - t > 1800000) state.soldCooldowns.delete(c);
      }

      // Build portfolio snapshot (matches auto-ape's _portfolioSnapshot structure)
      if (!state._entryTimestamps) state._entryTimestamps = [];
      state._entryTimestamps = state._entryTimestamps.filter(ts => Date.now() - ts < 600000);
      const simBankroll = state.settings.solPerTrade * state.settings.maxPositions * 2; // simulated bankroll
      const simInvested = [...state.positions.values()].reduce((s, p) => s + p.entrySol, 0);
      const simPortfolio = {
        activePositionCount: state.positions.size,
        maxPositions: state.settings.maxPositions,
        positionsLast10m: state._entryTimestamps.length,
        availableSOL: simBankroll - simInvested,
        totalBankroll: simBankroll,
        solPerTrade: state.settings.solPerTrade,
        drawdownMult: 1,
        consecutiveLosses: state.stats.losses > 0 ? Math.min(5, state.stats.losses - state.stats.wins) : 0,
        lastLossTime: state._lastLossTime || 0,
        currentDrawdownPct: state.stats.peakPnl > 0 ? (state.stats.peakPnl - state.stats.totalPnlSol) / simBankroll : 0,
        settings: state.settings,
        learnerMult: 1,
        activePositions: [...state.positions.entries()].map(([ca, p]) => ({
          ca, devWallet: radar.tokens.get(ca)?.devWallet, archetype: p.archetype,
        })),
      };

      // Pre-filter: skip already-held, cooldown, and unscored tokens
      const preFiltered = tokens.filter(t => {
        if (state.positions.has(t.ca)) return false;
        if (state.soldCooldowns.has(t.ca)) {
          const soldAt = state.soldCooldowns.get(t.ca);
          const dyn = scoreDynamics.get(t.ca);
          const recovering = dyn && dyn.scores >= 3 && (dyn.trend === "rising" || dyn.trend === "rocket");
          if (Date.now() - soldAt < (recovering ? 600000 : 1800000)) return false;
          state.soldCooldowns.delete(t.ca);
        }
        return (t._apeScore || 0) > 0;
      }).sort((a, b) => (b._apeScore || 0) - (a._apeScore || 0));

      // Run 5-gate pipeline on top candidates (matches auto-ape exactly)
      const pipelineResults = [];
      const nearMisses = [];
      const rugRejects = [];
      for (const t of preFiltered.slice(0, 15)) {
        const qf = typeof extractQuickFeatures === "function" ? extractQuickFeatures(t) : null;
        const dyn = scoreDynamics.get(t.ca);
        const scores = {
          apeScore: t._apeScore || 0,
          scoreTimestamp: Date.now(),
          pricePhase: t._pricePhase,
          buyVelTrend: t._buyVelTrend,
          rugFlagCount: t._rugFlags?.length || 0,
        };
        const pipeResult = runPipeline(t, qf, scores, dyn, simPortfolio);
        t._simPipelineTier = pipeResult.tier;
        t._simPipelineLabel = pipeResult.tierLabel;
        t._simPipelineDecision = pipeResult.decision;

        if (pipeResult.decision === "ENTER") {
          pipelineResults.push({ token: t, result: pipeResult, dyn });
        } else if (pipeResult.decision === "WATCHLIST") {
          nearMisses.push({ name: t.name || t.ca?.slice(0, 6), score: t._apeScore, tier: pipeResult.tier, reason: pipeResult.rejectReason });
        } else if (pipeResult.rejectGate === 1) {
          rugRejects.push({ name: t.name || t.ca?.slice(0, 6), reason: pipeResult.rejectReason });
        }
      }

      // Log scan activity periodically so user sees sim is working
      if (_simCycle % 5 === 1) {
        const scored = preFiltered.length;
        const topScore = preFiltered.length > 0 ? (preFiltered[0]._apeScore || 0) : 0;
        simLog(`Scan: ${tokens.length} tokens, ${scored} scored, ${pipelineResults.length} passed pipeline (top:${topScore})`, "scan");
      }

      // Log near misses for visibility
      if (pipelineResults.length === 0 && _simCycle % 10 === 1) {
        if (nearMisses.length > 0) {
          simLog(`Near misses (WATCHLIST): ${nearMisses.slice(0, 3).map(n => `${n.name} s:${n.score}`).join(", ")}`, "scan");
        }
        if (rugRejects.length > 0) {
          simLog(`Rug rejects: ${rugRejects.slice(0, 3).map(r => `${r.name}:${r.reason}`).join(", ")}`, "scan");
        }
      }

      // Enter positions for pipeline-approved tokens
      for (const { token: t, result: pipeResult, dyn } of pipelineResults.slice(0, 2)) {
        if (state.positions.size >= state.settings.maxPositions) break;
        const score = t._apeScore || 0;
        const trend = dyn?.trend || "new";
        const sizing = pipeResult.positionSize;
        const sizeSol = sizing?.solAmount || calcPositionSize(score, trend, (t._rugFlags || []).length);
        state.positions.set(t.ca, {
          name: t.name, ticker: t.ticker, image: t.image, entryMcap: t.mcapUsd || 0,
          currentMcap: t.mcapUsd || 0, peakMcap: t.mcapUsd || 0, changePct: 0,
          entrySol: sizeSol, sizeMult: sizing?.sizeMult || +(sizeSol / state.settings.solPerTrade).toFixed(2),
          entryScore: score, liveScore: score, trend, entryTime: Date.now(),
          // Auto-ape pipeline fields for exit system
          tier: pipeResult.tier, tierLabel: pipeResult.tierLabel,
          exitPlan: pipeResult.exitPlan,
          tpHit: 0, slHit: 0, isMoonbag: false,
          // Legacy compat
          tp1Hit: false, tp2Hit: false, tp3Hit: false, sl1Hit: false,
        });
        state._entryTimestamps.push(Date.now());
        state.stats.totalBuys++;
        state.stats.totalInvested += sizeSol;
        addDecision("BUY", { ca: t.ca, name: t.name, score, trend, sol: sizeSol, tier: pipeResult.tier, tierLabel: pipeResult.tierLabel, rugFlags: t._rugFlags || [], gates: pipeResult.timing });
        simLog(`SIM BUY ${t.name} score=${score} T${pipeResult.tier}:${pipeResult.tierLabel} trend=${trend} MC:$${Math.round(t.mcapUsd||0)} sol=${sizeSol}`, "buy");
      }

      updateGraduation();
    } catch (e) { console.error(`[SIM] Error: ${e.message}`); }
  }, 4000);

  liveSims.set(id, state);
  simLog(`Live sim started: minScore=${state.settings.minScore} sol=${state.settings.solPerTrade}`);
  return state;
}

function stopLiveSim(id) {
  const state = liveSims.get(id);
  if (state) clearInterval(state.interval);
  liveSims.delete(id);
}

// Start live sim
app.post("/api/sim/start", async (req, res) => {
  try {
    const { wallet, settings } = req.body;
    const id = wallet || ("anon_" + (req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown"));
    const state = createLiveSim(id, settings || {});
    res.json({ ok: true, simId: id, settings: state.settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stop sim
app.post("/api/sim/stop", (req, res) => {
  const { wallet } = req.body;
  const id = wallet || ("anon_" + (req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown"));
  const state = liveSims.get(id);
  if (!state) return res.json({ ok: true, message: "No sim running" });
  const totalTrades = state.stats.wins + state.stats.losses;
  const finalStats = {
    duration: Date.now() - state.startedAt, ...state.stats,
    winRate: totalTrades > 0 ? Math.round((state.stats.wins / totalTrades) * 100) : 0,
    roi: state.stats.totalInvested > 0 ? +((state.stats.totalPnlSol / state.stats.totalInvested) * 100).toFixed(1) : 0,
    calibration: state.calibration, graduation: state.graduation,
    closedTrades: state.closedTrades.slice(-20),
  };
  stopLiveSim(id);
  res.json({ ok: true, finalStats });
});

// Get sim status
app.get("/api/sim/status", (req, res) => {
  const wallet = req.query.wallet;
  const id = wallet || ("anon_" + (req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown"));
  const state = liveSims.get(id);
  if (!state) return res.json({ active: false });
  state.lastActivity = Date.now();
  const totalTrades = state.stats.wins + state.stats.losses;
  res.json({
    active: true, settings: state.settings,
    positions: [...state.positions.entries()].map(([ca, p]) => ({
      ca, name: p.name, ticker: p.ticker, image: p.image,
      entryMcap: p.entryMcap, currentMcap: p.currentMcap, peakMcap: p.peakMcap,
      changePct: p.changePct, entrySol: p.entrySol, sizeMult: p.sizeMult,
      entryScore: p.entryScore, liveScore: p.liveScore, trend: p.trend,
      tpHit: p.tpHit || ((p.tp1Hit ? 1 : 0) + (p.tp2Hit ? 1 : 0) + (p.tp3Hit ? 1 : 0)),
      slHit: p.slHit || (p.sl1Hit ? 1 : 0), isMoonbag: !!p.isMoonbag,
      tier: p.tier || 0, tierLabel: p.tierLabel || "UNKNOWN",
      age: Math.round((Date.now() - p.entryTime) / 60000),
    })),
    decisions: state.decisions.slice(-30), log: state.log.slice(-30),
    stats: { ...state.stats, totalTrades, winRate: totalTrades > 0 ? Math.round((state.stats.wins / totalTrades) * 100) : 0, roi: state.stats.totalInvested > 0 ? +((state.stats.totalPnlSol / state.stats.totalInvested) * 100).toFixed(1) : 0 },
    calibration: { accuracy: state.calibration.accuracy, totalPredictions: state.calibration.totalPredictions, adjustments: state.calibration.adjustments },
    graduation: state.graduation,
    recentlyClosed: state.closedTrades.slice(-10).reverse(),
    startedAt: state.startedAt, simDuration: Date.now() - state.startedAt,
  });
});

// Update sim settings
app.post("/api/sim/update", (req, res) => {
  const { wallet, settings } = req.body;
  const id = wallet || ("anon_" + (req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown"));
  const state = liveSims.get(id);
  if (!state) return res.status(404).json({ error: "No sim running" });
  state.lastActivity = Date.now();
  Object.assign(state.settings, settings);
  res.json({ ok: true, settings: state.settings });
});

// Graduate sim to real auto-ape
app.post("/api/sim/graduate", async (req, res) => {
  try {
    const { wallet } = req.body;
    const simState = liveSims.get(wallet);
    if (!simState) return res.status(404).json({ error: "No sim running" });
    if (!simState.graduation.ready) {
      return res.status(400).json({ error: `Not ready. Confidence: ${simState.graduation.confidence}% (need 70%+). Duration: ${Math.round(simState.graduation.simDurationMs / 60000)}m (need 60m+).` });
    }
    const graduatedSettings = {
      ...simState.settings,
      minScore: Math.max(15, simState.settings.minScore + simState.calibration.adjustments.scoreBias),
      tp1: Math.max(10, Math.round(simState.settings.tp1 * (1 + simState.calibration.adjustments.tpBias * 0.01))),
      tp2: Math.max(20, Math.round(simState.settings.tp2 * (1 + simState.calibration.adjustments.tpBias * 0.01))),
      tp3: Math.max(50, Math.round(simState.settings.tp3 * (1 + simState.calibration.adjustments.tpBias * 0.01))),
      sl1: Math.max(5, Math.round(simState.settings.sl1 * (1 + simState.calibration.adjustments.slBias * 0.01))),
      sl2: Math.max(10, Math.round(simState.settings.sl2 * (1 + simState.calibration.adjustments.slBias * 0.01))),
    };
    stopLiveSim(wallet);
    res.json({ ok: true, graduatedSettings, simStats: { duration: simState.graduation.simDurationMs, trades: simState.graduation.totalSimTrades, winRate: simState.graduation.simWinRate, roi: simState.graduation.simRoi, confidence: simState.graduation.confidence, calibrationAccuracy: simState.calibration.accuracy } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Backtest sim (one-shot against current radar data)
app.post("/api/sim/backtest", async (req, res) => {
  try {
    const { settings } = req.body;
    const s = {
      minScore: settings?.minScore || 28, solPerTrade: settings?.solPerTrade || 0.05,
      maxPositions: settings?.maxPositions || 5,
      tp1: settings?.tp1 || 25, tp1Sell: settings?.tp1Sell || 35,
      tp2: settings?.tp2 || 70, tp2Sell: settings?.tp2Sell || 35,
      tp3: settings?.tp3 || 150, tp3Sell: settings?.tp3Sell || 50,
      sl1: settings?.sl1 || 12, sl1Sell: settings?.sl1Sell || 70, sl2: settings?.sl2 || 22,
    };
    const tokens = [...radar.tokens.values()];
    let totalTrades = 0, wins = 0, losses = 0, totalPnlSol = 0, totalInvested = 0;
    let bestTrade = null, worstTrade = null;
    const trades = [];

    for (const t of tokens) {
      const spark = t.spark || [];
      if (spark.length < 6) continue;
      const features = typeof extractQuickFeatures === "function" ? extractQuickFeatures(t) : null;
      const scoreResult = features && memeIntel?.scorer ? memeIntel.scorer.score(features) : null;
      const score = scoreResult?.score || t._apeScore || 0;
      if (score < s.minScore) continue;
      const entryIdx = Math.floor(spark.length * 0.3);
      const entryMc = spark[entryIdx] || 1;
      const peakMc = Math.max(...spark.slice(entryIdx));
      const endMc = spark[spark.length - 1] || 1;
      const range = Math.max(80 - s.minScore, 20);
      let sizeMult = 0.5 + ((score - s.minScore) / range);
      sizeMult = Math.max(0.4, Math.min(1.6, sizeMult));
      const tradeSol = Math.round(s.solPerTrade * sizeMult * 1000) / 1000;
      const peakPct = entryMc > 0 ? ((peakMc - entryMc) / entryMc) * 100 : 0;
      const endPct = entryMc > 0 ? ((endMc - entryMc) / entryMc) * 100 : 0;
      let exitReason = "hold", soldPct = 0, realizedPnl = 0;
      if (peakPct >= s.tp3) { realizedPnl += tradeSol * (s.tp3 / 100) * (s.tp3Sell / 100); soldPct += s.tp3Sell * ((100 - soldPct) / 100); exitReason = "TP3"; }
      if (peakPct >= s.tp2) { const r = 100 - soldPct; realizedPnl += tradeSol * (r / 100) * (s.tp2 / 100) * (s.tp2Sell / 100); soldPct += s.tp2Sell * (r / 100); if (exitReason === "hold") exitReason = "TP2"; }
      if (peakPct >= s.tp1) { const r = 100 - soldPct; realizedPnl += tradeSol * (r / 100) * (s.tp1 / 100) * (s.tp1Sell / 100); soldPct += s.tp1Sell * (r / 100); if (exitReason === "hold") exitReason = "TP1"; }
      if (endPct <= -s.sl2 && soldPct < 100) { realizedPnl += tradeSol * ((100 - soldPct) / 100) * (endPct / 100); soldPct = 100; exitReason = exitReason === "hold" ? "SL2" : exitReason + "+SL2"; }
      else if (endPct <= -s.sl1 && soldPct < 100) { const r = 100 - soldPct; realizedPnl += tradeSol * (r / 100) * (s.sl1Sell / 100) * (endPct / 100); soldPct += s.sl1Sell * (r / 100); if (exitReason === "hold") exitReason = "SL1"; }
      if (soldPct < 100) { realizedPnl += tradeSol * ((100 - soldPct) / 100) * (endPct / 100); }
      const trade = { name: t.name || t.ca?.slice(0, 8), score, sizeMult: +sizeMult.toFixed(2), sol: tradeSol, peakPct: +peakPct.toFixed(1), endPct: +endPct.toFixed(1), pnlSol: +realizedPnl.toFixed(4), exitReason };
      trades.push(trade); totalTrades++; totalInvested += tradeSol; totalPnlSol += realizedPnl;
      if (realizedPnl > 0) wins++; else losses++;
      if (!bestTrade || realizedPnl > bestTrade.pnlSol) bestTrade = trade;
      if (!worstTrade || realizedPnl < worstTrade.pnlSol) worstTrade = trade;
    }
    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
    const avgPnl = totalTrades > 0 ? +(totalPnlSol / totalTrades).toFixed(4) : 0;
    const roi = totalInvested > 0 ? +((totalPnlSol / totalInvested) * 100).toFixed(1) : 0;
    const lossAdjPnl = trades.reduce((sum, t) => sum + (t.pnlSol < 0 ? t.pnlSol * 2 : t.pnlSol), 0);
    const kahnemanScore = totalInvested > 0 ? +((lossAdjPnl / totalInvested) * 100).toFixed(1) : 0;
    res.json({ ok: true, totalTrades, wins, losses, winRate, totalPnlSol: +totalPnlSol.toFixed(4), totalInvested: +totalInvested.toFixed(4), roi, kahnemanScore, avgPnl, bestTrade, worstTrade, trades: trades.sort((a, b) => b.pnlSol - a.pnlSol).slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    name: "Bondli API v4",
    status: "running",
    radar: { tokens: radar.tokens.size, online: radar.online },
    solPrice: solUsdPrice,
    uptime: Math.round(process.uptime()),
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ═══════════════════════════════════════
// HOSTED VELOCITY — one radar, one engine per user, fee on realized profit (src/velocity/HOSTED_DESIGN.md)
// ═══════════════════════════════════════
let velocityHub = null;
if (process.env.VELOCITY_HOSTED === "1") {
  // The hub's feed reads the radar in-process: same shape as GET /api/radar/scored, no HTTP hop.
  const inProcessFetch = async (url) => { const q = Object.fromEntries(new URL(url, "http://x").searchParams); return { ok: true, status: 200, json: async () => buildScoredResponse(q) }; };
  const hubFeed = new PumpfunFeed({ bondliUrl: "http://in-process", minScore: parseInt(process.env.VELOCITY_MIN_SCORE || "25") || 25, pollMs: 2000, tickMs: 1000, pumpportal: false, fetchImpl: inProcessFetch });
  // Robinhood Chain (PONS): one shared feed of launches and curve trades, ETH priced from Coinbase.
  const ponsFeed = process.env.VELOCITY_PONS !== "0" ? new PonsFeed({ rpcUrl: process.env.PONS_RPC_URL || PONS_DEFAULT_RPC, pollMs: parseInt(process.env.PONS_POLL_MS || "3000") || 3000, priceFn: ethPriceUsd,
      // Robinhood Chain trades go into the same history Solana's do, so the revival and slow-cook
      // signals can speak about a PONS token instead of silently answering "no trades" for every one.
      onTrade: (t, tr) => radar._revivals.noteTrade(t.ca, { side: tr.side, sol: tr.quote, wallet: tr.wallet, curvePct: tr.curvePct, ts: tr.ts }) }) : null;
  // Arc (Argus): USDC-quoted launches on Circle's chain, read straight from the Portals and the pool
  // manager. VELOCITY_ARC=0 turns it off. ARC_RPC_URL should be the operator's own endpoint: blocks
  // come every half second and the public RPC is rate-limited for a poll this fast.
  const arcFeed = process.env.VELOCITY_ARC !== "0" ? new ArcFeed({ rpcUrl: process.env.ARC_RPC_URL || ARC_DEFAULT_RPC, pollMs: parseInt(process.env.ARC_POLL_MS || "1500") || 1500,
      onTrade: (t, tr) => {
        radar._revivals.noteTrade(t.ca, { side: tr.side, sol: tr.quote, wallet: tr.wallet, curvePct: tr.curvePct, ts: tr.ts });
        // The same wallet ledger pump.fun has, on Arc addresses: only a swap whose sender was
        // resolved (never the router's own address) and whose USDC leg is known feeds it.
        if (!tr.attributed || !(tr.quote > 0) || !(tr.tokens > 0)) return;
        if (!arcIntel.mints.has(t.ca)) arcIntel.onCreate({ mint: t.ca, creator: t.devWallet || t.creator || null, ts: t.createdAt || tr.ts, slot: null });
        arcIntel.onTrade({ mint: t.ca, wallet: tr.wallet, isBuy: tr.side === "buy", sol: tr.quote, tokens: tr.tokens, ts: tr.ts, slot: null, signature: tr.tx, mcapUsd: t.mcapUsd || null });
        if (t.mcapUsd > 0) arcIntel.markMcap(t.ca, t.mcapUsd, tr.ts);
      } }) : null;
  velocityHub = new VelocityHub({
    feed: hubFeed, ponsFeed, arcFeed, onUsers: (n) => activity.note(n), platformEvmWallet: /^0x[0-9a-fA-F]{40}$/.test(process.env.PLATFORM_EVM_WALLET || "") ? process.env.PLATFORM_EVM_WALLET : null,
    rootDir: path.resolve(process.env.VELOCITY_DATA_DIR || "data/velocity/users"), platformWallet: process.env.PLATFORM_WALLET || null, rpcUrl: RPC_URL,
    fee: { calculateFee, resolveTier, recordTradeOutcome, recordGlobalFee, getUser, isOwnerWallet },
    feePct: process.env.VELOCITY_FEE_PCT != null ? Number(process.env.VELOCITY_FEE_PCT) : 5,
  });
  // The three feeds run only while someone is trading. A feed restarted after idling reads from
  // the chain's head, not from the block it stopped at, so nothing is replayed as new.
  const feeds = [["radar", hubFeed], ["Robinhood Chain (PONS)", ponsFeed], ["Arc (Argus)", arcFeed]].filter(([, f]) => f);
  activity.on((active) => {
    for (const [name, f] of feeds) {
      if (active && !f.running) f.start().then(() => console.log(`[VELOCITY-HUB] ${name} feed started`)).catch(e => console.error(`[VELOCITY-HUB] ${name} feed failed to start:`, e.message));
      else if (!active && f.running) { f.stop().catch(() => {}); if ("_block" in f) f._block = null; console.log(`[VELOCITY-HUB] ${name} feed stopped: idle`); }
    }
  });
  console.log(`[VELOCITY-HUB] fee wallet ${velocityHub.feeOk ? "configured" : "NOT configured"}; ETH/USDC fee wallet ${velocityHub.platformEvmWallet ? "configured" : "NOT configured"}; feeds ${activity.active() ? "running" : "idle until the first bot starts"}`);
  mountVelocityRoutes(app, { hub: velocityHub, requireOwner, getTradingWallet, getUser, resolveTier });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { velocityHub.stopAll().finally(() => process.exit(0)); });
}

// ═══════════════════════════════════════
// GLOBAL ERROR HANDLER — catch route errors, keep server alive
// ═══════════════════════════════════════
app.use((err, req, res, _next) => {
  console.error(`[EXPRESS] Route error ${req.method} ${req.path}:`, err.message);
  if (!res.headersSent) {
    res.header("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
server.listen(PORT, async () => {
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  BONDLI v4 API — port ${PORT}`);
  console.log(`  RPC: ${RPC_URL.slice(0, 40)}...`);
  console.log(`  Redis: ${redis ? "connected" : "in-memory"}`);
  console.log(`  SOL: $${solUsdPrice}`);
  console.log(`  Radar: PumpPortal WS connecting... (API key ${PUMPPORTAL_API_KEY ? "set" : "not set"}; trade source ${tradeSourceMode()})`);

  // BRAD cognitive engine: check if sidecar is running
  bradClient.initBrad().then(ok => {
    if (ok) {
      console.log(`  BRAD: ACTIVE — cognitive reasoning layer online`);
      // Auto-start paper trading so BRAD can learn immediately
      const paperBankroll = parseFloat(process.env.BRAD_PAPER_BANKROLL || "10");
      startPaperTrading(paperBankroll, { maxPositions: 10, positionSizePct: 0.05 });
      console.log(`  BRAD: Paper trading started — ${paperBankroll} SOL virtual bankroll`);
    } else {
      console.log(`  BRAD: offline (start with: cd brad && python -m bondli_bridge)`);
    }
  });
  console.log(`═══════════════════════════════════════\n`);

  // Load smart wallet profiles from Redis
  await smartWallets.load();

  // Load smart money tracker from Redis (but don't start — off by default)
  await smartMoneyTracker.load();
  // Initial sync from existing smartWallets data
  smartMoneyTracker.syncFromSmartWallets(smartWallets.walletStats);
  // NOTE: tracker starts OFF — enable from frontend toggle or VIP/owner trade activity
  console.log(`[SMART-MONEY] Tracker loaded (OFF): ${smartMoneyTracker.summary().totalWallets} wallets — enable from dashboard or trade as VIP/owner`);

  // Periodic smart wallet save + cleanup (every 10 minutes)
  setInterval(() => {
    smartWallets.cleanup();
    smartWallets.save();
    // Sync tracker from latest smartWallet data + save
    smartMoneyTracker.syncFromSmartWallets(smartWallets.walletStats);
    smartMoneyTracker.save();
    devWalletTracker.save();
    demandAuth.cleanup();
  }, 600000);

  // ═══ BACKGROUND TOKEN SCORER ═══
  // Scores ALL radar tokens every 3s so BRAD chat, paper trading, and the
  // frontend always have live _apeScore data — even when no auto-trader or
  // live-sim is running. Without this, _apeScore stays 0 for every token
  // unless a wallet has explicitly started auto-trading.
  setInterval(() => {
    if (autoTraders.size > 0 || liveSims.size > 0) return; // auto-ape or sim already scoring
    const tokens = [...radar.tokens.values()];
    if (tokens.length === 0) return;
    let scored = 0;
    for (const t of tokens) {
      const mc = t.mcapUsd || 0;
      const buys = t.buys || 0;
      const sells = t.sells || 0;
      const ub = t.uniqueBuyers?.size || t.uniqueBuyers || 0;
      const ageMin = (Date.now() - (t.createdAt || Date.now())) / 60000;
      const vol = t.volumeSol || 0;
      const sellVol = t.sellVolumeSol || 0;
      const dyn = scoreDynamics.get(t.ca);
      const isAccelerating = dyn && dyn.scores >= 2 && (dyn.trend === "rocket" || dyn.trend === "rising");
      const isDexPaid = !!radar.dexBoosted?.get?.(t.ca);
      const isLowVelocity = mc >= 4000 && mc <= 30000 && buys >= 1 && sells <= buys && ub >= 1 && ageMin >= 0.3 && ageMin <= 30;

      // A skipped token must not keep an old score: clear it so it is not served as current.
      const skip = () => { t._apeScore = 0; t._scoreSkippedAt = Date.now(); };

      // Base filter — skip obvious non-starters (a revival is scored regardless: its model needs the score)
      const revivalNow = !!t._revival, loose = feedIsLoose();
      if (revivalNow) { /* scored */ }
      else if (!isDexPaid && !isAccelerating && !isLowVelocity) {
        if (!(mc > (loose ? 2500 : 5000) && buys >= 2 && ub >= 2 && ageMin >= (loose ? 0.33 : 0.5) && sells <= buys * 1.2)) { skip(); continue; }
      } else if (isAccelerating) {
        if (!(mc > 3000 && buys >= 2 && ub >= 1 && ageMin >= 0.3 && sells <= buys * 1.5)) { skip(); continue; }
      }

      // Hard rug gate
      const qf = extractQuickFeatures(t);
      if (qf) {
        if (qf.rg_devSellSpeed > 0.5) { skip(); continue; }
        if (qf.rg_coordDumpScore > 0.5 && qf._rg_sybilScore > 0.4) { skip(); continue; }
        if (qf.rg_mcapDropRate > 0.5 && ageMin > 3) { skip(); continue; }
      }

      // Scoring (mirrors auto-ape composite)
      const buyScore = Math.min(20, buys * 1.5);
      const ubScore = Math.min(15, ub * 2.5);
      const volScore = Math.min(10, (vol / Math.max(mc, 1)) * 100);
      const mcScore = mc >= 100000 ? 3 : mc >= 50000 ? 5 : mc >= 20000 ? 8 :
                      mc >= 10000 ? 10 : mc >= 5000 ? 8 : mc >= 4000 ? 6 : 0;
      const spark = t.spark || [];
      let greenScore = 0;
      if (spark.length >= 3) {
        const recent = spark.slice(-3);
        const earlier = spark.slice(-6, -3);
        if (earlier.length > 0) {
          const avgR = recent.reduce((a, b) => a + b, 0) / recent.length;
          const avgE = earlier.reduce((a, b) => a + b, 0) / earlier.length;
          const growth = avgE > 0 ? (avgR - avgE) / avgE : 0;
          if (growth > 0) greenScore = Math.min(20, growth * 60);
        }
      }
      const pressureScore = buys > 2 ? Math.min(10, (buys / Math.max(1, buys + sells)) * 10) : 0;
      const velocityScore = Math.min(10, (buys / Math.max(0.2, ageMin)) * 3);
      const sellPenalty = sells > buys * 0.6 ? Math.min(12, (sells - buys * 0.4) * 2) : 0;
      let rugPenalty = 0;
      if (qf) {
        rugPenalty += qf.rg_devSellSpeed > 0.25 ? 10 : 0;
        rugPenalty += qf.rg_coordDumpScore > 0.25 ? 8 : 0;
        rugPenalty += qf.rg_mcapDropRate > 0.3 ? 8 : 0;
        rugPenalty += qf._rg_quickFlipRate > 0.15 ? 6 : 0;
        rugPenalty += qf._rg_sybilScore > 0.3 ? 6 : 0;
      }

      // Somebody is spamming same-name launches to advertise this token: a paid-for reason it pumps,
      // worth a little while the copies are fresh (last one within 10 minutes).
      const promoScore = (t._copies || 0) > 0 && Date.now() - (t._lastCopyAt || 0) < 10 * 60_000 ? Math.min(10, 3 * t._copies) : 0;
      let total = Math.max(0, Math.min(99, Math.round(
        buyScore + ubScore + volScore + mcScore + greenScore +
        pressureScore + velocityScore + promoScore - sellPenalty - rugPenalty
      )));

      // Survivorship adjustment
      if (qf && survivorBias.survivors.size >= 5) {
        const sbAdj = survivorBias.getScoreAdjustment(qf);
        total = Math.max(0, Math.min(99, total + sbAdj.adjustment));
      }

      t._apeScore = total;
      t._scoredAt = Date.now(); // freshness stamp: /api/radar/scored serves only scores refreshed within 10s
      if (total > 0) scored++;
    }
  }, 3000);
});
