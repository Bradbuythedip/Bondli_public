// ═══ VELOCITY — pump.fun edge model (DP2 plugin) ═══
// Wraps bondli's five-gate auto-ape pipeline as kill gates. Gate 4 (portfolio)
// is deliberately absent: caps belong to the risk envelope (DP3), not here.

import { checkDisqualifiers } from "../../../autoape/gates/disqualifiers.js";
import { checkViability } from "../../../autoape/gates/viability.js";
import { classifyConfidence } from "../../../autoape/gates/confidence.js";
import { checkExecutionWindow } from "../../../autoape/gates/execution-window.js";
import { planFor } from "../../core/plans.mjs";
import { DEFAULT_WEIGHTS, scoreFeatures } from "../../core/learner.mjs";

/** Normalized 0..1 features the learnable ranking weights read. Kill gates never see these. */
export function waveLeaderOf(w) {
  if (!w || !(w.copies > 0)) return null;
  const size = Math.min(1, w.copies / 4);
  return +(size * (w.rising ? 1 : w.fading ? 0.25 : 0.7)).toFixed(3);
}

export function pumpfunFeatures(c) {
  const clamp01 = v => Math.min(1, Math.max(0, Number(v) || 0));
  const opt = v => (v == null || Number.isNaN(Number(v)) ? null : clamp01(v)); // absent enrichment is null, never 0
  return {
    apeScore: clamp01((Number(c.scores.apeScore) || 0) / 100),
    memeticQuick: opt(c.token._memeticQuick),
    survivorMatch: c.token._survivorMatch == null ? null : clamp01(Number(c.token._survivorMatch) / 100),
    chartHealth: opt(c.qf?.ch_healthScore),
    whaleBullish: opt(c.qf?._whaleBullish),
    walletAge: opt(c.qf?.rg_walletAgeScore),
    freshWalletRatio: opt(c.qf?._rg_freshWalletRatio),
    // Measured smart money in the first minute: proven wallets only, exclusions applied upstream.
    smartMoney: opt(c.qf?._smartMoney?.score),
    // The original of a copied name, scored by how big the wave is and which way it is going. Four
    // copies saturate it; a wave still building counts in full, a steady one for most, a fading one
    // for little. No wave at all is MISSING, so a token nobody copied is not marked down for it.
    waveLeader: waveLeaderOf(c.qf?._wave),
  };
}

// Priors until the ledger has enough realized outcomes for the tier. Every tier must clear the EV
// gate after ~5% costs on priors alone, or the tier can never trade and never earn the outcomes
// that would replace the prior: the old tier-3 prior (0.25 x 3.0) had EV -0.05 after costs, which
// silently refused every speculative entry.
export const PUMPFUN_PRIORS = Object.freeze({
  // loss_fraction is the tier's designed stop loss: how much of the stake one average loss costs,
  // and therefore the unit that `payoff` is measured in. See stats.mjs.
  1: Object.freeze({ p_win: 0.45, payoff: 3.0, loss_fraction: 0.15 }),
  2: Object.freeze({ p_win: 0.35, payoff: 3.0, loss_fraction: 0.12 }),
  3: Object.freeze({ p_win: 0.30, payoff: 3.0, loss_fraction: 0.10 }),
});

/** One knob for how far past the designed floors gates 2 and 3 let a token in. Gate 1 (the rug
 *  disqualifiers) never moves: aggression is about how early and how speculative, not how unsafe.
 *    0 cautious  1 as designed  2 aggressive  3 degen */
