// ═══ VELOCITY — Live state store (DP6) ═══
// One JSON snapshot, written atomically (temp file + rename). Holds what the
// operator needs to see and what a restart needs to reconcile. The ledger is
// the record; this is the current picture. Fewer parts than Redis, same FR.

import fs from "node:fs";
import path from "node:path";

export const HALT_MODES = Object.freeze(["freeze", "flatten"]);
export const VENUE_MODES = Object.freeze(["off", "paper", "live"]);

function defaultState(now) {
  return {
    version: 1,
    startedAt: now,
    savedAt: now,
    heartbeatAt: now,
    reconciledAt: null,
    positions: {},            // positionId -> position
    halt: { mode: null, reason: null, since: null, venues: {} },
    throttle: 1,
    governor: { reasons: [], blindSpots: {} },
    regime: "RISK_ON",
    feeds: {},                // venue -> { lastEventAt, healthy, stale }
    routers: {},              // venue -> { ok, latencyMs, checkedAt }
    venues: {},               // venue -> { mode }
    weightsVersion: 0,
    day: { date: dayKey(now), realizedUsd: 0, trades: 0, paperRealizedUsd: 0, paperTrades: 0, lossAckUsd: 0 },
    alerts: [],
    lastDecisions: [],
  };
}

export function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export class Store {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return defaultState(this.now());
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { ...defaultState(this.now()), ...parsed };
    } catch {
      // A torn snapshot is not fatal: the ledger reconstructs positions.
      return defaultState(this.now());
    }
  }

  save() {
    this.state.savedAt = this.now();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
    return this.state;
  }

  rollDay() {
    const key = dayKey(this.now());
    // Paper and live are counted apart. They fund the same daily loss limit only when there is no
    // live venue at all, and then it is the simulation's own limit.
    if (this.state.day.date !== key) this.state.day = { date: key, realizedUsd: 0, trades: 0, paperRealizedUsd: 0, paperTrades: 0, lossAckUsd: 0 };
    if (this.state.day.paperRealizedUsd == null) { this.state.day.paperRealizedUsd = 0; this.state.day.paperTrades = 0; } // an older state file
    return this.state.day;
  }

  // ── positions ──
  openPositions(venue = null) {
    return Object.values(this.state.positions).filter(p => p.status === "open" && (!venue || p.venue === venue));
  }
  upsertPosition(pos) {
    this.state.positions[pos.id] = pos;
    return pos;
  }
  closePosition(id, patch = {}) {
    const p = this.state.positions[id];
    if (!p) return null;
    Object.assign(p, patch, { status: "closed", closedAt: this.now() });
    return p;
  }

  // ── halt / venues ──
  setHalt(mode, reason, venue = null) {
    if (mode && !HALT_MODES.includes(mode)) throw new Error(`halt mode must be one of ${HALT_MODES.join("|")}`);
    if (venue) this.state.halt.venues[venue] = mode ? { mode, reason, since: this.now() } : undefined;
    else this.state.halt = { mode, reason, since: mode ? this.now() : null, venues: this.state.halt.venues || {} };
    return this.state.halt;
  }
  isHalted(venue = null) {
    if (this.state.halt.mode) return this.state.halt;
    if (venue && this.state.halt.venues?.[venue]) return this.state.halt.venues[venue];
    return null;
  }
  setVenueMode(venue, mode, extra = {}) {
    if (!VENUE_MODES.includes(mode)) throw new Error(`venue mode must be one of ${VENUE_MODES.join("|")}`);
    this.state.venues[venue] = { ...(this.state.venues[venue] || {}), mode, since: this.now(), ...extra };
    return this.state.venues[venue];
  }
  venueMode(venue) {
    return this.state.venues[venue]?.mode || "off";
  }

  noteDecision(decision) {
    this.state.lastDecisions.unshift({
      id: decision.id, venue: decision.venue, instrument: decision.instrument, action: decision.action,
      gate: decision.gate, reason: (decision.reasons || [])[0] || null, waived: (decision.reasons || []).find(r => /^momentum waived /.test(r)) || null, ts: decision.t_decided,
    });
    if (this.state.lastDecisions.length > 20) this.state.lastDecisions.length = 20;
  }

  alert(level, text) {
    const a = { level, text, ts: this.now() };
    this.state.alerts.unshift(a);
    if (this.state.alerts.length > 50) this.state.alerts.length = 50;
    return a;
  }
}
