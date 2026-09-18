// BONDLI v3.0 — Redis-backed Rate Limiter
import { createClient } from "redis";

let redis = null;

export async function initRedis(url) {
  try {
    redis = createClient({ url: url || process.env.REDIS_URL || "redis://localhost:6379" });
    redis.on("error", () => {});
    await redis.connect();
    console.log("[REDIS] Connected");
    return redis;
  } catch (e) {
    console.warn("[REDIS] Skipping — not available:", e.message);
    redis = null;
    return null;
  }
}

export function getRedis() { return redis; }

// Sliding window rate limiter
export function rateLimit(opts = {}) {
  const {
    windowMs = 60_000,
    max = 30,
    keyPrefix = "rl:",
    message = "Too many requests, slow down.",
  } = opts;

  return async (req, res, next) => {
    if (!redis) return next();

    // Key by wallet first (more accurate), fallback to IP
    const wallet = req.headers["x-wallet"] || req.query?.wallet || req.body?.wallet;
    const ip = req.headers["x-real-ip"] || req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    const key = `${keyPrefix}${wallet || ip}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    try {
      await redis.zRemRangeByScore(key, 0, windowStart);
      const count = await redis.zCard(key);

      if (count >= max) {
        const oldest = await redis.zRange(key, 0, 0, { withScores: true });
        const retryAfter = oldest.length ? Math.ceil((oldest[0].score + windowMs - now) / 1000) : 60;

        res.set("Retry-After", retryAfter.toString());
        res.set("X-RateLimit-Limit", max.toString());
        res.set("X-RateLimit-Remaining", "0");
        return res.status(429).json({ error: message, retryAfter });
      }

      await redis.zAdd(key, { score: now, value: `${now}:${Math.random().toString(36).slice(2, 8)}` });
      await redis.expire(key, Math.ceil(windowMs / 1000) + 1);

      res.set("X-RateLimit-Limit", max.toString());
      res.set("X-RateLimit-Remaining", (max - count - 1).toString());
      next();
    } catch (e) {
      // On Redis error, let request through
      next();
    }
  };
}

// API: 300/min (polling uses ~60, user actions need headroom)
export const apiLimiter = rateLimit({ max: 300, windowMs: 60_000, keyPrefix: "rl:api:" });
// Launch: 5 per 5 min
export const launchLimiter = rateLimit({ max: 5, windowMs: 300_000, keyPrefix: "rl:launch:", message: "Launch rate limited. Max 5 per 5 minutes." });
// Payment: 15/min
export const paymentLimiter = rateLimit({ max: 15, windowMs: 60_000, keyPrefix: "rl:pay:" });
// WS: 10/min
export const wsLimiter = rateLimit({ max: 10, windowMs: 60_000, keyPrefix: "rl:ws:" });
