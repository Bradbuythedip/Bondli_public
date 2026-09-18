// ═══ VELOCITY — Feed base (DP1) ═══
// A feed is read-only. It turns a venue's stream into MarketEvents, tracks its
// own health and observation latency, and never touches an order.

import { EventEmitter } from "node:events";
import { makeEvent, observeLatencyMs, LatencyHistogram } from "./events.mjs";

/** An error as it may be shown anywhere. ethers embeds the request URL, API key included, in its
 *  messages (info.requestUrl), and a feed's last error is served on the health route; a key must
 *  never travel that way. The short message is kept, every URL is replaced, the length is bounded. */
export function errorText(err, max = 300) {
  const raw = String(err?.shortMessage || err?.message || err || "");
  return raw.replace(/https?:\/\/\S+/g, "<rpc>").slice(0, max);
}

export class Feed extends EventEmitter {
  constructor({ venue, name, clock = () => Date.now(), staleAfterMs = 5_000, latencyBoundMs = 500 }) {
    super();
    if (!venue) throw new Error("feed needs a venue");
    this.venue = venue;
    this.name = name || `${venue}-feed`;
    this.clock = clock;
    this.staleAfterMs = staleAfterMs;
    this.latencyBoundMs = latencyBoundMs;
    this.latency = new LatencyHistogram();
    this.lastEventAt = null;
    this.healthy = false;
    this.running = false;
    this.watched = new Set();
    this.eventsEmitted = 0;
  }

  /** Emit one MarketEvent. t_observed is the feed clock unless replaying. */
  emitEvent({ kind, id, payload = {}, t_venue, t_observed }) {
    const e = makeEvent({
      venue: this.venue, kind, id, payload,
      t_venue: Number.isFinite(t_venue) ? t_venue : this.clock(),
      t_observed: Number.isFinite(t_observed) ? t_observed : this.clock(),
    });
    if (kind !== "feed_health") {
      this.lastEventAt = e.t_observed;
      this.latency.record(observeLatencyMs(e));
      this.eventsEmitted++;
    }
    this.emit("event", e);
    return e;
  }

  /** A successful poll with nothing to report still proves the feed is alive. */
  touch() { this.lastEventAt = this.clock(); }

  markHealth(healthy, detail = "") {
    const changed = healthy !== this.healthy;
    this.healthy = healthy;
    if (changed) this.emitEvent({ kind: "feed_health", id: this.name, payload: { healthy, detail } });
  }

  ageMs() {
    return this.lastEventAt == null ? Infinity : this.clock() - this.lastEventAt;
  }
  isStale() {
    return this.ageMs() > this.staleAfterMs;
  }
  status() {
    const lat = this.latency.summary();
    return {
      venue: this.venue, name: this.name, healthy: this.healthy, running: this.running,
      ageMs: this.ageMs() === Infinity ? null : this.ageMs(), stale: this.isStale(),
      latency: lat, latencyBoundMs: this.latencyBoundMs, withinBound: lat.count === 0 || lat.p95 <= this.latencyBoundMs,
      watched: [...this.watched], events: this.eventsEmitted,
    };
  }

  /** Instruments the engine holds; feeds may poll these more often. */
  watch(id) { this.watched.add(String(id)); }
  unwatch(id) { this.watched.delete(String(id)); }

  async start() { this.running = true; this.markHealth(true, "started"); }
  async stop() { this.running = false; this.markHealth(false, "stopped"); }
}

/** A feed that plays a script of events on timers. Used by tests and the T9 crash drill. */
export class ScriptedFeed extends Feed {
  constructor({ venue, script = [], loop = false, ...rest }) {
    super({ venue, name: `${venue}-scripted`, ...rest });
    this.script = script;
    this.loop = loop;
    this._timers = [];
  }
  async start() {
    await super.start();
    const run = () => {
      let at = 0;
      for (const step of this.script) {
        at += step.delayMs || 0;
        const t = setTimeout(() => {
          if (!this.running) return;
          this.emitEvent({ kind: step.kind, id: step.id, payload: step.payload || {}, t_venue: step.t_venue ?? this.clock() - (step.lagMs || 0) });
        }, at);
        this._timers.push(t);
      }
      if (this.loop) this._timers.push(setTimeout(() => this.running && run(), at + 10));
    };
    run();
  }
  async stop() {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    await super.stop();
  }
}
