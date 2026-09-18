#!/usr/bin/env node
// ═══ VELOCITY — CLI (E1..E8) ═══
//   velocity validate [risk.json]        check the envelope, print the worst day
//   velocity start [--config f]          run the engine and control server (foreground)
//   velocity status                      one screen, from the running engine or from files
//   velocity halt freeze|flatten         kill switch (HTTP, falls back to the HALT file)
//   velocity resume <venue>              lift a halt; the venue name must be typed
//   velocity venue <name> off|paper|live set a venue mode (live goes through the gate)
//   velocity promote <venue>             show the paper-to-live checklist, promote if green
//   velocity why <id|last|venue last>    the full trail of one decision
//   velocity watch [--all]               live narration: every candidate judged, why, and every order
import "dotenv/config"; // the trader reads the same .env as the bondli server (MASTER_SEED, RPC_URL, PUMPPORTAL_API_KEY)
import fs from "node:fs";
import path from "node:path";
import { validateRisk } from "./core/risk.mjs";
import { buildEngine, DEFAULT_CONFIG } from "./core/build.mjs";
import { Supervisor } from "./core/supervisor.mjs";
import { startControlServer } from "./core/server.mjs";
import { Store } from "./core/store.mjs";
import { Ledger } from "./core/ledger.mjs";
import { loadRiskEnvelope } from "./core/risk.mjs";
import { promotionGate } from "./core/promote.mjs";
import { followLedger } from "./core/watch.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

function loadConfig() {
  const file = opt("config", "velocity.config.json");
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG, _file: null };
  return { ...JSON.parse(fs.readFileSync(file, "utf8")), _file: file };
}
const cfg = loadConfig();
const base = `http://${cfg.host || DEFAULT_CONFIG.host}:${cfg.port || DEFAULT_CONFIG.port}`;

