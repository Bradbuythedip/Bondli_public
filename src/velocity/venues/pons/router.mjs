// ═══ PONS routers: paper (curve model) and live (ethers wallet on Robinhood Chain) (DP4) ═══
// Fill records keep the engine's field names: sol_spent / sol_received are the QUOTE asset (ETH)
// spent and received, gas included, and reference.solPrice is the ETH price in USD.
import { Wallet, JsonRpcProvider, Contract, MaxUint256, Interface } from "ethers";
import { PaperRouter, Router, failure } from "../../core/router.mjs";
import { EXPLORER, FACTORY, FACTORY_ABI, CURVE_ABI, ERC20_ABI, DEFAULT_RPC_URL, CHAIN_ID, TOPICS, curveBuyQuote, curveSellQuote, decodeLog, toEth, toWei, toTokens, TOKEN_DECIMALS } from "./chain.mjs";

const PRICE_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_RESERVES = { quoteReserve: 3, tokenReserve: 1_000_000_000, feeBps: 100, creatorTaxBps: 0 };
// The worst price a sell may ever accept, as a share of the curve's own quote for that exact size.
// Below this the trade is not worth making at all: the position is better left open for one more
// tick than handed over at a price nobody would agree to in advance.
const MIN_SELL_KEEP = 0.85;

function reserves(ref = {}) {
  const c = ref.curve || {};
  const quoteReserve = Number(c.quoteReserve) > 0 ? Number(c.quoteReserve) : DEFAULT_RESERVES.quoteReserve;
  const tokenReserve = Number(c.tokenReserve) > 0 ? Number(c.tokenReserve) : DEFAULT_RESERVES.tokenReserve;
  return { quoteReserve, tokenReserve, feeBps: (Number(c.feeBps) || DEFAULT_RESERVES.feeBps) + (Number(c.creatorTaxBps) || 0) };
}

export function ponsFillModel(order) {
  const price = Number(order.reference?.solPrice) || 0;
  if (!(price > 0)) return { reject: "NO_QUOTE_PRICE", reason: "reference has no ETH price" };
  const r = reserves(order.reference);
  if (order.side === "BUY") {
    const quoteIn = (Number(order.stake_usd) || 0) / price;
    if (!(quoteIn > 0)) return { reject: "ZERO_STAKE", reason: "stake is zero" };
    const q = curveBuyQuote(r, quoteIn, r.feeBps);
    return { price: q.avgPrice * price, qty: q.tokensOut, notional_usd: Number(order.stake_usd), slippage_bps: q.slippage_bps, fee_usd: q.feeQuote * price };
  }
  const qty = Number(order.qty) || 0;
  if (!(qty > 0)) return { reject: "ZERO_QTY", reason: "nothing to sell" };
  const q = curveSellQuote(r, qty, r.feeBps);
  return { price: q.avgPrice * price, qty, notional_usd: q.quoteOut * price, slippage_bps: q.slippage_bps, fee_usd: q.feeQuote * price };
}

export class PonsPaperRouter extends PaperRouter {
  constructor({ bookFile, clock, latencyMs = 5 } = {}) { super({ venue: "pons", clock, bookFile, fillModel: ponsFillModel, latencyMs }); }
}

/** A live router on an EVM wallet. `secret` is the 0x-prefixed private key of a dedicated wallet. */
export class PonsLiveRouter extends Router {
  constructor({ secret = null, rpcUrl = null, provider = null, slippagePct = 15, confirmTimeoutMs = 25_000, gasLimitBuy = 400_000n, gasLimitSell = 350_000n, clock, fetchImpl = globalThis.fetch } = {}) {
    super({ venue: "pons", mode: "live", clock });
    this.secret = secret; this.rpcUrl = rpcUrl; this.provider = provider; this.slippagePct = slippagePct; this.confirmTimeoutMs = confirmTimeoutMs;
    this.gasLimitBuy = gasLimitBuy; this.gasLimitSell = gasLimitSell;
    // The explorer and the signature database are the only things this router reads off-chain, and both
    // are best effort: they name a revert, they never decide a trade. Injectable so a test is
    // hermetic -- a suite that reaches the internet passes or fails on somebody else's uptime.
    this.fetch = fetchImpl;
    this.ready = false; this.address = null; this.known = new Set(); this._curves = new Map(); // tokens this wallet has been told about (EVM has no account enumeration)
  }

