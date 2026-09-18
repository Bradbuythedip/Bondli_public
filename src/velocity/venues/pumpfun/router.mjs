// ═══ VELOCITY — pump.fun routers (DP4) ═══
// Paper: exact constant-product bonding-curve fill with virtual reserves, so
// modeled slippage is the real slippage the curve would charge.
// Live: bondli's PumpFunClient builds and signs; rpc-enhanced smartSend races
// the primary RPC against Jito with a p75 priority fee. Loaded lazily so paper
// mode and tests never import the Solana stack.

import { PaperRouter, Router, failure } from "../../core/router.mjs";

export const PUMP_FEE_BPS = 100;               // 1% each way
const DEFAULT_VSOL = 30;                       // fresh curve virtual SOL
const DEFAULT_VTOKENS = 1_073_000_000;         // fresh curve virtual tokens
const TOTAL_SUPPLY = 1_000_000_000;

/** Reserves from what the radar exposes: vSol from the curve, vTokens from spot price. */
export function reservesFromReference(ref = {}) {
  const solPrice = Number(ref.solPrice) || 0;
  const vSol = Number(ref.vSolInBondingCurve) > 0 ? Number(ref.vSolInBondingCurve) : DEFAULT_VSOL;
  let vTokens = Number(ref.vTokensInBondingCurve) || 0;
  if (!vTokens) {
    const mcapSol = Number(ref.mcapSol) || (solPrice > 0 ? (Number(ref.mcapUsd) || 0) / solPrice : 0);
    const spot = mcapSol > 0 ? mcapSol / TOTAL_SUPPLY : vSol / DEFAULT_VTOKENS;
    vTokens = spot > 0 ? vSol / spot : DEFAULT_VTOKENS;
  }
  return { vSol, vTokens, solPrice };
}

export function curveBuy({ vSol, vTokens }, stakeSol) {
  const tokensOut = vTokens - (vSol * vTokens) / (vSol + stakeSol);
  const spot = vSol / vTokens;
  const avg = stakeSol / tokensOut;
  return { tokensOut, avgPrice: avg, spot, slippage_bps: (avg / spot - 1) * 1e4 };
}
export function curveSell({ vSol, vTokens }, tokensIn) {
  const solOut = vSol - (vSol * vTokens) / (vTokens + tokensIn);
  const spot = vSol / vTokens;
  const avg = solOut / tokensIn;
  return { solOut, avgPrice: avg, spot, slippage_bps: (1 - avg / spot) * 1e4 };
}

/** Paper has to pay what live pays, or every statistic it feeds is a lie in the same direction.
 *  Live pays, per side: the curve's 1%, the router's 0.5%, a priority fee and a base fee. It also pays
 *  the token account's rent on a new mint and takes it back when the position finally closes, so the
 *  rent nets out and only the extra base fee for that close is charged here. Before this, a paper buy
 *  booked cost_usd = stake_usd and a paper sell charged only the curve fee, which understated a round
 *  trip by about $0.12 — small against a $25 stake and fatal against a $5 one. */
