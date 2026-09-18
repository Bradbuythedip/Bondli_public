#!/usr/bin/env node
// ═══ Push "Not a fruit fly" updates to bondli.fun ═══
// The site reads GET /api/launch every 15 seconds; this writes it. No redeploy for any of it.
//
//   BONDLI_API=https://<railway-app>.up.railway.app ADMIN_SECRET=<your ADMIN_SECRET> \
//   node tools/launch-push.mjs --address 0xTOKEN --ticker FLY --x https://x.com/... --update "We are live."
//
//   --venue uniswap-v2|pons   where it trades (default uniswap-v2: launch.py's pool)   --pair 0xPAIR (the v2 pair; found from the factory if left out)
//   --from-state launch_state.json   read token and pair from launch.py's state file and push them (goes live)
//   --from-state <fleet-state.json>  same, for a PONS launch (venue pons, so the site links straight
//                         to the PONS buy page). Only the address is read.
//   --status soon|live|graduated|off   --tagline "..."   --telegram URL   --launchpad URL (override the buy link)
//   --update "text"       one line, newest shown on the site (last 20 kept)
//   --clear-updates       drop every update line
//   --reset               back to the defaults (soon, no address)
//   --show                print what the site has right now, and the chain's view of it
//   --announce            print ready-to-post text (X, Telegram) from the current state, then exit
//   --watch [minutes]     keep running: read the chain every 30s, push a milestone update when mcap
//                         crosses 10k/25k/50k/100k/250k/500k/1M and when the curve graduates; default 720 min
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : d; };
const API = (process.env.BONDLI_API || arg("--api", "") || "").replace(/\/$/, "");
const SECRET = process.env.ADMIN_SECRET || arg("--secret", "");
if (!API) { console.error("Set BONDLI_API to the Railway URL (the one the site talks to; it shows in the site's network tab as /api/…)"); process.exit(2); }

