// ═══ VELOCITY — hosted hub: one radar, one engine per user, a fee on realized profit ═══
// Design: src/velocity/HOSTED_DESIGN.md (DP2, DP3, DP5, DP6).
// One PumpfunFeed is shared by every engine through a SharedFeedView, so N users cost one radar.
// Each engine owns its wallet (secret injected, never process.env), risk envelope, ledger, store and
// halt state under data/velocity/users/<wallet>. When a position closes with a profit the hub
// computes the platform's cut from the measured SOL in and out, moves it from the user's trading
// wallet to PLATFORM_WALLET, and writes it to the user's ledger where they can see it.
import fs from "node:fs";
import path from "node:path";
import { Feed } from "./core/feed.mjs";
import { Engine } from "./core/engine.mjs";
import { Alerter } from "./core/alerts.mjs";
import { Supervisor } from "./core/supervisor.mjs";
import { validateRisk, deepFreeze } from "./core/risk.mjs";
import { formatRecord } from "./core/watch.mjs";
import { makePumpfunEdge } from "./venues/pumpfun/edge.mjs";
import { PumpfunPaperRouter, PumpfunLiveRouter } from "./venues/pumpfun/router.mjs";
import { PonsLiveRouter, PonsPaperRouter } from "./venues/pons/router.mjs";
import { ArcLiveRouter, ArcPaperRouter } from "./venues/arc/router.mjs";
import { HolderWaiver } from "./core/holder-waiver.mjs";
import { Ledger } from "./core/ledger.mjs";
import { Callouts } from "./core/callouts.mjs";

/** The platform wallet this project shipped with before fees were configurable. It must be replaced:
 *  it is not a wallet whose key can be trusted any more. Setting PLATFORM_WALLET to it still works,
 *  so an operator is never silently cut off from their own fees, but the boot warns every time. */
export const EXPOSED_DEFAULT_PLATFORM_WALLET = "4XnHZZmHwSQ8RszJsdc7snvxG8dZtm6g4hvpkCMkguMx";
/** Each venue's quote asset, as the ledger and the operator name it. */
export const QUOTE_OF = Object.freeze({ pumpfun: "SOL", pons: "ETH", arc: "USDC" });
/** The one rate, for everyone who does not hold the house token. The site states the same number. */
export const DEFAULT_FEE_PCT = 5;
/** The smallest stake whose costs do not eat the trade. See the venue envelope below. */
// The smallest trade worth making, from the router's own cost constants at SOL $200.
//
// This was 25 when a round trip cost $0.61 in fixed fees: two priority fees at 0.0005 SOL and the
// token account's rent, which was paid and never recovered. Both of those are gone -- the priority
// fee is 0.0003 and the rent comes back when the account is closed -- so the fixed cost is $0.12 and
// the drag curve is almost flat above $10:
//
//   stake   fixed    variable   total drag   break-even win rate*
//   $5      2.46%    3.0%       5.46%        36.6%
//   $10     1.23%    3.0%       4.23%        32.4%
//   $25     0.49%    3.0%       3.49%        29.9%
//   $40     0.31%    3.0%       3.31%        29.3%
//   * at the observed payoff shape: average win +24.1%, average loss -5.3%
//
// $10 costs 0.74 points of drag against $25 and buys two and a half times the diversification on the
// same money. Below it the fixed cost starts to bite again. The EV gate prices costs at the smallest
// stake the sizer could return, so a trade that cannot clear its own drag is still refused.
export const MIN_STAKE_USD = Number(process.env.MIN_STAKE_USD) > 0 ? Number(process.env.MIN_STAKE_USD) : 10;

/** A per-engine view of one shared feed: same events, own watch list, no own poller. */
export class SharedFeedView extends Feed {
  constructor(shared, { clock } = {}) {
    super({ venue: shared.venue, name: `${shared.name}:view`, clock: clock || shared.clock, staleAfterMs: shared.staleAfterMs, latencyBoundMs: shared.latencyBoundMs });
    this.shared = shared;
    this._onEvent = e => { if (e.kind !== "feed_health") { this.lastEventAt = e.t_observed; this.eventsEmitted++; } this.emit("event", e); };
  }
  get solPrice() { return this.shared.solPrice; }
  watch(id) { super.watch(id); this.shared.watch(id); this.shared._viewRefs = this.shared._viewRefs || new Map(); this.shared._viewRefs.set(String(id), (this.shared._viewRefs.get(String(id)) || 0) + 1); }
  unwatch(id) {
    super.unwatch(id);
    const refs = this.shared._viewRefs || new Map(); const n = (refs.get(String(id)) || 1) - 1;
    if (n <= 0) { refs.delete(String(id)); this.shared.unwatch(id); } else refs.set(String(id), n);
  }
  ageMs() { return this.shared.ageMs(); }
  isStale() { return this.shared.isStale(); }
  async start() { this.running = true; this.shared.on("event", this._onEvent); this.healthy = this.shared.healthy; }
  async stop() { this.running = false; this.shared.off("event", this._onEvent); }
}

/** A user's risk envelope: the template with the user's few choices, validated and frozen. */
export function userEnvelope(settings = {}, templateFile = path.resolve("src/velocity/config/risk.example.json")) {
  const t = JSON.parse(fs.readFileSync(templateFile, "utf8"));
  // A bankroll below one stake cannot place a trade, and a per-trade cap below one stake would place
  // trades whose costs exceed what they can win. Both are raised to the floor rather than silently
  // producing a bot that runs and never fills.
  const bankroll = Math.max(MIN_STAKE_USD, Math.min(100_000, Number(settings.bankrollUsd) || 100));
  const perTrade = Math.max(MIN_STAKE_USD, Math.min(bankroll, Number(settings.perTradeMaxUsd) || MIN_STAKE_USD));
  let maxPositions = Math.max(1, Math.min(10, Math.round(Number(settings.maxPositions) || 4)));
  // The day's loss budget also caps a single stake (worst_case_fraction is 1.0 on a memecoin: the
  // whole position can go). A budget smaller than one stake therefore means the bot runs and never
  // fills, which is the worst of both. One minimum stake is the floor; a bankroll too small to
  // afford that is refused at start rather than quietly idling.
  // The day's budget, when the user has not named one. 15% of the bankroll was a risk number chosen
  // without reference to the position count, and because a memecoin position can lose all of itself
  // the budget is ALSO the concurrency limit -- so 15% quietly funded one position on any account
  // under $667 while the panel promised four.
  //
  // Fund the positions actually asked for, and cap the day at 35% of the account. 35% is the point
  // where three maximally bad days in a row still leave a quarter of the bankroll; past that a
  // recovery stops being plausible. It is a LIMIT on the worst case where every open position rugs
  // at once, not an expectation: the observed loss per losing trade is about 5% of stake.
  const DAILY_MAX_FRACTION = 0.35;
  const daily = Math.max(MIN_STAKE_USD, Math.min(bankroll,
    Number(settings.dailyLossUsd) || Math.min(Math.round(bankroll * DAILY_MAX_FRACTION), perTrade * maxPositions)));
  // The sizer treats a memecoin position as able to lose all of itself (worst_case_fraction 1.0), so
  // the day's budget is also a concurrency limit: with a $15 budget and $25 stakes, ONE open position
  // exhausts it and every later candidate is refused DAILY_BUDGET_EXHAUSTED until tomorrow. The
  // setting said four positions and the budget allowed one, with nothing anywhere saying so. Make
  // the two agree, and report it, rather than letting the budget quietly overrule the setting.
  const affordable = Math.max(1, Math.floor(daily / perTrade));
  const positionsAsked = maxPositions;
  if (affordable < maxPositions) maxPositions = affordable;
  const portfolio = Math.min(bankroll, perTrade * maxPositions);
  // Degen apes heavier: the Kelly fraction scales with the dial (0.75x safe, 1x, 1.5x, 2x), capped at half Kelly.
  const level = Math.max(0, Math.min(3, Math.round(settings.aggression == null || settings.aggression === "" ? 1 : Number(settings.aggression) || 0)));
  const kellyMult = { 0: 0.75, 1: 1, 2: 1.5, 3: 2 }[level] || 1;
  const kelly = v => Math.min(0.5, (Number(v) || 0.25) * kellyMult);
  const cfg = {
    ...t, bankroll_usd: bankroll, bankroll_source: "wallet", wallet_reserve_sol: 0.02,
    per_trade_max_usd: perTrade, portfolio_max_exposure_usd: portfolio, daily_loss_limit_usd: daily,
    max_concurrent_positions: maxPositions, max_per_group: 1,
    venues: {
      // min_stake_usd: the floor a round trip has to clear to be worth taking. See MIN_STAKE_USD above
      // for the arithmetic behind it; the short version is 4.2% of drag at $10 against 3.5% at $25.
      // Either venue can be switched off. A venue with no exposure is never sized and never entered,
      // which is what lets someone trade Robinhood Chain alone without funding a SOL wallet at all.
      pumpfun: { ...t.venues.pumpfun, max_exposure_usd: settings.pumpfun === false ? 0 : portfolio, max_concurrent: settings.pumpfun === false ? 0 : maxPositions, min_stake_usd: MIN_STAKE_USD, kelly_fraction: kelly(t.venues.pumpfun.kelly_fraction) },
      pons: { ...t.venues.pons, max_exposure_usd: settings.pons ? portfolio : 0, max_concurrent: settings.pons ? maxPositions : 0, min_stake_usd: MIN_STAKE_USD, kelly_fraction: kelly(t.venues.pons.kelly_fraction) },
      // Arc (Argus): opt-in like Robinhood Chain, quoted in USDC. Off until the user turns it on.
      arc: { ...t.venues.arc, max_exposure_usd: settings.arc ? portfolio : 0, max_concurrent: settings.arc ? maxPositions : 0, min_stake_usd: MIN_STAKE_USD, kelly_fraction: kelly(t.venues.arc.kelly_fraction) },
      polymarket: { ...t.venues.polymarket, max_exposure_usd: 0 },
      perps: { ...t.venues.perps, max_exposure_usd: 0 },
    },
  };
  delete cfg._comment;
  const v = validateRisk(cfg);
  if (!v.ok) throw new Error(`risk settings rejected: ${v.errors.join("; ")}`);
  // Recorded, not hidden: the panel says "4 positions" and the envelope allows one.
  if (maxPositions < positionsAsked) cfg.positions_capped_by_daily_budget = { asked: positionsAsked, allowed: maxPositions, daily_loss_limit_usd: daily, per_trade_max_usd: perTrade };
  return deepFreeze(cfg);
}

