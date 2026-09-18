// ═══ VELOCITY — Gate runner (DP2) ═══
// Venue-agnostic. Runs an edge model's kill gates cheapest-first, then the
// edge's estimate, then expected value after costs. Emits GO or REJECT with
// the gate and reasons. It never consults the risk envelope: that is DP3's job.
// Every number here derives from the event and the context, never from the
// wall clock, so a replay of the same capture yields byte-identical decisions.

import { eventHash } from "./events.mjs";

/** Run fn with Date.now() pinned to t. bondli's gates read the clock for token
 *  age and score freshness; the decision time is the event's observed time. */
export function withClock(t, fn) {
  const real = Date.now;
  Date.now = () => t;
  try { return fn(); } finally { Date.now = real; }
}

/** Expected value of one trade as a FRACTION OF THE STAKE, after costs.
 *
 *  `payoff` is a ratio -- average win over average loss -- so `p*payoff - (1-p)` is an edge measured
 *  in units of one average loss (one R), not in stake. `costs` is a fraction of the stake. Subtracting
 *  one from the other compares two different units: at a 5% average loss and a 3.5% round trip, one R
 *  is 0.7 of the trade's cost, so charging 0.035 R instead of 0.7 R understated the cost of trading by
 *  about twenty times. `lossFraction` is what converts between them.
 *
 *  With no lossFraction the old R-denominated form is kept, so a venue that has not supplied one is
 *  not silently rescaled. */
export function expectedValue({ p_win, payoff, costs, lossFraction = null }) {
  const edgeR = p_win * payoff - (1 - p_win);
  if (!(lossFraction > 0)) return edgeR - costs;
  return edgeR * lossFraction - costs;
}

export class GateRunner {
  // probeStakeFraction: while a tier has no realized outcomes of its own it is judged on priors, and
  // a prior that prices a trade out is a claim about a guess. A tier whose edge is positive BEFORE
  // costs, and only negative after them, is exactly the case where the assumed loss size is what
  // decides -- and that is the number the priors are least entitled to. Rather than refuse forever
  // and never learn otherwise, such a trade is taken at this fraction of the normal cap until the
  // tier has enough outcomes to be measured. Set to 0 to refuse instead.
  constructor({ venue, edge, minConfidence = edge?.minConfidence ?? 0.5, minEv = 0, probeStakeFraction = 0.4 }) {
    if (!edge || edge.venue !== venue) throw new Error(`edge model must be for venue ${venue}`);
    this.venue = venue;
    this.edge = edge;
    this.minConfidence = minConfidence;
    this.minEv = minEv;
    this.probeStakeFraction = Number(probeStakeFraction) > 0 ? Math.min(1, Number(probeStakeFraction)) : 0;
    this.evaluated = 0;
    this.gos = 0;
  }

  /** Feed one MarketEvent through the edge's ingest, then gate every candidate. */
  run(event, ctx = {}) {
    const candidates = this.edge.ingest(event, ctx) || [];
    const out = [];
    for (const cand of candidates) out.push(this.evaluate(event, cand, ctx));
    return out;
  }

