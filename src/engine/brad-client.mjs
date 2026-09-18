// ═══ BRAD ENGINE CLIENT — Cognitive Trading Bridge ═══
//
// HTTP client that connects Bondli's Node.js pipeline to the BRAD
// (Ouroboros Loop) cognitive trading engine running as a Python sidecar.
//
// BRAD adds 3-level strange loop reasoning:
//   L0 (World Model)  — Knowledge graph of tokens, wallets, regime
//   L1 (Self Model)   — Strategy selection, confidence calibration
//   L2 (Meta-Cognitive) — Blind spot detection, downward causation
//
// Integration points:
//   - Pre-pipeline: BRAD evaluates tokens before 5-gate pipeline
//   - Exit overlay:  BRAD evaluates positions for meta-cognitive exits
//   - Post-trade:    BRAD records entries/exits for self-learning
//   - Regime sync:   Bondli's regime engine feeds BRAD's world model
//
// BRAD runs as a FastAPI sidecar on port 8421 (configurable via BRAD_URL).
// All calls are async with timeouts — if BRAD is down, bondli continues alone.

const BRAD_URL = process.env.BRAD_URL || "http://127.0.0.1:8421";
const BRAD_TIMEOUT_MS = parseInt(process.env.BRAD_TIMEOUT_MS || "500"); // 500ms max per call
const BRAD_ENABLED = process.env.BRAD_ENABLED !== "false"; // enabled by default

let _healthy = false;
let _lastHealthCheck = 0;
let _consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 10; // disable after 10 consecutive failures
const HEALTH_CHECK_INTERVAL_MS = 30_000; // re-check health every 30s

// ═══ INTERNAL FETCH WITH TIMEOUT ═══