export class VelocityHub {
  /**
   * @param feed        the shared PumpfunFeed (or any Feed) already fed by the radar
   * @param rootDir     data/velocity/users
   * @param platformWallet  where the fee goes; the exposed default is refused
   * @param fee         { calculateFee, resolveTier, recordTradeOutcome, recordGlobalFee, getUser }
   * @param makeLiveRouter  ({ secret }) => router; tests inject a double
   */
  constructor({ feed, ponsFeed = null, arcFeed = null, rootDir, platformWallet, platformEvmWallet = null, fee, feePct = null, rpcUrl = process.env.RPC_URL, makeLiveRouter = null, makePonsRouter = null, makeArcRouter = null, callouts = null, onUsers = null, clock = () => Date.now(), log = console }) {
    this.feed = feed; this.ponsFeed = ponsFeed; this.arcFeed = arcFeed; this.rootDir = rootDir;
    // The activity gate asks how many bots run, on every change.
    this.onUsers = typeof onUsers === "function" ? onUsers : null;
    this.platformWallet = platformWallet || null; this.platformEvmWallet = platformEvmWallet || null; this.fee = fee; this.rpcUrl = rpcUrl;
    this.makePonsRouter = makePonsRouter || (({ secret }) => new PonsLiveRouter({ secret, clock }));
    // Arc signs with the same EVM key as Robinhood Chain: one 0x address, two chains, two balances.
    this.makeArcRouter = makeArcRouter || (({ secret }) => new ArcLiveRouter({ secret, rpcUrl: process.env.ARC_RPC_URL || null, clock }));
    // A flat rate on realized profit (VELOCITY_FEE_PCT) replaces the site's ladder when set: one number, said plainly.
    // One rate for everyone who does not hold the house token. There are no tiers: the old free /
    // pro / vip ladder was a different revenue model and no longer decides anything here, so an
    // unset or nonsense VELOCITY_FEE_PCT falls back to the standard rate rather than to that ladder.
    this.feePct = feePct != null && feePct !== "" && Number.isFinite(Number(feePct)) && Number(feePct) >= 0 ? Number(feePct) : DEFAULT_FEE_PCT;
    this.makeLiveRouter = makeLiveRouter || (({ secret }) => new PumpfunLiveRouter({ secret, rpcUrl, clock }));
    this.clock = clock; this.log = log;
    this.users = new Map(); // wallet -> { engine, sup, view, settings, startedAt }
    // The public track record: the bot's own live fills, each written to a ledger with a hash before
    // any channel sees it. One for the whole hub, not one per user -- the dedupe (one call per token
    // per hour) and the record are hub-wide, and no row ever names whose engine traded. Tests inject
    // their own with a fetch double; production reads its channels from the environment and posts
    // nowhere when none is set, which still leaves the record on the site.
    this.callouts = callouts || new Callouts({
      ledger: new Ledger(path.join(rootDir, "_hub", "callouts.jsonl"), { now: clock }), clock,
      statusUrl: process.env.PUBLIC_URL || process.env.BONDLI_URL || "",
      minTier: Number.isFinite(Number(process.env.CALLOUT_MIN_TIER)) && process.env.CALLOUT_MIN_TIER !== "" ? Number(process.env.CALLOUT_MIN_TIER) : 2,
      channels: {
        webhookUrl: process.env.CALLOUT_WEBHOOK_URL || null,
        telegram: process.env.CALLOUT_TG_TOKEN && process.env.CALLOUT_TG_CHAT_ID ? { token: process.env.CALLOUT_TG_TOKEN, chatId: process.env.CALLOUT_TG_CHAT_ID } : null,
      },
    });
    this._sweeps = new Map(); // wallet -> running or finished sweep job
    this._holdingsCache = new Map();
    // Hold the house token and the fee is zero, on both venues. $BNDLI is an SPL mint on Solana, read
    // against the user's own Solana wallet -- the pubkey they already sign in with -- so there is
    // nothing extra to connect and someone who only trades pump.fun can earn the waiver too. Inert
    // until the token is launched and BNDLI_MINT is set; until then every fee is charged as before.
    // The variables used to be named JEFF_*; they are still read as a fallback for one deploy so a
    // host whose env was set under the old name does not switch the waiver off in silence.
    const waiverEnv = (name) => process.env[`BNDLI_${name}`] || process.env[`JEFF_${name}`] || "";
    const usesOldWaiverEnv = ["MINT", "MIN_TOKENS", "SYMBOL"].filter(n => !process.env[`BNDLI_${n}`] && process.env[`JEFF_${n}`]);
    if (usesOldWaiverEnv.length) log.warn?.(`[VELOCITY-HUB] ${usesOldWaiverEnv.map(n => `JEFF_${n}`).join(", ")} still set under the old name; rename to ${usesOldWaiverEnv.map(n => `BNDLI_${n}`).join(", ")} -- the JEFF_* fallback goes away next release`);
    this.waiver = new HolderWaiver({
      token: waiverEnv("MINT") || null,
      minTokens: Number(waiverEnv("MIN_TOKENS") || 1),
      symbol: waiverEnv("SYMBOL") || "BNDLI",
      rpcUrl: rpcUrl || process.env.RPC_URL || null,
      clock, log,
    });
    if (this.waiver.enabled) log.log?.(`[VELOCITY-HUB] fee waiver on: holders of ${this.waiver.minTokens}+ ${this.waiver.symbol} (${this.waiver.token}) pay nothing`);
    else if (this.waiver.configuredButInvalid) log.error?.(`[VELOCITY-HUB] BNDLI_MINT is not a Solana address; the holder fee waiver is OFF`);
    this.feeOk = !!this.platformWallet;
    if (!this.feeOk) log.error?.(`[VELOCITY-HUB] PLATFORM_WALLET is unset: SOL performance fees will NOT be collected`);
    else if (this.platformWallet === EXPOSED_DEFAULT_PLATFORM_WALLET) log.warn?.(`[VELOCITY-HUB] PLATFORM_WALLET is the shipped default, which must be replaced with a wallet you created: fees are being collected there by your own configuration`);
  }

