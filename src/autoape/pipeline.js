// ═══ BONDLI AUTO-APE ENGINE — 5-GATE PIPELINE ═══
// Every gate is a kill gate. Failing any = no entry.
// Gates ordered cheapest→most expensive to reject fast.
//
// Gate 1: Hard Disqualifiers (instant reject, <5ms)
// Gate 2: Minimum Viability (score + feature floors, <10ms)
// Gate 3: Confidence Classification (tier assignment, <5ms)
// Gate 4: Portfolio Constraints (bankroll, exposure, correlation, <5ms)
// Gate 5: Timing & Execution Window (is the window still open?, <5ms)

import { curvePctOf } from "./gates/curve.js";
import { checkDisqualifiers } from "./gates/disqualifiers.js";
import { checkViability } from "./gates/viability.js";
import { classifyConfidence } from "./gates/confidence.js";
import { checkPortfolioConstraints } from "./gates/portfolio.js";
import { checkExecutionWindow } from "./gates/execution-window.js";
import { calculatePositionSize } from "./sizing.js";
import { createExitPlan, checkDerivativeExit, checkThresholdExit, checkTrailingExit, checkGraduationExit, checkVolumeExit } from "./exit-plan.js";
import { checkWatchlistPromotion, checkMissedReentry, checkPostExitReentry, checkDipDCA } from "./recovery.js";
import { evaluateToken as bradEvaluateToken, evaluatePosition as bradEvaluatePosition, isHealthy as bradIsHealthy } from "../engine/brad-client.mjs";

// Run the full 5-gate pipeline for a single token
// Now enhanced with BRAD cognitive engine pre-evaluation
export function runPipeline(token, qf, scores, dynamics, portfolio) {
  const result = {
    ca: token.ca,
    name: token.name || token.ca?.slice(0, 8),
    gates: {},
    decision: "REJECT",
    tier: 0,
    tierLabel: "REJECT",
    positionSize: null,
    exitPlan: null,
    rejectGate: null,
    rejectReason: null,
    timing: {},
    brad: null, // BRAD cognitive evaluation (attached if available)
  };

  const t0 = Date.now();

  // ═══ BRAD PRE-EVALUATION (async result attached by caller) ═══
  // If the caller ran bradEvaluateToken() and attached result to token._bradEval,
  // use it as a pre-filter. BRAD's meta-cognitive layer can veto entries
  // when it detects systematic errors (overconfidence, revenge trading, regime blindness).
  if (token._bradEval) {
    result.brad = token._bradEval;
    const bradAction = token._bradEval.action;
    const bradConfidence = token._bradEval.confidence || 0;

    // BRAD SKIP with high confidence = hard reject (meta-cognitive veto)
    if (bradAction === "SKIP" && bradConfidence >= 0.8) {
      result.rejectGate = 0; // Gate 0 = BRAD cognitive layer
      result.rejectReason = `BRAD veto: ${(token._bradEval.reasoning || []).join("; ")}`;
      result.timing.brad = Date.now() - t0;
      return result;
    }
  }

  // ═══ GATE 1: HARD DISQUALIFIERS ═══
  const g1 = checkDisqualifiers(token, qf);
  result.gates.disqualifiers = g1;
  result.timing.gate1 = Date.now() - t0;
  if (!g1.pass) {
    result.rejectGate = 1;
    result.rejectReason = g1.flags.join(", ");
    return result;
  }

  // ═══ GATE 2: MINIMUM VIABILITY ═══
  const t2 = Date.now();
  const g2 = checkViability(token, qf, scores, dynamics);
  result.gates.viability = g2;
  result.timing.gate2 = Date.now() - t2;
  if (!g2.pass) {
    result.rejectGate = 2;
    result.rejectReason = g2.checks.join(", ");
    return result;
  }

  // ═══ GATE 3: CONFIDENCE CLASSIFICATION ═══
  const t3 = Date.now();
  const g3 = classifyConfidence(token, qf, scores, dynamics);
  result.gates.confidence = g3;
  result.tier = g3.tier;
  result.tierLabel = g3.label;
  result.timing.gate3 = Date.now() - t3;

  // Tier 4 (WATCHLIST) = don't enter, just monitor
  if (g3.tier >= 4 || g3.tier === 0) {
    result.decision = g3.tier === 4 ? "WATCHLIST" : "REJECT";
    result.rejectGate = 3;
    result.rejectReason = g3.tier === 4 ? "WATCHLIST" : g3.reasons.join(", ");
    return result;
  }

  // ═══ GATE 4: PORTFOLIO CONSTRAINTS ═══
  const t4 = Date.now();
  // Calculate preliminary position size for constraint checking
  const prelimSize = calculatePositionSize(g3.tier, scores, portfolio, dynamics);
  const g4 = checkPortfolioConstraints(g3.tier, prelimSize.solAmount, portfolio, token);
  result.gates.portfolio = g4;
  result.timing.gate4 = Date.now() - t4;
  if (!g4.pass) {
    result.rejectGate = 4;
    result.rejectReason = g4.checks.join(", ");
    return result;
  }

  // ═══ GATE 5: EXECUTION WINDOW ═══
  const t5 = Date.now();
  const g5 = checkExecutionWindow(token, g3.tier, scores.scoreTimestamp);
  result.gates.executionWindow = g5;
  result.timing.gate5 = Date.now() - t5;
  if (!g5.pass) {
    result.rejectGate = 5;
    result.rejectReason = g5.checks.join(", ");
    return result;
  }

  // ═══ ALL GATES PASSED — ENTRY DECISION: GO ═══
  result.decision = "ENTER";
  result.positionSize = prelimSize;

  // ═══ BRAD SIZING CAP ═══
  // If BRAD is active and recommends a smaller position, cap bondli's size.
  // BRAD's meta-cognitive layer may reduce sizing when it detects overconfidence
  // or regime mismatch. BRAD's size acts as a ceiling, not a floor.
  if (token._bradEval && token._bradEval.action === "APE" && token._bradEval.position_size_sol > 0) {
    const bradMaxSol = token._bradEval.position_size_sol;
    if (prelimSize.solAmount > bradMaxSol) {
      result.positionSize = {
        ...prelimSize,
        solAmount: bradMaxSol,
        bradCapped: true,
        bradOriginal: prelimSize.solAmount,
      };
    }
    // Attach BRAD's confidence as additional signal for downstream use
    result.bradConfidence = token._bradEval.confidence || 0;
    result.bradStrategy = token._bradEval.strategy || "";
  }

  // Attach exit plan
  result.exitPlan = createExitPlan(g3.tier, scores.apeScore || 0, portfolio.settings || {});

  result.timing.total = Date.now() - t0;
  return result;
}

