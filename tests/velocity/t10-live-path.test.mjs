// T10: the live path end to end, without a network. Every case here was a defect found by
// tracing the operator's first live day: a $50 bankroll that could never clear the minimum
// stake, a restart that forgot the venue was live, paper positions handed to the live router,
// fills booked from a lagging RPC, sells that landed after their timeout, and positions with
// no ticks and therefore no exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../src/velocity/core/engine.mjs";
import { Sizer, loadRiskEnvelope } from "../../src/velocity/core/risk.mjs";
import { ScriptedFeed } from "../../src/velocity/core/feed.mjs";
import { makeEvent } from "../../src/velocity/core/events.mjs";
import { evaluateExit, createPlan } from "../../src/velocity/core/exits.mjs";
import { buildEngine, DEFAULT_CONFIG } from "../../src/velocity/core/build.mjs";
import { failure } from "../../src/velocity/core/router.mjs";
import { makePumpfunEdge } from "../../src/velocity/venues/pumpfun/edge.mjs";
import { PumpfunPaperRouter, PumpfunLiveRouter, solNeededForBuy, walletDeltasFromMeta, RENT_ATA_SOL } from "../../src/velocity/venues/pumpfun/router.mjs";
import { goodCandidatePayload, tickPayload } from "./helpers/fixtures.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "velocity-t10-"));

/** The operator's envelope: $50 bankroll, $5 minimum stake. */
function smallEnvelope(dir, over = {}) {
  const base = JSON.parse(fs.readFileSync(path.resolve("src/velocity/config/risk.example.json"), "utf8"));
  const cfg = { ...base, bankroll_usd: 50, per_trade_max_usd: 10, portfolio_max_exposure_usd: 40, daily_loss_limit_usd: 15, max_concurrent_positions: 4, max_per_group: 1, ...over };
  cfg.venues = { ...base.venues, pumpfun: { ...base.venues.pumpfun, max_exposure_usd: 40, min_stake_usd: 5, ...(over.pumpfun || {}) }, polymarket: { ...base.venues.polymarket, max_exposure_usd: 0 } };
  const file = path.join(dir, "risk.json");
  fs.writeFileSync(file, JSON.stringify(cfg));
  return loadRiskEnvelope(file);
}

/** A live router double: no network, scripted wallet, records every call. */
class FakeLive {
  constructor({ wallet = {}, failInit = false, balanceSol = 1 } = {}) {
    this.ready = false; this.calls = []; this.wallet = wallet; this.failInit = failInit; this.balanceSol = balanceSol; this.priorityFeeSol = 0.0005;
    this.closeImpl = null; this.submitImpl = null; this.closedAccounts = [];
  }
  async closeTokenAccount(mint) { this.closedAccounts.push(mint); return { closed: 1, reclaimed_sol: 0.002034, sig: "SIGRENT" }; }
  async init() { this.calls.push("init"); if (this.failInit) throw new Error("MASTER_SEED missing"); this.ready = true; return { wallet: "WALLET", balanceSol: this.balanceSol, rpc: "fake" }; }
  async health() { return { ok: true, latencyMs: 1, detail: "fake" }; }
  async preflight() { this.calls.push("preflight"); return { wallet: "WALLET", balanceSol: this.balanceSol, rpc: "fake" }; }
  async positions() { this.calls.push("positions"); return this.ready ? Object.entries(this.wallet).filter(([, q]) => q > 0).map(([instrument, qty]) => ({ instrument, qty })) : []; }
  async submit(order) {
    this.calls.push(`submit:${order.instrument}`);
    if (this.submitImpl) return this.submitImpl(order);
    const t = Date.now();
    this.wallet[order.instrument] = (this.wallet[order.instrument] || 0) + 1000;
    return { ok: true, fill: { orderId: order.id, decisionId: order.decisionId, venue: "pumpfun", instrument: order.instrument, side: "BUY", price: 0.005, qty: 1000, notional_usd: 5.12, fee_usd: 0.12, t_sent: t, t_filled: t + 5, latency_ms: 5, venue_ref: "SIGBUY" } };
  }
  async close(p, pct, ctx) {
    this.calls.push(`close:${p.instrument}:${pct}`);
    if (this.closeImpl) return this.closeImpl(p, pct, ctx);
    return failure({ id: p.id }, "NO_POSITION", "no token balance to sell");
  }
}

function mkEngine(dataDir, { envelope, mode = "paper", live = null, feed = new ScriptedFeed({ venue: "pumpfun", script: [] }), config = {} } = {}) {
  const venues = { pumpfun: { mode, feed, edge: makePumpfunEdge(), router: new PumpfunPaperRouter({ bookFile: path.join(dataDir, "paper-book-pumpfun.json"), latencyMs: 0 }), liveRouter: live } };
  return new Engine({ dataDir, envelope, venues, config: { saveMs: 600_000, governorMs: 600_000, sweepMs: 600_000, ...config } });
}
const cand = (id, t = Date.now()) => makeEvent({ venue: "pumpfun", kind: "candidate", id, t_venue: t - 100, t_observed: t, payload: goodCandidatePayload(id) });

test("T10: a $50 bankroll trades the venue minimum instead of nothing", () => {
  const env = smallEnvelope(tmp());
  const sizer = new Sizer(env);
  const portfolio = { open: [], realized_today_usd: 0 };
  const tier1 = sizer.size({ decision: { venue: "pumpfun", p_win: 0.45, payoff: 3, stop_fraction: 1 }, portfolio });
  assert.equal(tier1.stake_usd, 5, "fractional Kelly ($3.33) is floored to the $5 minimum");
  assert.ok(tier1.caps.includes("MIN_STAKE_FLOOR"));
  const tier2 = sizer.size({ decision: { venue: "pumpfun", p_win: 0.35, payoff: 3, stop_fraction: 1 }, portfolio });
  assert.equal(tier2.stake_usd, 5);
  const noEdge = sizer.size({ decision: { venue: "pumpfun", p_win: 0.25, payoff: 3, stop_fraction: 1 }, portfolio });
  assert.equal(noEdge.stake_usd, 0); assert.equal(noEdge.reasons[0], "NO_EDGE", "the floor never invents an edge");
  // The floor respects every cap: with $37 open of a $40 venue cap there is no room for $5.
  const crowded = sizer.size({ decision: { venue: "pumpfun", p_win: 0.45, payoff: 3, stop_fraction: 1 }, portfolio: { open: [{ venue: "pumpfun", notional_usd: 37, worst_case_fraction: 0 }], realized_today_usd: 0 } });
  assert.equal(crowded.stake_usd, 0); assert.match(crowded.reasons[0], /BELOW_MIN_STAKE/);
  // And the daily budget: $12 lost today of a $15 limit leaves $3 of risk, not $5.
  const bled = sizer.size({ decision: { venue: "pumpfun", p_win: 0.45, payoff: 3, stop_fraction: 1 }, portfolio: { open: [], realized_today_usd: -12 } });
  assert.equal(bled.stake_usd, 0); assert.match(bled.reasons[0], /BELOW_MIN_STAKE/);
});

test("T10: the persisted venue mode survives a restart and the live router is initialized before reconcile", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const first = mkEngine(dir, { envelope: env, mode: "paper", live: new FakeLive() });
  assert.equal(first.store.venueMode("pumpfun"), "paper", "config seeds a venue the store never saw");
  first.store.setVenueMode("pumpfun", "live", { liveStartCapUsd: 5 }); first.store.save();
  // Restart with the same default config ("paper"): the operator's go-live wins.
  const live = new FakeLive({ wallet: { MintHeld: 900 } });
  const second = mkEngine(dir, { envelope: env, mode: "paper", live });
  assert.equal(second.store.venueMode("pumpfun"), "live");
  second.store.upsertPosition({ id: "pumpfun:MintHeld:1", venue: "pumpfun", instrument: "MintHeld", status: "open", paper: false, qty: 900, remaining_qty: 900, cost_usd: 5, notional_usd: 5, stake_usd: 5, proceeds_usd: 0, entryTime: Date.now(), entryMark: 9000, plan: createPlan({ venue: "pumpfun", key: 2, entry: { score: 60 } }) });
  try {
    await second.start();
    assert.deepEqual(live.calls.slice(0, 2), ["init", "positions"], "init runs before the wallet is read");
    assert.equal(second.store.openPositions("pumpfun").length, 1, "the real position is matched, not closed as missing");
    assert.equal(second.ledger.query({ kind: "venue", limit: 1 })[0].by, "restart");
    assert.equal(second.venues.pumpfun.liveStartCapUsd ?? second.store.state.venues.pumpfun.liveStartCapUsd, 5, "the live start cap is persisted with the mode");
  } finally { await second.stop(); }

  // A router that cannot initialize freezes the venue instead of emptying it.
  const broken = new FakeLive({ failInit: true });
  const third = mkEngine(dir, { envelope: env, mode: "paper", live: broken });
  try {
    await third.start();
    assert.equal(third.store.openPositions("pumpfun").length, 1, "nothing closed");
    assert.equal(third.store.isHalted("pumpfun")?.mode, "freeze");
    assert.match(third.store.isHalted("pumpfun").reason, /live router not ready/);
    const rec = third.ledger.query({ kind: "reconcile", limit: 1 })[0];
    assert.equal(rec.report.venues.pumpfun.frozen, true);
  } finally { await third.stop(); }
});

test("T10: going live closes paper positions through the paper router first; going back refuses with live positions open", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const live = new FakeLive();
  const engine = mkEngine(dir, { envelope: env, mode: "paper", live, config: { reentryCooldownMs: 0 } });
  try {
    await engine.start({ reconcile: false });
    await engine.enqueue(() => engine.onEvent(cand("MintPaper")));
    assert.equal(engine.store.openPositions("pumpfun").length, 1);
    assert.equal(engine.store.openPositions("pumpfun")[0].paper, true);
    const r = await engine.setVenueMode("pumpfun", "live", { override: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(engine.store.openPositions("pumpfun").length, 0, "the paper position was closed before the flip");
    const outcome = engine.ledger.query({ kind: "outcome", limit: 1 })[0];
    assert.equal(outcome.reason, "VENUE_MODE_CHANGE"); assert.equal(outcome.paper, true);
    assert.ok(!live.calls.some(c => c.startsWith("close")), "the live router never saw the paper position");
    assert.equal(engine.store.state.venues.pumpfun.liveStartCapUsd, r.liveStartCapUsd);

    // Now a live entry, then an attempt to go back to paper.
    await engine.enqueue(() => engine.onEvent(cand("MintLive", Date.now() + 1000)));
    const pos = engine.store.openPositions("pumpfun")[0];
    assert.ok(pos && pos.paper === false, "live fill opened a live position");
    assert.equal(pos.cost_usd, 5.12, "cost is what left the wallet; the fee is not added twice");
    assert.equal(pos.notional_usd, 5.12);
    const back = await engine.setVenueMode("pumpfun", "paper");
    assert.equal(back.ok, false); assert.match(back.error, /1 live position\(s\) and 0 unconfirmed buy\(s\) still open/);
    assert.equal(engine.store.venueMode("pumpfun"), "live");
  } finally { await engine.stop(); }
});

// ── live router with a scripted RPC ──
function fakeConn({ sol = 1, tokens = {}, statuses = {}, txs = {} } = {}) {
  const c = {
    sol, tokens, statuses, txs, sent: 0, statusCalls: 0, throwTokenRead: false, nextSig: "SIG1",
    async getBalance() { return Math.round(c.sol * 1e9); },
    async getParsedTokenAccountsByOwner(owner, { mint }) {
      if (c.throwTokenRead) throw new Error("429 too many requests");
      const entries = mint ? [[mint.v, c.tokens[mint.v] || 0]] : Object.entries(c.tokens);
      return { value: entries.filter(([, q]) => q > 0).map(([m, q]) => ({ account: { data: { parsed: { info: { mint: m, tokenAmount: { uiAmount: q } } } } } })) };
    },
    async getSignatureStatuses([sig]) { c.statusCalls++; const s = c.statuses[sig]; return { value: [typeof s === "function" ? s() : s ?? null] }; },
    async getTransaction(sig) { const t = c.txs[sig]; return typeof t === "function" ? t() : t ?? null; },
    async getLatestBlockhash() { return { blockhash: "x" }; },
    async sendRawTransaction() { c.sent++; return c.nextSig; },
  };
  return c;
}
function liveRouter(conn, over = {}) {
  let t = 1_000_000;
  const r = new PumpfunLiveRouter({ secret: "x", confirmTimeoutMs: 30, lateConfirmMs: 30, sleep: async () => {}, clock: () => t, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(200).buffer }), ...over });
  r.ready = true; r.publicKey = "PK"; r.keypair = { publicKey: "PK" };
  r.web3 = { PublicKey: class { constructor(v) { this.v = v; } }, VersionedTransaction: { deserialize: () => ({ sign() {}, serialize() { return new Uint8Array(1); } }) } };
  r.connection = conn;
  r.tick = ms => { t += ms; };
  return r;
}
const meta = (solDelta, tokenDelta, mint = "M", { err = null } = {}) => ({ meta: { err, preBalances: [1e9], postBalances: [1e9 + Math.round(solDelta * 1e9)], preTokenBalances: tokenDelta < 0 ? [{ mint, owner: "PK", uiTokenAmount: { uiAmount: -tokenDelta } }] : [], postTokenBalances: tokenDelta > 0 ? [{ mint, owner: "PK", uiTokenAmount: { uiAmount: tokenDelta } }] : [] } });
const confirmed = { confirmationStatus: "confirmed", err: null };
const buyOrder = (over = {}) => ({ id: "o1", decisionId: "d1", instrument: "M", stake_usd: 5, max_slippage_bps: 300, reference: { vSolInBondingCurve: 30, mcapUsd: 4500, solPrice: 200, solPriceAt: 1_000_000 - 30_000 }, ...over });