  has(wallet) { return this.users.has(wallet); }
  list() { return [...this.users.keys()]; }

  /** Start a user's engine on their trading wallet. Refuses when the wallet cannot cover one order. */
  async start({ wallet, secret, evmSecret = null, settings = {} }) {
    if (!wallet || !secret) throw new Error("wallet and secret required");
    if (this.users.has(wallet)) return { ok: true, already: true, ...this.status(wallet) };
    const dataDir = path.join(this.rootDir, wallet);
    fs.mkdirSync(dataDir, { recursive: true });
    const pons = !!settings.pons && !!this.ponsFeed && !!evmSecret; // Robinhood Chain: opted in, feed running, ETH key on file
    const arc = !!settings.arc && !!this.arcFeed && !!evmSecret; // Arc (Argus): opted in, feed running, the same EVM key
    // pump.fun is on unless the user says otherwise. Someone who only wants Robinhood Chain turns it
    // off and never has to fund a SOL wallet; the venue goes to "off", not "paper", so the engine
    // stops looking at its feed rather than quietly paper-trading it in the background.
    const pumpfun = settings.pumpfun !== false;
    if (!pumpfun && !pons && !arc) return { ok: false, error: "turn on at least one chain: pump.fun, Robinhood Chain, or Arc" };
    // Paper: run the whole machine on the real feed and simulate only the fills. Chosen per start, so
    // a user can paper-trade today and go live tomorrow with the same settings.
    const paper = !!settings.paper;
    // Public callouts are the user's choice, off by default: a call links the buy transaction, and the
    // transaction names the trading wallet. Nobody's wallet goes public because someone else's did.
    const callouts = settings.callouts === true;
    const aggression = Math.max(0, Math.min(3, Math.round(settings.aggression == null || settings.aggression === "" ? 1 : Number(settings.aggression) || 0)));
    const envelope = userEnvelope({ ...settings, pons, arc, aggression });
    const view = new SharedFeedView(this.feed, { clock: this.clock });
    const liveRouter = this.makeLiveRouter({ secret, wallet });
    const venues = { pumpfun: { mode: "paper", feed: view, edge: makePumpfunEdge({ aggression }), router: new PumpfunPaperRouter({ bookFile: path.join(dataDir, "paper-book-pumpfun.json"), clock: this.clock }), liveRouter } };
    if (pons) venues.pons = { mode: "paper", feed: new SharedFeedView(this.ponsFeed, { clock: this.clock }), edge: makePumpfunEdge({ venue: "pons", aggression }), router: new PonsPaperRouter({ bookFile: path.join(dataDir, "paper-book-pons.json"), clock: this.clock }), liveRouter: this.makePonsRouter({ secret: evmSecret, wallet }) };
    if (arc) venues.arc = { mode: "paper", feed: new SharedFeedView(this.arcFeed, { clock: this.clock }), edge: makePumpfunEdge({ venue: "arc", aggression }), router: new ArcPaperRouter({ bookFile: path.join(dataDir, "paper-book-arc.json"), clock: this.clock }), liveRouter: this.makeArcRouter({ secret: evmSecret, wallet }) };
    const engine = new Engine({ dataDir, envelope, venues, clock: this.clock });
    // Everything the engine considers worth waking someone for -- a live router that failed to
    // initialise, a flatten that left positions open, a position booked as a total loss, the governor
    // freezing entries, gate files changed on disk -- went to a webhook that was hard-coded null, so
    // it reached the ledger and the status page and nowhere a person would see it. ALERT_WEBHOOK_URL
    // (a Slack/Discord/ntfy endpoint) is now honoured, and the message carries a link back.
    engine.alerter = new Alerter({
      store: engine.store, ledger: engine.ledger,
      webhookUrl: process.env.ALERT_WEBHOOK_URL || null,
      statusUrl: process.env.PUBLIC_URL || process.env.BONDLI_URL || "",
    });
    engine.on("log", l => this.log.log?.(`[velocity ${wallet.slice(0, 8)}] ${l.level} ${l.text}`));
    engine.on("outcome", ({ position }) => { this.settleFee(wallet, position).catch(err => this.log.error?.(`[VELOCITY-HUB] fee ${wallet.slice(0, 8)}: ${err.message}`)); });
    // Every fill is offered to the public record; the callouts object decides (paper never, below the
    // tier never, once an hour per token across every user) and never throws back into the engine.
    engine.on("position", p => { if (!callouts) return; this.callouts.onFill(p, { venue: p.venue, tx: p.venue_ref || null, mcapUsd: p.reference?.mcapUsd, tier: p.tier, plan: p.plan, paper: !!p.paper }).catch(() => {}); });
    engine.on("outcome", ({ position: p, pnl }) => { this.callouts.onOutcome({ position: p, pnl, instrument: p.instrument, positionId: p.id, paper: !!p.paper, reason: p.exitReason }).catch(() => {}); });
    engine.on("released", ({ position: p }) => { this.callouts.onOutcome({ position: p, pnl: null, instrument: p.instrument, positionId: p.id, paper: !!p.paper, reason: "RELEASED" }).catch(() => {}); });
    const sup = new Supervisor({ engine, dataDir, alerter: engine.alerter, clock: this.clock });
    await engine.start();
    // Start is the user's intent to trade: a halt left over from their last stop or pause must not
    // outlive it. resume() re-runs the governor, so a daily-loss halt that still applies comes back.
    for (const v of Object.keys(engine.venues)) if (engine.store.state.halt?.mode || engine.store.isHalted(v)) engine.resume(v, { by: "user" });
    // Each wanted venue goes live on its own terms, and the start only fails if NONE of them could.
    // pump.fun used to be mandatory -- its preflight failing stopped the whole engine -- so a user
    // with a funded ETH wallet and an empty SOL one could not trade at all.
    //
    // Paper mode is the exception: the venues are built exactly as they are for real money and then
    // simply left in "paper", so every gate, size, plan and exit runs against the same live feed and
    // the same rules, and only the router is a simulation. That means it needs no funded wallet and
    // can never spend one -- the preflight that refuses an empty wallet is the thing being skipped,
    // so it must not run at all rather than run and be ignored.
    const wanted = [pumpfun && "pumpfun", pons && "pons", arc && "arc"].filter(Boolean);
    const results = {};
    if (paper) {
      for (const v of wanted) results[v] = { ok: true, paper: true };
      engine.log("info", `paper mode: ${wanted.join(" and ")} judged and traded on the live feed, with simulated money`);
    } else for (const v of wanted) {
      results[v] = await engine.setVenueMode(v, "live", { override: true, by: "user" });
      if (!results[v].ok) engine.log("warn", `${v} stays paper: ${results[v].error || "could not go live"}`);
    }
    // A venue the user turned off is switched off rather than left in paper, so the engine stops
    // reading its feed instead of quietly simulating trades nobody asked for. A venue that was never
    // built (no ETH key, no PONS feed) is not in engine.venues at all and needs no switching.
    for (const v of Object.keys(engine.venues)) if (!wanted.includes(v)) await engine.setVenueMode(v, "off", { by: "user" });
    const anyLive = wanted.some(v => results[v]?.ok);
    if (!anyLive) {
      await engine.stop();
      const first = results[wanted[0]] || {};
      return { ok: false, error: first.error || "could not go live", preflight: first.preflight || null, venues: results };
    }
    sup.start();
    this.users.set(wallet, { engine, sup, view, settings: { ...settings, aggression, pons, arc, pumpfun, paper, callouts }, startedAt: this.clock() });
    this.onUsers?.(this.users.size);
    // Once a minute, the funnel in the server log: what the candidates hit. The first place to look when nothing fills.
    const fun = setInterval(() => { try { const f = engine.funnel(); this.log.log?.(`[velocity ${wallet.slice(0, 8)}] funnel 10m: judged ${f.judged} (${f.distinct} tokens) go ${f.gos} filled ${f.filled} | ${Object.entries(f.gates).map(([g, n]) => `${g} ${n}`).join(", ") || "no rejects"} | top: ${f.top.map(x => `${x.k} ${x.n}`).join("; ")}${f.sized0 ? ` | no size: ${JSON.stringify(f.sized0)}` : ""}${f.failed ? ` | failed: ${JSON.stringify(f.failed)}` : ""}`); } catch {} }, 60_000);
    fun.unref?.(); this.users.get(wallet).fun = fun;
    return { ok: true, ...this.status(wallet) };
  }

