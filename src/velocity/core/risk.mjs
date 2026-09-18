// ═══ VELOCITY — Risk envelope and sizer (DP3) ═══
// The envelope is read once, validated, deep-frozen, and never written by the
// process. The sizer turns a GO decision into a stake that cannot breach any
// cap even if every open position hits its worst case at the same time.
// The governor's throttle arrives as an input and can only shrink the stake.

import fs from "node:fs";

export const VENUE_KEYS = Object.freeze(["pumpfun", "pons", "arc", "polymarket", "perps"]);

export function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const num = (v) => typeof v === "number" && Number.isFinite(v);

export function validateRisk(cfg) {
  const errors = [];
  const req = (path, cond, msg) => { if (!cond) errors.push(`${path}: ${msg}`); };
  if (!cfg || typeof cfg !== "object") return { ok: false, errors: ["risk file is not an object"], summary: null };

  req("bankroll_usd", num(cfg.bankroll_usd) && cfg.bankroll_usd > 0, "must be a positive number");
  // "wallet": the live wallet's free SOL is the bankroll; bankroll_usd stays the paper bankroll.
  req("bankroll_source", cfg.bankroll_source == null || ["fixed", "wallet"].includes(cfg.bankroll_source), "must be \"fixed\" or \"wallet\"");
  req("wallet_reserve_sol", cfg.wallet_reserve_sol == null || (num(cfg.wallet_reserve_sol) && cfg.wallet_reserve_sol >= 0), "must be a number >= 0 (SOL kept back for fees and rent)");
  req("per_trade_max_usd", num(cfg.per_trade_max_usd) && cfg.per_trade_max_usd > 0, "must be a positive number");
  req("portfolio_max_exposure_usd", num(cfg.portfolio_max_exposure_usd) && cfg.portfolio_max_exposure_usd > 0, "must be a positive number");
  req("daily_loss_limit_usd", num(cfg.daily_loss_limit_usd) && cfg.daily_loss_limit_usd > 0, "must be a positive number");
  req("max_concurrent_positions", Number.isInteger(cfg.max_concurrent_positions) && cfg.max_concurrent_positions >= 1, "must be an integer >= 1");
  req("max_per_group", Number.isInteger(cfg.max_per_group) && cfg.max_per_group >= 1, "must be an integer >= 1");
  if (num(cfg.per_trade_max_usd) && num(cfg.portfolio_max_exposure_usd))
    req("per_trade_max_usd", cfg.per_trade_max_usd <= cfg.portfolio_max_exposure_usd, "cannot exceed portfolio_max_exposure_usd");
  if (num(cfg.daily_loss_limit_usd) && num(cfg.bankroll_usd))
    req("daily_loss_limit_usd", cfg.daily_loss_limit_usd <= cfg.bankroll_usd, "cannot exceed bankroll_usd");
  if (num(cfg.portfolio_max_exposure_usd) && num(cfg.bankroll_usd))
    req("portfolio_max_exposure_usd", cfg.portfolio_max_exposure_usd <= cfg.bankroll_usd, "cannot exceed bankroll_usd");

  req("venues", cfg.venues && typeof cfg.venues === "object", "must be an object");
  for (const v of VENUE_KEYS) {
    const vc = cfg.venues?.[v];
    const p = `venues.${v}`;
    if (!vc) { errors.push(`${p}: missing (set max_exposure_usd to 0 to disable)`); continue; }
    req(`${p}.max_exposure_usd`, num(vc.max_exposure_usd) && vc.max_exposure_usd >= 0, "must be a number >= 0");
    if (num(vc.max_exposure_usd) && num(cfg.portfolio_max_exposure_usd))
      req(`${p}.max_exposure_usd`, vc.max_exposure_usd <= cfg.portfolio_max_exposure_usd, "cannot exceed portfolio_max_exposure_usd");
    req(`${p}.max_concurrent`, Number.isInteger(vc.max_concurrent) && vc.max_concurrent >= 0, "must be an integer >= 0");
    if (num(vc.max_exposure_usd) && vc.max_exposure_usd > 0)
      req(`${p}.max_concurrent`, vc.max_concurrent >= 1, "must be >= 1 when the venue has exposure");
    req(`${p}.kelly_fraction`, num(vc.kelly_fraction) && vc.kelly_fraction > 0 && vc.kelly_fraction <= 0.5, "must be in (0, 0.5]");
    req(`${p}.min_stake_usd`, num(vc.min_stake_usd) && vc.min_stake_usd >= 0, "must be a number >= 0");
    req(`${p}.worst_case_fraction`, num(vc.worst_case_fraction) && vc.worst_case_fraction > 0 && vc.worst_case_fraction <= 1, "must be in (0, 1]");
    req(`${p}.max_slippage_bps`, Number.isInteger(vc.max_slippage_bps) && vc.max_slippage_bps >= 0 && vc.max_slippage_bps <= 5000, "must be an integer in [0, 5000]");
    const lb = vc.latency_budget_ms;
    req(`${p}.latency_budget_ms`, lb && ["observe", "decide", "send", "confirm"].every(k => num(lb[k]) && lb[k] > 0), "needs observe, decide, send, confirm in ms");
  }
  const pr = cfg.promotion || {};
  req("promotion.confidence", num(pr.confidence) && pr.confidence >= 0.5 && pr.confidence < 1, "must be in [0.5, 1)");
  req("promotion.live_start_fraction", num(pr.live_start_fraction) && pr.live_start_fraction > 0 && pr.live_start_fraction <= 1, "must be in (0, 1]");
  req("promotion.min_paper_trades", pr.min_paper_trades && VENUE_KEYS.every(v => Number.isInteger(pr.min_paper_trades[v]) && pr.min_paper_trades[v] >= 1), "needs an integer >= 1 per venue");

  return { ok: errors.length === 0, errors, summary: errors.length ? null : worstDay(cfg) };
}