const paperPrioritySol = () => Number(process.env.PRIORITY_FEE_SOL) > 0 ? Number(process.env.PRIORITY_FEE_SOL) : 0.0003;
export function pumpfunFillModel(order) {
  const { vSol, vTokens, solPrice } = reservesFromReference(order.reference || {});
  if (!(solPrice > 0)) return { reject: "NO_SOL_PRICE", reason: "reference has no solPrice" };
  const fee = PUMP_FEE_BPS / 1e4, portal = PUMP_PORTAL_FEE_BPS / 1e4;
  const perSendSol = paperPrioritySol() + BASE_FEE_SOL;
  if (order.side === "BUY") {
    const stakeSol = (Number(order.stake_usd) || 0) / solPrice;
    if (!(stakeSol > 0)) return { reject: "ZERO_STAKE", reason: "stake is zero" };
    const r = curveBuy({ vSol, vTokens }, stakeSol * (1 - fee));
    // What actually leaves the wallet: the stake, the router's cut, and the send.
    const spentSol = stakeSol * (1 + portal) + perSendSol;
    return { price: (spentSol * solPrice) / (r.tokensOut || 1), qty: r.tokensOut, notional_usd: +(spentSol * solPrice).toFixed(4), slippage_bps: r.slippage_bps, fee_usd: +((spentSol - stakeSol) * solPrice).toFixed(4) };
  }
  const qty = Number(order.qty) || 0;
  if (!(qty > 0)) return { reject: "ZERO_QTY", reason: "nothing to sell" };
  const r = curveSell({ vSol, vTokens }, qty);
  // What actually arrives: the curve's proceeds less both cuts, the send, and the account close.
  const netSol = Math.max(0, r.solOut * (1 - fee - portal) - perSendSol - BASE_FEE_SOL);
  return { price: qty > 0 ? (netSol * solPrice) / qty : 0, qty, notional_usd: +(netSol * solPrice).toFixed(4), slippage_bps: r.slippage_bps, fee_usd: +((r.solOut - netSol) * solPrice).toFixed(4) };
}

export class PumpfunPaperRouter extends PaperRouter {
  constructor({ bookFile, clock, latencyMs = 5 } = {}) {
    super({ venue: "pumpfun", clock, bookFile, fillModel: pumpfunFillModel, latencyMs });
  }
}

/** Request body for PumpPortal's free local transaction builder (the same path bondli's
 *  own trader uses). The returned transaction is signed locally; keys never leave the box. */
export function tradeLocalBody({ publicKey, action, mint, amount, denominatedInSol, slippagePct, priorityFeeSol, pool = "auto" }) {
  return { publicKey, action, mint, amount, denominatedInSol: denominatedInSol ? "true" : "false", slippage: slippagePct, priorityFee: priorityFeeSol, pool };
}

// What a pump.fun buy debits besides the SOL sent: pump's fee, the token account's rent (first
// buy of a mint), the base fee, and the rent-exempt floor the wallet itself must keep.
export const PUMP_PORTAL_FEE_BPS = 50;
export const RENT_ATA_SOL = 0.00203928;
export const RENT_WALLET_MIN_SOL = 0.00089088;
export const BASE_FEE_SOL = 0.000005;
export const BLOCKHASH_LIFETIME_MS = 90_000;   // a sent transaction can still land for about this long
export const SOL_PRICE_MAX_AGE_MS = 10 * 60_000;

/** SOL a buy of `solAmount` needs in the wallet. A SOL-denominated pump.fun buy may debit up to
 *  `slippagePct` more than the amount if the curve moves before it lands. `hasAccount` skips the
 *  token-account rent. */
export function solNeededForBuy(solAmount, { priorityFeeSol = 0.0003, hasAccount = false, slippagePct = 0 } = {}) {
  return solAmount * (1 + slippagePct / 100) * (1 + (PUMP_FEE_BPS + PUMP_PORTAL_FEE_BPS) / 1e4) + priorityFeeSol + BASE_FEE_SOL + (hasAccount ? 0 : RENT_ATA_SOL) + RENT_WALLET_MIN_SOL;
}

/** Exact wallet deltas of a confirmed transaction from its metadata: index 0 is the fee payer (us). */
export function walletDeltasFromMeta(meta, { mint, owner }) {
  if (!meta) return null;
  const sum = list => (list || []).filter(b => b.mint === mint && (!b.owner || b.owner === owner)).reduce((s, b) => s + (Number(b.uiTokenAmount?.uiAmount) || 0), 0);
  return { solDelta: ((meta.postBalances?.[0] ?? 0) - (meta.preBalances?.[0] ?? 0)) / 1e9, tokenDelta: sum(meta.postTokenBalances) - sum(meta.preTokenBalances), err: meta.err || null };
}