test("T10: the SOL a buy needs counts fees and rent, and the fill is read from the confirmed transaction", async () => {
  assert.ok(Math.abs(solNeededForBuy(0.025, { priorityFeeSol: 0.0005 }) - (0.025 * 1.015 + 0.0005 + 0.000005 + RENT_ATA_SOL + 0.00089088)) < 1e-12);
  assert.ok(solNeededForBuy(0.025, { hasAccount: true }) < solNeededForBuy(0.025), "an existing token account needs no rent");
  const poor = liveRouter(fakeConn({ sol: 0.0275 }));
  const p = await poor.submit(buyOrder());
  assert.equal(p.failure.code, "INSUFFICIENT_SOL"); assert.match(p.failure.reason, /order needs 0\.0324/, "15% slippage headroom, fees and rent are all counted at the 0.0003 priority fee");
  // The default priority fee is 0.0003: every 0.0001 off it is $0.02 a transaction, and a round trip pays two.
  assert.ok(Math.abs(solNeededForBuy(0.025) - solNeededForBuy(0.025, { priorityFeeSol: 0.0003 })) < 1e-12, "0.0003 is the default");
  assert.equal(poor.connection.sent, 0);

  // Confirmed: the transaction metadata gives the exact debit (stake + fees) and tokens received,
  // even though the balance reads still show the old numbers (a lagging RPC node).
  const conn = fakeConn({ sol: 0.5, statuses: { SIG1: confirmed }, txs: { SIG1: meta(-0.0285, 1200) } });
  const r = liveRouter(conn);
  const res = await r.submit(buyOrder());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.fill.qty, 1200); assert.equal(res.fill.exact, true);
  assert.equal(res.fill.notional_usd, +(0.0285 * 200).toFixed(4), "notional is the whole outflow");
  assert.ok(Math.abs(res.fill.fee_usd - (0.0285 - 0.025) * 200) < 1e-6, "fee is the part above the stake, informational");
  assert.equal(res.fill.venue_ref, "SIG1");
  assert.equal(walletDeltasFromMeta(null, { mint: "M", owner: "PK" }), null);
});

test("T10: an on-chain failure reports the burnt fee; a late confirmation is settled, not lost", async () => {
  const failed = liveRouter(fakeConn({ sol: 0.5, statuses: { SIG1: { confirmationStatus: "confirmed", err: { InstructionError: [3, { Custom: 6002 }] } } } }));
  const f = await failed.submit(buyOrder());
  assert.equal(f.failure.code, "SEND_FAILED"); assert.match(f.failure.reason, /failed on chain/);
  assert.equal(f.failure.venue_ref, "SIG1"); assert.ok(f.failure.fee_usd > 0, "priority fee and base fee were paid for nothing");

  // Never confirms inside both windows: UNCONFIRMED with the signature, nothing booked.
  const conn = fakeConn({ sol: 0.5, statuses: { SIG1: null } });
  const r = liveRouter(conn);
  const u = await r.submit(buyOrder());
  assert.equal(u.failure.code, "UNCONFIRMED"); assert.equal(u.failure.venue_ref, "SIG1");
  // Later the sweep asks: still unknown and young -> wait; landed -> a late fill; unknown and old -> expired.
  const wait = await r.resolvePending({ instrument: "M", side: "BUY", sig: "SIG1", at: 1_000_000, reference: { solPrice: 200 } });
  assert.equal(wait.failure.code, "UNCONFIRMED"); assert.equal(wait.failure.expired, false);
  conn.statuses.SIG1 = confirmed; conn.txs.SIG1 = meta(-0.0285, 1200);
  const late = await r.resolvePending({ instrument: "M", side: "BUY", sig: "SIG1", at: 1_000_000, reference: { solPrice: 200 } });
  assert.equal(late.ok, true); assert.equal(late.fill.qty, 1200); assert.equal(late.fill.late, true); assert.equal(late.fill.notional_usd, 5.7);
  conn.statuses.SIG1 = null; r.tick(100_000);
  const gone = await r.resolvePending({ instrument: "M", side: "BUY", sig: "SIG1", at: 1_000_000, reference: { solPrice: 200 } });
  assert.equal(gone.failure.code, "EXPIRED"); assert.equal(gone.failure.expired, true);
});

test("T10: sells settle from the transaction, a pending sell is never sent twice, a failed token read does not book a full close", async () => {
  // 100% close, balance reads lag: proceeds come from the transaction, not from a zero delta.
  const conn = fakeConn({ sol: 0.5, tokens: { M: 1200 }, statuses: { SIG1: confirmed }, txs: { SIG1: meta(0.03, -1200) } });
  const r = liveRouter(conn);
  const pos = { id: "p1", instrument: "M", decisionId: "d1", reference: { solPrice: 200 } };
  const full = await r.close(pos, 100, { reference: { solPrice: 200 } });
  assert.equal(full.ok, true); assert.equal(full.fill.qty, 1200); assert.equal(full.fill.notional_usd, 6); assert.equal(full.fill.exact, true);

  // Partial sell; the post-trade token read throws and the transaction is not readable yet:
  // the fill is the percentage asked for, never the whole position.
  const lag = fakeConn({ sol: 0.5, tokens: { M: 1000 }, statuses: { SIG1: confirmed }, txs: {} });
  const r2 = liveRouter(lag);
  lag.getParsedTokenAccountsByOwner = (function (orig) { let n = 0; return async function (...a) { if (++n > 1) throw new Error("429"); return orig.apply(this, a); }; })(lag.getParsedTokenAccountsByOwner);
  const part = await r2.close(pos, 80, { reference: { solPrice: 200 } });
  assert.equal(part.ok, true); assert.equal(part.fill.qty, 800, "80% of 1000, not 1000");

  // A pending sell still in flight: no new transaction is built.
  const inflight = fakeConn({ sol: 0.5, tokens: { M: 1000 }, statuses: { SIGOLD: null } });
  const r3 = liveRouter(inflight);
  const p3 = { ...pos, pendingExit: { sig: "SIGOLD", pct: 100, at: 1_000_000 } };
  const still = await r3.close(p3, 100, { reference: { solPrice: 200 } });
  assert.equal(still.failure.code, "UNCONFIRMED"); assert.equal(inflight.sent, 0, "did not sell twice");
  // The pending sell landed: the fill is read from it, with the percentage it was sent for.
  inflight.statuses.SIGOLD = confirmed; inflight.txs.SIGOLD = meta(0.028, -1000);
  const landed = await r3.close(p3, 100, { reference: { solPrice: 200 } });
  assert.equal(landed.ok, true); assert.equal(landed.fill.qty, 1000); assert.equal(landed.fill.notional_usd, 5.6); assert.equal(landed.fill.pending_pct, 100);
  assert.equal(inflight.sent, 0);
  // The pending sell expired: a fresh sell goes out.
  const expired = fakeConn({ sol: 0.5, tokens: { M: 1000 }, statuses: { SIGOLD: null, SIG1: confirmed }, txs: { SIG1: meta(0.02, -1000) } });
  const r4 = liveRouter(expired); r4.tick(100_000);
  const fresh = await r4.close(p3, 100, { reference: { solPrice: 200 } });
  assert.equal(fresh.ok, true); assert.equal(fresh.fill.venue_ref, "SIG1"); assert.equal(expired.sent, 1);

  // A stale SOL price refuses to size an order in SOL; so does one bondli never fetched.
  const stale = liveRouter(fakeConn({ sol: 0.5 }));
  const s = await stale.submit(buyOrder({ reference: { vSolInBondingCurve: 30, mcapUsd: 4500, solPrice: 200, solPriceAt: 1_000_000 - 11 * 60_000 } }));
  assert.equal(s.failure.code, "STALE_SOL_PRICE");
  const never = await stale.submit(buyOrder({ reference: { vSolInBondingCurve: 30, mcapUsd: 4500, solPrice: 200 } }));
  assert.equal(never.failure.code, "STALE_SOL_PRICE"); assert.match(never.failure.reason, /not fetched/);
  assert.equal(stale.connection.sent, 0);
});

test("T10: a wallet that holds none of a mint is checked against the chain before it is written off", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const live = new FakeLive();
  live.findRecentSale = async (mint, { since }) => (mint === "Sold" ? { sig: "SIGMANUAL", solReceived: 0.04, qty: 1000, at: since + 30_000 } : null);
  const engine = mkEngine(dir, { envelope: env, mode: "live", live });
  let now = Date.now(); engine.clock = () => now;
  const mk = (id) => ({ id, venue: "pumpfun", instrument: id, status: "open", paper: false, qty: 1000, remaining_qty: 1000, cost_usd: 5.2, notional_usd: 5.2, stake_usd: 5, proceeds_usd: 0, entryTime: now - 60_000, entryMark: 9000, tier: 2, model: "bondli_gates", plan: createPlan({ venue: "pumpfun", key: 2, entry: { score: 60 } }), reference: { solPrice: 200 } });
  engine.store.upsertPosition(mk("Sold")); engine.store.upsertPosition(mk("Rugged"));
  try {
    await engine.start({ reconcile: false });
    for (const id of ["Sold", "Rugged"]) { await engine.closePosition(engine.store.state.positions[id], 100, "SL1"); }
    now += 20_000;
    // Sold by hand: the SOL is really in the wallet, so the trade books its real proceeds.
    const rec = await engine.closePosition(engine.store.state.positions.Sold, 100, "SL1");
    assert.equal(rec.ok, true); assert.equal(rec.fill.recovered, true); assert.equal(rec.fill.notional_usd, 8);
    const o1 = engine.ledger.query({ kind: "outcome", limit: 1 })[0];
    assert.equal(o1.reason, "SL1:RECOVERED"); assert.equal(o1.pnl_usd, 2.8); assert.equal(o1.flat_at_venue, undefined);
    // Nothing on chain explains where the tokens went: still a total loss.
    const flat = await engine.closePosition(engine.store.state.positions.Rugged, 100, "SL1");
    assert.equal(flat.flat, true);
    assert.equal(engine.ledger.query({ kind: "outcome", limit: 1 })[0].pnl_usd, -5.2);
  } finally { await engine.stop(); }
});

test("T10: findRecentSale reads the mint's own account history and ignores buys and older trades", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const owner = PublicKey.unique(), mint = PublicKey.unique();
  const ata = getAssociatedTokenAddressSync(mint, owner, true).toBase58();
  const M = mint.toBase58();
  const conn = fakeConn({ txs: { SIGBUY: meta(-0.05, 1000, M), SIGSELL: meta(0.04, -1000, M), SIGOLD: meta(0.09, -1000, M) } });
  let asked = null;
  conn.getSignaturesForAddress = async (addr) => { asked = addr.toBase58(); return [{ signature: "SIGBUY", blockTime: 1_500 }, { signature: "SIGSELL", blockTime: 1_400 }, { signature: "SIGOLD", blockTime: 900 }]; };
  const r = liveRouter(conn);
  r.web3 = { PublicKey }; r.keypair = { publicKey: owner };
  const sale = await r.findRecentSale(M, { since: 1_000_000 });
  assert.equal(asked, ata, "scans the token account, not the whole wallet");
  assert.deepEqual({ sig: sale.sig, sol: sale.solReceived, qty: sale.qty }, { sig: "SIGSELL", sol: 0.04, qty: 1000 });
  // A sale from before this position was opened is not this position's exit.
  assert.equal(await r.findRecentSale(M, { since: 1_600_000 }), null);
});

test("T10: the engine finalizes a live position the wallet no longer holds, and remembers a pending sell", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const live = new FakeLive();
  const engine = mkEngine(dir, { envelope: env, mode: "live", live });
  let now = Date.now(); engine.clock = () => now;
  const mk = (id) => ({ id, venue: "pumpfun", instrument: id, status: "open", paper: false, qty: 1000, remaining_qty: 1000, cost_usd: 5.2, notional_usd: 5.2, stake_usd: 5, proceeds_usd: 0, entryTime: now - 60_000, entryMark: 9000, tier: 2, model: "bondli_gates", plan: createPlan({ venue: "pumpfun", key: 2, entry: { score: 60 } }), reference: { solPrice: 200 } });
  engine.store.upsertPosition(mk("Gone")); engine.store.upsertPosition(mk("Slow"));
  try {
    await engine.start({ reconcile: false });
    // One empty wallet read is a failed exit, not a loss; a second one a retry interval later is.
    const first = await engine.closePosition(engine.store.state.positions.Gone, 100, "SL1");
    assert.equal(first.ok, false); assert.equal(engine.store.state.positions.Gone.status, "open");
    now += 5_000;
    const soon = await engine.closePosition(engine.store.state.positions.Gone, 100, "SL1");
    assert.equal(soon.ok, false, "5s later: still not proof");
    now += 15_000;
    const r = await engine.closePosition(engine.store.state.positions.Gone, 100, "SL1");
    assert.equal(r.ok, true); assert.equal(r.flat, true);
    assert.equal(engine.store.state.positions.Gone.status, "closed");
    const outcome = engine.ledger.query({ kind: "outcome", limit: 1 })[0];
    assert.equal(outcome.reason, "SL1:FLAT_AT_VENUE"); assert.equal(outcome.pnl_usd, -5.2); assert.equal(outcome.flat_at_venue, true);
    assert.equal(engine.store.state.day.realizedUsd, -5.2, "real money lost counts against the daily limit");

    live.closeImpl = () => failure({ id: "Slow" }, "UNCONFIRMED", "tx SIGSELL not confirmed", { venue_ref: "SIGSELL" });
    const u = await engine.closePosition(engine.store.state.positions.Slow, 100, "TP2");
    assert.equal(u.ok, false);
    assert.equal(engine.store.state.positions.Slow.status, "open");
    assert.deepEqual({ sig: engine.store.state.positions.Slow.pendingExit.sig, pct: engine.store.state.positions.Slow.pendingExit.pct }, { sig: "SIGSELL", pct: 100 });
    // The same signature reported again keeps its original send time and percentage, so the
    // blockhash lifetime can actually run out and a dropped sell gets resent.
    const at0 = engine.store.state.positions.Slow.pendingExit.at;
    now += 30_000;
    await engine.closePosition(engine.store.state.positions.Slow, 50, "STOP");
    assert.equal(engine.store.state.positions.Slow.pendingExit.at, at0); assert.equal(engine.store.state.positions.Slow.pendingExit.pct, 100);
    // The next attempt returns the settled fill for the pending sell; the position closes with it.
    live.closeImpl = (p) => ({ ok: true, fill: { price: 0.006, qty: 1000, notional_usd: 6, fee_usd: 0, t_filled: now, latency_ms: 0, venue_ref: p.pendingExit.sig, pending_pct: p.pendingExit.pct } });
    const done = await engine.closePosition(engine.store.state.positions.Slow, 50, "TP3");
    assert.equal(done.ok, true);
    assert.equal(engine.store.state.positions.Slow.status, "closed", "closed at the pending sell's 100%, not the later 50%");
    assert.equal(engine.store.state.positions.Slow.pendingExit, undefined);
    assert.equal(engine.ledger.query({ kind: "outcome", limit: 1 })[0].pnl_usd, +(6 - 5.2).toFixed(4));
  } finally { await engine.stop(); }
});

