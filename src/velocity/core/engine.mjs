// ═══ VELOCITY — Engine wiring ═══
// feed -> pipeline (DP2) -> sizer (DP3) -> router (DP4) -> position with plan (DP5)
// ticks -> exits (DP5) -> router -> outcome -> governor (DP7)
// Every stage writes to the ledger (DP6) before the next stage runs.
// Events are processed one at a time so two candidates for the same
// instrument cannot both enter, and a crash leaves a single clean stage.

import path from "node:path";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { Ledger } from "./ledger.mjs";
import { Store } from "./store.mjs";
import { GateRunner } from "./pipeline.mjs";
import { Sizer } from "./risk.mjs";
import { createPlan, evaluateExit, markPosition, applyExitStamp } from "./exits.mjs";
import { Governor } from "./governor.mjs";
import { WeightStore, checksumFiles, verifyChecksums, retrain } from "./learner.mjs";
import { LatencyHistogram } from "./events.mjs";
import { statsFromOutcomes } from "./stats.mjs";
import { promotionGate } from "./promote.mjs";

/** Venues that trade a bonding curve in a quote asset: pump.fun (SOL) and PONS on Robinhood Chain (ETH).
 *  Positions are marked by market cap, plans are the tiered layers, fills carry sol_spent / sol_received
 *  (the quote asset), and reference.solPrice is that quote asset's USD price. */
// Arc's Argus is not a virtual curve -- it is one concentrated Uniswap v4 position the price walks
// up through -- but from the engine's side it trades like one: a launch, a rising price, buyers
// and sellers, a quote asset. So it shares the curve venues' plans, exits and cost model.
export const CURVE_VENUES = new Set(["pumpfun", "pons", "arc"]);

/** The market cap a curve position is marked from at entry. On PONS the fill is exact (quote spent
 *  and tokens received from the receipt), so the mark is what was actually paid per token times the
 *  fixed supply: the feed's estimate drifts from the chain by the fees and phantom reserve, which
 *  showed as a +20% "gain" the moment a position opened. pump.fun keeps the radar's market cap. */
export function curveEntryMark(venue, fill, decision) {
  if ((venue === "pons" || venue === "arc") && fill?.qty > 0 && fill?.price > 0) return +(fill.price * 1_000_000_000).toFixed(2); // both launch a fixed 1e9 supply
  return CURVE_VENUES.has(venue) ? (decision.reference?.mcapUsd || 0) : fill.price;
}

/** Gate-1 flags that describe the token, not the last minute: a reject on these stands. */
export const FATAL_FLAGS = new Set(["SERIAL_LAUNCHER", "SERIAL_RUGGER", "DEV_SELF_SNIPE", "FREEZE_AUTHORITY", "STOLEN_ART", "TOO_LATE"]);

/** Sell failures that no retry can fix, because the venue has changed in a way that cannot change
 *  back. Only GRADUATED qualifies today: a PONS curve that completed moved to a Uniswap V4 pool the
 *  router does not speak, and it never un-graduates. Everything else the routers report -- REVERT,
 *  UNREADABLE, NO_CURVE, SEND_FAILED -- can be an RPC having a bad minute, and is retried. */
// UNSUPPORTED: a sell the venue itself cannot make (no Permit2 on the chain, a quote asset the router
// does not pay in); retrying it five times changes nothing.
export const TERMINAL_EXIT_CODES = new Set(["GRADUATED", "UNSUPPORTED"]);

export class Engine extends EventEmitter {
  constructor({ dataDir, envelope, venues = {}, clock = () => Date.now(), config = {}, alerter = null }) {
    super();
    this.dataDir = dataDir;
    this.env = envelope;
    this.clock = clock;
    this.cfg = { governorMs: 5_000, saveMs: 5_000, sweepMs: 5_000, reentryCooldownMs: 5 * 60_000,
      // After a DOA or STALL exit: we left because nothing was happening, not because it was bad.
      retryCooldownMs: 45_000,
      failCooldownMs: 60_000, sweepRetryMs: 15_000, tickSilenceMs: 15_000, walletRefreshMs: 30_000, walletMaxAgeMs: 5 * 60_000, retrainEvery: 50, disqualifyMs: 5 * 60_000, rejudgeMs: 30_000, haltNoticeMs: 5 * 60_000, releaseAfterFailures: 5,
      // How far a refused token has to run before the refusal counts as a miss, and for how long
      // after the refusal it stays under observation.
      missMultiple: 1.6, missWatchMs: 10 * 60_000,
      // How far back realized statistics look. See modeStats: without a window they never revise.
      statsWindowMs: 14 * 24 * 60 * 60_000, ...config };
    this.ledger = new Ledger(path.join(dataDir, "ledger.jsonl"), { now: clock });
    this.store = new Store(path.join(dataDir, "state.json"), { now: clock });
    this.weights = new WeightStore(path.join(dataDir, "weights"));
    this.governor = new Governor({ ledger: this.ledger, envelope, clock });
    this.sizer = new Sizer(envelope);
    this.alerter = alerter;
    this.venues = {};
    for (const [venue, v] of Object.entries(venues)) {
      this.venues[venue] = { ...v, runner: v.edge ? new GateRunner({ venue, edge: v.edge }) : null };
      // The config mode seeds a venue the store has never seen. A persisted mode (an operator's
      // go-live, or a paper downgrade) wins over the file on restart.
      if (v.mode && !this.store.state.venues[venue]?.mode) this.store.setVenueMode(venue, v.mode);
    }
    this.latency = {};
    for (const venue of Object.keys(this.venues)) this.latency[venue] = { decide: new LatencyHistogram(10_000, 1), send: new LatencyHistogram(), confirm: new LatencyHistogram() };
    this.blocked = {};          // venue -> reason from the supervisor (feed stale, router down)
    this.inflight = new Set();  // instruments with an ENTRY in flight
    this.exiting = new Set();   // position ids with a SELL in flight (see closePosition)
    this.cooldown = new Map();  // instrument -> until
    // instrument -> { until, at, mcap, gate, reasons, tier, peak, missed }. Two jobs: a gate-1 reject
    // is not re-judged every poll (see FATAL_FLAGS), and the token is kept under observation
    // afterwards so a rule that refused a runner leaves a record. See noteRejected/watchRejected.
    this.disqualified = new Map();
    this._entryBlockedLogged = new Map(); // instrument -> until; one "already in / cooling down" line per window, not one per tick
    this._haltNoticed = new Map(); // venue -> ts; one halt line per window, not one per refused candidate
    this.pendingBuys = new Map();  // instrument -> { sig, decision, orderId, stake, sizing, at }: sent, not yet confirmed
    this.wallet = { sol: null, usd: null, solPrice: null, at: 0, venue: null }; // last live wallet reading (bankroll_source: wallet)
    this.wallets = {}; // venue -> reading; a hosted user trades pump.fun from a SOL wallet and PONS from an ETH wallet
    this.quotePrice = {}; // venue -> quote asset price in USD (SOL, ETH), from that venue's own events
    this._knownForeign = new Set(); // venue:instrument the wallet holds that the bot never bought
    this._holdings = {}; // venue -> { at, list: [{ instrument, qty }] } as the venue last reported them
    this._lastHoldingsReconcile = 0;
    this._lastSweepTry = new Map();
    this.stats = this.modeStats();
    this.checksums = checksumFiles();
    this.verdict = { throttle: 1, halt: false, reasons: [] };
    this.running = false;
    this._queue = Promise.resolve();
    this._timers = [];
    this._outcomesSinceRetrain = 0;
    this._lastGovernorKey = null;
  }

  // ── lifecycle ──
  async start({ reconcile = true } = {}) {
    this.running = true;
    this.store.state.startedAt = this.clock();
    this.store.state.baseline = null; // the header P&L restarts from the wallet as it is now
    this.store.rollDay();
    await this.initLiveRouters();
    if (reconcile) await this.reconcile();
    this.evaluateGovernor();
    for (const [venue, v] of Object.entries(this.venues)) {
      if (this.store.venueMode(venue) === "off" || !v.feed) continue;
      v.feed.on("event", e => this.enqueue(() => this.onEvent(e)));
      for (const p of this.store.openPositions(venue)) v.feed.watch(p.instrument);
      await v.feed.start();
    }
    // unref: the control server keeps a real deployment alive; tests and tools must be able to exit.
    this._timers.push(setInterval(() => this.enqueue(() => this.evaluateGovernor()), this.cfg.governorMs).unref());
    this._timers.push(setInterval(() => this.store.save(), this.cfg.saveMs).unref());
    this._timers.push(setInterval(() => this.enqueue(() => this.sweep()), this.cfg.sweepMs).unref());
    this.store.save();
    this.emit("started");
  }

  /** A venue persisted as live gets its router initialized before any reconcile, order or exit.
   *  If that fails the venue freezes rather than treating an uninitialized router as an empty venue. */
  /** An EVM wallet cannot list its tokens: the router only knows what it is told. Tell it every
   *  instrument this engine ever bought (store positions, ledger fills, orders sent), so a restart
   *  does not make the wallet's holdings invisible and the store's positions "missing". */
  seedRouterKnowledge(venue) {
    const r = this.venues[venue]?.liveRouter;
    if (!r?.track) return 0;
    const inst = new Set();
    for (const p of Object.values(this.store.state.positions)) if (p.venue === venue && p.instrument) inst.add(p.instrument);
    try { for (const f of this.ledger.readAll(x => x.venue === venue && x.instrument && (x.kind === "fill" || (x.kind === "order" && x.stage === "sent")))) inst.add(f.instrument); } catch {}
    for (const i of inst) r.track(i);
    return inst.size;
  }

  async initLiveRouters() {
    for (const [venue, v] of Object.entries(this.venues)) {
      const mode = this.store.venueMode(venue);
      if (v.mode && v.mode !== mode) this.log("warn", `${venue}: config says ${v.mode}, persisted mode ${mode} wins (change it with: velocity venue ${venue} ${v.mode})`);
      if (mode !== "live" || !v.liveRouter || v.liveRouter.ready) continue;
      try {
        const pre = await v.liveRouter.init();
        const seeded = this.seedRouterKnowledge(venue);
        if (seeded) this.log("info", `${venue}: router told about ${seeded} instrument(s) this wallet has traded`);
        const h = await v.liveRouter.health();
        if (!h.ok) throw new Error(h.detail);
        this.ledger.append({ kind: "venue", venue, mode: "live", by: "restart", preflight: pre });
        this.log("info", `${venue}: live router ready${pre?.wallet ? ` (wallet ${pre.wallet}, ${Number(pre.balanceSol).toFixed(4)} ${pre.quote || "SOL"})` : ""}`);
        this._clearStartupFreeze(venue, /^(live router not ready|reconcile)/);
        this.noteWallet(venue, pre);
      } catch (err) {
        const reason = `live router not ready: ${err.message}`;
        this.log("error", `${venue}: ${reason}; entries frozen`);
        this.store.setHalt("freeze", reason, venue);
        this.ledger.append({ kind: "halt", mode: "freeze", reason, by: "restart", venue });
        this.alerter?.send("error", `${venue} is live but its router failed to initialize: ${err.message}. Entries frozen; fix .env and restart, or: velocity venue ${venue} paper`);
      }
    }
  }

  /** A freeze this engine wrote at a failed startup is lifted by a startup that succeeds; an
   *  operator's own freeze (halt freeze, governor) is not touched. */
  _clearStartupFreeze(venue, pattern) {
    const h = this.store.state.halt.venues?.[venue];
    if (!h || !pattern.test(h.reason || "")) return;
    this.store.setHalt(null, null, venue);
    this.ledger.append({ kind: "resume", venue, by: "restart", cleared: h.reason });
    this.log("info", `${venue}: earlier freeze lifted (${h.reason})`);
  }

  // ── wallet as bankroll (bankroll_source: wallet) ──
  walletMode() { return this.env.bankroll_source === "wallet"; }