async function bradFetch(path, options = {}) {
  if (!BRAD_ENABLED) return null;

  // Circuit breaker: if too many failures, only try on health checks
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const now = Date.now();
    if (now - _lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) return null;
    _lastHealthCheck = now;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || BRAD_TIMEOUT_MS);

  try {
    const resp = await fetch(`${BRAD_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      _consecutiveFailures++;
      console.error(`[BRAD] ${path} returned ${resp.status}`);
      return null;
    }

    _consecutiveFailures = 0;
    _healthy = true;
    return await resp.json();
  } catch (err) {
    clearTimeout(timeout);
    _consecutiveFailures++;
    if (_consecutiveFailures === 1 || _consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
      console.error(`[BRAD] ${path} failed (${_consecutiveFailures}x): ${err.message}`);
    }
    if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      _healthy = false;
      console.warn(`[BRAD] Circuit breaker open — ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Will retry in ${HEALTH_CHECK_INTERVAL_MS / 1000}s.`);
    }
    return null;
  }
}

// ═══ PUBLIC API ═══

/**
 * Evaluate a token through BRAD's cognitive engine (L0→L1→L2 cycle).
 *
 * Call this BEFORE the 5-gate pipeline. BRAD returns:
 *   { action: "APE"|"SKIP"|"WATCH", confidence, reasoning, position_size_sol, risk_factors, cognitive }
 *
 * If BRAD says SKIP, the pipeline should skip this token.
 * If BRAD says APE, use its confidence as an additional signal.
 * BRAD's position_size_sol acts as a ceiling on bondli's Kelly sizing.
 *
 * @param {object} tokenData - Token data from Bondli's scorer
 * @returns {object|null} BRAD decision or null if unavailable
 */
export async function evaluateToken(tokenData) {
  return bradFetch("/evaluate", {
    method: "POST",
    body: JSON.stringify({
      mint: tokenData.ca || tokenData.mint || "",
      name: tokenData.name || "",
      symbol: tokenData.symbol || "",
      source: tokenData.source || "pump",
      score: (tokenData.score ?? tokenData._apeScore ?? 0) / 100, // normalize 0-100 to 0-1
      velocity: tokenData.velocity ?? tokenData._scoreVelocity ?? 0,
      acceleration: tokenData.acceleration ?? tokenData._scoreAcceleration ?? 0,
      rug_signals: tokenData._rugFlags?.length ?? tokenData.rugSignals ?? 0,
      rug_details: tokenData._rugFlags ?? tokenData.rugDetails ?? [],
      holder_count: tokenData.uniqueBuyers?.size ?? tokenData.holderCount ?? 0,
      top_holder_pct: tokenData.topHolderPct ?? 0,
      liquidity_sol: tokenData.liquiditySol ?? tokenData.vSolInBondingCurve ?? 0,
      mcap_sol: (tokenData.mcapUsd ?? 0) / (tokenData.solPrice || 150), // rough USD→SOL
      volume_5m: tokenData.volume5m ?? tokenData.volumeSol ?? 0,
      buy_pressure: tokenData.buyPressure ?? (tokenData.buys && tokenData.trades
        ? tokenData.buys / Math.max(1, tokenData.buys + (tokenData.sells || 0))
        : 0.5),
      smart_money_in: tokenData.smartMoneyIn ?? false,
      dev_wallet: tokenData.devWallet ?? "",
      is_graduated: !!(tokenData.graduated || tokenData.raydiumPool),
      price_sol: tokenData.priceSol ?? 0,
    }),
  });
}

/**
 * Evaluate an open position through BRAD's cognitive engine.
 *
 * Call this during exit checks. BRAD returns:
 *   { action: "EXIT"|"HOLD"|"PARTIAL_EXIT", confidence, reasoning, pnl_pct, exit_pct }
 *
 * BRAD's meta-cognitive layer can detect systematic patterns bondli misses:
 *   - Overconfidence → force exit on marginal holds
 *   - Loss aversion → accelerate exit on deteriorating positions
 *   - Regime blindness → exit positions mismatched to current regime
 *
 * @param {string} mint - Token contract address
 * @param {object} tokenData - Current token data
 * @returns {object|null} BRAD decision or null if unavailable
 */
export async function evaluatePosition(mint, tokenData) {
  return bradFetch("/position/evaluate", {
    method: "POST",
    body: JSON.stringify({
      mint,
      score: (tokenData.score ?? tokenData._apeScore ?? tokenData.liveScore ?? 0) / 100,
      velocity: tokenData.velocity ?? tokenData._scoreVelocity ?? 0,
      acceleration: tokenData.acceleration ?? tokenData._scoreAcceleration ?? 0,
      rug_signals: tokenData._rugFlags?.length ?? tokenData.rugSignals ?? 0,
      rug_details: tokenData._rugFlags ?? [],
      price_sol: tokenData.priceSol ?? 0,
      liquidity_sol: tokenData.liquiditySol ?? tokenData.vSolInBondingCurve ?? 0,
    }),
  });
}

/**
 * Record a confirmed entry. Called AFTER the swap is confirmed on-chain.
 * This feeds BRAD's position tracker and self-model for performance awareness.
 *
 * @param {object} entry - { mint, symbol, price_sol, size_sol, score, reasoning }
 */
export async function recordEntry(entry) {
  return bradFetch("/position/entry", {
    method: "POST",
    body: JSON.stringify({
      mint: entry.mint || entry.ca || "",
      symbol: entry.symbol || entry.name || "",
      price_sol: entry.price_sol || entry.priceSol || 0,
      size_sol: entry.size_sol || entry.sizeSol || entry.entrySol || 0,
      score: (entry.score || 0) / 100,
      reasoning: entry.reasoning || [],
    }),
    timeout: 1000, // entry recording can be slightly slower
  });
}

/**
 * Record a confirmed exit. Triggers BRAD's meta-cognitive evaluation.
 * After every closed trade, L2 checks for blind spots and may restructure L1.
 *
 * @param {object} exit - { mint, exit_price_sol, reason }
 * @returns {object|null} { status, trade: { pnl_sol, outcome, ... } }
 */
export async function recordExit(exit) {
  return bradFetch("/position/exit", {
    method: "POST",
    body: JSON.stringify({
      mint: exit.mint || exit.ca || "",
      exit_price_sol: exit.exit_price_sol || exit.exitPriceSol || 0,
      reason: exit.reason || "unknown",
    }),
    timeout: 2000, // exit triggers meta-eval, may take longer
  });
}

/**
 * Record a partial exit (take profit).
 *
 * @param {object} partial - { mint, size_sol, price_sol, reason }
 */
export async function recordPartialExit(partial) {
  return bradFetch("/position/partial", {
    method: "POST",
    body: JSON.stringify({
      mint: partial.mint || partial.ca || "",
      size_sol: partial.size_sol || partial.sizeSol || 0,
      price_sol: partial.price_sol || partial.priceSol || 0,
      reason: partial.reason || "take_profit",
    }),
  });
}

/**
 * Update market regime from bondli's regime engine.
 * Maps bondli's 5 regimes (EUPHORIA, RISK_ON, GRINDING, PVP, DEAD)
 * to BRAD's regime model (bull, bear, chop, unknown).
 *
 * @param {object} regimeData - { regime, confidence, signals }
 */
export async function updateRegime(regimeData) {
  // Map bondli regime names to BRAD regime names
  const REGIME_MAP = {
    EUPHORIA: "bull",
    RISK_ON: "bull",
    GRINDING: "chop",
    PVP: "bear",
    DEAD: "bear",
  };

  const bradRegime = REGIME_MAP[regimeData.regime] || "unknown";

  return bradFetch("/regime", {
    method: "POST",
    body: JSON.stringify({
      regime: bradRegime,
      confidence: regimeData.confidence ?? 0.5,
      bull_score: regimeData.regime === "EUPHORIA" ? 0.9 : regimeData.regime === "RISK_ON" ? 0.7 : 0.3,
      bear_score: regimeData.regime === "DEAD" ? 0.9 : regimeData.regime === "PVP" ? 0.7 : 0.2,
      chop_score: regimeData.regime === "GRINDING" ? 0.7 : 0.3,
      rug_frequency: regimeData.signals?.rugRate || 0,
      avg_token_lifespan: regimeData.signals?.avgLifespan || 0,
    }),
  });
}

/**
 * Ingest a smart money wallet profile into BRAD's world model.
 *
 * @param {string} wallet - Wallet address
 * @param {object} profile - { win_rate, avg_profit, total_trades, active_tokens }
 */
export async function ingestSmartWallet(wallet, profile) {
  return bradFetch("/smart-wallet", {
    method: "POST",
    body: JSON.stringify({
      wallet,
      win_rate: profile.winRate ?? profile.win_rate ?? 0,
      avg_profit: profile.avgProfit ?? profile.avg_profit ?? 0,
      total_trades: profile.totalTrades ?? profile.total_trades ?? 0,
      active_tokens: profile.activeTokens ?? profile.active_tokens ?? [],
    }),
  });
}

/**
 * Get BRAD's full cognitive state (for debugging/dashboard).
 * @returns {object|null} Full state including world model, self model, meta-cognitive
 */
export async function getState() {
  return bradFetch("/state", { timeout: 2000 });
}

/**
 * Get BRAD's combined consciousness + trading metrics.
 * @returns {object|null} { hofstadter_index, strange_loop_count, win_rate, ... }
 */
export async function getMetrics() {
  return bradFetch("/metrics", { timeout: 1000 });
}

/**
 * Get BRAD's current configuration.
 * @returns {object|null} Config object
 */
export async function getConfig() {
  return bradFetch("/config");
}

/**
 * Update BRAD's configuration at runtime.
 * @param {object} updates - { risk: {...}, scoring: {...}, strategy: {...} }
 */
export async function updateConfig(updates) {
  return bradFetch("/config", {
    method: "POST",
    body: JSON.stringify(updates),
  });
}

/**
 * Get recent decisions from BRAD's decision log.
 * @param {number} n - Number of recent decisions (default 20)
 * @returns {object|null} { decisions, stats }
 */
export async function getDecisions(n = 20) {
  return bradFetch(`/decisions?n=${n}`);
}

/**
 * Health check. Returns true if BRAD is running and responsive.
 */
export async function healthCheck() {
  const result = await bradFetch("/health", { timeout: 2000 });
  _healthy = result !== null;
  _lastHealthCheck = Date.now();
  if (_healthy) _consecutiveFailures = 0;
  return _healthy;
}

/**
 * Check if BRAD is currently healthy and responding.
 */
export function isHealthy() {
  return BRAD_ENABLED && _healthy;
}

/**
 * Check if BRAD integration is enabled.
 */
export function isEnabled() {
  return BRAD_ENABLED;
}

/**
 * Get BRAD client status for diagnostics.
 */
export function getClientStatus() {
  return {
    enabled: BRAD_ENABLED,
    healthy: _healthy,
    url: BRAD_URL,
    timeoutMs: BRAD_TIMEOUT_MS,
    consecutiveFailures: _consecutiveFailures,
    circuitBreakerOpen: _consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
    lastHealthCheck: _lastHealthCheck,
  };
}

// ═══ STARTUP ═══

/**
 * Initialize the BRAD client. Performs an initial health check.
 * Call this during server startup.
 */
export async function initBrad() {
  if (!BRAD_ENABLED) {
    console.log("[BRAD] Integration disabled (BRAD_ENABLED=false)");
    return false;
  }

  console.log(`[BRAD] Connecting to cognitive engine at ${BRAD_URL}...`);
  const healthy = await healthCheck();

  if (healthy) {
    console.log("[BRAD] Cognitive engine connected and healthy");
    const metrics = await getMetrics();
    if (metrics) {
      console.log(`[BRAD] Hofstadter Index: ${metrics.hofstadter_index?.toFixed(3) || "N/A"} | Strange Loops: ${metrics.strange_loop_count || 0} | Strategy: ${metrics.active_strategy || "unknown"}`);
    }
  } else {
    console.warn("[BRAD] Cognitive engine not available — bondli will run without BRAD reasoning layer");
    console.warn(`[BRAD] Start BRAD with: cd brad && python -m bondli_bridge --port 8421`);
  }

  return healthy;
}

// Default export for convenience
const bradClient = {
  evaluateToken,
  evaluatePosition,
  recordEntry,
  recordExit,
  recordPartialExit,
  updateRegime,
  ingestSmartWallet,
  getState,
  getMetrics,
  getConfig,
  updateConfig,
  getDecisions,
  healthCheck,
  isHealthy,
  isEnabled,
  getClientStatus,
  initBrad,
};

export default bradClient;
