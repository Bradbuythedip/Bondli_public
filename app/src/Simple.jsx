// Bondli — one page. A bot that trades memecoins for you.
// The page has one primary action at a time: connect, fund, start, watch, stop. Everything the bot
// does is shown in its own words; nothing is explained in prose that the narration already shows.
import React, { useState, useEffect, useCallback, useRef } from "react";
import { TC, D, L, BLUE, CHIP_TINT, css } from "./lib/theme.js";
import { M, S, imgUrl, X_URL, DISCORD_URL, TOKEN_SYMBOL, TOKEN_URL } from "./lib/constants.js";
import a from "./lib/api-client.js";
import { shareCard, canShareCard } from "./lib/sharecard.js";
import { useT, useLang, tEn, LANGS } from "./lib/i18n.js";

const FEE_PCT = 5;
// The risk dial. Each stop is a full profile in the engine (AGGRESSION in the pumpfun edge).
// The words for each stop live in the dictionary as agg.<k> (the label) and agg.<k>.d (the line under it).
const AGG = [{ v: 0, k: "safe" }, { v: 1, k: "careful" }, { v: 2, k: "normal" }, { v: 3, k: "degen" }];
const aggL = (t, v) => t(`agg.${AGG[v]?.k || "normal"}`);
// Every round trip pays the venue 1.5% each way and about $0.61 of fixed cost (two priority fees and
// the token account's rent), so the fixed part is what decides whether a size can work at all: it is
// 12% of a $5 trade and 1.2% of a $50 one. $5 and $10 needed a +15% and a +9% move on every single
// trade just to break even, which is not a bet, it is a fee. They are gone.
const SIZES = [25, 50, 100, 250];
const SOL_USD_FALLBACK = 200;
/** What one round trip costs at this size, as a percentage — the move needed just to get even. */
const dragPct = (usd, solPrice) => { const p = solPrice > 0 ? solPrice : SOL_USD_FALLBACK; return ((usd * 0.03) + (0.001 + 0.00001) * p + 0.00203928 * p) / usd * 100; };
const fmt = n => (n < 0 ? "-$" : "$") + Math.abs(Number(n) || 0).toFixed(2);
const phantom = () => (window?.phantom?.solana?.isPhantom ? window.phantom.solana : window?.solana?.isPhantom ? window.solana : null);

// The two places the project talks, as their own marks rather than words. Both open in a new tab.
const XIcon = ({ s = 15 }) => <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>;
const DiscordIcon = ({ s = 16 }) => <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037a13.76 13.76 0 0 0-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.65 12.65 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.2 14.2 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.1 13.1 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.009c.12.099.246.199.373.293a.077.077 0 0 1-.006.127a12.3 12.3 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.84 19.84 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.182 0-2.157-1.086-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.211 0 2.176 1.096 2.157 2.42c0 1.332-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.332-.946 2.418-2.157 2.418z" /></svg>;
function Socials({ T }) {
  const t = useT();
  const link = { display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 13px", borderRadius: 10, border: `1px solid ${T.bd}`, color: T.dm, textDecoration: "none", fontFamily: S, fontWeight: 800, fontSize: 13 };
  return <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 18 }}>
    <a href={X_URL} target="_blank" rel="noopener" style={link} aria-label={t("social.x")}><XIcon /> <span>@shitanalystXBT</span></a>
    <a href={DISCORD_URL} target="_blank" rel="noopener" style={link} aria-label={t("social.discord")}><DiscordIcon /> <span>Discord</span></a>
  </div>;
}

function Btn({ children, onClick, disabled, danger, ghost, T, big }) {
  return <button onClick={disabled ? undefined : onClick} style={{ width: "100%", padding: big ? "18px 20px" : "12px 16px", borderRadius: 12, border: ghost || danger ? `1px solid ${danger ? T.rd : T.bd}` : "none", background: ghost || danger ? "transparent" : T.gn, color: danger ? T.rd : ghost ? T.tx : "#000", fontFamily: S, fontWeight: 900, fontSize: big ? 20 : 15, letterSpacing: ".01em", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? .45 : 1 }}>{children}</button>;
}

