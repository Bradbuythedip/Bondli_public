// ═══ VELOCITY — Polymarket routers (DP4) ═══
// Paper: fills by walking the displayed book; anything past the displayed
// depth is NO_LIQUIDITY, never an imagined fill. Multi-leg orders are all
// legs or none (the PaperRouter unwinds). Live: the official CLOB client,
// loaded lazily; single legs FOK, multi-leg FOK per leg with unwind.

import { PaperRouter, Router, failure } from "../../core/router.mjs";

/** Walk one side of a book for a notional. Returns avg price, shares, slippage vs best. */
export function walkBook(levels, side, notionalUsd) {
  const sorted = (levels || []).map(l => ({ price: Number(l.price), size: Number(l.size) })).filter(l => l.price > 0 && l.size > 0)
    .sort((a, b) => (side === "BUY" ? a.price - b.price : b.price - a.price));
  if (!sorted.length) return { reject: "NO_LIQUIDITY", reason: "empty book side" };
  const best = sorted[0].price;
  let remaining = notionalUsd, shares = 0, cost = 0;
  for (const l of sorted) {
    const canNotional = l.price * l.size;
    const take = Math.min(remaining, canNotional);
    shares += take / l.price;
    cost += take;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-6) return { reject: "NO_LIQUIDITY", reason: `book depth ${(notionalUsd - remaining).toFixed(2)} < ${notionalUsd.toFixed(2)} wanted` };
  const avg = cost / shares;
  const slippage_bps = side === "BUY" ? (avg / best - 1) * 1e4 : (1 - avg / best) * 1e4;
  return { price: avg, shares, notional: cost, best, slippage_bps };
}

export function polymarketFillModel(order) {
  const book = order.reference?.book;
  if (!book) return { reject: "NO_BOOK", reason: "reference has no book" };
  const feeBps = Number(order.reference?.feeRateBps) || 0;
  if (order.side === "BUY") {
    const asks = book.asks?.length ? book.asks : book.bestAsk != null ? [{ price: book.bestAsk, size: book.askSize || 0 }] : [];
    const r = walkBook(asks, "BUY", Number(order.stake_usd) || 0);
    if (r.reject) return r;
    return { price: r.price, qty: r.shares, notional_usd: r.notional, slippage_bps: r.slippage_bps, fee_usd: 0 };
  }
  const bids = book.bids?.length ? book.bids : book.bestBid != null ? [{ price: book.bestBid, size: book.bidSize || 0 }] : [];
  const qty = Number(order.qty) || 0;
  if (!(qty > 0)) return { reject: "ZERO_QTY", reason: "nothing to sell" };
  // Selling qty shares: walk bids by shares.
  const sorted = bids.map(l => ({ price: Number(l.price), size: Number(l.size) })).filter(l => l.price > 0 && l.size > 0).sort((a, b) => b.price - a.price);
  if (!sorted.length) return { reject: "NO_LIQUIDITY", reason: "empty bid side" };
  let rem = qty, proceeds = 0;
  for (const l of sorted) { const take = Math.min(rem, l.size); proceeds += take * l.price; rem -= take; if (rem <= 1e-9) break; }
  if (rem > 1e-6) return { reject: "NO_LIQUIDITY", reason: `bid depth short by ${rem.toFixed(2)} shares` };
  const avg = proceeds / qty;
  const fee = proceeds * (feeBps / 1e4);
  return { price: avg, qty, notional_usd: proceeds - fee, slippage_bps: (1 - avg / sorted[0].price) * 1e4, fee_usd: fee };
}

export class PolymarketPaperRouter extends PaperRouter {
  constructor({ bookFile, clock, latencyMs = 5, unwindBudgetMs = 2_000 } = {}) {
    super({ venue: "polymarket", clock, bookFile, fillModel: polymarketFillModel, latencyMs, unwindBudgetMs });
  }
}

export class PolymarketLiveRouter extends Router {
  constructor({ host = "https://clob.polymarket.com", chainId = 137, privateKey = process.env.POLYMARKET_PRIVATE_KEY, funder = process.env.POLYMARKET_FUNDER, signatureType = 0, clock } = {}) {
    super({ venue: "polymarket", mode: "live", clock });
    this.host = host; this.chainId = chainId; this.privateKey = privateKey; this.funder = funder; this.signatureType = signatureType;
    this.ready = false;
  }

  async init() {
    if (this.privateKey == null) this.privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    if (this.funder == null) this.funder = process.env.POLYMARKET_FUNDER;
    if (!this.privateKey) throw new Error("polymarket live router needs POLYMARKET_PRIVATE_KEY");
    let clob, ethers;
    try { clob = await import("@polymarket/clob-client"); } catch { throw new Error("polymarket live router needs the @polymarket/clob-client package: npm install @polymarket/clob-client ethers"); }
    try { ethers = await import("ethers"); } catch { throw new Error("polymarket live router needs the ethers package: npm install ethers"); }
    const signer = new ethers.Wallet(this.privateKey);
    const tmp = new clob.ClobClient(this.host, this.chainId, signer);
    const creds = await tmp.createOrDeriveApiKey();
    this.client = new clob.ClobClient(this.host, this.chainId, signer, creds, this.signatureType, this.funder || undefined);
    this.OrderType = clob.OrderType;
    this.Side = clob.Side;
    this.ready = true;
  }