  /** What a venue keeps back for fees, in ITS OWN quote asset. SOL and ETH are not interchangeable
   *  numbers: 0.006 is about a dollar of SOL and about twenty of ETH, and the same literal used for
   *  both is how a funded Robinhood Chain wallet gets told it is too small to trade. */
  quoteReserve(venue) {
    return venue === "pumpfun" ? (this.env.wallet_reserve_sol ?? 0.02) : (this.env.wallet_reserve_quote?.[venue] ?? 0.001);
  }

  /** The venue's quote asset in USD: the engine's own reading, or the feed's if no event has
   *  reached the engine yet (the feed knows the price before the first candidate arrives). */
  quotePriceFor(venue) {
    return this.quotePriceOf(venue) || Number(this.venues[venue]?.feed?.solPrice) || 0;
  }

  /** Close the emptied token account and take its rent back. Opening one costs 0.00203928 SOL on
   *  every new mint, about $0.41, which is the largest fixed cost of a round trip and is simply left
   *  behind unless it is claimed. Deliberately not awaited: the engine queue also drives every open
   *  position's exit checks, and no stop loss should wait on a housekeeping transaction. */
  reclaimRent(venue, instrument) {
    const router = this.venues[venue]?.liveRouter;
    if (!router?.closeTokenAccount || this.store.venueMode(venue) !== "live") return;
    Promise.resolve()
      .then(() => router.closeTokenAccount(instrument))
      .then(r => {
        if (!r?.closed) return;
        // The rent went out at entry inside cost_usd, so the position's outcome already counts it as
        // lost. Getting it back is realized money and is credited to the day it lands in, or every
        // pump.fun trade is booked ~$0.40 worse than it was and the header drifts under the truth by
        // that much per trade, forever.
        const px = this.quotePriceOf(venue) || 0;
        const usd = +((Number(r.reclaimed_sol) || 0) * px).toFixed(4);
        if (usd > 0) { this.store.rollDay(); this.store.state.day.realizedUsd = +(this.store.state.day.realizedUsd + usd).toFixed(4); }
        this.ledger.append({ kind: "rent", venue, instrument, sol: r.reclaimed_sol, usd, accounts: r.closed, venue_ref: r.sig || null, note: "token account closed, rent reclaimed" });
        this.store.save();
        this.log("info", `rent back ${r.reclaimed_sol} SOL ($${usd.toFixed(2)}) from ${instrument.slice(0, 8)}`);
        this.refreshWallet().catch(() => {});
      })
      .catch(err => this.log("warn", `rent reclaim ${instrument.slice(0, 8)}: ${err.shortMessage || err.message}`));
  }

  /** Realized statistics, never mixed across modes. A paper fill is a model's opinion and a live fill
   *  is a receipt; pooling them let a run of simulated wins size a real bet. Each venue learns from
   *  outcomes booked in the mode it is in now, so paper still calibrates itself and live only ever
   *  hears from live. */
  modeStats() {
    // A ROLLING window, not all history. Without one the statistics are an absorbing state: a tier
    // that loses money over its first thirty trades makes the EV gate refuse it, refusing it stops
    // new outcomes arriving, and the stats that closed it can never be revised -- the tier is off
    // for the life of the account, whatever the market does afterwards. Ageing the window lets a
    // closed tier fall back to priors and probe again at a reduced size.
    const cutoff = this.clock() - this.cfg.statsWindowMs;
    const outs = this.ledger.query({ kind: "outcome", limit: 5000 })
      .filter(o => o && o.venue && !!o.paper === (this.store.venueMode(o.venue) === "paper"))
      .filter(o => !(o.ts > 0) || o.ts >= cutoff);
    return statsFromOutcomes(outs);
  }

  /** The last hundred closes, grouped by how they ended: where the money went. */
  /** The last few closes as a person would tell them: what, how much, how long. For the share card. */
  closes(limit = 8) {
    // ledger.query hands back the newest N records OLDEST first. Taking the head of that list showed
    // the eight oldest of the last sixteen -- stale re-entries of one ticker, three times over, and
    // never the close that just happened. The newest go first, and each carries its time.
    return this.ledger.query({ kind: "outcome", limit: limit * 2 })
      .filter(o => o.reason !== "LEG_UNWOUND")
      .slice(-limit).reverse()
      .map(o => { const p = this.store.state.positions?.[o.positionId]; return { ts: o.ts, venue: o.venue, instrument: o.instrument, name: p?.reference?.name || "", ticker: p?.reference?.ticker || "", pnl_usd: o.pnl_usd, pnl_pct: o.pnl_pct, held_ms: o.held_ms, reason: o.reason, paper: !!o.paper }; });
  }

  review(limit = 100) {
    const outs = this.ledger.query({ kind: "outcome", limit }).filter(o => !o.paper);
    if (!outs.length) return null;
    const by = {};
    for (const o of outs) { const k = String(o.reason || "?").replace(/_\d+$/, ""); const b = by[k] || (by[k] = { n: 0, pnl: 0, wins: 0, held_ms: 0 }); b.n++; b.pnl += Number(o.pnl_usd) || 0; if (o.pnl_usd > 0) b.wins++; b.held_ms += Number(o.held_ms) || 0; }
    const reasons = Object.entries(by).map(([reason, b]) => ({ reason, n: b.n, pnl_usd: +b.pnl.toFixed(2), win_rate: +(b.wins / b.n).toFixed(2), avg_hold_min: +(b.held_ms / b.n / 60000).toFixed(1) })).sort((a, c) => a.pnl_usd - c.pnl_usd);
    const fees = this.ledger.query({ kind: "exit", limit: limit * 3 }).filter(e => !e.failed && e.fee_usd > 0).reduce((s, e) => s + e.fee_usd, 0) + this.ledger.query({ kind: "fill", limit }).filter(f => f.side === "BUY" && !f.paper).reduce((s, f) => s + (Number(f.fee_usd) || 0), 0);
    const byVenue = {}; for (const o of outs) { const v = byVenue[o.venue] || (byVenue[o.venue] = { n: 0, pnl: 0, wins: 0 }); v.n++; v.pnl += Number(o.pnl_usd) || 0; if (o.pnl_usd > 0) v.wins++; }
    return { n: outs.length, pnl_usd: +outs.reduce((s, o) => s + (Number(o.pnl_usd) || 0), 0).toFixed(2), win_rate: +(outs.filter(o => o.pnl_usd > 0).length / outs.length).toFixed(2), fees_usd: +fees.toFixed(2), reasons, venues: Object.fromEntries(Object.entries(byVenue).map(([v, x]) => [v, { n: x.n, pnl_usd: +x.pnl.toFixed(2), win_rate: +(x.wins / x.n).toFixed(2) }])) };
  }

  /** The venue's quote asset in USD, freshest known: SOL for pump.fun, ETH for pons. One hint per
   *  venue; a single shared one would let the RH feed's ETH price value the SOL wallet. */
  quotePriceOf(venue) { return this.quotePrice[venue] || this.venues[venue]?.feed?.solPrice || 0; }
  get solPriceHint() { return this.quotePriceOf("pumpfun"); }
  set solPriceHint(v) { this.quotePrice.pumpfun = v; }

  /** Stop tracking a position the venue will not let us sell, without pretending it was a trade.
   *
   *  A curve that reverts every sell -- graduated, paused, a token with a transfer restriction --
   *  leaves a position that can never close, holding one of a handful of slots for as long as the
   *  bot runs, with a red error nobody can clear. The operator needs a way to say "I will deal with
   *  this by hand".
   *
   *  It books NO profit and loss. Nothing was realized: the money was spent and the tokens are still
   *  in the wallet. Writing a 100% loss here would be the FLAT_AT_VENUE mistake again, and writing a
   *  gain would be worse. The position leaves the book, the tokens reappear under "also in the
   *  wallets" where they can be sold by hand or by the sweep, and the ledger records why. */
  releasePosition(id, { by = "user", note = null } = {}) {
    const p = this.store.state.positions[id];
    if (!p) return { ok: false, error: "no such position" };
    if (p.status !== "open") return { ok: false, error: "position is not open" };
    if (this.exiting.has(id)) return { ok: false, error: "a sell for this position is in flight; try again in a moment" };
    const held = p.remaining_qty ?? p.qty;
    this.ledger.append({
      kind: "exit", venue: p.venue, positionId: p.id, decisionId: p.decisionId, instrument: p.instrument,
      pct: 100, reason: "RELEASED", detail: note || p.lastExitError?.reason || null,
      price: null, qty: held, proceeds_usd: 0, fee_usd: 0, final: true, released: true, by,
    });
    this.store.closePosition(p.id, { exitReason: "RELEASED", pnl_usd: null, remaining_qty: 0, released: true });
    // No outcome record: an abandoned position is not a result, and counting it as a loss would
    // teach the learner and the governor something that did not happen.
    this._knownForeign.delete(p.venue + ":" + p.instrument); // so it shows up as a wallet holding again
    this.venues[p.venue]?.feed?.unwatch(p.instrument);
    this.cooldown.set(p.instrument, this.clock() + this.cfg.reentryCooldownMs);
    this.emit("released", { position: p });
    this.log("warn", `RELEASED ${p.venue} ${p.instrument}: ${note || p.lastExitError?.reason || "by the operator"}; ${held} tokens stay in the wallet`);
    this.store.save();
    return { ok: true, instrument: p.instrument, venue: p.venue, qty: held };
  }

  /** Forget the last failed sell on a position. The failure stays in the ledger; this only clears
   *  the banner, and a further failure puts a fresh one back. */
  clearExitError(id) {
    const p = this.store.state.positions[id];
    if (!p) return { ok: false, error: "no such position" };
    const had = !!p.lastExitError;
    delete p.lastExitError;
    this.store.save();
    return { ok: true, cleared: had };
  }

  /** Record a wallet reading (from a router preflight) in USD at the freshest SOL price known. */
  noteWallet(venue, pre) {
    if (!pre || !(pre.balanceSol >= 0)) return;
    const solPrice = this.quotePriceOf(venue);
    this.wallet = { sol: pre.balanceSol, usd: solPrice > 0 ? +(pre.balanceSol * solPrice).toFixed(2) : null, solPrice: solPrice || null, at: this.clock(), venue, quote: pre.quote || "SOL" };
    this.wallets[venue] = this.wallet;
    this.store.state.wallet = this.wallet; this.store.state.wallets = this.wallets;
    // The first full reading after a start (every live wallet read since Start) is the baseline the
    // header P&L is measured from, kept in quote units so a move in SOL or ETH itself is not "P&L".
    //
    // It must cover at least one live venue. setVenueMode calls this while the venue is still paper,
    // so truePnl skipped every venue and returned wallet_usd 0 with an empty quote map -- a baseline
    // of nothing, against which the header P&L came out as the user's entire wallet balance.
    if (!this.store.state.baseline) {
      const b = this.truePnl();
      if (b.wallet_usd != null && b.all_since_start && Object.keys(b.quote).length > 0)
        this.store.state.baseline = { wallet_usd: b.wallet_usd, open_usd: b.open_usd, quote: b.quote, at: this.clock() };
    }
    // A venue that goes live later has produced no P&L yet, so its balance joins the baseline rather
    // than appearing as profit the moment it is funded.
    const base = this.store.state.baseline;
    if (base && this.store.venueMode(venue) === "live" && base.quote && base.quote[venue] == null) {
      base.quote[venue] = pre.balanceSol;
      base.wallet_usd = +(base.wallet_usd + (solPrice > 0 ? pre.balanceSol * solPrice : 0)).toFixed(2);
      // ...and anything this venue already holds joins the baseline too. Folding in the wallet
      // without the positions the wallet already paid for made every one of them read as pure profit:
      // truePnl adds today's open value and subtracts the baseline's, so an open position the baseline
      // has never seen is a gain the size of its whole mark. That is how a header showed +$9.41 over a
      // day whose own subtitle read "closed -$9.63 · open -$0.95".
      base.open_usd = +(base.open_usd + this.openValueUsd(venue)).toFixed(2);
    }
  }