test("T10: no ticks is not no exit: the time stop fires on a quiet position and a flatten is retried", async () => {
  // Pure: a tick with no price still yields MAX_HOLD once the hold is over.
  const plan = createPlan({ venue: "pumpfun", key: 2, entry: { score: 60 } });
  const pos = { id: "x", venue: "pumpfun", instrument: "M", entryTime: 1000, entryMark: 9000, entryScore: 60, plan };
  const dead = evaluateExit(pos, { t_observed: 1000 + plan.max_hold_ms + 1000, payload: { mcapUsd: 0 } }, { now: 1000 + plan.max_hold_ms + 1000 });
  assert.equal(dead?.reason, "MAX_HOLD");
  assert.equal(evaluateExit({ ...pos, plan }, { t_observed: 2000, payload: { mcapUsd: 0 } }, { now: 2000 }), null, "before the hold ends a priceless tick means hold");

  const dir = tmp(); const env = smallEnvelope(dir);
  let now = Date.now();
  const engine = mkEngine(dir, { envelope: env, mode: "paper", config: { reentryCooldownMs: 0, sweepRetryMs: 0 } });
  engine.clock = () => now;
  try {
    await engine.start({ reconcile: false });
    await engine.enqueue(() => engine.onEvent(cand("MintQuiet", now)));
    const p = engine.store.openPositions("pumpfun")[0];
    assert.ok(p, "paper position opened");
    // Not one trade since the fill. That is the strongest form of "nobody followed us in", and the
    // tick-side DOA test can never see it, because a token nobody trades produces no ticks.
    now += 5_000; await engine.sweep();
    assert.equal(engine.store.openPositions("pumpfun").length, 1, "5s: too young to call");
    now += p.plan.doa_ms; await engine.sweep();
    assert.equal(engine.store.openPositions("pumpfun").length, 0, "silent past doa_ms: out in seconds, not minutes");
    assert.equal(engine.ledger.query({ kind: "outcome", limit: 1 })[0].reason, "DOA");
    assert.equal(engine.ledger.query({ kind: "exit", limit: 1 })[0].by, "timer");
    // And it is a "not yet", not a verdict: the mint may be bought again in 45s, not 5 minutes.
    assert.equal(engine.cooldown.get("MintQuiet") - now, engine.cfg.retryCooldownMs);

    // A position that ran far enough to arm the trail is the trail's, not the stall's: a quiet feed
    // is not a reason to give it up, so it waits for max hold.
    const q = { ...p, id: "ran", instrument: "MintRan", status: "open", entryTime: now, peak: p.entryMark * 1.5, remaining_qty: p.qty };
    engine.store.upsertPosition(q);
    now += q.plan.stall_ms + 60_000; await engine.sweep();
    assert.equal(engine.store.openPositions("pumpfun").length, 1, "armed: neither DOA nor the stall takes a position that ran");
    now += q.plan.max_hold_ms; await engine.sweep();
    assert.equal(engine.ledger.query({ kind: "exit", limit: 1 })[0].reason, "MAX_HOLD", "past max hold it goes, armed or not");
    engine.store.closePosition("ran", { exitReason: "MAX_HOLD", pnl_usd: 0, remaining_qty: 0 }); // the paper book never held it

    // Flatten that fails once is retried by the sweep until it succeeds.
    // The gates judge freshness from the event's own timestamps; the engine clock is 20 minutes ahead by now.
    await engine.enqueue(() => engine.onEvent(cand("MintStuck", Date.now())));
    const router = engine.venues.pumpfun.router;
    const realClose = router.close.bind(router);
    let fails = 1;
    router.close = async (...a) => (fails-- > 0 ? failure({ id: "s" }, "SEND_FAILED", "builder 502") : realClose(...a));
    const h = await engine.halt("flatten", "test");
    assert.equal(h.failed.length, 1); assert.equal(engine.store.openPositions().length, 1);
    now += 20_000; await engine.sweep();
    assert.equal(engine.store.openPositions().length, 0, "the sweep flattened what the halt could not");
    assert.equal(engine.ledger.query({ kind: "exit", limit: 1 })[0].by, "retry");
  } finally { await engine.stop(); }
});

test("T10: reconcile leaves unknown tokens alone, books a missing live position, and a failed send cools the instrument down", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const live = new FakeLive({ wallet: { AirdropSpam: 5_000_000, MintOurs: 1000 } });
  const engine = mkEngine(dir, { envelope: env, mode: "live", live, config: { reentryCooldownMs: 0 } });
  engine.store.upsertPosition({ id: "pumpfun:MintOurs:1", venue: "pumpfun", instrument: "MintOurs", status: "open", paper: false, qty: 1000, remaining_qty: 1000, cost_usd: 5, notional_usd: 5, stake_usd: 5, proceeds_usd: 0, entryTime: Date.now(), entryMark: 9000, plan: createPlan({ venue: "pumpfun", key: 2, entry: { score: 60 } }) });
  engine.store.upsertPosition({ id: "pumpfun:MintSold:1", venue: "pumpfun", instrument: "MintSold", status: "open", paper: false, qty: 1000, remaining_qty: 1000, cost_usd: 2, notional_usd: 2, stake_usd: 2, proceeds_usd: 0, entryTime: Date.now(), entryMark: 9000, plan: createPlan({ venue: "pumpfun", key: 2, entry: { score: 60 } }) });
  try {
    await engine.start();
    const rep = engine.ledger.query({ kind: "reconcile", limit: 1 })[0].report.venues.pumpfun;
    assert.deepEqual(rep.matched, ["MintOurs"]);
    assert.deepEqual(rep.adopted, [], "an airdrop the engine never bought is not a position");
    assert.deepEqual(rep.unknown.map(u => u.instrument), ["AirdropSpam"]);
    assert.deepEqual(rep.closed, ["MintSold"]);
    assert.equal(engine.store.state.positions["pumpfun:MintSold:1"].pnl_usd, -2, "real tokens gone without a sale record: cost lost until proven otherwise");
    assert.equal(engine.store.state.day.realizedUsd, -2);
    assert.equal(engine.ledger.query({ kind: "exit", limit: 1 })[0].final, true);

    // A send that fails on chain charges its fee and is not retried on the next poll.
    live.submitImpl = () => failure({ id: "o" }, "SEND_FAILED", "tx SIGX failed on chain", { venue_ref: "SIGX", fee_usd: 0.1 });
    const t = Date.now();
    await engine.enqueue(() => engine.onEvent(cand("MintFail", t)));
    assert.equal(engine.ledger.query({ kind: "order", limit: 1 })[0].code, "SEND_FAILED");
    assert.equal(engine.ledger.query({ kind: "fee", limit: 1 })[0].usd, 0.1);
    assert.equal(engine.store.state.day.realizedUsd, -2.1);
    await engine.enqueue(() => engine.onEvent(cand("MintFail", t + 5_000)));
    assert.equal(engine.ledger.query({ kind: "order", limit: 1 })[0].reason, "REENTRY_COOLDOWN");
    assert.equal(live.calls.filter(c => c === "submit:MintFail").length, 1);
    // An unconfirmed send is settled by the sweep once the venue can prove it landed.
    live.submitImpl = () => failure({ id: "o" }, "UNCONFIRMED", "tx SIGLATE not confirmed", { venue_ref: "SIGLATE" });
    await engine.enqueue(() => engine.onEvent(cand("MintLate", t + 10_000)));
    assert.ok(engine.pendingBuys.has("MintLate"));
    live.resolvePending = async ({ sig }) => ({ ok: true, fill: { instrument: "MintLate", side: "BUY", price: 0.005, qty: 1100, notional_usd: 5.5, fee_usd: 0, t_sent: t, t_filled: t + 30_000, latency_ms: 30_000, venue_ref: sig, late: true } });
    await engine.sweep();
    assert.ok(!engine.pendingBuys.has("MintLate"));
    const late = engine.store.openPositions("pumpfun").find(p => p.instrument === "MintLate");
    assert.ok(late, "the late buy became a position with a plan"); assert.equal(late.cost_usd, 5.5); assert.ok(late.plan);
  } finally { await engine.stop(); }
});

test("T10: a partial venue entry in velocity.config.json keeps the documented defaults", () => {
  const dir = tmp(); smallEnvelope(dir);
  const { cfg } = buildEngine({ dataDir: dir, riskFile: path.join(dir, "risk.json"), venues: { pumpfun: { mode: "paper" }, polymarket: { mode: "off" } } });
  assert.equal(cfg.venues.pumpfun.minScore, DEFAULT_CONFIG.venues.pumpfun.minScore);
  assert.equal(cfg.venues.pumpfun.bondliUrl, DEFAULT_CONFIG.venues.pumpfun.bondliUrl);
  assert.equal(cfg.venues.polymarket.mode, "off");
});

test("T10: a signature survives an RPC that drops the reply; a zero read is re-read; a sale with no visible proceeds is not booked at zero", async () => {
  const fakeTx = () => ({ sign() {}, serialize() { return new Uint8Array(1); }, signatures: [new Uint8Array(64)] });
  // sendRawTransaction throws after the RPC may have forwarded it: the locally known signature is kept.
  const dropped = fakeConn({ sol: 0.5 });
  dropped.sendRawTransaction = async () => { throw new Error("socket hang up"); };
  const r1 = liveRouter(dropped); r1.web3.VersionedTransaction.deserialize = fakeTx; r1.bs58 = { encode: () => "LOCALSIG" };
  const a = await r1.submit(buyOrder());
  assert.equal(a.failure.code, "UNCONFIRMED"); assert.equal(a.failure.venue_ref, "LOCALSIG");
  // getSignatureStatuses throws after the send: same.
  const flaky = fakeConn({ sol: 0.5 });
  flaky.getSignatureStatuses = async () => { throw new Error("429"); };
  const r2 = liveRouter(flaky); r2.web3.VersionedTransaction.deserialize = fakeTx; r2.bs58 = { encode: () => "LOCALSIG" };
  const b = await r2.submit(buyOrder());
  assert.equal(b.failure.code, "UNCONFIRMED"); assert.equal(b.failure.venue_ref, "SIG1", "the RPC's signature once it answered the send");
  // Without bs58 (never initialized) a thrown send is still an honest SEND_FAILED.
  const r3 = liveRouter(dropped); r3.web3.VersionedTransaction.deserialize = fakeTx;
  assert.equal((await r3.submit(buyOrder())).failure.code, "SEND_FAILED");

  // A token balance that reads 0 once and 1000 next is a position, not NO_POSITION.
  const lag = fakeConn({ sol: 0.5, tokens: { M: 1000 }, statuses: { SIG1: confirmed }, txs: { SIG1: meta(0.03, -1000) } });
  let reads = 0; const orig = lag.getParsedTokenAccountsByOwner.bind(lag);
  lag.getParsedTokenAccountsByOwner = async (...args) => (++reads === 1 ? { value: [] } : orig(...args));
  const r4 = liveRouter(lag);
  const sold = await r4.close({ id: "p", instrument: "M", decisionId: "d", reference: { solPrice: 200 } }, 100, { reference: { solPrice: 200 } });
  assert.equal(sold.ok, true); assert.equal(sold.fill.notional_usd, 6);

  // Tokens gone, SOL not visible, transaction not readable: UNCONFIRMED, never a $0 sale.
  // A real position, not dust: at 1,000 tokens the curve pays $0.009 and the send costs more than that,
  // so the honest estimate would be zero and the test would be measuring rounding, not the code path.
  const half = fakeConn({ sol: 0.5, tokens: { M: 200_000 }, statuses: { SIG1: confirmed }, txs: {} });
  const r5 = liveRouter(half);
  half.sendRawTransaction = async () => { half.tokens.M = 0; return "SIG1"; };
  const z = await r5.close({ id: "p", instrument: "M", decisionId: "d", reference: { solPrice: 200 } }, 100, { reference: { solPrice: 200 } });
  assert.equal(z.failure.code, "UNCONFIRMED"); assert.equal(z.failure.venue_ref, "SIG1");
  // Later, still unreadable but long confirmed: the curve model's estimate is booked, flagged.
  r5.tick(100_000);
  const est = await r5.resolvePending({ instrument: "M", side: "SELL", sig: "SIG1", at: 1_000_000, reference: { solPrice: 200, mcapUsd: 9000, vSolInBondingCurve: 30 }, qtyHint: 200_000 });
  assert.equal(est.ok, true); assert.equal(est.fill.estimated, true); assert.ok(est.fill.notional_usd > 0);
});