// Proof of life between decisions: the engine only writes a line when it judges a token, so this row
// re-reads the heartbeat, the feed age and the judged count on every poll and says what it is doing now.
function Pulse({ st, T }) {
  const t = useT();
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(id); }, []);
  const s = st?.status; if (!s) return null;
  const now = Date.now();
  const v = s.venues?.pumpfun || {};
  const hb = s.heartbeatAt ? (now - s.heartbeatAt) / 1000 : null;
  const feedAge = v.feed?.ageMs != null ? v.feed.ageMs / 1000 : null;
  const judged = v.evaluated || 0, gos = v.gos || 0;
  const last = st.narration?.length ? (now - st.narration[st.narration.length - 1].ts) / 1000 : null;
  const dead = hb != null && hb > 45, stale = v.feed?.stale || (feedAge != null && feedAge > 30);
  const c = dead ? T.rd : stale ? T.yl : T.gn;
  const what = dead ? t("pulse.dead") : stale ? t("pulse.stale") : s.halt?.mode ? (/user/.test(s.halt.reason || "") ? t("pulse.pausedByYou") : t("pulse.paused", { reason: s.halt.reason })) : judged === 0 ? t("pulse.waitingFirst") : t("pulse.watching");
  const dots = ".".repeat(1 + (Math.floor(now / 500) % 3));
  const f = st.funnel;
  const gate = g => (t.has(`gate.${g}`) ? t(`gate.${g}`) : g);
  return <>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, fontFamily: M, fontSize: 11, color: T.ft }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: c }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: c, animation: dead ? "none" : "gp 1.5s infinite" }} />{what}{dead || stale ? "" : dots}</span>
      <span>{t("pulse.counts", { judged, gos })}{last != null ? t("pulse.last", { ago: last < 60 ? Math.round(last) + t("unit.s") : Math.round(last / 60) + t("unit.m") }) : ""}</span>
    </div>
    {(s.throttle === 0 || s.halt?.mode) && s.governor?.reasons?.length > 0 && <div style={{ marginTop: 6, fontFamily: M, fontSize: 11, color: T.yl, lineHeight: 1.5 }}>{t("pulse.governor")}{s.governor.reasons.join(" · ")}</div>}
    {f && f.judged > 0 && <div style={{ marginTop: 6, fontFamily: M, fontSize: 11, color: T.ft, lineHeight: 1.5 }}>
      {t("pulse.funnel", { distinct: f.distinct, judged: f.judged, gos: f.gos, filled: f.filled })}{f.gos > f.filled && f.sized0 ? t("pulse.noSize", { list: Object.keys(f.sized0).join(", ").toLowerCase().replace(/_/g, " ") }) : ""}{f.failed ? t("pulse.failed", { list: Object.keys(f.failed).join(", ").toLowerCase().replace(/_/g, " ") }) : ""}
      <div>{Object.entries(f.gates).sort((a, b) => b[1] - a[1]).map(([g, n]) => <span key={g} style={{ marginRight: 10 }}>{gate(g)} <b style={{ color: T.dm }}>{n}</b></span>)}</div>
    </div>}
  </>;
}
// The market as the bot sees it: newest launches, a sparkline, the score, and the bot's one-word verdict.
// Ages and hold times take the page's translator for their unit; with none they read in English,
// which is what the tweet and the share card want whatever the page is showing.
const ago = (ms, t = tEn) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}${t("unit.s")}` : ms < 3600_000 ? `${Math.round(ms / 60_000)}${t("unit.m")}` : `${Math.round(ms / 3600_000)}${t("unit.h")}`;
const kfmt = n => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : `$${Math.round(n)}`;
function Spark({ v, T, w = 72, h = 22 }) {
  const pts = (v || []).filter(x => x > 0);
  if (pts.length < 2) return <svg width={w} height={h} style={{ display: "block" }}><line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke={T.bd} strokeWidth="1.5" /></svg>;
  const mn = Math.min(...pts), mx = Math.max(...pts), r = mx - mn || 1;
  const d = pts.map((y, i) => `${(i / (pts.length - 1)) * w},${h - 2 - ((y - mn) / r) * (h - 4)}`).join(" ");
  const up = pts[pts.length - 1] >= pts[0];
  return <svg width={w} height={h} style={{ display: "block" }}><polyline points={d} fill="none" stroke={up ? T.gn : T.rd} strokeWidth="1.5" strokeLinejoin="round" /></svg>;
}
// The bot's one reason per token, in plain words.
// The word for each is tag.<key> in the dictionary; this is only the ink it is written in.
const TAG = { hot: "gn", close: "yl", cooking: "yl", weak: "ft", new: "ft", nobuyers: "ft", fewbuyers: "ft", small: "ft", late: "ft", rug: "rd", mayhem: "ft", copy: "ft" };
// Risk reads green → yellow → red, the same three colours the rest of the page uses for gain, caution, loss.
const RISK_C = (v, T) => v >= 3 ? T.rd : v >= 2 ? T.yl : T.gn;
function Dial({ value, onChange, T }) {
  const t = useT();
  const n = AGG.length, c = RISK_C(value, T);
  return <div style={{ marginTop: 8 }}>
    <div style={{ display: "flex", gap: 4 }}>{AGG.map(o => <div key={o.v} onClick={() => onChange(o.v)} style={{ flex: 1, height: 10, borderRadius: 5, cursor: "pointer", background: o.v <= value ? RISK_C(o.v, T) : T.bg, border: `1px solid ${o.v <= value ? RISK_C(o.v, T) : T.bd}`, opacity: o.v <= value ? (o.v === value ? 1 : .55) : 1, transition: "background .15s, opacity .15s" }} />)}</div>
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${n}, 1fr)`, marginTop: 6 }}>{AGG.map(o => <button key={o.v} onClick={() => onChange(o.v)} style={{ background: "none", border: "none", padding: "2px 0", fontSize: 12, fontWeight: 800, cursor: "pointer", color: o.v === value ? c : T.ft, textAlign: o.v === 0 ? "left" : o.v === n - 1 ? "right" : "center" }}>{t(`agg.${o.k}`)}</button>)}</div>
  </div>;
}
const HUE = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
// A token picture through the proxy (by url, else by mint from DexScreener's copy). While it loads the
// tile is a soft, shimmering blur in the token's own hue with the ticker over it; the picture blurs in
// on top. Six retries over ~90s because a token's picture usually exists a minute after its launch.
const IMG_RETRY_MS = [8_000, 32_000, 32_000, 32_000, 45_000, 45_000, 60_000, 60_000, 60_000, 60_000]; // ~7 min
function TokenImg({ src, ca, label, size, T }) {
  const [tries, sTries] = useState(0); const [ok, sOk] = useState(true); const [ready, sReady] = useState(null);
  const ref = useRef(null);
  useEffect(() => { sTries(0); sOk(true); sReady(null); }, [src, ca]);
  const h = HUE(ca);
  const tile = { width: size, height: size, borderRadius: Math.round(size / 4), overflow: "hidden", position: "relative", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: M, fontWeight: 900, fontSize: Math.round(size / 3.2), color: "rgba(255,255,255,.55)", background: `radial-gradient(circle at 30% 30%, hsl(${h} 45% 34%), hsl(${(h + 40) % 360} 40% 18%))` };
  const fuzz = <div style={{ position: "absolute", inset: 0, background: `linear-gradient(110deg, transparent 30%, hsl(${h} 60% 60% / .25) 50%, transparent 70%)`, backgroundSize: "200% 100%", animation: "shimmer 1.6s linear infinite", filter: "blur(6px)" }} />;
  const url = imgUrl(src, ca);
  const full = url ? url + (tries ? `&r=${tries}` : "") : "";
  const loaded = ready === full;
  // Nothing half-drawn is ever put on screen, and nothing that DID arrive is ever thrown away.
  //
  // The picture loads in a real <img> that is in the document but invisible (opacity 0 is still a
  // full paint, so a progressive JPEG draws its bands where nobody can see them). It is revealed only
  // once there is a whole frame: decode() when the browser has it, which resolves when the frame is
  // ready to present. But decode() is NOT the judge of whether the picture exists. On WebKit it can
  // reject for a picture that loaded perfectly well -- a detached element, a large frame, memory
  // pressure -- and the previous version of this tile fetched into a detached Image and treated any
  // rejection as a miss, so on an iPhone a good picture was retried into the ground and then
  // replaced by the ticker. Now: onerror is the only miss. If decode() rejects but the element says
  // it has pixels (complete, naturalWidth > 0), the picture is real and it is shown.
  const reveal = () => { const el = ref.current; if (el && el.complete && el.naturalWidth > 0) sReady(full); };
  const onLoad = () => {
    const el = ref.current; if (!el) return;
    if (el.decode) el.decode().then(reveal, reveal); else reveal();
  };
  const onError = () => {
    // A token's picture usually exists a minute or three after its launch, and the proxy remembers
    // a miss for 30s. Retry on a schedule that outlasts the metadata, each gap past that negative
    // cache so the retry is a real fetch, and only then settle for the ticker.
    if (tries < IMG_RETRY_MS.length) setTimeout(() => sTries(t => t + 1), IMG_RETRY_MS[tries]);
    else sOk(false);
  };
  if (!url || !ok) return <div style={tile}>{label}</div>;
  return <div style={tile}>{!loaded && fuzz}{!loaded && <span style={{ position: "relative" }}>{label}</span>}
    <img ref={ref} key={full} src={full} alt="" decoding="async" onLoad={onLoad} onError={onError}
      style={{ position: "absolute", inset: 0, width: size, height: size, objectFit: "cover", opacity: loaded ? 1 : 0, animation: loaded ? "imgin .35s ease-out" : "none" }} /></div>;
}
// ── Heartbeat ──────────────────────────────────────────────────────────────────
// The landing page's proof that the thing is real, from every bot on the site with no wallet named:
// how many are trading now, what closed today, the best of it. "0 bots trading" in a corner was the
// opposite of this. When there is nothing yet it says nothing -- an empty pulse is not a pulse.
const held = (ms, t = tEn) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}${t("unit.s")}` : `${Math.round(ms / 60_000)}${t("unit.m")}`;
const shareText = (c) => `${c.pnl_pct >= 0 ? "+" : ""}${Number(c.pnl_pct).toFixed(0)}% on $${(c.ticker || c.instrument.slice(0, 6)).replace(/^\$/, "")} in ${held(c.held_ms)}. The bot did it, not me 🐸`;
const shareUrl = (c) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText(c))}&url=${encodeURIComponent("https://bondli.fun")}`;
// The picture beside the words: the same won close as a 1200x630 card through the phone's share
// sheet, or saved on a desktop. Never on paper, never on a loss -- canShareCard is the one rule.
// A failure (no painting and no logo, or a canvas that will not hand back a blob) goes to the page's
// toast where there is one, and otherwise reads on the button itself for a moment; a button that
// says "…" and then nothing is the one outcome this must not have.
function ShareCardBtn({ c, T, small, onError }) {
  const t = useT();
  const [busy, sBusy] = useState(false);
  const [fail, sFail] = useState(false);
  if (!canShareCard(c)) return null;
  const go = async () => {
    if (busy) return; sBusy(true);
    try { await shareCard(c, T); }
    catch (e) { const m = t("share.cardFail", { err: e?.message || String(e) }); if (onError) onError(m); else { sFail(true); setTimeout(() => sFail(false), 6000); } }
    finally { sBusy(false); }
  };
  return <button onClick={go} aria-label={t("share.cardAria")} style={{ flexShrink: 0, fontFamily: S, fontWeight: 800, fontSize: small ? 11 : 12, color: fail ? T.rd : T.gn, background: "transparent", border: `1px solid ${fail ? T.rd : T.gn}66`, borderRadius: 8, padding: small ? "3px 8px" : "5px 9px", cursor: busy ? "wait" : "pointer" }}>{busy ? "…" : fail ? t("share.cardFailShort") : t("share.card")}</button>;
}
// The exit, in the words the callouts use, so the tape and a Telegram post say the same thing.
const exitWord = r => { const w = String(r || "").toLowerCase(); return /stop/.test(w) ? "stopped" : /stall|doa/.test(w) ? "cut flat" : /max_hold|timeout|time/.test(w) ? "timed out" : w ? w.replace(/_/g, " ") : "closed"; };
// The tape: every bot's last dozen closes drifting past under the heartbeat. Losses are on it, paper
// is on it as "paper" in the neutral ink and never in green or red -- the strip is a pulse, not a
// pitch. The rows are rendered twice so the loop has no seam; with reduced motion the copy is hidden
// and the one row wraps and stands still (theme.js).
function Tape({ rows, T }) {
  const t = useT();
  if (!rows?.length) return null;
  const item = (c, i) => {
    const pct = `${c.pnl_pct > 0 ? "+" : ""}${Number(c.pnl_pct).toFixed(0)}%`;
    const tk = `$${(c.ticker || String(c.instrument || "").slice(0, 6)).replace(/^\$/, "")}`;
    // The fixed exit words have a translation; a raw reason from the ledger passes through as it is.
    const ex = exitWord(c.reason), exl = t.has(`exit.${ex}`) ? t(`exit.${ex}`) : ex;
    const line = c.pnl_pct > 0 ? t("tape.win", { pct, tk, held: held(c.held_ms, t) }) : t("tape.loss", { pct, tk, exit: exl });
    const col = c.paper || c.pnl_pct === 0 ? T.dm : c.pnl_pct > 0 ? T.gn : T.rd;
    return <span key={`${c.ts}:${c.instrument}:${i}`} style={{ whiteSpace: "nowrap", padding: "0 10px", color: col }}>{c.paper ? <span style={{ color: T.ft }}>{t("tape.paper")}</span> : null}{line}<span style={{ color: T.ft }}> ·</span></span>;
  };
  return <div style={{ width: "100%" }}>
    <div style={{ color: T.ft, fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em", textAlign: "center", marginBottom: 4 }}>{t("tape.label")}</div>
    <div className="card tapebox" style={{ border: `1px solid ${T.bd}`, borderRadius: 10, padding: "7px 0", overflow: "hidden", fontFamily: M, fontSize: 12, fontWeight: 800 }}>
      <div className="tape"><span style={{ display: "flex" }}>{rows.map(item)}</span><span data-tape-copy aria-hidden="true" style={{ display: "flex" }}>{rows.map(item)}</span></div>
    </div>
  </div>;
}
function Heartbeat({ T }) {
  const t = useT();
  const [d, sD] = useState(null);
  useEffect(() => { let on = true; const poll = async () => { try { const r = await a.pulse(); if (on) sD(r); } catch {} }; poll(); const id = setInterval(poll, 20_000); return () => { on = false; clearInterval(id); }; }, []);
  // The three cards need money behind them; the tape only needs closes, paper ones say so on the strip.
  const cards = !!d && (d.live > 0 || d.closes > 0);
  if (!d || (!cards && !d.tape?.length)) return null;
  const muted = { color: T.ft, fontSize: 12 };
  const best = d.best?.[0];
  return <div style={{ width: "100%", maxWidth: 440, marginBottom: 18, display: "flex", flexDirection: "column", gap: 8 }}>
    {cards && <div style={{ display: "flex", gap: 6 }}>
      {[[d.live, t("beat.live"), "gn"], [d.closes, t("beat.closes"), "tx"], [d.closes ? `${Math.round(100 * d.wins / d.closes)}%` : "—", t("beat.won"), d.closes && d.wins / d.closes >= .3 ? "gn" : "dm"]].map(([n, l, c]) =>
        <div key={l} className="card" style={{ flex: 1, border: `1px solid ${T.bd}`, borderRadius: 10, padding: "8px 0", textAlign: "center" }}><div style={{ fontFamily: M, fontWeight: 900, fontSize: 20, color: T[c] }}>{n}</div><div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>{l}</div></div>)}
    </div>}
    {cards && best && <div className="card" style={{ border: `1px solid ${T.gn}55`, borderRadius: 10, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
      <span style={{ ...muted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("beat.best")}<b style={{ color: T.tx }}>${(best.ticker || best.instrument.slice(0, 6)).replace(/^\$/, "")}</b>{t("beat.in", { held: held(best.held_ms, t) })}</span>
      <span style={{ fontFamily: M, fontWeight: 900, fontSize: 18, color: T.gn, flexShrink: 0 }}>+{Number(best.pnl_pct).toFixed(0)}%</span>
    </div>}
    <Tape rows={d.tape} T={T} />
  </div>;
}

// ── Movers ─────────────────────────────────────────────────────────────────────
// The other half of "what is happening": the launch radar above only ever sees tokens in their first
// hours, so anything that already ran was invisible here. /api/movers has been on the server all
// along, feeding nothing. These are NOT the bot's picks -- it trades launches, not established
// tokens -- so the panel says so rather than implying a signal it is not acting on.
const TF = [["1h", "movers.1h"], ["6h", "movers.6h"], ["24h", "movers.24h"]];
const pctOf = n => `${n >= 0 ? "+" : ""}${(Number(n) || 0).toFixed(n != null && Math.abs(n) >= 100 ? 0 : 1)}%`;
function Movers({ T }) {
  const t = useT();
  const [tf, sTf] = useState("24h");
  const [d, sD] = useState(null);
  const [err, sErr] = useState(null);
  useEffect(() => {
    let on = true;
    sD(null); sErr(null);
    const poll = async () => { try { const r = await a.movers(tf); if (on) { sD(r); sErr(null); } } catch (e) { if (on && !d) sErr(e.message); } };
    poll();
    const id = setInterval(poll, 60_000); // these move on the hour, not the second
    return () => { on = false; clearInterval(id); };
  }, [tf]);
  const muted = { color: T.ft, fontSize: 12 };
  const row = (tok) => {
    const ch = Number(tok.change24h) || 0;
    const initial = (tok.ticker || tok.name || "?").slice(0, 2).toUpperCase();
    return <a key={tok.ca} href={tok.dexUrl || `https://dexscreener.com/solana/${tok.ca}`} target="_blank" rel="noopener"
      style={{ display: "grid", gridTemplateColumns: "44px 1fr 86px", gap: 12, alignItems: "center", padding: "9px 12px", borderTop: `1px solid ${T.bd}`, color: "inherit", textDecoration: "none" }}>
      <TokenImg src={tok.image} ca={tok.ca} label={initial} size={44} T={T} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
          <span style={{ fontWeight: 800, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tok.name || tok.ca.slice(0, 6)}</span>
          <span style={{ ...muted, fontFamily: M, whiteSpace: "nowrap" }}>{tok.ticker}</span>
        </div>
        <div style={{ ...muted, fontFamily: M, fontSize: 12, marginTop: 2 }}>{kfmt(tok.mcapUsd || 0)}{tok.volume24h ? t("movers.vol", { v: kfmt(tok.volume24h) }) : ""}{tok.liquidity ? t("movers.liq", { v: kfmt(tok.liquidity) }) : ""}</div>
      </div>
      <div style={{ textAlign: "right", fontFamily: M, fontWeight: 900, fontSize: 16, color: ch >= 0 ? T.gn : T.rd }}>{pctOf(ch)}</div>
    </a>;
  };
  const section = (title, note, rows) => rows?.length ? <div key={title} style={{ marginBottom: 14 }}>
    <div style={{ ...muted, marginBottom: 6, display: "flex", justifyContent: "space-between", gap: 10 }}><span>{title}</span><span style={{ textAlign: "right" }}>{note}</span></div>
    <div style={{ background: T.sf + "f5", border: `1px solid ${T.bd}`, borderRadius: 12, overflow: "hidden" }}>{rows.slice(0, 12).map(row)}</div>
  </div> : null;
  if (err) return <div style={{ ...muted, padding: "18px 0", textAlign: "center" }}>{t("movers.err", { err })}</div>;
  if (!d) return <div style={{ ...muted, padding: "18px 0", textAlign: "center" }}>{t("movers.reading")}</div>;
  const any = (d.topGainers?.length || 0) + (d.apeTargets?.length || 0) + (d.watchList?.length || 0) + (d.hotGraduated?.length || 0) + (d.trending?.length || 0);
  return <div>
    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
      {TF.map(([k, l]) => <button key={k} onClick={() => sTf(k)} style={{ flex: 1, padding: "8px 0", borderRadius: 10, border: `1px solid ${tf === k ? T.gn : T.bd}`, background: tf === k ? T.gn + "1c" : "transparent", color: tf === k ? T.gn : T.dm, fontFamily: M, fontWeight: 800, cursor: "pointer" }}>{t(l)}</button>)}
    </div>
    {!any && <div style={{ ...muted, padding: "18px 0", textAlign: "center" }}>{t("movers.none", { tf: t(`movers.${tf}`) })}</div>}
    {section(t("movers.gainers"), t("movers.gainers.n"), d.topGainers)}
    {section(t("movers.scored"), t("movers.scored.n"), d.apeTargets)}
    {section(t("movers.watch"), t("movers.watch.n"), d.watchList)}
    {section(t("movers.grad"), t("movers.grad.n"), d.hotGraduated)}
    {section(t("movers.trending"), t("movers.trending.n"), d.trending)}
    <div style={{ ...muted, marginTop: 4, textAlign: "center" }}>
      {t("movers.note")}
      {d.updatedAt ? t("movers.updated", { ago: ago(Date.now() - d.updatedAt, t) }) : ""}
    </div>
  </div>;
}

// ── Calls ──────────────────────────────────────────────────────────────────────
// The bot's own live buys, posted the moment they fill: the token, the market cap it paid, the exit
// plan it declared, the transaction, and later how it went. Each one is written to the ledger with a
// hash before any channel sees it, so nothing can be edited after the fact -- a track record, not a
// highlight reel. Paper fills never appear here, and losses stay on the list.
function Calls({ T }) {
  const t = useT();
  const [d, sD] = useState(null);
  const [err, sErr] = useState(null);
  useEffect(() => { let on = true; const poll = async () => { try { const r = await a.calls(); if (on) { sD(r); sErr(null); } } catch (e) { if (on) sErr(e.message); } }; poll(); const id = setInterval(poll, 20_000); return () => { on = false; clearInterval(id); }; }, []);
  const muted = { color: T.ft, fontSize: 12 };
  if (err && !d) return <div style={{ ...muted, padding: "18px 0", textAlign: "center" }}>{t("calls.err", { err })}</div>;
  if (!d) return <div style={{ ...muted, padding: "18px 0", textAlign: "center" }}>{t("calls.reading")}</div>;
  const r = d.record || {};
  const chainOf = v => v === "pons" ? "RH" : v === "arc" ? "ARC" : "SOL";
  const row = c => {
    const res = c.result;
    const col = !res ? T.dm : res.pnl_pct >= 0 ? T.gn : T.rd;
    return <a key={c.id} href={c.txUrl || c.url} target="_blank" rel="noopener"
      style={{ display: "grid", gridTemplateColumns: "1fr 78px", gap: 10, alignItems: "center", padding: "9px 12px", borderTop: `1px solid ${T.bd}`, color: "inherit", textDecoration: "none" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
          <span style={{ fontWeight: 800, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name || c.instrument.slice(0, 6)}</span>
          <span style={{ ...muted, fontFamily: M, whiteSpace: "nowrap" }}>{c.ticker}</span>
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".05em", color: BLUE, background: CHIP_TINT, padding: "1px 5px", borderRadius: 4, whiteSpace: "nowrap" }}>{chainOf(c.venue)}</span>
        </div>
        <div style={{ ...muted, fontFamily: M, fontSize: 12, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t("calls.row", { mcap: kfmt(c.mcapUsd || 0), tier: c.tier, ago: ago(Date.now() - c.ts, t) })}{c.plan ? ` · ${c.plan}` : ""}</div>
      </div>
      <div style={{ textAlign: "right", fontFamily: M, fontWeight: 900, fontSize: 15, color: col }}>{res ? pctOf(res.pnl_pct) : t("calls.open")}{res && <div style={{ ...muted, fontSize: 10, fontWeight: 600 }}>{t("calls.in", { held: held(res.held_ms, t) })}</div>}</div>
    </a>;
  };
  // A won call is the most shareable thing on the site: the tx is public, the hash was on the ledger
  // before the post, and the tweet says so. Only wins, only resolved: a share link on an open call
  // would be an opinion, which a callout is not.
  const shareCall = c => c.result && c.result.pnl_pct > 0 ? <div key={c.id + ":share"} style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, padding: "4px 12px 8px" }}>
    <a href={shareUrl({ pnl_pct: c.result.pnl_pct, ticker: c.ticker, instrument: c.instrument, held_ms: c.result.held_ms })} target="_blank" rel="noopener"
      style={{ fontSize: 11, color: T.gn, textDecoration: "none", fontWeight: 700 }}>{t("share.call")}</a>
    <ShareCardBtn small T={T} c={{ pnl_pct: c.result.pnl_pct, ticker: c.ticker, instrument: c.instrument, held_ms: c.result.held_ms, tx: c.tx }} />
  </div> : null;
  return <div>
    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
      {[[r.calls || 0, t("calls.calls"), "tx"], [r.resolved ? `${Math.round(100 * (r.winRate || 0))}%` : "—", t("calls.won"), r.resolved && r.winRate >= .3 ? "gn" : "dm"], [r.resolved ? pctOf(r.avgPct) : "—", t("calls.avg"), (r.avgPct || 0) >= 0 ? "gn" : "rd"], [r.best != null ? pctOf(r.best) : "—", t("calls.best"), "gn"]].map(([n, l, c]) =>
        <div key={l} className="card" style={{ flex: 1, border: `1px solid ${T.bd}`, borderRadius: 10, padding: "8px 0", textAlign: "center" }}><div style={{ fontFamily: M, fontWeight: 900, fontSize: 18, color: T[c] }}>{n}</div><div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>{l}</div></div>)}
    </div>
    {d.calls?.length ? <div style={{ background: T.sf + "f5", border: `1px solid ${T.bd}`, borderRadius: 12, overflow: "hidden" }}>{d.calls.flatMap(c => [row(c), shareCall(c)])}</div>
      : <div style={{ ...muted, padding: "18px 0", textAlign: "center" }}>{t("calls.none", { tier: d.minTier ?? 2 })}</div>}
    <div style={{ ...muted, marginTop: 8, textAlign: "center" }}>{t("calls.note")}</div>
  </div>;
}

// ── Lore ───────────────────────────────────────────────────────────────────────
// Where the frog comes from, in four lines, with the sources as chips. The OG links are the
// character's own history, not ours: the comic, its author, the film, and the coin that put the frog
// on top of the memecoin table. The last line is the disclaimer, in the same voice as the rest.
const LORE_LINKS = [
  ["pepe.vip", "https://pepe.vip"],
  ["Matt Furie", "https://mattfurie.com"],
  ["Boy's Club", "https://en.wikipedia.org/wiki/Boy%27s_Club_(comics)"],
  ["Feels Good Man", "https://en.wikipedia.org/wiki/Feels_Good_Man"],
];
// The four lines, by key: lore.1 to lore.4 in the dictionary, the last one the disclaimer.
const LORE_LINES = ["lore.1", "lore.2", "lore.3", "lore.4"];
function Lore({ T }) {
  const t = useT();
  const chip = { display: "inline-flex", alignItems: "center", padding: "6px 11px", borderRadius: 999, border: `1px solid ${T.bd}`, color: T.dm, textDecoration: "none", fontFamily: S, fontWeight: 800, fontSize: 12 };
  return <div className="card" style={{ width: "100%", maxWidth: 560, marginTop: 28, border: `1px solid ${T.bd}`, borderRadius: 16, padding: 20 }}>
    <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: "-.01em", marginBottom: 10 }}>{t("lore.title")}</div>
    {LORE_LINES.map((k, i) => <p key={k} style={{ color: i === LORE_LINES.length - 1 ? T.ft : T.dm, fontSize: 13, lineHeight: 1.55, marginTop: i ? 8 : 0 }}>{t(k)}</p>)}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
      {LORE_LINKS.map(([l, href]) => <a key={href} href={href} target="_blank" rel="noopener" style={chip}>{l}</a>)}
    </div>
  </div>;
}

// The public panel: the launch radar the bot actually acts on, its own calls, and the wider market beside them.
function Watch({ T, agg }) {
  const t = useT();
  const [tab, sTab] = useState(() => { try { const k = localStorage.getItem("bondli_watch_tab"); return k === "movers" || k === "calls" ? k : "bot"; } catch { return "bot"; } });
  const pick = (k) => { sTab(k); try { localStorage.setItem("bondli_watch_tab", k); } catch {} };
  return <div style={{ width: "100%", maxWidth: 560, marginTop: 32 }}>
    <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
      {[["bot", "watch.bot"], ["calls", "watch.calls"], ["movers", "watch.movers"]].map(([k, l]) => <button key={k} onClick={() => pick(k)}
        style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: `1px solid ${tab === k ? T.gn : T.bd}`, background: tab === k ? T.gn + "1c" : "transparent", color: tab === k ? T.gn : T.dm, fontFamily: S, fontWeight: 800, fontSize: 14, cursor: "pointer" }}>{t(l)}</button>)}
    </div>
    {tab === "bot" ? <Live T={T} agg={agg} /> : tab === "calls" ? <Calls T={T} /> : <Movers T={T} />}
  </div>;
}

function Live({ T, agg }) {
  const t = useT();
  const [d, sD] = useState(null);
  useEffect(() => { let on = true; const poll = async () => { try { const r = await a.live(agg); if (on) sD(r); } catch {} }; poll(); const id = setInterval(poll, 3000); return () => { on = false; clearInterval(id); }; }, [agg]);
  if (!d) return null;
  const now = d.ts || Date.now();
  const muted = { color: T.ft, fontSize: 12 };
  return <div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
      <span style={{ fontWeight: 800, fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: d.online ? T.gn : T.rd, animation: d.online ? "gp 2s infinite" : "none" }} />{d.online ? t("live.on") : t("live.off")}</span>
      <span style={muted}>{d.bots != null ? t("live.bots", { n: d.bots }) : ""}</span>
    </div>
    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
      {[["live.launched", d.hour.launches, "tx"], ["live.buyzone", d.hour.hot, "gn"], ["live.robinhood", d.hour.robinhood ?? 0, "dm"], ...(d.hour.arc > 0 ? [["live.arc", d.hour.arc, "dm"]] : []), ["live.mayhem", d.hour.mayhem, "ft"]].map(([l, n, c]) => <div key={l} style={{ flex: 1, background: T.sf + "f5", border: `1px solid ${T.bd}`, borderRadius: 10, padding: "8px 0", textAlign: "center" }}><div style={{ fontFamily: M, fontWeight: 900, fontSize: 22, color: T[c] }}>{n}</div><div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>{t.has(l) ? t(l) : l}</div></div>)}
    </div>
    {d.revivals?.length > 0 && <>
      <div style={{ ...muted, marginBottom: 6 }}>{t("live.revivals")}</div>
      <div style={{ background: T.sf + "f5", border: `1px solid ${T.yl}55`, borderRadius: 12, overflow: "hidden", marginBottom: 14 }}>{d.revivals.map(x => rowOf(x, true))}</div>
    </>}
    {d.cooking?.length > 0 && <>
      <div style={{ ...muted, marginBottom: 6 }}>{t("live.cooking")}</div>
      <div style={{ background: T.sf + "f5", border: `1px solid ${T.yl}55`, borderRadius: 12, overflow: "hidden", marginBottom: 14 }}>{d.cooking.map(x => rowOf(x))}</div>
    </>}
    <div style={{ ...muted, marginBottom: 6, display: "flex", justifyContent: "space-between" }}><span>{t("live.hour", { level: aggL(t, d.aggression ?? agg) })}</span><span>{t("live.tap")}</span></div>
    <div style={{ background: T.sf + "f5", border: `1px solid ${T.bd}`, borderRadius: 12, overflow: "hidden" }}>
      {d.tokens.slice(0, 25).map(x => rowOf(x))}
      {!d.tokens.length && <div style={{ ...muted, padding: 14, textAlign: "center" }}>{t("live.waiting")}</div>}
    </div>
  </div>;
  function rowOf(tok, revival = false) { const tag = TAG[tok.tag] ? tok.tag : "weak", c = TAG[tag], label = t(`tag.${tag}`); const dim = tok.tag === "mayhem" || tok.tag === "copy"; const initial = (tok.ticker || tok.name || "?").slice(0, 2).toUpperCase(); return <a key={tok.ca} href={tok.url || `https://pump.fun/coin/${tok.ca}`} target="_blank" rel="noopener" style={{ display: "grid", gridTemplateColumns: "56px 1fr 100px 68px", gap: 12, alignItems: "center", padding: "9px 12px", borderTop: `1px solid ${T.bd}`, opacity: dim ? .45 : 1, color: "inherit", textDecoration: "none" }}>
        <TokenImg src={tok.image} ca={tok.ca} label={initial} size={56} T={T} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}><span style={{ fontWeight: 800, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tok.name || tok.ca.slice(0, 6)}</span><span style={{ ...muted, fontFamily: M, whiteSpace: "nowrap" }}>{tok.ticker}</span>{(tok.chain === "robinhood" || tok.chain === "arc") && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".05em", color: BLUE, background: CHIP_TINT, padding: "1px 5px", borderRadius: 4, whiteSpace: "nowrap" }}>{tok.chain === "arc" ? "ARC" : "RH"}</span>}</div>
          <div style={{ ...muted, fontFamily: M, fontSize: 12, marginTop: 2 }}>{ago(now - tok.createdAt, t)} · {kfmt(tok.mcapUsd)} · {t("live.buyers", { n: tok.buyers })}{tok.smart > 0 ? t("live.smart", { n: tok.smart }) : ""}{tok.wave ? t("live.wave", { n: tok.copies, state: t(tok.wave.rising ? "live.wave.building" : tok.wave.fading ? "live.wave.fading" : "live.wave.steady") }) : tok.copies ? t("live.copies", { n: tok.copies }) : ""}{revival && tok.revival ? t("live.revival", { a: tok.revival.buyers5m, b: tok.revival.baseline5m }) : ""}{!revival && tok.slowCook ? t("live.slowCook", { n: tok.slowCook.buyers, m: tok.slowCook.windowMin, d: tok.slowCook.curveDelta }) : ""}{tok.why ? ` · ${tok.why.toLowerCase().replace(/_/g, " ")}` : ""}</div>
        </div>
        <Spark v={tok.spark} T={T} w={100} h={30} />
        <div style={{ textAlign: "right" }}><div style={{ fontFamily: M, fontWeight: 900, fontSize: 18, color: tok.score >= 60 ? T.gn : tok.score >= 40 ? T.tx : T.ft }}>{dim || !tok.score ? "" : tok.score}</div><div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: T[c], whiteSpace: "nowrap" }}>{label}</div></div>
      </a>; }
}