  async init() {
    if (this.secret == null) this.secret = process.env.PONS_PRIVATE_KEY;
    if (this.rpcUrl == null) this.rpcUrl = process.env.PONS_RPC_URL || DEFAULT_RPC_URL;
    if (!this.secret) throw new Error("pons live router needs an EVM private key (PONS_PRIVATE_KEY, 0x-hex) for a dedicated wallet");
    if (!this.provider) this.provider = new JsonRpcProvider(this.rpcUrl, { chainId: CHAIN_ID, name: "robinhood" }, { staticNetwork: true });
    this.wallet = new Wallet(this.secret.trim(), this.provider);
    this.address = this.wallet.address;
    this.ready = true;
    return this.preflight();
  }

  async preflight() {
    if (!this.ready) throw new Error("call init() first");
    const t0 = Date.now();
    const wei = await this.provider.getBalance(this.address);
    const balanceSol = toEth(wei); // the engine's name for "quote balance"
    return { wallet: this.address, balanceSol, balanceEth: balanceSol, quote: "ETH", rpc: String(this.rpcUrl || "").split("?")[0], rpcLatencyMs: Date.now() - t0, chainId: CHAIN_ID };
  }

  track(token) { this.known.add(String(token).toLowerCase()); }
  async _quoteBalance() { return toEth(await this.provider.getBalance(this.address)); }
  async _tokenBalance(token) { const c = new Contract(token, ERC20_ABI, this.provider); return toTokens(await c.balanceOf(this.address)); }

  async _waitReceipt(hash, budgetMs) {
    const deadline = this.clock() + budgetMs;
    while (this.clock() < deadline) {
      const r = await this.provider.getTransactionReceipt(hash).catch(() => null);
      if (r) return r;
      await new Promise(res => setTimeout(res, 800));
    }
    return null;
  }

