/**
 * ═══════════════════════════════════════════════════════════════
 * SMART MONEY TRACKER — Follow Profitable Wallets, Find Tokens Early
 * ═══════════════════════════════════════════════════════════════
 *
 * The gap: the existing smartWallets system only tracks wallets it
 * happens to see on tokens already on radar. It never asks:
 *   "What is wallet X buying RIGHT NOW?"
 *
 * This engine closes that loop:
 *   1. LEADERBOARD: ranks wallets by win rate, avg return, consistency
 *   2. WATCHLIST: monitors top wallets via RPC for new buys
 *   3. SIGNALS: emits "smart money alert" when a tracked wallet apes
 *      into a token we haven't seen yet — BEFORE the radar picks it up
 *   4. COPY SCORING: feeds signals into the scoring pipeline so tokens
 *      with smart money get a massive boost
 *
 * Data flow:
 *   smartWallets (existing) → feeds wallet stats into leaderboard
 *   RPC tx polling → detects new buys from top wallets
 *   Signal emitted → token gets fast-tracked onto radar with boost
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { Connection, PublicKey } from "@solana/web3.js";
import CONFIG from "./config.mjs";

// pump.fun program ID
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export class SmartMoneyTracker {
  constructor({ redis = null, onSignal = null } = {}) {
    this.redis = redis;
    this.rpcEnabled = !!CONFIG.ALCHEMY_API_KEY;
    this.connection = new Connection(CONFIG.RPC_URL, "confirmed");
    this.onSignal = onSignal; // callback: (signal) => {} — emits to radar/scoring

    // ── Wallet leaderboard ──
    // fullAddress → { prefix, wins, losses, totalReturn, score, avgReturn,
    //                 winRate, consistency, lastSeen, recentTokens: [{ca, time, graduated}],
    //                 tracked: bool, tier: "s"|"a"|"b"|"c",
    //                 solBalance: number|null, balanceUpdated: number,
    //                 category: "whale"|"sniper"|"accumulator"|"mixed"|null }
    this.wallets = new Map();

    // ── Active watch list (top wallets we poll) ──
    this.watchlist = new Set(); // full addresses
    this.MAX_WATCH = 50;       // max wallets to actively poll

    // ── Signal dedup ──
    // ca → { time, wallets: Set, signalCount, cachedScore }
    this.recentSignals = new Map();
    this.SIGNAL_DEDUP_MS = 300000; // 5 min dedup window

    // ── Polling state ──
    this.pollInterval = null;
    this.POLL_INTERVAL_MS = 30000; // poll every 30s (was 15s — halves RPC cost)
    this.lastPollSignatures = new Map(); // wallet → last seen signature
    this._analyzedTxs = new Set(); // cache of already-analyzed tx signatures
    this._pollCycle = 0; // cycle counter for adaptive polling

    // ── Manual watch (user-added wallets) ──
    this.manualWatch = new Set();

    // ── Enabled state (off by default — toggled from frontend or VIP/owner activity) ──
    this.enabled = false;
    this._autoDisableTimer = null;
    this.AUTO_DISABLE_MS = 30 * 60 * 1000; // 30 min inactivity → auto-disable

    // ── Stats ──
    this.stats = {
      totalSignals: 0,
      signalsToday: 0,
      lastSignalTime: 0,
      pollCount: 0,
      pollErrors: 0,
    };
  }

  // ═══════════════════════════════════════
  // ENABLE / DISABLE — Controls whether tracker is active
  // ═══════════════════════════════════════

  enable(reason = "manual") {
    if (this.enabled) {
      this._resetAutoDisable();
      return;
    }
    this.enabled = true;
    console.log(`[SMART-MONEY] Enabled (reason: ${reason})`);
    this.start();
    this._resetAutoDisable();
  }

  disable(reason = "manual") {
    if (!this.enabled) return;
    this.enabled = false;
    console.log(`[SMART-MONEY] Disabled (reason: ${reason})`);
    this.stop();
    if (this._autoDisableTimer) {
      clearTimeout(this._autoDisableTimer);
      this._autoDisableTimer = null;
    }
  }

  /**
   * Called when VIP/owner trades — keeps tracker alive, auto-disables after inactivity.
   */
  touchActivity() {
    if (!this.enabled) {
      this.enable("vip_owner_activity");
    }
    this._resetAutoDisable();
  }

  _resetAutoDisable() {
    if (this._autoDisableTimer) clearTimeout(this._autoDisableTimer);
    this._autoDisableTimer = setTimeout(() => {
      console.log("[SMART-MONEY] Auto-disabling after inactivity");
      this.disable("inactivity_timeout");
    }, this.AUTO_DISABLE_MS);
  }

  // ═══════════════════════════════════════
  // INGEST — Feed from existing smartWallets system
  // ═══════════════════════════════════════

  /**
   * Import wallet stats from the existing smartWallets Map.
   * Called periodically (e.g., every 60s) to sync.
   * @param {Map} walletStats - from smartWallets.walletStats (prefix → stats)
   * @param {Map} fullAddressMap - optional: prefix → full address (built from trade history)
   */
  syncFromSmartWallets(walletStats, fullAddressMap = null) {
    for (const [prefix, stats] of walletStats) {
      const totalTrades = stats.wins + stats.losses;
      if (totalTrades < 2) continue; // need some history

      const winRate = totalTrades > 0 ? stats.wins / totalTrades : 0;
      const avgReturn = totalTrades > 0 ? stats.totalReturn / totalTrades : 0;

      // Try to find full address
      const fullAddr = fullAddressMap?.get(prefix) || null;
      const key = fullAddr || prefix;

      let wallet = this.wallets.get(key);
      if (!wallet) {
        wallet = {
          prefix,
          fullAddress: fullAddr,
          wins: 0,
          losses: 0,
          totalReturn: 0,
          score: 0,
          avgReturn: 0,
          winRate: 0,
          consistency: 0,
          lastSeen: 0,
          recentTokens: [],
          tracked: false,
          tier: "c",
          solBalance: null,
          balanceUpdated: 0,
          category: null,
        };
        this.wallets.set(key, wallet);
      }

      // Update stats
      wallet.wins = stats.wins;
      wallet.losses = stats.losses;
      wallet.totalReturn = stats.totalReturn;
      wallet.winRate = winRate;
      wallet.avgReturn = avgReturn;
      wallet.lastSeen = stats.lastSeen;

      // Score: composite of win rate, consistency, and returns
      // Win rate (40%) + avg return (30%) + consistency (30%)
      const consistencyScore = totalTrades >= 5 ? Math.min(1, winRate * 1.2) : winRate * 0.5;
      wallet.consistency = consistencyScore;
      wallet.score = Math.min(1, Math.max(0,
        winRate * 0.40 +
        Math.min(0.30, avgReturn * 0.05) +
        consistencyScore * 0.30
      ));

      // Tier assignment
      if (wallet.score >= 0.7 && totalTrades >= 5) wallet.tier = "s";
      else if (wallet.score >= 0.5 && totalTrades >= 4) wallet.tier = "a";
      else if (wallet.score >= 0.35 && totalTrades >= 3) wallet.tier = "b";
      else wallet.tier = "c";
    }

    this._updateWatchlist();
  }

  /**
   * Record a trade we observed — builds full address mapping.
   * Called from processRadarMessage when we see a buy.
   */
  recordObservedTrade(fullAddress, ca, side, solAmount) {
    if (!fullAddress || fullAddress.length < 20) return;
    const prefix = fullAddress.slice(0, 8);

    let wallet = this.wallets.get(fullAddress) || this.wallets.get(prefix);
    if (wallet && !wallet.fullAddress) {
      // Upgrade prefix-only entry to full address
      if (this.wallets.has(prefix)) {
        this.wallets.delete(prefix);
      }
      wallet.fullAddress = fullAddress;
      this.wallets.set(fullAddress, wallet);
    }

    if (!wallet) {
      wallet = {
        prefix,
        fullAddress,
        wins: 0, losses: 0, totalReturn: 0,
        score: 0, avgReturn: 0, winRate: 0,
        consistency: 0, lastSeen: Date.now(),
        recentTokens: [],
        tracked: false, tier: "c",
        solBalance: null, balanceUpdated: 0, category: null,
      };
      this.wallets.set(fullAddress, wallet);
    }

    wallet.lastSeen = Date.now();

    if (side === "buy") {
      // Track recent token buys (keep last 20)
      wallet.recentTokens.push({ ca, time: Date.now(), solAmount, graduated: null });
      if (wallet.recentTokens.length > 20) wallet.recentTokens.shift();
    }
  }

  /**
   * Record outcome for a token — propagates to all wallets that bought it.
   */
  recordOutcome(ca, graduated) {
    for (const [, wallet] of this.wallets) {
      for (const token of wallet.recentTokens) {
        if (token.ca === ca && token.graduated === null) {
          token.graduated = graduated;
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // WATCHLIST — Pick top wallets to monitor
  // ═══════════════════════════════════════

  _updateWatchlist() {
    // Rank by score blended with recency — active profitable wallets first
    const now = Date.now();
    const ranked = [...this.wallets.values()]
      .filter(w => w.fullAddress && w.score >= 0.35 && (w.wins + w.losses) >= 3)
      .map(w => {
        // Recency bonus: wallets seen in last hour get up to +0.15 boost
        const hoursSince = Math.max(0, (now - (w.lastSeen || 0)) / 3600000);
        const recencyBonus = hoursSince < 1 ? 0.15 : hoursSince < 6 ? 0.08 : hoursSince < 24 ? 0.03 : 0;
        return { w, rankScore: w.score + recencyBonus };
      })
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, this.MAX_WATCH)
      .map(r => r.w);

    this.watchlist.clear();
    for (const w of ranked) {
      w.tracked = true;
      this.watchlist.add(w.fullAddress);
    }

    // Also include manually added wallets
    for (const addr of this.manualWatch) {
      this.watchlist.add(addr);
    }
  }

  /**
   * Manually add a wallet to watch (e.g., known alpha caller).
   */
  addManualWatch(address) {
    if (!address || address.length < 20) return false;
    this.manualWatch.add(address);
    this.watchlist.add(address);

    if (!this.wallets.has(address)) {
      this.wallets.set(address, {
        prefix: address.slice(0, 8),
        fullAddress: address,
        wins: 0, losses: 0, totalReturn: 0,
        score: 0.5, avgReturn: 0, winRate: 0,
        consistency: 0, lastSeen: Date.now(),
        recentTokens: [],
        tracked: true, tier: "a", // assume A-tier for manual adds
        solBalance: null, balanceUpdated: 0, category: null,
      });
    }
    // Fetch balance immediately for newly added wallet
    this._fetchBalance(address).catch(() => {});
    return true;
  }

  removeManualWatch(address) {
    this.manualWatch.delete(address);
    this._updateWatchlist();
  }

  // ═══════════════════════════════════════
  // POLLING — RPC transaction monitoring
  // ═══════════════════════════════════════

  start() {
    if (this.pollInterval) return;
    if (!this.enabled) {
      console.log("[SMART-MONEY] Not enabled — skipping start (enable from frontend or trade as VIP/owner)");
      return;
    }
    if (!this.rpcEnabled) {
      console.log("[SMART-MONEY] No Alchemy API key — polling disabled (passive mode only)");
      return;
    }
    console.log(`[SMART-MONEY] Starting wallet poll (${this.watchlist.size} wallets, ${this.POLL_INTERVAL_MS / 1000}s interval)`);
    this.pollInterval = setInterval(() => this._pollWatchlist(), this.POLL_INTERVAL_MS);
    // First poll immediately
    this._pollWatchlist();
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async _pollWatchlist() {
    if (this.watchlist.size === 0) return;
    this.stats.pollCount++;
    this._pollCycle++;

    // Adaptive polling: S/A tier every cycle, B/C every other cycle
    const addresses = [...this.watchlist].filter(addr => {
      const w = this.wallets.get(addr);
      if (!w) return true;
      if (w.tier === "s" || w.tier === "a") return true;
      return this._pollCycle % 2 === 0; // B/C every other cycle
    });

    // Batch size 10 (Alchemy handles 330+ RPS easily)
    const batchSize = 10;

    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const promises = batch.map(addr => this._pollWallet(addr).catch(() => null));
      await Promise.all(promises);

      // 200ms delay between batches
      if (i + batchSize < addresses.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Prune tx cache every 20 cycles to prevent unbounded growth
    if (this._pollCycle % 20 === 0 && this._analyzedTxs.size > 5000) {
      this._analyzedTxs.clear();
    }

    // Refresh balances every 3rd cycle (~90s at default 30s interval)
    if (this._pollCycle % 3 === 0) {
      this._refreshBalances().catch(() => {});
      this._categorizeWallets();
    }
  }

  async _pollWallet(address) {
    try {
      const pubkey = new PublicKey(address);
      const w = this.wallets.get(address);
      // S/A tier wallets get deeper sig history (5) to reduce missed buys
      const sigLimit = (w?.tier === "s" || w?.tier === "a") ? 5 : 3;
      const sigs = await this.connection.getSignaturesForAddress(pubkey, { limit: sigLimit }, "confirmed");
      if (!sigs || !sigs.length) return;

      const lastSig = this.lastPollSignatures.get(address);

      for (const sig of sigs) {
        if (sig.signature === lastSig) break;

        // Skip already-analyzed transactions
        if (this._analyzedTxs.has(sig.signature)) continue;
        this._analyzedTxs.add(sig.signature);

        // Skip failed transactions without fetching
        if (sig.err) continue;

        // Fetch full parsed transaction to detect pump.fun buys
        const tx = await this.connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx) continue;

        const isPumpBuy = this._isPumpFunBuy(tx, address);
        if (isPumpBuy) {
          this._emitSignal({
            type: "smart_money_buy",
            wallet: address,
            walletPrefix: address.slice(0, 8),
            mint: isPumpBuy.mint,
            solAmount: isPumpBuy.solAmount,
            walletTier: w?.tier || "b",
            walletScore: w?.score || 0,
            walletWinRate: w?.winRate || 0,
            walletWins: w?.wins || 0,
            timestamp: (sig.blockTime || 0) * 1000,
          });
        }
      }

      // Update last seen signature
      if (sigs[0]?.signature) {
        this.lastPollSignatures.set(address, sigs[0].signature);
      }
    } catch (e) {
      this.stats.pollErrors++;
    }
  }

  _isPumpFunBuy(tx, walletAddress) {
    if (!tx.transaction?.message?.instructions) return null;

    // Check if pump.fun program is involved
    const hasPump = tx.transaction.message.instructions.some(ix => {
      const prog = ix.programId?.toBase58?.() || "";
      return prog === PUMP_FUN_PROGRAM;
    });
    if (!hasPump) return null;

    // Analyze token balance changes to detect buy
    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    for (const post of postBalances) {
      if (!post.mint || post.mint === "So11111111111111111111111111111111111111112") continue;
      const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
      const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmount || 0);
      const postAmt = parseFloat(post.uiTokenAmount?.uiAmount || 0);

      if (postAmt > preAmt) {
        // Token received — this is a buy. Estimate SOL spent from lamport diff
        const preSol = (tx.meta?.preBalances?.[0] || 0) / 1e9;
        const postSol = (tx.meta?.postBalances?.[0] || 0) / 1e9;
        const solSpent = preSol - postSol;

        if (solSpent > 0.01) {
          return { mint: post.mint, solAmount: solSpent };
        }
      }
    }

    return null;
  }

  // ═══════════════════════════════════════
  // SIGNALS — Emit when smart wallet buys
  // ═══════════════════════════════════════

  _emitSignal(signal) {
    const { mint } = signal;
    const now = Date.now();

    // Dedup check
    let existing = this.recentSignals.get(mint);
    if (existing && now - existing.time < this.SIGNAL_DEDUP_MS) {
      existing.wallets.add(signal.wallet);
      existing.signalCount++;
      // Track temporal clustering — buys within 60s are "tight" convergence
      existing.lastBuyTime = now;
      if (!existing.firstBuyTime) existing.firstBuyTime = existing.time;
      existing.tightConvergence = (now - existing.firstBuyTime) < 60000 && existing.wallets.size >= 2;
    } else {
      existing = { time: now, firstBuyTime: now, lastBuyTime: now, wallets: new Set([signal.wallet]), signalCount: 1, tightConvergence: false, cachedScore: null };
      this.recentSignals.set(mint, existing);
    }

    signal.convergence = existing.wallets.size;
    signal.isConvergence = existing.wallets.size >= 2;
    signal.tightConvergence = existing.tightConvergence; // multiple wallets within 60s

    // Pre-compute and cache the smart money score for this token
    existing.cachedScore = null; // invalidate on new signal

    this.stats.totalSignals++;
    this.stats.signalsToday++;
    this.stats.lastSignalTime = Date.now();

    console.log(`[SMART-MONEY] Signal: ${signal.walletPrefix}... (tier:${signal.walletTier} wr:${(signal.walletWinRate * 100).toFixed(0)}%) → ${signal.mint.slice(0, 8)} | ${signal.solAmount.toFixed(3)} SOL${signal.isConvergence ? ` | CONVERGENCE (${signal.convergence} wallets)` : ""}${signal.tightConvergence ? " | TIGHT (<60s)" : ""}`);

    // Emit to callback (radar/scoring integration)
    if (this.onSignal) {
      try { this.onSignal(signal); } catch {}
    }

    // Cleanup old signals
    if (this.recentSignals.size > 500) {
      const cutoff = Date.now() - this.SIGNAL_DEDUP_MS;
      for (const [ca, s] of this.recentSignals) {
        if (s.time < cutoff) this.recentSignals.delete(ca);
      }
    }
  }

  // ═══════════════════════════════════════
  // SCORING BOOST — For the scoring pipeline
  // ═══════════════════════════════════════

  /**
   * Get smart money boost for a token.
   * Called from extractQuickFeatures or the scoring pipeline.
   * Returns 0-1 normalized score.
   */
  getSmartMoneyScore(ca) {
    const signal = this.recentSignals.get(ca);
    if (!signal) return { score: 0, walletCount: 0, topTier: null, convergence: false, tightConvergence: false };

    // Return cached score if available (invalidated on new signal)
    if (signal.cachedScore) return signal.cachedScore;

    const walletCount = signal.wallets.size;
    let topTier = "c";
    let bestScore = 0;

    for (const addr of signal.wallets) {
      const w = this.wallets.get(addr);
      if (w) {
        if (w.score > bestScore) {
          bestScore = w.score;
          topTier = w.tier;
        }
      }
    }

    // Score: wallet count * tier multiplier + tight convergence bonus
    const tierMult = { s: 1.0, a: 0.7, b: 0.4, c: 0.15 }[topTier] || 0.15;
    let rawScore = walletCount * 0.25 * tierMult + bestScore * 0.5;
    // Tight convergence (multiple wallets within 60s) gets extra boost
    if (signal.tightConvergence) rawScore += 0.15;
    rawScore = Math.min(1, rawScore);

    const result = {
      score: +rawScore.toFixed(3),
      walletCount,
      topTier,
      convergence: walletCount >= 2,
      tightConvergence: !!signal.tightConvergence,
      bestWalletScore: +bestScore.toFixed(3),
    };

    signal.cachedScore = result;
    return result;
  }

  // ═══════════════════════════════════════
  // BALANCE + CATEGORIZATION
  // ═══════════════════════════════════════

  /**
   * Fetch SOL balance for a single wallet. Cached for 5 min.
   */
  async _fetchBalance(address) {
    if (!address || address.length < 20) return;
    const wallet = this.wallets.get(address);
    if (!wallet) return;
    // Skip if fetched within last 5 min
    if (wallet.balanceUpdated && (Date.now() - wallet.balanceUpdated) < 300000) return;
    try {
      const pk = new PublicKey(address);
      const lamports = await this.connection.getBalance(pk);
      wallet.solBalance = +(lamports / 1e9).toFixed(4);
      wallet.balanceUpdated = Date.now();
    } catch (e) {
      // Silently fail — balance is optional enrichment
    }
  }

  /**
   * Batch-fetch balances for watched wallets. Called after each poll cycle.
   * Only refreshes stale balances (>5 min old). Max 10 per cycle to limit RPC.
   */
  async _refreshBalances() {
    const stale = [...this.watchlist]
      .map(addr => this.wallets.get(addr))
      .filter(w => w?.fullAddress && (!w.balanceUpdated || (Date.now() - w.balanceUpdated) > 300000))
      .slice(0, 10); // max 10 per cycle

    await Promise.allSettled(stale.map(w => this._fetchBalance(w.fullAddress)));
  }

  /**
   * Categorize wallet based on trading patterns.
   * Called after balance refresh to enrich wallet profiles.
   */
  _categorizeWallets() {
    for (const [, w] of this.wallets) {
      if ((w.wins + w.losses) < 2) continue;
      const totalTrades = w.wins + w.losses;
      const tokens = w.recentTokens || [];

      // Whale: high SOL balance (>10 SOL) or large avg position
      const avgSol = tokens.length > 0
        ? tokens.reduce((s, t) => s + (t.solAmount || 0), 0) / tokens.length
        : 0;
      const isWhale = (w.solBalance != null && w.solBalance >= 10) || avgSol >= 2;

      // Sniper: high frequency, fast trades (many tokens in short time)
      const recentTimes = tokens.slice(-10).map(t => t.time).filter(Boolean);
      const avgGap = recentTimes.length >= 2
        ? (recentTimes[recentTimes.length - 1] - recentTimes[0]) / (recentTimes.length - 1)
        : Infinity;
      const isSniper = totalTrades >= 5 && avgGap < 600000; // <10 min avg gap

      // Accumulator: steady, consistent, moderate size
      const isAccumulator = totalTrades >= 8 && w.winRate >= 0.5 && !isWhale && !isSniper;

      if (isWhale) w.category = "whale";
      else if (isSniper) w.category = "sniper";
      else if (isAccumulator) w.category = "accumulator";
      else w.category = "mixed";
    }
  }

  // ═══════════════════════════════════════
  // LEADERBOARD — Ranked wallet list
  // ═══════════════════════════════════════

  getLeaderboard(limit = 50) {
    return [...this.wallets.values()]
      .filter(w => (w.wins + w.losses) >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(w => ({
        address: w.fullAddress || w.prefix + "...",
        prefix: w.prefix,
        tier: w.tier,
        score: +w.score.toFixed(3),
        wins: w.wins,
        losses: w.losses,
        winRate: +(w.winRate * 100).toFixed(1),
        avgReturn: +w.avgReturn.toFixed(2),
        totalReturn: +w.totalReturn.toFixed(2),
        tracked: w.tracked,
        lastSeen: w.lastSeen,
        solBalance: w.solBalance,
        category: w.category,
        manual: this.manualWatch.has(w.fullAddress),
        recentTokens: w.recentTokens.slice(-5).map(t => ({
          ca: t.ca,
          time: t.time,
          graduated: t.graduated,
          solAmount: t.solAmount,
        })),
      }));
  }

  /**
   * Get recent smart money signals (for dashboard display).
   */
  getRecentSignals(limit = 20) {
    return [...this.recentSignals.entries()]
      .sort((a, b) => b[1].time - a[1].time)
      .slice(0, limit)
      .map(([ca, s]) => ({
        ca,
        time: s.time,
        walletCount: s.wallets.size,
        wallets: [...s.wallets].map(addr => {
          const w = this.wallets.get(addr);
          return {
            address: addr.slice(0, 8) + "...",
            tier: w?.tier || "c",
            winRate: +((w?.winRate || 0) * 100).toFixed(1),
            score: +(w?.score || 0).toFixed(3),
          };
        }),
        convergence: s.wallets.size >= 2,
        signalCount: s.signalCount,
      }));
  }

  // ═══════════════════════════════════════
  // PERSISTENCE — Redis save/load
  // ═══════════════════════════════════════

  async save() {
    if (!this.redis) return;
    try {
      // Save wallet data (compressed)
      const walletData = {};
      for (const [key, w] of this.wallets) {
        if ((w.wins + w.losses) < 2) continue; // skip noisy entries
        walletData[key] = {
          p: w.prefix,
          f: w.fullAddress || null,
          w: w.wins,
          l: w.losses,
          r: +w.totalReturn.toFixed(2),
          s: +w.score.toFixed(3),
          t: w.lastSeen,
          tier: w.tier,
          rt: w.recentTokens.slice(-10), // last 10 tokens
          bal: w.solBalance,
          cat: w.category,
        };
      }
      await this.redis.set("smart:money:wallets", JSON.stringify(walletData), { EX: 604800 }); // 7 days

      // Save manual watch list
      if (this.manualWatch.size > 0) {
        await this.redis.set("smart:money:manual", JSON.stringify([...this.manualWatch]), { EX: 2592000 }); // 30 days
      }

      console.log(`[SMART-MONEY] Saved ${Object.keys(walletData).length} wallets to Redis`);
    } catch (e) {
      console.error("[SMART-MONEY] Save error:", e.message);
    }
  }

  async load() {
    if (!this.redis) return;
    try {
      // Load wallets
      const raw = await this.redis.get("smart:money:wallets");
      if (raw) {
        const data = JSON.parse(raw);
        for (const [key, d] of Object.entries(data)) {
          this.wallets.set(key, {
            prefix: d.p,
            fullAddress: d.f,
            wins: d.w,
            losses: d.l,
            totalReturn: d.r,
            score: d.s,
            avgReturn: (d.w + d.l) > 0 ? d.r / (d.w + d.l) : 0,
            winRate: (d.w + d.l) > 0 ? d.w / (d.w + d.l) : 0,
            consistency: 0,
            lastSeen: d.t,
            recentTokens: d.rt || [],
            tracked: false,
            tier: d.tier || "c",
            solBalance: d.bal ?? null,
            balanceUpdated: d.bal != null ? d.t : 0,
            category: d.cat || null,
          });
        }
        console.log(`[SMART-MONEY] Loaded ${this.wallets.size} wallets from Redis`);
      }

      // Load manual watch
      const manualRaw = await this.redis.get("smart:money:manual");
      if (manualRaw) {
        const addrs = JSON.parse(manualRaw);
        for (const addr of addrs) this.manualWatch.add(addr);
        console.log(`[SMART-MONEY] Loaded ${this.manualWatch.size} manual watch wallets`);
      }

      this._updateWatchlist();
    } catch (e) {
      console.error("[SMART-MONEY] Load error:", e.message);
    }
  }

  // ═══════════════════════════════════════
  // SUMMARY — For logging/debugging
  // ═══════════════════════════════════════

  summary() {
    const tiers = { s: 0, a: 0, b: 0, c: 0 };
    for (const w of this.wallets.values()) tiers[w.tier]++;

    return {
      enabled: this.enabled,
      totalWallets: this.wallets.size,
      watching: this.watchlist.size,
      manualWatch: this.manualWatch.size,
      maxWatch: this.MAX_WATCH,
      tiers,
      recentSignals: this.recentSignals.size,
      stats: { ...this.stats },
      polling: !!this.pollInterval,
      pollIntervalMs: this.POLL_INTERVAL_MS,
      rpcEnabled: this.rpcEnabled,
    };
  }

  /**
   * Update polling interval (in seconds). Restarts polling if active.
   * Min 5s, max 300s.
   */
  setPollingInterval(seconds) {
    const s = Math.max(5, Math.min(300, Math.round(seconds)));
    this.POLL_INTERVAL_MS = s * 1000;
    console.log(`[SMART-MONEY] Polling interval set to ${s}s`);
    if (this.pollInterval) {
      this.stop();
      this.start();
    }
    return s;
  }

  /**
   * Update max wallets to track. Min 5, max 200.
   */
  setMaxWatch(n) {
    this.MAX_WATCH = Math.max(5, Math.min(200, Math.round(n)));
    console.log(`[SMART-MONEY] Max watch set to ${this.MAX_WATCH}`);
    this._updateWatchlist();
    return this.MAX_WATCH;
  }
}
