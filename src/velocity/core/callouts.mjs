// ═══ VELOCITY — Verified callouts (E11) ═══
// A callout is the bot's OWN fill, never an opinion: the instrument, the venue, the buy transaction
// anyone can look up, the market cap at the moment of posting, the tier, and the exit plan declared
// up front. Before a word reaches a channel the record is written to the ledger with
// sha256(venue|instrument|tx|ts|mcapUsd|tier|plan), so the track record is anchored at post time
// trimmed or back-dated later. Every outcome is posted too, losses included: a channel that only
// shows its winners is the thing this exists to not be.
//
// Delivery is a bonus, exactly as with alerts. Nothing in here may stop a trade, so onFill and
// onOutcome never throw; a channel that is down is recorded as such and the others still post.

import { createHash } from "node:crypto";

const HOUR = 60 * 60_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = s => { const t = String(s || ""); return t.length > 12 ? `${t.slice(0, 6)}..${t.slice(-4)}` : t; };
const usd = n => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const escapeHtml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Where a reader goes to verify the transaction and to look at the token, per venue. */
export const LINKS = Object.freeze({
  pumpfun: Object.freeze({ tx: tx => `https://solscan.io/tx/${tx}`, token: ca => `https://pump.fun/coin/${ca}` }),
  pons: Object.freeze({ tx: tx => `https://robinhoodchain.blockscout.com/tx/${tx}`, token: ca => (process.env.PONS_TOKEN_URL || "https://www.ponsfamily.com/launchpad/{ca}").replace("{ca}", ca) }),
  arc: Object.freeze({ tx: tx => `https://explorer.arc.io/tx/${tx}`, token: ca => (process.env.ARC_TOKEN_URL || "https://explorer.arc.io/token/{ca}").replace("{ca}", ca) }),
});