  /** Give up on a position the venue will not let us sell. No P&L is booked; the tokens stay in the
   *  wallet and reappear as an untracked holding the user can sell by hand. */
  async release(wallet, positionId, note = null) {
    const u = this.users.get(wallet);
    if (!u) return { ok: false, error: "not running" };
    return u.engine.enqueue(() => u.engine.releasePosition(positionId, { by: "user", note }));
  }

  /** Clear the "sell failed" banner on a position. The failure stays in the ledger. */
  async clearExitError(wallet, positionId) {
    const u = this.users.get(wallet);
    if (!u) return { ok: false, error: "not running" };
    return u.engine.enqueue(() => u.engine.clearExitError(positionId));
  }

  /** Clear a "paused by the bot: daily_limit" banner. Re-arms the limit rather than removing it. */
  async acknowledgeDailyLimit(wallet) {
    const u = this.users.get(wallet);
    if (!u) return { ok: false, error: "not running" };
    return u.engine.enqueue(() => u.engine.acknowledgeDailyLimit());
  }

  /** Sell everything the user holds and stop their engine. */
  async stop(wallet, { flatten = true } = {}) {
    const u = this.users.get(wallet);
    if (!u) return { ok: false, error: "not running" };
    let result = null;
    // Through the engine queue: off it, this flatten races the tick-driven exits already running on it.
    if (flatten) result = await u.engine.enqueue(() => u.engine.halt("flatten", "user stop", { by: "user" }));
    u.sup.stop(); clearInterval(u.fun);
    await u.engine.stop();
    this.users.delete(wallet);
    this.onUsers?.(this.users.size);
    return { ok: true, closed: result?.closed?.length || 0, failed: result?.failed || [] };
  }

  async halt(wallet, mode = "flatten") {
    const u = this.users.get(wallet);
    if (!u) return { ok: false, error: "not running" };
    return { ok: true, ...(await u.engine.enqueue(() => u.engine.halt(mode, "user halt", { by: "user" }))) };
  }

  /** Pause: no new entries, open positions keep their exit plans. Resume lifts it. */
  async pause(wallet) {
    const u = this.users.get(wallet);
    if (!u) return { ok: false, error: "not running" };
    await u.engine.enqueue(() => u.engine.halt("freeze", "paused by user", { by: "user" }));
    return { ok: true, ...this.status(wallet) };
  }
  resume(wallet) {
    const u = this.users.get(wallet);
    if (!u) return { ok: false, error: "not running" };
    // Every venue the engine has, not just pump.fun. Resume did nothing at all for someone trading
    // Robinhood Chain alone. It re-runs the governor, so a halt whose cause still stands -- the
    // day's loss limit, most of all -- comes straight back, which is the point.
    for (const v of Object.keys(u.engine.venues)) u.engine.resume(v, { by: "user" });
    const s = this.status(wallet);
    const still = u.engine.store.state.halt?.mode ? u.engine.store.state.halt : null;
    return { ok: true, ...s, stillHalted: still ? { reason: still.reason } : null };
  }

  /** Sell some or all of one open position now, by the user's hand. Runs on the engine's queue. */
  async closePosition(wallet, positionId, pct = 100) {
    const u = this.users.get(wallet);
    if (!u) return { ok: false, error: "not running" };
    const p = u.engine.store.state.positions[positionId];
    if (!p || p.status !== "open") return { ok: false, error: "no such open position" };
    const share = Math.min(100, Math.max(1, Math.round(Number(pct) || 100)));
    const r = await u.engine.enqueue(() => u.engine.closePosition(p, share, "USER_SELL", { by: "user", detail: `${share}% by the user` }));
    return { ok: !!r?.ok, ...(r?.ok ? { sold_pct: share, proceeds_usd: r.fill?.notional_usd ?? null } : { error: r?.failure?.reason || "sell failed", code: r?.failure?.code || null }), ...this.status(wallet) };
  }

  status(wallet) {
    const u = this.users.get(wallet);
    if (!u) return { running: false, sweep: this._sweepView(this._sweeps.get(wallet)) };
    const s = u.engine.status();
    // The waiver as last read; status must not block on an RPC, so this never triggers a fresh read.
    const cached = this.waiver.enabled ? this.waiver.cached(wallet) : null;
    const fee = { pct: this.feePct, waiver: this.waiver.enabled ? { symbol: this.waiver.symbol, token: this.waiver.token, minTokens: this.waiver.minTokens, holds: cached ? cached.holds : null } : null };
    return { running: true, startedAt: u.startedAt, settings: u.settings, owedFees: u.owedFees || [], status: s, funnel: u.engine.funnel(), feeWallet: this.feeOk ? this.platformWallet : null, fee, sweep: this._sweepView(this._sweeps.get(wallet)) };
  }

  /** What every bot on the site did lately, with no wallet named. This is the landing page's proof
   *  that the thing is real: bots trading now, closes in the last day, the best of them, and the tape
   *  -- the last dozen closes across every bot, paper included but flagged so the page can say
   *  "paper" rather than a number that looks like money. A wallet is never in it, nor a position id,
   *  and a paper close is never counted in the money figures. */
  pulse({ windowMs = 24 * 60 * 60_000, limit = 8, tapeLimit = 12 } = {}) {
    const since = this.clock() - windowMs;
    const closes = [];
    for (const u of this.users.values()) {
      for (const o of u.engine.ledger.query({ kind: "outcome", limit: 200 })) {
        if (o.ts < since || o.reason === "LEG_UNWOUND") continue;
        const p = u.engine.store.state.positions?.[o.positionId];
        closes.push({ ts: o.ts, venue: o.venue, instrument: o.instrument, name: p?.reference?.name || "", ticker: p?.reference?.ticker || "", pnl_usd: o.pnl_usd, pnl_pct: o.pnl_pct, held_ms: o.held_ms, reason: o.reason, paper: !!o.paper });
      }
    }
    const live = closes.filter(c => !c.paper);
    const wins = live.filter(c => c.pnl_usd > 0);
    const best = [...wins].sort((a, b) => b.pnl_pct - a.pnl_pct).slice(0, limit);
    const recent = [...live].sort((a, b) => b.ts - a.ts).slice(0, limit);
    // The tape carries no dollar figure at all: a percentage and a hold time say what happened, a
    // USD size would say how big someone's bankroll is.
    const tape = [...closes].sort((a, b) => b.ts - a.ts).slice(0, tapeLimit)
      .map(c => ({ ts: c.ts, venue: c.venue, ticker: c.ticker, instrument: c.instrument, pnl_pct: c.pnl_pct, held_ms: c.held_ms, paper: c.paper, reason: c.reason }));
    return {
      bots: this.users.size,
      live: [...this.users.values()].filter(u => !u.settings?.paper).length,
      closes: live.length, wins: wins.length,
      pnl_usd: +live.reduce((s, c) => s + c.pnl_usd, 0).toFixed(2),
      best, recent, tape, windowMs, ts: this.clock(),
    };
  }

  /** The narration, newest last, from the user's own ledger. */
  narration(wallet, limit = 60) {
    const u = this.users.get(wallet);
    if (!u) return [];
    return u.engine.ledger.query({ limit }).map(r => ({ ts: r.ts, line: formatRecord(r) })).filter(x => x.line).reverse();
  }

