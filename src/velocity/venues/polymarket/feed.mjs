// ═══ VELOCITY — Polymarket feed (DP1) ═══
// Three sources, one event stream:
//   market  : Gamma REST metadata (question, outcomes, token ids, neg-risk group, fees, rules)
//   book    : CLOB market WebSocket (best bid/ask + depth per outcome token)
//   fact    : resolution facts from named sources (file or HTTP), each with a confidence
// The feed never decides anything; the edge model matches facts to market rules.

import fs from "node:fs";
import { Feed } from "../../core/feed.mjs";

function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
}

/** Pure: normalize one Gamma market object. */
export function parseMarket(raw) {
  if (!raw) return null;
  const outcomes = parseJsonArray(raw.outcomes);
  const tokenIds = parseJsonArray(raw.clobTokenIds).map(String);
  const prices = parseJsonArray(raw.outcomePrices).map(Number);
  const conditionId = raw.conditionId || raw.condition_id || null;
  if (!conditionId || tokenIds.length !== outcomes.length || !outcomes.length) return null;
  const desc = String(raw.description || "");
  const m = desc.match(/resolution source[^:\n]*[:\s]+(.+?)(?:\.\s|\.$|\n|$)/i) || desc.match(/according to (.+?)(?:\.\s|\.$|\n|,|$)/i);
  return {
    id: conditionId,
    conditionId,
    gammaId: raw.id != null ? String(raw.id) : null,
    question: raw.question || "",
    slug: raw.slug || "",
    outcomes,
    tokenIds,
    outcomePrices: prices,
    negRisk: !!raw.negRisk,
    groupId: raw.negRiskMarketID || raw.negRiskMarketId || (raw.events?.[0]?.id != null ? String(raw.events[0].id) : null),
    endDate: raw.endDate || raw.end_date_iso || null,
    active: raw.active !== false,
    closed: !!raw.closed,
    acceptingOrders: raw.acceptingOrders !== false,
    feeRateBps: raw.feeRateBps ?? raw.takerFeeBps ?? raw.fee_rate_bps ?? null,
    liquidity: Number(raw.liquidityNum ?? raw.liquidity) || 0,
    volume24h: Number(raw.volume24hr ?? raw.volume24hrClob) || 0,
    resolutionSource: m ? m[1].trim() : null,
    description: desc.slice(0, 2000),
    umaResolutionStatus: raw.umaResolutionStatus || raw.umaResolutionStatuses || null,
  };
}

function bestLevel(levels, pickMax) {
  let best = null;
  for (const l of levels || []) {
    const price = Number(l.price), size = Number(l.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
    if (best === null || (pickMax ? price > best.price : price < best.price)) best = { price, size };
  }
  return best;
}

/** Pure: a CLOB WS message becomes zero or more book/tick payloads. */
export function parseClobMessage(msg, cache = new Map()) {
  const out = [];
  const items = Array.isArray(msg) ? msg : [msg];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const tokenId = String(it.asset_id || it.assetId || "");
    const t_venue = Number(it.timestamp) || null; // null: the feed stamps its own clock
    if (it.event_type === "book" && tokenId) {
      const bid = bestLevel(it.bids, true), ask = bestLevel(it.asks, false);
      const book = { tokenId, market: it.market || null, bids: it.bids || [], asks: it.asks || [],
        bestBid: bid?.price ?? null, bidSize: bid?.size ?? 0, bestAsk: ask?.price ?? null, askSize: ask?.size ?? 0 };
      cache.set(tokenId, book);
      out.push({ kind: "book", id: tokenId, t_venue, payload: book });
    } else if (it.event_type === "price_change") {
      const changes = Array.isArray(it.price_changes) ? it.price_changes : [it];
      for (const c of changes) {
        const tid = String(c.asset_id || tokenId || "");
        if (!tid) continue;
        const prev = cache.get(tid) || { tokenId: tid, market: it.market || null, bids: [], asks: [], bestBid: null, bidSize: 0, bestAsk: null, askSize: 0 };
        const book = { ...prev };
        if (c.best_bid != null) book.bestBid = Number(c.best_bid);
        if (c.best_ask != null) book.bestAsk = Number(c.best_ask);
        if (c.side === "BUY" && c.price != null) { book.bestBid = Number(c.price); book.bidSize = Number(c.size) || book.bidSize; }
        if (c.side === "SELL" && c.price != null) { book.bestAsk = Number(c.price); book.askSize = Number(c.size) || book.askSize; }
        cache.set(tid, book);
        out.push({ kind: "book", id: tid, t_venue, payload: book });
      }
    } else if (it.event_type === "last_trade_price" && tokenId) {
      out.push({ kind: "tick", id: tokenId, t_venue, payload: { price: Number(it.price), size: Number(it.size) || 0, side: it.side || null, market: it.market || null } });
    }
  }
  return out;
}