  /** What the user actually has, against what they had when they pressed start: every live wallet in
   *  USD plus open positions at their current mark. Realized-today ignores open losers, gas and fees on
   *  failed sends, and yesterday; this does not. Null wallet_usd means a live wallet has no fresh
   *  reading or no price yet. */
  /** What the real open positions are worth right now, at their current marks. One definition, used
   *  both to value the book and to fold a venue into the baseline, so the two cannot drift apart. */
  openValueUsd(venue = null) {
    return this.store.openPositions(venue || undefined)
      .filter(p => !p.paper)
      .reduce((s, p) => s + (p.notional_usd || 0) * (1 + (p.changePct || 0) / 100), 0);
  }

  truePnl() {
    let walletUsd = 0, known = true, allSinceStart = true; const quote = {}, prices = {};
    for (const venue of Object.keys(this.venues)) {
      if (this.store.venueMode(venue) !== "live") continue;
      const w = this.wallets[venue] || (this.wallet.venue === venue ? this.wallet : null);
      const price = this.quotePriceOf(venue) || w?.solPrice || 0;
      if (!w || !(w.sol >= 0) || !(price > 0)) { known = false; break; }
      if (!(w.at >= (this.store.state.startedAt || 0))) allSinceStart = false;
      walletUsd += w.sol * price; quote[venue] = w.sol; prices[venue] = price;
    }
    // Paper: no venue is live, so there is no wallet to measure from and the loop above saw nothing.
    // The header used to fall through to the LIVE day counter, which paper never touches, and the
    // paper positions were filtered out of the open value -- so a paper run read $0.00 whatever it
    // did. Pretend money is still a number: realized since Start from the paper outcomes, plus what
    // the paper positions are worth now, labelled as paper so nobody mistakes it for the wallet.
    const paperOnly = !this.anyLiveVenue();
    // The big number is "since Start"; the words under it must count the same trades, or the two
    // contradict each other on screen (they did: -$1.22 over "0 trades, closed +$0.00"). Both modes
    // therefore report trades and closed P&L since Start from the ledger, the one source of truth,
    // beside the day counters the loss limit reads.
    const since = this.store.state.startedAt || 0;
    const sinceStart = (paper) => {
      const outs = this.ledger.query({ kind: "outcome", limit: 5000 }).filter(o => !!o.paper === paper && o.ts >= since && o.reason !== "LEG_UNWOUND");
      return { trades: outs.length, closed_usd: +outs.reduce((s, o) => s + (Number(o.pnl_usd) || 0), 0).toFixed(2) };
    };
    if (paperOnly) {
      const ss = sinceStart(true);
      const realizedSinceStart = ss.closed_usd;
      const paperOpen = this.store.openPositions().filter(p => p.paper);
      const unrealizedPaper = paperOpen.reduce((s, p) => s + (p.unrealized_usd || 0), 0);
      const openPaper = paperOpen.reduce((s, p) => s + (p.notional_usd || 0) * (1 + (p.changePct || 0) / 100), 0);
      const d = this.store.state.day;
      return { kind: "paper", wallet_usd: null, open_usd: +openPaper.toFixed(2), unrealized_usd: +unrealizedPaper.toFixed(2), realized_today_usd: +(d.paperRealizedUsd || 0).toFixed(2), trades_today: d.paperTrades || 0, since_start: ss, baseline: null, since_start_usd: +(realizedSinceStart + unrealizedPaper).toFixed(2), quote: {}, all_since_start: true };
    }
    const open = this.store.openPositions().filter(p => !p.paper);
    const openUsd = this.openValueUsd();
    const unrealized = open.reduce((s, p) => s + (p.unrealized_usd || 0), 0);
    const b = this.store.state.baseline || null;
    const out = { kind: "wallet", wallet_usd: known ? +walletUsd.toFixed(2) : null, open_usd: +openUsd.toFixed(2), unrealized_usd: +unrealized.toFixed(2), realized_today_usd: this.store.state.day.realizedUsd, trades_today: this.store.state.day.trades || 0, since_start: sinceStart(false), baseline: b, since_start_usd: null, quote, all_since_start: allSinceStart };
    if (b && known) {
      // Each wallet's change in its own quote asset, at today's price: SOL and ETH moving is not trading.
      // A live venue the baseline has never seen contributes nothing rather than everything: its
      // whole balance is new money in, not a gain. (noteWallet folds it into the baseline on the next
      // reading.) The old fallback subtracted the baseline's total from the wallet's total, which
      // reported a newly funded wallet as profit.
      let diff = 0;
      for (const [venue, now] of Object.entries(quote)) { const base = b.quote?.[venue]; if (base == null) continue; diff += (now - base) * prices[venue]; }
      out.since_start_usd = +(diff + openUsd - b.open_usd).toFixed(2);
    }
    return out;
  }

  /** Re-read the live wallet; called after every live fill and periodically by the sweep. */
  async refreshWallet() {
    for (const [venue, v] of Object.entries(this.venues)) {
      if (this.store.venueMode(venue) !== "live" || !v.liveRouter?.ready || !v.liveRouter.preflight) continue;
      try { this.noteWallet(venue, await v.liveRouter.preflight()); } catch (err) { this.log("warn", `${venue}: wallet read failed: ${err.message}`); }
      // What the wallet actually holds, beside what the store says is open. A holding the store does
      // not track is shown, and reconciled (adopted or reported) at most every two minutes.
      try {
        this.seedRouterKnowledge(venue);
        const list = (await v.liveRouter.positions()).map(p => ({ instrument: p.instrument, qty: p.qty }));
        this._holdings[venue] = { at: this.clock(), list };
        const open = new Set(this.store.openPositions(venue).map(p => p.instrument));
        // A holding already reconciled as "not the bot's" (no fill, no order for it) is not asked about again.
        const untracked = list.filter(h => !open.has(h.instrument) && h.qty >= 1 && !this._knownForeign.has(venue + ":" + h.instrument)); // dust left by a sell is not a holding
        if (untracked.length && this.clock() - this._lastHoldingsReconcile > 2 * 60_000) {
          this._lastHoldingsReconcile = this.clock();
          this.log("warn", `${venue}: wallet holds ${untracked.length} token(s) the store does not track (${untracked.map(u => u.instrument.slice(0, 8)).join(", ")}); reconciling`);
          await this.reconcile();
        }
      } catch (err) { this.log("warn", `${venue}: holdings read failed: ${err.message}`); }
    }
  }

  /** Clock-driven safety net, independent of ticks: settles buys that confirmed after their
   *  timeout, retries a flatten that failed, and sells a position past its max hold whose
   *  instrument has gone quiet (left the radar, zero mcap). */
  async sweep() {
    const now = this.clock();
    const due = key => { if (now - (this._lastSweepTry.get(key) || 0) < this.cfg.sweepRetryMs) return false; this._lastSweepTry.set(key, now); return true; };
    this.pruneMemos(now);
    if (this.walletMode() && now - (this.wallet.at || 0) >= this.cfg.walletRefreshMs) await this.refreshWallet();
    for (const [inst, pb] of [...this.pendingBuys]) {
      const router = this.routerFor(pb.venue);
      if (!router?.resolvePending || !due(`buy:${inst}`)) continue;
      let r;
      try { r = await router.resolvePending({ instrument: inst, side: "BUY", sig: pb.sig, at: pb.at, reference: pb.decision.reference, stakeUsd: pb.stake }); } catch (err) { r = { ok: false, failure: { code: "ROUTER_THREW", reason: err.message } }; }
      if (r.ok) { this.pendingBuys.delete(inst); this.ledger.append({ kind: "order", venue: pb.venue, orderId: pb.orderId, decisionId: pb.decision.id, stage: "sent", instrument: inst, side: "BUY", stake_usd: pb.stake, late: true, t_sent: pb.at }); this._openPosition(pb.decision, pb.orderId, pb.stake, pb.sizing, r); }
      else if (r.failure?.expired) {
        this.pendingBuys.delete(inst);
        this.ledger.append({ kind: "order", venue: pb.venue, orderId: pb.orderId, decisionId: pb.decision.id, stage: "failed", reason: r.failure.reason, code: r.failure.code, venue_ref: pb.sig, late: true });
        if (r.failure.fee_usd > 0) this.chargeFee(pb.venue, inst, r.failure.fee_usd, `failed late buy ${pb.sig}`);
      }
    }
    for (const p of this.store.openPositions()) {
      if (this.inflight.has(p.instrument) || !this.venues[p.venue]) continue;
      const halted = this.store.isHalted(p.venue);
      if (halted?.mode === "flatten") { if (due(p.id)) await this.closePosition(p, 100, "FLATTEN", { by: "retry" }); continue; }
      if (p.legs?.length) continue; // multi-leg sets hold to redemption
      const maxHold = p.plan?.max_hold_ms;
      const quiet = now - (p.lastTickAt || p.entryTime);
      // A moonbag outlives the plan's time limit; only a moonbag whose token has gone silent for six hours is swept.
      const holdLimit = p._bondli?.isMoonbag ? Math.max(maxHold || 0, 6 * 3_600_000) : maxHold;
      if (holdLimit && now - p.entryTime > holdLimit && quiet > (p._bondli?.isMoonbag ? 6 * 3_600_000 : this.cfg.tickSilenceMs) && due(p.id)) {
        await this.closePosition(p, 100, "MAX_HOLD", { by: "timer", detail: `${Math.round((now - p.entryTime) / 60000)}min, no tick for ${Math.round(quiet / 1000)}s` });
        continue;
      }
      // The stall exit lives in the tick evaluator, so a token that stops ticking never reaches it:
      // "no movement" means no ticks means no evaluation, and the position sits to max hold holding a
      // slot. Silence is the strongest form of the same evidence the stall looks for -- nobody is
      // trading it at all -- so the timer enforces it here. A position whose peak armed the trail is
      // left alone: that one is the trail's to manage, and a quiet feed is not a reason to give it up.
      const stall = p.plan?.stall_ms;
      const peakPct = p.entryMark > 0 ? (((p.peak || p.entryMark) - p.entryMark) / p.entryMark) * 100 : 0;
      const armed = peakPct >= (p.plan?.stall_band_pct ?? 8) * 1.5;
      // Dead on arrival, the strongest form: not one tick since the fill. The tick evaluator's DOA
      // test needs a tick to run on, and a launch nobody is trading produces none -- so the position
      // that most deserves cutting is the one that check can never see. Silence for the whole window
      // IS the absence of participation it looks for.
      const doa = p.plan?.doa_ms;
      const age = now - p.entryTime;
      if (doa && !p._bondli?.isMoonbag && !(p._bondli?.tpHit > 0) && !armed && age >= doa && quiet >= doa && due(p.id)) {
        await this.closePosition(p, 100, "DOA", { by: "timer", detail: `${Math.round(age / 1000)}s, no trade since the fill` });
        continue;
      }
      if (stall && !p._bondli?.isMoonbag && !(p._bondli?.tpHit > 0) && !armed && now - p.entryTime > stall && quiet > this.cfg.tickSilenceMs && due(p.id))
        await this.closePosition(p, 100, "STALL", { by: "timer", detail: `${Math.round((now - p.entryTime) / 60000)}min, no tick for ${Math.round(quiet / 1000)}s, peak +${peakPct.toFixed(0)}%` });
    }
  }

  async stop() {
    this.running = false;
    this.stopping = true; // queued exits still run; queued candidates do not open new risk
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    for (const v of Object.values(this.venues)) { try { await v.feed?.stop(); } catch {} }
    await this._queue;
    this.store.save();
    this.emit("stopped");
  }

  enqueue(fn) {
    this._queue = this._queue.then(fn).catch(err => { this.log("error", `engine: ${err.stack || err.message}`); });
    return this._queue;
  }

  log(level, text) { this.emit("log", { level, text, ts: this.clock() }); }

