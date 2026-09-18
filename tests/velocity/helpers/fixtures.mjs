export const T0 = 1_700_000_000_000;
export function goodToken(ca, over = {}) {
  const now = Date.now();
  return {
    ca, name: "cat", ticker: "CAT", createdAt: now - 4 * 60_000, buys: 40, sells: 12, mcapUsd: 18_000, vSolInBondingCurve: 20,
    uniqueBuyers: { size: 25 }, volumeSol: 30, devWallet: "DevA",
    trades: Array.from({ length: 12 }, (_, i) => ({ time: now - 60_000 + i * 4_000, side: i % 4 === 3 ? "sell" : "buy", sol: 0.4 })),
    spark: [16_500, 17_200, 18_000, 17_600, 17_900, 18_000], _memeticQuick: 0.7, _survivorMatch: 55, _stabilityCount: 3, ...over,
  };
}
export const goodQf = { rg_devSellSpeed: 0.05, _rg_sybilScore: 0.05, _rg_freshWalletRatio: 0.2, rg_holderConcentration: 0.2, ch_healthScore: 0.7, rg_walletAgeScore: 0.6, _whaleBullish: 0.25 };
export const goodDyn = { scores: 4, velocity: 0.1, acceleration: 0.01, trend: "rising" };
export function goodCandidatePayload(ca) {
  return { token: goodToken(ca), qf: goodQf, scores: { apeScore: 68, scoreTimestamp: Date.now(), rugFlagCount: 0 }, dynamics: goodDyn, solPrice: 150, mcapUsd: 18_000, vSolInBondingCurve: 20 };
}
export function tickPayload(ca, mcapUsd, over = {}) {
  return { mcapUsd, token: goodToken(ca, { mcapUsd }), dynamics: over.dynamics || { scores: 5, velocity: 0.05, acceleration: 0, trend: "stable" }, scores: { apeScore: over.apeScore ?? 66 }, solPrice: 150, vSolInBondingCurve: 20 };
}
