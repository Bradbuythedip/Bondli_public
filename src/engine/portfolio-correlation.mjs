// BONDLI — Portfolio Correlation Awareness
//
// Everyone thinks per-token. Nobody warns you that your 4 positions all die together.
//
// CORRELATION DIMENSIONS:
//   Narrative: "3 of 4 positions are AI tokens. If AI cools, all 3 die."
//   Developer: "2 positions share same dev. Dev rugs one, likely rugs both."
//   Trend: "All launched from same Musk tweet. Trend decelerating."
//   Holder overlap: "65% of Token A holders also hold Token B."
//   Archetype: "All camp_absurdist. Diversify."
//
// Auto-ape Gate 4 blocks entries that push correlation above threshold.

import { classifyToken } from "./meta-engine.mjs";

const MAX_NARRATIVE_CONCENTRATION = 0.60; // max 60% in one narrative
const MAX_DEV_OVERLAP = 2;                // max 2 tokens from same dev
const MAX_TREND_CORRELATION = 0.70;       // max 70% correlation

export class PortfolioCorrelation {
  constructor() {
    this.positions = new Map(); // ca → { narrative, devWallet, archetype, entryTime, holders }
  }

  /**
   * Register an active position for correlation tracking.
   */
  addPosition(token) {
    const classification = classifyToken(token);
    this.positions.set(token.ca, {
      ca: token.ca,
      name: token.name || token.ticker,
      narrative: classification.primary,
      allNarratives: classification.all,
      devWallet: (token.devWallet || "").toLowerCase(),
      archetype: token.archetype || "unknown",
      entryTime: Date.now(),
      entryMcap: token.mcapUsd || 0,
    });
  }

  /**
   * Remove a position (on exit).
   */
  removePosition(ca) {
    this.positions.delete(ca);
  }

  /**
   * Analyze current portfolio correlations.
   */
  analyze() {
    const positions = [...this.positions.values()];
    if (positions.length < 2) return { risk: "LOW", correlations: [], warnings: [] };

    const warnings = [];
    const correlations = [];

    // 1. Narrative concentration
    const narrativeCounts = {};
    for (const p of positions) {
      narrativeCounts[p.narrative] = (narrativeCounts[p.narrative] || 0) + 1;
    }
    for (const [narr, count] of Object.entries(narrativeCounts)) {
      const pct = count / positions.length;
      if (pct > MAX_NARRATIVE_CONCENTRATION && count >= 2) {
        warnings.push({
          type: "NARRATIVE_CONCENTRATION",
          severity: pct > 0.8 ? "HIGH" : "MEDIUM",
          message: `${count} of ${positions.length} positions are ${narr} tokens. If ${narr} narrative cools, all die.`,
          narrative: narr,
          count,
          pct: +(pct * 100).toFixed(0),
        });
      }
      correlations.push({
        dimension: "narrative",
        key: narr,
        count,
        pct: +(pct * 100).toFixed(0),
      });
    }

    // 2. Developer overlap
    const devCounts = {};
    for (const p of positions) {
      if (p.devWallet) {
        devCounts[p.devWallet] = (devCounts[p.devWallet] || []);
        devCounts[p.devWallet].push(p.name);
      }
    }
    for (const [dev, tokens] of Object.entries(devCounts)) {
      if (tokens.length >= MAX_DEV_OVERLAP) {
        warnings.push({
          type: "DEV_OVERLAP",
          severity: "HIGH",
          message: `${tokens.join(", ")} share dev wallet ${dev.slice(0, 8)}... If dev rugs one, likely rugs all.`,
          devWallet: dev,
          tokens,
        });
      }
    }

    // 3. Temporal clustering (all entered in same narrow window)
    const entryTimes = positions.map(p => p.entryTime).sort();
    const timeSpan = entryTimes[entryTimes.length - 1] - entryTimes[0];
    if (positions.length >= 3 && timeSpan < 10 * 60_000) { // 3+ positions in 10 min
      warnings.push({
        type: "TEMPORAL_CLUSTER",
        severity: "MEDIUM",
        message: `${positions.length} positions entered within ${Math.round(timeSpan / 60_000)} minutes. Likely all riding same trend.`,
      });
    }

    // 4. Archetype concentration
    const archetypeCounts = {};
    for (const p of positions) {
      archetypeCounts[p.archetype] = (archetypeCounts[p.archetype] || 0) + 1;
    }
    for (const [arch, count] of Object.entries(archetypeCounts)) {
      if (count >= 3 && arch !== "unknown") {
        warnings.push({
          type: "ARCHETYPE_CONCENTRATION",
          severity: "MEDIUM",
          message: `${count} positions are ${arch} archetype. Diversify into different archetypes.`,
          archetype: arch,
          count,
        });
      }
    }

    // Overall risk level
    const highWarnings = warnings.filter(w => w.severity === "HIGH").length;
    const medWarnings = warnings.filter(w => w.severity === "MEDIUM").length;
    let risk;
    if (highWarnings >= 2) risk = "CRITICAL";
    else if (highWarnings >= 1) risk = "HIGH";
    else if (medWarnings >= 2) risk = "MEDIUM";
    else risk = "LOW";

    return {
      risk,
      positionCount: positions.length,
      correlations,
      warnings,
      // Heatmap data for UI
      heatmap: this._buildHeatmap(positions),
    };
  }

