// ═══ BONDING-CURVE PROGRESS ═══
// pump.fun's curve account reports a VIRTUAL SOL reserve. It starts at 30 SOL with nothing raised
// and climbs to about 115 as the 85 SOL of real deposits arrive, so progress is (vSol - 30) / 85.
// The raw ratio vSol / 85 is wrong at both ends: a token that has raised nothing reads 35%, and a
// token reads 100% when it is really 65% of the way. Every curve cap compared against the raw
// ratio therefore binds far earlier than its number says -- a tier-3 cap of 0.30 is unreachable
// even for a brand-new launch.
export const PUMP_VIRTUAL_SOL_START = 30;
export const PUMP_GRADUATION_SOL = 85;

/** Fraction of the way to graduation, 0..1, from pump.fun's virtual SOL reserve. */
export function pumpCurvePct(vSolInBondingCurve) {
  const v = Number(vSolInBondingCurve);
  if (!(v > 0)) return 0;
  return Math.max(0, Math.min(1, (v - PUMP_VIRTUAL_SOL_START) / PUMP_GRADUATION_SOL));
}

/** Curve progress for any venue: a feed that computes its own (PONS) is believed over the curve maths. */
export function curvePctOf(token) {
  if (token?._curvePct != null) return Number(token._curvePct);
  return pumpCurvePct(token?.vSolInBondingCurve);
}
