// ═══ The activity gate: nothing outside is polled unless someone is trading ═══
// Every feed, stream and poller in the server costs somebody else's quota: RPC calls on three chains,
// PumpPortal, DexScreener, Coinbase, Bags. With no bot running there is nobody those calls serve, so
// they stop. The gate is one number -- how many bots are running -- with a grace period after the
// last one stops, so a user who stops and restarts inside a few minutes does not pay the cold start
// (an empty radar, a feed that has to see launches again) twice. ALWAYS_ON=1 keeps everything hot.
export class ActivityGate {
  constructor({ graceMs = 10 * 60_000, alwaysOn = false, clock = () => Date.now(), log = console } = {}) {
    this.graceMs = graceMs; this.alwaysOn = !!alwaysOn; this.clock = clock; this.log = log;
    this.running = 0; this.lastActiveAt = 0; this._active = this.alwaysOn; this._listeners = new Set(); this._timer = null;
    this.since = clock(); this.transitions = 0;
  }
  /** How many bots are running right now. Called on every start and stop. */
  note(count) {
    this.running = Math.max(0, Number(count) || 0);
    const now = this.clock();
    if (this.running > 0) { this.lastActiveAt = now; this._set(true, "bots running"); if (this._timer) { clearTimeout(this._timer); this._timer = null; } return; }
    if (!this._active || this.alwaysOn) return;
    // Idle only once the grace has passed with nobody back.
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; if (this.running === 0) this._set(false, `no bot for ${Math.round(this.graceMs / 60_000)}m`); }, this.graceMs);
    this._timer.unref?.();
  }
  active() { return this.alwaysOn || this._active; }
  /** fn(active: boolean, why) on every transition; called at once with the current state. */
  on(fn) { this._listeners.add(fn); try { fn(this.active(), "subscribed"); } catch (err) { this.log.error?.(`[ACTIVITY] listener: ${err.message}`); } return () => this._listeners.delete(fn); }
  _set(active, why) {
    if (active === this._active) return;
    this._active = active; this.since = this.clock(); this.transitions++;
    this.log.log?.(`[ACTIVITY] ${active ? "active" : "idle"}: ${why}`);
    for (const fn of this._listeners) { try { fn(active, why); } catch (err) { this.log.error?.(`[ACTIVITY] listener: ${err.message}`); } }
  }
  status() { return { active: this.active(), alwaysOn: this.alwaysOn, running: this.running, since: this.since, graceMs: this.graceMs, lastActiveAt: this.lastActiveAt || null, transitions: this.transitions }; }
}