  evaluate(event, cand, ctx = {}) {
    this.evaluated++;
    const base = {
      id: eventHash(event, `${cand.model || "default"}|${cand.instrument || event.id}`),
      venue: this.venue,
      instrument: String(cand.instrument || event.id),
      model: cand.model || this.edge.name || "default",
      event_kind: event.kind,
      t_event: event.t_venue,
      t_observed: event.t_observed,
      t_decided: event.t_observed,
      group: cand.group || null,
      legs: cand.legs ? cand.legs.map(l => ({ conditionId: l.conditionId || null, tokenId: l.tokenId || l.instrument, instrument: l.instrument || l.tokenId, side: l.side, price: l.price, size: l.size })) : null,
      reference: cand.reference || null,
    };
    const reject = (gate, reasons) => ({ ...base, action: "REJECT", gate, reasons: [].concat(reasons).map(String), tier: cand.tier ?? 0 });

    // Gate 0: governor veto (halt or zero throttle). A throttle in (0,1) is sizing's business.
    const gov = ctx.governor || {};
    if (gov.halt) return reject("governor", [`HALT:${gov.haltReason || "halt"}`]);
    if (gov.throttle === 0) return reject("governor", ["THROTTLE_ZERO"]);

    // Venue gates, cheapest first, every one a kill gate.
    const gates = this.edge.gates || [];
    let verdict = null;
    withClock(event.t_observed, () => {
      for (const g of gates) {
        const r = g.check(cand, ctx);
        if (!r || r.pass) continue;
        verdict = reject(g.name, r.reasons && r.reasons.length ? r.reasons : ["FAIL"]);
        return;
      }
    });
    if (verdict) return verdict;

    // Estimate and expected value after costs.
    const est = withClock(event.t_observed, () => this.edge.estimate(cand, ctx)) || {};
    // Price the costs at the SMALLEST stake the sizer could hand back, not a nominal one. The fixed
    // part is a fixed number of dollars, so a gate that prices it at $25 while the governor throttles
    // the trade to the floor approves entries that cannot clear their own costs.
    const costs = withClock(event.t_observed, () => this.edge.costs(cand, ctx?.minStakeUsd ?? null)) || { fraction: 0 };
    const p_win = clamp(Number(est.p_win) || 0, 0, 1);
    const payoff = Math.max(0, Number(est.payoff) || 0);
    const confidence = clamp(Number(est.confidence) || 0, 0, 1);
    const lossFraction = Number(est.loss_fraction) > 0 ? Number(est.loss_fraction) : null;
    const ev = expectedValue({ p_win, payoff, costs: costs.fraction || 0, lossFraction });
    const tier = est.tier ?? cand.tier ?? 0;
    const common = { ...base, tier, p_win: round(p_win), payoff: round(payoff), confidence: round(confidence), ev: round(ev), loss_fraction: lossFraction, costs: { ...costs, fraction: round(costs.fraction || 0) }, stop_fraction: est.stop_fraction ?? cand.stop_fraction ?? null, plan_key: est.plan_key ?? null, stake_cap_fraction: est.stake_cap_fraction ?? null, group: est.group ?? base.group, size_hint: est.size_hint ?? null, features: est.features || null };
    if (!(p_win > 0) || !(payoff > 0)) return { ...common, action: "REJECT", gate: "estimate", reasons: ["NO_EDGE_ESTIMATE"] };
    if (confidence < this.minConfidence) return { ...common, action: "REJECT", gate: "confidence", reasons: [`CONFIDENCE_${confidence.toFixed(2)}_BELOW_${this.minConfidence}`] };
    if (ev <= this.minEv) {
      // A refusal that came from an assumption, not a measurement. See probeStakeFraction: if the
      // edge is positive before costs and the tier has never been measured, buy the measurement at a
      // reduced size instead of refusing forever on the strength of a guess.
      const edgeBeforeCosts = p_win * payoff - (1 - p_win);
      if (est.on_priors && this.probeStakeFraction > 0 && edgeBeforeCosts > 0) {
        this.gos++;
        return { ...common, action: "GO", gate: null, probe: true,
          stake_cap_fraction: Math.min(common.stake_cap_fraction ?? 1, this.probeStakeFraction),
          reasons: [`PROBE: tier ${tier} has ${est.outcomes_seen || 0} outcomes, EV ${ev.toFixed(4)} rests on priors`, ...(est.reasons || [])].map(String) };
      }
      return { ...common, action: "REJECT", gate: "ev", reasons: [`EV_${ev.toFixed(4)}_NOT_POSITIVE_AFTER_COSTS${est.on_priors ? "_ON_PRIORS" : ""}`] };
    }
    this.gos++;
    return { ...common, action: "GO", gate: null, reasons: [].concat(est.reasons || ["all gates passed"]).map(String) };
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round(v) { return Math.round(v * 1e6) / 1e6; }
