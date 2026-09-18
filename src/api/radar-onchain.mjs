// ═══ BONDLI — On-chain pump.fun trade stream (PumpPortal-independent) ═══
// One logsSubscribe on the pump.fun program. Every buy and sell writes an Anchor
// TradeEvent as a "Program data:" log line; decoding it yields the same fields
// PumpPortal's keyed (metered) stream delivers, for free, from any Solana RPC.
// Emits objects in PumpPortal's wire shape so processRadarMessage needs no change.

import { Connection, PublicKey } from "@solana/web3.js";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const TRADE_DISC_B64 = "vdt/007mYe"; // base64 prefix of the TradeEvent discriminator
// sha256("event:CreateEvent")[0..8] = 1b72a94ddeeb6376 -> base64 "G3KpTd7rY3Y=". Ten characters, like the
// trade prefix, so the eleventh (which depends on the byte after the discriminator) is not matched.
export const CREATE_DISC_B64 = "G3KpTd7rY3";

/** Fixed-offset decode of the TradeEvent header (after the 8-byte discriminator):
 *  mint@0, sol_amount u64@32, token_amount u64@40, is_buy u8@48, user@49,
 *  timestamp i64@81, virtual_sol_reserves u64@89, virtual_token_reserves u64@97.
 *  pump.fun has only ever appended fields to this event. */
export function decodeTradeEvent(raw) {
  if (!raw || raw.length < 129) return null;
  const b = raw.subarray(8);
  const vSol = Number(b.readBigUInt64LE(89));
  const vTok = Number(b.readBigUInt64LE(97));
  if (!(vTok > 0) || !(vSol > 1e8) || vSol > 1e13) return null; // sanity: 0.1 .. 10,000 SOL of virtual reserves
  return {
    mint: new PublicKey(b.subarray(0, 32)).toBase58(),
    solAmount: Number(b.readBigUInt64LE(32)) / 1e9,
    tokenAmount: Number(b.readBigUInt64LE(40)) / 1e6,
    isBuy: b[48] === 1,
    user: new PublicKey(b.subarray(49, 81)).toBase58(),
    timestamp: Number(b.readBigInt64LE(81)),
    vSol,
    vTok,
  };
}

/** The CreateEvent: name, symbol, uri as Borsh strings (u32 LE length + utf8), then mint, bonding
 *  curve and creator pubkeys. pump.fun has appended fields since (creator, timestamp, reserves);
 *  everything this needs is in the prefix, and the trailing reserves are read only when present.
 *
 *  This is what makes a launch visible at second zero without PumpPortal: the metadata URI is in
 *  the event, so the picture can be fetched from the IPFS JSON before pump.fun's own API has even
 *  indexed the mint. Before this, creates only arrived over PumpPortal's websocket -- when that
 *  dropped, the radar went "offline" and saw no new launches at all. */
export function decodeCreateEvent(raw) {
  if (!raw || raw.length < 8 + 12 + 96) return null;
  const b = raw.subarray(8);
  let o = 0;
  const str = () => { if (o + 4 > b.length) throw new Error("short"); const n = b.readUInt32LE(o); o += 4; if (n > 512 || o + n > b.length) throw new Error("short"); const v = b.subarray(o, o + n).toString("utf8"); o += n; return v; };
  const key = () => { if (o + 32 > b.length) throw new Error("short"); const v = new PublicKey(b.subarray(o, o + 32)).toBase58(); o += 32; return v; };
  try {
    const name = str(), symbol = str(), uri = str();
    const mint = key(), bondingCurve = key(), user = key();
    let creator = null, timestamp = null, vTok = null, vSol = null;
    if (o + 32 <= b.length) creator = key();
    if (o + 8 <= b.length) { timestamp = Number(b.readBigInt64LE(o)); o += 8; }
    if (o + 16 <= b.length) { vTok = Number(b.readBigUInt64LE(o)); vSol = Number(b.readBigUInt64LE(o + 8)); o += 16; }
    return { name, symbol, uri, mint, bondingCurve, user, creator, timestamp, vSol, vTok };
  } catch { return null; }
}

/** Walk a transaction's log lines with an invoke/success stack so only events
 *  emitted while pump.fun itself is executing are decoded (other programs reuse
 *  the same discriminator bytes). */
export function pumpTradesFromLogs(logs) { return pumpEventsFromLogs(logs).trades; }