/** What the operator is agreeing to: the most that can be lost in one day and at once. */
export function worstDay(cfg) {
  const venues = {};
  for (const v of VENUE_KEYS) {
    const vc = cfg.venues[v];
    venues[v] = { max_exposure_usd: vc.max_exposure_usd, worst_case_usd: +(vc.max_exposure_usd * vc.worst_case_fraction).toFixed(2), enabled: vc.max_exposure_usd > 0 };
  }
  return {
    bankroll_usd: cfg.bankroll_usd,
    bankroll_source: cfg.bankroll_source || "fixed",
    daily_loss_limit_usd: cfg.daily_loss_limit_usd,
    daily_loss_pct_of_bankroll: +((cfg.daily_loss_limit_usd / cfg.bankroll_usd) * 100).toFixed(2),
    max_open_exposure_usd: cfg.portfolio_max_exposure_usd,
    max_single_stake_usd: cfg.per_trade_max_usd,
    venues,
  };
}

export function loadRiskEnvelope(file) {
  if (!fs.existsSync(file)) throw new Error(`risk file not found: ${file}. Copy src/velocity/config/risk.example.json to ${file} and edit it.`);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) { throw new Error(`risk file ${file} is not valid JSON: ${err.message}`); }
  const v = validateRisk(cfg);
  if (!v.ok) throw new Error(`risk file ${file} rejected:\n  - ${v.errors.join("\n  - ")}`);
  return deepFreeze(cfg);
}

export function kellyFraction(p_win, payoff) {
  if (!(payoff > 0)) return 0;
  return Math.max(0, (p_win * payoff - (1 - p_win)) / payoff);
}

export class Sizer {
  constructor(envelope) {
    if (!Object.isFrozen(envelope)) throw new Error("sizer requires a frozen risk envelope (use loadRiskEnvelope)");
    this.env = envelope;
  }