  /** The performance fee: on realized SOL profit of one closed position, paid from the wallet that earned it. */
  async settleFee(wallet, position) {
    const u = this.users.get(wallet);
    if (!u || position.paper) return null;
    const solIn = Number(position.sol_spent) || 0, solOut = Number(position.sol_received) || 0;
    if (!(solIn > 0) || !(solOut > 0)) return null; // no measured SOL on both sides: no basis for a fee
    const f = this.flatFee(solIn, solOut, wallet);
    this.fee.recordTradeOutcome?.(wallet, f.net);
    if (!(f.fee > 0.0005)) return { fee: 0, net: f.net };
    // Holders trade free. Checked after the fee is computed so the ledger can say what was waived.
    if (await this.holderWaived(wallet)) {
      const venue0 = position.venue || "pumpfun", quote0 = QUOTE_OF[venue0] || "SOL";
      u.engine.ledger.append({ kind: "fee", venue: venue0, instrument: position.instrument, positionId: position.id, scope: "platform", sol: 0, usd: 0, rate: 0, net_sol: f.net, waived_sol: +f.fee.toFixed(6), note: `fee waived: holds ${this.waiver.symbol}` });
      u.engine.store.save();
      u.engine.log("info", `platform fee waived (${f.fee.toFixed(6)} ${quote0}): this wallet holds ${this.waiver.symbol}`);
      return { fee: 0, net: f.net, waived: +f.fee.toFixed(6), reason: `holds ${this.waiver.symbol}` };
    }
    const venue = position.venue || "pumpfun", quote = QUOTE_OF[venue] || "SOL";
    const feeWallet = this.feeWalletFor(venue);
    if (!feeWallet) { u.engine.log("warn", `platform fee ${f.fee.toFixed(6)} ${quote} not collected: ${venue === "pumpfun" ? "PLATFORM_WALLET" : "PLATFORM_EVM_WALLET"} not set`); return { fee: f.fee, net: f.net, collected: false }; }
    const solPrice = u.engine.quotePriceOf(venue) || (venue === "arc" ? 1 : venue === "pons" ? this.ponsFeed?.solPrice : this.feed.solPrice) || 0;
    let sig;
    try { sig = await u.engine.venues[venue].liveRouter.transferSol(feeWallet, f.fee); }
    catch (err) {
      // The fee is owed whether or not the transfer landed. A throw here used to vanish into the
      // outcome handler's catch: no record, no retry, the money simply not collected. Record it as
      // owed and try again on the next close from this wallet.
      const reason = String(err?.shortMessage || err?.message || err).slice(0, 200);
      u.engine.ledger.append({ kind: "fee", venue, quote, instrument: position.instrument, positionId: position.id, scope: "platform", sol: 0, owed_sol: +f.fee.toFixed(6), usd: 0, rate: f.rate ?? null, net_sol: f.net, collected: false, error: reason, note: `performance fee not collected: ${reason}` });
      u.owedFees = [...(u.owedFees || []), { venue, quote, amount: +f.fee.toFixed(6), instrument: position.instrument, at: this.clock(), error: reason }];
      u.engine.store.save();
      u.engine.log("warn", `platform fee ${f.fee.toFixed(6)} ${quote} owed, transfer failed: ${reason}`);
      return { fee: f.fee, net: f.net, collected: false, error: reason };
    }
    // The venue and quote asset are recorded as they are. This used to write venue "pumpfun" and a
    // field named sol for an ETH fee on Robinhood Chain, so the ledger could not say which chain
    // was paid in what.
    u.engine.ledger.append({ kind: "fee", venue, quote, instrument: position.instrument, positionId: position.id, scope: "platform", sol: +f.fee.toFixed(6), usd: +(f.fee * solPrice).toFixed(4), rate: f.rate ?? null, net_sol: f.net, venue_ref: sig, note: `performance fee ${f.rate ?? ""}% of ${f.net.toFixed(4)} ${quote} profit` });
    this.collectOwed(wallet, venue).catch(() => {});
    u.engine.store.save();
    this.fee.recordGlobalFee?.(f.fee);
    u.engine.log("info", `platform fee ${f.fee.toFixed(6)} ${quote} (${f.rate ?? "?"}% of ${f.net.toFixed(4)} profit) tx ${String(sig).slice(0, 10)}`);
    return { fee: f.fee, net: f.net, collected: true, sig };
  }

  /** Where a venue's fee goes: the Solana wallet for SOL, the EVM wallet for anything on an EVM chain.
   *  One EVM address serves Robinhood Chain and Arc alike; the asset differs (ETH there, USDC here). */
  feeWalletFor(venue) { return venue === "pumpfun" ? (this.feeOk ? this.platformWallet : null) : this.platformEvmWallet; }

  /** Fees that could not be transferred when they were earned. Tried again after any later fee on
   *  the same venue succeeds -- that is proof the transfer path works again. Never throws. */
  async collectOwed(wallet, venue) {
    const u = this.users.get(wallet);
    if (!u?.owedFees?.length) return;
    const feeWallet = this.feeWalletFor(venue);
    const router = u.engine.venues[venue]?.liveRouter;
    if (!feeWallet || !router?.transferSol) return;
    const keep = [];
    for (const owed of u.owedFees) {
      if (owed.venue !== venue) { keep.push(owed); continue; }
      try {
        const sig = await router.transferSol(feeWallet, owed.amount);
        u.engine.ledger.append({ kind: "fee", venue, quote: owed.quote, instrument: owed.instrument, scope: "platform", sol: owed.amount, usd: +(owed.amount * (u.engine.quotePriceOf(venue) || 0)).toFixed(4), venue_ref: sig, collected: true, note: `performance fee collected late (${owed.error})` });
        u.engine.log("info", `owed platform fee ${owed.amount} ${owed.quote} collected tx ${String(sig).slice(0, 10)}`);
      } catch (err) { keep.push({ ...owed, error: String(err?.shortMessage || err?.message || err).slice(0, 200) }); }
    }
    u.owedFees = keep;
    u.engine.store.save();
  }

  /** Does this user hold enough of the house token to trade free? Never throws.
   *  Read against their Solana wallet: $BNDLI is an SPL mint, and that pubkey is the account they
   *  signed in with, so every user has one whether or not they opted into Robinhood Chain. */
  async holderWaived(wallet) {
    if (!this.waiver.enabled || !wallet) return false;
    try { return await this.waiver.holds(wallet); } catch { return false; }
  }

  /** feePct of realized profit; nothing on a loss or dust; the owner pays nothing. The only other way
   *  to pay nothing is to hold the house token, which settleFee checks separately. No tiers. */
  flatFee(solIn, solOut, wallet) {
    const net = +(solOut - solIn).toFixed(6);
    if (net <= 0.001 || this.fee.isOwnerWallet?.(wallet)) return { fee: 0, net, rate: this.feePct };
    return { fee: +(net * this.feePct / 100).toFixed(6), net, rate: this.feePct, type: "profit-share" };
  }

  /**
   * Sell every token in the user's wallets to SOL / ETH, one by one: first every open position through
   * the engine (booked as USER_SWEEP), then anything else the wallets hold, straight through the routers.
   * Works whether or not the bot is running (routers are built from the keys when it is not).
   * A PONS token whose curve has graduated cannot be sold by the router and is reported as such.
   */
  /** The sweep as a background job: sixty tokens sold one by one take longer than any HTTP call may.
   *  Starts one if none is running; the report grows as it goes and status() shows it. */
  startSweep(wallet, opts = {}) {
    const cur = this._sweeps.get(wallet);
    if (cur && !cur.done) return { ok: true, started: false, sweep: this._sweepView(cur) };
    const job = { startedAt: Date.now(), done: false, finishedAt: null, chain: opts.chain || "all", report: [], total: null, error: null };
    this._sweeps.set(wallet, job);
    this.sweepWallet(wallet, { ...opts, job }).then(r => { job.total = r.report.length; }).catch(err => { job.error = err.message; }).finally(() => { job.done = true; job.finishedAt = Date.now(); });
    return { ok: true, started: true, sweep: this._sweepView(job) };
  }
  _sweepView(j) { return j ? { startedAt: j.startedAt, done: j.done, finishedAt: j.finishedAt, chain: j.chain, sold: j.report.filter(r => r.ok).length, failed: j.report.filter(r => !r.ok && !r.note).length, report: j.report, error: j.error, current: j.current || null } : null; }

