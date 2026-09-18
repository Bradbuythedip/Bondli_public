// ═══ GATE 1: HARD DISQUALIFIERS — Instant Reject (<5ms) ═══
// Absolute deal-breakers. No score overrides them. Token blacklisted on fail.

// opts: freezeAuthority, isRecoveryPlay, and the aggression profile's gate-1 knobs
// (src/velocity/venues/pumpfun/edge.mjs AGGRESSION); defaults are the designed rules.
import { curvePctOf } from "./curve.js";
export function checkDisqualifiers(token, qf, opts = {}) {
  const { coordDump = 0.5, staleMin = 15, tooLateCurve = 0.80, concentrationMax = 0.7, minAgeMin = 0.5, momentum = null, devHoldMax = 0.10, requireSocials = false, maxRoundTripBps = 800 } = opts;
  const flags = [];

  // A launch that lists no twitter, no telegram and no website is someone who did not intend to be
  // found. It is the cheapest thing a real project does and the first thing a throwaway skips. This
  // only fires once the metadata has actually been read: before that, absence is ignorance, not a fact.
  // A link is not verification — anyone can paste a URL — so this removes the laziest launches, not
  // the deliberate ones.
  if (requireSocials && qf?._socialsKnown && !qf._hasAnySocial) flags.push("NO_SOCIALS");

  // === WHAT THE VENUE CHARGES ===
  // On a PONS curve the creator sets a tax on top of the curve's own fee, and both are paid on the
  // way in and the way out. A 10% tax is a 22% round trip: no price move recovers that, and it is
  // not a judgement about the token but arithmetic about the venue. Twenty-five such trades cost one
  // operator $52 while the gate, reading an unfetched tax as zero, thought each one cost 20 cents.
  // Only fires once the curve has actually been read -- before that the cost model assumes the worst
  // and the EV gate does the refusing.
  const feeBps = Number(token.curve?.feeBps ?? token.feeBps);
  const taxBps = Number(token.curve?.creatorTaxBps ?? token.creatorTaxBps);
  if (Number.isFinite(feeBps) && Number.isFinite(taxBps) && 2 * (feeBps + taxBps) > maxRoundTripBps) flags.push("FEE_TOO_HIGH");
  // A twitter account created in the last week, for a token launched minutes ago, is part of the
  // launch rather than evidence about it. Only fires when the X API actually answered.
  if (requireSocials && qf?._xFlags?.includes("fresh_account")) flags.push("FRESH_SOCIALS");

  // === RUG SIGNALS (on-chain) ===
  // Dev wallet has 2+ prior rugs in last 30 days
  if (qf?._devLaunchCount > 8) flags.push("SERIAL_LAUNCHER");
  if (qf?._namePrevRugged && qf._devLaunchCount > 3) flags.push("SERIAL_RUGGER");

  // Dev selling aggressively
  if (qf?.rg_devSellSpeed > 0.6) flags.push("DEV_SELLING");

  // Dev self-sniped the launch
  if (qf?._rg_devSelfSnipe > 0) flags.push("DEV_SELF_SNIPE");
  // The dev still holds a rug-sized share of supply: one transaction empties the curve, and there is
  // no selling into that. Never waived.
  if (qf?._rg_devHoldPct > devHoldMax) flags.push("DEV_HOLDS_SUPPLY");

  // Freeze authority still active
  if (opts.freezeAuthority) flags.push("FREEZE_AUTHORITY");

  // Top holders extremely concentrated (excluding bonding curve).
  // Top-3 share is meaningless with fewer than 8 distinct organic buyers (3 of 5 wallets
  // is always "concentrated"); the rule only speaks once there are enough holders to rank.
  if (qf?.rg_holderConcentration > concentrationMax && (token.buys || 0) > 5 && (qf?._rg_organicBuyers ?? 99) >= 8 && !(qf?._whaleBullish > 0.3))
    flags.push("EXTREME_CONCENTRATION");

  // === DEV SELF-PUMP DETECTION (highest priority — catches "Whale Guru" pattern) ===
  // Linear velocity up + metronome buys + no sells + wallet concentration = dev pump
  // This fires REGARDLESS of age — dev pumps are identifiable from minute 1
  if (qf?._rg_devSelfPumpScore >= 0.7) flags.push("DEV_SELF_PUMP");
  if (qf?._rg_devSelfPumpScore >= 0.5 && qf?._rg_zeroSellFlag >= 0.5) flags.push("DEV_PUMP_NO_SELLS");
  // Linear velocity (R² > 0.9) combined with no sells = instant reject
  if (qf?._rg_velocityLinearity > 0.9 && qf?._rg_buySellImbalance > 0.7) flags.push("LINEAR_PUMP");
  // Metronome buying + concentration = bot farm
  if (qf?._rg_buyTimingRegularity > 0.6 && qf?._rg_singleWalletDominance > 0.4) flags.push("BOT_PUMP");

  // Multiple moderate rug signals firing simultaneously
  // Two of these were base rates rather than signals, for the same reasons the hard rules above
  // were corrected: top-3 share is structurally high with a handful of buyers, and sells landing
  // within 3s of each other is what any active token looks like unless they come as a burst.
  const moderateSignals = [
    qf?.rg_devSellSpeed > 0.35,
    qf?.rg_coordDumpScore > 0.3 && qf?.rg_sellWaveDetect > 0.3,
    qf?._rg_sybilScore > 0.3,
    qf?._rg_quickFlipRate > 0.2,
    qf?.rg_holderConcentration > 0.65 && (qf?._rg_organicBuyers ?? 99) >= 8,
    qf?._rg_earlyDump > 0.3,
    qf?.rg_mcapDropRate > 0.3,
    qf?._rg_pumpDump > 0.35,
    qf?.ch_smoothGrind > 0.4,
    qf?.ch_dipRatio < 0.08,
    qf?._rg_zeroSellFlag > 0.5,
    qf?._rg_buySellImbalance > 0.6,
    qf?.ch_staircaseScore > 0.4,
    qf?._rg_freshWalletRatio > 0.7,
    qf?.ch_flatlineSpike > 0.3,
    token._artworkOriginal === false,
    qf?._rg_velocityLinearity > 0.8,       // near-linear price trajectory
    qf?._rg_buyTimingRegularity > 0.5,     // suspiciously regular buy timing
    qf?._rg_singleWalletDominance > 0.5,   // one wallet doing most buying
  ].filter(Boolean).length;

  const ageMin = (Date.now() - (token.createdAt || Date.now())) / 60000;
  const sells = token.sells || 0;
  const isVeryYoung = ageMin < 2 && sells >= 1;
  const minSignals = isVeryYoung ? 5 : 4;
  if (moderateSignals >= minSignals) flags.push("MULTI_RUG_SIGNAL_" + moderateSignals);

  // === CHART FORENSICS ===
  // rg_coordDumpScore is a raw count (3 clustered sells = 0.6), which any active token
  // produces. A coordinated dump is a BURST of sells while sells are heavy against buys.
  if (qf?.rg_coordDumpScore > coordDump && qf?.rg_sellWaveDetect > coordDump && (token.sells || 0) > (token.buys || 0) * 0.5)
    flags.push("COORDINATED_DUMP");
  if (qf?._rg_pumpDump > 0.6 && !isVeryYoung) flags.push("PUMP_DUMP");
  if (qf?._rg_sybilScore > 0.5) flags.push("SYBIL_ATTACK");
  if (qf?._rg_earlyDump > 0.6 && ageMin < 5) flags.push("EARLY_DUMP");
  if (qf?._rg_quickFlipRate > 0.35) flags.push("QUICK_FLIP");
  if (qf?.rg_liqRemovalSpeed > 0.65 && !isVeryYoung) flags.push("LIQ_REMOVAL");
  if (qf?.ch_smoothGrind > 0.6 && !isVeryYoung) flags.push("SMOOTH_GRIND");
  if (qf?.ch_smoothGrind > 0.4 && qf?.ch_dipRatio < 0.1 && !isVeryYoung) flags.push("NO_DIPS_GRIND");
  if (qf?.rg_mcapDropRate > 0.5 && !isVeryYoung) flags.push("MCAP_CRASHING");
  if (qf?.ch_staircaseScore > 0.6 && !isVeryYoung) flags.push("STAIRCASE_CHART");
  if (qf?.ch_staircaseScore > 0.4 && qf?._rg_freshWalletRatio > 0.6 && !isVeryYoung) flags.push("STAIRCASE_FRESH");
  if (qf?._rg_freshWalletRatio > 0.8 && qf?._rg_zeroSellFlag > 0.4 && !isVeryYoung) flags.push("FRESH_WALLET_RUG");
  if (qf?.ch_flatlineSpike > 0.5 && !isVeryYoung) flags.push("FLATLINE_SPIKE");
  if (qf?.ch_flatlineSpike > 0.3 && qf?._rg_zeroSellFlag > 0.3 && !isVeryYoung) flags.push("FLATLINE_NO_SELLS");
  if (qf?.ch_flatlineSpike > 0.3 && qf?._rg_freshWalletRatio > 0.5 && !isVeryYoung) flags.push("FLATLINE_FRESH");

  // Zero sells: only reject for tokens > 2 min old with no sell activity
  if (qf?._rg_zeroSellFlag >= 0.8 && !isVeryYoung) flags.push("ZERO_SELLS");
  if (qf?._rg_zeroSellFlag >= 0.5 && (qf?.ch_smoothGrind > 0.3 || qf?.ch_staircaseScore > 0.3) && !isVeryYoung)
    flags.push("ZERO_SELLS_FAKE_CHART");
  if (qf?._rg_buySellImbalance >= 0.8 && (token.buys || 0) >= 15 && !isVeryYoung)
    flags.push("ALL_BUYS_NO_SELLS");

  // === VOLUME LEGITIMACY (fee accrual + bot detection) ===
  // Botted volume = instant disqualify. Real volume is the strongest legitimacy signal.
  const volLeg = token._volumeLegitimacy || qf?._volumeLegitimacy;
  if (volLeg) {
    // Hard reject: volume is almost certainly botted
    if (volLeg.botDetection?.botScore >= 70 && (token.buys || 0) >= 10)
      flags.push("BOTTED_VOLUME");
    // High volume but extremely few unique wallets = wash trading for chart
    if (volLeg.legitimacy === "LIKELY_BOTTED" && (token.volumeSol || 0) > 5)
      flags.push("FAKE_VOLUME_HIGH_SOL");
    // Metronomic timing + uniform sizes = clear bot farm
    const botSigs = volLeg.botDetection?.signals || [];
    if (botSigs.includes("METRONOMIC_TIMING") && botSigs.includes("UNIFORM_TRADE_SIZES"))
      flags.push("BOT_FARM_VOLUME");
  }

  // === ARTWORK ===
  if (token._artworkFlags?.includes("EXACT_DUPLICATE")) flags.push("STOLEN_ART");

  // === AGE / TIMING ===
  // Bonding curve >80% = too late
  const curvePct = curvePctOf(token); // pump.fun maths here; other venues say where they are
  if (curvePct > tooLateCurve) flags.push("TOO_LATE");
  // Token >15 min old and score just now appearing = missed it
  if (ageMin > staleMin && !opts.isRecoveryPlay) flags.push("STALE");

  // === HARD MINIMUMS ===
  const ub = token.uniqueBuyers?.size || 0;
  if (ub < 3) flags.push("TOO_FEW_BUYERS");
  if (ageMin < minAgeMin) flags.push("TOO_YOUNG");

  // === MOMENTUM OVERRIDE (aggression 2+) ===
  // The tokens that run hardest have a crowd out of the gate, and a crowd trips the pattern rules:
  // quick flips, sell clusters, top-3 share, "too many signals". Those rules are readings of
  // behaviour that a real crowd also produces. When many distinct buyers are still arriving, price
  // is at its high and sellers are a minority of the flow, the pattern rules are waived and only the
  // rules about WHO is selling and WHETHER it is collapsing can still refuse the token.
  let waived = [];
  if (momentum && flags.length) {
    const organic = qf?._rg_organicBuyers ?? ub;
    const crowd = organic >= momentum.buyers && ageMin <= momentum.ageMaxMin
      && !(qf?.rg_devSellSpeed > 0.35)                          // a dev selling into the crowd is never a crowd
      && (qf?.rg_mcapDropRate ?? 0) < 0.2                      // at or near its high
      && (qf?.rg_liqRemovalSpeed ?? 0) < momentum.sellShareMax  // sellers a minority of the flow
      && sells <= (token.buys || 0) * 0.6;
    if (crowd) {
      // An allow-list, never "everything not fatal": a rule not named here stands.
      waived = flags.filter(f => MOMENTUM_WAIVABLE.has(f) || f.startsWith("MULTI_RUG_SIGNAL_"));
      const keep = flags.filter(f => !waived.includes(f));
      flags.length = 0; flags.push(...keep);
    }
  }

  return {
    pass: flags.length === 0,
    flags,
    waived,
    // Gate 1 refuses for two different reasons and they must not be reported as one. A rug flag says
    // the token is dangerous. A timing flag says the token is fine and it is not our moment — too
    // late on the curve, older than the stale clock, not enough buyers yet, not old enough yet.
    // Calling the second kind a rug is how a clean slow cooker ends up labelled a scam.
    timingOnly: flags.length > 0 && flags.every(f => TIMING_DISQUALIFIERS.has(f)),
    fatal: true,
  };
}

