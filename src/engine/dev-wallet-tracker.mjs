/**
 * ═══════════════════════════════════════════════════════════════
 * DEV WALLET TRACKER — Map & Profile Every Token Creator
 * ═══════════════════════════════════════════════════════════════
 *
 * Core insight: devs with a lot of SOL will pump the chart.
 * A funded dev (10+ SOL) signals conviction and resources to
 * sustain buy pressure. A broke dev (< 0.5 SOL) = likely rug.
 *
 * This engine:
 *   1. REGISTRY: maps every dev wallet seen on radar
 *   2. BALANCE: fetches SOL balance + token holdings
 *   3. PROFILE: categorizes devs (whale_dev, funded_dev, broke_dev, serial_rugger)
 *   4. SCORING: provides boost/penalty for the scoring pipeline
 *   5. ALERTS: flags when a high-balance dev launches a new token
 *
 * Data flow:
 *   Token appears on radar → extract devWallet → register
 *   Background poll → fetch balances for all mapped devs
 *   Scoring pipeline → getDevScore(devWallet) → boost/penalty
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import CONFIG from "./config.mjs";

// Dev wallet tiers based on SOL balance
const DEV_TIERS = {
  WHALE_DEV:  { min: 50,  label: "whale_dev",  boost: 1.0,  color: "🐳" },
  FUNDED_DEV: { min: 10,  label: "funded_dev", boost: 0.75, color: "💰" },
  MID_DEV:    { min: 3,   label: "mid_dev",    boost: 0.4,  color: "📊" },
  LOW_DEV:    { min: 0.5, label: "low_dev",    boost: 0.1,  color: "⚠️" },
  BROKE_DEV:  { min: 0,   label: "broke_dev",  boost: -0.3, color: "🚩" },
};

export class DevWalletTracker {
  constructor({ redis = null, connection = null } = {}) {
    this.redis = redis;
    this.connection = connection || new Connection(CONFIG.RPC_URL, "confirmed");

    // ── Dev wallet registry ──
    // devWallet → {
    //   address, solBalance, lastBalanceCheck, tokens: [{ca, name, time, mcap}],
    //   tier, launchCount, avgTokenMcap, bestTokenMcap,
    //   pumpRate (% of tokens that pumped), rugRate, profiledAt
    // }
    this.devs = new Map();

    // ── Reverse lookup: CA → devWallet ──
    this.tokenToDev = new Map();

    // ── High-value dev alerts ──
    this.onHighValueDev = null; // callback: (alert) => {}

    // ── Balance poll state ──
    this.pollInterval = null;
    this.POLL_INTERVAL_MS = 60000; // check balances every 60s (was 30s — halves RPC cost)
    this.BALANCE_STALE_MS = 300000; // re-check if older than 5 min (was 2 min)
    this.MAX_BATCH_SIZE = 20; // RPC batch size for getMultipleAccountsInfo

    // ── Stats ──
    this.stats = {
      totalDevsMapped: 0,
      balanceChecks: 0,
      highValueAlerts: 0,
      avgDevBalance: 0,
    };
  }

  // ═══════════════════════════════════════
  // REGISTER — Track a new dev wallet
  // ═══════════════════════════════════════

  /**
   * Register a dev wallet from a token on radar.
   * Call this whenever a new token appears with a known devWallet.
   */
  register(devWallet, tokenData = {}) {
    if (!devWallet || devWallet.length < 20) return null;

    const { ca, name, mcap, ticker } = tokenData;

    // Register token → dev mapping
    if (ca) this.tokenToDev.set(ca, devWallet);

    let dev = this.devs.get(devWallet);
    if (!dev) {
      dev = {
        address: devWallet,
        solBalance: -1, // -1 = not yet checked
        lastBalanceCheck: 0,
        tokens: [],
        tier: "unknown",
        launchCount: 0,
        avgTokenMcap: 0,
        bestTokenMcap: 0,
        pumpRate: 0,
        rugRate: 0,
        profiledAt: 0,
        firstSeen: Date.now(),
      };
      this.devs.set(devWallet, dev);
      this.stats.totalDevsMapped++;
    }

    // Track this token under the dev
    if (ca && !dev.tokens.find(t => t.ca === ca)) {
      dev.tokens.push({
        ca,
        name: name || "",
        ticker: ticker || "",
        time: Date.now(),
        mcap: mcap || 0,
        peakMcap: mcap || 0,
        graduated: false,
        rugged: false,
      });
      dev.launchCount = dev.tokens.length;
    }

    return dev;
  }

  // ═══════════════════════════════════════
  // BALANCE CHECK — Fetch SOL balances
  // ═══════════════════════════════════════

  /**
   * Check SOL balance for a single dev wallet.
   * Returns balance in SOL.
   */
  async checkBalance(devWallet) {
    const dev = this.devs.get(devWallet);
    if (!dev) return -1;

    // Use cache if fresh
    if (dev.solBalance >= 0 && Date.now() - dev.lastBalanceCheck < this.BALANCE_STALE_MS) {
      return dev.solBalance;
    }

    try {
      const balance = await this.connection.getBalance(new PublicKey(devWallet));
      dev.solBalance = +(balance / LAMPORTS_PER_SOL).toFixed(4);
      dev.lastBalanceCheck = Date.now();
      this.stats.balanceChecks++;

      // Update tier
      this._updateTier(dev);

      // Alert if high-value dev
      if (dev.solBalance >= DEV_TIERS.FUNDED_DEV.min && dev.tokens.length <= 2) {
        this._emitHighValueAlert(dev);
      }

      return dev.solBalance;
    } catch (e) {
      console.error(`[DEV-TRACKER] Balance check failed for ${devWallet.slice(0, 8)}: ${e.message}`);
      return dev.solBalance;
    }
  }

  /**
   * Batch check balances for multiple dev wallets using getMultipleAccountsInfo.
   * Much more efficient than individual getBalance calls.
   */
  async batchCheckBalances(addresses = null) {
    const toCheck = addresses || this._getStaleAddresses();
    if (toCheck.length === 0) return;

    // Process in batches
    for (let i = 0; i < toCheck.length; i += this.MAX_BATCH_SIZE) {
      const batch = toCheck.slice(i, i + this.MAX_BATCH_SIZE);
      try {
        const pubkeys = batch.map(addr => new PublicKey(addr));
        const accounts = await this.connection.getMultipleAccountsInfo(pubkeys);

        for (let j = 0; j < batch.length; j++) {
          const dev = this.devs.get(batch[j]);
          if (!dev) continue;

          const account = accounts[j];
          dev.solBalance = account ? +(account.lamports / LAMPORTS_PER_SOL).toFixed(4) : 0;
          dev.lastBalanceCheck = Date.now();
          this._updateTier(dev);
          this.stats.balanceChecks++;

          // Alert on funded devs with few launches
          if (dev.solBalance >= DEV_TIERS.FUNDED_DEV.min && dev.tokens.length <= 2) {
            this._emitHighValueAlert(dev);
          }
        }
      } catch (e) {
        console.error(`[DEV-TRACKER] Batch balance check failed: ${e.message}`);
      }

      // Small delay between batches
      if (i + this.MAX_BATCH_SIZE < toCheck.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    this._updateStats();
  }

  /**
   * Get addresses that need a balance refresh.
   */
  _getStaleAddresses() {
    const now = Date.now();
    const stale = [];
    for (const [addr, dev] of this.devs) {
      if (now - dev.lastBalanceCheck > this.BALANCE_STALE_MS) {
        stale.push(addr);
      }
    }
    // Prioritize: unchecked first, then oldest checks
    stale.sort((a, b) => {
      const da = this.devs.get(a);
      const db = this.devs.get(b);
      if (da.solBalance < 0 && db.solBalance >= 0) return -1;
      if (db.solBalance < 0 && da.solBalance >= 0) return 1;
      return da.lastBalanceCheck - db.lastBalanceCheck;
    });
    return stale.slice(0, this.MAX_BATCH_SIZE * 3); // max 60 per cycle
  }

  // ═══════════════════════════════════════
  // TIER & SCORING — Categorize devs
  // ═══════════════════════════════════════

  _updateTier(dev) {
    const bal = dev.solBalance;
    if (bal < 0) { dev.tier = "unknown"; return; }

    if (bal >= DEV_TIERS.WHALE_DEV.min) dev.tier = DEV_TIERS.WHALE_DEV.label;
    else if (bal >= DEV_TIERS.FUNDED_DEV.min) dev.tier = DEV_TIERS.FUNDED_DEV.label;
    else if (bal >= DEV_TIERS.MID_DEV.min) dev.tier = DEV_TIERS.MID_DEV.label;
    else if (bal >= DEV_TIERS.LOW_DEV.min) dev.tier = DEV_TIERS.LOW_DEV.label;
    else dev.tier = DEV_TIERS.BROKE_DEV.label;
  }

  /**
   * Get scoring data for a token's dev wallet.
   * Called from the scoring pipeline.
   *
   * Returns:
   *   - devBalanceScore: 0-1 normalized score (higher = more SOL = bullish)
   *   - devTier: whale_dev, funded_dev, mid_dev, low_dev, broke_dev
   *   - solBalance: raw SOL balance
   *   - launchCount: how many tokens this dev has created
   *   - isSerialLauncher: launched 5+ tokens
   *   - isHighValue: funded dev with few launches (strong signal)
   *   - scoringBoost: raw point boost/penalty for ape score (-15 to +20)
   */
  getDevScore(devWalletOrCa) {
    // Accept either dev wallet address or token CA
    let devWallet = devWalletOrCa;
    if (this.tokenToDev.has(devWalletOrCa)) {
      devWallet = this.tokenToDev.get(devWalletOrCa);
    }

    const dev = this.devs.get(devWallet);
    if (!dev || dev.solBalance < 0) {
      return {
        devBalanceScore: 0.5, // neutral when unknown
        devTier: "unknown",
        solBalance: -1,
        launchCount: 0,
        isSerialLauncher: false,
        isHighValue: false,
        scoringBoost: 0,
        mapped: false,
      };
    }

    const bal = dev.solBalance;

    // Balance score: logarithmic scale, capped at 50 SOL
    // 0 SOL → 0.0, 1 SOL → 0.3, 5 SOL → 0.55, 10 SOL → 0.7, 50+ SOL → 1.0
    const devBalanceScore = bal <= 0
      ? 0
      : Math.min(1, Math.log10(1 + bal) / Math.log10(51));

    // Launch count penalty
    const isSerialLauncher = dev.launchCount >= 5;
    const launchPenalty = isSerialLauncher
      ? Math.min(0.3, (dev.launchCount - 4) * 0.05)
      : 0;

    // High-value signal: funded dev + few launches = strongest bullish indicator
    const isHighValue = bal >= DEV_TIERS.FUNDED_DEV.min && dev.launchCount <= 2;

    // Final scoring boost in ape score points
    // Whale dev (50+ SOL): up to +20 points
    // Funded dev (10+ SOL): up to +15 points
    // Mid dev (3-10 SOL): up to +8 points
    // Low dev (0.5-3 SOL): +2 points
    // Broke dev (<0.5 SOL): -10 to -15 points
    let scoringBoost = 0;
    if (bal >= 50) scoringBoost = 20;
    else if (bal >= 20) scoringBoost = 17;
    else if (bal >= 10) scoringBoost = 15;
    else if (bal >= 5) scoringBoost = 10;
    else if (bal >= 3) scoringBoost = 8;
    else if (bal >= 1) scoringBoost = 4;
    else if (bal >= 0.5) scoringBoost = 2;
    else if (bal >= 0.1) scoringBoost = -5;
    else scoringBoost = -15; // nearly empty = likely rug

    // Serial launcher penalty
    if (isSerialLauncher) scoringBoost -= Math.min(10, (dev.launchCount - 4) * 2);

    // High-value dev bonus: extra boost for first-time funded devs
    if (isHighValue) scoringBoost += 5;

    return {
      devBalanceScore: +devBalanceScore.toFixed(3),
      devTier: dev.tier,
      solBalance: dev.solBalance,
      launchCount: dev.launchCount,
      isSerialLauncher,
      isHighValue,
      scoringBoost: Math.max(-15, Math.min(25, scoringBoost)),
      mapped: true,
    };
  }

  // ═══════════════════════════════════════
  // TOKEN OUTCOMES — Track pump/rug rates
  // ═══════════════════════════════════════

  /**
   * Record a token outcome for the dev's profile.
   */
  recordOutcome(ca, { graduated = false, rugged = false, peakMcap = 0 } = {}) {
    const devWallet = this.tokenToDev.get(ca);
    if (!devWallet) return;

    const dev = this.devs.get(devWallet);
    if (!dev) return;

    const token = dev.tokens.find(t => t.ca === ca);
    if (token) {
      token.graduated = graduated;
      token.rugged = rugged;
      if (peakMcap > token.peakMcap) token.peakMcap = peakMcap;
    }

    // Recalculate dev stats
    const completed = dev.tokens.filter(t => t.graduated !== undefined || t.rugged);
    if (completed.length > 0) {
      dev.pumpRate = completed.filter(t => t.graduated).length / completed.length;
      dev.rugRate = completed.filter(t => t.rugged).length / completed.length;
      dev.avgTokenMcap = completed.reduce((s, t) => s + (t.peakMcap || 0), 0) / completed.length;
      dev.bestTokenMcap = Math.max(...completed.map(t => t.peakMcap || 0));
    }
  }

  // ═══════════════════════════════════════
  // ALERTS — High-value dev notifications
  // ═══════════════════════════════════════

  _emitHighValueAlert(dev) {
    this.stats.highValueAlerts++;
    const alert = {
      type: "high_value_dev",
      address: dev.address,
      solBalance: dev.solBalance,
      tier: dev.tier,
      launchCount: dev.launchCount,
      latestToken: dev.tokens[dev.tokens.length - 1] || null,
      time: Date.now(),
    };

    console.log(
      `[DEV-TRACKER] HIGH VALUE DEV: ${dev.address.slice(0, 8)}... | ` +
      `${dev.solBalance} SOL (${dev.tier}) | ` +
      `launches: ${dev.launchCount} | ` +
      `latest: ${alert.latestToken?.name || "?"}`
    );

    if (this.onHighValueDev) {
      try { this.onHighValueDev(alert); } catch {}
    }
  }

  // ═══════════════════════════════════════
  // POLLING — Background balance updates
  // ═══════════════════════════════════════

  start() {
    if (this.pollInterval) return;
    console.log(`[DEV-TRACKER] Starting balance poll (${this.devs.size} devs mapped, ${this.POLL_INTERVAL_MS / 1000}s interval)`);
    this.pollInterval = setInterval(() => this.batchCheckBalances(), this.POLL_INTERVAL_MS);
    // First poll immediately
    this.batchCheckBalances();
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  // ═══════════════════════════════════════
  // PERSISTENCE — Redis save/load
  // ═══════════════════════════════════════

  async save() {
    if (!this.redis) return;
    try {
      const data = {};
      for (const [addr, dev] of this.devs) {
        if (dev.solBalance < 0 && dev.tokens.length === 0) continue; // skip empty entries
        data[addr] = {
          b: dev.solBalance,
          t: dev.tier,
          lc: dev.launchCount,
          pr: +dev.pumpRate.toFixed(2),
          rr: +dev.rugRate.toFixed(2),
          bm: dev.bestTokenMcap,
          fs: dev.firstSeen,
          tokens: dev.tokens.slice(-10).map(t => ({
            ca: t.ca, n: t.name, m: t.peakMcap, g: t.graduated, r: t.rugged,
          })),
        };
      }
      await this.redis.set("dev:tracker:wallets", JSON.stringify(data), { EX: 604800 }); // 7 days

      // Save reverse lookup
      const reverseData = {};
      for (const [ca, devW] of this.tokenToDev) {
        reverseData[ca] = devW;
      }
      await this.redis.set("dev:tracker:reverse", JSON.stringify(reverseData), { EX: 604800 });

      console.log(`[DEV-TRACKER] Saved ${Object.keys(data).length} dev wallets to Redis`);
    } catch (e) {
      console.error("[DEV-TRACKER] Save error:", e.message);
    }
  }

  async load() {
    if (!this.redis) return;
    try {
      const raw = await this.redis.get("dev:tracker:wallets");
      if (raw) {
        const data = JSON.parse(raw);
        for (const [addr, d] of Object.entries(data)) {
          this.devs.set(addr, {
            address: addr,
            solBalance: d.b,
            lastBalanceCheck: 0, // will re-check on next poll
            tokens: (d.tokens || []).map(t => ({
              ca: t.ca, name: t.n || "", ticker: "", time: 0,
              mcap: t.m || 0, peakMcap: t.m || 0,
              graduated: t.g || false, rugged: t.r || false,
            })),
            tier: d.t || "unknown",
            launchCount: d.lc || 0,
            avgTokenMcap: 0,
            bestTokenMcap: d.bm || 0,
            pumpRate: d.pr || 0,
            rugRate: d.rr || 0,
            profiledAt: 0,
            firstSeen: d.fs || Date.now(),
          });
        }
        this.stats.totalDevsMapped = this.devs.size;
        console.log(`[DEV-TRACKER] Loaded ${this.devs.size} dev wallets from Redis`);
      }

      const reverseRaw = await this.redis.get("dev:tracker:reverse");
      if (reverseRaw) {
        const reverseData = JSON.parse(reverseRaw);
        for (const [ca, devW] of Object.entries(reverseData)) {
          this.tokenToDev.set(ca, devW);
        }
      }
    } catch (e) {
      console.error("[DEV-TRACKER] Load error:", e.message);
    }
  }

  // ═══════════════════════════════════════
  // STATS & VIEWS
  // ═══════════════════════════════════════

  _updateStats() {
    let totalBal = 0;
    let counted = 0;
    for (const dev of this.devs.values()) {
      if (dev.solBalance >= 0) {
        totalBal += dev.solBalance;
        counted++;
      }
    }
    this.stats.avgDevBalance = counted > 0 ? +(totalBal / counted).toFixed(3) : 0;
    this.stats.totalDevsMapped = this.devs.size;
  }

  /**
   * Get the full dev wallet map for dashboard display.
   */
  getDevMap(limit = 100) {
    return [...this.devs.values()]
      .filter(d => d.solBalance >= 0)
      .sort((a, b) => b.solBalance - a.solBalance)
      .slice(0, limit)
      .map(d => ({
        address: d.address,
        shortAddr: d.address.slice(0, 8) + "...",
        solBalance: d.solBalance,
        tier: d.tier,
        launchCount: d.launchCount,
        pumpRate: +(d.pumpRate * 100).toFixed(1),
        rugRate: +(d.rugRate * 100).toFixed(1),
        bestTokenMcap: d.bestTokenMcap,
        tokens: d.tokens.slice(-5).map(t => ({
          ca: t.ca,
          name: t.name,
          peakMcap: t.peakMcap,
          graduated: t.graduated,
          rugged: t.rugged,
        })),
        firstSeen: d.firstSeen,
        isHighValue: d.solBalance >= DEV_TIERS.FUNDED_DEV.min && d.launchCount <= 2,
      }));
  }

  /**
   * Get tier distribution stats.
   */
  getTierDistribution() {
    const dist = { whale_dev: 0, funded_dev: 0, mid_dev: 0, low_dev: 0, broke_dev: 0, unknown: 0 };
    for (const dev of this.devs.values()) {
      dist[dev.tier] = (dist[dev.tier] || 0) + 1;
    }
    return dist;
  }

  /**
   * Get dev wallet for a specific token CA.
   */
  getDevForToken(ca) {
    const devWallet = this.tokenToDev.get(ca);
    if (!devWallet) return null;
    return this.devs.get(devWallet) || null;
  }

  summary() {
    this._updateStats();
    return {
      totalDevsMapped: this.devs.size,
      tokensTracked: this.tokenToDev.size,
      tiers: this.getTierDistribution(),
      stats: { ...this.stats },
      polling: !!this.pollInterval,
    };
  }
}

export default DevWalletTracker;
