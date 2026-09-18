// BONDLI v3.0 — Security Middleware
import crypto from "crypto";

const ALLOWED_ORIGINS = new Set([
  "https://bondli.fun",
  "https://www.bondli.fun",
  "https://bondli-production.up.railway.app",
  // Add your Vercel URL here after deploy, e.g.:
  // "https://bondli-xxxx.vercel.app",
  ...(process.env.NODE_ENV !== "production" ? ["http://localhost:5173", "http://localhost:3001"] : []),
]);

// Also allow any vercel preview URL
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (origin.endsWith(".vercel.app")) return true;
  return false;
}

// CORS
export function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

// Security headers
export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.removeHeader("X-Powered-By");
  next();
}

// Request ID for tracing
export function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader("X-Request-ID", req.id);
  next();
}

// Request size limit
export function bodyLimit(maxBytes = 100_000) {
  return (req, res, next) => {
    const len = parseInt(req.headers["content-length"] || "0");
    if (len > maxBytes) {
      return res.status(413).json({ error: "Request too large" });
    }
    next();
  };
}

// IP extraction (behind proxy)
export function extractIP(req, res, next) {
  req.clientIP = req.headers["x-real-ip"]
    || req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.ip;
  next();
}