async function get() { const r = await fetch(`${API}/api/launch`); if (!r.ok) throw new Error(`GET /api/launch ${r.status}`); return r.json(); }
async function push(body) {
  if (!SECRET) throw new Error("Set ADMIN_SECRET (the same value Railway has) to push");
  const r = await fetch(`${API}/api/launch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-secret": SECRET }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw new Error(j.error || `POST /api/launch ${r.status}`); return j.launch;
}
const k = n => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`;

function announce(l) {
  const t = l.ticker ? `$${l.ticker.replace(/^\$/, "")}` : l.name, url = l.url || "", mc = l.live?.mcapUsd ? ` · mcap ${k(l.live.mcapUsd)}` : "";
  const curve = l.live?.curvePct != null ? ` · curve ${Math.round(l.live.curvePct * 100)}%` : l.live?.lpBurnedPct != null ? ` · LP ${l.live.lpBurnedPct}% burned` : "";
  const x = l.status === "soon"
    ? `${t} is launching on Robinhood Chain.\n\nNot a fruit fly. Bondli's own token, judged by the bot like any other launch.\n\nhttps://bondli.fun`
    : `${t} is LIVE on Robinhood Chain${mc}${curve}\n\nNot a fruit fly.${l.venue === "uniswap-v2" ? " No owner, no tax, no mint, LP burned." : ""}\nCA: ${l.address}\n\nBuy: ${url}${l.chart ? `\nChart: ${l.chart}` : ""}\nhttps://bondli.fun`;
  console.log("── X / Twitter ──\n" + x + "\n");
  console.log("── Telegram ──\n" + x.replace(/\n\n/g, "\n") + "\n");
  console.log("── one-liner ──\n" + `${t} ${l.status === "soon" ? "soon" : "live"} on RH · ${url || "https://bondli.fun"}`);
}

function bodyFromArgs() {
  const b = {}; const links = {};
  for (const [flag, key] of [["--name", "name"], ["--ticker", "ticker"], ["--venue", "venue"], ["--address", "address"], ["--curve", "curve"], ["--pair", "pair"], ["--status", "status"], ["--tagline", "tagline"], ["--image", "image"], ["--update", "update"]]) { const v = arg(flag); if (v !== undefined && v !== true) b[key] = v; }
  const stateFile = arg("--from-state");
  if (stateFile && stateFile !== true) {
    // Two state files can land here and only the token address ever leaves them. launch.py writes
    // { token, pair } for the v2 pool; the PONS fleet launcher writes { launches: [ { token, … } ] },
    // and that file also holds the fleet's private keys — read the address, nothing else, ever.
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    const fleet = Array.isArray(st.launches) ? [...st.launches].reverse().find(l => /^0x[0-9a-fA-F]{40}$/.test(l.token || "")) : null;
    const token = st.token || fleet?.token;
    if (!token) throw new Error(`${stateFile} has no token yet; run the launcher first`);
    b.address = token; b.venue = b.venue || (fleet ? "pons" : "uniswap-v2");
    if (!fleet && st.pair) b.pair = st.pair;
    if (!b.status) b.status = "live";
  }
  for (const [flag, key] of [["--x", "x"], ["--telegram", "telegram"], ["--launchpad", "launchpad"], ["--website", "website"]]) { const v = arg(flag); if (v !== undefined) links[key] = v === true ? "" : v; }
  if (Object.keys(links).length) b.links = links;
  if (arg("--reset")) b.reset = true; if (arg("--clear-updates")) b.clearUpdates = true;
  return b;
}

const MILESTONES = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
async function watch(minutes) {
  const until = Date.now() + minutes * 60_000; let crossed = -1, graduated = false, lastMc = 0;
  console.log(`watching ${API} for ${minutes} min; milestone updates go to the site as they happen`);
  while (Date.now() < until) {
    try {
      const l = await get(); const lv = l.live;
      if (lv && !lv.error) {
        const mc = lv.mcapUsd || 0;
        if (crossed < 0) { crossed = MILESTONES.findLastIndex(m => mc >= m); lastMc = mc; console.log(`${new Date().toISOString().slice(11, 19)} mcap ${k(mc)} · curve ${lv.curvePct != null ? Math.round(lv.curvePct * 100) + "%" : "?"}${lv.buys != null ? ` · buys ${lv.buys}` : ""}`); }
        const idx = MILESTONES.findLastIndex(m => mc >= m);
        if (idx > crossed) { crossed = idx; const text = `${k(MILESTONES[idx])} market cap.${lv.curvePct != null ? ` Curve ${Math.round(lv.curvePct * 100)}%.` : ""}`; await push({ update: text }); console.log("pushed:", text); announce({ ...l, live: lv }); }
        if (lv.pair && !graduated && l.status === "live" && !l.pair) { await push({ pair: lv.pair }); console.log("pushed: pair", lv.pair); }
        if (lv.graduated && !graduated) { graduated = true; await push({ status: "graduated", update: "Graduated. Trading on the pool now." }); console.log("pushed: graduated"); }
        if (Math.abs(mc - lastMc) / Math.max(1, lastMc) > 0.25) { console.log(`${new Date().toISOString().slice(11, 19)} mcap ${k(mc)}`); lastMc = mc; }
      } else if (lv?.error) console.log("chain read:", lv.error);
    } catch (err) { console.log("watch:", err.message); }
    await sleep(30_000);
  }
}

(async () => {
  if (arg("--show")) { console.log(JSON.stringify(await get(), null, 2)); return; }
  if (arg("--announce")) { announce(await get()); return; }
  const body = bodyFromArgs();
  if (Object.keys(body).length) { const l = await push(body); console.log(`site now: ${l.status} ${l.ticker || l.name} ${l.address || "(no address)"}${l.updates[0] ? ` · "${l.updates[0].text}"` : ""}`); }
  if (arg("--watch")) { const m = arg("--watch"); await watch(m === true ? 720 : Number(m) || 720); return; }
  if (!Object.keys(body).length) console.log("nothing to push; see the header of this file for flags");
})().catch(e => { console.error(e.message); process.exit(1); });
