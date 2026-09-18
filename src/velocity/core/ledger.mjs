// ═══ VELOCITY — Append-only ledger (DP6) ═══
// Every decision, order stage, fill, exit, outcome, halt, and governor verdict
// is written here with its reasons BEFORE the next action is taken.
// JSONL, one record per line, fsync on every append. A crash mid-line leaves a
// truncated tail that the reader tolerates; the previous records are intact.

import fs from "node:fs";
import path from "node:path";

export const RECORD_KINDS = Object.freeze([
  "decision", "order", "fill", "exit", "outcome", "halt", "resume",
  "reconcile", "weights", "governor", "alert", "heartbeat", "violation", "feed", "venue",
  "fee",  // a venue fee paid for nothing (a send that failed on chain): real money, charged to the day
  "rent", // an emptied token account closed and its rent taken back: real money, returned to the wallet
  "miss", // a candidate a rule refused that then ran anyway: the only record of what the rules cost
  "callout", // the bot's own fill, posted publicly with its tx and a hash written here first, so the track record cannot be edited after the fact
]);

// Order lifecycle stages, in order. The stage reached is what a crash reveals.
export const ORDER_STAGES = Object.freeze(["sized", "sent", "filled", "failed", "unwound"]);

export class Ledger {
  constructor(file, { now = () => Date.now(), fsync = true, recentLimit = 20_000 } = {}) {
    this.file = file;
    this.now = now;
    this.fsyncEnabled = fsync;
    this.recentLimit = recentLimit;
    this.seq = 0;
    this.recent = [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.repairedTail = false;
    if (fs.existsSync(file)) {
      this._repairTail();
      for (const rec of this.iterate()) {
        this.seq = Math.max(this.seq, rec.seq || 0);
        this._remember(rec);
      }
    }
  }

  /** A crash mid-write leaves a line without its newline. Terminate it so the
   *  next append starts clean; the fragment stays on disk and is skipped. */
  _repairTail() {
    const size = fs.statSync(this.file).size;
    if (size === 0) return;
    const fd = fs.openSync(this.file, "r+");
    try {
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);
      if (buf[0] !== 0x0a) {
        fs.writeSync(fd, "\n", size);
        fs.fsyncSync(fd);
        this.repairedTail = true;
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  _remember(rec) {
    this.recent.push(rec);
    if (this.recent.length > this.recentLimit) this.recent.splice(0, this.recent.length - this.recentLimit);
  }

  /** Append one record. Returns the record with seq and ts filled in. */
  append(record) {
    if (!RECORD_KINDS.includes(record.kind)) throw new Error(`ledger: unknown record kind ${record.kind}`);
    if (record.kind === "order" && !ORDER_STAGES.includes(record.stage))
      throw new Error(`ledger: order record needs a stage in ${ORDER_STAGES.join(",")}`);
    const rec = { seq: ++this.seq, ts: record.ts ?? this.now(), ...record };
    const line = JSON.stringify(rec) + "\n";
    const fd = fs.openSync(this.file, "a");
    try {
      fs.writeSync(fd, line);
      if (this.fsyncEnabled) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this._remember(rec);
    return rec;
  }

  /** Iterate every record on disk. Tolerates a truncated final line. */
  *iterate() {
    if (!fs.existsSync(this.file)) return;
    const text = fs.readFileSync(this.file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch (err) {
        // A torn fragment from a crash mid-write: it never closed its object.
        // Skip it; every record before it is whole. Anything else is corruption.
        if (!line.trimEnd().endsWith("}")) continue;
        throw new Error(`ledger: corrupt record at line ${i + 1}: ${err.message}`);
      }
    }
  }

  readAll(filter = null) {
    const out = [];
    for (const rec of this.iterate()) if (!filter || filter(rec)) out.push(rec);
    return out;
  }

  /** Recent records from memory (fast path for the governor and status). */
  query({ kind, venue, limit = 100, since = 0 } = {}) {
    const out = [];
    for (let i = this.recent.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.recent[i];
      if (r.seq <= since) break;
      if (kind && r.kind !== kind) continue;
      if (venue && r.venue !== venue) continue;
      out.push(r);
    }
    return out.reverse();
  }

  /** Latest stage an order reached, or null if never sized. */
  orderStage(orderId) {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const r = this.recent[i];
      if (r.kind === "order" && r.orderId === orderId) return r;
    }
    for (const r of this.readAll(r => r.kind === "order" && r.orderId === orderId).reverse()) return r;
    return null;
  }

  /** Everything recorded about one decision id, in order. */
  trail(decisionId) {
    return this.readAll(r => r.decisionId === decisionId || r.id === decisionId);
  }

  outcomes(venue = null, limit = 1000) {
    return this.query({ kind: "outcome", venue, limit });
  }

  lastDecision(venue = null) {
    const d = this.query({ kind: "decision", venue, limit: 1 });
    return d[0] || null;
  }
}
