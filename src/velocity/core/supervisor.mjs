// ═══ VELOCITY — Supervisor (DP9) ═══
// Heartbeat, feed-staleness watchdog, router health probe, HALT file, and a
// dead-man check. A stale feed or dead router blocks entries for that venue
// while exits keep running. Restart is the process manager's job (systemd, pm2);
// the engine's reconcile() runs before any new risk is taken.

import fs from "node:fs";
import path from "node:path";

export class Supervisor {
  constructor({ engine, dataDir, clock = () => Date.now(), heartbeatMs = 10_000, watchdogMs = 2_000, deadmanMs = 60_000, alerter = null }) {
    this.engine = engine;
    this.dataDir = dataDir;
    this.clock = clock;
    this.heartbeatMs = heartbeatMs;
    this.watchdogMs = watchdogMs;
    this.deadmanMs = deadmanMs;
    this.alerter = alerter;
    this._timers = [];
    this._beats = 0;
    this.haltFile = path.join(dataDir, "HALT");
    this.heartbeatFile = path.join(dataDir, "heartbeat");
  }

  start() {
    this.heartbeat();
    this._timers.push(setInterval(() => this.heartbeat(), this.heartbeatMs).unref());
    this._timers.push(setInterval(() => {
      // A live order can hold the engine queue for tens of seconds; queued watchdogs would then
      // run back to back and delay exits. One in flight at a time.
      if (this._watchdogPending) return;
      this._watchdogPending = true;
      this.engine.enqueue(() => this.watchdog().finally(() => { this._watchdogPending = false; }));
    }, this.watchdogMs).unref());
  }
  stop() { for (const t of this._timers) clearInterval(t); this._timers = []; }

  heartbeat() {
    const now = this.clock();
    this.engine.store.state.heartbeatAt = now;
    try { fs.writeFileSync(this.heartbeatFile, String(now)); } catch {}
    if (++this._beats % 6 === 0) this.engine.ledger.append({ kind: "heartbeat", positions: this.engine.store.openPositions().length, throttle: this.engine.store.state.throttle });
  }

  async watchdog() {
    const e = this.engine;
    for (const [venue, v] of Object.entries(e.venues)) {
      if (e.store.venueMode(venue) === "off") continue;
      const feedStale = v.feed ? v.feed.isStale() && v.feed.eventsEmitted > 0 : false;
      const neverSeen = v.feed ? v.feed.eventsEmitted === 0 && v.feed.running && v.feed.ageMs() === Infinity : false;
      const router = e.routerFor(venue);
      let health = { ok: true };
      if (router?.health) { try { health = await Promise.race([router.health(), new Promise(r => setTimeout(() => r({ ok: false, detail: "health timeout" }), 1_500))]); } catch (err) { health = { ok: false, detail: err.message }; } }
      e.store.state.routers[venue] = { ...health, checkedAt: this.clock() };
      e.store.state.feeds[venue] = { ...(e.store.state.feeds[venue] || {}), stale: feedStale, ageMs: v.feed?.ageMs() === Infinity ? null : v.feed?.ageMs() };
      const before = e.blocked[venue] || null;
      const reason = feedStale ? "FEED_STALE" : neverSeen ? "FEED_NO_DATA" : !health.ok ? "ROUTER_DOWN" : null;
      if (reason) e.blocked[venue] = reason; else delete e.blocked[venue];
      if (reason !== before) {
        e.ledger.append({ kind: "feed", venue, blocked: reason, detail: reason === "ROUTER_DOWN" ? health.detail : v.feed?.status() });
        if (reason) this.alerter?.send("warn", `${venue}: entries blocked (${reason}); exits keep running`);
      }
    }
    // HALT file: works even when the control server is down.
    if (fs.existsSync(this.haltFile)) {
      const mode = (fs.readFileSync(this.haltFile, "utf8").trim() || "freeze").toLowerCase();
      await e.halt(mode === "flatten" ? "flatten" : "freeze", "HALT file", { by: "file" });
      try { fs.unlinkSync(this.haltFile); } catch {}
    }
  }

  /** For a status reader with no running engine: is the last heartbeat too old? */
  static deadman(dataDir, { now = Date.now(), deadmanMs = 60_000 } = {}) {
    const f = path.join(dataDir, "heartbeat");
    if (!fs.existsSync(f)) return { alive: false, ageMs: null, detail: "no heartbeat file" };
    const at = Number(fs.readFileSync(f, "utf8")) || 0;
    const age = now - at;
    return { alive: age <= deadmanMs, ageMs: age, detail: age <= deadmanMs ? "heartbeat fresh" : `last heartbeat ${Math.round(age / 1000)}s ago` };
  }
}