/** A hold time a person reads at a glance: 45s, 3m, 1h12m. */
export function heldLabel(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

/** '+42% in 3m' for a win, '-8% stopped after 3m' for a loss. The reason names the exit layer. */
export function resultLine(result) {
  const pct = Number(result?.pnl_pct) || 0;
  const signed = `${pct > 0 ? "+" : ""}${pct.toFixed(pct % 1 ? 1 : 0)}%`;
  const held = heldLabel(result?.held_ms);
  if (pct > 0) return `${signed} in ${held}`;
  const reason = String(result?.reason || "").toLowerCase();
  const word = /stop/.test(reason) ? "stopped" : /stall|doa/.test(reason) ? "cut flat" : /max_hold|timeout|time/.test(reason) ? "timed out" : reason ? reason.replace(/_/g, " ") : "closed";
  return `${signed} ${word} after ${held}`;
}

const planLabel = plan => (plan && typeof plan === "object") ? String(plan.label || plan.key || "") : String(plan || "");
const planLine = plan => {
  if (!plan || typeof plan !== "object") return planLabel(plan);
  const bits = [planLabel(plan)];
  if (plan.stop_pct != null) bits.push(`stop ${plan.stop_pct}%`);
  if (plan.target_pct != null) bits.push(`target ${plan.target_pct}%`);
  if (plan.max_hold_ms) bits.push(`max hold ${heldLabel(plan.max_hold_ms)}`);
  return bits.filter(Boolean).join(", ");
};

export class Callouts {
  /**
   * @param channels.webhookUrl   a Slack/Discord/ntfy endpoint, the same JSON shape the Alerter sends
   * @param channels.telegram     { token, chatId } for the Bot API; outcomes reply to the original post
   * @param minTier               fills below this tier are traded but not called: the channel stays scarce
   * @param dedupeMs              one callout per instrument in this window across every user of the hub
   */
  constructor({ ledger, clock = () => Date.now(), fetchImpl = globalThis.fetch, channels = {}, statusUrl = "", minTier = 2, dedupeMs = HOUR, sleepImpl = null, retries = 2, feedLimit = 500, links = LINKS } = {}) {
    this.ledger = ledger; this.clock = clock; this.fetch = fetchImpl; this.statusUrl = statusUrl;
    this.minTier = minTier; this.dedupeMs = dedupeMs; this.retries = retries; this.feedLimit = feedLimit; this.links = links;
    this.sleep = sleepImpl || sleep;
    this.channels = {};
    if (channels.webhookUrl) this.channels.webhook = { url: channels.webhookUrl };
    if (channels.telegram?.token && channels.telegram?.chatId) this.channels.telegram = { token: channels.telegram.token, chatId: channels.telegram.chatId };
    this.calls = [];               // oldest first; the ledger is the truth, this is the working copy
    this.byId = new Map();
    this.lastAt = new Map();       // instrument -> ts of its last callout, for the dedupe window
    this.lastError = null;
    this.skipped = { paper: 0, tier: 0, dedupe: 0, noTx: 0 };
    this._rehydrate();
  }

  /** A restart must not call the same instrument twice or forget the public record: rebuild both from the ledger. */
  _rehydrate() {
    if (typeof this.ledger?.query !== "function") return;
    let recs = [];
    // A delivered call is four records (call, delivery, result, result_delivery).
    try { recs = this.ledger.query({ kind: "callout", limit: this.feedLimit * 4 }); } catch { return; }
    for (const r of recs) {
      if (r.phase === "call") this._remember({ ...r, positionId: r.positionId || "", channels: r.channels || {}, result: r.result || null, messageIds: {} });
      else if (r.phase === "delivery" && this.byId.has(r.id)) Object.assign(this.byId.get(r.id), { posted: r.posted, channels: r.channels || {}, messageIds: r.messageIds || {} });
      else if (r.phase === "result" && this.byId.has(r.id)) this.byId.get(r.id).result = r.result || null;
    }
  }

  _remember(call) {
    this.calls.push(call);
    this.byId.set(call.id, call);
    const last = this.lastAt.get(call.instrument) || 0;
    if (call.ts > last) this.lastAt.set(call.instrument, call.ts);
    if (this.calls.length > this.feedLimit) for (const gone of this.calls.splice(0, this.calls.length - this.feedLimit)) this.byId.delete(gone.id);
  }

  _url(venue, kind, value) {
    const l = this.links[venue];
    return l?.[kind] ? l[kind](value) : "";
  }

  /**
   * The bot just bought. Anchor the record, then tell the channels.
   * Paper fills never post: a paper track record is not a track record.
   */
  async onFill(position, { venue = position?.venue, tx = null, mcapUsd, tier, plan, paper } = {}) {
    try {
      const isPaper = paper ?? !!position?.paper;
      const t = tier ?? position?.tier ?? 0;
      const instrument = String(position?.instrument || "");
      if (isPaper) { this.skipped.paper++; return { posted: false, id: null, channels: {}, reason: "paper" }; }
      if (!instrument) return { posted: false, id: null, channels: {}, reason: "no instrument" };
      if (!(Number(t) >= this.minTier)) { this.skipped.tier++; return { posted: false, id: null, channels: {}, reason: `tier ${t} below ${this.minTier}` }; }
      const ts = this.clock();
      const last = this.lastAt.get(instrument);
      if (last != null && ts - last < this.dedupeMs) { this.skipped.dedupe++; return { posted: false, id: null, channels: {}, reason: "already called" }; }
      // The whole point is a transaction anyone can look up; a fill without one is not called.
      if (!tx) { this.skipped.noTx++; return { posted: false, id: null, channels: {}, reason: "no tx" }; }

      const ref = position?.reference || {};
      const exitPlan = plan ?? position?.plan ?? null;
      const mcap = Math.round(Number(mcapUsd ?? ref.mcapUsd) || 0), planText = planLine(exitPlan);
      // The anchor covers everything the call declares up front -- venue, token, tx, time, the market
      // cap it paid, the tier, the exit plan -- so none of it can be edited later without breaking the
      // hash a reader recomputes: sha256(venue|instrument|tx|ts|mcapUsd|tier|plan).
      const hash = createHash("sha256").update(`${venue}|${instrument}|${tx}|${ts}|${mcap}|${t}|${planText}`).digest("hex");
      const call = {
        id: hash.slice(0, 16), ts, venue, instrument, positionId: String(position?.id || ""), name: String(ref.name || ""), ticker: String(ref.ticker || ""),
        mcapUsd: mcap, tier: t, tx, txUrl: this._url(venue, "tx", tx),
        url: this._url(venue, "token", instrument), plan: planText, hash, posted: null, channels: {}, result: null, messageIds: {},
      };
      // The anchor goes down before any channel is tried: the post proves nothing unless the ledger
      // already holds the hash it carries.
      this.ledger?.append({ kind: "callout", phase: "call", ts, id: call.id, venue, instrument, positionId: call.positionId, name: call.name, ticker: call.ticker, mcapUsd: call.mcapUsd, tier: t, tx: call.tx, url: call.url, plan: call.plan, hash });
      this._remember(call);
      // Dedupe from the moment of the anchor, not the delivery: a fill whose channels are down is still called.
      this.lastAt.set(instrument, ts);

      const { channels, errors, messageIds } = await this._deliver(call, this._callText(call), null);
      call.channels = channels; call.messageIds = messageIds;
      call.posted = Object.values(channels).some(v => v === "ok");
      if (Object.keys(this.channels).length) this.ledger?.append({ kind: "callout", phase: "delivery", id: call.id, venue, instrument, tier: t, mcapUsd: call.mcapUsd, posted: call.posted, channels, errors, messageIds });
      return { posted: call.posted, id: call.id, hash, channels };
    } catch (err) {
      this.lastError = err.message;
      return { posted: false, id: null, channels: {}, error: err.message };
    }
  }

  /**
   * The position closed. Fold the result into the call and post the follow-up, whatever the sign.
   * Takes the ledger's outcome record ({instrument, pnl_pct, held_ms, reason}) or the engine's
   * emitted {position, pnl} pair.
   */
  async onOutcome(outcome = {}) {
    try {
      const p = outcome.position || null;
      // A paper close is never a result, whatever it closed: the hub shares one record across users
      // and a paper engine can hold the same token a called live fill holds.
      if (outcome.paper ?? !!p?.paper) return { posted: false, id: null, channels: {}, reason: "paper" };
      const instrument = String(outcome.instrument || p?.instrument || "");
      const pid = String(outcome.positionId ?? p?.id ?? "") || null; // unknown is null: the instrument fallback, never a mismatch
      const call = this._openCall(instrument, outcome.calloutId, pid);
      if (!call) return { posted: false, id: null, channels: {}, reason: this._openCall(instrument, null, null) ? "not the called fill" : "not called" };
      const held = outcome.held_ms ?? (p?.entryTime ? this.clock() - p.entryTime : 0);
      const pnlPct = outcome.pnl_pct ?? (p?.cost_usd > 0 && Number.isFinite(outcome.pnl) ? +((outcome.pnl / p.cost_usd) * 100).toFixed(2) : 0);
      const result = { pnl_pct: +(Number(pnlPct) || 0).toFixed(2), held_ms: Math.max(0, Math.round(Number(held) || 0)), reason: String(outcome.reason || p?.exitReason || "") };
      call.result = result;
      // Same rule as the entry: the ledger holds the result before the channels hear of it.
      this.ledger?.append({ kind: "callout", phase: "result", id: call.id, venue: call.venue, instrument, tier: call.tier, mcapUsd: call.mcapUsd, hash: call.hash, result });
      const { channels, errors } = await this._deliver(call, this._resultText(call), call.messageIds);
      if (Object.keys(this.channels).length) this.ledger?.append({ kind: "callout", phase: "result_delivery", id: call.id, venue: call.venue, instrument, posted: Object.values(channels).some(v => v === "ok"), channels, errors });
      return { posted: Object.values(channels).some(v => v === "ok"), id: call.id, channels, result };
    } catch (err) {
      this.lastError = err.message;
      return { posted: false, id: null, channels: {}, error: err.message };
    }
  }

  /** The unresolved call for THIS fill: by id, else by the position that made it, else (for a call
   *  anchored before positions were recorded) the latest unresolved call on the instrument. Another
   *  engine's close of the same token is not this call's result. */
  _openCall(instrument, id = null, positionId = null) {
    if (id && this.byId.has(id)) { const c = this.byId.get(id); return c.result ? null : c; }
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i];
      if (c.instrument !== instrument || c.result) continue;
      if (c.positionId && positionId != null) { if (c.positionId === positionId) return c; continue; }
      return c;
    }
    return null;
  }

  _title(call) { return `${call.ticker ? `$${call.ticker}` : short(call.instrument)}${call.name ? ` (${call.name})` : ""}`; }
  // The plain text goes to Slack, where <!channel> in a token's name would page everyone: its angle
  // brackets and ampersands are escaped there; Discord gets allowed_mentions instead (below).
  _plainTitle(call) { return this._title(call).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  _recordUrl() { return this.statusUrl ? `${this.statusUrl}/callouts` : ""; }

  _callText(call) {
    const lines = [
      `CALLOUT ${this._plainTitle(call)} on ${call.venue}`,
      `mcap ${usd(call.mcapUsd)} at post, tier ${call.tier}${call.plan ? `, exit plan: ${call.plan}` : ""}`,
      `bought: ${call.tx ? (call.txUrl || call.tx) : "(no tx)"}`,
    ];
    if (call.url) lines.push(`token: ${call.url}`);
    lines.push(`anchor: ${call.hash.slice(0, 16)}`);
    if (this._recordUrl()) lines.push(`record: ${this._recordUrl()}`);
    const html = [
      `<b>CALLOUT</b> ${escapeHtml(this._title(call))} on ${escapeHtml(call.venue)}`,
      `mcap ${usd(call.mcapUsd)} at post, tier ${call.tier}${call.plan ? `, exit plan: ${escapeHtml(call.plan)}` : ""}`,
      call.tx ? `bought: <a href="${escapeHtml(call.txUrl || call.tx)}">${escapeHtml(short(call.tx))}</a>` : "bought: (no tx)",
      call.url ? `token: <a href="${escapeHtml(call.url)}">${escapeHtml(call.instrument)}</a>` : `token: <code>${escapeHtml(call.instrument)}</code>`,
      `anchor: <code>${call.hash.slice(0, 16)}</code>`,
      this._recordUrl() ? `record: ${escapeHtml(this._recordUrl())}` : "",
    ].filter(Boolean);
    return { text: lines.join("\n"), html: html.join("\n"), title: `bondli callout ${call.ticker || short(call.instrument)}` };
  }

  _resultText(call) {
    const line = resultLine(call.result);
    const text = `${this._plainTitle(call)}: ${line}${call.tx ? ` (entry ${short(call.tx)})` : ""}`;
    return { text, html: `${escapeHtml(this._title(call))}: <b>${escapeHtml(line)}</b>`, title: `bondli result ${call.ticker || short(call.instrument)}` };
  }

  /** Every configured channel is tried, each on its own; one failing never blocks another. */
  async _deliver(call, msg, replyTo) {
    const channels = {}, errors = {}, messageIds = {};
    const jobs = Object.entries(this.channels).map(async ([name, cfg]) => {
      try {
        const r = name === "telegram" ? await this._telegram(cfg, msg, replyTo?.telegram) : await this._webhook(cfg, msg);
        channels[name] = "ok";
        if (r?.messageId != null) messageIds[name] = r.messageId;
      } catch (err) {
        channels[name] = "error";
        errors[name] = err.message;
        this.lastError = `${name}: ${err.message}`;
      }
    });
    await Promise.all(jobs);
    return { channels, errors, messageIds };
  }

  async _post(url, payload) {
    let error = null;
    for (let i = 0; i < this.retries; i++) {
      try {
        const res = await this.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5_000) });
        if (res.ok) return res;
        error = new Error(`http ${res.status}`);
      } catch (err) { error = err; }
      // A receiver that is briefly down gets one more chance; a fill is not re-called later.
      if (i < this.retries - 1) await this.sleep(500 * (i + 1));
    }
    throw error;
  }

  async _webhook(cfg, msg) {
    // Slack reads text, Discord reads content, ntfy reads message: one paste, any receiver.
    await this._post(cfg.url, { text: msg.text, content: msg.text, message: msg.text, title: msg.title, level: "info", priority: 3, allowed_mentions: { parse: [] } });
    return {};
  }

  async _telegram(cfg, msg, replyTo) {
    const payload = { chat_id: cfg.chatId, text: msg.html, parse_mode: "HTML", disable_web_page_preview: true };
    if (replyTo != null) payload.reply_to_message_id = replyTo;
    const res = await this._post(`https://api.telegram.org/bot${cfg.token}/sendMessage`, payload);
    let body = null;
    try { body = typeof res.json === "function" ? await res.json() : null; } catch { /* a receiver that answers with no body still delivered */ }
    if (body && body.ok === false) throw new Error(`telegram: ${body.description || "refused"}`);
    return { messageId: body?.result?.message_id ?? null };
  }

  /** The public list, newest first. Nothing in a row identifies whose engine made the trade. */
  feed(limit = 50) {
    const out = [];
    for (let i = this.calls.length - 1; i >= 0 && out.length < limit; i--) {
      const c = this.calls[i];
      out.push({ id: c.id, ts: c.ts, venue: c.venue, instrument: c.instrument, name: c.name, ticker: c.ticker, mcapUsd: c.mcapUsd, tier: c.tier, tx: c.tx, txUrl: c.txUrl || "", url: c.url, plan: c.plan, result: c.result ? { pnl_pct: c.result.pnl_pct, held_ms: c.result.held_ms, reason: c.result.reason } : null, hash: c.hash });
    }
    return out;
  }

  /** The track record as it stands, wins and losses alike. */
  record() {
    const done = this.calls.filter(c => c.result);
    const wins = done.filter(c => c.result.pnl_pct > 0).length;
    const sum = done.reduce((s, c) => s + c.result.pnl_pct, 0);
    const best = done.length ? Math.max(...done.map(c => c.result.pnl_pct)) : null;
    return { calls: this.calls.length, resolved: done.length, wins, winRate: done.length ? +(wins / done.length).toFixed(2) : 0, avgPct: done.length ? +(sum / done.length).toFixed(2) : 0, best };
  }

  status() {
    const last = this.calls.at(-1);
    return { channels: Object.keys(this.channels), minTier: this.minTier, dedupeMs: this.dedupeMs, ...this.record(), skipped: { ...this.skipped }, lastCallAt: last?.ts ?? null, lastPosted: last?.posted ?? null, lastError: this.lastError };
  }
}