export class PumpfunLiveRouter extends Router {
  constructor({
    secret = process.env.MASTER_SEED, rpcUrl = process.env.RPC_URL, slippageBps = 300,
    // On-chain tolerance for our own transaction, separate from the envelope's modeled-impact cap:
    // bondli's trader has run at 15% for a reason (a fresh curve moves between build and land).
    buySlippagePct = Number(process.env.BUY_SLIPPAGE || 15), sellSlippagePct = Number(process.env.SELL_SLIPPAGE || 15),
    // An order holds the engine queue while it waits, and no other position can exit meanwhile:
    // wait a normal confirmation's worth, then hand the signature to the sweep (buys) or the next
    // exit attempt (sells), which settle it from the chain without blocking anyone.
    priorityFeeSol = Number(process.env.PRIORITY_FEE_SOL || 0.0003), confirmTimeoutMs = 12_000, lateConfirmMs = 0,
    tradeLocalUrl = "https://pumpportal.fun/api/trade-local", fetchImpl = globalThis.fetch, clock, sleep = ms => new Promise(r => setTimeout(r, ms)),
  } = {}) {
    super({ venue: "pumpfun", mode: "live", clock });
    this.secret = secret; this.rpcUrl = rpcUrl; this.slippageBps = slippageBps; this.buySlippagePct = buySlippagePct; this.sellSlippagePct = sellSlippagePct;
    this.priorityFeeSol = priorityFeeSol; this.confirmTimeoutMs = confirmTimeoutMs; this.lateConfirmMs = lateConfirmMs; this.tradeLocalUrl = tradeLocalUrl; this.fetch = fetchImpl; this.sleep = sleep;
    this.ready = false; this.publicKey = null;
  }

  async init() {
    // Resolved here, not in the constructor: the engine builds routers before an operator may have loaded .env.
    if (this.secret == null) this.secret = process.env.MASTER_SEED;
    if (this.rpcUrl == null) this.rpcUrl = process.env.RPC_URL;
    if (!this.secret) throw new Error("pumpfun live router needs MASTER_SEED (base58 secret key of a dedicated wallet) in .env");
    const [web3, bs58, cfg] = await Promise.all([import("@solana/web3.js"), import("bs58"), import("../../../engine/config.mjs")]);
    this.web3 = web3;
    this.bs58 = bs58.default || bs58;
    this.keypair = web3.Keypair.fromSecretKey(this.bs58.decode(this.secret.trim()));
    this.publicKey = this.keypair.publicKey.toBase58();
    this.connection = new web3.Connection(this.rpcUrl || cfg.default.RPC_URL, "confirmed");
    this.ready = true;
    return this.preflight();
  }

  /** What the operator sees before the first real order: wallet, balance, RPC. */
  async preflight() {
    if (!this.ready) throw new Error("call init() first");
    const t0 = Date.now();
    const lamports = await this.connection.getBalance(this.keypair.publicKey, "confirmed");
    return { wallet: this.publicKey, balanceSol: lamports / 1e9, rpc: String(this.rpcUrl || "").split("?")[0] || "default", rpcLatencyMs: Date.now() - t0 };
  }

  async _solBalance() { return (await this.connection.getBalance(this.keypair.publicKey, "confirmed")) / 1e9; }

  async _tokenBalance(mint) {
    const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
    const res = await this.connection.getParsedTokenAccountsByOwner(this.keypair.publicKey, { mint: new this.web3.PublicKey(mint) });
    let qty = 0;
    for (const a of res?.value || []) qty += Number(a.account.data.parsed.info.tokenAmount.uiAmount) || 0;
    return qty;
  }