// The risk dial. Every knob a gate reads, per level. 0 = only the designed rules at their strictest,
// 3 = as loose as still makes sense. Calibrated on gate-stats (30 min, 786 tokens): at level 1 the
// binding rules were COORDINATED_DUMP (+51 tokens), STALE (+15), TOO_LATE (+12), EXTREME_CONCENTRATION
// (+11) in gate 1; DEAD_ON_ARRIVAL (63%) and INSUFFICIENT_DATA (22%) in gate 2; WATCHLIST in gate 3.
export const AGGRESSION = Object.freeze({
  0: Object.freeze({ scoreFloor: 50, tier3Floor: 55, sybilMax: 0.35, freshWalletMax: 0.70, curveMax: 0.50, curveMaxSpec: 0.30, spikeSlope: 0.10, blockDecel: true,  requireStable: true,
                     coordDump: 0.5, staleMin: 15, tooLateCurve: 0.80, concentrationMax: 0.70, doaBuyers: 5, minScores: 2, enterWatchlist: false, minConfidence: 0.55, momentum: null, kellyMult: 0.75, mcapFloor: 4000, devHoldMax: 0.08, requireSocials: true, maxRoundTripBps: 500 }),
  1: Object.freeze({ scoreFloor: 45, tier3Floor: 50, sybilMax: 0.40, freshWalletMax: 0.80, curveMax: 0.60, curveMaxSpec: 0.40, spikeSlope: 0.15, blockDecel: true,  requireStable: true,
                     coordDump: 0.5, staleMin: 15, tooLateCurve: 0.80, concentrationMax: 0.70, doaBuyers: 5, minScores: 2, enterWatchlist: false, minConfidence: 0.50, momentum: null, kellyMult: 1, mcapFloor: 4000, devHoldMax: 0.10, requireSocials: true, maxRoundTripBps: 600 }),
  2: Object.freeze({ scoreFloor: 38, tier3Floor: 42, sybilMax: 0.50, freshWalletMax: 0.90, curveMax: 0.70, curveMaxSpec: 0.55, spikeSlope: 0.25, blockDecel: false, requireStable: false,
                     coordDump: 0.7, staleMin: 30, tooLateCurve: 0.90, concentrationMax: 0.80, doaBuyers: 4, minScores: 1, enterWatchlist: true, minConfidence: 0.40,
                     momentum: { buyers: 15, ageMaxMin: 3, sellShareMax: 0.40 }, kellyMult: 1.5, mcapFloor: 3000, devHoldMax: 0.12, requireSocials: true, maxRoundTripBps: 800 }),
  3: Object.freeze({ scoreFloor: 32, tier3Floor: 35, sybilMax: 0.60, freshWalletMax: 1.00, curveMax: 0.80, curveMaxSpec: 0.65, spikeSlope: 0.40, blockDecel: false, requireStable: false,
                     coordDump: 0.85, staleMin: 60, tooLateCurve: 0.95, concentrationMax: 0.90, doaBuyers: 3, minScores: 0, enterWatchlist: true, minConfidence: 0.30,
                     momentum: { buyers: 10, ageMaxMin: 5, sellShareMax: 0.45 }, kellyMult: 2, mcapFloor: 2500, devHoldMax: 0.15, requireSocials: true, maxRoundTripBps: 1000 }),
});

// What a PONS curve is assumed to charge before its economics have actually been read. The point is
// that an unread number must not look free: at these values a round trip costs 12%, which the EV
// gate will refuse for anything but a strong edge -- and the moment the real figures arrive, they
// are used instead. Erring high delays an entry; erring low buys a token that cannot be sold back
// at a profit however it moves.
const PONS_ASSUMED_FEE_BPS = 100;
const PONS_ASSUMED_TAX_BPS = 500;
// Arc / Argus: a side's tax is at most 10% (LaunchHook.MAX_LEG_TAX_BPS); the v4 pool tier is 1%.
export const ARC_MAX_LEG_TAX_BPS = 1000;
export const ARC_POOL_FEE_BPS = 100;
// null and undefined mean "not read yet" and must take the fallback. Number(null) is 0, which is
// finite, so a plain isFinite check would call an unread tax zero -- the exact bug this guards.
const numOr = (v, fallback) => (v == null || v === "" || !Number.isFinite(Number(v)) ? fallback : Number(v));

