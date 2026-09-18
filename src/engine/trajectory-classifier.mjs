/**
 * Exit Engine Enhancement: Trajectory Classification
 *
 * Little & Xiao (2025) classified memes into four canonical post-peak trajectories.
 * Classifies trajectory every tick cycle by fitting the last N score readings.
 *
 * Trajectories:
 *   - flash_decay: Score in freefall. Exit immediately.
 *   - oscillatory_decay: Oscillates with decreasing amplitude. Exit on next bounce peak.
 *   - plateau: Score stabilized. Hold if profitable, tighten stops.
 *   - sustained_growth: Score velocity positive. Hold, widen trailing stops.
 */

const MIN_READINGS = 5;
const DEFAULT_WINDOW = 20;

/**
 * Compute first and second derivatives of a score series
 */
function computeDerivatives(readings) {
  if (readings.length < 2) return { velocity: 0, acceleration: 0 };

  // First derivative (velocity): d(score)/dt
  const velocities = [];
  for (let i = 1; i < readings.length; i++) {
    const dt = readings[i].timestamp - readings[i - 1].timestamp;
    if (dt === 0) continue;
    velocities.push((readings[i].score - readings[i - 1].score) / (dt / 1000));
  }

  const velocity = velocities.length > 0
    ? velocities.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, velocities.length)
    : 0;

  // Second derivative (acceleration): d²(score)/dt²
  const accelerations = [];
  for (let i = 1; i < velocities.length; i++) {
    const dt = readings[i + 1].timestamp - readings[i].timestamp;
    if (dt === 0) continue;
    accelerations.push((velocities[i] - velocities[i - 1]) / (dt / 1000));
  }

  const acceleration = accelerations.length > 0
    ? accelerations.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, accelerations.length)
    : 0;

  return { velocity, acceleration };
}

/**
 * Detect oscillation pattern (peaks and troughs)
 */
function detectOscillation(readings) {
  if (readings.length < 5) return { isOscillating: false, peakAmplitudes: [] };

  const scores = readings.map(r => r.score);
  const peaks = [];
  const troughs = [];

  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i] > scores[i - 1] && scores[i] > scores[i + 1]) peaks.push({ index: i, score: scores[i] });
    if (scores[i] < scores[i - 1] && scores[i] < scores[i + 1]) troughs.push({ index: i, score: scores[i] });
  }

  if (peaks.length < 2) return { isOscillating: false, peakAmplitudes: [] };

  // Check if peak amplitudes are decreasing
  const peakAmplitudes = peaks.map(p => p.score);
  let isDecreasing = true;
  for (let i = 1; i < peakAmplitudes.length; i++) {
    if (peakAmplitudes[i] >= peakAmplitudes[i - 1]) {
      isDecreasing = false;
      break;
    }
  }

  // Check if at a peak right now (for exit timing)
  const lastScore = scores[scores.length - 1];
  const prevScore = scores[scores.length - 2];
  const isAtPeak = lastScore < prevScore && peaks.length > 0;

  return {
    isOscillating: true,
    isDecayingOscillation: isDecreasing,
    peakAmplitudes,
    peaks,
    troughs,
    isAtPeak
  };
}

/**
 * Classify the trajectory pattern
 *
 * @param {Array<{score: number, timestamp: number}>} readings - Recent score readings
 * @returns {Object} Classification result
 */
