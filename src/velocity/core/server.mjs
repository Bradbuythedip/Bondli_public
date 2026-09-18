// ═══ VELOCITY — Control server (E4, E5, E6, E7) ═══
// One screen, one kill switch. Binds to localhost by default.

import http from "node:http";

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}
function readBody(req) {
  return new Promise(resolve => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });
}

export function renderStatusHtml(s) {
  const esc = v => String(v ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const halt = (s.halt?.mode ? `<div class="banner red">HALTED (${esc(s.halt.mode)}): ${esc(s.halt.reason)}</div>` : "")
    + Object.entries(s.halt?.venues || {}).filter(([, h]) => h?.mode).map(([v, h]) => `<div class="banner red">${esc(v)} ${esc(h.mode)}: ${esc(h.reason)} (velocity resume ${esc(v)})</div>`).join("");
  const stale = s.now - (s.heartbeatAt || 0) > 60_000 ? `<div class="banner amber">stale: last heartbeat ${Math.round((s.now - s.heartbeatAt) / 1000)}s ago</div>` : "";
  const venues = Object.entries(s.venues).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v.mode)}</td><td>${v.blocked ? esc(v.blocked) : v.feed?.stale ? "stale" : v.feed ? "ok" : "no data"}</td><td>${v.feed?.ageMs ?? "-"}</td><td>${v.latency?.observe?.p95 ?? "-"}/${v.budget.observe}</td><td>${v.latency?.decide?.p95 ?? "-"}/${v.budget.decide}</td><td>${v.gos}/${v.evaluated}</td><td>${v.promotion.ok ? "ready" : v.promotion.items.filter(i => !i.ok).map(i => esc(i.name)).join(", ")}</td></tr>`).join("");
  const positions = s.positions.length ? s.positions.map(p => `<tr><td>${esc(p.venue)}</td><td>${esc(p.instrument)}</td><td>${esc(p.plan?.key)}</td><td>$${(p.notional_usd || 0).toFixed(2)}</td><td>${p.changePct == null ? "-" : p.changePct.toFixed(1) + "%"}</td><td>${p.unrealized_usd ?? "-"}</td></tr>`).join("") : `<tr><td colspan="6">no positions</td></tr>`;
  const decisions = s.lastDecisions.length ? s.lastDecisions.map(d => `<tr><td>${esc(d.venue)}</td><td>${esc(d.instrument)}</td><td class="${d.action === "GO" ? "go" : ""}">${esc(d.action)}</td><td>${esc(d.gate || "")}</td><td>${esc(d.reason || "")}</td><td><code>${esc(d.id)}</code></td></tr>`).join("") : `<tr><td colspan="6">no decisions yet (started ${new Date(s.startedAt).toISOString()})</td></tr>`;
  const used = s.day.used_pct;
  return `<!doctype html><meta charset="utf-8"><title>velocity status</title><style>body{font:14px system-ui;margin:16px;color:#111;background:#fafafa}table{border-collapse:collapse;margin:8px 0 16px}td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}.banner{padding:8px;margin:8px 0;border-radius:4px}.red{background:#fdd;color:#900}.amber{background:#ffe9b3}.bar{height:12px;background:#eee;width:300px}.bar i{display:block;height:100%;background:${used > 80 ? "#c00" : used > 50 ? "#e90" : "#3a3"};width:${Math.min(100, used)}%}.go{color:#070;font-weight:bold}code{font-size:12px}</style>
<h2>velocity</h2>${halt}${stale}
<p>throttle <b>${s.throttle}</b> · regime <b>${esc(s.regime)}</b> · governor: ${esc((s.governor?.reasons || []).join("; ") || "clear")}</p>
<p>day PnL <b>$${(s.day.realizedUsd || 0).toFixed(2)}</b> of a $${s.day.limit_usd} limit</p><div class="bar"><i></i></div>
<h3>venues</h3><table><tr><th>venue</th><th>mode</th><th>feed</th><th>age ms</th><th>observe p95/budget</th><th>decide p95/budget</th><th>go/evaluated</th><th>promotion</th></tr>${venues}</table>
<h3>positions</h3><table><tr><th>venue</th><th>instrument</th><th>plan</th><th>notional</th><th>change</th><th>unrealized</th></tr>${positions}</table>
<h3>last decisions</h3><table><tr><th>venue</th><th>instrument</th><th>action</th><th>gate</th><th>reason</th><th>id (use: velocity why &lt;id&gt;)</th></tr>${decisions}</table>
<h3>halt</h3><form method="post" action="/halt?mode=freeze"><button>freeze (no new entries, exits continue)</button></form><form method="post" action="/halt?mode=flatten"><button>flatten (close everything now)</button></form>
<p>alerts: ${s.alerts.map(a => `${new Date(a.ts).toISOString()} ${esc(a.level)} ${esc(a.text)}`).join("<br>") || "none"}</p>`;
}

export function startControlServer({ engine, host = "127.0.0.1", port = 3210 }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, running: engine.running, halt: engine.store.state.halt.mode });
      if (req.method === "GET" && url.pathname === "/status") return json(res, 200, engine.status());
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/status.html")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(renderStatusHtml(engine.status())); }
      if (req.method === "GET" && url.pathname.startsWith("/why/")) return json(res, 200, engine.why(decodeURIComponent(url.pathname.slice(5))));
      if (req.method === "GET" && url.pathname.startsWith("/promote/")) return json(res, 200, engine.promotion(url.pathname.slice(9)));
      if (req.method === "POST" && url.pathname === "/halt") {
        const body = await readBody(req);
        const mode = body.mode || url.searchParams.get("mode") || "freeze";
        const r = await engine.enqueue(() => engine.halt(mode, body.reason || "control server", { by: "http" }));
        return json(res, 200, r);
      }
      if (req.method === "POST" && url.pathname === "/resume") { const body = await readBody(req); return json(res, 200, engine.resume(body.venue, { by: "http" })); }
      // A mode change runs inside the engine queue so it cannot interleave with an entry or an exit.
      const queued = fn => new Promise(resolve => engine.enqueue(async () => { try { resolve(await fn()); } catch (err) { resolve({ ok: false, error: err.message }); } }));
      if (req.method === "POST" && url.pathname === "/venue") { const body = await readBody(req); return json(res, 200, await queued(() => engine.setVenueMode(body.venue, body.mode, { override: !!body.override, by: "http" }))); }
      if (req.method === "POST" && url.pathname.startsWith("/promote/")) return json(res, 200, await queued(() => engine.setVenueMode(url.pathname.slice(9), "live", { by: "http" })));
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}` }));
  });
}