export function makePumpfunEdge({
  venue = "pumpfun",               // "pons": the same judge on Robinhood Chain; snipe-tax window refused
  aggression = 1,
  priors = PUMPFUN_PRIORS,
  minOutcomesForStats = 30,
  feeFractionRoundTrip = 0.03,     // pump.fun 1% in + 1% out, plus the router's 0.5% each way
  // What a round trip really costs in fixed SOL, from the router's own constants: a priority fee and
  // a base fee on the buy, the same on the sell, and one more base fee to close the token account and
  // take its rent back. The rent itself nets out because it is reclaimed.
  fixedCostSol = (Number(process.env.PRIORITY_FEE_SOL) > 0 ? Number(process.env.PRIORITY_FEE_SOL) : 0.0003) + 0.000005,
  // The stake the gate prices costs at when the caller does not say. A gate that assumes $25 while the
  // sizer hands it $5 approves trades that cannot clear their own costs, which is how a fixed cost
  // becomes an invisible one.
  nominalStakeUsd = 25,
} = {}) {
  const level = AGGRESSION[Math.max(0, Math.min(3, Math.round(Number(aggression) || 0)))] || AGGRESSION[1];
  // A launch with no twitter, telegram or website is refused at every risk level. Set
  // VELOCITY_REQUIRE_SOCIALS=0 to turn it off. On PONS the gate is inert rather than disabled: the
  // socials are on chain in TokenParams but the feed does not read them yet, so _socialsKnown is never
  // set there and the rule cannot fire. Reading them is the fix, not switching this off.
  const socialsOff = process.env.VELOCITY_REQUIRE_SOCIALS === "0";
  const base = socialsOff ? { ...level, requireSocials: false } : level;
  // PONS: up to 99% snipe tax in the first 60s. Arc (Argus): the same idea over the first 3 seconds,
  // so the floor is six seconds -- past the tax, before the crowd.
  const gateOpts = venue === "pons" ? { ...base, minAgeMin: 1.1 } : venue === "arc" ? { ...base, minAgeMin: 0.1 } : base;
  return {
    venue,
    name: "bondli_gates",
    aggression: Number(aggression),
    gateOpts,
    minConfidence: gateOpts.minConfidence ?? 0.5, // the post-gate confidence floor, read by the GateRunner

    /** Only candidate events carry a scorable token; ticks belong to exits. */
    ingest(event) {
      if (event.kind !== "candidate") return [];
      const p = event.payload || {};
      if (!p.token || !p.token.ca) return [];
      if (p.token._mayhem) return []; // Mayhem launches are never looked at
      if (p.token._copyOf) return []; // a same-name copy is an advert for another token, never a trade
      return [{
        model: p.token._revival ? "bondli_revival" : p.token._slowCook ? "bondli_slowcook" : "bondli_gates",
        revival: p.token._revival || null,
        // Still building, just slowly (src/api/revival.mjs). Waives the stale clock and nothing else.
        slowCook: p.token._revival ? null : (p.token._slowCook || null),
        instrument: p.token.ca,
        token: p.token, qf: p.qf, scores: p.scores || {}, dynamics: p.dynamics,
        solPrice: p.solPrice || 0,
        // The router sizes and routes from this: on PONS it needs the curve contract and its reserves.
        reference: { mcapUsd: p.mcapUsd || p.token.mcapUsd || 0, vSolInBondingCurve: p.vSolInBondingCurve || p.token.vSolInBondingCurve || 0, solPrice: p.solPrice || 0, solPriceAt: p.solPriceAt || 0, name: p.token.name || "", ticker: p.token.ticker || "", ...(p.curve ? { curve: p.curve, quote: p.quote || "ETH" } : {}) },
        group: p.token.devWallet || null,
      }];
    },

    gates: [
      // A revival is hours old by definition and a slow cook is older than the stale clock on purpose:
      // for both, the age rule (STALE) does not apply and every rug rule still does.
      { name: "disqualifiers", check: c => { const r = checkDisqualifiers(c.token, c.qf, { ...gateOpts, ...(c.revival || c.slowCook ? { staleMin: Infinity } : {}), freezeAuthority: !!c.token.freezeAuthority }); if (r.waived?.length) c.waived = r.waived; return { pass: r.pass, reasons: r.flags, timingOnly: r.timingOnly }; } },
      { name: "viability", check: c => { const r = checkViability(c.token, c.qf, c.scores, c.dynamics, gateOpts); return { pass: r.pass, reasons: r.checks }; } },
      { name: "confidence", check: c => {
          // A revival is always a speculative entry: its own plan, half the stake, never a bigger tier.
          if (c.revival) { c.tier = 3; c.tierLabel = "REVIVAL"; c.tierReasons = [`buyers5m ${c.revival.buyers5m} vs ${c.revival.baseline5m}`, `curve +${c.revival.curveDelta}`]; return { pass: true }; }
          const r = classifyConfidence(c.token, c.qf, c.scores, c.dynamics, gateOpts);
          c.tier = r.tier; c.tierLabel = r.label; c.tierReasons = r.reasons;
          if (r.tier >= 1 && r.tier <= 3) return { pass: true };
          // On the loose settings a watchlist token is a speculative entry: tier-3 plan and sizing.
          if (r.tier === 4 && gateOpts.enterWatchlist) { c.tier = 3; c.tierLabel = "WATCHLIST_AS_SPEC"; return { pass: true }; }
          return { pass: false, reasons: [...new Set([r.tier === 4 ? "WATCHLIST" : "BELOW_THRESHOLD", ...r.reasons])] };
        } },
      { name: "execution_window", check: c => { const r = checkExecutionWindow(c.token, c.tier, c.scores.scoreTimestamp, gateOpts); return { pass: r.pass, reasons: r.checks }; } },
    ],

    estimate(c, ctx = {}) {
      // This judge serves PONS as well as pump.fun, so it must read the record of the venue it is
      // actually judging. Keyed to "pumpfun" it priced Robinhood Chain entries with pump.fun's win
      // rate and payoff -- a different chain, launchpad, fee schedule and crowd -- while the PONS
      // statistics modeStats computes were never read by anything.
      const stats = ctx.stats?.[venue]?.[c.tier];
      const prior = priors[c.tier] || priors[3];
      const useStats = stats && stats.n >= minOutcomesForStats && stats.p_win > 0 && stats.payoff > 0;
      const p_win = useStats ? stats.p_win : prior.p_win;
      const payoff = useStats ? stats.payoff : prior.payoff;
      // How much one average loss is worth, as a fraction of the stake. payoff is a ratio measured in
      // these units, so without it the EV gate cannot compare an edge against a cost. Realized losses
      // when there are enough of them; before that the tier's designed stop, which is what the exit
      // plan is actually aiming to lose.
      const lossFraction = useStats && stats.loss_fraction > 0 ? stats.loss_fraction : (prior.loss_fraction ?? 0.12);
      // Ranking weights are still pump.fun's: the learner only trains that set, and the features are
      // the same shape on both venues. Unlike the statistics above, this is a shared prior rather
      // than one venue's record being read as another's.
      const weights = ctx.weights?.[venue] || ctx.weights?.pumpfun || DEFAULT_WEIGHTS.pumpfun;
      const features = pumpfunFeatures(c);
      const ranked = scoreFeatures(features, weights);
      const confidence = Math.min(0.95, ranked + (c.tier === 1 ? 0.15 : c.tier === 2 ? 0.05 : 0));
      const plan = planFor(venue, c.revival ? "revival" : c.tier);
      return {
        p_win, payoff, loss_fraction: lossFraction, on_priors: !useStats, outcomes_seen: stats?.n || 0, confidence, tier: c.tier,
        plan_key: plan.key, stake_cap_fraction: plan.stake_cap_fraction ?? null,
        stop_fraction: plan.worst_case_fraction,
        group: c.token.devWallet || null,
        features,
        reasons: [c.tierLabel, ...(c.tierReasons || []), ...(c.waived?.length ? [`momentum waived ${c.waived.join("+")}`] : []), useStats ? `stats n=${stats.n}` : "priors", `rank ${ranked.toFixed(3)}`],
      };
    },

    /** Cost as a fraction of the stake actually being risked. Pass stakeUsd when it is known: the
     *  fixed part is a constant number of dollars, so it is 0.5% of $25 and 2.4% of $5, and pricing it
     *  at the wrong size is the difference between a gate that works and one that waves everything
     *  through. Both the fixed part and the curve impact scale with the real stake. */
    costs(c, stakeUsd = null) {
      const quotePrice = c.solPrice || c.reference?.solPrice || 0; // SOL on pump.fun, ETH on PONS
      const pons = venue === "pons";
      const arc = venue === "arc";
      const stakeAt = Number(stakeUsd) > 0 ? Number(stakeUsd) : nominalStakeUsd;
      const vQuote = Number(c.reference?.vSolInBondingCurve) || (venue === "arc" ? 2000 : pons ? 3 : 30);
      const stakeQuote = quotePrice > 0 ? stakeAt / quotePrice : (venue === "arc" ? 10 : pons ? 0.01 : 0.1);
      // Constant-product curve: buying stake into the quote reserve moves price by about stake/reserve.
      const impact = Math.min(0.25, stakeQuote / Math.max(pons ? 0.1 : 1, vQuote));
      // Fixed cost per side: priority fee + tip on Solana; L2 gas on Robinhood Chain (a few cents).
      const fixedQuote = arc ? 0.02 : pons ? 0.00003 : fixedCostSol; // Arc gas is USDC and a swap costs cents
      const fixed = quotePrice > 0 ? (2 * fixedQuote * quotePrice + (pons || arc ? 0 : 0.000005 * quotePrice)) / stakeAt : 0.02;
      // Round-trip fee. pump.fun is 1% + 1% and the same for everyone. PONS is not: each curve sets
      // its own feeBps, and the creator sets a tax on top that they choose. A 10% creator tax is a
      // 22% round trip, and no price move recovers that.
      //
      // Two ways this used to read as cheap. A curve whose economics had not been fetched yet
      // carried the placeholders feeBps 100 / creatorTaxBps 0, so an unread tax was priced as no
      // tax; those are null now, and null here means "assume the worst until it is read". And with
      // no curve object at all it fell through to pump.fun's flat 3% -- a number from the other
      // chain entirely. Neither silently under-prices a PONS trade any more.
      // Arc (Argus): the hook's buy tax on the way in, its sell tax on the way out, and the pool's 1%
      // fee on each leg. The taxes are immutable per launch and read off the hook, so unlike PONS
      // there is no creator tax to assume; an unread tax is priced at the hook's maximum (10% a side).
            const feeRT = arc
        ? (numOr(c.reference?.curve?.feeBps, ARC_MAX_LEG_TAX_BPS) + numOr(c.reference?.curve?.sellTaxBps, ARC_MAX_LEG_TAX_BPS) + 2 * ARC_POOL_FEE_BPS) / 1e4
        : pons
        ? 2 * ((numOr(c.reference?.curve?.feeBps, PONS_ASSUMED_FEE_BPS) + numOr(c.reference?.curve?.creatorTaxBps, PONS_ASSUMED_TAX_BPS)) / 1e4)
        : feeFractionRoundTrip;
      return { fraction: feeRT + impact + fixed, detail: { feeFractionRoundTrip: feeRT, impact, fixed, stake_usd: stakeAt } };
    },
  };
}
