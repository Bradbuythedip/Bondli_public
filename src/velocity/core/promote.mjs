// ═══ VELOCITY — Paper-to-live promotion gate (Part K) ═══
// Every item must be green. A venue that never passes stays in paper; that is
// the system working as designed, not a failure of the system.

import { expectancyInterval } from "./stats.mjs";

export function promotionGate({ ledger, envelope, venue, latency = null, store = null }) {
  const vc = envelope.venues[venue];
  const min = envelope.promotion.min_paper_trades[venue];
  const outcomes = ledger.readAll(r => r.kind === "outcome" && r.venue === venue && r.paper !== false);
  const ci = expectancyInterval(outcomes, envelope.promotion.confidence);
  const violations = ledger.readAll(r => r.kind === "violation" && r.venue === venue).length;
  const unplanned = store ? store.openPositions(venue).filter(p => !p.plan).length : 0;
  const items = [];
  items.push({ name: "paper_trades", ok: outcomes.length >= min, detail: `${outcomes.length} of ${min} paper trades` });
  items.push({ name: "expectancy_positive", ok: ci.n > 0 && ci.mean > 0, detail: `mean ${(ci.mean * 100).toFixed(2)}% of stake after modeled costs` });
  items.push({ name: "expectancy_significant", ok: ci.n > 1 && ci.lower > 0, detail: ci.n > 1 && ci.mean > 0 && ci.lower <= 0 ? `positive, not yet significant (lower bound ${(ci.lower * 100).toFixed(2)}%)` : `lower ${(envelope.promotion.confidence * 100).toFixed(0)}% bound ${(ci.lower * 100).toFixed(2)}%` });
  const budget = vc.latency_budget_ms;
  const stages = ["observe", "decide", "send", "confirm"];
  const lat = latency || {};
  const latOk = stages.every(s => !lat[s] || lat[s].count === 0 || lat[s].p95 <= budget[s]);
  items.push({ name: "latency_within_budget", ok: latOk && stages.some(s => lat[s] && lat[s].count > 0), detail: stages.map(s => `${s} p95 ${lat[s]?.p95 ?? "n/a"}/${budget[s]}ms`).join(", ") });
  items.push({ name: "zero_violations", ok: violations === 0, detail: `${violations} risk-envelope violations` });
  items.push({ name: "zero_unplanned", ok: unplanned === 0, detail: `${unplanned} positions without a plan` });
  const ok = items.every(i => i.ok) && vc.max_exposure_usd > 0;
  if (!(vc.max_exposure_usd > 0)) items.push({ name: "venue_enabled", ok: false, detail: "venue has zero exposure in the risk file" });
  const paperStake = outcomes.length ? outcomes.reduce((s, o) => s + (o.stake_usd || 0), 0) / outcomes.length : 0;
  const liveStartCap = +Math.min(envelope.per_trade_max_usd, Math.max(vc.min_stake_usd, paperStake * envelope.promotion.live_start_fraction)).toFixed(2);
  return { venue, ok, items, liveStartCapUsd: liveStartCap, n: outcomes.length, ci: { mean: ci.mean, lower: ci.lower, sd: ci.sd } };
}
