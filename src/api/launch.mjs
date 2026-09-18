// ═══ The launch banner: what bondli.fun shows about Bondli's own token ═══
// One JSON file on disk (the Railway volume), written by POST /api/launch from tools/launch-push.mjs
// and read by GET /api/launch every few seconds from the site. The site never needs a redeploy for
// a new address, status, or update line: push it here and it is live.
import fs from "node:fs";
import path from "node:path";

export const LAUNCH_STATUSES = Object.freeze(["soon", "live", "graduated", "off"]);
export const LAUNCH_VENUES = Object.freeze(["pump.fun", "pons", "uniswap-v2"]);
export const LAUNCH_CHAINS = Object.freeze(["solana", "robinhood"]);
/** The post the previous token was about. No longer a default link: $BNDLI is Bondli's own token and
 *  needs no one else's post. Kept only so the legacy check and its tests can name the record that
 *  used to carry it; an operator who wants a post on the banner pushes links.post explicitly. */
export const JEFF_POST_URL = "https://x.com/elonmusk/status/1935370021439705302";
export const LAUNCH_FIELDS = Object.freeze(["name", "ticker", "chain", "venue", "address", "curve", "pair", "status", "tagline", "image", "links"]);
const MAX_UPDATES = 20;

export function defaultLaunch() {
  return { name: "Bondli", ticker: "BNDLI", chain: "solana", venue: "pump.fun", address: "", curve: "", pair: "", status: "soon", tagline: "Bondli's own token. Hold it, trade free.", image: "", links: {}, updates: [], updatedAt: 0 };
}

/** A record the store held under an earlier name: the fruit fly from before the token moved to
 *  Solana, or the $JEFF placeholder that came after it. Recognised so a volume that still carries
 *  either comes up as $BNDLI: the defaults only apply when the file is missing, and the file was
 *  not missing. Only a record that never launched is migrated -- a live address, on any chain, is
 *  left exactly as it is, because a token that exists is never renamed under the people holding it. */
export function isLegacyLaunch(st) {
  if (!st || typeof st !== "object") return false;
  const name = String(st.name || "").toLowerCase(), ticker = String(st.ticker || "").toLowerCase();
  if (st.address) return false;
  return name === "not a fruit fly" || name === "notafly" || (st.chain === "robinhood" && !st.ticker) || name === "jeff" || ticker === "jeff";
}

const isEvmAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const isSolAddr = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || ""));
const isAddrFor = (chain, a) => chain === "solana" ? isSolAddr(a) : isEvmAddr(a);

/** Apply one push to the stored state. Unknown fields are ignored; an `update` string is appended
 *  (newest first, capped); `reset: true` starts over from the defaults. Returns the new state or throws. */
export function mergeLaunch(state, body = {}, now = Date.now()) {
  const next = body.reset ? defaultLaunch() : { ...defaultLaunch(), ...state, links: { ...(state?.links || {}) }, updates: [...(state?.updates || [])] };
  for (const k of LAUNCH_FIELDS) {
    if (body[k] === undefined) continue;
    if (k === "links") { for (const [n, v] of Object.entries(body.links || {})) { if (v == null || v === "") delete next.links[n]; else next.links[n] = String(v).slice(0, 300); } continue; }
    if (k === "status") { if (!LAUNCH_STATUSES.includes(body.status)) throw new Error(`status must be one of ${LAUNCH_STATUSES.join(", ")}`); next.status = body.status; continue; }
    if (k === "venue") { if (!LAUNCH_VENUES.includes(body.venue)) throw new Error(`venue must be one of ${LAUNCH_VENUES.join(", ")}`); next.venue = body.venue; continue; }
    if (k === "chain") { if (!LAUNCH_CHAINS.includes(body.chain)) throw new Error(`chain must be one of ${LAUNCH_CHAINS.join(", ")}`); next.chain = body.chain; continue; }
    if (k === "address" || k === "curve" || k === "pair") {
      // The chain the address is checked against is the one being pushed with it, else the stored one.
      const chain = body.chain !== undefined ? body.chain : next.chain;
      if (body[k] !== "" && !isAddrFor(chain, body[k])) throw new Error(`${k} must be a ${chain === "solana" ? "base58 Solana" : "0x"} address`);
      // Base58 is case-sensitive: a Solana address is stored as given, an EVM one lowercased as before.
      next[k] = chain === "solana" ? String(body[k]) : String(body[k]).toLowerCase(); continue;
    }
    next[k] = String(body[k]).slice(0, k === "tagline" ? 200 : 120);
  }
  if (body.update) next.updates = [{ at: now, text: String(body.update).slice(0, 280) }, ...next.updates].slice(0, MAX_UPDATES);
  if (body.clearUpdates) next.updates = [];
  // A live token needs an address; a pushed address without a status goes live by itself.
  if (next.address && body.address && body.status === undefined && next.status === "soon") next.status = "live";
  next.updatedAt = now;
  return next;
}

export class LaunchStore {
  constructor(file) { this.file = file; this.state = this._read(); }
  _read() {
    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return defaultLaunch(); }
    if (isLegacyLaunch(stored)) { console.log("[LAUNCH] stored banner is an earlier, never-launched token; starting over as $BNDLI"); return defaultLaunch(); }
    const d = defaultLaunch();
    return { ...d, ...stored, links: { ...d.links, ...(stored.links || {}) } };
  }
  push(body, now = Date.now()) {
    this.state = mergeLaunch(this.state, body, now);
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2)); } catch (err) { console.error("[LAUNCH] could not persist:", err.message); }
    return this.state;
  }
}