// How long the trend covers, said the way a person would say it.
const spanOf = (m, t = tEn) => (!m || m < 1) ? t("span.minute") : m < 60 ? `${m}${t("unit.m")}` : t("span.hm", { h: Math.floor(m / 60), m: m % 60 });
/** The launch's market cap over the session it has been watched. One series, so no legend: the label
 *  above names it. The line is recessive; only the current point wears the accent, ringed in the card's
 *  own surface so it reads on top of the line. Hovering moves the read-out to that point. */
function LaunchChart({ pts, T, h = 54 }) {
  const t = useT();
  const box = useRef(null);
  const [w, sW] = useState(340);
  const [hi, sHi] = useState(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const set = () => sW(Math.max(120, el.clientWidth));
    set();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(set) : null;
    ro?.observe(el); window.addEventListener("resize", set);
    return () => { ro?.disconnect(); window.removeEventListener("resize", set); };
  }, []);
  const n = pts?.length || 0;
  if (n < 2) return null;
  const pad = 5, mn = Math.min(...pts), mx = Math.max(...pts), rng = (mx - mn) || Math.max(1, mx * 0.02);
  const X = i => pad + (i / (n - 1)) * (w - pad * 2);
  const Y = v => h - pad - ((v - mn) / rng) * (h - pad * 2);
  const line = pts.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const up = pts[n - 1] >= pts[0], acc = up ? T.gn : T.rd;
  const at = hi == null ? n - 1 : hi;
  const read = e => { const b = box.current?.getBoundingClientRect(); if (!b) return; const x = (e.touches ? e.touches[0].clientX : e.clientX) - b.left; sHi(Math.max(0, Math.min(n - 1, Math.round(((x - pad) / Math.max(1, w - pad * 2)) * (n - 1))))); };
  return <div ref={box} onMouseMove={read} onMouseLeave={() => sHi(null)} onTouchStart={read} onTouchMove={read} onTouchEnd={() => sHi(null)}
    style={{ position: "relative", height: h, margin: "8px 0 4px", cursor: "crosshair", touchAction: "pan-y" }}>
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }} role="img" aria-label={t("chart.aria", { n })}>
      <polyline points={line} fill="none" stroke={T.dm} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {hi != null && <line x1={X(at)} y1="0" x2={X(at)} y2={h} stroke={T.bd} strokeWidth="1" />}
      <circle cx={X(at)} cy={Y(pts[at])} r="4" fill={acc} stroke={T.sf} strokeWidth="2" />
    </svg>
    {hi != null && <div style={{ position: "absolute", left: Math.max(0, Math.min(X(at) - 32, w - 64)), top: -2, fontFamily: M, fontSize: 11, fontWeight: 800, color: T.tx, background: T.bg, border: `1px solid ${T.bd}`, borderRadius: 6, padding: "2px 6px", pointerEvents: "none", whiteSpace: "nowrap" }}>{kfmt(pts[at])}</div>}
  </div>;
}