test("T10: a throttled bot at the minimum order trades fewer positions, not none; a failed startup freeze lifts on a good restart; stopping opens no new risk", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const sizer = new Sizer(env);
  const d = { venue: "pumpfun", p_win: 0.45, payoff: 3, stop_fraction: 1 };
  const pos = n => Array.from({ length: n }, () => ({ venue: "pumpfun", notional_usd: 5, worst_case_fraction: 1 }));
  const at = (throttle, open = 0) => sizer.size({ decision: d, portfolio: { open: pos(open), realized_today_usd: 0 }, throttle });
  assert.equal(env.max_concurrent_positions, 4);
  assert.equal(at(1).stake_usd, 5);
  const halved = at(0.5);
  assert.equal(halved.stake_usd, 5, "half of a minimum order does not exist: the minimum trades");
  assert.ok(halved.caps.includes("MIN_STAKE_FLOOR"));

  // Size cannot go below one order, so the throttle is honoured in the NUMBER of orders instead.
  // A quarter throttle holds one slot of four: the same quarter of the exposure, and -- unlike
  // refusing outright -- the bot keeps producing the outcomes that would let the throttle lift.
  assert.equal(at(0.25, 0).stake_usd, 5, "a quarter-throttled bot still opens its first position");
  assert.match(at(0.25, 1).reasons[0], /THROTTLED_TO_1_OF_4_SLOTS/);
  assert.equal(at(0.25, 1).stake_usd, 0);
  assert.equal(at(0.5, 1).stake_usd, 5, "half throttle holds two of the four");
  assert.match(at(0.5, 2).reasons[0], /THROTTLED_TO_2_OF_4_SLOTS/);
  assert.equal(at(1, 2).stake_usd, 5, "unthrottled, the envelope's own cap is the only limit");

  const first = mkEngine(dir, { envelope: env, mode: "paper", live: new FakeLive({ failInit: true }) });
  first.store.setVenueMode("pumpfun", "live");
  try { await first.start(); assert.equal(first.store.isHalted("pumpfun")?.mode, "freeze"); } finally { await first.stop(); }
  const second = mkEngine(dir, { envelope: env, mode: "paper", live: new FakeLive() });
  try {
    await second.start();
    assert.equal(second.store.isHalted("pumpfun"), null, "the startup freeze is gone once the router initializes");
    assert.equal(second.ledger.query({ kind: "resume", limit: 1 })[0].by, "restart");
    // Leaving live with an unconfirmed buy outstanding is refused.
    second.pendingBuys.set("MintLate", { venue: "pumpfun", sig: "S", decision: { instrument: "MintLate", reference: {} }, orderId: "o", stake: 5, sizing: {}, at: Date.now() });
    const back = await second.setVenueMode("pumpfun", "paper");
    assert.equal(back.ok, false); assert.match(back.error, /1 unconfirmed buy/);
    second.pendingBuys.clear();
  } finally { await second.stop(); }

  // A candidate queued behind a slow order when stop() is called opens nothing.
  const third = mkEngine(dir, { envelope: env, mode: "paper", config: { reentryCooldownMs: 0 } });
  third.store.setVenueMode("pumpfun", "paper");
  await third.start({ reconcile: false });
  let release; const gate = new Promise(r => { release = r; }); third.enqueue(() => gate);
  const queued = third.enqueue(() => third.onEvent(cand("MintStop")));
  const stopped = third.stop();
  release(); await queued; await stopped;
  assert.equal(third.store.openPositions().length, 0, "no entry after stop()");
});

test("T10: a tick-less paper sell is priced at the last mark, not the entry", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  let now = Date.now();
  const engine = mkEngine(dir, { envelope: env, mode: "paper", config: { reentryCooldownMs: 0, sweepRetryMs: 0 } });
  engine.clock = () => now;
  try {
    await engine.start({ reconcile: false });
    await engine.enqueue(() => engine.onEvent(cand("MintFade", now)));
    const p = engine.store.openPositions("pumpfun")[0];
    assert.ok(p);
    // One tick 40% down that trips no plan rule of its own (the fixture's plan stop is wider on a
    // stable trend), then silence.
    await engine.enqueue(() => engine.onEvent(makeEvent({ venue: "pumpfun", kind: "tick", id: "MintFade", t_venue: now + 400, t_observed: now + 500, payload: tickPayload("MintFade", 10_800) })));
    if (engine.store.openPositions("pumpfun").length === 0) return; // the plan sold on the tick: nothing left to test here
    now += p.plan.max_hold_ms + 60_000; await engine.sweep();
    assert.equal(engine.store.openPositions("pumpfun").length, 0);
    const out = engine.ledger.query({ kind: "outcome", limit: 1 })[0];
    assert.equal(out.reason, "MAX_HOLD");
    assert.ok(out.pnl_pct < -30, `booked at the last mark (-40%), got ${out.pnl_pct}%`);
  } finally { await engine.stop(); }
});