  // ── halt / resume / venue mode (E2, E4) ──
  async halt(mode, reason, { by = "operator", venue = null } = {}) {
    this.store.setHalt(mode, reason, venue);
    this.ledger.append({ kind: "halt", mode, reason, by, venue });
    this.log("warn", `HALT ${mode}${venue ? ` ${venue}` : ""}: ${reason} (${by})`);
    const result = { mode, reason, closed: [], failed: [] };
    if (mode === "flatten") {
      for (const p of this.store.openPositions(venue)) {
        const r = await this.closePosition(p, 100, "FLATTEN", { by });
        (r.ok ? result.closed : result.failed).push({ id: p.id, instrument: p.instrument, detail: r.ok ? r.fill.notional_usd : r.failure.reason });
      }
      if (result.failed.length) this.alerter?.send("error", `flatten left ${result.failed.length} position(s) open: ${result.failed.map(f => f.instrument).join(", ")}; retrying on next tick`);
    }
    this.store.save();
    return result;
  }

  resume(venue, { by = "operator" } = {}) {
    if (!venue) throw new Error("resume needs a venue name typed by the operator");
    if (this.store.state.halt.mode) this.store.setHalt(null, null);
    this.store.setHalt(null, null, venue);
    this.ledger.append({ kind: "resume", venue, by });
    this.evaluateGovernor();
    this.store.save();
    return this.store.state.halt;
  }

  async setVenueMode(venue, mode, { override = false, by = "operator" } = {}) {
    if (!this.venues[venue]) throw new Error(`unknown venue ${venue}`);
    const current = this.store.venueMode(venue);
    const refuse = (error, extra = {}) => ({ ok: false, mode: current, error, ...extra });
    let preflight = null;
    let liveStartCapUsd = null;
    if (mode !== "live" && current === "live") {
      // Real tokens must not be handed to the paper router: flatten them first.
      const liveOpen = this.store.openPositions(venue).filter(p => !p.paper);
      const pending = [...this.pendingBuys.values()].filter(pb => pb.venue === venue);
      if (liveOpen.length || pending.length) return refuse(`${liveOpen.length} live position(s) and ${pending.length} unconfirmed buy(s) still open (${[...liveOpen.map(p => p.instrument), ...pending.map(pb => pb.decision.instrument)].join(", ")}); run: velocity halt flatten, wait for the sweep, then retry, then: velocity resume ${venue}`);
    }
    if (mode === "live") {
      const gate = this.promotion(venue);
      if (!gate.ok && !override) return { ok: false, gate, mode: current };
      const router = this.venues[venue].liveRouter;
      if (!router) return refuse("no live router configured for this venue");
      try { preflight = await router.init(); }
      catch (err) { return refuse(`live router not ready: ${err.message}`); }
      const h = await router.health();
      if (!h.ok) return refuse(`live venue unreachable: ${h.detail}`);
      // Can this wallet cover one order plus fees, in the asset this venue actually trades?
      //
      // Every term here used to be Solana's. The fee reserve was the literal 0.006, which is about a
      // dollar of SOL and about twenty of ETH; the price fallback was 100, which is SOL's order of
      // magnitude and a thirty-fifth of ETH's. On Robinhood Chain the two together demanded 0.0886
      // ETH -- roughly $31 of gas reserve for a $10 trade on a chain where gas costs three cents --
      // and a wallet holding $30 of ETH was told it was too small and left in paper.
      const unit = preflight?.quote || (venue === "pumpfun" ? "SOL" : "ETH");
      const quotePrice = this.quotePriceFor(venue);
      if (!(quotePrice > 0)) return refuse(`no ${unit} price yet, so there is no way to tell whether the wallet covers one order; try again in a moment`, { preflight });
      const minQuote = this.env.venues[venue].min_stake_usd / quotePrice + (router.priorityFeeSol || 0) + this.quoteReserve(venue);
      if (preflight && preflight.balanceSol != null && preflight.balanceSol < minQuote)
        return refuse(`wallet ${preflight.wallet} holds ${preflight.balanceSol.toFixed(5)} ${unit}, below one minimum stake plus fees (${minQuote.toFixed(5)} ${unit})`, { preflight });
      // Paper positions cannot be sold through the live router: close them while the paper router still serves the venue.
      for (const p of this.store.openPositions(venue).filter(p => p.paper)) {
        const r = await this.closePosition(p, 100, "VENUE_MODE_CHANGE", { by });
        if (!r.ok) return refuse(`paper position ${p.instrument} could not be closed (${r.failure.reason}); run: velocity halt flatten, then retry`, { preflight });
      }
      liveStartCapUsd = gate.liveStartCapUsd;
      this.venues[venue].liveStartCapUsd = liveStartCapUsd;
      this.noteWallet(venue, preflight);
      // A hosted user's Start is always an override of the paper gate: log it, do not alert them about it.
      if (!gate.ok && by !== "user") this.alerter?.send("warn", `${venue} switched to LIVE by operator override with the paper gate red: ${gate.items.filter(i => !i.ok).map(i => i.name).join(", ")}`);
      else if (!gate.ok) this.log("info", `${venue}: live by the user's start; the paper gate would still say ${gate.items.filter(i => !i.ok).map(i => i.name).join(", ")}`);
    }
    this.store.setVenueMode(venue, mode, mode === "live" ? { liveStartCapUsd } : {});
    // Now that the venue is live, the wallet reading taken above can become a real baseline.
    if (mode === "live" && preflight) this.noteWallet(venue, preflight);
    this.ledger.append({ kind: "venue", venue, mode, by, override: !!override, gateOk: mode === "live" ? this.promotion(venue).ok : null, preflight, liveStartCapUsd });
    this.store.save();
    return { ok: true, mode, liveStartCapUsd: liveStartCapUsd || null, override: !!override, preflight };
  }

  routerFor(venue) {
    const v = this.venues[venue];
    return this.store.venueMode(venue) === "live" ? v.liveRouter : v.router;
  }

  // ── events ──
  async onEvent(event) {
    const venue = event.venue;
    const v = this.venues[venue];
    if (!v || this.store.venueMode(venue) === "off") return;
    if (event.kind === "feed_health") { this.store.state.feeds[venue] = { ...(this.store.state.feeds[venue] || {}), healthy: event.payload.healthy, detail: event.payload.detail, at: event.t_observed }; return; }
    this.store.state.feeds[venue] = { ...(this.store.state.feeds[venue] || {}), lastEventAt: event.t_observed };

    // Exits first: a held instrument's tick is worth more than a new candidate.
    await this.checkExits(event);
    if (this.stopping) return; // queued behind a slow order at shutdown: exits ran, no new entries

    if (event.payload?.solPrice > 0) this.quotePrice[venue] = event.payload.solPrice; // the venue's quote asset in USD: SOL here, ETH on pons
    if (!v.runner) return;
    const gov = this.governorContext(venue);
    const t0 = performance.now();
    if (event.kind === "candidate") {
      // A refused token keeps arriving. That is the only free measurement of what the rules cost, so
      // read it before deciding whether to re-judge.
      this.watchRejected(event);
      if ((this.disqualified.get(event.id)?.until || 0) > event.t_observed) return;
    }
    // Nothing can be entered twice, so judging a candidate we already hold, have in flight, or are
    // cooling down on is work that can only end in ALREADY_IN_OR_INFLIGHT or REENTRY_COOLDOWN. It is
    // not free: the whole gate pipeline runs on this one serialised queue, ahead of every other
    // position's stop loss, and each throwaway GO is written to the ledger and counted in the
    // funnel the operator reads. A held mint tickles this every couple of seconds.
    if (event.kind === "candidate" && this.cannotEnter(venue, event.id, event.t_observed)) return this.noteBlockedEntry(venue, event);
    // A halted governor refuses every candidate for the same reason. Running the pipeline anyway
    // spends the serialised queue on a foregone conclusion and writes one identical HALT reject per
    // token to the ledger the operator reads — a few hundred lines an hour that bury the exits and
    // the one line that matters. Say it once per haltNoticeMs and stop. Exits already ran above.
    if (event.kind === "candidate" && gov.halt) return this.noteHalted(venue, gov, event.t_observed);
    const decisions = v.runner.run(event, { governor: gov, stats: this.stats, minStakeUsd: this.env.venues[venue]?.min_stake_usd ?? null, weights: { pumpfun: this.weights.current().weights } });
    const decideMs = performance.now() - t0;
    for (const d of decisions) {
      // A rug flag that cannot change (dev self-sniped, serial rugger, frozen, stolen art) is final for
      // disqualifyMs. Every other gate-1 flag is a reading of the last minute of trades, and the first
      // minute is when they are noisiest: a token rejected for QUICK_FLIP at 40 seconds is re-judged
      // rejudgeMs later, when it has the trades to be judged on. A 5-minute blacklist here was the
      // difference between seeing a runner and missing it.
      if (d.action === "REJECT") this.noteRejected(d, event);
      this.latency[venue].decide.record(decideMs);
      d.decide_ms = +decideMs.toFixed(3);
      this.ledger.append({ kind: "decision", venue, id: d.id, decisionId: d.id, ...d });
      this.store.noteDecision(d);
      if (d.action === "GO") await this.enter(d, event);
    }
  }

  /** These maps take an entry per instrument the radar has ever shown us, and the radar is a
   *  firehose. Without this a long-running engine leaks a few hundred bytes per token, forever. */
  pruneMemos(now) {
    for (const [k, r] of this.disqualified) if (now > (r.expires || r.until || 0)) this.disqualified.delete(k);
    for (const [k, until] of this.cooldown) if (now > until) this.cooldown.delete(k);
    for (const [k, until] of this._entryBlockedLogged) if (now > until) this._entryBlockedLogged.delete(k);
    for (const [k, at] of this._lastSweepTry) if (now - at > 60 * 60_000) this._lastSweepTry.delete(k);
  }

  /** Remember a refusal: which rule, and where the token was when the rule fired.
   *
   *  Without this the ledger records that a rule said no and nothing else, so no amount of data can
   *  ever show that the rule was wrong. A rule that blocks every runner is indistinguishable from a
   *  rule that blocks every rug -- both look like a large REJECT count. */
  noteRejected(d, event) {
    const inst = d.instrument;
    // Only gate 1 stops a token being re-judged. The other gates are readings that change minute to
    // minute, and a governor veto is not a judgement about the token at all -- blocking on one would
    // keep refusing a token for thirty seconds after the halt that caused it had lifted.
    const fatal = d.gate === "disqualifiers" && (d.reasons || []).some(r => FATAL_FLAGS.has(String(r)));
    const blockMs = d.gate === "disqualifiers" ? (fatal ? this.cfg.disqualifyMs : this.cfg.rejudgeMs) : 0;
    const prev = this.disqualified.get(inst);
    const mcap = Number(event.payload?.mcapUsd) || Number(event.payload?.token?.mcapUsd) || 0;
    this.disqualified.set(inst, {
      until: Math.max(prev?.until || 0, blockMs ? event.t_observed + blockMs : 0),
      // The first refusal is the one that matters: it is the price of the rule. A later re-refusal
      // of a token that has already doubled must not reset the mark and hide the miss.
      at: prev?.at ?? event.t_observed,
      mcap: prev?.mcap || mcap,
      gate: prev?.gate ?? d.gate,
      reasons: prev?.reasons ?? (d.reasons || []).map(String),
      tier: prev?.tier ?? d.tier ?? 0,
      peak: Math.max(prev?.peak || 0, mcap),
      missed: prev?.missed || false,
      expires: event.t_observed + this.cfg.missWatchMs,
    });
  }

  /** A refused token that ran anyway. Recorded once, with the rule that refused it and the multiple
   *  it reached, so the cost of every rule is countable instead of invisible. */
  watchRejected(event) {
    const r = this.disqualified.get(event.id);
    if (!r || r.missed || !(r.mcap > 0)) return;
    if (event.t_observed > r.expires) return;
    const mcap = Number(event.payload?.mcapUsd) || Number(event.payload?.token?.mcapUsd) || 0;
    if (!(mcap > 0)) return;
    if (mcap > r.peak) r.peak = mcap;
    const mult = mcap / r.mcap;
    if (mult < this.cfg.missMultiple) return;
    r.missed = true;
    this.ledger.append({
      kind: "miss", venue: event.venue, instrument: event.id, gate: r.gate, reasons: r.reasons,
      tier: r.tier, mcap_at_reject: Math.round(r.mcap), mcap_now: Math.round(mcap),
      multiple: +mult.toFixed(2), held_ms: event.t_observed - r.at,
    });
    this.log("info", `MISS ${event.id} ${mult.toFixed(2)}x after ${r.gate}: ${r.reasons.join(", ")}`);
  }