/** The first second: the mark draws itself inside a sweeping ring while the wallet is read, then the
 *  whole thing lifts away. Nothing waits on it — it is a cover over work already happening. */
function Boot({ T, done }) {
  const t = useT();
  const [gone, sGone] = useState(false);
  // The ring gets one full turn even when the data is instant: a splash that flickers reads as a bug.
  const [minUp, sMinUp] = useState(false);
  useEffect(() => { const t = setTimeout(() => sMinUp(true), 1150); return () => clearTimeout(t); }, []);
  const out = done && minUp;
  useEffect(() => { if (!out) return; const t = setTimeout(() => sGone(true), 700); return () => clearTimeout(t); }, [out]);
  // Fren is the loading screen: the painting full-bleed and softened behind, and his face inside the
  // ring. If /fren.png is not there yet the <img> errors, and the ring shows the logo it always did --
  // a missing file is never a broken splash.
  const [fren, sFren] = useState(true);
  if (gone) return null;
  return <div data-boot style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22, background: `radial-gradient(120% 90% at 50% 35%, ${T.sf} 0%, ${T.bg} 70%)`, animation: out ? "bootout .55s .1s cubic-bezier(.4,0,.2,1) forwards" : "none", pointerEvents: out ? "none" : "auto", overflow: "hidden" }}>
    {fren && <div aria-hidden="true" style={{ position: "absolute", inset: -24, background: `url(/fren.png) center 30%/cover no-repeat`, filter: "blur(18px) saturate(1.1)", opacity: .55 }} />}
    {fren && <div aria-hidden="true" style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, ${T.bg}66 0%, ${T.bg}cc 100%)` }} />}
    <div style={{ position: "relative", width: 132, height: 132, display: "grid", placeItems: "center" }}>
      <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: `conic-gradient(from 0deg, transparent 0deg, transparent 240deg, ${T.gn}00 250deg, ${T.gn} 340deg, ${T.gn}00 360deg)`, animation: "bootspin 1.15s linear infinite", mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))", WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))" }} />
      <div style={{ position: "absolute", inset: 14, borderRadius: "50%", border: `1px solid ${T.bd}` }} />
      {fren
        ? <img src="/fren.png" alt="" onError={() => sFren(false)} style={{ width: 100, height: 100, borderRadius: "50%", objectFit: "cover", objectPosition: "center 30%", animation: "bootrise .7s cubic-bezier(.2,.8,.2,1) both", boxShadow: `0 0 0 2px ${T.bg}, 0 0 28px ${T.gn}55` }} />
        : <img src="/bondli-logo.svg" alt="" style={{ width: 58, animation: "bootrise .7s cubic-bezier(.2,.8,.2,1) both", filter: `drop-shadow(0 0 18px ${T.gn}55)` }} />}
    </div>
    <div style={{ position: "relative", fontFamily: M, fontSize: 11, letterSpacing: ".08em", color: T.ft, animation: "bootword .8s .25s cubic-bezier(.2,.8,.2,1) both" }}>{t("boot.word")}</div>
    <div style={{ position: "relative", width: 150, height: 2, borderRadius: 2, background: T.bd, overflow: "hidden" }}>
      <div style={{ width: "33%", height: "100%", background: T.gn, animation: "bootbar 1.25s cubic-bezier(.5,0,.5,1) infinite" }} />
    </div>
  </div>;
}

/** Bondli's own token, front and centre: the name, the status, and when it is live the number, the
 *  curve, the address and the way in. State comes from the API every 15s, pushed by tools/launch-push.mjs. */
function Launch({ T }) {
  const t = useT();
  const [l, sL] = useState(null); const [copied, sCopied] = useState(false);
  useEffect(() => { let on = true; const poll = async () => { try { const r = await a.launch(); if (on) sL(r); } catch {} }; poll(); const id = setInterval(poll, 15000); return () => { on = false; clearInterval(id); }; }, []);
  // The token is the page, not a card on it. The banner only exists once the token is live -- as the way
  // in and the number -- never as a "soon" placeholder taking the top of the page.
  if (!l || l.status === "off" || l.status === "soon") return null;
  const live = l.status === "live" || l.status === "graduated", lv = l.live && !l.live.error ? l.live : null, tr = l.trend || null;
  const copy = async () => { try { await navigator.clipboard.writeText(l.address); sCopied(true); setTimeout(() => sCopied(false), 1500); } catch {} };
  const pill = { display: "inline-block", padding: "4px 10px", borderRadius: 999, fontFamily: M, fontSize: 11, fontWeight: 800, letterSpacing: ".08em", whiteSpace: "nowrap" };
  // The corner badge is the state of the launch and, once there is something to buy, the way in.
  const sol = l.chain === "solana";
  const where = sol ? (l.status === "graduated" ? "RAYDIUM" : "PUMP.FUN") : l.venue === "uniswap-v2" ? "UNISWAP" : "PONS";
  const chainName = sol ? "SOLANA" : "ROBINHOOD CHAIN";
  const buyUrl = live ? (l.buy || l.url || "") : "";
  const badge = l.status === "graduated" ? t("launch.graduated", { where }) : live ? t("launch.live", { where }) : t("launch.soon", { chain: chainName });
  const post = l.links?.post || "";
  // The name, as the server states it, split at the first space so a two-word name stacks the way
  // the old one did and a one-word name stands alone. Nothing about the token is hard-coded here.
  const [first, ...rest] = String(l.name || "").toUpperCase().split(" ");
  return <div style={{ width: "100%", maxWidth: 440, marginBottom: 18, position: "relative", overflow: "hidden", borderRadius: 18, border: `1px solid ${live ? T.gn : T.bd}`, background: `radial-gradient(120% 90% at 85% 20%, ${T.gn}2a 0%, ${T.sf} 55%)`, padding: "18px 18px 16px", boxSizing: "border-box" }}>
    {l.image && <img src={l.image} alt={l.name || ""} style={{ position: "absolute", right: -18, top: -6, width: 190, height: "auto", animation: "fly 5s ease-in-out infinite", filter: `drop-shadow(0 0 22px ${T.gn}88)`, pointerEvents: "none" }} />}
    <div style={{ position: "relative", zIndex: 1, maxWidth: 240 }}>
      {buyUrl
        ? <a href={buyUrl} target="_blank" rel="noopener" style={{ ...pill, display: "inline-flex", alignItems: "center", gap: 6, background: T.gn, color: "#000", border: `1px solid ${T.gn}`, textDecoration: "none", animation: "gp 1.8s infinite" }}>{badge}<span aria-hidden="true">&#8594;</span></a>
        : <span style={{ ...pill, background: live ? T.gn : T.bg, color: live ? "#000" : T.dm, border: `1px solid ${live ? T.gn : T.bd}` }}>{badge}</span>}
      <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: "-.03em", lineHeight: 1, marginTop: 12 }}>{first}{rest.length > 0 && <><br />{rest.join(" ")}</>}</div>
      {l.ticker && <div style={{ fontFamily: M, fontWeight: 800, color: T.gn, marginTop: 6 }}>${l.ticker.replace(/^\$/, "")}</div>}
      <div style={{ color: T.ft, fontSize: 13, lineHeight: 1.45, marginTop: 8 }}>{l.tagline}</div>
      {post && <a href={post} target="_blank" rel="noopener" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 13, fontWeight: 800, color: T.tx, textDecoration: "none", borderBottom: `1px solid ${T.bd}` }}><XIcon /> {t("launch.post")}</a>}
    </div>
    {live && <div style={{ position: "relative", zIndex: 1, marginTop: 14 }}>
      {lv && <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontFamily: M, fontSize: 11, color: T.ft }}>
          <span style={{ letterSpacing: ".07em" }}>{t("launch.mcap")}</span>
          {tr?.changePct != null && <span style={{ color: tr.changePct >= 0 ? T.gn : T.rd, fontWeight: 800 }}>{tr.changePct >= 0 ? "+" : "-"}{Math.abs(tr.changePct).toFixed(1)}%<span style={{ color: T.ft, fontWeight: 400 }}>{t("launch.last", { span: spanOf(tr.spanMin, t) })}</span></span>}
        </div>
        <div style={{ fontFamily: M, fontWeight: 900, fontSize: 28, lineHeight: 1.1, color: T.tx, marginTop: 1 }}>{kfmt(lv.mcapUsd || 0)}</div>
        {tr?.spark?.length >= 2 && <LaunchChart pts={tr.spark} T={T} />}
      </div>}
      {lv && <div style={{ display: "flex", gap: 14, fontFamily: M, fontSize: 13, alignItems: "baseline", flexWrap: "wrap" }}>
        {lv.buys != null && <span><span style={{ color: T.ft, fontSize: 11 }}>{t("launch.buys")}</span><b>{lv.buys}</b></span>}
        {lv.buyers != null && lv.buyers > 0 && <span><span style={{ color: T.ft, fontSize: 11 }}>{t("launch.holders")}</span><b>{lv.buyers}</b></span>}
        {lv.liquidityUsd != null && <span><span style={{ color: T.ft, fontSize: 11 }}>{t("launch.liquidity")}</span><b>{kfmt(lv.liquidityUsd)}</b></span>}
        {lv.lpBurnedPct != null && <span><span style={{ color: T.ft, fontSize: 11 }}>{t("launch.lpBurned")}</span><b style={{ color: T.gn }}>{lv.lpBurnedPct}%</b></span>}
      </div>}
      {lv && lv.curvePct != null && <div style={{ marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: M, fontSize: 11, color: T.ft }}><span>{lv.graduated ? t("launch.curveDone") : t("launch.curve")}</span><span>{Math.round(lv.curvePct * 100)}%</span></div>
        <div style={{ height: 6, background: T.bg, borderRadius: 3, marginTop: 4, overflow: "hidden" }}><div style={{ width: `${Math.max(2, Math.round(lv.curvePct * 100))}%`, height: "100%", background: T.gn, transition: "width .6s" }} /></div>
      </div>}
      {l.address && <div onClick={copy} title={t("copy.title")} style={{ fontFamily: M, fontSize: 11, color: T.dm, marginTop: 10, wordBreak: "break-all", cursor: "pointer", padding: "7px 9px", background: T.bg + "cc", borderRadius: 8, border: `1px solid ${T.bd}` }}>{l.address}{copied ? t("copy.done") : ""}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {l.url && <a href={l.url} target="_blank" rel="noopener" style={{ flex: 1, textAlign: "center", padding: "11px 12px", borderRadius: 10, background: T.gn, color: "#000", fontWeight: 900, textDecoration: "none", fontSize: 14 }}>{l.venue === "uniswap-v2" ? t("launch.buyUniswap") : t("launch.buyPons")}</a>}
        {l.chart && l.venue === "uniswap-v2" && <a href={l.chart} target="_blank" rel="noopener" style={{ padding: "11px 14px", borderRadius: 10, border: `1px solid ${T.bd}`, color: T.tx, fontWeight: 800, textDecoration: "none", fontSize: 14 }}>{t("launch.chart")}</a>}
        {l.links?.x && <a href={l.links.x} target="_blank" rel="noopener" style={{ padding: "11px 14px", borderRadius: 10, border: `1px solid ${T.bd}`, color: T.tx, fontWeight: 800, textDecoration: "none", fontSize: 14 }}>X</a>}
        {l.links?.telegram && <a href={l.links.telegram} target="_blank" rel="noopener" style={{ padding: "11px 14px", borderRadius: 10, border: `1px solid ${T.bd}`, color: T.tx, fontWeight: 800, textDecoration: "none", fontSize: 14 }}>Telegram</a>}
      </div>
    </div>}
    {l.updates?.length > 0 && <div style={{ position: "relative", zIndex: 1, marginTop: 12, fontFamily: M, fontSize: 11, color: T.ft, lineHeight: 1.6, borderTop: `1px solid ${T.bd}`, paddingTop: 8 }}>
      {l.updates.slice(0, 3).map((u, i) => <div key={i}><span style={{ color: T.dm }}>{new Date(u.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> {u.text}</div>)}
    </div>}
    <div style={{ position: "relative", zIndex: 1, marginTop: 10, fontSize: 11, color: T.dm }}>{l.venue === "uniswap-v2" ? t("launch.erc20") : t("launch.fair")}</div>
  </div>;
}

export default function Simple() {
  const t = useT();
  const [lang, setLang] = useLang();
  const [dark] = useState(() => { try { return localStorage.getItem("bondli_theme") !== "light"; } catch { return true; } });
  const T = dark ? D : L;
  const [pk, sPk] = useState(null);
  const [tw, sTw] = useState(null);        // { pubkey, solBalance }
  const [st, sSt] = useState(null);        // velocity status
  const [busy, sBusy] = useState(null);    // what is in flight, for the button label
  const [msg, sMsg] = useState(null);
  const [agg, sAgg] = useState(() => { try { const v = localStorage.getItem("bondli_agg"); return v == null ? 2 : Math.max(0, Math.min(3, Number(v) || 0)); } catch { return 2; } });
  const [size, sSize] = useState(() => { try { const v = Number(localStorage.getItem("bondli_size")); return SIZES.includes(v) ? v : SIZES[0]; } catch { return SIZES[0]; } });
  const [showKey, sShowKey] = useState(null);
  const [openPos, sOpenPos] = useState(null);
  const [chains, sChains] = useState(() => { try { return { pumpfun: true, ...(JSON.parse(localStorage.getItem("bondli_chains") || "null") || {}) }; } catch { return { pumpfun: true, pons: true }; } });
  // Paper: the whole bot on the live feed with simulated money. Remembered per device, and never
  // assumed -- a returning user who paper-traded last time is shown that they are still in paper
  // rather than quietly going live, and vice versa.
  const [paper, sPaper] = useState(() => { try { return localStorage.getItem("bondli_paper") === "1"; } catch { return false; } });
  // Public calls: off unless they say so. A call links the buy transaction, and the transaction names this bot's wallet.
  const [calls, sCalls] = useState(() => { try { return localStorage.getItem("bondli_callouts") === "1"; } catch { return false; } });
  const [copied, sCopied] = useState(false);
  const narRef = useRef(null);
  const running = !!st?.running;
  const s = st?.status; const day = s?.day; const tp = s?.pnl || null; const pnl = tp?.since_start_usd ?? (tp?.realized_today_usd ?? day?.realizedUsd ?? 0) + (tp?.unrealized_usd || 0); const pnlKind = tp?.kind === "paper" ? "paper" : tp?.since_start_usd != null ? "wallet" : "trades";
  // Whether this wallet's fee is waived, as the server last read it. null = not known (not running, or
  // never read); the footer then states the offer rather than the fact.
  const waived = st?.fee?.waiver?.holds ?? null;
  // A message clears itself (errors get longer) and on a tap.
  const say = (m, kind = "info") => { sMsg({ m, kind }); setTimeout(() => sMsg(x => (x?.m === m ? null : x)), kind === "error" ? 15000 : 6000); };

  const [booted, sBooted] = useState(false);
  useEffect(() => { const p = phantom(); const settle = () => sBooted(true); if (p?.isConnected && p.publicKey) { sPk(p.publicKey.toString()); settle(); } else if (p?.connect) p.connect({ onlyIfTrusted: true }).then(r => { sPk(r.publicKey.toString()); }).catch(() => {}).finally(settle); else settle(); }, []);
  useEffect(() => { const t = setTimeout(() => sBooted(true), 2500); return () => clearTimeout(t); }, []); // never hold the page on a wallet that never answers
  useEffect(() => { a.sw(pk); }, [pk]);

  const loadWallet = useCallback(async () => {
    if (!pk) return;
    try { const r = await a.gtw(pk); sBooted(true); sTw(r?.tradingWallet ? { pubkey: r.tradingWallet, solBalance: Number(r.solBalance ?? r.sol ?? 0), tokenValueSol: Number(r.tokenValueSol || 0), evmAddress: r.evmAddress || null, ethBalance: r.ethBalance == null ? null : Number(r.ethBalance) } : null); } catch { sBooted(true); /* keep the last reading */ }
  }, [pk]);
  useEffect(() => { loadWallet(); const id = setInterval(loadWallet, running ? 15000 : 8000); return () => clearInterval(id); }, [loadWallet, running]);
  useEffect(() => {
    if (!pk || !tw) return; let on = true;
    const poll = async () => { try { const r = await a.vstat(pk); if (on) sSt(r); } catch (e) { if (on && !/Sign in/.test(e.message)) sSt(x => x); } };
    poll(); const id = setInterval(poll, running ? 3000 : 12000); return () => { on = false; clearInterval(id); };
  }, [pk, tw?.pubkey, running]);
  useEffect(() => { if (narRef.current) narRef.current.scrollTop = narRef.current.scrollHeight; }, [st?.narration?.length]);

  const connect = async () => {
    const p = phantom();
    if (!p) { if (/iPhone|iPad|Android/i.test(navigator.userAgent)) { window.location.href = "https://phantom.app/ul/browse/" + encodeURIComponent(window.location.href); return; } say(t("toast.installPhantom"), "error"); return; }
    try { const r = await p.connect(); sPk(r.publicKey.toString()); } catch (e) { say(e.code === 4001 ? t("toast.cancelled") : t("toast.noConnect"), "error"); }
  };
  const createWallet = async () => { sBusy("wallet"); try { await a.ctw(pk); await loadWallet(); } catch (e) { say(e.message, "error"); } finally { sBusy(null); } };
  const start = async () => {
    sBusy("start");
    try {
      try { localStorage.setItem("bondli_agg", String(agg)); localStorage.setItem("bondli_size", String(size)); } catch {}
      try { localStorage.setItem("bondli_chains", JSON.stringify(chains)); } catch {}
      // Only the chains that are on count toward the bankroll: someone trading Robinhood Chain alone
      // must not be sized against SOL they never funded, or against SOL they are keeping out of it.
      try { localStorage.setItem("bondli_paper", paper ? "1" : "0"); } catch {}
      try { localStorage.setItem("bondli_callouts", calls ? "1" : "0"); } catch {}
      const usePump = chainsOn.pumpfun, usePons = chainsOn.pons, useArc = chainsOn.arc;
      // Paper has no wallet to size against, so it gets a stated bankroll: enough to run the same
      // four positions at the chosen stake, which is what makes the result comparable to going live.
      const bank = paper ? Math.max(100, size * 20)
        : (usePump ? (tw?.solBalance || 0) * 200 : 0) + (usePons ? (tw?.ethBalance || 0) * 3000 : 0) + (useArc ? (tw?.usdcBalance || 0) : 0);
      const r = await a.vst(pk, { aggression: agg, perTradeMaxUsd: size, maxPositions: 4, dailyLossUsd: Math.max(15, size * 3), bankrollUsd: Math.max(20, Math.round(bank)), pumpfun: usePump, pons: usePons, arc: useArc, paper, callouts: calls });
      if (!r.ok) say(r.error || t("toast.noStart"), "error"); else sSt(r);
    } catch (e) { say(e.message, "error"); } finally { sBusy(null); }
  };
  const stop = async () => { if (!confirm(t("toast.stopConfirm"))) return; sBusy("stop"); try { const r = await a.vsp(pk); sSt({ running: false }); if (r.failed?.length) say(t("toast.stopRetry", { n: r.failed.length }), "error"); } catch (e) { say(e.message, "error"); } finally { sBusy(null); } };
  const paused = !!s?.halt?.mode;
  const pause = async () => { sBusy("pause"); try { const r = await a.vpause(pk); if (r.ok) sSt(x => ({ ...x, ...r })); else say(r.error, "error"); } catch (e) { say(e.message, "error"); } finally { sBusy(null); } };
  const resume = async () => { sBusy("pause"); try { const r = await a.vresume(pk); if (r.ok) sSt(x => ({ ...x, ...r })); else say(r.error, "error"); } catch (e) { say(e.message, "error"); } finally { sBusy(null); } };
  const sellPos = async (p, pct) => { sBusy("sell:" + p.id); try { const r = await a.vclose(pk, p.id, pct); if (r.ok) { say(t("toast.sold", { pct, name: p.name || p.ticker || p.instrument.slice(0, 6) }) + (r.proceeds_usd != null ? t("toast.soldFor", { usd: fmt(r.proceeds_usd) }) : ""), "ok"); sSt(x => ({ ...x, ...r })); } else say(r.error || t("toast.sellFailed"), "error"); } catch (e) { say(e.message, "error"); } finally { sBusy(null); } };
  const [sweep, sSweep] = useState(null);
  // The sweep runs on the server, one token at a time; the page follows it until it is done.
  const sweepAll = async () => {
    if (!confirm(t("toast.sweepConfirm"))) return;
    sBusy("sweep");
    try { const r = await a.vsweep(pk, "all"); sSweep(r.sweep || null); if (!r.sweep) say(r.error || t("toast.noStart"), "error"); }
    catch (e) { say(e.message, "error"); sBusy(null); }
  };
  useEffect(() => {
    if (!pk || !sweep || sweep.done) { if (sweep?.done) sBusy(b => (b === "sweep" ? null : b)); return; }
    let on = true;
    const poll = async () => { try { const r = await a.vsweepStatus(pk); if (on && r.sweep) { sSweep(r.sweep); if (r.sweep.done) { say(t("toast.sweepDone", { sold: r.sweep.sold, failed: r.sweep.failed }), r.sweep.failed ? "error" : "ok"); loadWallet(); } } } catch {} };
    const id = setInterval(poll, 2500); poll();
    return () => { on = false; clearInterval(id); };
  }, [pk, sweep?.done, sweep?.startedAt]);
  useEffect(() => { if (st?.sweep && !st.sweep.done && !sweep) sSweep(st.sweep); }, [st?.sweep?.startedAt]);
  // Every token in both wallets, with what a sell would fetch, whether or not the bot is running.
  const [hold, sHold] = useState(null); const [holdOpen, sHoldOpen] = useState(false);
  const loadHold = useCallback(async () => { if (!pk || !tw) return; try { const r = await a.vholdings(pk); if (r.holdings) sHold(r.holdings); } catch {} }, [pk, tw?.pubkey]);
  useEffect(() => { if (!holdOpen) return; loadHold(); const id = setInterval(loadHold, 25000); return () => clearInterval(id); }, [holdOpen, loadHold, sweep?.done]);
  // Tokens in the wallet the bot did not buy: shown once, hidden on a tap, remembered on this device.
  const [hidden, sHidden] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem("bondli_hide_holdings") || "[]")); } catch { return new Set(); } });
  const persistHidden = (set) => { sHidden(new Set(set)); try { localStorage.setItem("bondli_hide_holdings", JSON.stringify([...set])); } catch {} };
  const hideOne = (k) => { const n = new Set(hidden); n.add(k); persistHidden(n); };
  const hideAll = (rows) => { const n = new Set(hidden); for (const r of rows) n.add(r.venue + r.instrument); persistHidden(n); };
  // Dismiss a stale banner, and give up on a position the venue will not let us sell. Giving up
  // books no profit or loss -- nothing was realized -- so the tokens simply reappear in the
  // "also in the wallets" list, where the Sell button already works.
  const refreshStatus = async () => { try { const r = await a.vstat(pk); sSt(r); } catch {} };
  const clearErr = async (p) => { try { await a.vclearErr(pk, p.id); await refreshStatus(); } catch (e) { say(e.message, "error"); } };
  // The daily loss limit stopped the bot. Clearing it re-arms the limit rather than removing it: the
  // loss booked so far stops counting against today, so the next stop is a fresh limit away.
  const ackDaily = async () => {
    if (!confirm(t("toast.dailyConfirm"))) return;
    try { const r = await a.vackDaily(pk); say(r.ok ? (r.halted ? t("toast.dailyStillPaused", { reason: r.haltReason }) : t("toast.dailyCleared")) : r.error, r.ok && !r.halted ? "ok" : "error"); await refreshStatus(); }
    catch (e) { say(e.message, "error"); }
  };
  const releasePos = async (p) => {
    if (!confirm(t("toast.releaseConfirm", { id: p.instrument.slice(0, 10) }))) return;
    try { const r = await a.vrelease(pk, p.id); say(r.ok ? t("toast.released", { id: p.instrument.slice(0, 8), qty: Math.round(r.qty || 0).toLocaleString() }) : r.error, r.ok ? "ok" : "error"); await refreshStatus(); loadWallet(); }
    catch (e) { say(e.message, "error"); }
  };
  const [selling, sSelling] = useState(null);
  const sellHolding = async (venue, instrument) => {
    sSelling(venue + instrument);
    try { const r = await a.vsell(pk, venue, instrument, 100); say(r.ok ? t("toast.soldHolding", { id: instrument.slice(0, 8), amt: Number(r.received || 0).toFixed(venue === "pons" ? 5 : venue === "arc" ? 2 : 4), unit: venue === "pons" ? "ETH" : venue === "arc" ? "USDC" : "SOL" }) : `${instrument.slice(0, 8)}…: ${r.error}`, r.ok ? "ok" : "error"); loadWallet(); sHold(h => h ? { ...h, sol: h.sol.map(x => x.instrument === instrument ? { ...x, result: r } : x), eth: h.eth.map(x => x.instrument === instrument ? { ...x, result: r } : x), usdc: (h.usdc || []).map(x => x.instrument === instrument ? { ...x, result: r } : x) } : h); }
    catch (e) { say(e.message, "error"); } finally { sSelling(null); }
  };
  const withdraw = async () => {
    if (running) { say(t("toast.stopFirst"), "error"); return; }
    if (!confirm(t("toast.withdrawConfirm", { pk: pk.slice(0, 6) }))) return;
    sBusy("withdraw"); try { const r = await a.wdr(pk, pk, "all"); say(t("toast.sentSol", { n: r.sol.toFixed(4) }), "ok"); await loadWallet(); } catch (e) { say(e.message, "error"); } finally { sBusy(null); }
  };
  const withdrawUsdc = async () => {
    if (running) { say(t("toast.stopFirst"), "error"); return; }
    const to = prompt(t("toast.usdcTo")); if (!to) return;
    sBusy("withdraw"); try { const r = await a.wdrUsdc(pk, to.trim()); say(t("toast.sentUsdc", { n: r.usdc.toFixed(2) }), "ok"); await loadWallet(); } catch (e) { say(e.message, "error"); } finally { sBusy(null); }
  };
  const withdrawEth = async () => {
    if (running) { say(t("toast.stopFirst"), "error"); return; }
    const to = prompt(t("toast.ethTo")); if (!to) return;
    sBusy("withdraw"); try { const r = await a.wdrEth(pk, to.trim()); say(t("toast.sentEth", { n: r.eth.toFixed(5) }), "ok"); await loadWallet(); } catch (e) { say(e.message, "error"); } finally { sBusy(null); }
  };
  const exportKey = async () => {
    sBusy("key"); sMsg(null);
    try { const r = await a.etw(pk); if (!r?.privateKey) throw new Error(t("toast.noKey", { raw: JSON.stringify(r).slice(0, 80) })); sShowKey({ sol: r.privateKey, evm: r.evmPrivateKey || null }); }
    catch (e) { console.error("export key", e); say(t("toast.exportFailed", { err: e.message || String(e) }), "error"); }
    finally { sBusy(null); }
  };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); sCopied(true); setTimeout(() => sCopied(false), 1500); } catch {} };

  // 1.75 SOL (~$350) is the first bankroll the arithmetic actually works at: the smallest stake that
  // can outrun its own costs is $25, the day's loss budget has to cover more than one of those, and
  // 15% of $350 is $52. Below this the bot either refuses every trade or gets one shot a day.
  const MIN_BANKROLL_SOL = 0.5;   // the hard floor: below this the fees are most of the trade
  const GOOD_BANKROLL_SOL = 2;    // what it actually wants: room for several $25 bets and a day's loss limit
  // Robinhood Chain has its own floor, in its own asset. One $10 stake needs about 0.0039 ETH plus
  // the gas reserve; 0.01 leaves room for a few of them. It is a smaller number than the SOL floor
  // because ETH is dearer and Robinhood Chain gas is cents, not a rent-bearing token account.
  const MIN_BANKROLL_ETH = 0.01;
  // Arc is quoted in dollars: one minimum stake plus gas, with room for a few. Gas on Arc is cents.
  const MIN_BANKROLL_USDC = 12;
  const RELEASE_AFTER = 5; // engine cfg.releaseAfterFailures: keep the two in step
  const fundedSol = (tw?.solBalance || 0) >= MIN_BANKROLL_SOL;
  const fundedEth = (tw?.ethBalance || 0) >= MIN_BANKROLL_ETH;
  const fundedUsdc = (tw?.usdcBalance || 0) >= MIN_BANKROLL_USDC;
  // Paper money needs no funding: nothing can be spent, so nothing has to be there. Every other rule
  // -- the gates, the sizes, the plans, the exits, the live feed -- is the same one live trading uses.
  const canTrade = { pumpfun: fundedSol || paper, pons: (fundedEth || paper) && !!tw?.evmAddress, arc: (fundedUsdc || paper) && !!tw?.evmAddress };
  // Which chains are actually on: what the user asked for, AND what the wallet can pay for. One
  // definition, read by the Start call and by the chips, so the panel can never show pump.fun off
  // and then start it anyway.
  const chainsOn = {
    pumpfun: chains.pumpfun !== false && canTrade.pumpfun,
    pons: !!chains.pons && canTrade.pons,
    arc: !!chains.arc && canTrade.arc,
  };
  // Funded means funded on a chain the bot can actually trade -- EITHER chain. This read SOL alone,
  // so a wallet holding 0.024 ETH and no SOL was shown "send SOL to begin" and never rendered the
  // Start button at all: the engine had supported Robinhood Chain on its own for days, and the panel
  // would not let anyone ask for it.
  const funded = fundedSol || fundedEth || fundedUsdc || paper;
  // What the RUNNING bot is doing, as the server reports it -- not what the switch happens to say
  // now. Flipping the toggle mid-run must not relabel a run that is spending real money.
  const onPaper = running ? !!st?.settings?.paper : paper;
  const wrap = { minHeight: "100vh", position: "relative", color: T.tx, fontFamily: S, display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 16px 32px", boxSizing: "border-box" };
  const card = { width: "100%", maxWidth: 440, border: `1px solid ${running ? T.gn : T.bd}`, borderRadius: 16, padding: 20, boxSizing: "border-box" };
  const muted = { color: T.ft, fontSize: 13, lineHeight: 1.5 };

  return <TC.Provider value={T}><style>{css(T)}</style><Boot T={T} done={booted} /><div style={wrap}>
    {/* The language, in the corner of the header: two chips, the chosen one lit the way the tabs are. */}
    <div role="group" aria-label={t("lang.switch")} style={{ position: "absolute", top: 14, right: 16, display: "flex", gap: 4 }}>
      {LANGS.map(l => <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} style={{ padding: "5px 9px", borderRadius: 8, border: `1px solid ${lang === l ? T.gn : T.bd}`, background: lang === l ? T.gn + "1c" : "transparent", color: lang === l ? T.gn : T.dm, fontFamily: S, fontWeight: 800, fontSize: 12, cursor: "pointer" }}>{t(`lang.${l}`)}</button>)}
    </div>
    <div style={{ textAlign: "center", marginBottom: 28 }}>
      <img src="/bondli-logo.svg" alt="Bondli" style={{ height: 72, marginBottom: 14 }} />
      <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: "-.02em", lineHeight: 1.1 }}>{t("hero.title")}</div>
      <div style={{ ...muted, fontSize: 16, marginTop: 10 }}>{t("hero.sub")}</div>
    </div>

    <Heartbeat T={T} />

    <Launch T={T} />

    <div className="card" style={card}>
      {/* 1. Connect */}
      {!pk && <Btn big T={T} onClick={connect}>{t("panel.connect")}</Btn>}

      {/* 2. Trading wallet: create, then fund */}
      {pk && !tw && <>
        <div style={{ ...muted, marginBottom: 12 }}>{t("panel.needsWallet")}</div>
        <Btn big T={T} onClick={createWallet} disabled={busy === "wallet"}>{busy === "wallet" ? t("panel.creating") : t("panel.create")}</Btn>
      </>}
      {pk && tw && !running && <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={muted}>{t("panel.walletSol")}</span>
          <span style={{ fontFamily: M, fontWeight: 800, fontSize: 22 }}>{tw.solBalance.toFixed(3)} SOL</span>
        </div>
        <div onClick={() => copy(tw.pubkey)} title={t("copy.title")} style={{ fontFamily: M, fontSize: 12, color: T.dm, marginTop: 6, wordBreak: "break-all", cursor: "pointer", padding: "8px 10px", background: T.bg, borderRadius: 8, border: `1px solid ${T.bd}` }}>{tw.pubkey}{copied ? t("copy.done") : ""}</div>
        {/* Paper first: the cheapest way to find out whether this is worth funding. */}
        <div onClick={() => sPaper(v => !v)} style={{ marginTop: 14, padding: "10px 12px", borderRadius: 10, border: `1px solid ${paper ? T.yl : T.bd}`, background: paper ? T.yl + "14" : "transparent", cursor: "pointer", display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span style={{ width: 34, height: 20, borderRadius: 10, background: paper ? T.yl : T.bd, flexShrink: 0, position: "relative", marginTop: 1 }}>
            <span style={{ position: "absolute", top: 2, left: paper ? 16 : 2, width: 16, height: 16, borderRadius: "50%", background: paper ? "#000" : T.ft, transition: "left .15s" }} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 800, fontSize: 14, color: paper ? T.yl : T.tx }}>{t("panel.paper")}{paper ? t("panel.on") : ""}</span>
            <span style={{ display: "block", ...muted, fontSize: 12, marginTop: 2 }}>{t("panel.paperDesc")}</span>
          </span>
        </div>
        <div onClick={() => sCalls(v => !v)} style={{ marginTop: 8, padding: "10px 12px", borderRadius: 10, border: `1px solid ${calls ? T.gn : T.bd}`, background: calls ? T.gn + "14" : "transparent", display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
          <span style={{ width: 34, height: 20, borderRadius: 10, background: calls ? T.gn : T.bd, flexShrink: 0, position: "relative", marginTop: 1 }}>
            <span style={{ position: "absolute", top: 2, left: calls ? 16 : 2, width: 16, height: 16, borderRadius: "50%", background: calls ? "#000" : T.ft, transition: "left .15s" }} />
          </span>
          <span style={{ minWidth: 0 }}>
            <span style={{ fontWeight: 800, fontSize: 14, color: calls ? T.gn : T.tx }}>{t("panel.publicCalls")}{calls ? t("panel.on") : ""}</span>
            <div style={{ ...muted, marginTop: 2 }}>{t("panel.publicCallsDesc")}</div>
          </span>
        </div>
        {!funded && <div style={{ ...muted, marginTop: 8 }}>{t("panel.fund", { sol: MIN_BANKROLL_SOL, eth: MIN_BANKROLL_ETH, usdc: MIN_BANKROLL_USDC, drag: dragPct(SIZES[0], st?.status?.solPrice || 0).toFixed(0), good: GOOD_BANKROLL_SOL })}{t("panel.have", { sol: tw?.solBalance || 0, eth: tw?.ethBalance || 0 })}</div>}
        {fundedSol && (tw?.solBalance || 0) < GOOD_BANKROLL_SOL && <div style={{ ...muted, marginTop: 8, color: T.yl }}>{t("panel.tight", { sol: (tw.solBalance).toFixed(2), good: GOOD_BANKROLL_SOL })}</div>}
        {!fundedSol && fundedEth && <div style={{ ...muted, marginTop: 8, color: T.yl }}>{t("panel.ethOnly", { sol: MIN_BANKROLL_SOL })}</div>}
        {tw.evmAddress && <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 14 }}>
            <span style={muted}>{t("panel.walletEvm")}</span>
            <span style={{ fontFamily: M, fontWeight: 800, fontSize: 22 }}>{tw.ethBalance == null ? "…" : tw.ethBalance.toFixed(4)} ETH<span style={{ ...muted, fontSize: 14, marginLeft: 8 }}>{tw.usdcBalance == null ? "…" : tw.usdcBalance.toFixed(2)} USDC</span></span>
          </div>
          <div onClick={() => copy(tw.evmAddress)} title={t("copy.title")} style={{ fontFamily: M, fontSize: 12, color: T.dm, marginTop: 6, wordBreak: "break-all", cursor: "pointer", padding: "8px 10px", background: T.bg, borderRadius: 8, border: `1px solid ${T.bd}` }}>{tw.evmAddress}{copied ? t("copy.done") : ""}</div>
          {!(tw.ethBalance > 0.003) && <div style={{ ...muted, marginTop: 8 }}>{t("panel.ethOptional")}</div>}
        </>}

        {/* 3. Two choices, then start */}
        {funded && <>
          <div style={{ marginTop: 18, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><span style={muted}>{t("panel.risk")}</span><span style={{ fontWeight: 800, color: RISK_C(agg, T) }}>{aggL(t, agg)}</span></div>
          <Dial value={agg} onChange={sAgg} T={T} />
          <div style={{ ...muted, marginTop: 8 }}>{t(`agg.${AGG[agg]?.k || "normal"}.d`)}</div>
          <div style={{ marginTop: 14, ...muted, marginBottom: 6 }}>{t("panel.perTrade")}</div>
          <div style={{ display: "flex", gap: 6 }}>{SIZES.map(v => <button key={v} onClick={() => sSize(v)} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: `1px solid ${size === v ? T.gn : T.bd}`, background: size === v ? T.gn + "22" : "transparent", color: size === v ? T.gn : T.dm, fontFamily: M, fontWeight: 800, cursor: "pointer" }}>${v}</button>)}</div>
          <div style={{ ...muted, marginTop: 10 }}>{t("panel.limits", { loss: Math.max(15, size * 3) })}</div>
          <div style={{ ...muted, marginTop: 6, fontFamily: M, fontSize: 11 }}>{t("panel.drag", { size, drag: dragPct(size, st?.status?.solPrice || 0).toFixed(1) })}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
            {(() => {
              // Either chain can be switched off, so long as one stays on. pump.fun used to be a
              // permanent label -- not clickable, always green -- which meant nobody could trade
              // Robinhood Chain on its own however they had funded the wallets.
              // The same floors the funding copy quotes, not a second set of ad-hoc numbers.
              const canFund = canTrade;
              const on = chainsOn;
              const isLast = (k) => on[k] && !Object.keys(on).some(x => x !== k && on[x]); // the only one on
              const toggle = (k) => {
                if (!canFund[k]) return;       // nothing to trade with
                if (isLast(k)) return;         // never every chain off
                sChains(c => ({ ...c, [k]: !on[k] }));
              };
              const fundWith = { pumpfun: `${MIN_BANKROLL_SOL} SOL`, pons: `${MIN_BANKROLL_ETH} ETH`, arc: `${MIN_BANKROLL_USDC} USDC` };
              return [["pumpfun", "pump.fun", "Solana"], ["pons", "PONS", "Robinhood Chain"], ["arc", "Argus", "Arc · USDC"]].map(([k, l, sub]) => {
                const isOn = on[k], last = isLast(k);
                const can = canFund[k];
                const note = !can ? ((k !== "pumpfun" && !tw?.evmAddress) ? t("panel.noEvm") : t("panel.fundWith", { amt: fundWith[k] }))
                  : last ? t("panel.onlyOne")
                  : isOn ? t("panel.chainOn") : t("panel.chainOff");
                return <div key={k} onClick={() => toggle(k)} title={last ? t("panel.keepOne") : ""}
                  style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: `1px solid ${isOn ? T.gn : T.bd}`, background: isOn ? T.gn + "14" : "transparent", cursor: can && !last ? "pointer" : "default", opacity: can ? 1 : .5 }}>
              <div style={{ fontWeight: 800, fontSize: 13, color: isOn ? T.gn : T.dm }}>{l}</div><div style={{ ...muted, fontSize: 11 }}>{sub}{note}</div>
                </div>;
              });
            })()}
          </div>
          <div style={{ marginTop: 16 }}><Btn big T={T} onClick={start} disabled={busy === "start"}>{busy === "start" ? t("panel.starting") : paper ? t("panel.startPaper") : t("panel.start")}</Btn></div>
        </>}
      </>}

      {/* 4. Running: the number, the holdings, the bot's own words, the stop */}
      {running && <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: onPaper ? T.yl : T.gn, animation: "gp 2s infinite" }} /><span style={{ fontWeight: 800 }}>{onPaper ? t("run.paper") : t("run.live")}</span>{onPaper && <span style={{ fontFamily: M, fontSize: 10, fontWeight: 900, letterSpacing: ".08em", color: "#000", background: T.yl, borderRadius: 5, padding: "2px 6px" }}>{t("run.pretend")}</span>}</span>
          <span style={{ fontFamily: M, fontWeight: 900, fontSize: 30, color: pnl >= 0 ? T.gn : T.rd }}>{pnl >= 0 ? "+" : ""}{fmt(pnl)}</span>
        </div>
        <div style={{ ...muted, display: "flex", justifyContent: "space-between", marginTop: 2 }}><span title={pnlKind === "wallet" ? t("run.title.wallet") : pnlKind === "paper" ? t("run.title.paper") : t("run.title.trades")}>{(() => {
          // The words count the same trades the number does. "since start" reads the ledger since
          // Start (both paper and wallet modes); only the trades-only fallback is a today's number.
          const ss = tp?.since_start;
          const n = ss ? ss.trades : (tp?.trades_today ?? day?.trades ?? 0);
          const closed = ss ? ss.closed_usd : (tp?.realized_today_usd ?? day?.realizedUsd ?? 0);
          const label = pnlKind === "paper" ? t("run.since.paper") : pnlKind === "wallet" ? t("run.since.wallet") : t("run.since.today");
          return t("run.trades", { label, n }) + (tp ? t("run.closedOpen", { closed: `${closed >= 0 ? "+" : ""}${fmt(closed)}`, open: `${(tp.unrealized_usd || 0) >= 0 ? "+" : ""}${fmt(tp.unrealized_usd || 0)}` }) : "");
        })()}</span><span>{(() => {
          // Cash AND what is in positions, per venue. Showing only the wallet made a buy look like
          // money disappearing: the balance dropped, nothing said where it went, and the number
          // looked broken rather than spent. A reading the server could not refresh says so instead
          // of sitting there looking live.
          const w = s?.bankroll?.wallets || {}, staleLegs = tw?.stale || [];
          const held = (venue) => (s?.positions || []).filter(p => p.venue === venue && !p.paper).length;
          const leg = (venue, cash, digits, unit, isStale) => {
            if (cash == null) return null;
            const n = held(venue);
            return Number(cash).toFixed(digits) + " " + unit + (n ? t("run.open", { n }) : "") + (isStale ? t("run.stale") : "");
          };
          const parts = [
            leg("pumpfun", w.pumpfun?.sol ?? tw?.solBalance, 3, "SOL", w.pumpfun?.sol == null && staleLegs.includes("sol")),
            leg("pons", w.pons?.sol ?? tw?.ethBalance, 4, "ETH", w.pons?.sol == null && staleLegs.includes("eth")),
          ].filter(Boolean);
          return parts.join(" · ");
        })()}</span></div>
        {paused && <div style={{ color: T.yl, fontSize: 13, marginTop: 8 }}>
          {/user/.test(s.halt.reason || "") ? t("run.pausedByYou") : t("run.pausedByBot", { reason: s.halt.reason })}
          {/daily_limit|daily_breaker/.test(s.halt.reason || "") && <> <span onClick={ackDaily} style={{ cursor: "pointer", textDecoration: "underline" }}>{t("run.keepTrading")}</span></>}
        </div>}
        {s?.positions?.length > 0 && <div style={{ marginTop: 12 }}>{s.positions.map(p => { const now = Date.now(); const tickAge = p.lastTickAt ? (now - p.lastTickAt) / 1000 : null; const stale = tickAge == null ? now - p.entryTime > 60_000 : tickAge > 60; const open = openPos === p.id; const url = p.venue === "pons" ? `https://www.ponsfamily.com/launchpad/${p.instrument}` : `https://pump.fun/coin/${p.instrument}`; const held = Math.round((now - p.entryTime) / 60000); return <div key={p.id} style={{ borderTop: `1px solid ${T.bd}` }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 8, alignItems: "center", fontFamily: M, fontSize: 13, padding: "6px 0" }}>
            <span onClick={() => sOpenPos(open ? null : p.id)} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}><span style={{ fontWeight: 800, color: T.tx }}>{p.name || p.ticker || p.instrument.slice(0, 6) + "…"}</span> <span style={{ color: T.ft, fontSize: 11 }}>{p.venue === "pons" ? "RH" : "SOL"} · {t("pos.held", { m: held })}{stale ? t("pos.noPrice") : ""}</span></span>
            {(() => { const value = (p.notional_usd || 0) * (1 + (p.changePct || 0) / 100), delta = value - (p.notional_usd || 0), up = delta >= 0; return <span onClick={() => sOpenPos(open ? null : p.id)} style={{ textAlign: "right", cursor: "pointer", lineHeight: 1.2 }}><div style={{ color: T.tx }}>{fmt(value)}</div><div style={{ fontSize: 11, color: stale ? T.yl : up ? T.gn : T.rd }}>{up ? "+" : "-"}{fmt(Math.abs(delta)).replace(/^[-$]+/, "$")} · {p.changePct != null ? (p.changePct >= 0 ? "+" : "") + p.changePct.toFixed(1) + "%" : ""}</div></span>; })()}
            <button onClick={() => sellPos(p, 50)} disabled={busy === "sell:" + p.id} style={{ background: "transparent", border: `1px solid ${T.bd}`, color: T.dm, borderRadius: 8, padding: "6px 8px", fontFamily: S, fontWeight: 800, fontSize: 12, cursor: "pointer" }}>50%</button>
            <button onClick={() => sellPos(p, 100)} disabled={busy === "sell:" + p.id} style={{ background: "transparent", border: `1px solid ${T.rd}`, color: T.rd, borderRadius: 8, padding: "6px 8px", fontFamily: S, fontWeight: 800, fontSize: 12, cursor: "pointer" }}>{busy === "sell:" + p.id ? "…" : t("run.sell")}</button>
          </div>
          {open && <div style={{ fontFamily: M, fontSize: 11, color: T.ft, lineHeight: 1.6, padding: "2px 0 8px" }}>
            <div>{p.instrument} <a href={url} target="_blank" rel="noopener" style={{ color: T.gn }}>{t("pos.openOn", { venue: p.venue === "pons" ? "PONS" : "pump.fun" })}</a></div>
            <div>{t("pos.paid", { paid: fmt(p.stake_usd || p.notional_usd), entry: kfmt(p.entryMark || 0), now: kfmt(p.mark || p.entryMark || 0), peak: kfmt(p.peak || p.entryMark || 0) })}</div>
            {p.sizing && <div>{t("pos.sized", { usd: fmt(p.stake_usd || 0) })}{p.sizing.kelly ? t("pos.kelly", { k: (p.sizing.kelly.f_used * 100).toFixed(1), t: p.sizing.throttle ?? 1 }) : ""}{p.sizing.caps?.length ? t("pos.capped", { list: p.sizing.caps.join(", ").toLowerCase().replace(/_/g, " ") }) : ""}</div>}
            <div>{t("pos.plan", { tier: p.tier, plan: String(p.plan?.key), hit: p.tpHit || 0 })}{p.plan?.stall_ms ? t("pos.stall", { m: Math.round(p.plan.stall_ms / 60000) }) : ""}{p.plan?.max_hold_ms ? t("pos.outBy", { m: Math.round(p.plan.max_hold_ms / 60000) }) : ""}</div>
            <div style={{ color: stale ? T.yl : T.ft }}>{t("pos.priceUpdated", { when: tickAge == null ? t("pos.never") : tickAge < 60 ? t("pos.sAgo", { n: Math.round(tickAge) }) : t("pos.mAgo", { n: Math.round(tickAge / 60) }) })}{stale ? t("pos.noExit") : ""}</div>
          </div>}
          {p.lastExitError && <div style={{ fontFamily: M, fontSize: 11, color: T.rd, padding: "0 0 8px", lineHeight: 1.4, display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ flex: 1, minWidth: 0 }}>{t("pos.sellFailed", { n: p.lastExitError.count, tried: p.lastExitError.tried })}{p.lastExitError.code ? p.lastExitError.code + " " : ""}{p.lastExitError.reason}
              {p.lastExitError.count >= 2 && <span style={{ display: "block", color: T.dm, marginTop: 3 }}>{t("pos.refusing", { n: RELEASE_AFTER })}</span>}
            </span>
            <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              {p.lastExitError.count >= 2 && <span onClick={() => releasePos(p)} style={{ cursor: "pointer", color: T.yl, textDecoration: "underline" }}>{t("pos.giveUp")}</span>}
              <span onClick={() => clearErr(p)} title={t("dismiss")} style={{ cursor: "pointer", color: T.dm }}>&times;</span>
            </span>
          </div>}
        </div>; })}</div>}
        {(() => { const h = s?.holdings || {}; const rows = Object.entries(h).flatMap(([venue, x]) => (x.list || []).filter(i => !i.tracked && i.qty >= 1 && !hidden.has(venue + i.instrument)).map(i => ({ ...i, venue }))); if (!rows.length) return null; return <div style={{ marginTop: 10, fontFamily: M, fontSize: 11, color: T.yl, lineHeight: 1.6 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>{t("pos.alsoHeld")}</span><span onClick={() => hideAll(rows)} style={{ cursor: "pointer", color: T.dm }}>{t("pos.hideAll")}</span></div>
          {rows.map(r => <div key={r.venue + r.instrument} style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><a href={r.venue === "pons" ? `https://www.ponsfamily.com/launchpad/${r.instrument}` : `https://pump.fun/coin/${r.instrument}`} target="_blank" rel="noopener" style={{ color: T.yl }}>{r.instrument.slice(0, 10)}…</a> · {r.venue === "pons" ? "RH" : "SOL"} · {t("pos.tokens", { n: Number(r.qty).toLocaleString(undefined, { maximumFractionDigits: 0 }) })}</span><button onClick={() => sellHolding(r.venue, r.instrument)} disabled={selling === r.venue + r.instrument} style={{ background: "transparent", border: `1px solid ${T.rd}`, color: T.rd, borderRadius: 8, padding: "4px 8px", fontFamily: S, fontWeight: 800, fontSize: 11, cursor: "pointer" }}>{selling === r.venue + r.instrument ? "…" : t("run.sell")}</button><span onClick={() => hideOne(r.venue + r.instrument)} title={t("hide")} style={{ cursor: "pointer", color: T.dm, padding: "0 4px" }}>×</span></div>)}
        </div>; })()}
        <div ref={narRef} style={{ marginTop: 14, fontFamily: M, fontSize: 11, lineHeight: 1.55, height: 200, overflowY: "auto", background: T.bg, border: `1px solid ${T.bd}`, borderRadius: 10, padding: "8px 10px", color: T.ft }}>
          {(st.narration || []).map((n, i) => <div key={i} style={{ color: /FILLED|SOLD|P&L/.test(n.line) ? T.tx : /fee/.test(n.line) ? T.yl : T.ft, whiteSpace: "pre-wrap" }}>{n.line}</div>)}
          {!(st.narration || []).length && <div>{t("run.narrationEmpty")}</div>}
        </div>
        {s?.review && <div style={{ marginTop: 10, fontFamily: M, fontSize: 11, color: T.ft, lineHeight: 1.6 }}>
          <div>{t("run.review", { n: s.review.n })}<b style={{ color: s.review.pnl_usd >= 0 ? T.gn : T.rd }}>{fmt(s.review.pnl_usd)}</b>{t("run.reviewTail", { won: Math.round(s.review.win_rate * 100), fees: fmt(s.review.fees_usd) })}{Object.entries(s.review.venues || {}).map(([v, x]) => ` · ${v === "pons" ? "RH" : "SOL"} ${x.n} ${fmt(x.pnl_usd)}`)}</div>
          <div>{s.review.reasons.slice(0, 6).map(r => <span key={r.reason} style={{ marginRight: 10, color: r.pnl_usd >= 0 ? T.gn : T.yl }}>{r.reason.toLowerCase().replace(/_/g, " ")} {r.n} {fmt(r.pnl_usd)}</span>)}</div>
        </div>}
        {s.closes?.length > 0 && <div style={{ marginTop: 12 }}>
          <div style={{ ...muted, marginBottom: 6 }}>{t("run.closes")}</div>
          <div style={{ background: T.sf + "f5", border: `1px solid ${T.bd}`, borderRadius: 12, overflow: "hidden" }}>
            {s.closes.slice(0, 5).map((c, i) => <div key={c.ts + ":" + i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderTop: i ? `1px solid ${T.bd}` : "none" }}>
              <span style={{ flex: 1, minWidth: 0, fontFamily: M, fontSize: 12, color: T.dm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><b style={{ color: T.tx }}>${(c.ticker || c.instrument.slice(0, 6)).replace(/^\$/, "")}</b> · {held(c.held_ms, t)} · {c.reason.toLowerCase().replace(/_/g, " ")}{c.paper ? t("run.paperTag") : ""} · {t("run.ago", { ago: ago(Date.now() - c.ts, t) })}</span>
              <span style={{ fontFamily: M, fontWeight: 900, fontSize: 14, color: c.pnl_usd >= 0 ? T.gn : T.rd, flexShrink: 0 }}>{c.pnl_pct >= 0 ? "+" : ""}{Number(c.pnl_pct).toFixed(0)}%</span>
              {c.pnl_usd > 0 && !c.paper && <a href={shareUrl(c)} target="_blank" rel="noopener" style={{ flexShrink: 0, fontFamily: S, fontWeight: 800, fontSize: 12, color: "#000", background: T.gn, borderRadius: 8, padding: "5px 9px", textDecoration: "none" }}>{t("share.tweet")}</a>}
              {c.pnl_usd > 0 && <ShareCardBtn T={T} c={c} onError={m => say(m, "error")} />}
            </div>)}
          </div>
        </div>}
        <Pulse st={st} T={T} />
        <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
          <Btn ghost T={T} onClick={paused ? resume : pause} disabled={busy === "pause"}>{busy === "pause" ? "…" : paused ? t("run.resume") : t("run.pause")}</Btn>
          <Btn danger T={T} onClick={stop} disabled={busy === "stop"}>{busy === "stop" ? t("run.selling") : t("run.stop")}</Btn>
        </div>
      </>}
      {msg && <div onClick={() => sMsg(null)} title={t("dismiss.tap")} style={{ marginTop: 12, fontSize: 13, cursor: "pointer", color: msg.kind === "error" ? T.rd : T.gn }}>{msg.m} <span style={{ color: T.dm }}>×</span></div>}
    </div>

    {/* Footer: the two ways out, and the one line about money */}
    {pk && tw && <div style={{ width: "100%", maxWidth: 440, marginTop: 14, display: "flex", gap: 8 }}>
      <Btn ghost T={T} onClick={withdraw} disabled={busy === "withdraw" || running}>{busy === "withdraw" ? t("hold.sending") : t("hold.withdrawSol")}</Btn>
      {tw.ethBalance > 0 && <Btn ghost T={T} onClick={withdrawEth} disabled={busy === "withdraw" || running}>{t("hold.withdrawEth")}</Btn>}
      {tw.usdcBalance > 0 && <Btn ghost T={T} onClick={withdrawUsdc} disabled={busy === "withdraw" || running}>{t("hold.withdrawUsdc")}</Btn>}
      <Btn ghost T={T} onClick={exportKey} disabled={busy === "key"}>{busy === "key" ? t("hold.signing") : t("hold.exportKey")}</Btn>
    </div>}
    {pk && tw && <div style={{ width: "100%", maxWidth: 440, marginTop: 8 }}>
      <Btn ghost T={T} onClick={() => sHoldOpen(o => !o)}>{holdOpen ? t("hold.hide") : t("hold.show")}</Btn>
      {holdOpen && <div style={{ marginTop: 8, background: T.sf, border: `1px solid ${T.bd}`, borderRadius: 12, padding: "10px 12px", fontFamily: M, fontSize: 11, lineHeight: 1.5 }}>
        {!hold && <div style={{ color: T.ft }}>{t("hold.reading")}</div>}
        {hold && [...hold.sol, ...hold.eth, ...(hold.usdc || [])].length === 0 && <div style={{ color: T.ft }}>{t("hold.none")}</div>}
        {hold && [...hold.sol, ...hold.eth, ...(hold.usdc || [])].map(h => { const sellable = h.state === "curve" || h.state === "bonded" || h.state === "unknown" && (h.venue === "pumpfun" || h.venue === "arc"); const k = h.venue + h.instrument; return <div key={k} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "center", padding: "6px 0", borderTop: `1px solid ${T.bd}` }}>
          <span style={{ minWidth: 0 }}>
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><a href={h.url} target="_blank" rel="noopener" style={{ color: T.tx, fontWeight: 800, textDecoration: "none" }}>{h.name || h.ticker || h.instrument.slice(0, 10) + "…"}</a> <span style={{ color: T.ft }}>{h.venue === "pons" ? "RH" : h.venue === "arc" ? "ARC" : "SOL"}{h.tracked ? t("hold.open") : ""}</span></div>
            <div style={{ color: h.state === "curve" ? T.ft : T.yl }}>{t("pos.tokens", { n: Number(h.qty).toLocaleString(undefined, { maximumFractionDigits: 0 }) })} · {t.has(`state.${h.state}`) ? t(`state.${h.state}`) : h.state}{h.curvePct != null ? ` ${Math.round(h.curvePct * 100)}%` : ""}{h.mcapUsd ? t("hold.mcap", { v: kfmt(h.mcapUsd) }) : ""}{h.via === "transfer" ? t("hold.viaTransfer") : ""}{h.state === "graduated" ? t("hold.sellOnPool") : h.state === "not a curve token" ? t("hold.noCurve") : ""}</div>
            {h.result && <div style={{ color: h.result.ok ? T.gn : T.rd }}>{h.result.ok ? t("hold.soldFor", { n: Number(h.result.received || 0).toFixed(5) }) : h.result.error}</div>}
            {h.explorer && h.state !== "curve" && <a href={h.explorer} target="_blank" rel="noopener" style={{ color: T.dm }}>{t("hold.explorer")}</a>}
          </span>
          <span style={{ textAlign: "right", color: T.tx }}>{h.valueUsd != null ? fmt(h.valueUsd) : "—"}</span>
          <button onClick={() => sellHolding(h.venue, h.instrument)} disabled={!sellable || selling === k} style={{ background: "transparent", border: `1px solid ${sellable ? T.rd : T.bd}`, color: sellable ? T.rd : T.dm, borderRadius: 8, padding: "5px 9px", fontFamily: S, fontWeight: 800, fontSize: 11, cursor: sellable ? "pointer" : "default" }}>{selling === k ? "…" : t("run.sell")}</button>
        </div>; })}
        {hold?.scan && !hold.scan.done && <div style={{ color: T.dm, marginTop: 6 }}>{t("hold.scanning")}</div>}
        {hold?.errors?.length > 0 && <div style={{ color: T.yl, marginTop: 6 }}>{hold.errors.join(" · ")}</div>}
      </div>}
      <div style={{ height: 8 }} />
      <Btn ghost T={T} onClick={sweepAll} disabled={busy === "sweep" || (sweep && !sweep.done)}>{sweep && !sweep.done ? t("sweep.running", { n: sweep.sold + sweep.failed }) + (sweep.current ? t("sweep.now", { venue: sweep.current.venue === "pons" ? "RH" : "SOL", id: sweep.current.instrument.slice(0, 8) }) : "") : t("sweep.start")}</Btn>
      {sweep && (sweep.report?.length > 0 || sweep.error) && <div style={{ marginTop: 8, fontFamily: M, fontSize: 11, color: T.ft, lineHeight: 1.6 }}>
        <div style={{ color: T.dm, display: "flex", justifyContent: "space-between" }}><span>{sweep.done ? t("sweep.finished", { sold: sweep.sold, failed: sweep.failed }) : t("sweep.progress", { sold: sweep.sold, failed: sweep.failed })}{sweep.error ? ` · ${sweep.error}` : ""}</span>{sweep.done && <span onClick={() => sSweep(null)} style={{ cursor: "pointer", padding: "0 4px" }}>{t("sweep.clear")}</span>}</div>
        {sweep.report.map((r, i) => <div key={i} style={{ color: r.ok ? T.gn : r.note ? T.dm : T.yl }}>{r.instrument ? `${r.venue === "pons" ? "RH" : "SOL"} ${r.instrument.slice(0, 10)}… ` : ""}{r.ok ? t("sweep.sold") + (r.received != null ? t("sweep.soldFor", { n: Number(r.received).toFixed(r.venue === "pons" ? 5 : 4), unit: r.venue === "pons" ? "ETH" : "SOL" }) : "") : `${r.code ? r.code + ": " : ""}${r.error}`}</div>)}
      </div>}
    </div>}
    {msg && !running && pk && tw && <div onClick={() => sMsg(null)} title={t("dismiss.tap")} style={{ width: "100%", maxWidth: 440, marginTop: 8, fontSize: 13, cursor: "pointer", color: msg.kind === "error" ? T.rd : T.gn }}>{msg.m} <span style={{ color: T.dm }}>×</span></div>}
    {showKey && <div style={{ width: "100%", maxWidth: 440, marginTop: 10, background: T.sf, border: `1px solid ${T.yl}`, borderRadius: 12, padding: 14 }}>
      <div style={{ ...muted, color: T.yl, marginBottom: 6 }}>{t("keys.warn")}</div>
      <div style={{ ...muted, fontSize: 11, marginTop: 6 }}>Solana</div>
      <div onClick={() => copy(showKey.sol)} title={t("copy.tap")} style={{ fontFamily: M, fontSize: 12, wordBreak: "break-all", cursor: "pointer", color: T.tx, padding: "8px 10px", background: T.bg, borderRadius: 8, border: `1px solid ${T.bd}` }}>{showKey.sol}</div>
      {showKey.evm && <><div style={{ ...muted, fontSize: 11, marginTop: 8 }}>Robinhood Chain</div>
      <div onClick={() => copy(showKey.evm)} title={t("copy.tap")} style={{ fontFamily: M, fontSize: 12, wordBreak: "break-all", cursor: "pointer", color: T.tx, padding: "8px 10px", background: T.bg, borderRadius: 8, border: `1px solid ${T.bd}` }}>{showKey.evm}</div></>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}><Btn ghost T={T} onClick={() => sShowKey(null)}>{t("keys.hide")}</Btn></div>
    </div>}
    <Watch T={T} agg={agg} />
    <Lore T={T} />
    <div style={{ ...muted, fontSize: 12, marginTop: 28, textAlign: "center", maxWidth: 440 }}>
      {t("footer.fee", { pct: FEE_PCT })}{" "}
      {waived === true
        ? <span style={{ color: T.gn }}>{t("footer.waived", { sym: TOKEN_SYMBOL })}</span>
        : <>{t("footer.holdPre")}<a href={TOKEN_URL} target="_blank" rel="noopener" style={{ color: T.dm, textDecoration: "underline dotted", textUnderlineOffset: 3 }}>${TOKEN_SYMBOL}</a>{t("footer.holdPost")}</>}
      {" "}{t("footer.risk")}
    </div>
    <Socials T={T} />
  </div></TC.Provider>;
}