/** Fact sources. Each returns [{ conditionId, outcome, source, confidence, t_fact }]. */
export class FileFactSource {
  constructor({ path, source = "file", confidence = 0.95 }) { this.path = path; this.source = source; this.confidence = confidence; }
  async read() {
    if (!fs.existsSync(this.path)) return [];
    const arr = JSON.parse(fs.readFileSync(this.path, "utf8"));
    return (Array.isArray(arr) ? arr : []).map(f => ({
      conditionId: f.conditionId || f.marketId, outcome: f.outcome, source: f.source || this.source,
      confidence: Number(f.confidence ?? this.confidence), t_fact: Number(f.t_fact) || Date.now(),
    })).filter(f => f.conditionId && f.outcome);
  }
}

export class HttpFactSource {
  constructor({ url, source, confidence = 0.95, map = null, fetchImpl = globalThis.fetch }) {
    this.url = url; this.source = source || new URL(url).host; this.confidence = confidence; this.map = map; this.fetch = fetchImpl;
  }
  async read() {
    const res = await this.fetch(this.url, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) throw new Error(`fact source ${this.source} ${res.status}`);
    const json = await res.json();
    const arr = this.map ? this.map(json) : Array.isArray(json) ? json : json.facts || [];
    return arr.map(f => ({ conditionId: f.conditionId, outcome: f.outcome, source: f.source || this.source, confidence: Number(f.confidence ?? this.confidence), t_fact: Number(f.t_fact) || Date.now() }))
      .filter(f => f.conditionId && f.outcome);
  }
}

export class PolymarketFeed extends Feed {
  constructor({
    gammaUrl = "https://gamma-api.polymarket.com",
    clobWsUrl = "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    marketPollMs = 30_000,
    factPollMs = 2_000,
    maxMarkets = 150,
    minLiquidity = 1_000,
    factSources = [],
    fetchImpl = globalThis.fetch,
    wsFactory = url => new globalThis.WebSocket(url),
    ...rest
  } = {}) {
    super({ venue: "polymarket", name: "polymarket-feed", staleAfterMs: rest.staleAfterMs ?? Math.max(15_000, 2 * marketPollMs), latencyBoundMs: rest.latencyBoundMs ?? 250, clock: rest.clock });
    this.gammaUrl = gammaUrl.replace(/\/$/, "");
    this.clobWsUrl = clobWsUrl;
    this.marketPollMs = marketPollMs;
    this.factPollMs = factPollMs;
    this.maxMarkets = maxMarkets;
    this.minLiquidity = minLiquidity;
    this.factSources = factSources;
    this.fetch = fetchImpl;
    this.wsFactory = wsFactory;
    this.markets = new Map();     // conditionId -> market
    this.tokenToMarket = new Map();
    this.books = new Map();       // tokenId -> book
    this.seenFacts = new Set();
    this._ws = null;
    this._timers = [];
    this._subscribed = new Set();
  }

