// ═══ VELOCITY — Router interface and paper router (DP4) ═══
// A router is write-only: it turns a sized order into a verified fill or a
// failure with nothing at risk. It never reads a feed. The paper router keeps
// its own book on disk as the venue's truth, so a restart can reconcile
// against it exactly as it would against a real venue.

import fs from "node:fs";
import path from "node:path";

export class Router {
  constructor({ venue, mode = "paper", clock = () => Date.now() }) {
    this.venue = venue;
    this.mode = mode;
    this.clock = clock;
  }
  async init() {}
  async submit() { throw new Error("submit not implemented"); }
  async submitLegs() { throw new Error("submitLegs not implemented"); }
  async close() { throw new Error("close not implemented"); }
  async health() { return { ok: false, latencyMs: null, detail: "not implemented" }; }
  async positions() { return []; }
}

export function failure(order, code, reason, extra = {}) {
  return { ok: false, failure: { orderId: order?.id || null, code, reason, ...extra } };
}

export class PaperRouter extends Router {
  /**
   * @param fillModel (order|leg, ctx) -> { price, qty, notional_usd, slippage_bps, fee_usd } | { reject, reason }
   * @param bookFile  where the paper book lives; survives a crash (venue truth)
   */
  constructor({ venue, clock, bookFile, fillModel, latencyMs = 5, unwindBudgetMs = 2_000 }) {
    super({ venue, mode: "paper", clock });
    this.bookFile = bookFile;
    this.fillModel = fillModel;
    this.latencyMs = latencyMs;
    this.unwindBudgetMs = unwindBudgetMs;
    this.book = this._loadBook();
    this.sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
    this.sent = 0;
    this.filled = 0;
    this.failed = 0;
  }