/** Refusals about the clock and the crowd, not about the token being dangerous. */
export const TIMING_DISQUALIFIERS = new Set(["TOO_LATE", "STALE", "TOO_FEW_BUYERS", "TOO_YOUNG"]);

/** The only rules a crowd may waive: readings of behaviour a real crowd also produces. */
export const MOMENTUM_WAIVABLE = new Set(["QUICK_FLIP", "COORDINATED_DUMP", "EXTREME_CONCENTRATION"]);

/** Never waived by momentum (documentation of the intent; the allow-list above is what runs). */
export const FATAL_DISQUALIFIERS = new Set([
  // What a curve charges does not change minute to minute: re-judging it is wasted work.
  "FEE_TOO_HIGH",
  "DEV_HOLDS_SUPPLY", "LINEAR_PUMP", "BOT_PUMP", "ZERO_SELLS", "ZERO_SELLS_FAKE_CHART", "ALL_BUYS_NO_SELLS", "FRESH_WALLET_RUG",
  "STAIRCASE_CHART", "STAIRCASE_FRESH", "FLATLINE_SPIKE", "FLATLINE_NO_SELLS", "FLATLINE_FRESH", "SMOOTH_GRIND", "NO_DIPS_GRIND", "LIQ_REMOVAL",
  "DEV_SELLING", "DEV_SELF_SNIPE", "DEV_SELF_PUMP", "DEV_PUMP_NO_SELLS", "FREEZE_AUTHORITY", "STOLEN_ART",
  "SYBIL_ATTACK", "PUMP_DUMP", "MCAP_CRASHING", "EARLY_DUMP", "BOT_FARM_VOLUME", "BOTTED_VOLUME", "FAKE_VOLUME_HIGH_SOL",
  "TOO_LATE", "STALE", "TOO_FEW_BUYERS", "TOO_YOUNG", "NO_SOCIALS", "FRESH_SOCIALS",
]);
