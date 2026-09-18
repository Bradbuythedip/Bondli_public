import { API } from "./constants.js";
// Base58 for the signature bytes Phantom returns (no dependency needed for one encoder).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) { let x = 0n; for (const b of bytes) x = x * 256n + BigInt(b); let out = ""; while (x > 0n) { out = B58[Number(x % 58n)] + out; x /= 58n; } for (const b of bytes) { if (b === 0) out = "1" + out; else break; } return out; }
const TOK = w => "bondli_auth_" + w;

class A {
  constructor() { this.w = null; this._signing = null; }
  sw(w) { this.w = w; }
  token() { try { return this.w ? localStorage.getItem(TOK(this.w)) : null; } catch { return null; } }
  // Proof of ownership: sign a server nonce with Phantom once; the token lasts 7 days and is sent as
  // Bearer on every call. Money routes refuse without it, so f() signs in on a 401 and retries once.
  async signIn() {
    if (!this.w) throw new Error("connect wallet first");
    if (this._signing) return this._signing;
    this._signing = (async () => {
      try {
        const p = window?.phantom?.solana || window?.solana;
        if (!p?.signMessage) throw new Error("wallet cannot sign");
        const c = await this.f("/api/auth/challenge", { method: "POST", body: { wallet: this.w }, noauth: true });
        const s = await p.signMessage(new TextEncoder().encode(c.message), "utf8");
        const v = await this.f("/api/auth/verify", { method: "POST", body: { wallet: this.w, signature: b58(s.signature || s) }, noauth: true });
        try { localStorage.setItem(TOK(this.w), v.token); } catch {}
        return v.token;
      } finally { this._signing = null; }
    })();
    return this._signing;
  }
  async f(p, o = {}) {
    const h = { "Content-Type": "application/json" };
    if (this.w) { h["X-Wallet"] = this.w; const t = this.token(); if (t && !o.noauth) h["Authorization"] = "Bearer " + t; }
    const r = await fetch(API + p, { headers: h, ...o, body: o.body ? JSON.stringify(o.body) : undefined, signal: o.signal || AbortSignal.timeout(o.timeout || 20000) });
    if (!r.ok) {
      const e = await r.json().catch(() => ({ error: r.statusText }));
      if (r.status === 401 && e.auth_required && !o.noauth && !o._retried) { await this.signIn(); return this.f(p, { ...o, _retried: true }); }
      throw new Error(e.error || `API ${r.status}`);
    }
    return r.json();
  }
  // The bot's wallet
  gtw(w) { return this.f(`/api/trading-wallet/${w}`); }
  ctw(w) { return this.f("/api/trading-wallet/create", { method: "POST", body: { wallet: w } }); }
  etw(w) { return this.f("/api/trading-wallet/export", { method: "POST", body: { wallet: w } }); }
  wdr(w, to, sol) { return this.f("/api/trading-wallet/withdraw", { method: "POST", body: { wallet: w, to, sol: sol || "all" }, timeout: 60000 }); }
  wdrEth(w, to) { return this.f("/api/trading-wallet/withdraw", { method: "POST", body: { wallet: w, to, sol: "all", chain: "pons" }, timeout: 60000 }); }
  wdrUsdc(w, to) { return this.f("/api/trading-wallet/withdraw", { method: "POST", body: { wallet: w, to, sol: "all", chain: "arc" }, timeout: 60000 }); }
  // The bot
  vst(w, s) { return this.f("/api/velocity/start", { method: "POST", body: { wallet: w, settings: s }, timeout: 90000 }); }
  vsp(w) { return this.f("/api/velocity/stop", { method: "POST", body: { wallet: w }, timeout: 90000 }); }
  vstat(w) { return this.f(`/api/velocity/status?wallet=${w}`); }
  vpause(w) { return this.f("/api/velocity/pause", { method: "POST", body: { wallet: w } }); }
  vresume(w) { return this.f("/api/velocity/resume", { method: "POST", body: { wallet: w } }); }
  vsweepStatus(w) { return this.f("/api/velocity/sweep?wallet=" + w); }
  vholdings(w) { return this.f("/api/velocity/holdings?wallet=" + w, { timeout: 60000 }); }
  vsell(w, venue, instrument, pct) { return this.f("/api/velocity/sell", { method: "POST", body: { wallet: w, venue, instrument, pct: pct || 100 }, timeout: 120000 }); }
  vsweep(w, chain) { return this.f("/api/velocity/sweep", { method: "POST", body: { wallet: w, chain: chain || "all" }, timeout: 180000 }); }
  vclose(w, positionId, pct) { return this.f("/api/velocity/close", { method: "POST", body: { wallet: w, positionId, pct }, timeout: 90000 }); }
  vrelease(w, positionId, note) { return this.f("/api/velocity/release", { method: "POST", body: { wallet: w, positionId, note } }); }
  vclearErr(w, positionId) { return this.f("/api/velocity/clear-error", { method: "POST", body: { wallet: w, positionId } }); }
  vackDaily(w) { return this.f("/api/velocity/ack-daily-limit", { method: "POST", body: { wallet: w } }); }
  // What the bot sees (public)
  launch() { return this.f("/api/launch", { noauth: true, timeout: 8000 }); }
  live(agg) { return this.f("/api/radar/live" + (agg != null ? "?aggression=" + agg : ""), { noauth: true, timeout: 8000 }); }
  pulse() { return this.f("/api/velocity/pulse", { noauth: true, timeout: 8000 }); }
  movers(tf) { return this.f("/api/movers" + (tf ? "?timeframe=" + tf : ""), { noauth: true, timeout: 15000 }); }
  calls() { return this.f("/api/callouts", { noauth: true, timeout: 8000 }); }
}
export const a = new A(); export default a;