  _loadBook() {
    try {
      if (this.bookFile && fs.existsSync(this.bookFile)) return JSON.parse(fs.readFileSync(this.bookFile, "utf8"));
    } catch { /* torn book: start empty, reconciliation reports the gap */ }
    return { positions: {}, fills: 0 };
  }
  _saveBook() {
    if (!this.bookFile) return;
    fs.mkdirSync(path.dirname(this.bookFile), { recursive: true });
    const tmp = `${this.bookFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.book));
    fs.renameSync(tmp, this.bookFile);
  }

  _apply(instrument, side, qty, price, notional_usd) {
    const p = this.book.positions[instrument] || { instrument, qty: 0, avgPrice: 0, notional_usd: 0 };
    if (side === "BUY") {
      const newQty = p.qty + qty;
      p.avgPrice = newQty > 0 ? (p.avgPrice * p.qty + price * qty) / newQty : 0;
      p.qty = newQty;
      p.notional_usd += notional_usd;
    } else {
      const before = p.qty;
      p.qty = Math.max(0, p.qty - qty);
      p.notional_usd = before > 0 ? p.notional_usd * (p.qty / before) : 0;
    }
    p.updatedAt = this.clock();
    if (p.qty <= 1e-12) delete this.book.positions[instrument];
    else this.book.positions[instrument] = p;
    this.book.fills++;
    this._saveBook();
  }

  async _fillOne(order, ctx) {
    const t_sent = this.clock();
    this.sent++;
    await this.sleep(this.latencyMs);
    let f;
    try { f = this.fillModel(order, ctx); } catch (err) { f = { reject: "MODEL_ERROR", reason: err.message }; }
    const t_filled = this.clock();
    if (!f || f.reject) {
      this.failed++;
      return failure(order, f?.reject || "NO_FILL", f?.reason || "fill model returned nothing", { t_sent, latency_ms: t_filled - t_sent });
    }
    const cap = Number(order.max_slippage_bps);
    if (Number.isFinite(cap) && f.slippage_bps > cap) {
      this.failed++;
      return failure(order, "SLIPPAGE_CAP", `modeled slippage ${f.slippage_bps.toFixed(1)}bps > cap ${cap}bps`, { t_sent, latency_ms: t_filled - t_sent, slippage_bps: f.slippage_bps });
    }
    this._apply(order.instrument, order.side, f.qty, f.price, f.notional_usd);
    this.filled++;
    return {
      ok: true,
      fill: {
        orderId: order.id, decisionId: order.decisionId || null, venue: this.venue, instrument: order.instrument, side: order.side,
        price: f.price, qty: f.qty, notional_usd: f.notional_usd, slippage_bps: +f.slippage_bps.toFixed(2), fee_usd: f.fee_usd || 0,
        t_sent, t_filled, latency_ms: t_filled - t_sent, venue_ref: `paper-${this.book.fills}`, paper: true,
      },
    };
  }

  async submit(order, ctx = {}) {
    if (order.legs && order.legs.length) return this.submitLegs(order, ctx);
    return this._fillOne(order, ctx);
  }

  /** All legs or none. A leg that fails unwinds every leg already filled. */
  async submitLegs(order, ctx = {}) {
    const fills = [];
    const filledLegs = [];
    const t0 = this.clock();
    for (const leg of order.legs) {
      const legOrder = { ...leg, id: `${order.id}:${leg.instrument}`, decisionId: order.decisionId, max_slippage_bps: leg.max_slippage_bps ?? order.max_slippage_bps };
      const r = await this._fillOne(legOrder, { ...ctx, leg: true });
      if (!r.ok) {
        const unwound = [];
        for (const { fill: f, leg: done } of filledLegs) {
          // Unwind into the filled leg's own book, never the failing leg's.
          const back = await this._fillOne({ ...f, id: `${f.orderId}:unwind`, side: f.side === "BUY" ? "SELL" : "BUY", qty: f.qty, stake_usd: f.notional_usd, max_slippage_bps: Infinity, reference: done.reference || order.reference }, { ...ctx, unwind: true });
          unwound.push(back.ok ? back.fill : { orderId: f.orderId, instrument: f.instrument, failed: true, reason: back.failure.reason });
        }
        const t_unwind_ms = this.clock() - t0;
        return { ok: false, failure: { orderId: order.id, code: "LEG_FAILED", reason: `${legOrder.id}: ${r.failure.reason}`, leg: legOrder.instrument, t_unwind_ms, within_budget: t_unwind_ms <= this.unwindBudgetMs }, fills, unwound };
      }
      fills.push(r.fill);
      filledLegs.push({ fill: r.fill, leg });
    }
    const notional = fills.reduce((s, f) => s + f.notional_usd, 0);
    return { ok: true, fills, fill: { orderId: order.id, decisionId: order.decisionId || null, venue: this.venue, instrument: order.instrument, side: "BUY", price: null, qty: fills.length, notional_usd: notional, slippage_bps: Math.max(...fills.map(f => f.slippage_bps)), fee_usd: fills.reduce((s, f) => s + (f.fee_usd || 0), 0), t_sent: fills[0].t_sent, t_filled: fills.at(-1).t_filled, latency_ms: fills.at(-1).t_filled - fills[0].t_sent, legs: fills.length, paper: true } };
  }

  async close(position, pct = 100, ctx = {}) {
    const p = this.book.positions[position.instrument];
    const qty = p ? p.qty * (Math.min(100, Math.max(0, pct)) / 100) : 0;
    if (!qty) return failure({ id: `${position.id}:close` }, "NO_POSITION", `no paper position in ${position.instrument}`);
    return this._fillOne({ id: `${position.id}:close:${this.clock()}`, decisionId: position.decisionId, instrument: position.instrument, side: "SELL", qty, stake_usd: position.notional_usd * pct / 100, max_slippage_bps: Infinity, reference: ctx.reference || position.reference }, { ...ctx, close: true });
  }

  async health() { return { ok: true, latencyMs: this.latencyMs, detail: "paper" }; }

  async positions() {
    return Object.values(this.book.positions).map(p => ({ instrument: p.instrument, qty: p.qty, avgPrice: p.avgPrice, notional_usd: p.notional_usd, updatedAt: p.updatedAt }));
  }
}
