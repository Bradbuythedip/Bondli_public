/**
 * Module 7: Temporal & Market Regime
 *
 * Peak crypto activity: 15:00-17:00 UTC London PM / NYC AM overlap.
 * pump.fun: 40K-65K tokens/day baseline, 100K+ during hype.
 * Average liquid memecoin age on Solana: only 1.3 hours.
 *
 * Target: <10ms + workers
 */

import { createClient } from 'redis';

let redis = null;

async function getRedis() {
  if (!redis) {
    redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    redis.on('error', () => {}); // suppress connection errors in scoring
    try { await redis.connect(); } catch { redis = null; }
  }
  return redis;
}

const WEIGHTS = {
  hourOfDay: 0.15,
  marketMomentum: 0.20,
  fearGreed: 0.15,
  launchDensity: 0.15,
  dayOfWeek: 0.05,
  graduationRate: 0.10,
  viralRecency: 0.10,
  marketInefficiency: 0.10
};

/**
 * Hour of day scoring (UTC)
 * Peak: 15:00-17:00 UTC (London PM / NYC AM overlap)
 */
function scoreHourOfDay() {
  const hour = new Date().getUTCHours();

  // Peak: London PM / NYC AM overlap
  if (hour >= 15 && hour <= 17) return 1.0;
  // EU morning
  if (hour >= 9 && hour <= 13) return 0.7;
  // NYC afternoon
  if (hour >= 18 && hour <= 20) return 0.5;
  // Asia active
  if (hour >= 1 && hour <= 5) return 0.3;
  // Dead zone
  if (hour >= 2 && hour <= 6) return 0.1;
  // Default moderate
  return 0.4;
}

/**
 * Day of week scoring
 */
function scoreDayOfWeek() {
  const day = new Date().getUTCDay(); // 0=Sun
  const scores = {
    0: 0.3, // Sunday
    1: 0.7, // Monday
    2: 0.9, // Tuesday
    3: 1.0, // Wednesday
    4: 0.9, // Thursday
    5: 0.6, // Friday
    6: 0.3  // Saturday
  };
  return scores[day] ?? 0.5;
}

/**
 * Launch density inverse - less competition = more attention per token
 */
async function scoreLaunchDensityInverse() {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const hourlyLaunches = parseInt(await r.get('market:hourly_launches') || '0');
    const avgHourly = parseFloat(await r.get('market:avg_hourly_launches_7d') || '0');

    if (avgHourly === 0) return 0.5;

    const ratio = hourlyLaunches / avgHourly;
    if (ratio < 0.5) return 1.0;   // way below average = great
    if (ratio < 1.0) return 0.7;   // below average = good
    if (ratio < 1.5) return 0.4;   // above average = crowded
    return 0.1;                     // very crowded
  } catch {
    return 0.5;
  }
}

/**
 * Market momentum - BTC + SOL 24h change
 */
async function scoreMarketMomentum() {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const btcChange = parseFloat(await r.get('market:btc_24h_change') || '0');
    const solChange = parseFloat(await r.get('market:sol_24h_change') || '0');

    // Capitulation = very bearish but contrarian opportunity
    if (btcChange < -5 || solChange < -10) return 0.1;

    // Both strongly up = risk on
    if (btcChange > 3 && solChange > 5) return 0.9;

    // Both mildly up
    if (btcChange > 0 && solChange > 0) return 0.7;

    // Mixed signals
    if (btcChange > 0 || solChange > 0) return 0.5;

    // Both down
    return 0.3;
  } catch {
    return 0.5;
  }
}

/**
 * Graduation rate health - rolling 24h pump.fun graduation rate
 */
async function scoreGraduationRate() {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const gradRate = parseFloat(await r.get('market:graduation_rate_24h') || '0');

    if (gradRate > 0.02) return 1.0;   // >2% = healthy
    if (gradRate > 0.01) return 0.6;   // 1-2%
    if (gradRate > 0.005) return 0.3;  // 0.5-1%
    return 0.1;                         // <0.5% = dead market
  } catch {
    return 0.5;
  }
}

/**
 * Time since last viral token
 */
async function scoreViralRecency() {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const lastViralTs = parseInt(await r.get('market:last_viral_timestamp') || '0');
    if (lastViralTs === 0) return 0.5;

    const hoursSince = (Date.now() - lastViralTs) / (1000 * 60 * 60);
    // Exponential decay: e^(-hours/12)
    return Math.exp(-hoursSince / 12);
  } catch {
    return 0.5;
  }
}

/**
 * Fear & Greed alignment
 */
async function scoreFearGreedAlignment() {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const fgi = parseInt(await r.get('market:fear_greed_index') || '50');

    if (fgi >= 55 && fgi <= 75) return 1.0;   // Greed = optimal
    if (fgi > 75) return 0.9;                  // Extreme greed
    if (fgi >= 45 && fgi < 55) return 0.5;     // Neutral
    if (fgi >= 25 && fgi < 45) return 0.3;     // Fear
    if (fgi <= 20) return 0.4;                  // Extreme fear = contrarian
    return 0.5;
  } catch {
    return 0.5;
  }
}

/**
 * Market inefficiency - Shannon entropy of recent returns
 * Research: meme markets run 30-50% below efficient levels
 */
async function scoreMarketInefficiency() {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const inefficiency = parseFloat(await r.get('market:inefficiency_score') || '0.5');
    // Higher inefficiency = more edge = higher score
    return Math.min(1.0, inefficiency);
  } catch {
    return 0.5;
  }
}

/**
 * Main scoring function
 */
export async function scoreTemporal(input = {}) {
  try {
    const hourOfDay = scoreHourOfDay();
    const dayOfWeek = scoreDayOfWeek();

    // Parallel Redis lookups
    const [
      launchDensity,
      marketMomentum,
      graduationRate,
      viralRecency,
      fearGreed,
      marketInefficiency
    ] = await Promise.allSettled([
      scoreLaunchDensityInverse(),
      scoreMarketMomentum(),
      scoreGraduationRate(),
      scoreViralRecency(),
      scoreFearGreedAlignment(),
      scoreMarketInefficiency()
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : 0.5));

    const features = {
      hourOfDay,
      dayOfWeek,
      launchDensity,
      marketMomentum,
      graduationRate,
      viralRecency,
      fearGreed,
      marketInefficiency,
      utcHour: new Date().getUTCHours(),
      utcDay: new Date().getUTCDay()
    };

    const score = Math.max(0, Math.min(1.0,
      hourOfDay * WEIGHTS.hourOfDay +
      marketMomentum * WEIGHTS.marketMomentum +
      fearGreed * WEIGHTS.fearGreed +
      launchDensity * WEIGHTS.launchDensity +
      dayOfWeek * WEIGHTS.dayOfWeek +
      graduationRate * WEIGHTS.graduationRate +
      viralRecency * WEIGHTS.viralRecency +
      marketInefficiency * WEIGHTS.marketInefficiency
    ));

    return { score, features };
  } catch (err) {
    console.error('[temporal] Error:', err.message);
    return { score: 0.5, features: { error: err.message } };
  }
}

export default scoreTemporal;