export function classifyTrajectory(readings) {
  if (!readings || readings.length < MIN_READINGS) {
    return {
      type: 'insufficient_data',
      confidence: 0,
      recommendation: 'hold',
      details: {}
    };
  }

  // Use last N readings
  const window = readings.slice(-DEFAULT_WINDOW);
  const { velocity, acceleration } = computeDerivatives(window);
  const oscillation = detectOscillation(window);

  // Compute trend metrics
  const scores = window.map(r => r.score);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const scoreVariance = scores.reduce((a, b) => a + (b - avgScore) ** 2, 0) / scores.length;
  const recentTrend = scores.slice(-3).reduce((a, b) => a + b, 0) / 3 - scores.slice(0, 3).reduce((a, b) => a + b, 0) / 3;

  // Classification logic

  // 1. Flash Decay: velocity strongly negative, acceleration negative
  if (velocity < -0.01 && acceleration < 0) {
    return {
      type: 'flash_decay',
      confidence: Math.min(1.0, Math.abs(velocity) * 50),
      recommendation: 'exit_immediately',
      details: { velocity, acceleration, avgScore },
      exitPriority: 'layer1_derivative'
    };
  }

  // 2. Oscillatory Decay: oscillating with decreasing amplitude
  if (oscillation.isOscillating && oscillation.isDecayingOscillation) {
    return {
      type: 'oscillatory_decay',
      confidence: 0.7,
      recommendation: oscillation.isAtPeak ? 'exit_on_bounce' : 'wait_for_peak',
      details: {
        velocity, acceleration,
        peakAmplitudes: oscillation.peakAmplitudes,
        isAtPeak: oscillation.isAtPeak
      },
      exitPriority: 'layer2_trailing'
    };
  }

  // 3. Plateau: velocity near zero, acceleration near zero
  if (Math.abs(velocity) < 0.002 && Math.abs(acceleration) < 0.001 && scoreVariance < 0.005) {
    return {
      type: 'plateau',
      confidence: Math.min(1.0, 1.0 - scoreVariance * 100),
      recommendation: avgScore > 0.5 ? 'hold_tighten_stops' : 'exit_if_unprofitable',
      details: { velocity, acceleration, avgScore, variance: scoreVariance },
      exitPriority: 'layer3_absolute'
    };
  }

  // 4. Sustained Growth: velocity positive, acceleration >= 0
  if (velocity > 0.002 && acceleration >= -0.001 && recentTrend > 0) {
    return {
      type: 'sustained_growth',
      confidence: Math.min(1.0, velocity * 100),
      recommendation: 'hold_widen_stops',
      details: { velocity, acceleration, avgScore, recentTrend },
      exitPriority: 'none'
    };
  }

  // Default: uncertain
  return {
    type: 'uncertain',
    confidence: 0.3,
    recommendation: 'hold',
    details: { velocity, acceleration, avgScore, scoreVariance },
    exitPriority: 'layer3_absolute'
  };
}

/**
 * Get dynamic exit parameters based on trajectory classification
 */
export function getExitParams(trajectory, baseParams = {}) {
  const params = { ...baseParams };

  switch (trajectory.type) {
    case 'flash_decay':
      // Exit immediately - override all other exit logic
      params.forceExit = true;
      params.reason = 'flash_decay';
      break;

    case 'oscillatory_decay':
      if (trajectory.details?.isAtPeak) {
        params.forceExit = true;
        params.reason = 'oscillatory_decay_peak';
      } else {
        // Tighten trailing stop to catch next peak
        params.trailingStopPercent = Math.max(0.03, (params.trailingStopPercent || 0.1) * 0.5);
        params.reason = 'oscillatory_decay_waiting';
      }
      break;

    case 'plateau':
      // Tighten stops, lower targets
      params.trailingStopPercent = Math.max(0.05, (params.trailingStopPercent || 0.1) * 0.7);
      params.reason = 'plateau';
      break;

    case 'sustained_growth':
      // Widen trailing stops to let it run
      params.trailingStopPercent = Math.min(0.3, (params.trailingStopPercent || 0.1) * 1.5);
      params.reason = 'sustained_growth';
      break;

    default:
      params.reason = 'default';
  }

  return params;
}

/**
 * Score reading accumulator for a position
 */
export class TrajectoryTracker {
  constructor(maxReadings = 100) {
    this.readings = [];
    this.maxReadings = maxReadings;
  }

  addReading(score) {
    this.readings.push({ score, timestamp: Date.now() });
    if (this.readings.length > this.maxReadings) {
      this.readings.shift();
    }
  }

  classify() {
    return classifyTrajectory(this.readings);
  }

  getExitParams(baseParams) {
    return getExitParams(this.classify(), baseParams);
  }
}

export default { classifyTrajectory, getExitParams, TrajectoryTracker };