  /**
   * @param decision  GO decision from DP2: p_win, payoff, venue, group, stop_fraction
   * @param portfolio { open: [{venue, group, notional_usd, worst_case_fraction}], realized_today_usd,
   *                    equity_usd?: number|null, equity_reason?: string }
   *                  equity_usd, when present, is the measured bankroll (wallet mode): free wallet
   *                  value plus what is open. A null with a reason means no order can be sized.
   * @param throttle  governor output in [0,1]; only ever shrinks
   */
  size({ decision, portfolio, throttle = 1, halted = false }) {
    const env = this.env;
    const venue = decision.venue;
    const vc = env.venues[venue];
    const reasons = [];
    const caps = [];
    const zero = (why) => ({ stake_usd: 0, worst_case_usd: 0, reasons: [why, ...reasons], caps, kelly: null });

    if (halted) return zero("HALTED");
    if (!vc || !(vc.max_exposure_usd > 0)) return zero("VENUE_DISABLED");
    const t = Math.min(1, Math.max(0, Number(throttle) || 0));
    if (t === 0) return zero("THROTTLE_ZERO");

    const open = portfolio?.open || [];
    const realized = Number(portfolio?.realized_today_usd) || 0;
    const totalOpen = open.reduce((s, p) => s + (p.notional_usd || 0), 0);
    const venueOpen = open.filter(p => p.venue === venue).reduce((s, p) => s + (p.notional_usd || 0), 0);
    const openRisk = open.reduce((s, p) => s + (p.notional_usd || 0) * (p.worst_case_fraction ?? env.venues[p.venue]?.worst_case_fraction ?? 1), 0);

    // Concurrency and group caps are yes/no.
    if (open.length >= env.max_concurrent_positions) return zero("MAX_CONCURRENT");
    if (open.filter(p => p.venue === venue).length >= vc.max_concurrent) return zero("VENUE_MAX_CONCURRENT");
    if (decision.group && open.filter(p => p.group === decision.group).length >= env.max_per_group) return zero("MAX_PER_GROUP");

    // Edge.
    const f_full = kellyFraction(decision.p_win, decision.payoff);
    if (f_full <= 0) return zero("NO_EDGE");
    const f_used = f_full * vc.kelly_fraction * t;
    let equity;
    if (portfolio && "equity_usd" in portfolio) {
      if (!(portfolio.equity_usd > 0)) return zero(portfolio.equity_reason || "WALLET_UNKNOWN");
      equity = portfolio.equity_usd; // measured: the wallet already reflects today's realized PnL
    } else equity = env.bankroll_usd + realized;
    const available = Math.max(0, equity - totalOpen);
    let stake = available * f_used;
    reasons.push(`kelly f=${f_full.toFixed(4)} x ${vc.kelly_fraction} x throttle ${t.toFixed(2)} on ${available.toFixed(2)} available${portfolio && "equity_usd" in portfolio ? " (wallet)" : ""}`);

    const cap = (name, limit) => { if (stake > limit) { stake = Math.max(0, limit); caps.push(name); } };
    cap("PER_TRADE_MAX", env.per_trade_max_usd);
    // A model may cap itself below the envelope (a revival takes half of what a launch may).
    if (decision.stake_cap_fraction > 0 && decision.stake_cap_fraction < 1) cap("MODEL_CAP", env.per_trade_max_usd * decision.stake_cap_fraction);
    cap("VENUE_EXPOSURE", vc.max_exposure_usd - venueOpen);
    cap("PORTFOLIO_EXPOSURE", env.portfolio_max_exposure_usd - totalOpen);

    // Daily loss budget: what could still be lost today if everything open hits its worst case.
    const stop = Math.max(Number(decision.stop_fraction) || 0, vc.worst_case_fraction);
    const budget = env.daily_loss_limit_usd - Math.max(0, -realized) - openRisk;
    if (budget <= 0) return zero("DAILY_BUDGET_EXHAUSTED");
    cap("DAILY_LOSS_BUDGET", budget / stop);

    stake = Math.floor(stake * 100) / 100;
    if (stake > 0 && stake < vc.min_stake_usd) {
      // A small bankroll: fractional Kelly lands under the venue's minimum viable order. Trade the
      // minimum when every cap still admits it.
      //
      // This used to require throttle >= 0.5, reading a harder cut as "do not trade". That turned
      // the governor's own words -- "sizes cut to a quarter", entries still happen -- into no
      // entries at all, and made it permanent: a throttle of 0.25 refused every order, no orders
      // meant no outcomes, no outcomes meant the win rate that caused the throttle never moved. A
      // real account sat at 286 GO decisions and 0 fills with nothing in the log but
      // BELOW_MIN_STAKE. A governor that can only ever tighten is not a governor.
      //
      // So the throttle is honoured where it still can be. Size cannot go below one order, but the
      // NUMBER of orders can: at a quarter throttle the bot holds a quarter of the slots. Exposure
      // falls by the same factor the governor asked for, and trading continues, which is the only
      // way the statistics that lift the throttle ever arrive.
      const room = Math.min(env.per_trade_max_usd, vc.max_exposure_usd - venueOpen, env.portfolio_max_exposure_usd - totalOpen, budget / stop);
      if (vc.min_stake_usd <= room) {
        if (t < 1) {
          const slots = Math.max(1, Math.round(env.max_concurrent_positions * t));
          if (open.length >= slots) return zero(`THROTTLED_TO_${slots}_OF_${env.max_concurrent_positions}_SLOTS`);
        }
        // The envelope's caps are in `room`; the MODEL's own cap deliberately is not. A model asking
        // for 40% of the maximum on a small account can ask for less than the venue's minimum order,
        // and there is no such order -- so the choice is the minimum or nothing, and for a probe,
        // whose whole purpose is to buy an outcome to learn from, nothing means never learning. The
        // floor takes it, and says so, rather than the cap silently deciding not to trade.
        const modelCap = decision.stake_cap_fraction > 0 && decision.stake_cap_fraction < 1
          ? env.per_trade_max_usd * decision.stake_cap_fraction : Infinity;
        stake = vc.min_stake_usd;
        caps.push("MIN_STAKE_FLOOR");
        if (vc.min_stake_usd > modelCap) caps.push("MIN_STAKE_OVER_MODEL_CAP");
      }
    }
    if (stake < vc.min_stake_usd) return zero(`BELOW_MIN_STAKE_${vc.min_stake_usd}`);
    return {
      stake_usd: stake,
      worst_case_usd: +(stake * stop).toFixed(2),
      stop_fraction: stop,
      reasons,
      caps,
      kelly: { f_full: +f_full.toFixed(6), fraction: vc.kelly_fraction, throttle: t, f_used: +f_used.toFixed(6) },
      budget_remaining_usd: +(budget - stake * stop).toFixed(2),
    };
  }
}