// Run exit checks on an existing position (called every tick)
// Enhanced with BRAD cognitive exit layer (Layer 0 — highest priority)
export function runExitChecks(pos, token, dynamics, settings) {
  if (!token || !pos) return null;

  const currentMcap = token.mcapUsd || 0;
  if (pos.entryMcap <= 0) return null;

  const changePct = ((currentMcap - pos.entryMcap) / pos.entryMcap) * 100;
  pos.peakMcap = Math.max(pos.peakMcap || pos.entryMcap, currentMcap);
  const fromPeak = pos.peakMcap > 0 ? ((pos.peakMcap - currentMcap) / pos.peakMcap) * 100 : 0;

  // ═══ LAYER 0: BRAD COGNITIVE EXIT (meta-cognitive intervention) ═══
  // If BRAD's meta-cognitive layer (L2) detected a blind spot and recommends exit,
  // this takes highest priority. BRAD catches systematic patterns that per-position
  // checks miss: loss aversion (holding losers too long), regime blindness, etc.
  if (pos._bradExitEval) {
    const bradExit = pos._bradExitEval;
    if (bradExit.action === "EXIT" && bradExit.confidence >= 0.7) {
      return {
        action: "SELL", pct: 100, reason: "brad-exit", layer: 0,
        detail: `BRAD L2: ${(bradExit.reasoning || []).slice(0, 2).join("; ")}`,
        changePct, fromPeak, currentMcap,
      };
    }
    if (bradExit.action === "PARTIAL_EXIT" && bradExit.confidence >= 0.7) {
      const exitPct = Math.round((bradExit.exit_pct || 0.33) * 100);
      return {
        action: "PARTIAL_SELL", pct: exitPct || 33, reason: "brad-partial", layer: 0,
        detail: `BRAD L2: ${(bradExit.reasoning || []).slice(0, 2).join("; ")}`,
        changePct, fromPeak, currentMcap,
      };
    }
    // Clean up after processing
    delete pos._bradExitEval;
  }

  // Layer 1: Derivative exits (highest priority, leading indicators).
  //
  // Only an ACTUAL EXIT may return from here. checkDerivativeExit also emits two plan adjustments,
  // WIDEN_TPS and TIGHTEN_SLS, and returning those the same way meant that on any tick where the
  // live score sat 10 points below the entry score -- which is to say, on every tick of a position
  // that is dying -- the stop loss, the trail, the graduation exit and the volume exit were all
  // skipped. The one layer that could still fire was layer 1 itself, which is why a real run of forty
  // closes contains fourteen crash-exits and not a single SL1 or SL2.
  //
  // An adjustment is a change to the plan, so it is held and returned only if nothing else fires.
  let adjustment = null;
  const hasRadarData = token.buys != null && token.trades != null;
  if (settings.momentumExit && hasRadarData && !pos.isMoonbag) {
    const deriv = checkDerivativeExit(pos, dynamics, changePct, settings);
    if (deriv && (deriv.action === "SELL" || deriv.action === "PARTIAL_SELL")) return { ...deriv, changePct, fromPeak, currentMcap };
    if (deriv) adjustment = deriv;
  }

  // Sell-into-volume
  const volExit = checkVolumeExit(pos, token, changePct);
  if (volExit) return { ...volExit, changePct, fromPeak, currentMcap };

  // Layer 4: Graduation exit (check before trailing — graduation is time-critical)
  const curvePct = curvePctOf(token);
  const gradExit = checkGraduationExit(pos, changePct, curvePct);
  if (gradExit) return { ...gradExit, changePct, fromPeak, currentMcap };

  // Layer 3: Trailing profit stops
  const trail = checkTrailingExit(pos, changePct, fromPeak, settings);
  if (trail) return { ...trail, changePct, fromPeak, currentMcap };

  // Layer 2: Absolute thresholds (safety net)
  const thresh = checkThresholdExit(pos, changePct, settings);
  if (thresh) return { ...thresh, changePct, fromPeak, currentMcap };

  // Nothing wants out: now the plan may be adjusted.
  if (adjustment) return { ...adjustment, changePct, fromPeak, currentMcap };
  return null;
}

// Export all submodules for direct access
export {
  checkDisqualifiers,
  checkViability,
  classifyConfidence,
  checkPortfolioConstraints,
  checkExecutionWindow,
  calculatePositionSize,
  createExitPlan,
  checkDerivativeExit,
  checkThresholdExit,
  checkTrailingExit,
  checkGraduationExit,
  checkVolumeExit,
  checkWatchlistPromotion,
  checkMissedReentry,
  checkPostExitReentry,
  checkDipDCA,
  bradEvaluateToken,
  bradEvaluatePosition,
  bradIsHealthy,
};