  async pollMarkets() {
    const url = `${this.gammaUrl}/markets?active=true&closed=false&limit=${this.maxMarkets}&order=volume24hr&ascending=false`;
    const res = await this.fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`gamma ${res.status}`);
    const rows = await res.json();
    let n = 0;
    for (const raw of Array.isArray(rows) ? rows : []) {
      const m = parseMarket(raw);
      if (!m || m.liquidity < this.minLiquidity) continue;
      this.markets.set(m.conditionId, m);
      for (const tid of m.tokenIds) this.tokenToMarket.set(tid, m.conditionId);
      this.emitEvent({ kind: "market", id: m.conditionId, payload: m, t_venue: this.clock() });
      n++;
    }
    await this.pollGroups();
    this._subscribeAll();
    this.touch();
    this.markHealth(true, `markets ${n}`);
    return n;
  }

  /** A consistency trade needs the whole mutually-exclusive set. Gamma's events
   *  endpoint lists every market in a negative-risk group, including ones the
   *  liquidity filter dropped, so the edge can refuse incomplete groups. */
  async pollGroups() {
    const groups = new Set([...this.markets.values()].filter(m => m.negRisk && m.groupId).map(m => m.groupId));
    let n = 0;
    for (const groupId of groups) {
      try {
        const res = await this.fetch(`${this.gammaUrl}/events/${encodeURIComponent(groupId)}`, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) continue;
        const ev = await res.json();
        const conditionIds = (ev?.markets || []).map(r => r.conditionId || r.condition_id).filter(Boolean);
        if (!conditionIds.length) continue;
        for (const raw of ev.markets) {
          const m = parseMarket({ ...raw, negRisk: true, negRiskMarketID: groupId });
          if (m && !this.markets.has(m.conditionId)) {
            this.markets.set(m.conditionId, m);
            for (const tid of m.tokenIds) this.tokenToMarket.set(tid, m.conditionId);
            this.emitEvent({ kind: "market", id: m.conditionId, payload: m, t_venue: this.clock() });
          }
        }
        this.emitEvent({ kind: "market", id: `group:${groupId}`, payload: { isGroup: true, groupId, conditionIds }, t_venue: this.clock() });
        n++;
      } catch { /* group stays unknown; the edge refuses to trade it */ }
    }
    return n;
  }

  async pollFacts() {
    let n = 0;
    if (this.factSources.length) this.touch();
    for (const src of this.factSources) {
      const facts = await src.read();
      for (const f of facts) {
        const key = `${f.conditionId}|${f.outcome}|${f.source}`;
        if (this.seenFacts.has(key)) continue;
        this.seenFacts.add(key);
        this.emitEvent({ kind: "fact", id: f.conditionId, payload: f, t_venue: f.t_fact });
        n++;
      }
    }
    return n;
  }

  handleWsMessage(data) {
    let msg; try { msg = typeof data === "string" ? JSON.parse(data) : data; } catch { return 0; }
    const items = parseClobMessage(msg, this.books);
    for (const it of items) this.emitEvent(it);
    return items.length;
  }

  _subscribeAll() {
    if (!this._ws || this._ws.readyState !== 1) return;
    const ids = [...this.tokenToMarket.keys()].filter(id => !this._subscribed.has(id));
    if (!ids.length) return;
    this._ws.send(JSON.stringify({ assets_ids: ids, type: "market" }));
    for (const id of ids) this._subscribed.add(id);
  }

  _connect() {
    if (!this.running) return;
    try {
      const ws = this.wsFactory(this.clobWsUrl);
      this._ws = ws;
      ws.onopen = () => {
        this._subscribed.clear(); this._subscribeAll(); this.markHealth(true, "clob ws open");
        // The CLOB server drops idle sockets; it expects a PING text frame about every 10s.
        this._ping = setInterval(() => { try { if (ws.readyState === 1) ws.send("PING"); } catch {} }, 10_000);
        this._ping.unref?.();
      };
      ws.onmessage = ev => { if (ev.data === "PONG") { this.touch(); return; } this.handleWsMessage(ev.data); };
      ws.onclose = () => { clearInterval(this._ping); this._ws = null; this.markHealth(false, "clob ws closed"); if (this.running) this._timers.push(setTimeout(() => this._connect(), 3_000)); };
      ws.onerror = () => {};
    } catch {
      this._timers.push(setTimeout(() => this._connect(), 10_000));
    }
  }

  async start() {
    this.running = true;
    const loop = (fn, ms) => {
      const tick = async () => {
        if (!this.running) return;
        try { await fn(); } catch (err) { this.markHealth(false, err.message); }
        if (this.running) this._timers.push(setTimeout(tick, ms));
      };
      tick();
    };
    loop(() => this.pollMarkets(), this.marketPollMs);
    loop(() => this.pollFacts(), this.factPollMs);
    this._connect();
  }

  async stop() {
    this.running = false;
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    clearInterval(this._ping);
    try { this._ws?.close(); } catch {}
    this._ws = null;
    this.markHealth(false, "stopped");
  }
}
