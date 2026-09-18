// ═══ VELOCITY — MarketEvent (DP1 contract) ═══
// The one schema every feed emits and every consumer reads.
// A feed is read-only: it may only produce these. A router never sees them.

import { createHash } from "node:crypto";

export const VENUES = Object.freeze(["pumpfun", "pons", "arc", "polymarket", "perps"]);
export const EVENT_KINDS = Object.freeze([
  "candidate",   // an instrument worth running through the decision pipeline
  "tick",        // price/mark update for an instrument (drives exits)
  "book",        // order book snapshot: best bid/ask + sizes
  "fact",        // a resolution fact from a named source
  "market",      // instrument metadata (rules, fees, groups)
  "feed_health", // feed connected / disconnected / stale
]);

let _seq = 0;

/** Build a MarketEvent. Throws on schema violation so a bad feed fails loudly. */
export function makeEvent({ venue, kind, id, payload = {}, t_venue, t_observed = Date.now() }) {
  const e = { venue, kind, id: String(id ?? ""), payload, t_venue, t_observed, seq: ++_seq };
  const errors = validateEvent(e);
  if (errors.length) throw new Error(`invalid MarketEvent: ${errors.join("; ")}`);
  return e;
}

export function validateEvent(e) {
  const errors = [];
  if (!e || typeof e !== "object") return ["not an object"];
  if (!VENUES.includes(e.venue)) errors.push(`venue ${e.venue}`);
  if (!EVENT_KINDS.includes(e.kind)) errors.push(`kind ${e.kind}`);
  if (typeof e.id !== "string" || !e.id.length) errors.push("id required");
  if (!Number.isFinite(e.t_venue)) errors.push("t_venue must be a number (ms)");
  if (!Number.isFinite(e.t_observed)) errors.push("t_observed must be a number (ms)");
  if (Number.isFinite(e.t_venue) && Number.isFinite(e.t_observed) && e.t_observed < e.t_venue - 5000)
    errors.push("t_observed earlier than t_venue by more than clock skew allowance (5s)");
  if (e.payload === null || typeof e.payload !== "object") errors.push("payload must be an object");
  return errors;
}

/** Observation latency: how long after the venue emitted it did we see it. */
export function observeLatencyMs(e) {
  return e.t_observed - e.t_venue;
}

/** Deterministic id for anything derived from an event (decisions, orders). */
export function eventHash(e, salt = "") {
  return createHash("sha256")
    .update(`${e.venue}|${e.kind}|${e.id}|${e.t_venue}|${e.seq}|${salt}`)
    .digest("hex")
    .slice(0, 16);
}

/** Reset the sequence counter (tests and replay only). */
export function resetSequence(n = 0) {
  _seq = n;
}

/** Fixed-bucket latency histogram; enough for p50/p95/p99 without a dependency. */
export class LatencyHistogram {
  constructor(maxMs = 60_000, bucketMs = 5) {
    this.bucketMs = bucketMs;
    this.buckets = new Uint32Array(Math.ceil(maxMs / bucketMs) + 1);
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }
  record(ms) {
    const v = Math.max(0, ms);
    const i = Math.min(this.buckets.length - 1, Math.floor(v / this.bucketMs));
    this.buckets[i]++;
    this.count++;
    this.sum += v;
    if (v > this.max) this.max = v;
  }
  percentile(p) {
    if (!this.count) return 0;
    const target = Math.ceil((p / 100) * this.count);
    let seen = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      seen += this.buckets[i];
      if (seen >= target) return (i + 1) * this.bucketMs;
    }
    return this.max;
  }
  summary() {
    return {
      count: this.count,
      mean: this.count ? +(this.sum / this.count).toFixed(1) : 0,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      max: this.max,
    };
  }
}
