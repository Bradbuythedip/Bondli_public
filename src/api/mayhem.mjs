// ═══ Mayhem tokens: never even looked at ═══
// pump.fun's Mayhem launches are a different game and the radar must not spend a cycle on them.
// Three independent signals, any one of which marks the token; the operator confirms which fires
// on their box with tools/mayhem-probe.mjs:
//   1. the create message (PumpPortal / on-chain create) carrying a mayhem flag or pool name
//   2. the pump.fun coin API record carrying a mayhem field
//   3. the bonding-curve account: the pump program appended an is_mayhem_mode byte after the
//      creator pubkey (offset MAYHEM_FLAG_OFFSET, default 81) in the layout that introduced Mayhem
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const MAYHEM_FLAG_OFFSET = Math.max(49, parseInt(process.env.MAYHEM_FLAG_OFFSET || "81") || 81);

const truthy = v => v === true || v === 1 || v === "true" || v === "1";
const mayhemKey = k => /mayhem/i.test(k);

/** Decode the tail of a bonding-curve account: complete flag, creator, and any bytes after it. */
export function decodeCurveFlags(buf) {
  if (!buf || buf.length < 49) return { complete: null, creator: null, flagByte: null, tailHex: "" };
  const complete = buf[48] === 1;
  let creator = null;
  try { creator = buf.length >= 81 ? bs58encode(buf.subarray(49, 81)) : null; } catch {}
  const flagByte = buf.length > MAYHEM_FLAG_OFFSET ? buf[MAYHEM_FLAG_OFFSET] : null;
  return { complete, creator, flagByte, tailHex: buf.length > 81 ? buf.subarray(81).toString("hex") : "", length: buf.length };
}

function bs58encode(bytes) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let x = 0n; for (const b of bytes) x = x * 256n + BigInt(b);
  let out = ""; while (x > 0n) { out = A[Number(x % 58n)] + out; x /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}

/**
 * @param create  the create/trade message as received (any shape)
 * @param meta    the pump.fun coin API record, or null
 * @param curve   the bonding-curve account data (Buffer), or null
 * @returns { mayhem: boolean, source: string|null }
 */
export function detectMayhem({ create = null, meta = null, curve = null } = {}) {
  if (create && typeof create === "object") {
    for (const k of Object.keys(create)) if (mayhemKey(k) && truthy(create[k])) return { mayhem: true, source: `create:${k}` };
    for (const k of ["pool", "platform", "launchpad", "mode", "type"]) if (typeof create[k] === "string" && /mayhem/i.test(create[k])) return { mayhem: true, source: `create:${k}=${create[k]}` };
  }
  if (meta && typeof meta === "object") {
    for (const k of Object.keys(meta)) if (mayhemKey(k) && truthy(meta[k])) return { mayhem: true, source: `api:${k}` };
    for (const k of ["pool", "platform", "launchpad", "mode", "type", "program"]) if (typeof meta[k] === "string" && /mayhem/i.test(meta[k])) return { mayhem: true, source: `api:${k}=${meta[k]}` };
  }
  if (curve && curve.length > MAYHEM_FLAG_OFFSET) {
    const f = decodeCurveFlags(curve);
    if (f.flagByte === 1) return { mayhem: true, source: `curve:byte${MAYHEM_FLAG_OFFSET}` };
  }
  return { mayhem: false, source: null };
}