  /** What every rule has refused, and what those refusals would have been worth. */
  misses({ limit = 500 } = {}) {
    const rows = this.ledger.query({ kind: "miss", limit });
    const by = new Map();
    for (const m of rows) {
      for (const reason of (m.reasons?.length ? m.reasons : [m.gate || "unknown"])) {
        const s = by.get(reason) || { reason, n: 0, best: 0, sumMult: 0 };
        s.n++; s.sumMult += m.multiple || 0; s.best = Math.max(s.best, m.multiple || 0);
        by.set(reason, s);
      }
    }
    return [...by.values()].map(s => ({ ...s, avgMult: +(s.sumMult / s.n).toFixed(2) })).sort((a, b) => b.n - a.n);
  }

  governorContext(venue) {
    const halted = this.store.isHalted(venue);
    const blocked = this.blocked[venue];
    return {
      halt: !!halted || !!blocked || this.verdict.halt,
      haltReason: halted?.reason || blocked || this.verdict.haltReason || null,
      throttle: this.verdict.throttle,
    };
  }

  portfolioSnapshot() {
    this.store.rollDay();
    // Only positions of the kind the caps are protecting. equity_usd is built from live wallets and
    // live positions, but `open` was every position, paper included -- so with pump.fun live and PONS
    // in paper (anyone who has funded SOL but not ETH) a simulated position held a real concurrency
    // slot and ate the real exposure cap. With nothing live the paper book stands in, so an all-paper
    // run still exercises the caps and the promote gate keeps its meaning.
    const anyLive = this.anyLiveVenue();
    const open = this.store.openPositions().filter(p => (anyLive ? !p.paper : true));
    // A buy that was sent but not confirmed may still land: until the sweep settles it, its whole
    // stake is open risk, or every candidate inside the confirmation window is sized against the
    // full daily budget.
    const pending = [...this.pendingBuys.values()].map(pb => ({ venue: pb.venue, group: pb.decision?.group || null, notional_usd: pb.stake, worst_case_fraction: 1, pending: true }));
    const snap = {
      open: [...open.map(p => ({ venue: p.venue, group: p.group, notional_usd: p.notional_usd, worst_case_fraction: p.worst_case_fraction ?? 1 })), ...pending],
      realized_today_usd: this.realizedToday(),
    };
    // Wallet mode: the bankroll is what the wallet holds. Free SOL (less the fee reserve) at the
    // current price, plus what is already open, is the equity the sizer works from. Paper venues
    // keep the fixed bankroll. No fresh reading means no order, not a guess.
    if (this.walletMode() && anyLive) {
      // Every live venue's wallet, each in its own quote asset, summed in USD. One unreadable wallet
      // means no order on any venue: a guess is not a bankroll.
      let freeUsd = 0, reason = null;
      const liveVenues = Object.keys(this.venues).filter(v => this.store.venueMode(v) === "live");
      for (const venue of liveVenues) {
        const w = this.wallets[venue] || (this.wallet.venue === venue ? this.wallet : null);
        const fresh = w && w.at && this.clock() - w.at <= this.cfg.walletMaxAgeMs;
        const price = this.quotePriceOf(venue) || w?.solPrice || 0;
        if (!fresh || !(w.sol >= 0)) { reason = "WALLET_UNKNOWN"; break; }
        if (!(price > 0)) { reason = "NO_SOL_PRICE"; break; }
        const reserve = this.quoteReserve(venue);
        freeUsd += Math.max(0, w.sol - reserve) * price;
      }
      if (reason) { snap.equity_usd = null; snap.equity_reason = reason; }
      else {
        const liveOpen = open.reduce((s, p) => s + (p.notional_usd || 0), 0); // `open` is already live-only here
        snap.equity_usd = +(freeUsd + liveOpen).toFixed(2);
        const w = this.wallet;
        snap.wallet = { sol: w.sol, solPrice: w.solPrice, free_usd: +freeUsd.toFixed(2), at: w.at, wallets: this.wallets };
      }
    }
    return snap;
  }

  // ── entry ──
  /** Record why a candidate was screened out before the gates, but at most once per rejudge window:
   *  the operator still sees that the bot wanted back in, without a line every two seconds. */
  noteBlockedEntry(venue, event) {
    const inst = event.id, at = event.t_observed;
    if ((this._entryBlockedLogged.get(inst) || 0) > at) return;
    this._entryBlockedLogged.set(inst, at + this.cfg.rejudgeMs);
    const held = this.inflight.has(inst) || this.pendingBuys.has(inst) || this.store.openPositions(venue).some(p => p.instrument === inst);
    this.ledger.append({ kind: "order", venue, orderId: `${venue}:${inst}:blocked`, instrument: inst, stage: "failed", reason: held ? "ALREADY_IN_OR_INFLIGHT" : "REENTRY_COOLDOWN", screened: true });
  }

  /** The governor is halted: one narration line per venue per haltNoticeMs, not one per token. */
  noteHalted(venue, gov, at) {
    const last = this._haltNoticed.get(venue) || 0;
    if (at - last < (this.cfg.haltNoticeMs ?? 5 * 60_000)) return;
    this._haltNoticed.set(venue, at);
    this.ledger.append({ kind: "order", venue, orderId: `${venue}:halt`, instrument: "-", stage: "failed", reason: `HALTED:${gov.haltReason || "halt"}`, screened: true });
  }

  /** True when this instrument could not be entered even with a perfect score. */
  cannotEnter(venue, instrument, at) {
    return this.inflight.has(instrument) || this.pendingBuys.has(instrument)
      || (this.cooldown.get(instrument) || 0) > at
      || this.store.openPositions(venue).some(p => p.instrument === instrument);
  }

  async enter(decision, event) {
    const venue = decision.venue;
    const v = this.venues[venue];
    const inst = decision.instrument;
    if (this.inflight.has(inst) || this.pendingBuys.has(inst) || this.store.openPositions(venue).some(p => p.instrument === inst))
      return this.ledger.append({ kind: "order", venue, orderId: `${decision.id}:o`, decisionId: decision.id, stage: "failed", reason: "ALREADY_IN_OR_INFLIGHT" });
    if ((this.cooldown.get(inst) || 0) > event.t_observed)
      return this.ledger.append({ kind: "order", venue, orderId: `${decision.id}:o`, decisionId: decision.id, stage: "failed", reason: "REENTRY_COOLDOWN" });
    // (onEvent screens candidates before the gates run; these two remain as the last word, because a
    // decision can also arrive from a tick-driven re-judge and the queue can change under it.)

    const sizing = this.sizer.size({ decision, portfolio: this.portfolioSnapshot(), throttle: this.verdict.throttle, halted: !!this.store.isHalted(venue) });
    const liveCap = this.store.venueMode(venue) === "live" ? (v.liveStartCapUsd ?? this.store.state.venues[venue]?.liveStartCapUsd ?? null) : null;
    let stake = sizing.stake_usd;
    if (liveCap && stake > liveCap) { stake = liveCap; sizing.caps.push("LIVE_START_CAP"); }
    const orderId = `${decision.id}:o`;
    this.ledger.append({ kind: "order", venue, orderId, decisionId: decision.id, stage: "sized", stake_usd: stake, sizing });
    if (!(stake > 0)) return;

    const order = this.buildOrder(decision, orderId, stake, venue);
    if (!order) return this.ledger.append({ kind: "order", venue, orderId, decisionId: decision.id, stage: "failed", reason: "NO_REFERENCE" });

    const router = this.routerFor(venue);
    if (!router) return this.ledger.append({ kind: "order", venue, orderId, decisionId: decision.id, stage: "failed", reason: "NO_ROUTER" });

    this.inflight.add(inst);
    const t_sent = this.clock();
    this.ledger.append({ kind: "order", venue, orderId, decisionId: decision.id, stage: "sent", t_sent, instrument: inst, side: "BUY", stake_usd: stake, legs: order.legs?.length || 0 });
    this.latency[venue].send.record(Math.max(0, t_sent - decision.t_decided));
    let r;
    try { r = await router.submit(order); } catch (err) { r = { ok: false, failure: { orderId, code: "ROUTER_THREW", reason: err.message } }; }
    this.inflight.delete(inst);
    if (!r.ok) {
      this.ledger.append({ kind: "order", venue, orderId, decisionId: decision.id, stage: r.unwound ? "unwound" : "failed", reason: r.failure.reason, code: r.failure.code, venue_ref: r.failure.venue_ref || null, unwound: r.unwound || null });
      if (r.unwound) this.ledger.append({ kind: "outcome", venue, instrument: inst, decisionId: decision.id, pnl_usd: -(r.unwound.reduce((s, u) => s + (u.failed ? 0 : Math.max(0, (u.stake_usd || 0) - (u.notional_usd || 0))), 0)), pnl_pct: 0, stake_usd: stake, p_win: decision.p_win, confidence: decision.confidence, model: decision.model, tier: decision.tier, held_ms: 0, reason: "LEG_UNWOUND", paper: !!(r.unwound[0]?.paper) });
      // A venue failure is not retried on the next poll: the candidate re-emits every few seconds
      // and each on-chain failure costs the priority fee.
      // REVERT is a dry run the pool refused; nothing about it changes on the next re-emit seconds later.
      if (["SEND_FAILED", "UNCONFIRMED", "INSUFFICIENT_SOL", "ROUTER_THREW", "STALE_SOL_PRICE", "REVERT"].includes(r.failure.code)) this.cooldown.set(inst, event.t_observed + this.cfg.failCooldownMs);
      if (r.failure.fee_usd > 0) this.chargeFee(venue, inst, r.failure.fee_usd, `failed send ${r.failure.venue_ref || ""}`);
      // Sent but not confirmed in time: the transaction may still land. The sweep settles it either way.
      if (r.failure.code === "UNCONFIRMED" && r.failure.venue_ref) this.pendingBuys.set(inst, { venue, sig: r.failure.venue_ref, decision, orderId, stake, sizing, at: t_sent });
      return;
    }
    this._openPosition(decision, orderId, stake, sizing, r);
  }

  /** A fee the venue charged for nothing (a send that failed on chain) is real money: the day sees it. */
  chargeFee(venue, instrument, usd, note) {
    this.store.rollDay();
    const paper = this.store.venueMode(venue) === "paper";
    if (paper) this.store.state.day.paperRealizedUsd = +(this.store.state.day.paperRealizedUsd - usd).toFixed(4);
    else this.store.state.day.realizedUsd = +(this.store.state.day.realizedUsd - usd).toFixed(4);
    this.ledger.append({ kind: "fee", venue, instrument, usd: +usd.toFixed(4), note, paper });
  }