test("T10: with bankroll_source wallet the live wallet is the bankroll; no reading means no order", async () => {
  const dir = tmp(); const env = smallEnvelope(dir, { bankroll_source: "wallet", wallet_reserve_sol: 0.02 });
  assert.equal(env.bankroll_source, "wallet");
  // Sizer: a measured equity replaces bankroll + realized; null equity sizes nothing.
  const sizer = new Sizer(env);
  const d = { venue: "pumpfun", p_win: 0.45, payoff: 3, stop_fraction: 1 };
  const w = sizer.size({ decision: d, portfolio: { open: [], realized_today_usd: -5, equity_usd: 120 } });
  assert.equal(w.stake_usd, 8, "0.2667 x 0.25 x $120 = $8, realized is not subtracted twice (the wallet already fell by it)");
  assert.match(w.reasons[0], /\(wallet\)/);
  const unknown = sizer.size({ decision: d, portfolio: { open: [], realized_today_usd: 0, equity_usd: null, equity_reason: "WALLET_UNKNOWN" } });
  assert.equal(unknown.stake_usd, 0); assert.equal(unknown.reasons[0], "WALLET_UNKNOWN");
  const fixed = sizer.size({ decision: d, portfolio: { open: [], realized_today_usd: 0 } });
  assert.equal(fixed.stake_usd, 5, "a snapshot without equity_usd (paper) uses the fixed bankroll");

  // Engine: the go-live preflight and every live fill refresh the reading; the snapshot carries it.
  const live = new FakeLive({ balanceSol: 0.1495 });
  const engine = mkEngine(dir, { envelope: env, mode: "paper", live, config: { reentryCooldownMs: 0 } });
  let now = Date.now(); engine.clock = () => now;
  try {
    await engine.start({ reconcile: false });
    assert.equal(engine.portfolioSnapshot().equity_usd, undefined, "paper venue: fixed bankroll");
    engine.solPriceHint = 200;
    const r = await engine.setVenueMode("pumpfun", "live", { override: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const snap = engine.portfolioSnapshot();
    assert.equal(snap.equity_usd, +((0.1495 - 0.02) * 200).toFixed(2), "free SOL at the current price");
    assert.equal(engine.status().bankroll.source, "wallet");
    assert.equal(engine.status().bankroll.wallet.sol, 0.1495);
    // A live buy: equity is free SOL plus what is open, and the wallet is re-read after the fill.
    const before = live.calls.filter(c => c === "preflight").length;
    await engine.enqueue(() => engine.onEvent(cand("MintW", now)));
    const pos = engine.store.openPositions("pumpfun")[0];
    assert.ok(pos && !pos.paper, "live position opened from the wallet bankroll");
    assert.equal(pos.stake_usd, 5, "Kelly on $25.9 is $1.73, floored to the $5 minimum");
    assert.ok(live.calls.filter(c => c === "preflight").length > before, "wallet re-read after the fill");
    const withOpen = engine.portfolioSnapshot();
    // The candidate carried the feed's SOL price (150), which is fresher than the 200 seeded above.
    assert.equal(withOpen.equity_usd, +(((0.1495 - 0.02) * 150) + pos.notional_usd).toFixed(2));
    // Stale reading: nothing is sized, and the sweep refreshes it.
    now += 6 * 60_000;
    assert.equal(engine.portfolioSnapshot().equity_reason, "WALLET_UNKNOWN");
    await engine.sweep();
    assert.equal(engine.portfolioSnapshot().equity_reason, undefined, "the sweep re-read the wallet");
    assert.ok(engine.portfolioSnapshot().equity_usd > 0);
  } finally { await engine.stop(); }
});

test("T10: the wallet's own balance change is read by account key, not by a fixed index", async () => {
  const { walletDelta } = await import("../../tools/tx-audit.mjs");
  const key = v => ({ toBase58: () => v });
  // A transaction where our wallet pays: it is the fee payer, so it sits at index 0.
  const payer = {
    transaction: { message: { getAccountKeys: () => ({ keySegments: () => [[key("ME"), key("CURVE"), key("SYS")]] }) } },
    meta: { fee: 5_000, err: null, preBalances: [100_000_000, 5_000, 1], postBalances: [70_000_000, 35_000, 1],
      preTokenBalances: [], postTokenBalances: [{ owner: "ME", mint: "M", uiTokenAmount: { uiAmount: 1200 } }] },
  };
  const a = walletDelta(payer, { owner: "ME", mint: "M" });
  assert.equal(a.index, 0); assert.equal(a.indexZeroIsWallet, true);
  assert.equal(a.solDelta, -0.03); assert.equal(a.tokenDelta, 1200); assert.equal(a.feeSol, 0.000005);

  // The same read when our wallet is NOT first: index 0 would report someone else's balance.
  const notFirst = {
    transaction: { message: { getAccountKeys: () => ({ keySegments: () => [[key("OTHER"), key("ME")]] }) } },
    meta: { fee: 5_000, err: null, preBalances: [9_000_000_000, 100_000_000], postBalances: [8_000_000_000, 130_000_000],
      preTokenBalances: [{ owner: "ME", mint: "M", uiTokenAmount: { uiAmount: 1200 } }], postTokenBalances: [] },
  };
  const b = walletDelta(notFirst, { owner: "ME", mint: "M" });
  assert.equal(b.index, 1); assert.equal(b.indexZeroIsWallet, false);
  assert.equal(b.solDelta, 0.03, "our wallet received 0.03 SOL");
  assert.equal(b.solDeltaAtIndexZero, -1, "index 0 would have claimed a whole SOL left the wallet");
  assert.equal(b.tokenDelta, -1200, "a 100% sell that closes the token account still shows the full outflow");

  // Balances that only mention other owners contribute nothing, and a failed tx is reported as failed.
  const foreign = { transaction: { message: { getAccountKeys: () => ({ keySegments: () => [[key("ME")]] }) } },
    meta: { fee: 5_000, err: { InstructionError: [3, { Custom: 6002 }] }, preBalances: [1_000_000], postBalances: [995_000],
      preTokenBalances: [{ owner: "SOMEONE", mint: "M", uiTokenAmount: { uiAmount: 500 } }], postTokenBalances: [] } };
  const c = walletDelta(foreign, { owner: "ME", mint: "M" });
  assert.equal(c.tokenDelta, 0); assert.ok(c.err); assert.equal(c.solDelta, -0.000005, "a failed transaction still paid its fee");
  assert.equal(walletDelta(null, { owner: "ME" }), null);
});

test("T10: velocity watch narrates the ledger one line per event and follows appends", async () => {
  const { formatRecord, followLedger } = await import("../../src/velocity/core/watch.mjs");
  assert.match(formatRecord({ kind: "decision", ts: 0, action: "REJECT", instrument: "MintAAAAAAAA", gate: "disqualifiers", reasons: ["QUICK_FLIP", "LIQ_REMOVAL"], features: { apeScore: 0.42 } }), /reject  MintAAAAAA disqualifiers: QUICK_FLIP, LIQ_REMOVAL score 42/);
  assert.match(formatRecord({ kind: "decision", ts: 0, action: "GO", instrument: "M", tier: 2, p_win: 0.35 }), /^..:..:.. GO      M tier 2 p_win 0.35/);
  assert.match(formatRecord({ kind: "order", stage: "sized", stake_usd: 5, sizing: { caps: ["MIN_STAKE_FLOOR"] } }), /sized   \$5.00 \(MIN_STAKE_FLOOR\)/);
  assert.match(formatRecord({ kind: "order", stage: "sized", stake_usd: 0, sizing: { reasons: ["WALLET_UNKNOWN"] } }), /no size WALLET_UNKNOWN/);
  assert.match(formatRecord({ kind: "fill", instrument: "M", notional_usd: 5.49, qty: 642871.5, slippage_bps: 9.9, venue_ref: "5KtSvwUuDwoT" }), /FILLED  BUY M \$5.49 qty 642872 slip 10bps tx 5KtSvwUuDw/);
  assert.match(formatRecord({ kind: "exit", instrument: "M", pct: 100, reason: "crash-exit", detail: "v=-0.35", proceeds_usd: 5.57, final: true }), /SOLD    100% M crash-exit \(v=-0.35\) -> \$5.57$/);
  assert.match(formatRecord({ kind: "outcome", instrument: "M", pnl_usd: -0.4617, pnl_pct: -12.58, held_ms: 1572, reason: "crash-exit" }), /P&L     M -\$0.46 \(-12.6%\) held 2s crash-exit/);
  assert.match(formatRecord({ kind: "fee", usd: 0.05, note: "failed send X" }), /fee     -\$0.05 failed send X/);
  assert.equal(formatRecord({ kind: "heartbeat" }), null);
  // Following: only what is appended after the watch starts, unless --all.
  const dir = tmp(); const file = path.join(dir, "ledger.jsonl");
  fs.writeFileSync(file, JSON.stringify({ kind: "halt", mode: "freeze", reason: "old", by: "test" }) + "\n");
  const seen = [];
  const stop = followLedger(file, l => seen.push(l), { pollMs: 20 });
  fs.appendFileSync(file, JSON.stringify({ kind: "outcome", instrument: "N", pnl_usd: 1, pnl_pct: 20, held_ms: 3000, reason: "TP2" }) + "\n" + '{"kind":"heartbeat"}\n');
  await new Promise(r => setTimeout(r, 120));
  stop();
  assert.equal(seen.length, 1, "the old halt was before the watch; the heartbeat is noise");
  assert.match(seen[0], /P&L     N \$1.00 \(20.0%\) held 3s TP2/);
});

test("T10: the risk dial moves gates 1, 2 and 3 together; the designed rules are the default", async () => {
  const { AGGRESSION, makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { checkViability } = await import("../../src/autoape/gates/viability.js");
  const { checkExecutionWindow } = await import("../../src/autoape/gates/execution-window.js");
  const { classifyConfidence } = await import("../../src/autoape/gates/confidence.js");
  const now = Date.now();
  const token = { ca: "M", createdAt: now - 3 * 60000, buys: 20, sells: 6, uniqueBuyers: { size: 12 }, mcapUsd: 9000, volumeSol: 8, vSolInBondingCurve: 85, spark: [5000, 6000, 7000, 8000, 8500, 9000], _apeScore: 40 };
  const qf = { _rg_sybilScore: 0.45, _rg_freshWalletRatio: 0.5, ch_healthScore: 0.6 };
  const dyn = { scores: 4, velocity: 0.1, acceleration: 0.01, trend: "rising" };
  // Score 40 with sybil 0.45: refused as designed, admitted at aggression 2.
  assert.deepEqual(checkViability(token, qf, { apeScore: 40 }, dyn, AGGRESSION[1]).checks, ["SCORE_BELOW_FLOOR", "HIGH_SYBIL_RISK"]);
  assert.equal(checkViability(token, qf, { apeScore: 40 }, dyn, AGGRESSION[2]).pass, true);
  assert.equal(checkViability(token, qf, { apeScore: 40 }, dyn).pass, false, "no opts means the designed floors");
  // vSol 85 is 65% along -- (85 - 30) / 85, the virtual reserve subtracted -- so it is too advanced
  // for tier 2 as designed and inside the window at aggression 2.
  assert.ok(checkExecutionWindow(token, 2, now, AGGRESSION[1]).checks.includes("CURVE_TOO_ADVANCED"));
  assert.ok(!checkExecutionWindow(token, 2, now, AGGRESSION[2]).checks.includes("CURVE_TOO_ADVANCED"));
  assert.ok(checkExecutionWindow(token, 2, now, AGGRESSION[3]).pass, "degen takes it up to 80%");
  // Score 44 with a rising trend: watchlist as designed, a SPECULATIVE entry at aggression 2.
  assert.equal(classifyConfidence(token, qf, { apeScore: 44 }, dyn, AGGRESSION[1]).tier, 4);
  assert.equal(classifyConfidence(token, qf, { apeScore: 44 }, dyn, AGGRESSION[2]).tier, 3);
  // The edge wires the profile through; an out-of-range value clamps.
  assert.equal(makePumpfunEdge({ aggression: 2 }).gateOpts, AGGRESSION[2]);
  assert.equal(makePumpfunEdge({ aggression: 9 }).gateOpts, AGGRESSION[3]);
  assert.equal(makePumpfunEdge().gateOpts, AGGRESSION[1]);
  // Gate 1: the four rules gate-stats found binding loosen with the dial; the designed rule is the default.
  const { checkDisqualifiers } = await import("../../src/autoape/gates/disqualifiers.js");
  const stale = { ...token, createdAt: now - 20 * 60000, uniqueBuyers: { size: 12 } };
  assert.ok(checkDisqualifiers(stale, {}).flags.includes("STALE"), "20 min old is stale as designed");
  assert.ok(checkDisqualifiers(stale, {}, AGGRESSION[1]).flags.includes("STALE"));
  assert.ok(!checkDisqualifiers(stale, {}, AGGRESSION[2]).flags.includes("STALE"), "normal allows 30 min");
  const dump = { rg_coordDumpScore: 0.6, rg_sellWaveDetect: 0.6 };
  const dumping = { ...token, sells: 15, uniqueBuyers: { size: 12 } };
  assert.ok(checkDisqualifiers(dumping, dump).flags.includes("COORDINATED_DUMP"));
  assert.ok(!checkDisqualifiers(dumping, dump, AGGRESSION[2]).flags.includes("COORDINATED_DUMP"), "a 0.6 burst is not a dump on normal");
  assert.ok(checkDisqualifiers(dumping, { rg_coordDumpScore: 0.9, rg_sellWaveDetect: 0.9 }, AGGRESSION[3]).flags.includes("COORDINATED_DUMP"), "a 0.9 burst is a dump even on degen");
  const late = { ...token, vSolInBondingCurve: 30 + 85 * 0.85, uniqueBuyers: { size: 12 } }; // 85% along: the reserve starts at 30
  assert.ok(checkDisqualifiers(late, {}).flags.includes("TOO_LATE"));
  assert.ok(!checkDisqualifiers(late, {}, AGGRESSION[2]).flags.includes("TOO_LATE"));
  // Gate 2: 4 buyers at 3 minutes is dead on arrival as designed, alive on normal; no dynamics is only fine on degen.
  const quiet = { ...token, uniqueBuyers: { size: 4 } };
  assert.ok(checkViability(quiet, {}, { apeScore: 60 }, dyn).checks.includes("DEAD_ON_ARRIVAL"));
  assert.ok(!checkViability(quiet, {}, { apeScore: 60 }, dyn, AGGRESSION[2]).checks.includes("DEAD_ON_ARRIVAL"));
  assert.ok(checkViability(token, {}, { apeScore: 60 }, null, AGGRESSION[2]).checks.includes("INSUFFICIENT_DATA"));
  assert.ok(!checkViability(token, {}, { apeScore: 60 }, null, AGGRESSION[3]).checks.includes("INSUFFICIENT_DATA"));
  // Gate 3: a watchlist token becomes a speculative entry on normal and degen, never on careful.
  const edge1 = makePumpfunEdge({ aggression: 1 }), edge2 = makePumpfunEdge({ aggression: 2 });
  const conf1 = edge1.gates.find(g => g.name === "confidence"), conf2 = edge2.gates.find(g => g.name === "confidence");
  const wl = { token: { ...token, _apeScore: 41 }, qf: { _rg_sybilScore: 0.1 }, scores: { apeScore: 41 }, dynamics: { scores: 4, velocity: 0, acceleration: 0, trend: "flat" } };
  const r1 = conf1.check({ ...wl }); assert.equal(r1.pass, false); assert.ok(r1.reasons.includes("WATCHLIST"));
  const c2 = { ...wl }; const r2 = conf2.check(c2); assert.equal(r2.pass, true); assert.equal(c2.tier, 3); assert.equal(c2.tierLabel, "WATCHLIST_AS_SPEC");
});

test("T10: a revival candidate is its own model: tier-3 layers with a tighter stop, a 6-minute hold, half the stake", async () => {
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { createPlan } = await import("../../src/velocity/core/exits.mjs");
  const { Sizer } = await import("../../src/velocity/core/risk.mjs");
  const edge = makePumpfunEdge({ aggression: 1 });
  const p = goodCandidatePayload("MintOld");
  p.token.createdAt = Date.now() - 5 * 3600_000; // five hours old: STALE for the launch judge
  p.token._revival = { buyers5m: 9, baseline5m: 1.2, netSol5m: 2.1, curveDelta: 7 };
  const [c] = edge.ingest({ kind: "candidate", payload: p });
  assert.equal(c.model, "bondli_revival");
  for (const g of edge.gates) { const r = g.check(c); assert.equal(r.pass, true, `${g.name}: ${JSON.stringify(r.reasons)}`); }
  assert.equal(c.tier, 3); assert.equal(c.tierLabel, "REVIVAL");
  const est = edge.estimate(c, {});
  assert.equal(est.plan_key, "revival"); assert.equal(est.stake_cap_fraction, 0.5);
  // the same token without the revival mark is stale for the launch judge
  const plain = goodCandidatePayload("MintOld2"); plain.token.createdAt = Date.now() - 5 * 3600_000;
  const [c2] = edge.ingest({ kind: "candidate", payload: plain });
  assert.equal(c2.model, "bondli_gates");
  assert.ok(edge.gates[0].check(c2).reasons.includes("STALE"));
  // the plan: tier-3 layers, 8% stop instead of 10, six minutes
  const plan = createPlan({ venue: "pumpfun", key: "revival", entry: { score: 60 } });
  assert.equal(plan.bondli.stopLoss, 8); assert.equal(plan.bondli.tier, 3); assert.equal(plan.max_hold_ms, 6 * 60_000); assert.equal(plan.bondli.maxHoldMs, 6 * 60_000);
  assert.equal(createPlan({ venue: "pumpfun", key: 3, entry: { score: 60 } }).bondli.stopLoss, 10);
  // the sizer honours the model's cap
  const sizer = new Sizer(smallEnvelope(tmp(), { bankroll_usd: 1000, per_trade_max_usd: 40, portfolio_max_exposure_usd: 400, daily_loss_limit_usd: 200, pumpfun: { max_exposure_usd: 400 } }));
  const base = { venue: "pumpfun", p_win: 0.6, payoff: 2, stop_fraction: 1, tier: 3 };
  const full = sizer.size({ decision: base, portfolio: { open: [], realized_today_usd: 0 } });
  const half = sizer.size({ decision: { ...base, stake_cap_fraction: 0.5 }, portfolio: { open: [], realized_today_usd: 0 } });
  assert.ok(full.stake_usd > 20, JSON.stringify(full)); assert.equal(half.stake_usd, 20); assert.ok(half.caps.includes("MODEL_CAP"));
});

test("T10: a production-shaped candidate (no enrichment, tier 3) is a GO; missing features are not zeros and tier-3 priors clear costs", async () => {
  const { makePumpfunEdge, pumpfunFeatures, PUMPFUN_PRIORS } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { GateRunner, expectedValue } = await import("../../src/velocity/core/pipeline.mjs");
  const { scoreFeatures, DEFAULT_WEIGHTS } = await import("../../src/velocity/core/learner.mjs");
  // What the radar's live path actually serves: apeScore, chart health, fresh-wallet ratio. Nothing else.
  const p = goodCandidatePayload("MintProd");
  delete p.token._memeticQuick; delete p.token._survivorMatch;
  p.qf = { rg_devSellSpeed: 0.05, _rg_sybilScore: 0.1, _rg_freshWalletRatio: 0.2, rg_holderConcentration: 0.3, ch_healthScore: 0.5 };
  p.scores = { apeScore: 45, scoreTimestamp: Date.now() };
  const f = pumpfunFeatures({ token: p.token, qf: p.qf, scores: p.scores });
  assert.equal(f.memeticQuick, null); assert.equal(f.survivorMatch, null); assert.equal(f.whaleBullish, null); assert.equal(f.walletAge, null);
  const ranked = scoreFeatures(f, DEFAULT_WEIGHTS.pumpfun);
  assert.ok(ranked > 0.4 && ranked < 0.6, `renormalised over present features: ${ranked}`);
  const asZeros = scoreFeatures({ ...f, memeticQuick: 0, survivorMatch: 0, whaleBullish: 0, walletAge: 0 }, DEFAULT_WEIGHTS.pumpfun);
  assert.ok(asZeros < 0.35, `the old reading, which refused everything: ${asZeros}`);
  // The contract the producer has to honour. Deleting a key from a hand-written qf proves nothing:
  // extractQuickFeatures always DEFINES _whaleBullish, so the only question is what it defines it as.
  // A literal 0 survives opt() and enters the weighted sum as a measurement of "no whale is buying".
  assert.equal(pumpfunFeatures({ token: p.token, qf: { ...p.qf, _whaleBullish: null }, scores: p.scores }).whaleBullish, null, "unmeasured must be null");
  assert.equal(pumpfunFeatures({ token: p.token, qf: { ...p.qf, _whaleBullish: 0 }, scores: p.scores }).whaleBullish, 0, "a real zero is still a zero");
  const withFalseZero = scoreFeatures({ ...f, whaleBullish: 0 }, DEFAULT_WEIGHTS.pumpfun);
  assert.ok(ranked - withFalseZero > 0.04, `a false zero costs ${(ranked - withFalseZero).toFixed(3)} of confidence against a 0.50 floor`);
  // In R units every tier's prior looks like a clear edge -- but payoff is a RATIO of average win to
  // average loss, so that edge is denominated in one average loss, while the cost is a fraction of the
  // stake. Converted honestly, the tier-3 prior does NOT clear a 3.5% round trip: at a 10% stop, a 3x
  // payoff needs a 33.75% win rate and the prior assumes 30%.
  for (const t of [1, 2, 3]) assert.ok(expectedValue({ ...PUMPFUN_PRIORS[t], costs: 0.035 }) > 0, `tier ${t} prior edge in R`);
  const evOf = (t, costs) => expectedValue({ p_win: PUMPFUN_PRIORS[t].p_win, payoff: PUMPFUN_PRIORS[t].payoff, lossFraction: PUMPFUN_PRIORS[t].loss_fraction, costs });
  assert.ok(evOf(1, 0.035) > 0, "tier 1 prior clears its costs");
  assert.ok(evOf(3, 0.035) < 0, "tier 3 prior does not: 30% win rate is below the 33.75% break-even");
  assert.ok(evOf(3, 0) > 0, "and it is the costs that kill it, not the edge -- which is why tier 3 probes");
  // Through the whole runner at Normal: a GO, not a confidence or EV reject.
  const edge = makePumpfunEdge({ aggression: 2 });
  const runner = new GateRunner({ venue: "pumpfun", edge });
  assert.equal(runner.minConfidence, 0.40);
  const ev = makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintProd", t_venue: Date.now() - 100, t_observed: Date.now(), payload: p });
  const [cand] = edge.ingest(ev);
  const d = runner.evaluate(ev, cand, { governor: {} });
  assert.equal(d.action, "GO", JSON.stringify(d.reasons));
  assert.equal(d.tier, 3);
  // The designed level keeps its 0.5 floor.
  assert.equal(new GateRunner({ venue: "pumpfun", edge: makePumpfunEdge({ aggression: 1 }) }).minConfidence, 0.5);
});

test("T10: a transient gate-1 reject is re-judged after 30s; a fatal one stands for 5 minutes", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  const engine = mkEngine(dir, { envelope: env, mode: "paper", feed });
  try {
    await feed.start(); await engine.start();
    const t0 = Date.now();
    const rejects = () => engine.ledger.query({ kind: "decision", limit: 50 }).filter(d => d.action === "REJECT");
    // Minute one: quick flips everywhere, so QUICK_FLIP fires. A reading of the last minute, not a verdict on the token.
    const flip = goodCandidatePayload("MintFlip"); flip.qf = { ...flip.qf, _rg_quickFlipRate: 0.6 };
    feed.emitEvent({ kind: "candidate", id: "MintFlip", payload: flip, t_venue: t0 }); await engine.enqueue(() => {});
    assert.equal(rejects().filter(d => d.instrument === "MintFlip").length, 1);
    // 10 seconds later, same token, now clean: still inside the cooldown, not re-judged.
    feed.emitEvent({ kind: "candidate", id: "MintFlip", payload: goodCandidatePayload("MintFlip"), t_venue: t0 + 10_000, t_observed: t0 + 10_000 }); await engine.enqueue(() => {});
    assert.equal(engine.ledger.query({ kind: "decision", limit: 50 }).filter(d => d.instrument === "MintFlip").length, 1);
    // 35 seconds later: re-judged, and this time it is a GO.
    const fresh = goodCandidatePayload("MintFlip"); fresh.scores.scoreTimestamp = t0 + 35_000;
    feed.emitEvent({ kind: "candidate", id: "MintFlip", payload: fresh, t_venue: t0 + 35_000, t_observed: t0 + 35_000 }); await engine.enqueue(() => {});
    const ds = engine.ledger.query({ kind: "decision", limit: 50 }).filter(d => d.instrument === "MintFlip");
    assert.equal(ds.length, 2); assert.equal(ds.find(d => d.action === "GO")?.action, "GO", JSON.stringify(ds.map(d => [d.action, d.gate, d.reasons])));
    // A dev self-snipe is the token, not the minute: rejected at t0, silent at t0+35s, judged again only after 5 minutes.
    const snipe = goodCandidatePayload("MintSnipe"); snipe.qf = { ...snipe.qf, _rg_devSelfSnipe: 1 };
    feed.emitEvent({ kind: "candidate", id: "MintSnipe", payload: snipe, t_venue: t0, t_observed: t0 }); await engine.enqueue(() => {});
    feed.emitEvent({ kind: "candidate", id: "MintSnipe", payload: goodCandidatePayload("MintSnipe"), t_venue: t0 + 35_000, t_observed: t0 + 35_000 }); await engine.enqueue(() => {});
    assert.equal(engine.ledger.query({ kind: "decision", limit: 50 }).filter(d => d.instrument === "MintSnipe").length, 1);
    feed.emitEvent({ kind: "candidate", id: "MintSnipe", payload: goodCandidatePayload("MintSnipe"), t_venue: t0 + 6 * 60_000, t_observed: t0 + 6 * 60_000 }); await engine.enqueue(() => {});
    assert.equal(engine.ledger.query({ kind: "decision", limit: 50 }).filter(d => d.instrument === "MintSnipe").length, 2);
  } finally { await engine.stop(); await feed.stop(); }
});

test("T10: momentum override: a crowd waives the pattern rules on Normal and Degen, never the who-is-selling rules, never on Careful", async () => {
  const { checkDisqualifiers, FATAL_DISQUALIFIERS } = await import("../../src/autoape/gates/disqualifiers.js");
  const { AGGRESSION, makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const now = Date.now();
  // Two minutes in: 22 distinct buyers, at its high, sellers a fifth of the flow; but the crowd trips QUICK_FLIP and LIQ_REMOVAL-style readings.
  const runner = { ca: "R", createdAt: now - 2 * 60_000, buys: 60, sells: 32, uniqueBuyers: { size: 22 }, mcapUsd: 30_000, vSolInBondingCurve: 40, spark: [26_000, 27_500, 28_000, 29_000, 29_500, 30_000] };
  const qf = { _rg_organicBuyers: 22, _rg_quickFlipRate: 0.5, rg_coordDumpScore: 0.8, rg_sellWaveDetect: 0.8, rg_holderConcentration: 0.8, rg_liqRemovalSpeed: 0.2, rg_mcapDropRate: 0.05, rg_devSellSpeed: 0.1 };
  const careful = checkDisqualifiers(runner, qf, AGGRESSION[1]);
  assert.equal(careful.pass, false); assert.ok(careful.flags.includes("QUICK_FLIP")); assert.deepEqual(careful.waived, []);
  const normal = checkDisqualifiers(runner, qf, AGGRESSION[2]);
  assert.equal(normal.pass, true, JSON.stringify(normal)); assert.ok(normal.waived.includes("QUICK_FLIP")); assert.ok(normal.waived.includes("COORDINATED_DUMP"));
  // The dev selling into that crowd is still a no, on any setting.
  const devDump = checkDisqualifiers(runner, { ...qf, rg_devSellSpeed: 0.7 }, AGGRESSION[3]);
  assert.equal(devDump.pass, false); assert.ok(devDump.flags.includes("DEV_SELLING")); assert.ok(devDump.flags.includes("QUICK_FLIP"), "a selling dev is no crowd: nothing is waived"); assert.deepEqual(devDump.waived, []);
  // Price 30% off its high: not a crowd on its way up, no waiver.
  const off = checkDisqualifiers(runner, { ...qf, rg_mcapDropRate: 0.3 }, AGGRESSION[2]);
  assert.equal(off.pass, false); assert.deepEqual(off.waived, []);
  // Ten buyers is a crowd on Degen, not on Normal.
  const small = { ...runner, uniqueBuyers: { size: 10 } }, qfs = { ...qf, _rg_organicBuyers: 10 };
  assert.equal(checkDisqualifiers(small, qfs, AGGRESSION[2]).pass, false);
  assert.equal(checkDisqualifiers(small, qfs, AGGRESSION[3]).pass, true);
  assert.ok(FATAL_DISQUALIFIERS.has("SYBIL_ATTACK") && FATAL_DISQUALIFIERS.has("MCAP_CRASHING"));
  // A metronome bot pump is the purest "crowd" by the numbers; the bot-farm and no-sell rules are never waived.
  const bot = { ...runner, sells: 4, buys: 40, uniqueBuyers: { size: 16 } };
  const botQf = { _rg_organicBuyers: 16, _rg_buyTimingRegularity: 0.65, _rg_singleWalletDominance: 0.45, rg_mcapDropRate: 0, rg_liqRemovalSpeed: 0.1, rg_holderConcentration: 0.5 };
  for (const lvl of [2, 3]) { const r = checkDisqualifiers(bot, botQf, AGGRESSION[lvl]); assert.equal(r.pass, false, `level ${lvl}`); assert.ok(r.flags.includes("BOT_PUMP")); }
  const zero = checkDisqualifiers({ ...bot, sells: 0 }, { ...botQf, _rg_velocityLinearity: 0.95, _rg_buySellImbalance: 0.85, _rg_zeroSellFlag: 0.85, _rg_freshWalletRatio: 0.9, _rg_quickFlipRate: 0.5 }, AGGRESSION[3]);
  assert.equal(zero.pass, false); for (const f of ["LINEAR_PUMP", "ZERO_SELLS", "ALL_BUYS_NO_SELLS", "FRESH_WALLET_RUG"]) assert.ok(zero.flags.includes(f), f);
  assert.deepEqual(zero.waived.map(f => f.replace(/^MULTI_RUG_SIGNAL_\d+$/, "MULTI_RUG_SIGNAL_*")).sort(), ["MULTI_RUG_SIGNAL_*", "QUICK_FLIP"], "only the crowd-pattern rules are waived; the no-sell and bot rules stand");
  // A dev distributing under the DEV_SELLING line is no crowd: MULTI_RUG_SIGNAL stands.
  const devHalf = checkDisqualifiers(runner, { ...qf, rg_devSellSpeed: 0.5, _rg_freshWalletRatio: 0.75, ch_staircaseScore: 0.45 }, AGGRESSION[2]);
  assert.equal(devHalf.pass, false); assert.deepEqual(devHalf.waived, []);
  // Through the edge, the waiver is in the decision's reasons so the narration says why it was let in.
  const edge = makePumpfunEdge({ aggression: 2 });
  const p = goodCandidatePayload("R"); p.token = { ...p.token, ...runner }; p.qf = { ...p.qf, ...qf };
  const [c] = edge.ingest({ kind: "candidate", payload: p });
  assert.equal(edge.gates[0].check(c).pass, true); assert.deepEqual(c.waived, normal.waived);
  for (const g of edge.gates.slice(1)) { const r = g.check(c); assert.equal(r.pass, true, `${g.name}: ${JSON.stringify(r.reasons)}`); }
  assert.ok(edge.estimate(c, {}).reasons.some(r => /momentum waived/.test(r)));
});

test("T10: the dial scales the Kelly fraction: Degen sizes twice Careful, capped at half Kelly", async () => {
  const { userEnvelope } = await import("../../src/velocity/hub.mjs");
  const base = userEnvelope({ bankrollUsd: 100, aggression: 1 }).venues.pumpfun.kelly_fraction;
  assert.equal(userEnvelope({ bankrollUsd: 100, aggression: 0 }).venues.pumpfun.kelly_fraction, +(base * 0.75).toFixed(6));
  assert.equal(userEnvelope({ bankrollUsd: 100, aggression: 2 }).venues.pumpfun.kelly_fraction, Math.min(0.5, base * 1.5));
  assert.equal(userEnvelope({ bankrollUsd: 100, aggression: 3 }).venues.pumpfun.kelly_fraction, Math.min(0.5, base * 2));
});

test("T10: the market-cap floor follows the dial and is named for what it is; a PONS entry is marked at what was paid", async () => {
  const { checkViability } = await import("../../src/autoape/gates/viability.js");
  const { AGGRESSION } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { curveEntryMark } = await import("../../src/velocity/core/engine.mjs");
  const t = { ca: "S", createdAt: Date.now() - 3 * 60_000, buys: 20, sells: 5, uniqueBuyers: { size: 9 }, mcapUsd: 2_800, volumeSol: 3 };
  const dyn = { scores: 4, velocity: 0.1, acceleration: 0, trend: "rising" };
  assert.ok(checkViability(t, {}, { apeScore: 60 }, dyn).checks.includes("MCAP_BELOW_FLOOR"), "designed floor $4k");
  assert.ok(checkViability(t, {}, { apeScore: 60 }, dyn, AGGRESSION[2]).checks.includes("MCAP_BELOW_FLOOR"), "normal floor $3k");
  assert.ok(!checkViability(t, {}, { apeScore: 60 }, dyn, AGGRESSION[3]).checks.includes("MCAP_BELOW_FLOOR"), "degen floor $2.5k admits $2.8k");
  assert.ok(!checkViability(t, {}, { apeScore: 60 }, dyn).checks.includes("INSUFFICIENT_LIQUIDITY"), "the old name is gone");
  // PONS: paid 0.004 ETH at $3000 for 12,000,000 tokens => $0.000001 per token => $1,000 mcap at entry.
  assert.equal(curveEntryMark("pons", { qty: 12_000_000, price: 12 / 12_000_000 }, { reference: { mcapUsd: 1_500 } }), 1000);
  assert.equal(curveEntryMark("pumpfun", { qty: 1, price: 5 }, { reference: { mcapUsd: 9_000 } }), 9_000);
  assert.equal(curveEntryMark("polymarket", { qty: 1, price: 0.6 }, { reference: {} }), 0.6);
});

test("T10: an EVM router is told what the wallet has traded, so a restart adopts holdings instead of losing them", async () => {
  const { Engine } = await import("../../src/velocity/core/engine.mjs");
  const { PonsPaperRouter } = await import("../../src/velocity/venues/pons/router.mjs");
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const dir = tmp();
  const base = JSON.parse(fs.readFileSync(path.resolve("src/velocity/config/risk.example.json"), "utf8"));
  const cfg = { ...base, bankroll_usd: 100, per_trade_max_usd: 10, portfolio_max_exposure_usd: 40, daily_loss_limit_usd: 30, max_concurrent_positions: 4, max_per_group: 1 };
  cfg.venues = { ...base.venues, pumpfun: { ...base.venues.pumpfun, max_exposure_usd: 0 }, pons: { ...base.venues.pons, max_exposure_usd: 40, max_concurrent: 4, min_stake_usd: 5 }, polymarket: { ...base.venues.polymarket, max_exposure_usd: 0 } };
  fs.writeFileSync(path.join(dir, "risk.json"), JSON.stringify(cfg));
  const env = loadRiskEnvelope(path.join(dir, "risk.json"));
  // A live router shaped like the EVM one: it only sees balances of tokens it was told about.
  class FakeEvm { constructor() { this.ready = false; this.known = new Set(); this.wallet = { "0xheld": 900 }; this.calls = []; }
    async init() { this.ready = true; return this.preflight(); } async preflight() { return { wallet: "0xme", balanceSol: 0.05, quote: "ETH" }; }
    async health() { return { ok: true, latencyMs: 1, detail: "ok" }; } track(t) { this.known.add(t); }
    async positions() { return [...this.known].filter(t => this.wallet[t] > 0).map(t => ({ instrument: t, qty: this.wallet[t] })); }
    async submit() { return { ok: false, failure: { code: "UNUSED", reason: "" } }; } async close() { return { ok: false, failure: { code: "UNUSED", reason: "" } }; } }
  const feed = new ScriptedFeed({ venue: "pons", script: [] });
  const mk = (live) => new Engine({ dataDir: dir, envelope: env, venues: { pons: { mode: "live", feed, edge: makePumpfunEdge({ venue: "pons" }), router: new PonsPaperRouter({ bookFile: path.join(dir, "pb.json") }), liveRouter: live } }, config: { saveMs: 600_000, governorMs: 600_000, sweepMs: 600_000 } });
  // First life: the engine bought 0xheld (a fill in the ledger, a position in the store).
  const first = mk(new FakeEvm());
  first.store.setVenueMode("pons", "live");
  first.ledger.append({ kind: "order", venue: "pons", orderId: "o1", stage: "sent", instrument: "0xheld", side: "BUY", stake_usd: 8 });
  first.ledger.append({ kind: "fill", venue: "pons", orderId: "o1", positionId: "pons:0xheld:1", instrument: "0xheld", side: "BUY", price: 0.00001, qty: 900, notional_usd: 8, sol_spent: 0.003 });
  first.store.upsertPosition({ id: "pons:0xheld:1", venue: "pons", instrument: "0xheld", status: "open", paper: false, qty: 900, remaining_qty: 900, cost_usd: 8, notional_usd: 8, stake_usd: 8, proceeds_usd: 0, entryTime: Date.now(), entryMark: 10_000, plan: createPlan({ venue: "pons", key: 3, entry: { score: 60 } }) });
  first.store.save();
  // Second life, fresh router with no memory: the engine tells it, and the position survives.
  const live = new FakeEvm();
  const second = mk(live);
  try {
    await second.start();
    assert.ok(live.known.has("0xheld"), "the router was told about the instrument from the ledger and store");
    assert.equal(second.store.openPositions("pons").length, 1, "the held token stays an open position, not 'missing at venue'");
    assert.deepEqual(second.status().holdings.pons.list, [{ instrument: "0xheld", qty: 900, tracked: true }]);
    // A holding the store does not know (bought, then the store lost it): shown untracked, and reconcile adopts it from the ledger fill.
    live.wallet["0xlost"] = 500;
    second.ledger.append({ kind: "fill", venue: "pons", orderId: "o2", positionId: "pons:0xlost:1", instrument: "0xlost", side: "BUY", price: 0.00002, qty: 500, notional_usd: 9, sol_spent: 0.003 });
    await second.refreshWallet();
    const h = second.status().holdings.pons.list.find(x => x.instrument === "0xlost");
    assert.ok(h, "the wallet's holding is listed"); 
    assert.ok(second.store.openPositions("pons").some(p => p.instrument === "0xlost" && p.adopted), "adopted from the ledger fill");
    // Prices are per venue: an ETH price on a pons event never becomes the SOL price, and the header
    // P&L is the wallet's change in its own quote asset, so ETH moving is not "P&L".
    second.quotePrice.pumpfun = 200;
    await second.onEvent({ kind: "tick", venue: "pons", id: "0xheld", t_venue: Date.now(), payload: { solPrice: 4000, mcapUsd: 10_000 } });
    assert.equal(second.quotePriceOf("pumpfun"), 200); assert.equal(second.quotePriceOf("pons"), 4000);
    second.store.state.baseline = null; await second.refreshWallet();
    const b = second.store.state.baseline; assert.ok(b && b.quote.pons === 0.05, "baseline keeps the ETH amount");
    second.quotePrice.pons = 8000; // ETH doubles: nothing traded
    assert.equal(second.truePnl().since_start_usd, 0);
    live.preflight = async () => ({ wallet: "0xme", balanceSol: 0.06, quote: "ETH" }); await second.refreshWallet();
    assert.equal(second.truePnl().since_start_usd, +(0.01 * 8000).toFixed(2), "0.01 ETH more in the wallet, at today's price");
  } finally { await second.stop(); }
});

test("T10: a dev holding a rug-sized share is refused on every setting and never waived by momentum", async () => {
  const { checkDisqualifiers } = await import("../../src/autoape/gates/disqualifiers.js");
  const { AGGRESSION } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const now = Date.now();
  const crowd = { ca: "D", createdAt: now - 2 * 60_000, buys: 60, sells: 10, uniqueBuyers: { size: 22 }, mcapUsd: 30_000, vSolInBondingCurve: 40 };
  const qf = { _rg_organicBuyers: 22, rg_mcapDropRate: 0.02, rg_liqRemovalSpeed: 0.15, rg_devSellSpeed: 0, _rg_devHoldPct: 0.18, _rg_quickFlipRate: 0.5 };
  for (const lvl of [0, 1, 2, 3]) { const r = checkDisqualifiers(crowd, qf, AGGRESSION[lvl]); assert.equal(r.pass, false, `level ${lvl}`); assert.ok(r.flags.includes("DEV_HOLDS_SUPPLY")); }
  assert.equal(checkDisqualifiers(crowd, { ...qf, _rg_devHoldPct: 0.09, _rg_quickFlipRate: 0.1 }, AGGRESSION[1]).flags.includes("DEV_HOLDS_SUPPLY"), false, "9% is under the designed 10%");
  assert.equal(checkDisqualifiers(crowd, { ...qf, _rg_devHoldPct: 0.14, _rg_quickFlipRate: 0.1 }, AGGRESSION[3]).flags.includes("DEV_HOLDS_SUPPLY"), false, "degen tolerates up to 15%");
  assert.equal(checkDisqualifiers(crowd, { ...qf, _rg_devHoldPct: 0.14, _rg_quickFlipRate: 0.1 }, AGGRESSION[1]).flags.includes("DEV_HOLDS_SUPPLY"), true, "careful does not");
});

test("T10: the token account's rent comes back when a position leaves for good, and not while a moonbag is still held", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rent-"));
  const env = smallEnvelope(dir);
  const live = new FakeLive({ wallet: { MintR: 1000 } });
  live.closeImpl = (p, pct) => { const t = Date.now(); const qty = (p.remaining_qty ?? p.qty) * pct / 100; live.wallet.MintR = Math.max(0, (live.wallet.MintR || 0) - qty); return { ok: true, fill: { orderId: `${p.id}:close`, decisionId: p.decisionId, venue: "pumpfun", instrument: p.instrument, side: "SELL", price: 0.006, qty, notional_usd: 13, fee_usd: 0, t_sent: t, t_filled: t + 3, latency_ms: 3, venue_ref: "SIGSELL", sol_received: 0.065 } }; };
  const engine = mkEngine(dir, { envelope: env, mode: "paper", live, config: { reentryCooldownMs: 0, saveMs: 600_000, governorMs: 600_000, sweepMs: 600_000 } });
  try {
    await engine.start({ reconcile: false });
    engine.quotePrice.pumpfun = 200; // going live needs a price for the quote asset, or the wallet cannot be judged
    await engine.setVenueMode("pumpfun", "live", { override: true });
    const plan = createPlan({ venue: "pumpfun", key: 2, entry: { score: 66 } });
    const mk = (id, over = {}) => ({ id, venue: "pumpfun", instrument: "MintR", status: "open", paper: false, qty: 1000, remaining_qty: 1000, cost_usd: 25, notional_usd: 25, stake_usd: 25, proceeds_usd: 0, entryTime: Date.now() - 60_000, entryMark: 10_000, tier: 2, model: "bondli_gates", plan, reference: { solPrice: 200 }, ...over });

    // A partial sell leaves tokens behind: the account is still in use, so nothing is closed.
    const partial = mk("pos:partial");
    engine.store.upsertPosition(partial);
    await engine.closePosition(partial, 50, "TEST_PARTIAL", { by: "test" });
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(live.closedAccounts, [], "a partial exit keeps the account open");
    // Half sold means half still at risk. notional_usd is what the risk envelope, the daily taper
    // and the header's open value read; left at 25 it counted the sold half as still on the table
    // AND as cash in the wallet.
    assert.equal(engine.store.state.positions["pos:partial"].notional_usd, 12.5, "what is still at risk shrinks with what was sold");
    assert.equal(engine.store.state.positions["pos:partial"].stake_usd, 25, "the original stake, which the statistics key on, does not");

    // The final sell empties it: the rent is claimed and booked.
    await engine.closePosition(engine.store.state.positions["pos:partial"], 100, "TEST_FINAL", { by: "test" });
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(live.closedAccounts, ["MintR"], "the emptied account is closed");
    for (let i = 0; i < 50 && !engine.ledger.query({ kind: "rent", limit: 1 }).length; i++) await new Promise(r => setTimeout(r, 10));
    const rent = engine.ledger.query({ kind: "rent", limit: 1 })[0];
    assert.equal(rent.sol, 0.002034); assert.equal(rent.instrument, "MintR"); assert.equal(rent.venue_ref, "SIGRENT");
    // The rent went out inside cost_usd at entry, so the outcome already booked it as lost. Getting
    // it back is realized money: 0.002034 SOL at $200 is $0.41 credited to the day it lands in.
    assert.equal(rent.usd, 0.4068);
    const realized = engine.store.state.day.realizedUsd;
    const outcome = engine.ledger.query({ kind: "outcome", limit: 1 })[0];
    assert.equal(+(realized - outcome.pnl_usd).toFixed(4), 0.4068, "the day is the outcome plus the rent that came back");
  } finally { await engine.stop(); }
});

test("T10: a launch that lists no socials is refused, but only once its metadata has actually been read", async () => {
  const { checkDisqualifiers } = await import("../../src/autoape/gates/disqualifiers.js");
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const token = { ca: "M", createdAt: Date.now() - 120_000, buys: 20, sells: 4, uniqueBuyers: { size: 12 }, mcapUsd: 12_000, trades: [] };
  const opts = { requireSocials: true };
  // metadata not fetched yet: absence of socials says nothing, so the rule stays silent
  assert.ok(!checkDisqualifiers(token, { _socialsKnown: 0, _hasAnySocial: 0 }, opts).flags.includes("NO_SOCIALS"));
  // metadata read, nothing listed: refused
  assert.ok(checkDisqualifiers(token, { _socialsKnown: 1, _hasAnySocial: 0 }, opts).flags.includes("NO_SOCIALS"));
  // any one link is enough
  assert.ok(!checkDisqualifiers(token, { _socialsKnown: 1, _hasAnySocial: 1 }, opts).flags.includes("NO_SOCIALS"));
  // off by default in the raw gate, on at every risk level of the real edge
  assert.ok(!checkDisqualifiers(token, { _socialsKnown: 1, _hasAnySocial: 0 }, {}).flags.includes("NO_SOCIALS"));
  for (const aggression of [0, 1, 2, 3]) assert.equal(makePumpfunEdge({ aggression }).gateOpts?.requireSocials ?? "unset", true, `level ${aggression}`);
});

test("T10: X verification turns a dead handle into no social link, and a week-old account into a flag", async () => {
  const { checkDisqualifiers } = await import("../../src/autoape/gates/disqualifiers.js");
  const token = { ca: "M", createdAt: Date.now() - 120_000, buys: 20, sells: 4, uniqueBuyers: { size: 12 }, mcapUsd: 12_000, trades: [] };
  const opts = { requireSocials: true };
  const has = (qf, f) => checkDisqualifiers(token, qf, opts).flags.includes(f);
  // a listed handle the API says does not exist: the producer drops _hasAnySocial, so it reads as no socials
  assert.ok(has({ _socialsKnown: 1, _hasAnySocial: 0, _xDeadHandle: 1 }, "NO_SOCIALS"));
  // a real handle, freshly created for this launch
  assert.ok(has({ _socialsKnown: 1, _hasAnySocial: 1, _xFlags: ["fresh_account", "low_followers"] }, "FRESH_SOCIALS"));
  // an established account passes both
  const est = { _socialsKnown: 1, _hasAnySocial: 1, _xFlags: ["verified"], _xScore: 78 };
  assert.ok(!has(est, "NO_SOCIALS") && !has(est, "FRESH_SOCIALS"));
  // no X answer at all (no key, or not checked yet): neither rule fires
  const unchecked = { _socialsKnown: 1, _hasAnySocial: 1, _xFlags: null, _xScore: null };
  assert.ok(!has(unchecked, "NO_SOCIALS") && !has(unchecked, "FRESH_SOCIALS"));
});

test("T10: a refused X credential switches the checker off instead of spending the month on 401s", async () => {
  const { XSocialIntel } = await import("../../src/engine/x-social-intel.mjs");
  const x = new XSocialIntel("bad-token");
  assert.equal(x.enabled, true, "a token that has not been tried yet is usable");
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 401, text: async () => "Unauthorized" }; };
  try {
    const first = await x.analyze("https://x.com/someone");
    assert.equal(first.flags[0], "account_not_found", "a refused call returns no profile");
    assert.equal(x.enabled, false, "the checker turned itself off");
    const second = await x.analyze("https://x.com/another");
    assert.equal(second.flags[0], "no_x_api");
    assert.equal(calls, 1, "the second token was never sent to the API");
  } finally { globalThis.fetch = realFetch; }
});