  /** Every token the Robinhood Chain wallet holds and the curve each sells on, from three sources
   *  merged: the provider's balance index, the explorer, and the chain's own Transfer logs into the
   *  wallet (scanned in slices across calls, progress kept on disk, so a token no index lists and a
   *  curve no factory we know launched are still found: whoever sent us the token and answers token()
   *  with it is its curve). Rows: { instrument, qty, curve, graduated, via, state }. */
  async _rhInventory(wallet, ethRouter, rpc, { budgetMs = 15_000 } = {}) {
    const file = path.join(this.rootDir, wallet, "rh-scan.json");
    let scan = { scannedTo: null, tokens: {}, curves: {} };
    try { scan = { ...scan, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch {}
    const notes = [];
    // 1. the chain's logs, a slice at a time
    if (rpc?.transfersTo) {
      try {
        const head = await rpc.blockNumber();
        const back = Math.max(10_000, parseInt(process.env.PONS_SCAN_BLOCKS || "1500000") || 1_500_000);
        const from = scan.scannedTo == null ? Math.max(0, head - back) : scan.scannedTo + 1;
        if (from <= head) {
          const r = await rpc.transfersTo(ethRouter.address, { fromBlock: from, toBlock: head, budgetMs });
          for (const [t, senders] of r.tokens) scan.tokens[t] = [...new Set([...(scan.tokens[t] || []), ...senders])].slice(0, 12);
          scan.scannedTo = r.scannedTo; scan.head = head; scan.done = r.done;
          if (!r.done) notes.push(`chain history ${Math.round(((r.scannedTo - from) / Math.max(1, head - from)) * 100)}% scanned; more on the next refresh`);
        } else scan.done = true;
      } catch (err) { notes.push(`chain scan: ${err.message.slice(0, 80)}`); }
    }
    // 2. the indexes
    const held = new Map();
    try { for (const h of await rpc.walletTokens(ethRouter.address)) held.set(h.instrument.toLowerCase(), { ...h, instrument: h.instrument.toLowerCase() }); } catch (err) { notes.push(`listing: ${err.message.slice(0, 80)}`); }
    // 3. everything else we know of: the ledger, the scan
    const u = this.users.get(wallet);
    if (u) u.engine.seedRouterKnowledge("pons"); else for (const inst of this._instrumentsFromDisk(wallet, "pons")) ethRouter.track?.(inst);
    for (const t of Object.keys(scan.tokens)) ethRouter.track?.(t);
    for (const p of await ethRouter.positions()) if (!held.has(p.instrument.toLowerCase())) held.set(p.instrument.toLowerCase(), { instrument: p.instrument.toLowerCase(), qty: p.qty });
    // the curve for each, remembered
    const rows = [];
    for (const h of held.values()) {
      if (!(h.qty >= 1)) continue;
      let c = scan.curves[h.instrument] || null;
      if (!c || c.graduated === false) { try { const f = await rpc.curveFor(h.instrument, scan.tokens[h.instrument] || []); if (f) c = f; } catch {} }
      if (c) scan.curves[h.instrument] = c;
      rows.push({ ...h, curve: c?.curve || null, graduated: !!c?.graduated, via: c?.via || null, state: !c ? "not a curve token" : c.graduated ? "graduated" : "curve" });
    }
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(scan)); } catch {}
    return { rows, notes, scan: { done: !!scan.done, scannedTo: scan.scannedTo, head: scan.head ?? null } };
  }

  /** Every token both wallets hold, with what is known about each: name, curve state, what a sell
   *  would fetch. Works with the bot stopped (routers built from the keys). Cached 20 seconds. */
  async listHoldings(wallet, { secret = null, evmSecret = null } = {}) {
    const cached = this._holdingsCache.get(wallet);
    if (cached && Date.now() - cached.at < 20_000) return cached.data;
    const u = this.users.get(wallet);
    const out = { at: Date.now(), sol: [], eth: [], usdc: [], errors: [] };
    const open = new Map(u ? u.engine.store.openPositions().map(p => [p.venue + ":" + p.instrument.toLowerCase(), p]) : []);
    const solRouter = u?.engine.venues.pumpfun?.liveRouter || (secret ? this.makeLiveRouter({ secret, wallet }) : null);
    if (solRouter) {
      try {
        if (!solRouter.ready) await solRouter.init();
        const solPrice = this.feed?.solPrice || 0;
        for (const h of await solRouter.positions()) {
          if (!(h.qty >= 1)) continue;
          const t = this.feed?.tokens?.get?.(h.instrument) || null, p = open.get("pumpfun:" + h.instrument.toLowerCase());
          const valueUsd = t?.mcapUsd > 0 ? +(h.qty / 1e9 * t.mcapUsd).toFixed(2) : null;
          out.sol.push({ venue: "pumpfun", instrument: h.instrument, qty: h.qty, name: t?.name || p?.reference?.name || "", ticker: t?.ticker || p?.reference?.ticker || "", state: t?.graduated ? "graduated" : t ? "curve" : "unknown", valueUsd, tracked: !!p, positionId: p?.id || null, url: `https://pump.fun/coin/${h.instrument}` });
        }
      } catch (err) { out.errors.push(`solana: ${err.message}`); }
    }
    const ethRouter = u?.engine.venues.pons?.liveRouter || (evmSecret ? this.makePonsRouter({ secret: evmSecret, wallet }) : null);
    const rpc = this.ponsFeed?.rpc;
    if (ethRouter && rpc) {
      try {
        if (!ethRouter.ready) await ethRouter.init();
        const ethPrice = this.ponsFeed?.solPrice || 0;
        const inv = await this._rhInventory(wallet, ethRouter, rpc);
        out.errors.push(...inv.notes); out.scan = inv.scan;
        const { curveSellQuote, mcapQuote, curveProgress } = await import("./venues/pons/chain.mjs");
        for (const h of inv.rows) {
          const inst = h.instrument, p = open.get("pons:" + inst), feedTok = this.ponsFeed?.tokens?.get(inst);
          const row = { venue: "pons", instrument: inst, qty: h.qty, name: feedTok?.name || p?.reference?.name || h.name || "", ticker: feedTok?.ticker || p?.reference?.ticker || h.symbol || "", state: h.state, curve: h.curve, via: h.via, valueUsd: null, tracked: !!p, positionId: p?.id || null, url: (process.env.PONS_TOKEN_URL || "https://www.ponsfamily.com/launchpad/{ca}").replace("{ca}", inst), explorer: `https://robinhoodchain.blockscout.com/token/${inst}` };
          try {
            if (!row.name && rpc.tokenMeta) { const m = await rpc.tokenMeta(inst); row.name = m.name || ""; row.ticker = m.symbol || ""; }
            if (h.state === "curve") {
              const ci = await rpc.curveInfo(h.curve);
              row.curvePct = +curveProgress(ci.realQuoteReserve, ci.graduationThreshold).toFixed(3);
              row.mcapUsd = Math.round(mcapQuote(ci) * ethPrice);
              const q = curveSellQuote(ci, h.qty, ci.feeBps + ci.creatorTaxBps);
              row.sellEth = +q.quoteOut.toFixed(6); row.valueUsd = +(q.quoteOut * ethPrice).toFixed(2);
            }
          } catch (err) { row.note = err.message.slice(0, 80); }
          out.eth.push(row);
        }
      } catch (err) { out.errors.push(`robinhood: ${err.message}`); }
    }
    // Arc: the tokens this process was told about (an EVM wallet has no account list to walk), valued
    // off the feed when it still has the pool. Only when Arc is on for the site at all.
    const arcRouter = u?.engine.venues.arc?.liveRouter || (evmSecret && this.arcFeed ? this.makeArcRouter({ secret: evmSecret, wallet }) : null);
    if (arcRouter) {
      try {
        if (!arcRouter.ready) await arcRouter.init();
        if (u) u.engine.seedRouterKnowledge("arc"); else for (const inst of this._instrumentsFromDisk(wallet, "arc")) arcRouter.track?.(inst);
        for (const h of await arcRouter.positions()) {
          if (!(h.qty >= 1)) continue;
          const inst = String(h.instrument).toLowerCase(), t = this.arcFeed?.tokens?.get(inst) || null, p = open.get("arc:" + inst);
          out.usdc.push({ venue: "arc", instrument: inst, qty: h.qty, name: t?.name || p?.reference?.name || "", ticker: t?.ticker || p?.reference?.ticker || "", state: t ? (t.bonded ? "bonded" : "curve") : "unknown", valueUsd: t?.mcapUsd > 0 ? +(h.qty / 1e9 * t.mcapUsd).toFixed(2) : null, tracked: !!p, positionId: p?.id || null, url: (process.env.ARC_TOKEN_URL || "https://explorer.arc.io/token/{ca}").replace("{ca}", inst), explorer: `https://explorer.arc.io/token/${inst}` });
        }
      } catch (err) { out.errors.push(`arc: ${err.message}`); }
    }
    this._holdingsCache.set(wallet, { at: Date.now(), data: out });
    return out;
  }

