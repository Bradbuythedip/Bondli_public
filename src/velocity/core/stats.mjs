// ═══ VELOCITY — Realized statistics from the ledger ═══
// Per venue and tier: how often we won and how much a win paid relative to a
// loss. The edge estimates from these once there are enough outcomes, and the
// promotion gate reads the same numbers. One source, no second opinion.

export function statsFromOutcomes(outcomes) {
  const byKey = {};
  for (const o of outcomes) {
    if (!o || !o.venue || !Number.isFinite(o.pnl_usd) || !(o.stake_usd > 0)) continue;
    const key = o.tier != null && o.tier !== 0 ? o.tier : o.model || "default";
    const v = (byKey[o.venue] = byKey[o.venue] || {});
    const s = (v[key] = v[key] || { n: 0, wins: 0, winSum: 0, lossSum: 0, pnlSum: 0 });
    const r = o.pnl_usd / o.stake_usd;
    s.n++;
    s.pnlSum += r;
    if (o.pnl_usd > 0) { s.wins++; s.winSum += r; } else s.lossSum += -r;
  }
  for (const v of Object.values(byKey)) {
    for (const s of Object.values(v)) {
      const losses = s.n - s.wins;
      const avgWin = s.wins ? s.winSum / s.wins : 0;
      const avgLoss = losses ? s.lossSum / losses : 1;
      s.p_win = s.n ? s.wins / s.n : 0;
      s.payoff = avgLoss > 0 ? avgWin / avgLoss : avgWin;
      // payoff is a RATIO of average win to average loss, so it is denominated in "one average loss"
      // (one R), not in stake. Anything that wants to compare it against a cost -- which is a
      // fraction of stake -- needs to know how big one R actually is.
      s.loss_fraction = losses ? avgLoss : 0;
      s.expectancy = s.n ? s.pnlSum / s.n : 0;
    }
  }
  return byKey;
}

/** Mean, sd, and a one-sided lower confidence bound on expectancy per unit stake. */
export function expectancyInterval(outcomes, confidence = 0.9) {
  const rs = outcomes.filter(o => Number.isFinite(o.pnl_usd) && o.stake_usd > 0).map(o => o.pnl_usd / o.stake_usd);
  const n = rs.length;
  if (!n) return { n: 0, mean: 0, sd: 0, lower: 0, z: zFor(confidence) };
  const mean = rs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const z = zFor(confidence);
  return { n, mean, sd, lower: mean - z * sd / Math.sqrt(n), z };
}

function zFor(c) {
  if (c >= 0.99) return 2.326;
  if (c >= 0.975) return 1.960;
  if (c >= 0.95) return 1.645;
  if (c >= 0.9) return 1.282;
  return 0.842;
}