  _openPosition(decision, orderId, stake, sizing, r) {
    const venue = decision.venue;
    const v = this.venues[venue];
    const inst = decision.instrument;
    const fill = r.fill;
    this.latency[venue].confirm.record(fill.latency_ms || 0);
    const key = CURVE_VENUES.has(venue) ? (decision.plan_key || decision.tier) : decision.model;
    const plan = createPlan({ venue, key, entry: { score: decision.features ? Math.round((decision.features.apeScore || 0) * 100) : 0, price: fill.price } });
    const position = {
      id: `${venue}:${inst}:${fill.t_filled}`, venue, instrument: inst, model: decision.model, tier: decision.tier, group: decision.group,
      decisionId: decision.id, orderId, entryTime: fill.t_filled, entryPrice: fill.price, qty: fill.qty, notional_usd: fill.notional_usd, stake_usd: stake,
      // notional_usd is what left the wallet, fees included, for paper and live alike; fee_usd is informational.
      cost_usd: fill.notional_usd, proceeds_usd: 0, remaining_qty: fill.qty,
      entryMark: curveEntryMark(venue, fill, decision), mark: null, peak: null, changePct: 0,
      entryScore: decision.features ? Math.round((decision.features.apeScore || 0) * 100) : 0,
      worst_case_fraction: sizing.stop_fraction ?? decision.stop_fraction ?? 1, plan, status: "open",
      p_win: decision.p_win, confidence: decision.confidence, features: decision.features || null,
      sizing: sizing ? { caps: sizing.caps || [], kelly: sizing.kelly || null, throttle: sizing.kelly?.throttle ?? null, reason: (sizing.reasons || [])[0] || null } : null,
      reference: decision.reference || null, legs: r.fills ? r.fills.map(f => ({ instrument: f.instrument, qty: f.qty, price: f.price })) : null, paper: !!fill.paper,
      // Measured SOL, for anything that must not depend on a price feed (the platform fee).
      sol_spent: fill.sol_spent ?? null, sol_received: 0,
      // The buy's own transaction. A public callout is only worth anything with this on it.
      venue_ref: fill.venue_ref || null,
    };
    this.ledger.append({ kind: "fill", venue, orderId, decisionId: decision.id, positionId: position.id, side: "BUY", instrument: inst, price: fill.price, qty: fill.qty, notional_usd: fill.notional_usd, fee_usd: fill.fee_usd || 0, slippage_bps: fill.slippage_bps, latency_ms: fill.latency_ms, venue_ref: fill.venue_ref, sol_spent: fill.sol_spent ?? null, exact: fill.exact ?? null, plan: { venue: plan.venue, key: plan.key, mode: plan.mode }, paper: !!fill.paper });
    this.ledger.append({ kind: "order", venue, orderId, decisionId: decision.id, stage: "filled", positionId: position.id });
    this.store.upsertPosition(position);
    if (!fill.paper && this.walletMode()) this.refreshWallet().catch(() => {});
    v.feed?.watch(inst);
    for (const l of position.legs || []) v.feed?.watch(l.instrument);
    this.store.save();
    this.emit("position", position);
    this.log("info", `ENTER ${venue} ${inst} $${fill.notional_usd.toFixed(2)} tier ${decision.tier} (${decision.model}) plan ${plan.key}`);
  }

  buildOrder(decision, orderId, stake, venue) {
    const v = this.venues[venue];
    const maxSlip = this.env.venues[venue].max_slippage_bps;
    if (CURVE_VENUES.has(venue)) {
      if (!decision.reference?.solPrice) return null;
      return { id: orderId, decisionId: decision.id, venue, instrument: decision.instrument, side: "BUY", stake_usd: stake, max_slippage_bps: maxSlip, reference: decision.reference };
    }
    if (venue === "polymarket") {
      const st = v.edge?.state;
      if (decision.legs?.length) {
        const per = stake / decision.legs.length;
        const legs = decision.legs.map(l => {
          const m = st?.markets.get(l.conditionId);
          return { instrument: l.instrument, side: "BUY", stake_usd: per, reference: { book: st?.books.get(l.instrument) || null, feeRateBps: m?.feeRateBps || 0, conditionId: l.conditionId } };
        });
        if (legs.some(l => !l.reference.book)) return null;
        return { id: orderId, decisionId: decision.id, venue, instrument: decision.instrument, side: "BUY", stake_usd: stake, max_slippage_bps: maxSlip, legs };
      }
      const book = st?.books.get(decision.instrument) || decision.reference?.book;
      if (!book) return null;
      return { id: orderId, decisionId: decision.id, venue, instrument: decision.instrument, side: "BUY", stake_usd: stake, max_slippage_bps: maxSlip, reference: { book, feeRateBps: decision.reference?.feeRateBps || 0, conditionId: decision.reference?.conditionId || null } };
    }
    return null;
  }

  // ── exits ──
  async checkExits(event) {
    const venue = event.venue;
    for (const p of this.store.openPositions(venue)) {
      const mine = p.instrument === event.id || (p.legs || []).some(l => l.instrument === event.id);
      if (!mine) continue;
      if (event.kind !== "tick" && event.kind !== "book" && event.kind !== "fact" && event.kind !== "market") continue;
      const tick = event.kind === "tick" ? event
        : event.kind === "book" ? { ...event, payload: { price: event.payload.bestBid, bestBid: event.payload.bestBid, book: event.payload } }
        : event.kind === "fact" ? { ...event, payload: { resolved: true, outcome: event.payload.outcome } }
        : { ...event, payload: { resolved: !!event.payload.closed, outcome: null } };
      if (event.kind === "market" && !event.payload.closed) continue;
      if (p.legs && event.kind !== "fact" && event.kind !== "market") continue; // multi-leg sets hold to redemption
      markPosition(p, tick);
      if (tick.payload?.vSolInBondingCurve > 0) p.lastVSol = tick.payload.vSolInBondingCurve;
      let action = null;
      try { action = evaluateExit(p, tick, { now: event.t_observed }); }
      catch (err) { this.log("error", `exit eval ${p.id}: ${err.message}`); continue; }
      if (!action) continue;
      await this.closePosition(p, action.pct, action.reason, { action: action.action, layer: action.layer, detail: action.detail, tick, stamp: action.stamp || null });
    }
  }

  async closePosition(p, pct, reason, opts = {}) {
    if (p.status !== "open") return { ok: false, failure: { code: "ALREADY_CLOSED", reason: "position is not open" } };
    // A position's status only changes once its sell has come back, so two callers that reach here
    // while the first sell is in flight both see it open and both send one. The engine queue is not
    // enough on its own: hub.stop and hub.halt call halt("flatten") straight through, off the queue,
    // while a tick-driven stop loss is running on it. Two real sells for one position: the second
    // finds an empty wallet, and two sweep intervals later the position is booked as a total loss.
    if (this.exiting.has(p.id)) return { ok: false, failure: { code: "EXIT_IN_FLIGHT", reason: `a sell for ${p.instrument} is already in flight` } };
    this.exiting.add(p.id);
    try { return await this._closePosition(p, pct, reason, opts); }
    finally { this.exiting.delete(p.id); }
  }

  async _closePosition(p, pct, reason, { action = "SELL", layer = null, detail = null, tick = null, by = "plan", stamp = null } = {}) {
    const venue = p.venue;
    const router = this.routerFor(venue);
    if (!router) return { ok: false, failure: { reason: "NO_ROUTER" } };
    // Proceeds are measured in SOL; the freshest known SOL price converts them.
    const freshSol = tick?.payload?.solPrice || this.quotePriceOf(venue) || p.reference?.solPrice || 0;
    // With no tick, a paper sell is priced at the last mark, not the entry curve: a token goes quiet
    // when it dies. (A live sell measures real proceeds; the reference only sizes the model check.)
    const lastMark = CURVE_VENUES.has(venue) && p.mark > 0 ? { mcapUsd: p.mark, mcapSol: undefined, vTokensInBondingCurve: undefined, vSolInBondingCurve: p.lastVSol || p.reference?.vSolInBondingCurve } : {};
    const reference = tick?.payload?.book ? { book: tick.payload.book } : tick?.payload ? { ...p.reference, ...tick.payload, solPrice: freshSol } : { ...(p.reference || {}), ...lastMark, solPrice: freshSol };
    let r;
    if (action === "REDEEM") {
      // Paper redemption: the winning side pays 1.00 per share.
      r = await router.close(p, 100, { reference: { book: { bids: [{ price: 1, size: p.remaining_qty || p.qty }] } } });
    } else if (p.legs?.length) {
      r = { ok: true, fill: { price: null, qty: p.legs.length, notional_usd: p.legs.reduce((s, l) => s + l.qty, 0), fee_usd: 0, t_sent: this.clock(), t_filled: this.clock(), latency_ms: 0, paper: true } };
      for (const l of p.legs) await router.close({ ...p, instrument: l.instrument, id: `${p.id}:${l.instrument}` }, 100, { reference: { book: { bids: [{ price: 1, size: l.qty }] } } });
    } else {
      r = await router.close(p, pct, { reference });
    }
    if (!r.ok) {
      const code = r.failure.code;
      // Sent but not confirmed in time: remember the signature so the next attempt settles it
      // instead of selling twice. A repeat of the same signature keeps its original send time,
      // or the blockhash lifetime would never run out and a dropped sell could never be resent.
      if (code === "UNCONFIRMED" && r.failure.venue_ref && p.pendingExit?.sig !== r.failure.venue_ref) p.pendingExit = { sig: r.failure.venue_ref, pct, reason, at: r.failure.t_sent || this.clock() };
      if (r.failure.fee_usd > 0) this.chargeFee(venue, p.instrument, r.failure.fee_usd, `failed sell ${r.failure.venue_ref || ""}`);
      if (code === "NO_POSITION" && !p.paper && this.store.venueMode(venue) === "live") {
        // One empty wallet read is not proof; two, a retry interval apart, are.
        if (p.flatSeenAt && this.clock() - p.flatSeenAt >= this.cfg.sweepRetryMs) {
          // The tokens are gone, but "gone" is not the same as "lost": a manual sell, or one of ours
          // whose signature we dropped, put real SOL in the wallet. Read the chain before booking a
          // 100% loss, or one recovered trade is written off at its full cost.
          const sale = router.findRecentSale ? await router.findRecentSale(p.instrument, { since: p.entryTime }).catch(() => null) : null;
          if (sale) {
            const px = freshSol || this.quotePriceOf(venue) || 0;
            const fill = { venue, instrument: p.instrument, side: "SELL", price: sale.qty > 0 ? (sale.solReceived * px) / sale.qty : 0, qty: sale.qty, notional_usd: +(sale.solReceived * px).toFixed(4), fee_usd: 0, t_sent: sale.at, t_filled: sale.at, latency_ms: 0, venue_ref: sale.sig, sol_received: sale.solReceived, paper: false, recovered: true };
            delete p.flatSeenAt; delete p.pendingExit; delete p.lastExitError;
            this.log("info", `RECOVERED SALE ${p.instrument} ${sale.sig} ${sale.solReceived.toFixed(6)} SOL`);
            return this._bookExit(p, { ok: true, fill }, 100, `${reason}:RECOVERED`, { action: "SELL", layer: null, detail: sale.sig, by });
          }
          return this.finalizeFlat(p, reason, r, by);
        }
        if (!p.flatSeenAt) p.flatSeenAt = this.clock();
      } else if (p.flatSeenAt) delete p.flatSeenAt;
      this.ledger.append({ kind: "exit", venue, positionId: p.id, instrument: p.instrument, pct, reason, failed: true, error: r.failure.reason, code, venue_ref: r.failure.venue_ref || null });
      // Count repeats of the SAME failure. A different code means the situation changed and the
      // tally starts again; the same code over and over is the venue saying the same no.
      const sameAsBefore = p.lastExitError?.code === code;
      p.lastExitError = { code, reason: String(r.failure.reason || "").slice(0, 200), tried: reason, at: this.clock(), count: sameAsBefore ? (p.lastExitError.count || 0) + 1 : 1 };
      // A terminal refusal is not a failure to retry: the venue is telling us this position can never
      // be sold by the bot, and no amount of waiting changes that. A graduated PONS curve moved to a
      // Uniswap V4 pool the router does not speak; retrying forever holds a concurrency slot for the
      // life of the process, and with two slots that is half the bot's throughput lost to one token.
      // Release it: the slot comes back, no P&L is invented, and the tokens show up under the wallet
      // holdings where they can be sold by hand.
      // ...and a refusal that is not terminal in principle becomes terminal in practice once the
      // venue has given the same answer this many times running. REVERT is the case that matters: a
      // curve that refuses every sell is indistinguishable, from here, from one that cannot be sold,
      // and the difference stops mattering after the fifth identical no. Retrying forever holds a
      // concurrency slot AND raises a fresh error banner every few seconds, so the operator dismisses
      // one and the next arrives -- the error cannot be cleared while its cause is still being made.
      const stuck = p.lastExitError.count >= this.cfg.releaseAfterFailures;
      if (TERMINAL_EXIT_CODES.has(code) || stuck) {
        this.log("warn", `TERMINAL ${code} on ${p.instrument}${stuck ? ` after ${p.lastExitError.count} identical failures` : ""}: releasing so the slot is not held forever`);
        this.exiting.delete(p.id); // releasePosition refuses while a sell is in flight, and this one is over
        this.releasePosition(p.id, { by: "engine", note: `${code}: ${String(r.failure.reason || "").slice(0, 160)}` });
        return r;
      }
      this.log("warn", `EXIT FAILED ${p.instrument} ${reason}: ${r.failure.reason}`);
      this.store.save();
      return r;
    }
    if (p.pendingExit) { pct = r.fill.pending_pct ?? pct; delete p.pendingExit; }
    if (p.flatSeenAt) delete p.flatSeenAt;
    if (p.lastExitError) delete p.lastExitError;
    return this._bookExit(p, r, pct, reason, { action, layer, detail, by, stamp });
  }