  /** Sell one token the wallet holds, tracked or not, straight through the router. */
  async sellHolding(wallet, { venue, instrument, pct = 100, secret = null, evmSecret = null }) {
    const u = this.users.get(wallet);
    const inst = venue === "pons" || venue === "arc" ? String(instrument).toLowerCase() : String(instrument);
    const open = u?.engine.store.openPositions(venue).find(p => p.instrument === inst || p.instrument.toLowerCase() === inst.toLowerCase());
    if (open) return this.closePosition(wallet, open.id, pct);
    const router = venue === "pons" ? (u?.engine.venues.pons?.liveRouter || (evmSecret ? this.makePonsRouter({ secret: evmSecret, wallet }) : null))
      : venue === "arc" ? (u?.engine.venues.arc?.liveRouter || (evmSecret ? this.makeArcRouter({ secret: evmSecret, wallet }) : null))
      : (u?.engine.venues.pumpfun?.liveRouter || (secret ? this.makeLiveRouter({ secret, wallet }) : null));
    if (!router) return { ok: false, error: venue === "pons" ? "no Robinhood Chain wallet" : venue === "arc" ? "no Arc wallet" : "no Solana wallet" };
    if (!router.ready) await router.init();
    const price = venue === "pons" ? (this.ponsFeed?.solPrice || 0) : venue === "arc" ? 1 : (this.feed?.solPrice || 0);
    let curve = null;
    if (venue === "pons") { try { const scan = JSON.parse(fs.readFileSync(path.join(this.rootDir, wallet, "rh-scan.json"), "utf8")); const c = scan.curves?.[inst]; if (c?.curve && !c.graduated) curve = c.curve; if (!curve && this.ponsFeed?.rpc?.curveFor) { const f = await this.ponsFeed.rpc.curveFor(inst, scan.tokens?.[inst] || []); if (f && !f.graduated) curve = f.curve; } } catch {} }
    const r = await router.close({ id: `sell:${inst}`, instrument: inst, curve }, pct, { reference: { solPrice: price, curve: curve ? { address: curve } : undefined } });
    u?.engine.log("info", `sell ${inst.slice(0, 10)} (${venue}): ${r?.ok ? `sold for ${(r.fill.sol_received ?? 0).toFixed(venue === "pons" ? 5 : 4)} ${QUOTE_OF[venue] || "SOL"}` : `${r?.failure?.code || ""} ${r?.failure?.reason || "failed"}`}`);
    this._holdingsCache.delete(wallet);
    if (u) { try { await u.engine.refreshWallet(); } catch {} }
    return r?.ok ? { ok: true, received: r.fill.sol_received ?? null, proceeds_usd: r.fill.notional_usd ?? null } : { ok: false, error: r?.failure?.reason || "sell failed", code: r?.failure?.code || null };
  }

  async sweepWallet(wallet, { secret, evmSecret = null, chain = "all", explorer = null, job = null } = {}) {
    const u = this.users.get(wallet);
    const report = job ? job.report : [];
    const at = (venue, inst) => { if (job) job.current = { venue, instrument: inst, at: Date.now() }; };
    const note = (venue, instrument, r, extra = {}) => report.push({ venue, instrument, ok: !!r?.ok, proceeds_usd: r?.fill?.notional_usd ?? null, received: r?.fill?.sol_received ?? null, error: r?.ok ? null : (r?.failure?.reason || "failed"), code: r?.ok ? null : (r?.failure?.code || null), ...extra });
    const doSol = chain === "all" || chain === "sol" || chain === "pumpfun", doEth = (chain === "all" || chain === "eth" || chain === "pons" || chain === "rh") && !!(u?.engine.venues.pons || evmSecret);
    const doUsdc = (chain === "all" || chain === "usdc" || chain === "arc") && !!(u?.engine.venues.arc || (evmSecret && this.arcFeed));
    // 1. open positions, through the engine, so the ledger and P&L see them
    if (u) for (const venue of ["pumpfun", "pons", "arc"]) {
      if ((venue === "pumpfun" && !doSol) || (venue === "pons" && !doEth) || (venue === "arc" && !doUsdc) || !u.engine.venues[venue]) continue;
      for (const p of u.engine.store.openPositions(venue)) { at(venue, p.instrument); const r = await u.engine.enqueue(() => u.engine.closePosition(p, 100, "USER_SWEEP", { by: "user", detail: "wallet sweep" })); note(venue, p.instrument, r, { position: p.id }); }
    }
    // 2. whatever else the wallets hold, through the routers
    const solRouter = u?.engine.venues.pumpfun?.liveRouter || (secret ? this.makeLiveRouter({ secret, wallet }) : null);
    const ethRouter = u?.engine.venues.pons?.liveRouter || (evmSecret ? this.makePonsRouter({ secret: evmSecret, wallet }) : null);
    if (doSol && solRouter) {
      try {
        if (!solRouter.ready) await solRouter.init();
        const solPrice = this.feed?.solPrice || 0;
        for (const h of await solRouter.positions()) {
          if (!(h.qty >= 1)) continue;
          if (report.some(x => x.instrument === h.instrument && x.ok)) continue; // sold above as an open position
          at("pumpfun", h.instrument);
          const r = await solRouter.close({ id: `sweep:${h.instrument}`, instrument: h.instrument }, 100, { reference: { solPrice } });
          note("pumpfun", h.instrument, r, { qty: h.qty });
          u?.engine.log("info", `sweep ${h.instrument.slice(0, 8)}: ${r?.ok ? `sold ${h.qty} tokens for ${(r.fill.sol_received ?? 0).toFixed(4)} SOL` : r?.failure?.reason}`);
        }
      } catch (err) { report.push({ venue: "pumpfun", instrument: null, ok: false, error: err.message }); }
    }
    if (doEth && ethRouter) {
      try {
        if (!ethRouter.ready) await ethRouter.init();
        const rpc = this.ponsFeed?.rpc || explorer;
        const ethPrice = this.ponsFeed?.solPrice || 0;
        const inv = await this._rhInventory(wallet, ethRouter, rpc, { budgetMs: 30_000 });
        for (const n of inv.notes) report.push({ venue: "pons", instrument: null, ok: false, error: n, note: true });
        for (const h of inv.rows) {
          if (!(h.qty >= 1)) continue;
          if (report.some(x => x.instrument === h.instrument && x.ok)) continue; // sold above as an open position
          at("pons", h.instrument);
          if (!h.curve) { report.push({ venue: "pons", instrument: h.instrument, ok: false, qty: h.qty, error: "no curve found for it (not a launch, or an airdrop); see the explorer" }); continue; }
          if (h.graduated) { report.push({ venue: "pons", instrument: h.instrument, ok: false, qty: h.qty, code: "GRADUATED", error: "curve graduated to the pool; sell by hand on PONS" }); continue; }
          let ci = {}; try { ci = rpc?.curveInfo ? await rpc.curveInfo(h.curve) : {}; } catch {}
          const r = await ethRouter.close({ id: `sweep:${h.instrument}`, instrument: h.instrument, curve: h.curve }, 100, { reference: { solPrice: ethPrice, curve: { address: h.curve, ...ci } } });
          note("pons", h.instrument, r, { qty: h.qty });
          u?.engine.log("info", `sweep ${h.instrument.slice(0, 10)}: ${r?.ok ? `sold ${h.qty} tokens for ${(r.fill.sol_received ?? 0).toFixed(5)} ETH` : r?.failure?.reason}`);
        }
      } catch (err) { report.push({ venue: "pons", instrument: null, ok: false, error: err.message }); }
    }
    // Arc: whatever else the wallet holds of the tokens this process knows, sold through the pool.
    const arcRouter = u?.engine.venues.arc?.liveRouter || (evmSecret && this.arcFeed ? this.makeArcRouter({ secret: evmSecret, wallet }) : null);
    if (doUsdc && arcRouter) {
      try {
        if (!arcRouter.ready) await arcRouter.init();
        if (u) u.engine.seedRouterKnowledge("arc"); else for (const inst of this._instrumentsFromDisk(wallet, "arc")) arcRouter.track?.(inst);
        for (const h of await arcRouter.positions()) {
          if (!(h.qty >= 1)) continue;
          if (report.some(x => x.instrument === h.instrument && x.ok)) continue; // sold above as an open position
          at("arc", h.instrument);
          const r = await arcRouter.close({ id: `sweep:${h.instrument}`, instrument: h.instrument }, 100, { reference: { solPrice: 1 } });
          note("arc", h.instrument, r, { qty: h.qty });
          u?.engine.log("info", `sweep ${h.instrument.slice(0, 10)}: ${r?.ok ? `sold ${h.qty} tokens for ${(r.fill.sol_received ?? 0).toFixed(2)} USDC` : r?.failure?.reason}`);
        }
      } catch (err) { report.push({ venue: "arc", instrument: null, ok: false, error: err.message }); }
    }
    if (job) job.current = null;
    this._holdingsCache.delete(wallet);
    if (u) { try { await u.engine.refreshWallet(); } catch {} }
    return { ok: true, sold: report.filter(r => r.ok).length, failed: report.filter(r => !r.ok && !r.note).length, report };
  }

