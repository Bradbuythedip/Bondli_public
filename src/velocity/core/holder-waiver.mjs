// ═══ VELOCITY — the holder fee waiver ═══
// Hold the house token and the performance fee is zero. One SPL balance on Solana decides it, read
// against the user's own Solana wallet -- the same pubkey they sign in with, so there is nothing
// extra for them to connect -- and cached, so a close costs at most one balance read every few
// minutes rather than one per trade.
//
// The house token is $BNDLI, an SPL mint on Solana. It used to be an ERC-20 on Robinhood Chain, keyed
// on the user's EVM address; that asked everyone to hold a token on the chain most of them never
// opted into, and left anyone trading only pump.fun unable to earn the waiver at all.
//
// Fail-safe, in the user's favour where it is honest to be: an RPC that answers "you hold it" is
// trusted for the whole TTL, and if a later read fails the last good answer stands rather than
// charging someone a fee because a node blinked. A user we have never successfully read is charged,
// because inventing a waiver from a failure would let anyone with a broken RPC trade free.
//
// Disabled until the token exists: with no mint configured nothing is read, nothing is waived, and
// the rest of the fee path behaves exactly as it did before.
import * as web3 from "@solana/web3.js";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** A base58 Solana address. Deliberately a shape check, not a curve check: a malformed mint should
 *  disable the waiver loudly rather than throw somewhere deep in a fee calculation. */
const isAddress = (a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

export class HolderWaiver {
  /**
   * @param opts { token, minTokens, connection, rpcUrl, ttlMs, timeoutMs, clock, log, symbol }
   *   token      the SPL mint whose holders trade free; unset disables the whole thing
   *   minTokens  how many whole tokens count as holding (default 1)
   *   connection a @solana/web3.js Connection; else one is built from rpcUrl
   */
  constructor({ token = null, minTokens = 1, connection = null, rpcUrl = null, ttlMs = 5 * 60_000, timeoutMs = 6_000, clock = () => Date.now(), log = null, symbol = "BNDLI" } = {}) {
    this.token = isAddress(token) ? token : null;
    this.configuredButInvalid = !!token && !this.token;
    this.minTokens = Number(minTokens) > 0 ? Number(minTokens) : 1;
    this._connection = connection || null; this.rpcUrl = rpcUrl || null;
    this.ttlMs = ttlMs; this.timeoutMs = timeoutMs; this.clock = clock; this.log = log; this.symbol = symbol;
    this.cache = new Map(); // address -> { holds, at, balance }
    this.reads = 0; this.errors = 0; this.lastError = null;
  }

  get enabled() { return !!this.token; }

  connection() {
    if (!this._connection && this.rpcUrl) this._connection = new web3.Connection(this.rpcUrl, "confirmed");
    return this._connection;
  }

  /** Whole tokens `address` holds, or null when it cannot be read. Both token programs are asked:
   *  a mint launched under Token-2022 is just as real as one under the original program, and reading
   *  only the first would quietly charge every holder of the other. */
  async balanceOf(address) {
    const c = this.connection();
    if (!c || !this.token || !isAddress(address)) return null;
    const owner = new web3.PublicKey(address), mint = new web3.PublicKey(this.token);
    let total = 0, answered = false;
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      // A wallet can hold the same mint in more than one token account; the balance is all of them.
      const res = await c.getParsedTokenAccountsByOwner(owner, { mint, programId: new web3.PublicKey(programId) })
        .catch(err => { if (/could not find mint|invalid param/i.test(String(err?.message))) return { value: [] }; throw err; });
      answered = true;
      for (const { account } of res.value || []) total += Number(account?.data?.parsed?.info?.tokenAmount?.uiAmount) || 0;
    }
    return answered ? total : null;
  }

  /**
   * Does this address hold enough to trade free? Cached for ttlMs. Never throws: an unreadable
   * balance keeps the last good answer, or charges the fee when there has never been one.
   */
  async holds(address) {
    if (!this.enabled || !isAddress(address)) return false;
    const key = address;
    const hit = this.cache.get(key);
    if (hit && this.clock() - hit.at < this.ttlMs) return hit.holds;
    try {
      const balance = await Promise.race([
        this.balanceOf(address),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`balance read timed out after ${this.timeoutMs}ms`)), this.timeoutMs)),
      ]);
      this.reads++;
      if (balance == null) throw new Error("no connection to Solana");
      const holds = balance >= this.minTokens;
      this.cache.set(key, { holds, at: this.clock(), balance });
      if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value);
      return holds;
    } catch (err) {
      this.errors++; this.lastError = String(err?.message || err).slice(0, 200);
      this.log?.warn?.(`[WAIVER] ${this.symbol} balance of ${address.slice(0, 10)} unreadable: ${this.lastError}${hit ? " (keeping the last answer)" : ""}`);
      if (hit) { hit.at = this.clock() - this.ttlMs / 2; return hit.holds; } // keep it, retry sooner
      return false;
    }
  }

  /** What the last read said, without reading again. */
  cached(address) { return isAddress(address) ? (this.cache.get(address) || null) : null; }
  forget(address) { if (isAddress(address)) this.cache.delete(address); }

  status() {
    return { enabled: this.enabled, token: this.token, symbol: this.symbol, minTokens: this.minTokens, ttlMs: this.ttlMs, cached: this.cache.size, reads: this.reads, errors: this.errors, lastError: this.lastError, misconfigured: this.configuredButInvalid };
  }
}

export default HolderWaiver;
