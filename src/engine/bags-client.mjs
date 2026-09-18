// BONDLI — Bags.fm API Client (Complete Meteora DBC Integration)
//
// Full coverage of Bags Public API v1:
//   - Agent Auth (init + login + JWT)
//   - Agent Management (dev keys, wallets, export)
//   - Token Launch (create info/metadata, create launch tx, feed, creators)
//   - Trading (quote, swap, send tx)
//   - Fee Sharing (config, admin update, admin transfer, admin list, wallet lookup)
//   - Fee Claiming (claim txs v3, claimable positions, claim stats, claim events)
//   - Partner (create config, claim, stats)
//   - Pools & Analytics (pools, pool by mint, lifetime fees)
//   - Dexscreener (create order, check availability, submit payment)
//
// Bags.fm: Solana-native launchpad on Meteora DBC
//   Program: dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
//   Signer:  BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv
//
// Base URL: https://public-api-v2.bags.fm/api/v1/
// Auth: x-api-key header (dev key) or Authorization: Bearer <JWT> (agent auth)
// Rate limit: 1,000 req/hr per user/IP

import CONFIG from "./config.mjs";

const BAGS_BASE = "https://public-api-v2.bags.fm/api/v1";
const BAGS_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const BAGS_SIGNER = "BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv";

// ── Rate limiter: 1000 req/hr, we leave 50 buffer ──
const RATE_LIMIT = { count: 0, resetAt: 0, MAX: 950 };

function checkRateLimit() {
  const now = Date.now();
  if (now > RATE_LIMIT.resetAt) {
    RATE_LIMIT.count = 0;
    RATE_LIMIT.resetAt = now + 3600_000;
  }
  if (RATE_LIMIT.count >= RATE_LIMIT.MAX) {
    throw new Error("[BAGS] Rate limit approaching — request blocked");
  }
  RATE_LIMIT.count++;
}

export class BagsClient {
  constructor(apiKey, agentJwt) {
    this.apiKey = apiKey || CONFIG.BAGS_API_KEY || "";
    this.agentJwt = agentJwt || CONFIG.BAGS_AGENT_JWT || "";
    this.cache = new Map();
    this.CACHE_TTL = 15_000;
  }

  // ═══════════════════════════════════════════════════════════════
  //  INTERNAL: HTTP fetch with auth, caching, rate limiting
  // ═══════════════════════════════════════════════════════════════

  async _fetch(endpoint, opts = {}) {
    checkRateLimit();

    const url = `${BAGS_BASE}${endpoint}`;
    const method = opts.method || "GET";
    const cacheKey = method === "GET" ? url : null;

    // Cache check (GET only)
    if (cacheKey && !opts.noCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() < cached.expiry) return cached.data;
    }

    const headers = {};
    if (opts.multipart) {
      // Let fetch set Content-Type for FormData
    } else {
      headers["Content-Type"] = "application/json";
    }