  /** Every instrument a stopped user's ledger says this wallet bought on a venue, read from disk. */
  _instrumentsFromDisk(wallet, venue) {
    const out = new Set();
    try {
      const file = path.join(this.rootDir, wallet, "ledger.jsonl");
      if (!fs.existsSync(file)) return [];
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.includes(`"${venue}"`)) continue;
        try { const r = JSON.parse(line); if (r.venue === venue && r.instrument && (r.kind === "fill" || (r.kind === "order" && r.stage === "sent"))) out.add(String(r.instrument).toLowerCase()); } catch {}
      }
    } catch {}
    return [...out];
  }

  async stopAll() { for (const w of this.list()) { try { await this.stop(w, { flatten: false }); } catch {} } }
}

/** Express routes. deps: { hub, requireOwner, getTradingWallet } */
export function mountVelocityRoutes(app, { hub, requireOwner, getTradingWallet }) {
  // Anyone with a trading wallet can run the bot: the fee on profit is the only price of admission.
  app.post("/api/velocity/start", requireOwner, async (req, res) => {
    try {
      const { wallet, settings } = req.body || {};
      const tw = await getTradingWallet(wallet);
      if (!tw?.secret) return res.status(400).json({ error: "No trading wallet; create one first" });
      res.json(await hub.start({ wallet, secret: tw.secret, evmSecret: tw.evmSecret || null, settings: settings || {} }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/api/velocity/stop", requireOwner, async (req, res) => { try { res.json(await hub.stop(req.body.wallet)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post("/api/velocity/pause", requireOwner, async (req, res) => { try { res.json(await hub.pause(req.body.wallet)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post("/api/velocity/resume", requireOwner, (req, res) => { try { res.json(hub.resume(req.body.wallet)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post("/api/velocity/sweep", requireOwner, async (req, res) => {
    try {
      const { wallet, chain } = req.body || {};
      const tw = await getTradingWallet(wallet);
      if (!tw?.secret) return res.status(400).json({ error: "No trading wallet" });
      res.json(hub.startSweep(wallet, { secret: tw.secret, evmSecret: tw.evmSecret || null, chain: chain || "all" }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get("/api/velocity/holdings", requireOwner, async (req, res) => {
    try {
      const wallet = req.query.wallet; const tw = await getTradingWallet(wallet);
      if (!tw?.secret) return res.status(400).json({ error: "No trading wallet" });
      res.json({ ok: true, holdings: await hub.listHoldings(wallet, { secret: tw.secret, evmSecret: tw.evmSecret || null }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get("/api/velocity/sweep", requireOwner, (req, res) => res.json({ ok: true, sweep: hub._sweepView(hub._sweeps.get(req.query.wallet)) }));
  app.post("/api/velocity/sell", requireOwner, async (req, res) => {
    try {
      const { wallet, venue, instrument, pct } = req.body || {};
      if (!instrument || !["pons", "pumpfun", "arc"].includes(venue)) return res.status(400).json({ error: "venue (pons|pumpfun|arc) and instrument required" });
      const tw = await getTradingWallet(wallet);
      if (!tw?.secret) return res.status(400).json({ error: "No trading wallet" });
      res.json(await hub.sellHolding(wallet, { venue, instrument, pct: Number(pct) || 100, secret: tw.secret, evmSecret: tw.evmSecret || null }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/api/velocity/close", requireOwner, async (req, res) => { try { res.json(await hub.closePosition(req.body.wallet, req.body.positionId, req.body.pct)); } catch (e) { res.status(500).json({ error: e.message }); } });
  // Give up on a position that cannot be sold: it leaves the book, the tokens stay in the wallet.
  app.post("/api/velocity/release", requireOwner, async (req, res) => { try { res.json(await hub.release(req.body.wallet, req.body.positionId, req.body.note || null)); } catch (e) { res.status(500).json({ error: e.message }); } });
  // Dismiss a stale "sell failed" banner without touching the position.
  app.post("/api/velocity/clear-error", requireOwner, async (req, res) => { try { res.json(await hub.clearExitError(req.body.wallet, req.body.positionId)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post("/api/velocity/ack-daily-limit", requireOwner, async (req, res) => { try { res.json(await hub.acknowledgeDailyLimit(req.body.wallet)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post("/api/velocity/halt", requireOwner, async (req, res) => { try { res.json(await hub.halt(req.body.wallet, req.body.mode === "freeze" ? "freeze" : "flatten")); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.get("/api/velocity/status", requireOwner, (req, res) => res.json({ ok: true, ...hub.status(req.query.wallet), narration: hub.narration(req.query.wallet, 40) }));
  // The health route is public, so a feed's error text stays out of it: an RPC error can quote the
  // request URL, key and all.
  const pub = s => { const { lastError, lastHydrateError, ...rest } = s || {}; return rest; };
  app.get("/api/velocity/pulse", (req, res) => { res.set("Cache-Control", "public, max-age=10"); res.json({ ok: true, ...hub.pulse() }); });
  // The public track record. Rows carry the token, the tx and the result; never a wallet or a user.
  app.get("/api/callouts", (req, res) => {
    res.set("Cache-Control", "public, max-age=10");
    const limit = Math.max(1, Math.min(200, parseInt(req.query?.limit) || 50));
    const s = hub.callouts.status();
    res.json({ ok: true, calls: hub.callouts.feed(limit), record: hub.callouts.record(), channels: s.channels, minTier: s.minTier });
  });
  app.get("/api/velocity/health", (req, res) => res.json({ ok: true, users: hub.list().length, feeConfigured: hub.feeOk, feed: pub(hub.feed.status?.()), pons: hub.ponsFeed ? { ...pub(hub.ponsFeed.status?.()), tokens: hub.ponsFeed.tokens?.size ?? null, ethPrice: hub.ponsFeed.solPrice, feeConfigured: !!hub.platformEvmWallet } : null, arc: hub.arcFeed ? { ...pub(hub.arcFeed.status?.()), tokens: hub.arcFeed.tokens?.size ?? null, feeConfigured: !!hub.platformEvmWallet } : null, callouts: hub.callouts.record() }));
}