  async _fok(tokenId, side, price, size) {
    const t_sent = this.clock();
    const order = await this.client.createOrder({ tokenID: tokenId, price, size, side: side === "BUY" ? this.Side.BUY : this.Side.SELL });
    const res = await this.client.postOrder(order, this.OrderType.FOK);
    const t_filled = this.clock();
    if (!res || res.success === false || res.error) throw new Error(res?.errorMsg || res?.error || "order rejected");
    const status = String(res.status || "").toLowerCase();
    if (status && status !== "matched" && status !== "filled") throw new Error(`FOK not filled: ${status}`);
    return { venue_ref: res.orderID || res.id || null, t_sent, t_filled };
  }

  async submit(order) {
    if (!this.ready) return failure(order, "NOT_READY", "call init() first");
    if (order.legs?.length) return this.submitLegs(order);
    const est = polymarketFillModel(order);
    if (est.reject) return failure(order, est.reject, est.reason);
    if (Number.isFinite(order.max_slippage_bps) && est.slippage_bps > order.max_slippage_bps)
      return failure(order, "SLIPPAGE_CAP", `book slippage ${est.slippage_bps.toFixed(1)}bps > cap ${order.max_slippage_bps}bps`);
    try {
      const r = await this._fok(order.instrument, "BUY", +est.price.toFixed(3), +est.qty.toFixed(2));
      return { ok: true, fill: { orderId: order.id, decisionId: order.decisionId || null, venue: "polymarket", instrument: order.instrument, side: "BUY", price: est.price, qty: est.qty, notional_usd: est.notional_usd, slippage_bps: +est.slippage_bps.toFixed(2), fee_usd: est.fee_usd, ...r, latency_ms: r.t_filled - r.t_sent } };
    } catch (err) { return failure(order, "SEND_FAILED", err.message); }
  }

  async submitLegs(order) {
    if (!this.ready) return failure(order, "NOT_READY", "call init() first");
    const fills = [];
    const t0 = this.clock();
    for (const leg of order.legs) {
      const est = polymarketFillModel({ ...leg, side: "BUY", reference: leg.reference });
      if (est.reject) return await this._unwind(order, fills, `${leg.instrument}: ${est.reason}`, t0);
      try {
        const r = await this._fok(leg.instrument, "BUY", +est.price.toFixed(3), +est.qty.toFixed(2));
        fills.push({ orderId: `${order.id}:${leg.instrument}`, instrument: leg.instrument, side: "BUY", price: est.price, qty: est.qty, notional_usd: est.notional_usd, slippage_bps: est.slippage_bps, fee_usd: 0, ...r });
      } catch (err) { return await this._unwind(order, fills, `${leg.instrument}: ${err.message}`, t0); }
    }
    const notional = fills.reduce((s, f) => s + f.notional_usd, 0);
    return { ok: true, fills, fill: { orderId: order.id, decisionId: order.decisionId || null, venue: "polymarket", instrument: order.instrument, side: "BUY", price: null, qty: fills.length, notional_usd: notional, slippage_bps: Math.max(...fills.map(f => f.slippage_bps)), fee_usd: 0, t_sent: fills[0].t_sent, t_filled: fills.at(-1).t_filled, latency_ms: fills.at(-1).t_filled - fills[0].t_sent, legs: fills.length } };
  }

  async _unwind(order, fills, reason, t0) {
    const unwound = [];
    for (const f of fills) {
      try { const r = await this._fok(f.instrument, "SELL", +(f.price * 0.98).toFixed(3), +f.qty.toFixed(2)); unwound.push({ ...f, side: "SELL", ...r }); }
      catch (err) { unwound.push({ orderId: f.orderId, failed: true, reason: err.message }); }
    }
    const t_unwind_ms = this.clock() - t0;
    return { ok: false, failure: { orderId: order.id, code: "LEG_FAILED", reason, t_unwind_ms }, fills, unwound };
  }

  async close(position, pct = 100, ctx = {}) {
    if (!this.ready) return failure({ id: position.id }, "NOT_READY", "call init() first");
    const qty = (position.qty || 0) * Math.min(100, Math.max(0, pct)) / 100;
    if (!(qty > 0)) return failure({ id: position.id }, "NO_POSITION", "nothing to sell");
    const book = ctx.reference?.book || position.reference?.book;
    const price = book?.bestBid;
    if (!(price > 0)) return failure({ id: position.id }, "NO_BOOK", "no bid to sell into");
    try {
      const r = await this._fok(position.instrument, "SELL", +price.toFixed(3), +qty.toFixed(2));
      return { ok: true, fill: { orderId: `${position.id}:close`, decisionId: position.decisionId, venue: "polymarket", instrument: position.instrument, side: "SELL", price, qty, notional_usd: price * qty, slippage_bps: 0, fee_usd: 0, ...r, latency_ms: r.t_filled - r.t_sent } };
    } catch (err) { return failure({ id: position.id }, "SEND_FAILED", err.message); }
  }

  async health() {
    if (!this.ready) return { ok: false, latencyMs: null, detail: "not initialized" };
    const t0 = Date.now();
    try { await this.client.getOk(); return { ok: true, latencyMs: Date.now() - t0, detail: "clob ok" }; }
    catch (err) { return { ok: false, latencyMs: Date.now() - t0, detail: err.message }; }
  }

  async positions() {
    if (!this.ready || !this.funder) return [];
    try {
      const res = await fetch(`https://data-api.polymarket.com/positions?user=${this.funder}`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return [];
      const rows = await res.json();
      return (rows || []).map(r => ({ instrument: String(r.asset), qty: Number(r.size) || 0, avgPrice: Number(r.avgPrice) || 0, notional_usd: Number(r.initialValue) || 0 })).filter(p => p.qty > 0);
    } catch { return []; }
  }
}