test("T10: a website that does not answer stops counting as a social link", async () => {
  const { checkDisqualifiers } = await import("../../src/autoape/gates/disqualifiers.js");
  const token = { ca: "M", createdAt: Date.now() - 120_000, buys: 20, sells: 4, uniqueBuyers: { size: 12 }, mcapUsd: 12_000, trades: [] };
  const opts = { requireSocials: true };
  const noSocials = qf => checkDisqualifiers(token, qf, opts).flags.includes("NO_SOCIALS");
  // the only listed link is a site that does not resolve
  assert.ok(noSocials({ _socialsKnown: 1, _hasAnySocial: 0, _siteDead: 1 }));
  // a live site is enough on its own
  assert.ok(!noSocials({ _socialsKnown: 1, _hasAnySocial: 1, _siteDead: 0 }));
  // not probed yet: the producer still counts the link, so nothing is refused on a pending check
  assert.ok(!noSocials({ _socialsKnown: 1, _hasAnySocial: 1 }));
  // both dead: refused
  assert.ok(noSocials({ _socialsKnown: 1, _hasAnySocial: 0, _siteDead: 1, _xDeadHandle: 1 }));
});

test("T10: curve progress subtracts the virtual reserve, so a new launch reads 0% and not 35%", async () => {
  const { pumpCurvePct, curvePctOf } = await import("../../src/autoape/gates/curve.js");
  const { checkExecutionWindow } = await import("../../src/autoape/gates/execution-window.js");
  const { AGGRESSION } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  // pump.fun's reserve starts at 30 SOL with nothing raised and ends near 115.
  assert.equal(pumpCurvePct(30), 0, "a brand-new launch has raised nothing");
  assert.equal(+pumpCurvePct(30 + 85 / 2).toFixed(4), 0.5);
  assert.equal(pumpCurvePct(115), 1);
  assert.equal(pumpCurvePct(200), 1, "clamped");
  assert.equal(pumpCurvePct(0), 0);
  assert.equal(pumpCurvePct(undefined), 0);
  // A feed that knows its own progress (PONS) is believed over the pump.fun arithmetic.
  assert.equal(curvePctOf({ _curvePct: 0.42, vSolInBondingCurve: 99 }), 0.42);
  // The regression this guards: at the strictest dial, curveMaxSpec 0.30 was BELOW the 30/85 = 35%
  // a brand-new token read, so no tier-3 launch could ever clear the window.
  const fresh = { ca: "M", createdAt: Date.now() - 60_000, vSolInBondingCurve: 30.5, mcapUsd: 5000, spark: [] };
  for (const level of [0, 1, 2, 3])
    assert.ok(!checkExecutionWindow(fresh, 3, Date.now(), AGGRESSION[level]).checks.includes("CURVE_TOO_ADVANCED_SPEC"),
      `aggression ${level}: a fresh launch is not "too advanced"`);
});