  async _buildSignSend(body) {
    const res = await this.fetch(this.tradeLocalUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`trade builder ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < 100) throw new Error("trade builder returned an empty transaction");
    const tx = this.web3.VersionedTransaction.deserialize(bytes);
    tx.sign([this.keypair]);
    // The signature is ours before the RPC sees it: an RPC that forwards the transaction and then
    // drops the reply must not lose track of a transaction that can still land.
    let sig = null;
    try { sig = this.bs58 && tx.signatures?.[0] ? this.bs58.encode(tx.signatures[0]) : null; } catch { sig = null; }
    const t_sent = this.clock();
    try {
      sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    } catch (err) {
      if (sig) throw Object.assign(err, { sig, unconfirmed: true, t_sent });
      throw err;
    }
    let st;
    try { st = await this._awaitStatus(sig, this.confirmTimeoutMs); }
    catch (err) { throw Object.assign(err, { sig, unconfirmed: true, t_sent }); }
    if (st.err) throw this._chainError(sig, st.err);
    return { sig, t_sent, t_filled: st.confirmed ? this.clock() : null, unconfirmed: !st.confirmed };
  }

  /** A thrown error after a send: the transaction may still land, so it is UNCONFIRMED, not failed. */
  _sendFailure(order, err, solPrice) {
    if (err.unconfirmed && err.sig) return failure(order, "UNCONFIRMED", `${err.message}; tx ${err.sig} may still land`, { venue_ref: err.sig, t_sent: err.t_sent || null });
    return failure(order, "SEND_FAILED", err.message, { venue_ref: err.sig || null, fee_usd: err.fee_sol > 0 ? +(err.fee_sol * solPrice).toFixed(4) : 0 });
  }

  _chainError(sig, err) {
    // A transaction that executed and failed still paid its fees.
    const e = new Error(`tx ${sig} failed on chain: ${JSON.stringify(err)}`);
    e.sig = sig; e.fee_sol = this.priorityFeeSol + BASE_FEE_SOL;
    return e;
  }

  /** Poll one signature until it confirms, fails, or the budget runs out. */
  async _awaitStatus(sig, budgetMs, { history = false } = {}) {
    const deadline = Date.now() + budgetMs;
    do {
      const st = await this.connection.getSignatureStatuses([sig], history ? { searchTransactionHistory: true } : undefined);
      const v = st?.value?.[0];
      if (v?.err) return { confirmed: false, err: v.err };
      if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return { confirmed: true, err: null };
      if (Date.now() >= deadline) break;
      await this.sleep(400);
    } while (true);
    return { confirmed: false, err: null };
  }

  /** Exact deltas from the confirmed transaction; null when the RPC does not have it yet. */
  async _txDeltas(sig, mint) {
    const tx = await this.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return walletDeltasFromMeta(tx?.meta, { mint, owner: this.publicKey });
  }

  /** Deltas for a confirmed transaction: the transaction record first, then balance reads that
   *  are retried until they move (a load-balanced RPC can answer from a node behind the slot). */
  async _settle(sig, mint, { solBefore, qtyBefore, expectSign }) {
    const d = await this._txDeltas(sig, mint).catch(() => null);
    if (d && !d.err && (expectSign === 0 || Math.sign(d.tokenDelta) === expectSign)) return { solDelta: d.solDelta, tokenDelta: d.tokenDelta, exact: true };
    let solAfter = solBefore, qtyAfter = qtyBefore;
    for (let i = 0; i < 8; i++) {
      [solAfter, qtyAfter] = await Promise.all([this._solBalance().catch(() => solBefore), this._tokenBalance(mint).catch(() => null)]);
      // Both legs must have moved: a token read from one node and a SOL read from a node behind it
      // would book a sell with zero proceeds.
      const tokensMoved = qtyAfter != null && qtyAfter !== qtyBefore;
      const solMoved = expectSign < 0 ? solAfter > solBefore : solAfter < solBefore;
      if (tokensMoved && solMoved) break;
      await this.sleep(400);
    }
    return { solDelta: solAfter - solBefore, tokenDelta: qtyAfter == null ? null : qtyAfter - qtyBefore, exact: false };
  }

  /** The wallet's balance of a mint, re-read a few times before a zero is believed. */
  async _tokenBalanceSettled(mint, { reads = 5 } = {}) {
    let qty = 0;
    for (let i = 0; i < reads; i++) {
      qty = await this._tokenBalance(mint);
      if (qty > 0) return qty;
      if (i < reads - 1) await this.sleep(400);
    }
    return qty;
  }

  /** A signature sent earlier: did it land? Used for buys and sells that outlived their timeout. */
  /** The wallet holds none of a mint and the engine has no pending signature for it. Before that is
   *  booked as a total loss, look for the sale on chain: a manual sell, or one of ours whose
   *  signature we lost, still put SOL in the wallet. Scans the mint's own token account history, so
   *  it reads a handful of transactions rather than the whole wallet.
   *  Returns { sig, solReceived, qty, at } for the most recent outgoing transfer since `since`, or
   *  null when nothing explains where the tokens went. */
  async findRecentSale(mint, { since = 0, limit = 25 } = {}) {
    if (!this.ready) return null;
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    let ata;
    try { ata = getAssociatedTokenAddressSync(new this.web3.PublicKey(mint), this.keypair.publicKey, true); }
    catch { return null; }
    let sigs;
    try { sigs = await this.connection.getSignaturesForAddress(ata, { limit }); } catch { return null; }
    // Newest first, and only what happened after we bought: an older sale is a different position.
    for (const s of sigs || []) {
      if (s.err) continue;
      const at = s.blockTime ? s.blockTime * 1000 : null;
      if (since && at && at < since) break;
      const d = await this._txDeltas(s.signature, mint).catch(() => null);
      if (!d || d.err) continue;
      if (!(d.tokenDelta < 0)) continue; // a buy, or the account being closed
      return { sig: s.signature, solReceived: Math.max(0, d.solDelta), qty: -d.tokenDelta, at: at || this.clock() };
    }
    return null;
  }

  async resolvePending({ instrument, side, sig, at, reference = {}, qtyHint = 0, stakeUsd = 0 }) {
    if (!this.ready) return failure({ id: sig }, "NOT_READY", "call init() first");
    const st = await this._awaitStatus(sig, 0, { history: true });
    const solPrice = Number(reference?.solPrice) || 0;
    if (st.err) return failure({ id: sig }, "SEND_FAILED", `tx ${sig} failed on chain: ${JSON.stringify(st.err)}`, { expired: true, venue_ref: sig, fee_usd: +((this.priorityFeeSol + BASE_FEE_SOL) * solPrice).toFixed(4) });
    const age = this.clock() - (at || 0);
    if (!st.confirmed) {
      const expired = age > BLOCKHASH_LIFETIME_MS;
      return failure({ id: sig }, expired ? "EXPIRED" : "UNCONFIRMED", expired ? `tx ${sig} never landed` : `tx ${sig} still unconfirmed`, { expired, venue_ref: sig });
    }
    let d = await this._txDeltas(sig, instrument).catch(() => null);
    const t = this.clock();
    if (!d) {
      if (age <= BLOCKHASH_LIFETIME_MS) return failure({ id: sig }, "UNCONFIRMED", `tx ${sig} confirmed but not yet readable`, { venue_ref: sig });
      // Confirmed, still unreadable long after: book the curve model's estimate rather than nothing.
      const est = side === "BUY"
        ? pumpfunFillModel({ side: "BUY", stake_usd: stakeUsd, reference })
        : pumpfunFillModel({ side: "SELL", qty: qtyHint, reference });
      if (est.reject) return failure({ id: sig }, "UNCONFIRMED", `tx ${sig} confirmed but unreadable and no estimate (${est.reason})`, { venue_ref: sig });
      const solOf = usd => (solPrice > 0 ? usd / solPrice : 0);
      d = side === "BUY" ? { solDelta: -solOf(est.notional_usd + est.fee_usd), tokenDelta: est.qty, estimated: true } : { solDelta: solOf(est.notional_usd), tokenDelta: -est.qty, estimated: true };
    }
    if (side === "BUY") {
      const costSol = Math.max(0, -d.solDelta), qty = Math.max(0, d.tokenDelta);
      if (!(qty > 0)) return failure({ id: sig }, "EXPIRED", `tx ${sig} landed without tokens`, { expired: true, venue_ref: sig });
      return { ok: true, fill: { venue: "pumpfun", instrument, side: "BUY", price: (costSol * solPrice) / qty, qty, notional_usd: +(costSol * solPrice).toFixed(4), slippage_bps: null, fee_usd: 0, t_sent: at || t, t_filled: t, latency_ms: at ? t - at : 0, venue_ref: sig, sol_spent: costSol, late: true, estimated: !!d.estimated } };
    }
    const proceedsSol = Math.max(0, d.solDelta), qty = Math.max(0, -d.tokenDelta);
    return { ok: true, fill: { venue: "pumpfun", instrument, side: "SELL", price: qty > 0 ? (proceedsSol * solPrice) / qty : 0, qty, notional_usd: +(proceedsSol * solPrice).toFixed(4), slippage_bps: null, fee_usd: 0, t_sent: at || t, t_filled: t, latency_ms: at ? t - at : 0, venue_ref: sig, sol_received: proceedsSol, late: true, estimated: !!d.estimated } };
  }

  async submit(order) {
    if (!this.ready) return failure(order, "NOT_READY", "call init() first");
    if (order.legs?.length) return failure(order, "UNSUPPORTED", "pump.fun has no multi-leg orders");
    const solPrice = Number(order.reference?.solPrice) || 0;
    if (!(solPrice > 0)) return failure(order, "NO_SOL_PRICE", "reference has no solPrice");
    const est = pumpfunFillModel({ ...order, side: "BUY" }); // entries are always buys
    if (est.reject) return failure(order, est.reject, est.reason);
    if (Number.isFinite(order.max_slippage_bps) && est.slippage_bps > order.max_slippage_bps)
      return failure(order, "SLIPPAGE_CAP", `curve slippage ${est.slippage_bps.toFixed(1)}bps > cap ${order.max_slippage_bps}bps`);
    // The stake is converted to SOL at the radar's price: without a fresh fetch stamp that price
    // may be bondli's hard-coded default, and the order would be the wrong size.
    const priceAt = Number(order.reference?.solPriceAt) || 0;
    if (!(priceAt > 0)) return failure(order, "STALE_SOL_PRICE", "bondli has not fetched a SOL price yet (no solPriceAt); refusing to size in SOL");
    if (this.clock() - priceAt > SOL_PRICE_MAX_AGE_MS) return failure(order, "STALE_SOL_PRICE", `SOL price is ${Math.round((this.clock() - priceAt) / 60000)} min old; sizing in SOL would be wrong`);
    const solAmount = +(Number(order.stake_usd) / solPrice).toFixed(6);
    let sig = null;
    try {
      const [solBefore, qtyBefore] = await Promise.all([this._solBalance(), this._tokenBalance(order.instrument).catch(() => 0)]);
      const need = solNeededForBuy(solAmount, { priorityFeeSol: this.priorityFeeSol, hasAccount: qtyBefore > 0, slippagePct: this.buySlippagePct });
      if (solBefore < need) return failure(order, "INSUFFICIENT_SOL", `wallet has ${solBefore.toFixed(4)} SOL, order needs ${need.toFixed(4)}`);
      const body = tradeLocalBody({ publicKey: this.publicKey, action: "buy", mint: order.instrument, amount: solAmount, denominatedInSol: true, slippagePct: this.buySlippagePct, priorityFeeSol: this.priorityFeeSol });
      const sent = await this._buildSignSend(body);
      sig = sent.sig;
      let t_filled = sent.t_filled;
      if (sent.unconfirmed) {
        const st = this.lateConfirmMs > 0 ? await this._awaitStatus(sig, this.lateConfirmMs) : { confirmed: false, err: null };
        if (st.err) throw this._chainError(sig, st.err);
        // Not confirmed in time: the sweep settles it from the signature without holding the queue.
        if (!st.confirmed) return failure(order, "UNCONFIRMED", `tx ${sig} not confirmed within ${this.confirmTimeoutMs + this.lateConfirmMs}ms`, { venue_ref: sig, t_sent: sent.t_sent });
        t_filled = this.clock();
      }
      const d = await this._settle(sig, order.instrument, { solBefore, qtyBefore, expectSign: 1 });
      const costSol = Math.max(0, -d.solDelta);
      const qty = d.tokenDelta > 0 ? d.tokenDelta : est.qty;
      // No readable delta yet: book the expected outflow rather than zero, so exposure is never understated.
      const estCostSol = solNeededForBuy(solAmount, { priorityFeeSol: this.priorityFeeSol, hasAccount: qtyBefore > 0 }) - RENT_WALLET_MIN_SOL;
      const notional = +((costSol > 0 ? costSol : estCostSol) * solPrice).toFixed(4);
      return { ok: true, fill: { orderId: order.id, decisionId: order.decisionId || null, venue: "pumpfun", instrument: order.instrument, side: "BUY", price: qty > 0 ? notional / qty : est.price, qty, notional_usd: +notional.toFixed(4), slippage_bps: +est.slippage_bps.toFixed(2), fee_usd: +(Math.max(0, costSol - solAmount) * solPrice).toFixed(4), t_sent: sent.t_sent, t_filled, latency_ms: t_filled - sent.t_sent, venue_ref: sig, sol_spent: costSol, exact: d.exact } };
    } catch (err) {
      return this._sendFailure(order, err, solPrice);
    }
  }

  async close(position, pct = 100, ctx = {}) {
    if (!this.ready) return failure({ id: position.id }, "NOT_READY", "call init() first");
    const solPrice = Number(ctx.reference?.solPrice || position.reference?.solPrice) || 0;
    let sig = null;
    try {
      // A sell sent earlier that outlived its timeout: settle it before selling again.
      if (position.pendingExit?.sig) {
        const pendPct = Number(position.pendingExit.pct) || 100;
        const prev = await this.resolvePending({ instrument: position.instrument, side: "SELL", sig: position.pendingExit.sig, at: position.pendingExit.at, reference: { ...(ctx.reference || position.reference || {}), solPrice }, qtyHint: (Number(position.remaining_qty ?? position.qty) || 0) * pendPct / 100 });
        if (prev.ok) return { ...prev, fill: { ...prev.fill, orderId: `${position.id}:close`, decisionId: position.decisionId, pending_pct: pendPct } };
        if (!prev.failure.expired) return prev; // still in flight: do not sell twice
      }
      // One empty read from a node behind the slot is not proof the tokens are gone.
      const qtyBefore = await this._tokenBalanceSettled(position.instrument);
      if (!(qtyBefore > 0)) return failure({ id: position.id }, "NO_POSITION", "no token balance to sell");
      const solBefore = await this._solBalance();
      const p = Math.min(100, Math.max(1, Math.round(pct)));
      const body = tradeLocalBody({ publicKey: this.publicKey, action: "sell", mint: position.instrument, amount: `${p}%`, denominatedInSol: false, slippagePct: this.sellSlippagePct, priorityFeeSol: this.priorityFeeSol });
      const sent = await this._buildSignSend(body);
      sig = sent.sig;
      let t_filled = sent.t_filled;
      if (sent.unconfirmed) {
        const st = this.lateConfirmMs > 0 ? await this._awaitStatus(sig, this.lateConfirmMs) : { confirmed: false, err: null };
        if (st.err) throw this._chainError(sig, st.err);
        if (!st.confirmed) return failure({ id: position.id }, "UNCONFIRMED", `tx ${sig} not confirmed within ${this.confirmTimeoutMs + this.lateConfirmMs}ms`, { venue_ref: sig, t_sent: sent.t_sent });
        t_filled = this.clock();
      }
      const d = await this._settle(sig, position.instrument, { solBefore, qtyBefore, expectSign: -1 });
      // Tokens left but no SOL is visible yet: never book a sale at zero. The next attempt reads
      // the transaction itself.
      if (!(d.solDelta > 0) && d.tokenDelta != null && d.tokenDelta < 0) return failure({ id: position.id }, "UNCONFIRMED", `tx ${sig} sold ${-d.tokenDelta} tokens but proceeds are not readable yet`, { venue_ref: sig, t_sent: sent.t_sent });
      const proceedsSol = Math.max(0, d.solDelta);
      // A post-trade token read that failed says nothing: sold what was asked, not everything.
      const qty = d.tokenDelta == null ? qtyBefore * p / 100 : (Math.max(0, -d.tokenDelta) || qtyBefore * p / 100);
      return { ok: true, fill: { orderId: `${position.id}:close`, decisionId: position.decisionId, venue: "pumpfun", instrument: position.instrument, side: "SELL", price: qty > 0 ? (proceedsSol * solPrice) / qty : 0, qty, notional_usd: +(proceedsSol * solPrice).toFixed(4), slippage_bps: null, fee_usd: 0, t_sent: sent.t_sent, t_filled, latency_ms: t_filled - sent.t_sent, venue_ref: sig, sol_received: proceedsSol, exact: d.exact } };
    } catch (err) {
      return this._sendFailure({ id: position.id }, err, solPrice);
    }
  }

  /** Take back the rent on an emptied token account. Every new mint costs RENT_ATA_SOL (0.00203928 SOL,
   *  about $0.41 at $200) to open an account for, and a sell leaves that account open with the rent
   *  locked inside it. One small transaction closes it and returns the rent, for the price of a base
   *  fee (0.000005 SOL). At a $25 stake that rent is 1.6% of the trade, so this is the single largest
   *  cost the bot pays and the only one it can simply refuse to pay.
   *
   *  Only accounts whose balance is exactly zero are closed, so this can never destroy a holding: the
   *  token program itself rejects closing a non-empty account, and the filter here means we never ask. */
  async closeTokenAccount(mint) {
    if (!this.ready) throw new Error("call init() first");
    const { TOKEN_PROGRAM_ID, createCloseAccountInstruction } = await import("@solana/spl-token");
    const res = await this.connection.getParsedTokenAccountsByOwner(this.keypair.publicKey, { mint: new this.web3.PublicKey(mint) });
    const empty = (res?.value || []).filter(a => Number(a.account.data.parsed.info.tokenAmount.amount || 0) === 0);
    if (!empty.length) return { closed: 0, reclaimed_sol: 0, sig: null };
    const { Transaction } = this.web3;
    const tx = new Transaction();
    for (const a of empty.slice(0, 8)) tx.add(createCloseAccountInstruction(a.pubkey, this.keypair.publicKey, this.keypair.publicKey, [], TOKEN_PROGRAM_ID));
    tx.feePayer = this.keypair.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(this.keypair);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const st = await this._awaitStatus(sig, this.confirmTimeoutMs);
    if (st.err) throw this._chainError(sig, st.err);
    const n = Math.min(empty.length, 8);
    return { closed: n, reclaimed_sol: +(n * RENT_ATA_SOL - BASE_FEE_SOL).toFixed(9), sig };
  }

  /** Plain SOL transfer from the trading wallet (the platform's performance fee). Returns the signature. */
  async transferSol(toPubkey, sol) {
    if (!this.ready) throw new Error("call init() first");
    const lamports = Math.floor(Number(sol) * 1e9);
    if (!(lamports > 0)) throw new Error("transfer amount must be positive");
    const { SystemProgram, Transaction, PublicKey } = this.web3;
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: this.keypair.publicKey, toPubkey: new PublicKey(toPubkey), lamports }));
    tx.feePayer = this.keypair.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(this.keypair);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const st = await this._awaitStatus(sig, this.confirmTimeoutMs);
    if (st.err) throw this._chainError(sig, st.err);
    return sig;
  }

  async health() {
    if (!this.ready) return { ok: false, latencyMs: null, detail: "not initialized" };
    const t0 = Date.now();
    try { await this.connection.getLatestBlockhash("confirmed"); return { ok: true, latencyMs: Date.now() - t0, detail: "rpc ok" }; }
    catch (err) { return { ok: false, latencyMs: Date.now() - t0, detail: err.message }; }
  }

  async positions() {
    if (!this.ready) return [];
    const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
    const res = await this.connection.getParsedTokenAccountsByOwner(this.keypair.publicKey, { programId: TOKEN_PROGRAM_ID });
    return (res?.value || []).map(a => ({ instrument: a.account.data.parsed.info.mint, qty: Number(a.account.data.parsed.info.tokenAmount.uiAmount) || 0 })).filter(p => p.qty > 0);
  }
}
