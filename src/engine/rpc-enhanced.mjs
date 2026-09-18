// BONDLI v4.4 — RPC Enhanced (Priority Fees + Jito Bundles + Multi-RPC + Dedup)
import bs58 from "bs58";
import CONFIG from "./config.mjs";

// ── Priority fee cache ──
let _cachedPriorityFee = CONFIG.PRIORITY_FEE;
let _priorityFeeTs = 0;
const PRIORITY_FEE_TTL = 10_000;

// ── Blockhash cache ──
let _cachedBlockhash = null;
let _cachedBlockHeight = 0;
let _blockhashTs = 0;
const BLOCKHASH_TTL = 4_000;

export async function getCachedBlockhash(connection) {
  if (_cachedBlockhash && Date.now() - _blockhashTs < BLOCKHASH_TTL) {
    return { blockhash: _cachedBlockhash, lastValidBlockHeight: _cachedBlockHeight };
  }
  const result = await connection.getLatestBlockhash("confirmed");
  _cachedBlockhash = result.blockhash;
  _cachedBlockHeight = result.lastValidBlockHeight;
  _blockhashTs = Date.now();
  return result;
}

// ── Jito ──
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bPg4W6U6viQCi4LfbCR5iV",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSouaMnkQ3JrqERm9Hx",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

// Two Jito endpoints — mainnet (US) + closest regional
const JITO_ENDPOINTS = [
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
];

export async function getOptimalPriorityFee(accountKeys = []) {
  if (Date.now() - _priorityFeeTs < PRIORITY_FEE_TTL) return _cachedPriorityFee;
  try {
    const response = await fetch(CONFIG.RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getRecentPrioritizationFees",
        params: accountKeys.length > 0 ? [accountKeys] : [],
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const data = await response.json();
      if (data.result && data.result.length > 0) {
        const fees = data.result.map(f => f.prioritizationFee).sort((a, b) => a - b);
        const p75 = fees[Math.floor(fees.length * 0.75)] || fees[fees.length - 1];
        _cachedPriorityFee = Math.max(5_000, Math.min(100_000, Math.ceil(p75)));
        _priorityFeeTs = Date.now();
        return _cachedPriorityFee;
      }
    }
  } catch (e) {
    console.warn(`[RPC] Priority fee estimate failed: ${e.message}`);
  }
  return _cachedPriorityFee;
}

// Send to a single Jito endpoint
async function jitoSendSingle(base58Tx, endpoint) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[base58Tx]] }),
    signal: AbortSignal.timeout(6000),
  });
  if (res.ok) {
    const data = await res.json();
    if (data.result) return data.result;
    if (data.error) throw new Error(JSON.stringify(data.error));
  }
  throw new Error("Jito not ok");
}

// Send via Jito — race 2 endpoints
export async function jitoSend(serializedTx) {
  const base58Tx = bs58.encode(serializedTx);
  try {
    const result = await Promise.any(
      JITO_ENDPOINTS.map(ep => jitoSendSingle(base58Tx, ep))
    );
    return result;
  } catch {
    return null;
  }
}

export function getJitoTipAccount() {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

// Multi-RPC failover URLs
const RPC_URLS = [CONFIG.RPC_URL];
if (process.env.BACKUP_RPC_URL) RPC_URLS.push(process.env.BACKUP_RPC_URL);
if (process.env.BACKUP_RPC_URL_2) RPC_URLS.push(process.env.BACKUP_RPC_URL_2);

// Stats
const _sendStats = { total: 0, rpcOk: 0, jitoOk: 0, fallbackOk: 0, failed: 0 };

// Dedup: track recently sent tx signatures to prevent double-send
const _recentSends = new Map(); // sig → timestamp
const DEDUP_WINDOW_MS = 30_000; // 30s dedup window

function cleanDedup() {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [sig, ts] of _recentSends) {
    if (ts < cutoff) _recentSends.delete(sig);
  }
}

/**
 * Send transaction via primary RPC + Jito, no excessive retries.
 *
 * Strategy:
 *   1. Send to primary RPC + Jito simultaneously (Promise.any)
 *   2. RPC maxRetries: 3 (NOT 8 — Solana validators handle retry internally)
 *   3. No application-level retry — if both fail, throw immediately
 *   4. Dedup guard: same serialized tx won't be sent twice within 30s
 */
export async function smartSend(connection, serializedTx, opts = {}) {
  _sendStats.total++;

  // Dedup check
  const sigPreview = bs58.encode(serializedTx).slice(0, 32);
  if (_recentSends.has(sigPreview)) {
    console.warn(`[RPC-TX] Dedup: tx already sent within ${DEDUP_WINDOW_MS / 1000}s, skipping`);
    return _recentSends.get(sigPreview); // return the previous sig
  }

  const base58Tx = bs58.encode(serializedTx);

  const rpcSend = async (rpcUrl) => {
    const res = await fetch(rpcUrl, {
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
      if (data.result) { _sendStats.rpcOk++; return data.result; }
      if (data.error) {
        const errMsg = JSON.stringify(data.error);
        throw new Error(errMsg);
      }
    }
    throw new Error("RPC response not ok");
  };

  // Send to primary RPC + Jito simultaneously — first success wins
  const candidates = [
    rpcSend(RPC_URLS[0]),
    jitoSend(serializedTx).then(r => { if (!r) throw new Error("Jito failed"); _sendStats.jitoOk++; return r; }),
  ];
  // Add backup RPC if configured (but don't spam 5 endpoints)
  if (RPC_URLS.length > 1) candidates.push(rpcSend(RPC_URLS[1]));

  try {
    const sig = await Promise.any(candidates);
    // Record for dedup
    _recentSends.set(sigPreview, sig);
    cleanDedup();
    return sig;
  } catch (err) {
    // All failed — one last try via connection object
    console.warn("[RPC-TX] Primary paths failed, using connection fallback");
    try {
      const sig = await connection.sendRawTransaction(serializedTx, {
        skipPreflight: true,
        maxRetries: 3,
        ...opts,
      });
      _sendStats.fallbackOk++;
      _recentSends.set(sigPreview, sig);
      cleanDedup();
      return sig;
    } catch (e) {
      _sendStats.failed++;
      throw e;
    }
  }
}

export function getSendStats() {
  return { ..._sendStats, dedupSize: _recentSends.size };
}

export async function getTokenMetadata(mintAddress) {
  try {
    const res = await fetch(CONFIG.RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getAccountInfo",
        params: [mintAddress, { encoding: "jsonParsed" }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      return data.result?.value || null;
    }
  } catch {}
  return null;
}

export default { getOptimalPriorityFee, smartSend, jitoSend, getJitoTipAccount, getTokenMetadata, getCachedBlockhash, getSendStats };