  /** The venue holds none of this instrument and no pending sell explains it: the tokens left the
   *  wallet outside the engine. Book the whole cost as lost so the daily limit sees real money. */
  finalizeFlat(p, reason, r, by) {
    const why = `${reason}:FLAT_AT_VENUE`;
    const fill = { price: 0, qty: p.remaining_qty ?? p.qty, notional_usd: 0, fee_usd: 0, t_filled: this.clock(), latency_ms: 0, venue_ref: null, paper: false, flat_at_venue: true };
    this.alerter?.send("error", `${p.venue} ${p.instrument}: wallet holds none of it and no pending sell explains that (${r.failure.reason}); booked as a loss of $${Math.max(0, (p.cost_usd || 0) - (p.proceeds_usd || 0)).toFixed(2)}`);
    return this._bookExit(p, { ok: true, fill, flat: true }, 100, why, { action: "SELL", layer: null, detail: r.failure.reason, by, flat: true });
  }

  _bookExit(p, r, pct, reason, { action = "SELL", layer = null, detail = null, by = "plan", flat = false, stamp = null } = {}) {
    const venue = p.venue;
    const f = r.fill;
    applyExitStamp(p, stamp); // the sell landed, so the marks a reduced position earns are now true
    const proceeds = f.notional_usd;
    p.proceeds_usd = (p.proceeds_usd || 0) + proceeds;
    if (f.sol_received > 0) p.sol_received = (p.sol_received || 0) + f.sol_received;
    const before = p.remaining_qty ?? p.qty;
    p.remaining_qty = Math.max(0, before - (f.qty || 0));
    // What is still on the table shrinks with what was sold. notional_usd is what the risk envelope,
    // the daily taper and the header's open value all read; leaving it at the entry size after a
    // partial sell counted the sold part as still at risk AND as cash in the wallet -- twice.
    if (before > 0 && p.remaining_qty < before) p.notional_usd = +((p.notional_usd || 0) * (p.remaining_qty / before)).toFixed(4);
    // What actually filled, not what was asked for. A router that sells a position in chunks can stop
    // part-way and still succeed; closing on the requested percentage abandoned the rest.
    const filledPct = Number.isFinite(f.pct_filled) ? f.pct_filled : pct;
    const done = !!(filledPct >= 100 || p.remaining_qty <= 1e-9 || action === "REDEEM" || (p.legs && p.legs.length));
    this.ledger.append({ kind: "exit", venue, positionId: p.id, decisionId: p.decisionId, instrument: p.instrument, pct, reason, layer, detail, price: f.price, qty: f.qty, proceeds_usd: proceeds, fee_usd: f.fee_usd || 0, latency_ms: f.latency_ms, venue_ref: f.venue_ref, sol_received: f.sol_received ?? null, exact: f.exact ?? null, final: done, by });
    if (done) {
      const pnl = +(p.proceeds_usd - p.cost_usd).toFixed(4);
      const held = (f.t_filled || this.clock()) - p.entryTime;
      this.reclaimRent(venue, p.instrument); // the emptied token account's rent is ours again
      this.store.closePosition(p.id, { exitReason: reason, pnl_usd: pnl, remaining_qty: 0 });
      this.store.rollDay();
      // Simulated money must not spend the real daily loss budget, nor raise it. The reconcile path
      // has always guarded this; the main exit path did not, so a paper venue running beside a live
      // one could halt live trading with imaginary losses -- or, worse, size real trades up on
      // imaginary gains.
      if (f.paper) { this.store.state.day.paperRealizedUsd = +(this.store.state.day.paperRealizedUsd + pnl).toFixed(4); this.store.state.day.paperTrades++; }
      else { this.store.state.day.realizedUsd = +(this.store.state.day.realizedUsd + pnl).toFixed(4); this.store.state.day.trades++; }
      this.ledger.append({ kind: "outcome", venue, instrument: p.instrument, positionId: p.id, decisionId: p.decisionId, pnl_usd: pnl, pnl_pct: p.cost_usd > 0 ? +((pnl / p.cost_usd) * 100).toFixed(2) : 0, stake_usd: p.stake_usd, p_win: p.p_win, confidence: p.confidence, model: p.model, tier: p.tier, held_ms: held, reason, features: p.features, paper: !!f.paper, by, flat_at_venue: flat || undefined });
      // How long before this mint may be bought again depends on WHY we left. A stop loss, a crash or
      // a rug is a judgement that the token is bad, and five minutes is right. DOA and STALL are not:
      // they say nothing was happening YET. Holding those out for five minutes turns a cheap step
      // aside into a permanent forfeit of the token, and the whole case for cutting fast is that
      // stepping aside is cheap and reversible -- 3.5% to keep the right to come back when the crowd
      // arrives. The miss ledger records what these cost, so the number is checkable.
      const notYet = /^(DOA|STALL)/.test(reason);
      this.cooldown.set(p.instrument, this.clock() + (notYet ? this.cfg.retryCooldownMs : this.cfg.reentryCooldownMs));
      this.venues[venue].feed?.unwatch(p.instrument);
      for (const l of p.legs || []) this.venues[venue].feed?.unwatch(l.instrument);
      this.stats = this.modeStats();
      this.log("info", `EXIT ${venue} ${p.instrument} ${reason} pnl $${pnl.toFixed(2)} held ${Math.round(held / 1000)}s`);
      this.emit("outcome", { position: p, pnl });
      this.evaluateGovernor();
      if (++this._outcomesSinceRetrain >= this.cfg.retrainEvery) { this._outcomesSinceRetrain = 0; this.retrain(); }
    }
    if (!f.paper && this.walletMode()) this.refreshWallet().catch(() => {});
    this.store.save();
    return r;
  }

  // ── governor (DP7) ──
  /** True when real money is at stake at any venue. */
  anyLiveVenue() { return Object.keys(this.venues).some(v => this.store.venueMode(v) === "live"); }

  /** The day's realized P&L that the loss limit and the governor act on: the live number whenever a
   *  live venue exists, and otherwise the paper number, so an all-paper run still exercises the limit
   *  and the promote gate means something. */
  realizedToday() {
    const d = this.store.state.day;
    return this.anyLiveVenue() ? d.realizedUsd : (d.paperRealizedUsd || 0);
  }

  /** The operator forgives today's loss: it stops counting against the daily taper and the circuit
   *  breaker, so stakes go back to full size and the breaker is a fresh day's worth away. Nothing
   *  else about the accounting moves — the P&L the operator reads is still the truth — and it resets
   *  on the day roll like the rest of the day. */
  acknowledgeDailyLimit() {
    const d = this.store.state.day;
    const loss = Math.max(0, -this.realizedToday());
    const forgiven = Math.max(0, loss - (d.lossAckUsd || 0));
    d.lossAckUsd = loss;
    this._haltNoticed.clear();
    this.store.save();
    this.evaluateGovernor();
    this.ledger.append({ kind: "resume", venue: "-", by: `daily loss forgiven: $${forgiven.toFixed(2)}; stakes back to full size, the taper starts again from zero`, cleared: "daily_limit" });
    return { ok: true, forgiven: +forgiven.toFixed(2), halted: !!this.verdict.halt, haltReason: this.verdict.halt ? this.verdict.haltReason : null };
  }

  evaluateGovernor() {
    const snap = this.portfolioSnapshot();
    // A loss the operator has explicitly acknowledged still counts in the P&L; it stops counting
    // against today's limit, so the next halt is a fresh limit away rather than instant.
    const ack = Math.max(0, Number(this.store.state.day.lossAckUsd) || 0);
    const verdict = this.governor.evaluate({ regime: this.store.state.regime, realized_today_usd: snap.realized_today_usd + ack, open: this.store.openPositions().map(p => ({ ...p })) });
    this.verdict = verdict;
    this.store.state.throttle = verdict.throttle;
    this.store.state.governor = { reasons: verdict.reasons, blindSpots: verdict.blindSpots, halt: verdict.halt, haltReason: verdict.haltReason, at: verdict.at };
    const key = JSON.stringify([verdict.throttle, verdict.halt, verdict.haltReason, verdict.reasons]);
    if (key !== this._lastGovernorKey) {
      this._lastGovernorKey = key;
      this.ledger.append({ kind: "governor", throttle: verdict.throttle, halt: verdict.halt, haltReason: verdict.haltReason, reasons: verdict.reasons, blindSpots: verdict.blindSpots, regime: verdict.regime });
      if (verdict.halt && !this.store.isHalted()) {
        this.store.setHalt("freeze", `governor: ${verdict.haltReason}`);
        this.ledger.append({ kind: "halt", mode: "freeze", reason: `governor: ${verdict.haltReason}`, by: "governor" });
        this.alerter?.send("warn", `governor froze entries: ${verdict.haltReason}. Exits keep running. Resume with: velocity resume <venue>`);
      }
    }
    return verdict;
  }

  setRegime(regime) { this.store.state.regime = regime; this.evaluateGovernor(); }

  // ── learner (DP8) ──
  retrain() {
    const integrity = verifyChecksums(this.checksums);
    if (!integrity.ok) { this.ledger.append({ kind: "violation", venue: "pumpfun", rule: "gate_checksum", detail: integrity.changed }); this.alerter?.send("error", `gate files changed on disk: ${integrity.changed.join(", ")}; retrain refused`); return null; }
    const outcomes = this.ledger.query({ kind: "outcome", venue: "pumpfun", limit: 5000 });
    const cur = this.weights.current();
    const r = retrain({ venue: "pumpfun", outcomes, weights: cur.weights });
    if (r.changed) {
      const rec = this.weights.save(r.weights, { n: r.n, accuracyBefore: r.accuracyBefore, accuracyAfter: r.accuracyAfter, violations: r.violations, importance: r.importance });
      this.store.state.weightsVersion = rec.version;
      this.ledger.append({ kind: "weights", version: rec.version, weights: r.weights, violations: r.violations, n: r.n, accuracyBefore: r.accuracyBefore, accuracyAfter: r.accuracyAfter });
      if (r.violations.length) this.alerter?.send("warn", `learner saw data contradicting sacred priors: ${r.violations.map(v => v.feature).join(", ")} (kept, pinned)`);
    }
    return r;
  }