    // Auth: prefer x-api-key for public endpoints, Bearer JWT for agent endpoints
    if (opts.agentAuth && this.agentJwt) {
      headers["Authorization"] = `Bearer ${this.agentJwt}`;
    } else if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const fetchOpts = { method, headers };
    if (opts.multipart) {
      fetchOpts.body = opts.body; // FormData
    } else if (opts.body) {
      fetchOpts.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, fetchOpts);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[BAGS] ${res.status} ${method} ${endpoint}: ${text}`);
    }

    const data = await res.json();

    // Bags wraps responses: { success: true, response: {...} }
    const payload = data.response !== undefined ? data.response : data;

    if (cacheKey) {
      this.cache.set(cacheKey, { data: payload, expiry: Date.now() + (opts.cacheTtl || this.CACHE_TTL) });
    }

    return payload;
  }

  // ═══════════════════════════════════════════════════════════════
  //  AGENT AUTH — Initialize, login, get JWT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Step 1: Initialize agent auth — get verification challenge.
   * Challenge expires after 15 minutes.
   * POST /agent/auth/init
   */
  async authInit(opts = {}) {
    return this._fetch("/agent/auth/init", {
      method: "POST",
      body: { wallet: opts.wallet },
    });
  }

  /**
   * Step 2: Complete agent auth — returns JWT (valid 365 days).
   * Session can only be used once.
   * POST /agent/auth/login
   */
  async authLogin(opts = {}) {
    const result = await this._fetch("/agent/auth/login", {
      method: "POST",
      body: { sessionId: opts.sessionId, signature: opts.signature },
    });
    // Store the JWT for future agent calls
    if (result?.token) this.agentJwt = result.token;
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  //  AGENT MANAGEMENT — Dev keys, wallets
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a new API key for the Bags Public API.
   * POST /agent/dev/keys/create
   */
  async createDevKey(opts = {}) {
    return this._fetch("/agent/dev/keys/create", {
      method: "POST",
      body: { name: opts.name },
      agentAuth: true,
    });
  }

  /**
   * List all active API keys for the authenticated agent.
   * POST /agent/dev/keys
   */
  async listDevKeys() {
    return this._fetch("/agent/dev/keys", { method: "POST", agentAuth: true });
  }

  /**
   * List all wallets associated with the authenticated agent.
   * POST /agent/wallet/list
   */
  async listWallets() {
    return this._fetch("/agent/wallet/list", { method: "POST", agentAuth: true });
  }

  /**
   * Export private key for a specific wallet. USE WITH EXTREME CAUTION.
   * POST /agent/wallet/export
   */
  async exportWallet(walletAddress) {
    return this._fetch("/agent/wallet/export", {
      method: "POST",
      body: { wallet: walletAddress },
      agentAuth: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  TOKEN LAUNCH — Create token, launch, feed, creators
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create token info and metadata. Generates a token mint for launching.
   * Supports image upload via URL or base64.
   * POST /token-launch/create-token-info
   *
   * @param {Object} opts
   * @param {string} opts.name - Token name (required)
   * @param {string} opts.symbol - Token symbol (required)
   * @param {string} opts.description - Token description (required)
   * @param {string} [opts.imageUrl] - Image URL
   * @param {string} [opts.metadataUrl] - Metadata URL (if pre-uploaded)
   * @param {string} [opts.twitter] - Twitter handle
   * @param {string} [opts.telegram] - Telegram link
   * @param {string} [opts.website] - Website URL
   */
  async createTokenInfo(opts) {
    return this._fetch("/token-launch/create-token-info", {
      method: "POST",
      body: {
        name: opts.name,
        symbol: opts.symbol,
        description: opts.description,
        imageUrl: opts.imageUrl,
        metadataUrl: opts.metadataUrl,
        twitter: opts.twitter,
        telegram: opts.telegram,
        website: opts.website,
      },
    });
  }

  /**
   * Create the token launch transaction (already signed with token mint).
   * POST /token-launch/create-launch-transaction
   *
   * @param {Object} opts
   * @param {string} opts.mintPublicKey - Token mint from createTokenInfo
   * @param {string} opts.wallet - Creator wallet public key
   * @param {number} [opts.initialBuyAmount] - SOL amount for initial buy
   * @param {string} [opts.partnerKey] - Partner config key for fee sharing
   */
  async createLaunchTransaction(opts) {
    return this._fetch("/token-launch/create-launch-transaction", {
      method: "POST",
      body: {
        mintPublicKey: opts.mintPublicKey,
        wallet: opts.wallet,
        initialBuyAmount: opts.initialBuyAmount,
        partnerKey: opts.partnerKey,
      },
    });
  }

  /**
   * Get token launch feed — recent and active token launches.
   * GET /token-launch/feed
   */
  async getLaunchFeed() {
    // Bags API: GET /token-launch/feed — NO query params (400 if any are sent)
    return this._fetch("/token-launch/feed", { cacheTtl: 10_000 });
  }

  /**
   * Get token launch creators/deployers with profile details.
   * GET /token-launch/creator/v3
   */
  async getCreators(tokenMint) {
    return this._fetch(`/token-launch/creator/v3?tokenMint=${tokenMint}`, { cacheTtl: 60_000 });
  }

  // ═══════════════════════════════════════════════════════════════
  //  TRADING — Quote, swap, send transaction
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get a trade quote — expected output, price impact, slippage, route.
   * GET /trade/quote
   *
   * @param {Object} opts
   * @param {string} opts.inputMint - Input token mint (e.g. SOL mint for buys)
   * @param {string} opts.outputMint - Output token mint
   * @param {number} opts.amount - Amount in smallest unit (lamports/raw)
   * @param {number} [opts.slippage] - Slippage tolerance in bps
   */
  async getQuote(opts) {
    const params = new URLSearchParams({
      inputMint: opts.inputMint,
      outputMint: opts.outputMint,
      amount: String(opts.amount),
    });
    if (opts.slippage) params.set("slippage", opts.slippage);
    return this._fetch(`/trade/quote?${params}`, { cacheTtl: 5_000 });
  }

  /**
   * Create a swap transaction from a quote — ready to sign and send.
   * POST /trade/swap
   *
   * @param {Object} opts
   * @param {Object} opts.quote - Quote object from getQuote
   * @param {string} opts.wallet - User's wallet public key
   * @param {string} [opts.partnerKey] - Partner key for fee sharing
   */
  async createSwap(opts) {
    return this._fetch("/trade/swap", {
      method: "POST",
      body: {
        quote: opts.quote,
        wallet: opts.wallet,
        partnerKey: opts.partnerKey,
      },
    });
  }

  /**
   * Send a signed transaction to the Solana network.
   * POST /solana/send-transaction
   *
   * @param {string} signedTransaction - Base64 encoded signed transaction
   */
  async sendTransaction(signedTransaction) {
    return this._fetch("/solana/send-transaction", {
      method: "POST",
      body: { signedTransaction },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  FEE SHARING — Config, admin, wallet lookup
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create fee sharing configuration with multiple fee claimers (up to 100).
   * All fees must be explicitly allocated using basis points (total = 10000).
   * POST /fee-share/config
   *
   * @param {Object} opts
   * @param {string} opts.tokenMint - Token mint address
   * @param {string} opts.admin - Admin wallet (fee share authority)
   * @param {Array} opts.feeClaimers - [{ wallet, bps }] basis point allocations
   */
  async createFeeShareConfig(opts) {
    return this._fetch("/fee-share/config", {
      method: "POST",
      body: {
        tokenMint: opts.tokenMint,
        admin: opts.admin,
        feeClaimers: opts.feeClaimers,
      },
    });
  }

  /**
   * Update fee share configuration (change claimers/bps allocations).
   * POST /fee-share/admin/update-config
   */
  async updateFeeShareConfig(opts) {
    return this._fetch("/fee-share/admin/update-config", {
      method: "POST",
      body: {
        tokenMint: opts.tokenMint,
        admin: opts.admin,
        feeClaimers: opts.feeClaimers,
      },
    });
  }

  /**
   * Transfer fee share admin authority to a new admin.
   * POST /fee-share/admin/transfer-tx
   */
  async transferFeeShareAdmin(opts) {
    return this._fetch("/fee-share/admin/transfer-tx", {
      method: "POST",
      body: {
        tokenMint: opts.tokenMint,
        currentAdmin: opts.currentAdmin,
        newAdmin: opts.newAdmin,
      },
    });
  }

  /**
   * List all tokens where wallet is the fee share admin.
   * GET /fee-share/admin/list
   */
  async getFeeShareAdminList(wallet) {
    return this._fetch(`/fee-share/admin/list?wallet=${wallet}`, { cacheTtl: 60_000 });
  }

  /**
   * Look up wallet address by social provider + username for fee sharing.
   * GET /token-launch/fee-share/wallet/v2
   */
  async getFeeShareWallet(provider, username) {
    const params = new URLSearchParams({ provider, username });
    return this._fetch(`/token-launch/fee-share/wallet/v2?${params}`, { cacheTtl: 120_000 });
  }

  /**
   * Bulk wallet lookup for fee sharing.
   * POST /token-launch/fee-share/wallet/v2/bulk
   *
   * @param {Array} lookups - [{ provider, username }]
   */
  async getFeeShareWalletBulk(lookups) {
    return this._fetch("/token-launch/fee-share/wallet/v2/bulk", {
      method: "POST",
      body: { lookups },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  FEE CLAIMING — Claim txs, positions, stats, events
  // ═══════════════════════════════════════════════════════════════

  /**
   * Generate claim transactions for a token (v3 — auto-handles token state).
   * POST /token-launch/claim-txs/v3
   *
   * @param {Object} opts
   * @param {string} opts.tokenMint - Token mint address
   * @param {string} opts.wallet - Wallet claiming fees
   */
  async getClaimTransactions(opts) {
    return this._fetch("/token-launch/claim-txs/v3", {
      method: "POST",
      body: {
        tokenMint: opts.tokenMint,
        wallet: opts.wallet,
      },
    });
  }

  /**
   * Get all claimable fee positions for a wallet.
   * Returns positions from virtual pools and DAMM v2.
   * GET /token-launch/claimable-positions
   */
  async getClaimablePositions(wallet) {
    return this._fetch(`/token-launch/claimable-positions?wallet=${wallet}`, { cacheTtl: 60_000 });
  }

  /**
   * Get claim statistics for all fee claimers of a specific token.
   * GET /token-launch/claim-stats
   */
  async getClaimStats(tokenMint) {
    return this._fetch(`/token-launch/claim-stats?tokenMint=${tokenMint}`, { cacheTtl: 30_000 });
  }

  /**
   * Get claim events for a token. Supports offset or time-based pagination.
   * GET /fee-share/token/claim-events
   *
   * Offset mode: { tokenMint, limit (1-100), offset }
   * Time mode:   { tokenMint, mode: "time", from, to } (unix timestamps)
   */
  async getClaimEvents(opts) {
    const params = new URLSearchParams({ tokenMint: opts.tokenMint });
    if (opts.mode === "time") {
      params.set("mode", "time");
      if (opts.from) params.set("from", opts.from);
      if (opts.to) params.set("to", opts.to);
    } else {
      if (opts.limit) params.set("limit", opts.limit);
      if (opts.offset) params.set("offset", opts.offset);
    }
    return this._fetch(`/fee-share/token/claim-events?${params}`, { cacheTtl: 30_000 });
  }

  /**
   * Get total lifetime fees collected for a specific token.
   * GET /token-launch/lifetime-fees
   */
  async getLifetimeFees(tokenMint) {
    return this._fetch(`/token-launch/lifetime-fees?tokenMint=${tokenMint}`, { cacheTtl: 30_000 });
  }

  /**
   * Get pool config keys from fee claimer vault public keys.
   * POST /token-launch/state/pool-config
   */
  async getPoolConfigKeys(feeClaimerVaults) {
    return this._fetch("/token-launch/state/pool-config", {
      method: "POST",
      body: { feeClaimerVaults },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  PARTNER — Config, claim, stats
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a partner config key. Earns revenue from volume of coins created.
   * One partner key per wallet.
   * POST /fee-share/partner-config/creation-tx
   */
  async createPartnerConfig(wallet) {
    return this._fetch("/fee-share/partner-config/creation-tx", {
      method: "POST",
      body: { wallet },
    });
  }

  /**
   * Get partner stats — claimed and unclaimed fees.
   * GET /fee-share/partner-config/stats
   */
  async getPartnerStats(partnerKey) {
    return this._fetch(`/fee-share/partner-config/stats?partnerKey=${partnerKey}`, { cacheTtl: 60_000 });
  }

  /**
   * Generate transactions to claim accumulated partner fees.
   * POST /fee-share/partner-config/claim-tx
   */
  async claimPartnerFees(opts) {
    return this._fetch("/fee-share/partner-config/claim-tx", {
      method: "POST",
      body: {
        partnerKey: opts.partnerKey,
        wallet: opts.wallet,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  POOLS & ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get all Bags pools with Meteora DBC and DAMM v2 pool keys.
   * GET /solana/bags/pools
   */
  async getPools(opts = {}) {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", opts.limit);
    if (opts.offset) params.set("offset", opts.offset);
    const qs = params.toString();
    return this._fetch(`/solana/bags/pools${qs ? "?" + qs : ""}`, { cacheTtl: 30_000 });
  }

  /**
   * Get a single Bags pool by its token mint address.
   * GET /solana/bags/pools/token-mint
   */
  async getPoolByMint(tokenMint) {
    return this._fetch(`/solana/bags/pools/token-mint?tokenMint=${tokenMint}`, { cacheTtl: 15_000 });
  }

  // ═══════════════════════════════════════════════════════════════
  //  DEXSCREENER INTEGRATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a Dexscreener token info order. Returns payment tx.
   * POST /solana/dexscreener/create-order
   */
  async createDexscreenerOrder(opts) {
    return this._fetch("/solana/dexscreener/create-order", {
      method: "POST",
      body: {
        tokenMint: opts.tokenMint,
        wallet: opts.wallet,
      },
    });
  }

  /**
   * Check if a Dexscreener order is available for a token.
   * GET /solana/dexscreener/order-availability
   */
  async checkDexscreenerAvailability(tokenMint) {
    return this._fetch(`/solana/dexscreener/order-availability?tokenMint=${tokenMint}`, { cacheTtl: 60_000 });
  }

  /**
   * Submit signed payment transaction for a Dexscreener order.
   * POST /solana/dexscreener/submit-payment
   */
  async submitDexscreenerPayment(signedTransaction) {
    return this._fetch("/solana/dexscreener/submit-payment", {
      method: "POST",
      body: { signedTransaction },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  BONDLI-SPECIFIC: Token monitor, normalization, fee sweeps
  // ═══════════════════════════════════════════════════════════════

  /**
   * Poll for new Bags launches and normalize to Bondli token format.
   * Scoring engine treats Bags and PumpFun tokens identically.
   */
  async pollNewLaunches(since = 0) {
    const feed = await this.getLaunchFeed();
    // Response is already unwrapped by _fetch (strips { success, response } wrapper)
    const tokens = Array.isArray(feed) ? feed : (feed?.tokens || feed?.launches || []);
    return tokens
      .filter(t => {
        // Feed may not have createdAt — include all tokens if since=0
        if (since === 0) return true;
        const created = t.createdAt ? new Date(t.createdAt).getTime() : 0;
        return created > since || created === 0; // include if no timestamp
      })
      .map(t => this._normalizeToBondli(t));
  }

  /**
   * Normalize Bags token data to match Bondli's internal token format.
   * This lets every scoring module work identically on Bags and PumpFun tokens.
   */
  _normalizeToBondli(bagsToken) {
    const t = bagsToken;
    // Feed response fields per docs: name, symbol, description, image, tokenMint,
    // status (PRE_LAUNCH|PRE_GRAD|MIGRATING|MIGRATED), twitter, website,
    // launchSignature, accountKeys[], uri, dbcPoolKey, dbcConfigKey
    const devWallet = t.creator || t.deployer || (Array.isArray(t.accountKeys) ? t.accountKeys[0] : "") || "";
    return {
      ca: t.tokenMint || t.mint || t.address || "",
      name: t.name || "",
      ticker: t.symbol || "",
      description: t.description || "",
      image: t.image || t.imageUri || t.imageUrl || "",
      twitter: t.twitter || "",
      telegram: t.telegram || "",
      website: t.website || "",
      devWallet,
      priceUsd: t.priceUsd || 0,
      mcapUsd: t.marketCap || t.mcapUsd || 0,
      volume24h: t.volume24h || 0,
      volumeSol: t.volumeSol || 0,
      liquidity: t.liquidity || 0,
      change5m: t.priceChange5m || 0,
      change1h: t.priceChange1h || 0,
      change24h: t.priceChange24h || 0,
      buys: t.buys || t.buyCount || 0,
      sells: t.sells || t.sellCount || 0,
      uniqueBuyers: t.uniqueBuyers || 0,
      pairCreated: t.createdAt ? new Date(t.createdAt).getTime() : Date.now(),
      createdAt: t.createdAt ? new Date(t.createdAt).getTime() : Date.now(),
      // Bags-specific fields — preserved for routing + fee logic
      _source: "bags",
      _bagsStatus: t.status || "",              // PRE_LAUNCH | PRE_GRAD | MIGRATING | MIGRATED
      _bagsCreatorFee: 0.01,                    // 1% perpetual creator royalty
      _bagsDividends: true,
      _bagsHolderCount: t.holderCount || 0,
      _bagsDbcPoolKey: t.dbcPoolKey || "",
      _bagsLaunchSig: t.launchSignature || "",
      _meteoraDBC: true,                        // Meteora DBC, NOT pump.fun bonding curve
      _bagsRaw: t,                              // preserve original for Bags-specific API calls
    };
  }

  /**
   * Complete buy flow: get quote → create swap → return unsigned tx.
   * Caller signs and sends via sendTransaction().
   */
  async prepareBuy(opts) {
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const quote = await this.getQuote({
      inputMint: SOL_MINT,
      outputMint: opts.tokenMint,
      amount: Math.round(opts.solAmount * 1e9), // lamports
      slippage: opts.slippage || CONFIG.SLIPPAGE_BPS,
    });
    const swap = await this.createSwap({
      quote,
      wallet: opts.wallet,
      partnerKey: CONFIG.BAGS_PARTNER_WALLET || undefined,
    });
    return { quote, swap, tokenMint: opts.tokenMint };
  }

  /**
   * Complete sell flow: get quote → create swap → return unsigned tx.
   */
  async prepareSell(opts) {
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const quote = await this.getQuote({
      inputMint: opts.tokenMint,
      outputMint: SOL_MINT,
      amount: opts.tokenAmount, // raw token amount
      slippage: opts.slippage || CONFIG.SLIPPAGE_BPS,
    });
    const swap = await this.createSwap({
      quote,
      wallet: opts.wallet,
      partnerKey: CONFIG.BAGS_PARTNER_WALLET || undefined,
    });
    return { quote, swap, tokenMint: opts.tokenMint };
  }

  /**
   * Full token launch flow:
   *   1. Create token info/metadata → get mint
   *   2. Create launch transaction → return unsigned tx for signing
   */
  async prepareLaunch(opts) {
    // Step 1: Create token info
    const tokenInfo = await this.createTokenInfo({
      name: opts.name,
      symbol: opts.symbol,
      description: opts.description,
      imageUrl: opts.imageUrl,
      twitter: opts.twitter,
      telegram: opts.telegram,
      website: opts.website,
    });

    const mintPublicKey = tokenInfo.mintPublicKey || tokenInfo.mint;
    if (!mintPublicKey) throw new Error("[BAGS] createTokenInfo did not return a mint");

    // Step 2: Create launch transaction
    const launchTx = await this.createLaunchTransaction({
      mintPublicKey,
      wallet: opts.wallet,
      initialBuyAmount: opts.initialBuySol,
      partnerKey: CONFIG.BAGS_PARTNER_WALLET || undefined,
    });

    return { tokenInfo, mintPublicKey, launchTx };
  }

  /**
   * Auto-sweep claimable fees. Called by orchestrator on timer.
   * Returns claim transactions ready for signing.
   */
  async sweepFees(wallet) {
    try {
      const positions = await this.getClaimablePositions(wallet);
      const claimable = positions?.positions || positions || [];
      if (!Array.isArray(claimable) || !claimable.length) {
        return { swept: false, reason: "nothing_claimable" };
      }

      const totalClaimable = claimable.reduce((s, p) => s + (p.claimableAmount || p.unclaimedFees || 0), 0);
      if (totalClaimable < 0.001) {
        return { swept: false, reason: "dust_amount", amount: totalClaimable };
      }

      // Generate claim transactions for each claimable token
      const claimTxs = [];
      const tokenMints = [...new Set(claimable.map(p => p.tokenMint).filter(Boolean))];

      for (const tokenMint of tokenMints) {
        try {
          const txs = await this.getClaimTransactions({ tokenMint, wallet });
          if (txs) claimTxs.push({ tokenMint, transactions: txs });
        } catch (e) {
          console.error(`[BAGS] Claim tx error for ${tokenMint}: ${e.message}`);
        }
      }

      console.log(`[BAGS] Sweep: ${totalClaimable.toFixed(4)} SOL from ${tokenMints.length} tokens, ${claimTxs.length} claim batches`);

      return {
        swept: true,
        totalSol: totalClaimable,
        tokenCount: tokenMints.length,
        claimTxs, // caller signs and sends each via sendTransaction()
      };
    } catch (e) {
      console.error(`[BAGS] Fee sweep error: ${e.message}`);
      return { swept: false, reason: "error", error: e.message };
    }
  }

  /**
   * Sweep partner fees (from Bondli's partner key).
   */
  async sweepPartnerFees(partnerKey, wallet) {
    try {
      const stats = await this.getPartnerStats(partnerKey);
      const unclaimed = stats?.unclaimedFees || 0;
      if (unclaimed < 0.001) return { swept: false, reason: "dust_amount", amount: unclaimed };

      const claimTx = await this.claimPartnerFees({ partnerKey, wallet });
      console.log(`[BAGS] Partner sweep: ${unclaimed.toFixed(4)} SOL`);
      return { swept: true, amount: unclaimed, claimTx };
    } catch (e) {
      console.error(`[BAGS] Partner sweep error: ${e.message}`);
      return { swept: false, reason: "error", error: e.message };
    }
  }

  /**
   * Check if a mint is a Bags token by looking up its pool.
   */
  async isBagsToken(mint) {
    try {
      const pool = await this.getPoolByMint(mint);
      return !!pool;
    } catch {
      return false;
    }
  }

  /**
   * Get rate limit status.
   */
  getRateLimitStatus() {
    return {
      used: RATE_LIMIT.count,
      max: RATE_LIMIT.MAX,
      remaining: RATE_LIMIT.MAX - RATE_LIMIT.count,
      resetsAt: RATE_LIMIT.resetAt,
    };
  }

  /**
   * Clear response cache (useful on config changes).
   */
  clearCache() {
    this.cache.clear();
  }
}

export { BAGS_BASE, BAGS_PROGRAM, BAGS_SIGNER };
export default BagsClient;