async function api(pathname, method = "GET", body = null, timeoutMs = 5_000) {
  try {
    const res = await fetch(`${base}${pathname}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, json: await res.json() };
  } catch { return { ok: false, offline: true }; }
}
const out = v => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

async function main() {
  switch (cmd) {
    case "validate": {
      const file = args[1] || cfg.riskFile || DEFAULT_CONFIG.riskFile;
      if (!fs.existsSync(file)) { out(`no risk file at ${file}. Copy src/velocity/config/risk.example.json there and edit it.`); process.exit(2); }
      let parsed; try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) { out(`${file} is not valid JSON: ${err.message}`); process.exit(2); }
      const v = validateRisk(parsed);
      if (!v.ok) { out(`${file} rejected:`); for (const e of v.errors) out(`  - ${e}`); process.exit(2); }
      fs.copyFileSync(file, `${file}.last-good`);
      out(`${file} ok. Worst day you are agreeing to:`); out(v.summary);
      return;
    }
    case "start": {
      const { engine, cfg: c, dataDir } = buildEngine(cfg);
      const sup = new Supervisor({ engine, dataDir, alerter: engine.alerter });
      engine.on("log", l => console.log(`[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} ${l.text}`));
      engine.on("reconciled", r => console.log(`[reconcile] ${JSON.stringify(r.venues)}`));
      const { url } = await startControlServer({ engine, host: c.host, port: c.port });
      // The persisted mode wins over the config file: an operator's go-live survives a restart.
      out(`velocity starting. venues: ${Object.keys(engine.venues).map(k => `${k}=${engine.store.venueMode(k)}`).join(" ")}; caps: per trade $${engine.env.per_trade_max_usd}, daily loss $${engine.env.daily_loss_limit_usd}; control ${url}`);
      await engine.start();
      sup.start();
      out(`running. status: ${url}/status.html  halt: velocity halt freeze|flatten`);
      const stop = async () => { out("stopping"); sup.stop(); await engine.stop(); process.exit(0); };
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      return;
    }
    case "status": {
      const r = await api("/status");
      if (r.ok) { const s = r.json; out(`throttle ${s.throttle} regime ${s.regime} halt ${s.halt?.mode || "none"} day $${s.day.realizedUsd} (${s.day.used_pct}% of limit) positions ${s.positions.length}${s.bankroll ? ` bankroll ${s.bankroll.source === "wallet" ? (s.bankroll.wallet ? `wallet ${Number(s.bankroll.wallet.sol).toFixed(4)} SOL` : "wallet (no reading yet)") + (s.bankroll.equity_usd != null ? ` equity $${s.bankroll.equity_usd}` : "") : `fixed $${s.bankroll.fixed_usd}`}` : ""}`); for (const [k, v] of Object.entries(s.venues)) out(`  ${k}: ${v.mode}${v.blocked ? ` BLOCKED ${v.blocked}` : ""}${v.halted ? ` HALTED ${v.halted.mode}: ${v.halted.reason}` : ""} feed age ${v.feed?.ageMs ?? "-"}ms go ${v.gos}/${v.evaluated} promotion ${v.promotion.ok ? "READY" : v.promotion.items.filter(i => !i.ok).map(i => i.name).join(",")}`); for (const p of s.positions) out(`  pos ${p.venue} ${p.instrument} $${p.notional_usd?.toFixed(2)} ${p.changePct?.toFixed?.(1) ?? "-"}% plan ${p.plan.key}`); for (const d of s.lastDecisions.slice(0, 10)) out(`  ${d.action.padEnd(6)} ${d.venue} ${d.instrument} ${d.gate || ""} ${d.reason || ""} [${d.id}]`); return; }
      const dataDir = path.resolve(cfg.dataDir || DEFAULT_CONFIG.dataDir);
      const dead = Supervisor.deadman(dataDir);
      out(`engine not reachable at ${base} (${dead.detail}). Showing the last snapshot:`);
      const store = new Store(path.join(dataDir, "state.json"));
      const s = store.state;
      out(`snapshot ${new Date(s.savedAt).toISOString()} throttle ${s.throttle} halt ${s.halt?.mode || "none"} day $${s.day.realizedUsd} positions ${store.openPositions().length}`);
      for (const p of store.openPositions()) out(`  pos ${p.venue} ${p.instrument} $${p.notional_usd?.toFixed(2)}`);
      return;
    }
    case "halt": {
      const mode = args[1] === "flatten" ? "flatten" : "freeze";
      const r = await api("/halt", "POST", { mode, reason: "cli" });
      if (r.ok) { out(`halted (${mode})`); out(r.json); return; }
      const dataDir = path.resolve(cfg.dataDir || DEFAULT_CONFIG.dataDir);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "HALT"), mode);
      out(`engine not reachable; wrote ${path.join(dataDir, "HALT")} (${mode}). The supervisor applies it within 2s if the process is alive.`);
      return;
    }
    case "resume": {
      if (!args[1]) { out("resume needs the venue name: velocity resume pumpfun"); process.exit(2); }
      const r = await api("/resume", "POST", { venue: args[1] });
      out(r.ok ? r.json : "engine not reachable");
      return;
    }
    case "venue": {
      const [, venue, mode] = args;
      if (!venue || !["off", "paper", "live"].includes(mode)) { out("usage: velocity venue <pumpfun|polymarket|perps> off|paper|live"); process.exit(2); }
      const override = args.includes("--i-accept-the-risk");
      // Going live initializes the wallet and probes the RPC: allow well over the usual 5s.
      const r = await api("/venue", "POST", { venue, mode, override }, 90_000);
      if (!r.ok) { out(r.offline ? "engine not reachable or no reply within 90s; run: velocity status" : `engine error: ${r.json?.error || JSON.stringify(r.json)}`); process.exit(1); }
      if (r.json.ok) {
        out(`${venue} -> ${mode}${r.json.liveStartCapUsd ? ` (live start cap $${r.json.liveStartCapUsd} per trade)` : ""}${r.json.override ? " [paper gate overridden by operator]" : ""}`);
        if (r.json.preflight) out(`  wallet ${r.json.preflight.wallet}  balance ${r.json.preflight.balanceSol.toFixed(4)} SOL  rpc ${r.json.preflight.rpc}`);
      } else {
        out(`${venue} stays ${r.json.mode}:`);
        for (const i of r.json.gate?.items || []) out(`  ${i.ok ? "ok " : "RED"} ${i.name}: ${i.detail}`);
        if (r.json.error) out(`  ${r.json.error}`);
        if (r.json.gate && !r.json.error) out(`  to go live anyway: velocity venue ${venue} live --i-accept-the-risk`);
      }
      return;
    }
    case "promote": {
      const venue = args[1];
      if (!venue) { out("usage: velocity promote <venue>"); process.exit(2); }
      let gate;
      const r = await api(`/promote/${venue}`);
      if (r.ok) gate = r.json;
      else {
        const dataDir = path.resolve(cfg.dataDir || DEFAULT_CONFIG.dataDir);
        const envelope = loadRiskEnvelope(path.resolve(cfg.riskFile || DEFAULT_CONFIG.riskFile));
        gate = promotionGate({ ledger: new Ledger(path.join(dataDir, "ledger.jsonl")), envelope, venue, store: new Store(path.join(dataDir, "state.json")) });
      }
      for (const i of gate.items) out(`  ${i.ok ? "ok " : "RED"} ${i.name}: ${i.detail}`);
      if (!gate.ok) { out(`${venue} is not ready for live. Keep it in paper; run this again later.`); return; }
      if (!r.ok) { out(`gate green, but the engine is not running; start it and run: velocity venue ${venue} live`); return; }
      if (args.includes("--go")) { const p = await api(`/promote/${venue}`, "POST", null, 90_000); out(p.json); }
      else out(`gate green. Starting live cap would be $${gate.liveStartCapUsd}. Run: velocity venue ${venue} live`);
      return;
    }
    case "watch": {
      const dataDir = path.resolve(cfg.dataDir || DEFAULT_CONFIG.dataDir);
      const file = path.join(dataDir, "ledger.jsonl");
      out(`watching ${file} (Ctrl+C stops watching, not the bot)`);
      followLedger(file, line => console.log(line), { fromStart: args.includes("--all") });
      await new Promise(() => {});
      return;
    }
    case "why": {
      const id = args.slice(1).join(" ") || "last";
      const r = await api(`/why/${encodeURIComponent(id)}`);
      if (r.ok) return out(r.json);
      const dataDir = path.resolve(cfg.dataDir || DEFAULT_CONFIG.dataDir);
      const ledger = new Ledger(path.join(dataDir, "ledger.jsonl"));
      if (id === "last") { const d = ledger.lastDecision(); return out(d ? ledger.trail(d.id) : "nothing logged yet"); }
      const trail = ledger.trail(id);
      return out(trail.length ? trail : { error: `unknown id ${id}`, nearest: ledger.query({ kind: "decision", limit: 5 }).map(d => d.id) });
    }
    default:
      out(`velocity commands: validate | start | status | halt freeze|flatten | resume <venue> | venue <name> <mode> | promote <venue> [--go] | why <id>`);
      process.exit(cmd ? 2 : 0);
  }
}
main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
