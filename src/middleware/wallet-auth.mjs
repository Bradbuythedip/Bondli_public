// BONDLI — Wallet Signature Auth
// Verifies Solana wallet ownership via signed message
// Flow: 
//   1. Frontend calls /api/auth/challenge → gets nonce
//   2. User signs nonce with Phantom → sends signature
//   3. Server verifies signature → issues JWT session token
//   4. All subsequent requests use Bearer token

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import crypto from "crypto";

// A missing JWT_SECRET is not a small thing: sessions are signed with a key that dies with the
// process, so every user is silently signed out on each deploy or restart, and two instances behind
// one URL reject each other's tokens. It still starts -- refusing to boot would take the whole
// service down over a session key -- but it says so once, loudly, instead of looking healthy.
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn("[AUTH] JWT_SECRET is not set. Sessions are signed with a random key that is thrown away on restart: everyone will be signed out on every deploy, and a second instance will not accept the first's tokens. Set JWT_SECRET.");
  return crypto.randomBytes(32).toString("hex");
})();
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory nonce store (short-lived)
const nonces = new Map();

// ── JWT helpers ──
function base64url(buf) { return Buffer.from(buf).toString("base64url"); }

function signJWT(payload) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + TOKEN_TTL }));
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token) {
  try {
    const [header, body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// ── Challenge: generate nonce for wallet to sign ──
export function generateChallenge(wallet) {
  const nonce = crypto.randomBytes(32).toString("hex");
  const message = `Sign this message to verify your wallet on BONDLI.\n\nNonce: ${nonce}\nWallet: ${wallet}\nTimestamp: ${Date.now()}`;
  // Store nonce with 5-minute expiry
  nonces.set(wallet, { nonce, message, createdAt: Date.now() });
  setTimeout(() => nonces.delete(wallet), 5 * 60 * 1000).unref?.();
  return { message, nonce };
}

// ── Verify: check signature against challenge ──
export function verifySolanaSignature(wallet, signature, message) {
  try {
    const publicKey = new PublicKey(wallet);
    const sigBytes = bs58.decode(signature);
    const msgBytes = new TextEncoder().encode(message);
    // Use Node.js built-in ed25519 verification (no tweetnacl needed)
    const keyObj = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey.toBytes()]), format: "der", type: "spki" });
    return crypto.verify(null, msgBytes, keyObj, sigBytes);
  } catch { return false; }
}

// ── Issue session token after verification ──
export function issueAuthToken(wallet, tier) {
  return signJWT({ wallet, tier, verified: true });
}

// NOTE: two middlewares used to live here, requireVerifiedWallet and requireStrictAuth. Both fell
// back to trusting an X-Wallet header -- "legacy, less secure", from before the signature flow
// existed -- so anything mounted on them could be acted on by typing someone else's address into a
// header. Nothing used them by the time the money routes moved to requireOwner, and leaving a
// ready-made auth bypass in the file for the next route to pick up is worse than having no helper.
// If a route ever needs a weaker check than ownership, write it deliberately.

// ── Middleware: the caller must have signed in as the wallet the request acts on ──
// For routes that read a key, move money, or start a trader. No X-Wallet fallback: a header
// anyone can type is not ownership. An operator with ADMIN_SECRET may act for support.
export function makeRequireOwner({ adminSecret = process.env.ADMIN_SECRET || null } = {}) {
  return function requireOwner(req, res, next) {
    const target = req.body?.wallet || req.query?.wallet || req.params?.wallet || null;
    if (adminSecret && req.headers["x-admin-secret"] === adminSecret) { req.user = { wallet: target, admin: true, verified: true }; return next(); }
    const auth = req.headers.authorization;
    const payload = auth && auth.startsWith("Bearer ") ? verifyJWT(auth.slice(7)) : null;
    if (!payload || !payload.verified || !payload.wallet) return res.status(401).json({ error: "Sign in with your wallet first", auth_required: true });
    // A request that names no wallet used to skip the ownership check entirely and continue. Every
    // route behind this happens to reject a missing wallet itself, so nothing was exploitable -- but
    // the guard was one forgetful route away from being. It now resolves to the signed-in wallet,
    // which is both safe and what such a request means.
    if (!target) { req.user = payload; req.ownerWallet = payload.wallet; return next(); }
    if (payload.wallet !== target) return res.status(403).json({ error: "That wallet is not the one you signed in with" });
    req.user = payload;
    req.ownerWallet = payload.wallet;
    next();
  };
}

export { nonces, signJWT, verifyJWT, JWT_SECRET };