  /**
   * Check if a new entry would push correlation above thresholds.
   * Used by Gate 4 (portfolio constraints).
   *
   * @param {Object} token - Candidate token
   * @returns {{ allowed: boolean, reason: string }}
   */
  checkEntry(token) {
    const classification = classifyToken(token);
    const positions = [...this.positions.values()];

    if (positions.length === 0) return { allowed: true, reason: "Empty portfolio" };

    // Check narrative concentration
    const sameNarrative = positions.filter(p => p.narrative === classification.primary).length;
    const newPct = (sameNarrative + 1) / (positions.length + 1);
    if (newPct > MAX_NARRATIVE_CONCENTRATION && sameNarrative >= 2) {
      return {
        allowed: false,
        reason: `Would push ${classification.primary} concentration to ${Math.round(newPct * 100)}%. Max: ${MAX_NARRATIVE_CONCENTRATION * 100}%.`,
      };
    }

    // Check dev overlap
    const devWallet = (token.devWallet || "").toLowerCase();
    if (devWallet) {
      const sameDev = positions.filter(p => p.devWallet === devWallet).length;
      if (sameDev >= MAX_DEV_OVERLAP) {
        return {
          allowed: false,
          reason: `Already have ${sameDev} tokens from same dev wallet. Max: ${MAX_DEV_OVERLAP}.`,
        };
      }
    }

    return { allowed: true, reason: "Within correlation limits" };
  }

  /**
   * Build correlation heatmap for UI display.
   * Returns NxN matrix of pairwise correlation scores.
   */
  _buildHeatmap(positions) {
    const n = positions.length;
    if (n < 2) return [];

    const matrix = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let j = 0; j < n; j++) {
        if (i === j) {
          row.push(1.0);
        } else {
          row.push(this._pairCorrelation(positions[i], positions[j]));
        }
      }
      matrix.push({
        token: positions[i].name || positions[i].ca.slice(0, 8),
        ca: positions[i].ca,
        correlations: row,
      });
    }
    return matrix;
  }

  _pairCorrelation(a, b) {
    let corr = 0;
    // Same narrative: +0.4
    if (a.narrative === b.narrative) corr += 0.4;
    // Overlapping narratives
    const overlap = a.allNarratives?.filter(n => b.allNarratives?.includes(n)).length || 0;
    if (overlap > 0) corr += overlap * 0.1;
    // Same dev: +0.5
    if (a.devWallet && a.devWallet === b.devWallet) corr += 0.5;
    // Same archetype: +0.2
    if (a.archetype && a.archetype === b.archetype) corr += 0.2;
    // Close entry times: +0.2
    if (Math.abs(a.entryTime - b.entryTime) < 5 * 60_000) corr += 0.2;

    return Math.min(1, +corr.toFixed(2));
  }
}

export default PortfolioCorrelation;
