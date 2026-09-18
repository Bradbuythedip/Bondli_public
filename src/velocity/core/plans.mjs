// ═══ VELOCITY — Static exit plan table (read by DP2 and DP5) ═══
// A plan is a pure function of (venue, key). Nothing at runtime edits this
// table, which is what keeps entry (DP2) and exit (DP5) decoupled: the entry
// estimates payoff from the ledger's realized outcomes, never from these targets.

const SEC = 1_000;
const MIN = 60_000;

export const EXIT_PLANS = Object.freeze({
  pumpfun: Object.freeze({
    // bondli's createExitPlan(tier) supplies stop/targets; these add the sizing-side worst case.
    // doa_ms: the crowd-did-not-follow-us-in exit. Seconds after a fill the PRICE is mostly our own
    // impact and tells us nothing, but whether anyone ELSE has bought is already knowable, and a
    // launch that nobody joins in its first seconds is not about to be joined. Cutting one of these
    // flat costs a round trip (3.5% of a $25 stake); letting it become a crash-exit costs 7.2%, which
    // is what the last forty closes actually averaged. Time alone would be the wrong test -- a blanket
    // cut at this age takes the average win from +24% to nothing and flips the edge negative -- so it
    // fires only when participation is absent AND the price has not moved.
    // stall_ms / stall_band_pct: the slower version. A position this old that never left the band
    // around entry, with buying dried up, is dead money and is sold to free the slot ("STALL").
    1: Object.freeze({ key: 1, label: "GOD_CANDLE", mode: "bondli_layers", worst_case_fraction: 1.0, max_hold_ms: 30 * MIN, doa_ms: 30 * SEC, stall_ms: 4 * MIN, stall_band_pct: 10 }),
    2: Object.freeze({ key: 2, label: "STRONG", mode: "bondli_layers", worst_case_fraction: 1.0, max_hold_ms: 15 * MIN, doa_ms: 20 * SEC, stall_ms: 3 * MIN, stall_band_pct: 8 }),
    3: Object.freeze({ key: 3, label: "SPECULATIVE", mode: "bondli_layers", worst_case_fraction: 1.0, max_hold_ms: 10 * MIN, doa_ms: 12 * SEC, stall_ms: 2 * MIN, stall_band_pct: 8 }),
    // A revival moves faster on the way down than a launch: tier-3 layers with a tighter stop, a
    // shorter hold, and half the per-trade cap (stake_cap_fraction is read by the sizer).
    revival: Object.freeze({ key: "revival", label: "REVIVAL", mode: "bondli_layers", worst_case_fraction: 1.0, max_hold_ms: 6 * MIN, stop_pct: 8, tier: 3, stake_cap_fraction: 0.5, doa_ms: 10 * SEC, stall_ms: 1.5 * MIN, stall_band_pct: 8 }),
  }),
  polymarket: Object.freeze({
    // A wrong fact loses the whole stake: worst case is 1.0 even though the plan is hold-to-redeem.
    resolved_fact: Object.freeze({ key: "resolved_fact", mode: "hold_to_redeem", worst_case_fraction: 1.0, stop_pct: 25, max_hold_ms: 14 * 24 * 60 * MIN }),
    // A full consistency set is locked in; the residual is unwind slippage on a partial fill.
    consistency: Object.freeze({ key: "consistency", mode: "hold_to_redeem", worst_case_fraction: 0.15, stop_pct: null, max_hold_ms: 30 * 24 * 60 * MIN }),
    stale_quote: Object.freeze({ key: "stale_quote", mode: "target_stop", worst_case_fraction: 0.10, target_pct: 6, stop_pct: 5, max_hold_ms: 3 * 24 * 60 * MIN }),
  }),
});

// PONS trades the same way pump.fun does: same tiers, same layers, same revival plan.
const ALIAS = Object.freeze({ pons: "pumpfun", arc: "pumpfun" });

export function planFor(venue, key) {
  const p = EXIT_PLANS[ALIAS[venue] || venue]?.[key];
  if (!p) throw new Error(`no exit plan for ${venue}/${key}`);
  return p;
}