/** Both event kinds from one walk of the logs: trades and creates. */
export function pumpEventsFromLogs(logs) {
  const stack = [];
  const trades = [], creates = [];
  for (const l of logs || []) {
    let m;
    if ((m = /^Program (\w+) invoke \[\d+\]$/.exec(l))) stack.push(m[1]);
    else if (/^Program \w+ (success|failed)/.test(l)) stack.pop();
    else if (stack[stack.length - 1] === PUMP_PROGRAM && l.startsWith("Program data: " + TRADE_DISC_B64)) {
      let t = null;
      try { t = decodeTradeEvent(Buffer.from(l.slice(14), "base64")); } catch { t = null; }
      if (t) trades.push(t);
    } else if (stack[stack.length - 1] === PUMP_PROGRAM && l.startsWith("Program data: " + CREATE_DISC_B64)) {
      let c = null;
      try { c = decodeCreateEvent(Buffer.from(l.slice(14), "base64")); } catch { c = null; }
      if (c) creates.push(c);
    }
  }
  return { trades, creates };
}

/** A create in PumpPortal's wire shape, so processRadarMessage's create branch needs no change:
 *  it already reads name/symbol/uri and fetches the picture from the uri. */
export function toPortalCreate(c, signature, slot) {
  const vSol = c.vSol > 0 ? c.vSol : 30e9, vTok = c.vTok > 0 ? c.vTok : 1.073e15; // pump.fun's opening virtual reserves when the event predates the reserve fields
  return {
    txType: "create", signature, slot,
    mint: c.mint, traderPublicKey: c.user, bondingCurveKey: c.bondingCurve,
    name: c.name, symbol: c.symbol, uri: c.uri,
    vSolInBondingCurve: vSol / 1e9, vTokensInBondingCurve: vTok / 1e6, marketCapSol: (vSol * 1e6) / vTok,
    initialBuy: 0, pool: "pump", timestamp: c.timestamp, source: "onchain",
  };
}

export function toPortalTrade(t, signature, slot) {
  return {
    txType: t.isBuy ? "buy" : "sell",
    signature,
    slot,
    mint: t.mint,
    traderPublicKey: t.user,
    solAmount: t.solAmount,
    tokenAmount: t.tokenAmount,
    vSolInBondingCurve: t.vSol / 1e9,
    vTokensInBondingCurve: t.vTok / 1e6,
    marketCapSol: (t.vSol * 1e6) / t.vTok,
    pool: "pump",
    timestamp: t.timestamp,
    source: "onchain",
  };
}

/** Start the stream. Returns { stop, stats }. Resubscribes after staleMs of silence. */
export function startOnchainTrades({ rpcUrl, commitment = "confirmed", onTrade, staleMs = 45_000, log = console } = {}) {
  if (!rpcUrl) throw new Error("startOnchainTrades needs an rpcUrl");
  const stats = { notifications: 0, trades: 0, resubscribes: 0, startedAt: Date.now(), lastMsg: 0 };
  let conn = null, subId = null, stopped = false;
  const connect = () => {
    conn = new Connection(rpcUrl, { commitment });
    subId = conn.onLogs(new PublicKey(PUMP_PROGRAM), ({ err, logs, signature }, ctx) => {
      stats.notifications++;
      stats.lastMsg = Date.now();
      if (err) return; // failed transactions are delivered too
      const ev = pumpEventsFromLogs(logs);
      for (const c of ev.creates) {
        stats.creates = (stats.creates || 0) + 1;
        try { onTrade(toPortalCreate(c, signature, ctx?.slot)); } catch (e) { log.error?.("[RADAR] onchain onCreate error:", e.message); }
      }
      for (const t of ev.trades) {
        stats.trades++;
        try { onTrade(toPortalTrade(t, signature, ctx?.slot)); } catch (e) { log.error?.("[RADAR] onchain onTrade error:", e.message); }
      }
    }, commitment);
    stats.lastMsg = Date.now();
    log.log?.(`[RADAR] onchain logsSubscribe ${commitment} via ${String(rpcUrl).split("?")[0]} sub=${subId}`);
  };
  connect();
  const watchdog = setInterval(async () => {
    if (stopped) return;
    if (Date.now() - stats.lastMsg > staleMs) {
      stats.resubscribes++;
      log.warn?.("[RADAR] onchain stream silent — resubscribing");
      try { await conn.removeOnLogsListener(subId); } catch {}
      connect();
    }
  }, 10_000);
  watchdog.unref?.();
  return {
    stats,
    stop: async () => { stopped = true; clearInterval(watchdog); try { await conn.removeOnLogsListener(subId); } catch {} },
  };
}
