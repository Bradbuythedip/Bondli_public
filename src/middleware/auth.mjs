// BONDLI v3.0 — Authentication Middleware
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24h

// Simple JWT (no external dep)
function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(payload) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + SESSION_TTL }));
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verify(token) {
  try {
    const [header, body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Issue session token after payment verification
export function issueToken(walletPubkey, txSig) {
  return sign({
    wallet: walletPubkey,
    tx: txSig,
    tier: "paid",
  });
}

// Auth middleware - checks Bearer token
export function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required. Complete payment first." });
  }

  const token = auth.slice(7);
  const payload = verify(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired session. Re-authenticate." });
  }

  req.user = payload;
  next();
}

// Optional auth - attaches user if token present, continues regardless
export function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    const payload = verify(auth.slice(7));
    if (payload) req.user = payload;
  }
  next();
}

export { sign, verify, JWT_SECRET };
