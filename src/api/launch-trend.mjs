// The market-cap history behind the launch banner's number: enough samples to draw a line and name a
// change over a period a person would recognise. Kept in memory on purpose — a restart costs the
// sparkline a few minutes of history and nothing else, which is cheaper than writing the volume every
// fifteen seconds for a decoration.
export const LAUNCH_HISTORY_MAX = 480;   // two hours at one sample per 15s
export const LAUNCH_SPARK_POINTS = 24;   // what the banner draws
export const LAUNCH_MIN_GAP_MS = 10_000; // never two samples closer than this, whoever calls us

export class LaunchTrend {
  constructor({ max = LAUNCH_HISTORY_MAX, points = LAUNCH_SPARK_POINTS, minGapMs = LAUNCH_MIN_GAP_MS } = {}) {
    this.max = max; this.points = points; this.minGapMs = minGapMs;
    this.key = ""; this.samples = [];
  }
  /** A token change is a new history: the old line belonged to a different launch. */
  reset(address = "") { this.key = address || ""; this.samples = []; }
  /** Record one chain reading. Silently ignores anything without a token and a real market cap. */
  record(address, data, now = Date.now()) {
    const mcap = Number(data?.mcapUsd) || 0;
    if (!address || !(mcap > 0)) return false;
    if (this.key !== address) this.reset(address);
    const last = this.samples[this.samples.length - 1];
    if (last && now - last.t < this.minGapMs) return false;
    this.samples.push({ t: now, mcap });
    if (this.samples.length > this.max) this.samples.shift();
    return true;
  }
  /** An evenly spaced sparkline, the change across it, and how long "across it" was. */
  read(address, now = Date.now()) {
    if (this.key !== address || this.samples.length < 2) return null;
    const s = this.samples, step = Math.max(1, Math.floor(s.length / this.points));
    const spark = [];
    for (let i = s.length - 1; i >= 0 && spark.length < this.points; i -= step) spark.unshift(Math.round(s[i].mcap));
    const first = s[0], last = s[s.length - 1];
    return {
      spark,
      changePct: first.mcap > 0 ? +(((last.mcap - first.mcap) / first.mcap) * 100).toFixed(1) : null,
      spanMin: Math.round((last.t - first.t) / 60_000),
      points: s.length,
    };
  }
}