  /** The trade this receipt carried for `curve`, plus the gas it burned, in ETH. */
  _receiptDeltas(receipt, curve) {
    const gasEth = receipt.gasUsed != null && (receipt.gasPrice ?? receipt.effectiveGasPrice) != null ? toEth(BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice ?? receipt.effectiveGasPrice)) : 0;
    const trade = (receipt.logs || []).filter(l => String(l.address).toLowerCase() === String(curve).toLowerCase()).map(decodeLog).find(r => r && (r.kind === "buy" || r.kind === "sell")) || null;
    return { gasEth, trade, reverted: receipt.status === 0 };
  }

  async submit(order) {
    if (!this.ready) return failure(order, "NOT_READY", "call init() first");
    if (order.legs?.length) return failure(order, "UNSUPPORTED", "pons has no multi-leg orders");
    const ref = order.reference || {}, price = Number(ref.solPrice) || 0, curveAddr = ref.curve?.address;
    if (!(price > 0)) return failure(order, "NO_QUOTE_PRICE", "reference has no ETH price");
    if (!curveAddr) return failure(order, "NO_CURVE", "reference has no bonding curve address");
    const priceAt = Number(ref.solPriceAt) || 0;
    if (!(priceAt > 0) || this.clock() - priceAt > PRICE_MAX_AGE_MS) return failure(order, "STALE_QUOTE_PRICE", "ETH price is missing or older than 5 minutes; refusing to size in ETH");
    if (ref.curve?.native === false) return failure(order, "UNSUPPORTED", "this launch is quoted in an ERC-20, not ETH");
    const est = ponsFillModel({ ...order, side: "BUY" });
    if (est.reject) return failure(order, est.reject, est.reason);
    if (Number.isFinite(order.max_slippage_bps) && est.slippage_bps > order.max_slippage_bps) return failure(order, "SLIPPAGE_CAP", `curve slippage ${est.slippage_bps.toFixed(1)}bps > cap ${order.max_slippage_bps}bps`);
    const quoteIn = +(Number(order.stake_usd) / price).toFixed(9);
    const t_sent = this.clock();
    let hash = null;
    try {
      const bal = await this._quoteBalance();
      if (bal < quoteIn + 0.0003) return failure(order, "INSUFFICIENT_SOL", `wallet has ${bal.toFixed(5)} ETH, order needs ${(quoteIn + 0.0003).toFixed(5)} with gas`);
      const curve = new Contract(curveAddr, CURVE_ABI, this.wallet);
      const minOut = BigInt(Math.floor(est.qty * (1 - this.slippagePct / 100) * 1e6)) * 10n ** BigInt(TOKEN_DECIMALS - 6);
      const tx = await curve.buy(toWei(quoteIn), minOut, this.address, { value: toWei(quoteIn), gasLimit: this.gasLimitBuy });
      hash = tx.hash; this.track(order.instrument);
      const receipt = await this._waitReceipt(hash, this.confirmTimeoutMs);
      if (!receipt) return failure(order, "UNCONFIRMED", `tx ${hash} not confirmed within ${this.confirmTimeoutMs}ms`, { venue_ref: hash, t_sent });
      const d = this._receiptDeltas(receipt, curveAddr);
      if (d.reverted) return failure(order, "SEND_FAILED", `tx ${hash} reverted`, { venue_ref: hash, fee_usd: d.gasEth * price });
      const t_filled = this.clock();
      const qty = d.trade?.tokens || est.qty;
      const spent = (d.trade ? d.trade.quote : quoteIn) + d.gasEth;
      return { ok: true, fill: { orderId: order.id, decisionId: order.decisionId || null, venue: "pons", instrument: order.instrument, side: "BUY", price: qty > 0 ? (spent * price) / qty : est.price, qty, notional_usd: +(spent * price).toFixed(4), slippage_bps: +est.slippage_bps.toFixed(2), fee_usd: +(((d.trade?.fee || 0) + (d.trade?.tax || 0) + d.gasEth) * price).toFixed(4), t_sent, t_filled, latency_ms: t_filled - t_sent, venue_ref: hash, sol_spent: spent, exact: !!d.trade } };
    } catch (err) {
      return failure(order, "SEND_FAILED", err.shortMessage || err.message, hash ? { venue_ref: hash, t_sent } : {});
    }
  }

  /** The curve behind a token, from the position, the reference, or the factory (an adopted position
   *  can carry none). Remembered per token. */
  async _curveFor(instrument, hint = null) {
    const key = String(instrument).toLowerCase();
    if (hint) { this._curves.set(key, String(hint).toLowerCase()); return this._curves.get(key); }
    if (this._curves.has(key)) return this._curves.get(key);
    const f = new Contract(FACTORY, FACTORY_ABI, this.provider);
    const r = await f.getLaunchedToken(instrument);
    const curve = String(r.curve || r[1] || "").toLowerCase();
    if (!curve || /^0x0+$/.test(curve)) return null;
    this._curves.set(key, curve);
    return curve;
  }

  /** What the curve says right now: reserves and fees for the quote, graduated for the refusal. */
  async _curveNow(curveAddr) {
    const c = new Contract(curveAddr, CURVE_ABI, this.provider);
    const [[q, t], feeBps, taxBps, graduated] = await Promise.all([c.getReserves(), c.feeBps().catch(() => 0n), c.creatorTaxBps().catch(() => 0n), c.graduated().catch(() => false)]);
    return { quoteReserve: toEth(q), tokenReserve: toTokens(t), feeBps: Number(feeBps) + Number(taxBps), graduated: !!graduated };
  }

  /** Which sell the curve will take, found by dry runs that cost nothing: full amount at the normal
   *  slippage, then wider, then halves down to an eighth. Returns { ok, units, keep, note } or { ok:false, err }. */
  /** Find a sell the curve will accept, without agreeing to be robbed to get one.
   *
   *  What a curve actually refuses is SIZE: it will not let one sell drain it past a limit, but it
   *  will take a quarter of the same order. So every size is tried at a fair price before the price
   *  is widened at all -- the old ladder had this the wrong way round and offered the whole position
   *  at half price before ever trying to sell half of it at a fair one.
   *
   *  And the floor is a floor. The old ladder ended at keep = 0, which sends minOut = 0: a sell that
   *  accepts ANY price, including near zero, on a thin curve where a sandwich costs a few dollars to
   *  run. That is not slippage tolerance, it is a blank cheque, and it is how a close came back at
   *  -72% on a position whose exit rule only fires in profit. A sell that can only succeed with no
   *  price floor is a sell that should fail and be retried. */
  async _sellShape(curve, units, r) {
    const normal = Math.max(MIN_SELL_KEEP, 1 - this.slippagePct / 100);
    const keeps = normal > MIN_SELL_KEEP ? [normal, MIN_SELL_KEEP] : [normal];
    const fractions = [1n, 2n, 4n, 8n];
    let err = null;
    for (const keep of keeps) {
      for (const div of fractions) {
        const u = units / div; if (u <= 0n) break;
        const q = curveSellQuote(r, toTokens(u), r.feeBps);
        const minOut = toWei(Math.max(0, (q.quoteOut || 0) * keep));
        try { await curve.sell.staticCall(u, minOut, this.address); return { ok: true, units: u, keep, note: `${div === 1n ? "all" : `1/${div}`} at ${Math.round(keep * 100)}% of quote` }; }
        catch (e) { err = e; if (!/revert|CALL_EXCEPTION|execution/i.test(String(e.message || e.shortMessage || "")) && e.code !== "CALL_EXCEPTION") return { ok: false, err: e }; }
      }
    }
    return { ok: false, err };
  }

  /** A custom error the ABI in this file does not know: the verified contract on the explorer does.
   *  Cached per curve; the explorer being down leaves the raw selector. */
  async _explainRevert(curveAddr, err, tokenAddr = null) {
    const data = err?.data || err?.info?.error?.data || null;
    const plain = err?.reason || err?.shortMessage || err?.message || "reverted";
    if (!data || typeof data !== "string" || data.length < 10 || err?.reason || /^0x(08c379a0|4e487b71)/i.test(data)) return plain.slice(0, 160); // Error(string) and Panic decode by themselves
    if (!this._abis) this._abis = new Map();
    const key = String(curveAddr).toLowerCase();
    try {
      if (!this._abis.has(key)) {
        const abis = [];
        // The curve AND the token. A sell calls curve.sell(), which pulls tokens with transferFrom,
        // so the revert can come from the token's own code -- a transfer restriction, a blacklist, a
        // pause. Reading only the curve's ABI left those as a bare selector nobody could act on.
        for (const addr of [key, tokenAddr && String(tokenAddr).toLowerCase()].filter(Boolean)) {
          const res = await this.fetch(`${EXPLORER}/api/v2/smart-contracts/${addr}`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) bondli/1.0" }, signal: AbortSignal.timeout(6000) });
          if (!res.ok) throw new Error(`explorer ${res.status}`);
          const j = await res.json();
          if (Array.isArray(j.abi)) abis.push(j.abi);
          for (const impl of j.implementations || []) { if (impl.address) { const r2 = await this.fetch(`${EXPLORER}/api/v2/smart-contracts/${impl.address}`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 bondli/1.0" }, signal: AbortSignal.timeout(6000) }).catch(() => null); const j2 = r2?.ok ? await r2.json() : null; if (Array.isArray(j2?.abi)) abis.push(j2.abi); } }
        }
        this._abis.set(key, abis.map(a => new Interface(a.filter(x => x.type === "error"))));
      }
      for (const iface of this._abis.get(key)) { const e = iface.parseError(data); if (e) return `${e.name}${e.args?.length ? `(${e.args.map(String).join(", ")})` : ""}`; }
      // Neither contract declares it. A public signature database usually knows the selector, and a
      // name -- "CurveGraduated", "TransferPaused" -- is the difference between an error the
      // operator can act on and eight hex digits they cannot.
      const named = await this._lookupSelector(data.slice(0, 10));
      return named ? `${named} (${data.slice(0, 10)})` : `custom error ${data.slice(0, 10)}`;
    } catch (e2) { return `custom error ${data.slice(0, 10)}, explorer ${e2.message.slice(0, 40)}`; }
  }

  /** Sell pct of what the wallet holds. Sizes from the wallet's exact balance (a float rounding up
   *  by one unit would revert), quotes from the curve as it is now (not a stale reference), dry-runs
   *  the sell before paying gas so a revert comes back with its reason instead of a burned fee,
   *  and lets the node estimate gas. */
  /** Name a 4-byte error selector from a public signature database. Cached, best effort, never fatal. */
  async _lookupSelector(sel) {
    if (!this._selectors) this._selectors = new Map();
    if (this._selectors.has(sel)) return this._selectors.get(sel);
    let name = null;
    try {
      const r = await this.fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${sel}&filter=true`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(4000) });
      if (r.ok) { const j = await r.json(); name = j?.result?.function?.[sel]?.[0]?.name || null; }
    } catch {}
    this._selectors.set(sel, name);
    return name;
  }

  async close(position, pct = 100, ctx = {}) {
    if (!this.ready) return failure({ id: position.id }, "NOT_READY", "call init() first");
    const ref = ctx.reference || position.reference || {}, price = Number(ref.solPrice) || 0;
    // Without a quote price the proceeds of a real sale are booked as $0, which is a 100% loss on
    // money that actually arrived -- and that number goes on to drive the daily loss limit, the
    // governor, the learner and the performance fee. The engine offers the tick price, the venue's
    // last price and the position's own reference, so a zero here means the ETH feed has never
    // produced a price, and a venue in that state should not be trading at all. Refusing is
    // recoverable and loud; booking a total loss on a profitable sale is neither.
    if (!(price > 0)) return failure({ id: position.id }, "NO_QUOTE_PRICE", "no ETH price yet; refusing to sell into a book that cannot be priced (the sale would be booked as a total loss)");
    let curveAddr = ref.curve?.address || position.curve || null;
    const t_sent = this.clock();
    let hash = null;
    try {
      if (!curveAddr) { curveAddr = await this._curveFor(position.instrument).catch(() => null); if (!curveAddr) return failure({ id: position.id }, "NO_CURVE", "the factory does not know this token; not a PONS launch, sell by hand"); }
      else this._curveFor(position.instrument, curveAddr);
      this.track(position.instrument);
      if (position.pendingExit?.sig) {
        const prev = await this.resolvePending({ instrument: position.instrument, side: "SELL", sig: position.pendingExit.sig, at: position.pendingExit.at, reference: { ...ref, solPrice: price }, curve: curveAddr });
        if (prev.ok) return { ...prev, fill: { ...prev.fill, orderId: `${position.id}:close`, decisionId: position.decisionId, pending_pct: Number(position.pendingExit.pct) || 100 } };
        if (!prev.failure.expired) return prev;
      }
      const token = new Contract(position.instrument, ERC20_ABI, this.wallet);
      const balUnits = BigInt(await token.balanceOf(this.address));
      if (!(balUnits > 0n)) return failure({ id: position.id }, "NO_POSITION", "no token balance to sell");
      const held = toTokens(balUnits);
      const now = await this._curveNow(curveAddr);
      if (now.graduated) return failure({ id: position.id }, "GRADUATED", "the curve has graduated to a Uniswap V4 pool; sell by hand on PONS (export the key into Rabby)");
      const p = Math.min(100, Math.max(1, Math.round(pct)));
      const units = p >= 100 ? balUnits : balUnits * BigInt(p) / 100n;
      const tokensIn = toTokens(units);
      if (!(units > 0n)) return failure({ id: position.id }, "NO_POSITION", "nothing left to sell at that share");
      const allowance = BigInt(await token.allowance(this.address, curveAddr));
      if (allowance < units) {
        const a = await token.approve(curveAddr, MaxUint256);
        const ar = await this._waitReceipt(a.hash, this.confirmTimeoutMs);
        if (!ar) return failure({ id: position.id }, "UNCONFIRMED", `approve ${a.hash} not confirmed within ${this.confirmTimeoutMs}ms`, { venue_ref: a.hash, t_sent });
        if (ar.status === 0) return failure({ id: position.id }, "SEND_FAILED", `approve ${a.hash} reverted`, { venue_ref: a.hash });
      }
      const r = now.tokenReserve > 0 ? now : reserves(ref);
      const curve = new Contract(curveAddr, CURVE_ABI, this.wallet);
      // Find a sell the curve accepts before paying for one. First the quoted amount at the normal
      // slippage; if the curve refuses, wider slippage; if it still refuses, smaller chunks (a curve
      // can refuse a sell that would drain it past a limit while taking a quarter). The first shape
      // the dry run accepts is what gets sent, chunk by chunk until the wallet is empty or one fails.
      const shape = await this._sellShape(curve, units, r);
      if (!shape.ok) {
        const why = await this._explainRevert(curveAddr, shape.err, position.instrument);
        const ready = await curve.readyToGraduate().catch(() => null);
        const hint = ready ? "; the curve is full and waiting to graduate, sell on the pool once it has" : "";
        return failure({ id: position.id }, "REVERT", `sell would revert (${why})${hint}`.slice(0, 300));
      }
      let leftUnits = units, gotQuote = 0, feeQuote = 0, gasEth = 0, qtySold = 0, chunks = 0, lastHash = null, exact = true;
      while (leftUnits > 0n && chunks < 8) {
        const u = leftUnits < shape.units ? leftUnits : shape.units;
        const tIn = toTokens(u), q = curveSellQuote(r, tIn, r.feeBps);
        const minOut = toWei(Math.max(0, (q.quoteOut || 0) * shape.keep));
        if (chunks > 0) { try { await curve.sell.staticCall(u, minOut, this.address); } catch (err) { break; } }
        let gasLimit = this.gasLimitSell;
        try { const est = await curve.sell.estimateGas(u, minOut, this.address); gasLimit = est * 13n / 10n; if (gasLimit < this.gasLimitSell) gasLimit = this.gasLimitSell; } catch {}
        const tx = await curve.sell(u, minOut, this.address, { gasLimit });
        hash = lastHash = tx.hash;
        const receipt = await this._waitReceipt(hash, this.confirmTimeoutMs);
        if (!receipt) { if (chunks === 0) return failure({ id: position.id }, "UNCONFIRMED", `tx ${hash} not confirmed within ${this.confirmTimeoutMs}ms`, { venue_ref: hash, t_sent }); break; }
        const d = this._receiptDeltas(receipt, curveAddr);
        if (d.reverted) { if (chunks === 0) return failure({ id: position.id }, "SEND_FAILED", `tx ${hash} reverted`, { venue_ref: hash, fee_usd: d.gasEth * price }); gasEth += d.gasEth; break; }
        gasEth += d.gasEth; gotQuote += d.trade ? d.trade.quote : q.quoteOut; feeQuote += (d.trade?.fee || 0) + (d.trade?.tax || 0); qtySold += d.trade?.tokens || tIn; exact = exact && !!d.trade;
        leftUnits -= u; chunks++;
        // the curve moved: re-read it for the next chunk's quote
        if (leftUnits > 0n) { try { const n2 = await this._curveNow(curveAddr); if (n2.tokenReserve > 0) Object.assign(r, { quoteReserve: n2.quoteReserve, tokenReserve: n2.tokenReserve, feeBps: n2.feeBps }); } catch {} }
      }
      const t_filled = this.clock();
      const got = Math.max(0, gotQuote - gasEth);
      // The loop stops early when a chunk reverts, times out, or hits the chunk limit, and the tokens
      // it did not reach are still in the wallet. Say how much of the ORDER actually filled: the
      // engine closes a position on the percentage it asked for, so returning ok on a 100% request
      // that sold 60% booked the position closed and abandoned the rest -- which is how a wallet ends
      // up holding tokens no position knows about.
      const unsold = leftUnits > 0n ? toTokens(leftUnits) : 0;
      const pctFilled = units > 0n ? Math.min(100, (Number(units - leftUnits) / Number(units)) * 100) : 0;
      return { ok: true, fill: { orderId: `${position.id}:close`, decisionId: position.decisionId, venue: "pons", instrument: position.instrument, side: "SELL", price: qtySold > 0 ? (got * price) / qtySold : 0, qty: qtySold, notional_usd: +(got * price).toFixed(4), slippage_bps: null, fee_usd: +((feeQuote + gasEth) * price).toFixed(4), t_sent, t_filled, latency_ms: t_filled - t_sent, venue_ref: lastHash, sol_received: got, exact, held_before: held, chunks, partial: unsold, pct_filled: +pctFilled.toFixed(2), shape: shape.note } };
    } catch (err) {
      return failure({ id: position.id }, "SEND_FAILED", (err.reason || err.shortMessage || err.message || String(err)).slice(0, 300), hash ? { venue_ref: hash, t_sent } : {});
    }
  }

  /** The wallet holds none of a token and the engine has no pending signature for it. Before that is
   *  booked as a total loss, look for the sale on chain: the curve emits CurveSell with the exact
   *  quote it paid out.
   *
   *  pump.fun has had this since a phantom -$25.62 was traced to a sale that really landed. PONS did
   *  not, so the same phantom came back on Robinhood Chain as "doa:flat at venue -$10.00" -- the
   *  whole stake written off on a position that may well have been sold.
   *
   *  Returns { sig, solReceived, qty, at } for the most recent sale by this wallet since `since`. */
  async findRecentSale(instrument, { since = 0, blocks = 5000 } = {}) {
    if (!this.ready) return null;
    const curveAddr = await this._curveFor(instrument).catch(() => null);
    if (!curveAddr) return null;
    let logs;
    try {
      const head = await this.provider.getBlockNumber();
      logs = await this.provider.getLogs({ address: curveAddr, topics: [TOPICS.CurveSell], fromBlock: Math.max(0, head - blocks), toBlock: head });
    } catch { return null; }
    const me = String(this.address).toLowerCase();
    // Newest first: the sale that emptied the wallet is the last one, not the first.
    for (const log of (logs || []).slice().reverse()) {
      const r = decodeLog(log);
      if (!r || r.kind !== "sell" || r.wallet !== me) continue;
      let at = null;
      try { const b = await this.provider.getBlock(log.blockNumber); at = b?.timestamp ? b.timestamp * 1000 : null; } catch {}
      if (since && at && at < since) break;
      return { sig: r.tx, solReceived: Math.max(0, r.quote), qty: r.tokens, at: at || this.clock() };
    }
    return null;
  }

  /** A transaction sent earlier: did it land? Reads the receipt and books what it carried. */
  async resolvePending({ instrument, side, sig, at, reference = {}, curve = null, stakeUsd = 0 }) {
    const receipt = await this.provider.getTransactionReceipt(sig).catch(() => null);
    const price = Number(reference.solPrice) || 0, t = this.clock();
    if (!receipt) {
      const expired = at && t - at > 10 * 60_000;
      return failure({ id: sig }, expired ? "DROPPED" : "PENDING", expired ? `tx ${sig} never landed` : `tx ${sig} still pending`, { expired: !!expired, venue_ref: sig });
    }
    const d = this._receiptDeltas(receipt, curve || reference.curve?.address || "");
    if (d.reverted) return failure({ id: sig }, "SEND_FAILED", `tx ${sig} reverted`, { expired: true, venue_ref: sig, fee_usd: d.gasEth * price });
    if (!d.trade) return failure({ id: sig }, "UNREADABLE", `tx ${sig} carries no curve trade log`, { expired: true, venue_ref: sig });
    if (side === "BUY") { const spent = d.trade.quote + d.gasEth; return { ok: true, fill: { venue: "pons", instrument, side: "BUY", price: (spent * price) / d.trade.tokens, qty: d.trade.tokens, notional_usd: +(spent * price).toFixed(4), slippage_bps: null, fee_usd: 0, t_sent: at || t, t_filled: t, latency_ms: at ? t - at : 0, venue_ref: sig, sol_spent: spent, late: true } }; }
    const got = Math.max(0, d.trade.quote - d.gasEth);
    return { ok: true, fill: { venue: "pons", instrument, side: "SELL", price: d.trade.tokens > 0 ? (got * price) / d.trade.tokens : 0, qty: d.trade.tokens, notional_usd: +(got * price).toFixed(4), slippage_bps: null, fee_usd: 0, t_sent: at || t, t_filled: t, latency_ms: at ? t - at : 0, venue_ref: sig, sol_received: got, late: true } };
  }

  /** Plain ETH transfer from the trading wallet (the platform's performance fee). Returns the hash. */
  async transferSol(to, eth) {
    if (!this.ready) throw new Error("call init() first");
    const tx = await this.wallet.sendTransaction({ to, value: toWei(eth), gasLimit: 21_000n });
    await this._waitReceipt(tx.hash, this.confirmTimeoutMs);
    return tx.hash;
  }
  transferQuote(to, amount) { return this.transferSol(to, amount); }

  async health() {
    if (!this.ready) return { ok: false, latencyMs: null, detail: "not initialised" };
    const t0 = Date.now();
    try { const b = await this.provider.getBlockNumber(); return { ok: true, latencyMs: Date.now() - t0, detail: `block ${b}` }; }
    catch (err) { return { ok: false, latencyMs: Date.now() - t0, detail: err.message }; }
  }

  /** Balances of the tokens this router knows about. An EVM wallet has no account list to enumerate. */
  async positions() {
    if (!this.ready) return [];
    const out = [];
    for (const token of this.known) { try { const qty = await this._tokenBalance(token); if (qty > 0) out.push({ instrument: token, qty }); } catch {} }
    return out;
  }
}