test("T10: a candidate the engine cannot enter is screened before the gates, and logged once per window", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const engine = mkEngine(dir, { envelope: env, mode: "paper", config: { rejudgeMs: 30_000 } });
  let now = Date.now(); engine.clock = () => now;
  const runner = engine.venues.pumpfun.runner;
  let gateRuns = 0;
  const realRun = runner.run.bind(runner);
  runner.run = (...a) => { gateRuns++; return realRun(...a); };
  try {
    await engine.start({ reconcile: false });
    await engine.enqueue(() => engine.onEvent(cand("MintHeld", now)));
    assert.equal(engine.store.openPositions("pumpfun").length, 1);
    const afterEntry = gateRuns;
    // The feed keeps offering the same mint every couple of seconds while it is held.
    for (let i = 1; i <= 5; i++) { now += 2000; await engine.enqueue(() => engine.onEvent(cand("MintHeld", now))); }
    assert.equal(gateRuns, afterEntry, "the gate pipeline does not run on a mint we already hold");
    const blocked = engine.ledger.query({ kind: "order" }).filter(o => o.screened);
    assert.equal(blocked.length, 1, "one line per rejudge window, not one per tick");
    assert.equal(blocked[0].reason, "ALREADY_IN_OR_INFLIGHT");
    // Past the window it says so again, so a mint stuck like this is still visible.
    now += 31_000; await engine.enqueue(() => engine.onEvent(cand("MintHeld", now)));
    assert.equal(engine.ledger.query({ kind: "order" }).filter(o => o.screened).length, 2);
  } finally { await engine.stop(); }
});

