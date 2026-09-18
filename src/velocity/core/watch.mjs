// ═══ VELOCITY — live narration of the ledger (E5) ═══
// One readable line per ledger record: what the bot saw, what it decided, why, and what it did.
// The ledger is the record of thought; this is just how a person reads it as it happens.
import fs from "node:fs";

const t = ts => new Date(ts || Date.now()).toISOString().slice(11, 19);
const short = s => String(s || "").slice(0, 10);
const usd = n => (n < 0 ? "-$" : "$") + Math.abs(Number(n) || 0).toFixed(2);
const pct = n => (Number(n) || 0).toFixed(1) + "%";

/** Pure: a ledger record -> a line for a person, or null for records not worth a line. */
export function formatRecord(r) {
  const at = t(r.ts);
  switch (r.kind) {
    case "decision": {
      const score = r.features?.apeScore != null ? ` score ${Math.round(r.features.apeScore * 100)}` : "";
      if (r.action === "GO") { const waived = (r.reasons || []).find(x => /^momentum waived /.test(x)); return `${at} GO      ${short(r.instrument)} tier ${r.tier ?? "?"} p_win ${(r.p_win ?? 0).toFixed(2)}${score}${waived ? `  ${waived}` : ""}  -> sizing`; }
      const why = (r.reasons || []).slice(0, 3).join(", ");
      return `${at} reject  ${short(r.instrument)} ${r.gate || ""}: ${why}${score}`;
    }
    case "callout": return `${at} CALLOUT ${r.venue} ${short(r.instrument)} tier ${r.tier ?? "?"}${r.mcapUsd != null ? ` at $${Math.round(r.mcapUsd)}` : ""}${r.result ? ` -> ${(r.result.pnl_pct ?? 0) >= 0 ? "+" : ""}${r.result.pnl_pct}%` : ""}${r.posted === false ? " (not posted)" : ""}`;
    case "order":
      if (r.stage === "sized") return r.stake_usd > 0 ? `${at} sized   ${usd(r.stake_usd)}${(r.sizing?.caps || []).length ? ` (${r.sizing.caps.join(",")})` : ""}` : `${at} no size ${(r.sizing?.reasons || [])[0] || ""}`;
      if (r.stage === "sent") return `${at} SENT    BUY ${short(r.instrument)} ${usd(r.stake_usd)}`;
      if (r.stage === "failed") return `${at} failed  ${r.code || ""} ${r.reason || ""}`;
      if (r.stage === "unwound") return `${at} unwound ${r.reason || ""}`;
      return null;
    case "fill": return `${at} FILLED  BUY ${short(r.instrument)} ${usd(r.notional_usd)} qty ${Math.round(r.qty || 0)} slip ${(r.slippage_bps || 0).toFixed(0)}bps ${r.paper ? "(paper)" : "tx " + short(r.venue_ref)}`;
    case "exit": return r.failed ? `${at} exit!   ${short(r.instrument)} ${r.reason} FAILED: ${r.error || r.code || ""}`
      : `${at} SOLD    ${r.pct}% ${short(r.instrument)} ${r.reason}${r.detail ? ` (${r.detail})` : ""} -> ${usd(r.proceeds_usd)}${r.final ? "" : " partial"}`;
    case "outcome": return `${at} P&L     ${short(r.instrument)} ${usd(r.pnl_usd)} (${pct(r.pnl_pct)}) held ${Math.round((r.held_ms || 0) / 1000)}s ${r.reason}`;
    case "fee": return `${at} fee     ${usd(-r.usd)} ${r.note || ""}`;
    case "halt": return `${at} HALT    ${r.mode} ${r.venue || "all"}: ${r.reason} (${r.by})`;
    case "resume": return `${at} resume  ${r.venue} (${r.by})`;
    case "governor": return r.halt ? `${at} governor FROZE entries: ${r.haltReason}` : r.throttle < 1 ? `${at} governor throttle ${r.throttle} ${(r.reasons || []).join(", ")}` : null;
    case "feed": return r.blocked ? `${at} blocked ${r.venue}: ${r.blocked}` : `${at} unblock ${r.venue}`;
    case "venue": return `${at} venue   ${r.venue} -> ${r.mode} (${r.by})${r.preflight?.balanceSol != null ? ` wallet ${Number(r.preflight.balanceSol).toFixed(4)} ${r.preflight.quote || "SOL"}` : ""}`;
    case "reconcile": { const v = r.report?.venues?.pumpfun; return v ? `${at} reconcile matched ${v.matched.length} adopted ${v.adopted.length} closed ${v.closed.length} unknown ${(v.unknown || []).length}` : null; }
    case "alert": return `${at} ALERT   ${r.level}: ${r.text}`;
    case "violation": return `${at} VIOLATION ${r.rule}`;
    default: return null; // heartbeat, weights: noise for a live watcher
  }
}

/** Follow a JSONL ledger from its current end; onLine gets each formatted line. Returns stop(). */
export function followLedger(file, onLine, { pollMs = 500, fromStart = false } = {}) {
  let pos = fromStart || !fs.existsSync(file) ? 0 : fs.statSync(file).size;
  let buf = "";
  const tick = () => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size < pos) { pos = 0; buf = ""; } // rotated or rewritten
    if (size === pos) return;
    const fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(size - pos); fs.readSync(fd, b, 0, b.length, pos); buf += b.toString("utf8"); pos = size; } finally { fs.closeSync(fd); }
    const lines = buf.split("\n"); buf = lines.pop();
    for (const l of lines) { if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; } const s = formatRecord(r); if (s) onLine(s, r); }
  };
  tick();
  const timer = setInterval(tick, pollMs);
  return () => clearInterval(timer);
}
