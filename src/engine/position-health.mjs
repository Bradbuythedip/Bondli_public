// BONDLI — Post-Entry Health Monitor
//
// Everyone checks safety at entry. Nobody monitors token health WHILE you hold.
//
// Continuous health scoring on every active position (every 30 seconds):
//   A: Growing community, positive sentiment, new holders → hold/add
//   B: Stable community, neutral sentiment → hold, tighten stops
//   C: Declining engagement, holders leaving → begin graduated exit
//   D: Community dead, only bots remain → exit immediately
//   F: Dev activity detected → emergency exit

const HEALTH_GRADES = {
  A: { label: "A", color: "#00ff88", action: "HOLD_ADD", desc: "Growing — new holders, positive sentiment" },
  B: { label: "B", color: "#44aaff", action: "HOLD", desc: "Stable — tighten stops" },
  C: { label: "C", color: "#ffaa00", action: "GRADUATED_EXIT", desc: "Declining — begin exiting" },
  D: { label: "D", color: "#ff6644", action: "EXIT_NOW", desc: "Dead — exit immediately" },
  F: { label: "F", color: "#ff0000", action: "EMERGENCY_EXIT", desc: "Dev activity — emergency exit" },
};

export class PositionHealthMonitor {
  constructor() {
    // positionId → { grade, history: [{ time, grade, score, metrics }], alerts: [] }
    this.positions = new Map();
    this.CHECK_INTERVAL = 30_000; // 30s between checks
  }

  /**
   * Record a health check snapshot for a position.
   * Called by the main loop every 30 seconds per active position.
   *
   * @param {string} posId - Position identifier (typically mint address)
   * @param {Object} metrics - Current health metrics
   */
  checkHealth(posId, metrics) {
    if (!this.positions.has(posId)) {
      this.positions.set(posId, { grade: "B", history: [], alerts: [], trend: "stable" });
    }

    const pos = this.positions.get(posId);
    const score = this._calcHealthScore(metrics);
    const grade = this._scoreToGrade(score);

    // Detect grade changes
    const prevGrade = pos.grade;
    const gradeChanged = grade !== prevGrade;
    pos.grade = grade;

    // Record history
    pos.history.push({
      time: Date.now(),
      grade,
      score,
      metrics: { ...metrics },
    });

    // Keep last 120 snapshots (~60 minutes at 30s intervals)
    if (pos.history.length > 120) pos.history.shift();

    // Calculate trend
    pos.trend = this._calcTrend(pos.history);

    // Generate alerts on grade changes
    if (gradeChanged) {
      const direction = "ABCDF".indexOf(grade) > "ABCDF".indexOf(prevGrade) ? "DEGRADED" : "IMPROVED";
      pos.alerts.push({
        time: Date.now(),
        from: prevGrade,
        to: grade,
        direction,
        message: `Health ${direction.toLowerCase()}: ${prevGrade}${pos.trend === "declining" ? "↓" : pos.trend === "rising" ? "↑" : "→"} ${grade}`,
      });
      if (pos.alerts.length > 20) pos.alerts.shift();
    }

    return {
      grade,
      gradeInfo: HEALTH_GRADES[grade],
      score,
      trend: pos.trend,
      gradeChanged,
      alerts: pos.alerts.slice(-5),
    };
  }

  /**
   * Calculate health score (0-100) from multiple metrics.
   */
  _calcHealthScore(m) {
    let score = 0;

    // Community activity (0-25 pts)
    // Active message volume, unique posters
    const communityActivity = Math.min(1, (m.messageVolume || 0) / 50); // normalize
    const posterDiversity = Math.min(1, (m.uniquePosters || 0) / 20);
    score += (communityActivity * 0.5 + posterDiversity * 0.5) * 25;

    // Holder behavior (0-25 pts)
    // New buyers arriving vs holders leaving
    const newBuyerRate = Math.min(1, (m.newBuyers5m || 0) / 5);
    const sellPressure = Math.min(1, (m.sells5m || 0) / (Math.max(1, m.buys5m || 0)));
    const holderScore = newBuyerRate * 0.6 + (1 - sellPressure) * 0.4;
    score += holderScore * 25;

    // Sentiment (0-20 pts)
    // m.sentiment: -1 to 1 (from social monitors)
    const sentimentNorm = ((m.sentiment || 0) + 1) / 2; // 0 to 1
    score += sentimentNorm * 20;

    // Engagement half-life (0-15 pts)
    // How fast is attention decaying?
    const halfLife = Math.min(1, (m.engagementHalfLife || 30) / 60); // minutes, normalize to 60min
    score += halfLife * 15;

    // Dev safety (0-15 pts)
    // Any dev wallet movements = instant penalty
    if (m.devSelling) {
      score -= 40; // severe — overrides everything
    } else if (m.devMoving) {
      score -= 20; // dev moving tokens but not selling yet
    } else {
      score += 15; // clean
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  _scoreToGrade(score) {
    if (score >= 75) return "A";
    if (score >= 55) return "B";
    if (score >= 35) return "C";
    if (score >= 15) return "D";
    return "F";
  }

  _calcTrend(history) {
    if (history.length < 4) return "stable";
    const recent = history.slice(-6);
    const firstHalf = recent.slice(0, Math.ceil(recent.length / 2));
    const secondHalf = recent.slice(Math.ceil(recent.length / 2));
    const avgFirst = firstHalf.reduce((s, h) => s + h.score, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, h) => s + h.score, 0) / secondHalf.length;
    if (avgSecond > avgFirst + 5) return "rising";
    if (avgSecond < avgFirst - 5) return "declining";
    return "stable";
  }

  /**
   * Get health summary for a position.
   */
  getHealth(posId) {
    const pos = this.positions.get(posId);
    if (!pos) return { grade: "B", gradeInfo: HEALTH_GRADES.B, trend: "stable", alerts: [] };
    return {
      grade: pos.grade,
      gradeInfo: HEALTH_GRADES[pos.grade],
      trend: pos.trend,
      alerts: pos.alerts.slice(-5),
      history: pos.history.slice(-20).map(h => ({ time: h.time, grade: h.grade, score: h.score })),
    };
  }

  /**
   * Get exit recommendation based on health grade.
   */
  getExitAction(posId) {
    const pos = this.positions.get(posId);
    if (!pos) return null;

    const gradeInfo = HEALTH_GRADES[pos.grade];
    if (!gradeInfo) return null;

    if (pos.grade === "F") return { action: "EMERGENCY_EXIT", sellPct: 100, reason: "Dev activity detected" };
    if (pos.grade === "D") return { action: "EXIT_NOW", sellPct: 100, reason: "Community dead" };
    if (pos.grade === "C" && pos.trend === "declining") return { action: "GRADUATED_EXIT", sellPct: 50, reason: "Declining health" };
    if (pos.grade === "C") return { action: "TIGHTEN_STOPS", sellPct: 0, reason: "Health declining" };
    return null;
  }

  /**
   * Remove a position (on trade exit).
   */
  removePosition(posId) {
    this.positions.delete(posId);
  }
}

export { HEALTH_GRADES };
export default PositionHealthMonitor;