  // ── reconciliation (DP9) ──
  async reconcile() {
    const report = { at: this.clock(), venues: {} };
    for (const [venue, v] of Object.entries(this.venues)) {
      const mode = this.store.venueMode(venue);
      if (mode === "off") continue;
      const router = this.routerFor(venue);
      const rep = { matched: [], adopted: [], closed: [], unknown: [], frozen: false, error: null };
      report.venues[venue] = rep;
      // An uninitialized live router reports an empty wallet; that is not a reason to close anything.
      if (!router || router.ready === false) { rep.error = "live router not initialized"; rep.frozen = true; if (!this.store.state.halt.venues?.[venue]) this.store.setHalt("freeze", "reconcile: live router not initialized", venue); continue; }
      let venuePositions;
      this.seedRouterKnowledge(venue);
      try { venuePositions = await router.positions(); }
      catch (err) { rep.error = err.message; rep.frozen = true; this.store.setHalt("freeze", `reconcile failed: ${err.message}`, venue); continue; }
      this._holdings[venue] = { at: this.clock(), list: venuePositions.map(p => ({ instrument: p.instrument, qty: p.qty })) };
      const atVenue = new Map(venuePositions.map(p => [p.instrument, p]));
      const inStore = new Map(this.store.openPositions(venue).map(p => [p.instrument, p]));
      // Ledger truth: BUY fills with no final exit since.
      const fills = this.ledger.readAll(r => r.kind === "fill" && r.venue === venue && r.side === "BUY");
      const finals = new Set(this.ledger.readAll(r => r.kind === "exit" && r.venue === venue && r.final).map(r => r.positionId));
      const openInLedger = new Map(fills.filter(f => !finals.has(f.positionId)).map(f => [f.instrument, f]));
      // Orders this engine sent: a buy that confirmed after its timeout is ours; an airdrop is not.
      const sent = new Map(this.ledger.readAll(r => r.kind === "order" && r.venue === venue && r.stage === "sent" && r.instrument).map(r => [r.instrument, r]));
      for (const [inst, vp] of atVenue) {
        // A pending partial sell may already be reflected in the wallet: its settlement subtracts
        // the sold quantity later, so the store's quantity is left alone until then.
        if (inStore.has(inst)) { const p = inStore.get(inst); if (vp.qty != null && !p.pendingExit) { p.qty = vp.qty; p.remaining_qty = vp.qty; } rep.matched.push(inst); continue; }
        const f = openInLedger.get(inst);
        if (!f && !sent.has(inst)) { rep.unknown.push({ instrument: inst, qty: vp.qty }); this._knownForeign.add(venue + ":" + inst); continue; }
        const decision = f ? this.ledger.readAll(r => r.kind === "decision" && r.decisionId === f.decisionId)[0] : null;
        const tier = decision?.tier || 2;
        const key = CURVE_VENUES.has(venue) ? (tier >= 1 && tier <= 3 ? tier : 2) : (decision?.model || "resolved_fact");
        const plan = createPlan({ venue, key, entry: { score: decision?.features ? Math.round(decision.features.apeScore * 100) : 0, price: f?.price || vp.avgPrice || 0 } });
        const position = {
          id: f?.positionId || `${venue}:${inst}:adopted:${this.clock()}`, venue, instrument: inst, model: decision?.model || "adopted", tier, group: decision?.group || null,
          decisionId: f?.decisionId || null, orderId: f?.orderId || null, entryTime: f?.ts || this.clock(), entryPrice: f?.price || vp.avgPrice || 0, qty: vp.qty, remaining_qty: vp.qty,
          notional_usd: f?.notional_usd || vp.notional_usd || sent.get(inst)?.stake_usd || 0, stake_usd: f?.notional_usd || vp.notional_usd || sent.get(inst)?.stake_usd || 0, cost_usd: f?.notional_usd || vp.notional_usd || sent.get(inst)?.stake_usd || 0, proceeds_usd: 0,
          entryMark: CURVE_VENUES.has(venue) ? decision?.reference?.mcapUsd || 0 : f?.price || vp.avgPrice || 0, mark: null, peak: null, changePct: 0, entryScore: decision?.features ? Math.round(decision.features.apeScore * 100) : 0,
          worst_case_fraction: decision?.stop_fraction ?? 1, plan, status: "open", p_win: decision?.p_win ?? null, confidence: decision?.confidence ?? null, features: decision?.features || null,
          reference: decision?.reference || null, legs: null, paper: mode === "paper", adopted: true,
        };
        this.store.upsertPosition(position);
        this.venues[venue].feed?.watch(inst); // a position adopted mid-run needs ticks too, or it never gets a price and no exit can fire
        rep.adopted.push(inst);
      }
      for (const [inst, p] of inStore) {
        if (atVenue.has(inst)) continue;
        // A sell that confirmed after its timeout, then a crash: the venue can still prove the proceeds.
        if (p.pendingExit?.sig && router.resolvePending) {
          let r = null;
          try { r = await router.resolvePending({ instrument: inst, side: "SELL", sig: p.pendingExit.sig, at: p.pendingExit.at, reference: { ...(p.reference || {}), mcapUsd: p.mark || p.reference?.mcapUsd }, qtyHint: (Number(p.remaining_qty ?? p.qty) || 0) * (Number(p.pendingExit.pct) || 100) / 100 }); } catch {}
          if (r?.ok) { const { pct, reason } = p.pendingExit; delete p.pendingExit; this._bookExit(p, r, pct, reason || "PENDING_SELL", { by: "reconcile" }); rep.closed.push(inst); continue; }
        }
        // Real tokens gone with no record of the sale: the cost is lost until proven otherwise.
        const pnl = p.paper ? 0 : +((p.proceeds_usd || 0) - (p.cost_usd || 0)).toFixed(4);
        this.ledger.append({ kind: "exit", venue, positionId: p.id, decisionId: p.decisionId, instrument: inst, pct: 100, reason: "MISSING_AT_VENUE", price: 0, qty: p.remaining_qty ?? p.qty, proceeds_usd: 0, fee_usd: 0, final: true, by: "reconcile" });
        this.store.closePosition(p.id, { exitReason: "MISSING_AT_VENUE", pnl_usd: pnl, remaining_qty: 0 });
        if (!p.paper) { this.store.rollDay(); this.store.state.day.realizedUsd = +(this.store.state.day.realizedUsd + pnl).toFixed(4); this.store.state.day.trades++; }
        this.ledger.append({ kind: "outcome", venue, instrument: inst, positionId: p.id, decisionId: p.decisionId, pnl_usd: pnl, pnl_pct: p.cost_usd > 0 ? +((pnl / p.cost_usd) * 100).toFixed(2) : 0, stake_usd: p.stake_usd, p_win: p.p_win, confidence: p.confidence, model: p.model, tier: p.tier, held_ms: this.clock() - p.entryTime, reason: "MISSING_AT_VENUE", reconciled: true, paper: !!p.paper });
        this.emit("outcome", { position: p, pnl }); // the hub's fee and record hooks hear this close like any other
        rep.closed.push(inst);
      }
      if (rep.unknown.length) this.log("warn", `${venue}: wallet holds ${rep.unknown.length} token(s) this engine never bought (${rep.unknown.map(u => u.instrument.slice(0, 8)).join(", ")}); left alone`);
      this._clearStartupFreeze(venue, /^reconcile/);
    }
    this.store.state.reconciledAt = report.at;
    this.ledger.append({ kind: "reconcile", report });
    this.store.save();
    const adopted = Object.values(report.venues).reduce((s, r) => s + r.adopted.length, 0);
    const closed = Object.values(report.venues).reduce((s, r) => s + r.closed.length, 0);
    if (adopted || closed || Object.values(report.venues).some(r => r.frozen)) this.alerter?.send("warn", `reconciled: adopted ${adopted}, closed ${closed}${Object.values(report.venues).some(r => r.frozen) ? ", a venue is frozen" : ""}`);
    this.emit("reconciled", report);
    return report;
  }

  // ── observability (E5, E6, E7) ──
  promotion(venue) {
    const lat = this.latencySummary(venue);
    return promotionGate({ ledger: this.ledger, envelope: this.env, venue, latency: lat, store: this.store });
  }

  latencySummary(venue) {
    const v = this.venues[venue];
    const l = this.latency[venue];
    if (!l) return null;
    return { observe: v?.feed?.latency?.summary() || null, decide: l.decide.summary(), send: l.send.summary(), confirm: l.confirm.summary() };
  }

  status() {
    const s = this.store.state;
    this.store.rollDay();
    const venues = {};
    for (const [venue, v] of Object.entries(this.venues)) {
      venues[venue] = {
        mode: this.store.venueMode(venue), blocked: this.blocked[venue] || null, feed: v.feed?.status() || null, router: s.routers[venue] || null,
        latency: this.latencySummary(venue), budget: this.env.venues[venue].latency_budget_ms, halted: this.store.isHalted(venue),
        evaluated: v.runner?.evaluated || 0, gos: v.runner?.gos || 0, promotion: this.promotion(venue),
      };
    }
    return {
      running: this.running, startedAt: s.startedAt, now: this.clock(), heartbeatAt: s.heartbeatAt, reconciledAt: s.reconciledAt,
      halt: s.halt, throttle: s.throttle, governor: s.governor, regime: s.regime,
      pnl: this.truePnl(),
      day: { ...s.day, limit_usd: this.env.daily_loss_limit_usd, counted_usd: this.realizedToday(), counting: this.anyLiveVenue() ? "live" : "paper", used_pct: +((Math.max(0, -this.realizedToday()) / this.env.daily_loss_limit_usd) * 100).toFixed(1) },
      bankroll: { source: this.walletMode() ? "wallet" : "fixed", fixed_usd: this.env.bankroll_usd, equity_usd: this.portfolioSnapshot().equity_usd ?? null, wallet: this.wallet.at ? this.wallet : null, wallets: this.wallets },
      positions: this.store.openPositions().map(p => ({ id: p.id, venue: p.venue, instrument: p.instrument, name: p.reference?.name || "", ticker: p.reference?.ticker || "", tier: p.tier, model: p.model, notional_usd: p.notional_usd, stake_usd: p.stake_usd, mark: p.mark, entryMark: p.entryMark, peak: p.peak, changePct: p.changePct, unrealized_usd: p.unrealized_usd, plan: { key: p.plan?.key, mode: p.plan?.mode, stall_ms: p.plan?.stall_ms ?? null, max_hold_ms: p.plan?.max_hold_ms ?? null }, tpHit: p._bondli?.tpHit ?? 0, entryTime: p.entryTime, lastTickAt: p.lastTickAt || null, curve: p.reference?.curve?.address || null, adopted: !!p.adopted, sizing: p.sizing || null, lastExitError: p.lastExitError || null })),
      review: this.review(), closes: this.closes(8),
      misses: this.misses({ limit: 300 }).slice(0, 12), // what the rules refused that then ran
      venues, weightsVersion: this.weights.current().version, lastDecisions: s.lastDecisions, alerts: s.alerts.slice(0, 10),
      holdings: Object.fromEntries(Object.entries(this._holdings).map(([venue, h]) => { const open = new Set(this.store.openPositions(venue).map(p => p.instrument)); return [venue, { at: h.at, list: h.list.map(x => ({ ...x, tracked: open.has(x.instrument) })) }]; })),
    };
  }

  /** The entry funnel over the last windowMs, from the ledger: where candidates stop. */
  funnel(windowMs = 10 * 60_000) {
    const since = this.clock() - windowMs;
    const decisions = this.ledger.query({ kind: "decision", limit: 2000 }).filter(d => d.ts >= since);
    const orders = this.ledger.query({ kind: "order", limit: 500 }).filter(o => o.ts >= since);
    const by = {}; const add = (k) => { by[k] = (by[k] || 0) + 1; };
    let gos = 0;
    for (const d of decisions) { if (d.action === "GO") gos++; else add(`${d.gate}:${(d.reasons || [])[0] || "?"}`); }
    const sized0 = orders.filter(o => o.stage === "sized" && !(o.stake_usd > 0)).map(o => (o.sizing?.reasons || [])[0] || "?");
    const failed = orders.filter(o => o.stage === "failed").map(o => o.code || o.reason || "?");
    const filled = orders.filter(o => o.stage === "filled").length;
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => ({ k, n }));
    const gateTotals = {}; for (const d of decisions) if (d.action !== "GO") gateTotals[d.gate] = (gateTotals[d.gate] || 0) + 1;
    return { windowMs, judged: decisions.length, distinct: new Set(decisions.map(d => d.instrument)).size, gos, gates: gateTotals, top, sized0: sized0.length ? sized0.reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {}) : null, failed: failed.length ? failed.reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {}) : null, filled, feed: Object.fromEntries(Object.entries(this.venues).map(([v, x]) => [v, x.feed?.status ? { events: x.feed.status().events, stale: x.feed.status().stale } : null])) };
  }

  why(id) {
    if (id === "last") { const d = this.ledger.lastDecision(); return d ? this.ledger.trail(d.id) : []; }
    const m = /^(\w+) last$/.exec(id);
    if (m) { const d = this.ledger.lastDecision(m[1]); return d ? this.ledger.trail(d.id) : []; }
    const trail = this.ledger.trail(id);
    if (trail.length) return trail;
    const near = this.ledger.query({ kind: "decision", limit: 5 }).map(d => d.id);
    return { error: `unknown id ${id}`, nearest: near };
  }
}
