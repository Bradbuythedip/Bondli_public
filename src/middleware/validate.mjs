// BONDLI v3.0 — Input Validation & Sanitization
import { PublicKey } from "@solana/web3.js";

// Validate Solana public key
export function isValidPubkey(str) {
  if (!str || typeof str !== "string") return false;
  if (str.length < 32 || str.length > 44) return false;
  try {
    new PublicKey(str);
    return true;
  } catch {
    return false;
  }
}

// Validate transaction signature (base58, 87-88 chars)
export function isValidTxSig(str) {
  if (!str || typeof str !== "string") return false;
  return /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(str);
}

// Validate CA (contract address = pubkey)
export function isValidCA(str) {
  return isValidPubkey(str);
}

// Sanitize string (strip control chars, limit length)
export function sanitize(str, maxLen = 256) {
  if (typeof str !== "string") return "";
  return str.replace(/[\x00-\x1f\x7f]/g, "").slice(0, maxLen).trim();
}

// Validate SOL amount
export function isValidSolAmount(n) {
  if (typeof n !== "number" || isNaN(n)) return false;
  return n >= 0.01 && n <= 100;
}

// Middleware factory
export function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, rules] of Object.entries(schema)) {
      const val = req.body[field];

      if (rules.required && (val === undefined || val === null || val === "")) {
        errors.push(`${field} is required`);
        continue;
      }

      if (val === undefined || val === null) continue;

      if (rules.type === "pubkey" && !isValidPubkey(val)) {
        errors.push(`${field} must be a valid Solana address`);
      }
      if (rules.type === "txsig" && !isValidTxSig(val)) {
        errors.push(`${field} must be a valid transaction signature`);
      }
      if (rules.type === "ca" && !isValidCA(val)) {
        errors.push(`${field} must be a valid contract address`);
      }
      if (rules.type === "number") {
        const n = Number(val);
        if (isNaN(n)) errors.push(`${field} must be a number`);
        if (rules.min !== undefined && n < rules.min) errors.push(`${field} must be >= ${rules.min}`);
        if (rules.max !== undefined && n > rules.max) errors.push(`${field} must be <= ${rules.max}`);
      }
      if (rules.type === "boolean" && typeof val !== "boolean") {
        errors.push(`${field} must be boolean`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: "Validation failed", details: errors });
    }
    next();
  };
}

// Pre-built schemas
export const launchSchema = validateBody({
  ca:       { required: true, type: "ca" },
  totalSol: { type: "number", min: 0.01, max: 100 },
  force:    { type: "boolean" },
});

export const closeSchema = validateBody({
  ca: { required: true, type: "ca" },
});

export const paymentSchema = validateBody({
  wallet:   { required: true, type: "pubkey" },
  txSig:    { required: true, type: "txsig" },
});