test("T10: expected value converts the payoff ratio into stake before charging costs", async () => {
  const { expectedValue, GateRunner } = await import("../../src/velocity/core/pipeline.mjs");
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  // payoff is avgWin/avgLoss, so p*payoff - (1-p) is an edge in units of one average loss. A cost is
  // a fraction of the stake. At a 5% average loss, a 3.5% round trip is 0.7 of one loss, not 0.035.
  const p = 0.4, payoff = 3, costs = 0.035, lossFraction = 0.05;
  assert.equal(+expectedValue({ p_win: p, payoff, costs }).toFixed(4), 0.565, "unconverted: an 0.6 R edge charged 0.035 R of cost");
  assert.equal(+expectedValue({ p_win: p, payoff, costs, lossFraction }).toFixed(4), -0.005, "converted: 0.6 R is 3% of stake, and the round trip is 3.5%");
  // With no loss size supplied the old form is kept rather than silently rescaled.
  assert.equal(expectedValue({ p_win: p, payoff, costs, lossFraction: 0 }), expectedValue({ p_win: p, payoff, costs }));
  assert.equal(expectedValue({ p_win: p, payoff, costs, lossFraction: null }), expectedValue({ p_win: p, payoff, costs }));
  // A bigger stop makes each loss cost more, so the same ratio is worth more per trade.
  assert.ok(expectedValue({ p_win: p, payoff, costs, lossFraction: 0.15 }) > expectedValue({ p_win: p, payoff, costs, lossFraction: 0.05 }));

  // The probe: a tier judged on priors whose edge is positive before costs is taken small, not refused.
  const edge = makePumpfunEdge({ aggression: 2 });
  const runner = new GateRunner({ venue: "pumpfun", edge });
  assert.equal(runner.probeStakeFraction, 0.4);
  const strict = new GateRunner({ venue: "pumpfun", edge, probeStakeFraction: 0 });
  assert.equal(strict.probeStakeFraction, 0, "probing can be switched off");
});

test("T10: the header P&L starts at zero, not at the value of the wallet", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const live = new FakeLive(); live.balanceSol = 1.12;
  const engine = mkEngine(dir, { envelope: env, mode: "paper", live });
  let now = Date.now(); engine.clock = () => now;
  engine.quotePrice.pumpfun = 100; // 1.12 SOL = $112 in the wallet, and no trades yet
  try {
    await engine.start({ reconcile: false });
    await engine.setVenueMode("pumpfun", "live", { override: true, by: "user" });
    const p = engine.truePnl();
    assert.equal(p.wallet_usd, 112);
    assert.equal(p.since_start_usd, 0, "a funded wallet is not a profit");
    assert.equal(engine.store.state.baseline.quote.pumpfun, 1.12, "the baseline saw the live venue");

    // Real movement is real P&L: 0.1 SOL earned is $10.
    engine.noteWallet("pumpfun", { balanceSol: 1.22, quote: "SOL" });
    assert.equal(engine.truePnl().since_start_usd, 10);
    // And a move in SOL itself is not: the same 1.22 SOL at a higher price is still +$10.
    engine.quotePrice.pumpfun = 150;
    engine.noteWallet("pumpfun", { balanceSol: 1.22, quote: "SOL" });
    assert.equal(engine.truePnl().since_start_usd, 15, "measured in SOL, priced today");
  } finally { await engine.stop(); }
});

// A venue that goes live after Start joins the baseline so its balance is not read as profit. Its
// OPEN POSITIONS have to join it too: truePnl adds today's open value and subtracts the baseline's,
// so a position the baseline never saw is a gain the size of its whole mark. That is how a header
// read +$9.41 over a session whose own subtitle said "closed -$9.63 · open -$0.95".
test("T10: a venue folded into the baseline brings its open positions with it", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const live = new FakeLive(); live.balanceSol = 1.0;
  const engine = mkEngine(dir, { envelope: env, mode: "paper", live });
  let now = Date.now(); engine.clock = () => now;
  engine.quotePrice.pumpfun = 100;
  try {
    await engine.start({ reconcile: false });
    await engine.setVenueMode("pumpfun", "live", { override: true, by: "user" });
    assert.equal(engine.truePnl().since_start_usd, 0);

    // A second venue is already holding a $20 position, currently marked down 5%, when it goes live.
    engine.venues.pons = { ...engine.venues.pumpfun };
    engine.quotePrice.pons = 2000;
    engine.store.state.positions.ponsPos = { id: "ponsPos", venue: "pons", instrument: "0xabc", status: "open",
      notional_usd: 20, changePct: -5, unrealized_usd: -1, paper: false, qty: 1, remaining_qty: 1, entryTime: now, plan: { key: 2 } };
    engine.store.setVenueMode("pons", "live");
    engine.noteWallet("pons", { balanceSol: 0.01, quote: "ETH" });

    const b = engine.store.state.baseline;
    assert.equal(b.quote.pons, 0.01, "the wallet joined the baseline");
    assert.equal(b.open_usd, 19, "and so did what that wallet already bought, at its current mark");
    assert.equal(engine.truePnl().since_start_usd, 0, "funding a venue mid-run is not a profit");

    // From there it measures real movement: the same position down another $2 is -$2, not +$17.
    engine.store.state.positions.ponsPos.changePct = -15;
    assert.equal(engine.truePnl().since_start_usd, -2);
  } finally { await engine.stop(); }
});

test("T10: two callers cannot sell the same position at once", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const live = new FakeLive();
  let sells = 0, release;
  const gate = new Promise(r => { release = r; });
  live.closeImpl = async (p) => {
    sells++;
    await gate; // the first sell is still on the wire
    const t = Date.now();
    return { ok: true, fill: { price: 0.005, qty: 1000, notional_usd: 5, fee_usd: 0, t_sent: t, t_filled: t, latency_ms: 0, venue_ref: `SIG${sells}`, sol_received: 0.025 } };
  };
  const engine = mkEngine(dir, { envelope: env, mode: "live", live });
  const now = Date.now(); engine.clock = () => now;
  engine.store.upsertPosition({ id: "dup", venue: "pumpfun", instrument: "MintDup", status: "open", paper: false, qty: 1000,
    remaining_qty: 1000, cost_usd: 5.2, notional_usd: 5.2, stake_usd: 5, proceeds_usd: 0, entryTime: now - 60_000, entryMark: 9000,
    tier: 2, model: "bondli_gates", plan: createPlan({ venue: "pumpfun", key: 2, entry: { score: 60 } }), reference: { solPrice: 200 } });
  try {
    await engine.start({ reconcile: false });
    const p = engine.store.state.positions.dup;
    // The user's flatten and a tick-driven stop loss, at the same moment.
    const a = engine.closePosition(p, 100, "FLATTEN", { by: "user" });
    const b = engine.closePosition(p, 100, "SL2");
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(sells, 1, "one position, one sell");
    const loser = ra.ok ? rb : ra;
    assert.equal(loser.failure.code, "EXIT_IN_FLIGHT");
    assert.equal(engine.store.state.positions.dup.status, "closed");
    assert.equal(engine.ledger.query({ kind: "outcome" }).length, 1, "and one outcome, not two");
  } finally { await engine.stop(); }
});

test("T10: a DOA exit is a not-yet, so the mint can be bought back in seconds", async () => {
  const dir = tmp(); const env = smallEnvelope(dir);
  const engine = mkEngine(dir, { envelope: env, mode: "paper" });
  let now = Date.now(); engine.clock = () => now;
  const book = (reason) => engine._bookExit(
    { id: "p:" + reason, venue: "pumpfun", instrument: "M" + reason, status: "open", paper: true, qty: 1, remaining_qty: 1,
      cost_usd: 25, proceeds_usd: 0, stake_usd: 25, entryTime: 0, plan: { key: 2 } },
    { ok: true, fill: { price: 1, qty: 1, notional_usd: 24, fee_usd: 0, t_filled: now, paper: true } }, 100, reason);
  try {
    await engine.start({ reconcile: false });
    // "Nothing was happening yet" -- step aside cheaply, keep the right to come back.
    for (const r of ["DOA", "STALL"]) { book(r); assert.equal(engine.cooldown.get("M" + r) - now, engine.cfg.retryCooldownMs, r); }
    // "This token is bad" -- stay out.
    for (const r of ["SL2", "crash-exit", "MAX_HOLD"]) { book(r); assert.equal(engine.cooldown.get("M" + r) - now, engine.cfg.reentryCooldownMs, r); }
    assert.ok(engine.cfg.retryCooldownMs < engine.cfg.reentryCooldownMs / 4, "and the difference is worth having");
  } finally { await engine.stop(); }
});
