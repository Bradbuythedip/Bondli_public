// T11: the hosted hub. One shared feed drives one engine per user; a user's engine trades its own
// wallet under its own envelope; a profitable close pays the platform's cut from measured SOL to
// PLATFORM_WALLET and never to the exposed default; stopping flattens.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScriptedFeed } from "../../src/velocity/core/feed.mjs";
import { makeEvent } from "../../src/velocity/core/events.mjs";
import { failure } from "../../src/velocity/core/router.mjs";
import { VelocityHub, SharedFeedView, userEnvelope, EXPOSED_DEFAULT_PLATFORM_WALLET, DEFAULT_FEE_PCT, mountVelocityRoutes } from "../../src/velocity/hub.mjs";
import { Callouts } from "../../src/velocity/core/callouts.mjs";
import { Ledger } from "../../src/velocity/core/ledger.mjs";
import { goodCandidatePayload, tickPayload } from "./helpers/fixtures.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "velocity-t11-"));

/** A live router double with measured SOL on both sides and a recorded fee transfer. */
class FakeLive {
  constructor({ secret, wallet, balanceSol = 1, sellSol = 0.07 }) {
    this.secret = secret; this.owner = wallet; this.ready = false; this.balanceSol = balanceSol; this.sellSol = sellSol;
    this.transfers = []; this.priorityFeeSol = 0.0005; this.tokens = {};
  }
  async init() { this.ready = true; return { wallet: "TW_" + this.owner, balanceSol: this.balanceSol, rpc: "fake" }; }
  async preflight() { return { wallet: "TW_" + this.owner, balanceSol: this.balanceSol, rpc: "fake" }; }
  async health() { return { ok: true, latencyMs: 1, detail: "fake" }; }
  async positions() { return Object.entries(this.tokens).filter(([, q]) => q > 0).map(([instrument, qty]) => ({ instrument, qty })); }
  async submit(o) { const t = Date.now(); this.tokens[o.instrument] = 1000; return { ok: true, fill: { orderId: o.id, decisionId: o.decisionId, venue: "pumpfun", instrument: o.instrument, side: "BUY", price: 0.005, qty: 1000, notional_usd: 5.1, fee_usd: 0.1, t_sent: t, t_filled: t + 3, latency_ms: 3, venue_ref: "SIGBUY", sol_spent: 0.051 } }; }
  async close(p) { if (!this.tokens[p.instrument]) return failure({ id: p.id }, "NO_POSITION", "none"); this.tokens[p.instrument] = 0; const t = Date.now(); return { ok: true, fill: { price: 0.007, qty: 1000, notional_usd: this.sellSol * 100, fee_usd: 0, t_sent: t, t_filled: t + 3, latency_ms: 3, venue_ref: "SIGSELL", sol_received: this.sellSol } }; }
  async transferSol(to, sol) { this.transfers.push({ to, sol }); return "SIGFEE"; }
}

function feeDeps(tier = "pro") {
  const outcomes = [], global = [];
  return {
    outcomes, global,
    getUser: async () => ({ tier }),
    resolveTier: () => ({ tier, whitelisted: false }),
    recordTradeOutcome: (w, net) => outcomes.push(net),
    recordGlobalFee: f => global.push(f),
    // 10% of net profit, nothing on a loss or dust: the shape of bondli's calculateFee.
    calculateFee: (solIn, solOut) => { const net = +(solOut - solIn).toFixed(6); return net <= 0.001 ? { fee: 0, net } : { fee: +(net * 0.10).toFixed(6), net, rate: 10 }; },
  };
}

test("T11: a user's envelope is the template with their choices, validated", async () => {
  const { MIN_STAKE_USD } = await import("../../src/velocity/hub.mjs");
  // The floor comes from the router's cost constants, not a round number: with the ATA rent
  // reclaimed and the priority fee at 0.0003 the fixed cost of a round trip is $0.12, so the drag
  // is 4.2% at $10 against 3.5% at $25 and the extra diversification is worth more than the gap.
  assert.equal(MIN_STAKE_USD, 10);
  // $400, four positions of $40: the day's budget defaults to what those positions can lose, $160,
  // which is under the 35%-of-bankroll ceiling ($140)... so the ceiling binds and funds three.
  const e = userEnvelope({ bankrollUsd: 400, perTradeMaxUsd: 40, maxPositions: 4 });
  assert.equal(e.bankroll_source, "wallet"); assert.equal(e.per_trade_max_usd, 40);
  assert.equal(e.daily_loss_limit_usd, 140, "35% of the account is the most it will risk in a day unasked");
  assert.equal(e.max_concurrent_positions, 3); assert.equal(e.portfolio_max_exposure_usd, 120);
  assert.equal(e.venues.pumpfun.max_exposure_usd, 120); assert.equal(e.venues.polymarket.max_exposure_usd, 0);
  // The user can still ask for the fourth explicitly.
  const four = userEnvelope({ bankrollUsd: 400, perTradeMaxUsd: 40, maxPositions: 4, dailyLossUsd: 160 });
  assert.equal(four.max_concurrent_positions, 4); assert.equal(four.portfolio_max_exposure_usd, 160);
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.venues.pumpfun));

  // Nothing is sized below what a round trip costs to make and unmake. A per-trade cap under the
  // floor is raised to it rather than producing a bot that runs all day and fills nothing.
  const tiny = userEnvelope({ bankrollUsd: 100, perTradeMaxUsd: 10, maxPositions: 4 });
  assert.equal(tiny.venues.pumpfun.min_stake_usd, MIN_STAKE_USD);
  assert.equal(tiny.venues.pons.min_stake_usd, MIN_STAKE_USD);
  assert.equal(tiny.per_trade_max_usd, MIN_STAKE_USD, "a $10 cap cannot pay for itself, so it is not offered");
  // The day's loss budget caps a single stake too (a memecoin's worst case is the whole position), so
  // it can never be less than one stake, or the first trade of the day is refused for being too small.
  assert.ok(tiny.daily_loss_limit_usd >= MIN_STAKE_USD, `daily ${tiny.daily_loss_limit_usd}`);

  const small = userEnvelope({ bankrollUsd: 30, perTradeMaxUsd: 50, maxPositions: 20 });
  assert.equal(small.per_trade_max_usd, 30, "per-trade cannot exceed the bankroll");
  // 20 is clamped to the hard maximum of 10, and 35% of a $30 bankroll then funds one of them.
  assert.equal(small.max_concurrent_positions, 1);
  assert.deepEqual(small.positions_capped_by_daily_budget, { asked: 10, allowed: 1, daily_loss_limit_usd: 11, per_trade_max_usd: 30 });
});

test("T11: one feed, two users, isolated ledgers, fee paid on the profitable close; the original platform wallet is accepted", async () => {
  const root = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  feed.solPrice = 100;
  const routers = {};
  const deps = feeDeps("pro");
  const hub = new VelocityHub({ feed, rootDir: root, platformWallet: "PLATFORM_FRESH_WALLET", fee: deps, makeLiveRouter: ({ secret, wallet }) => (routers[wallet] = new FakeLive({ secret, wallet })), log: { log() {}, error() {}, warn() {} } });
  assert.equal(hub.feeOk, true);
  await feed.start();
  try {
    const a = await hub.start({ wallet: "UserA", secret: "sA", settings: { bankrollUsd: 100, aggression: 2 } });
    assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.status.venues.pumpfun.mode, "live"); assert.equal(a.settings.aggression, 2);
    const b = await hub.start({ wallet: "UserB", secret: "sB", settings: { bankrollUsd: 50 } });
    assert.equal(b.ok, true); assert.equal(hub.list().length, 2);
    assert.equal(routers.UserA.secret, "sA"); assert.equal(routers.UserB.secret, "sB", "each engine signs with its own key");
    assert.ok(fs.existsSync(path.join(root, "UserA", "ledger.jsonl")) && fs.existsSync(path.join(root, "UserB", "ledger.jsonl")));

    // One candidate on the shared feed reaches both engines; both buy with their own wallet.
    const now = Date.now();
    feed.emitEvent({ kind: "candidate", id: "MintX", payload: goodCandidatePayload("MintX"), t_venue: now - 100 });
    await new Promise(r => setTimeout(r, 50));
    for (const w of ["UserA", "UserB"]) { await hub.users.get(w).engine.enqueue(() => {}); assert.equal(hub.users.get(w).engine.store.openPositions("pumpfun").length, 1, `${w} holds MintX`); }
    // A crash tick closes both. Sold for 0.07 SOL against 0.051 spent: 0.019 profit, 5% fee = 0.00095 SOL.
    // One rate for everyone who does not hold the house token: the old free/pro/vip ladder no longer
    // decides anything here, so the "pro" deps below change nothing about what is charged.
    feed.emitEvent({ kind: "tick", id: "MintX", payload: tickPayload("MintX", 17_000, { dynamics: { scores: 5, velocity: -0.6, acceleration: -0.2, trend: "crashing" } }), t_venue: now + 500 });
    await new Promise(r => setTimeout(r, 80));
    for (const w of ["UserA", "UserB"]) await hub.users.get(w).engine.enqueue(() => {});
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(routers.UserA.transfers, [{ to: "PLATFORM_FRESH_WALLET", sol: 0.00095 }]);
    assert.deepEqual(routers.UserB.transfers, [{ to: "PLATFORM_FRESH_WALLET", sol: 0.00095 }]);
    const feeRec = hub.users.get("UserA").engine.ledger.query({ kind: "fee", limit: 1 })[0];
    assert.equal(feeRec.scope, "platform"); assert.equal(feeRec.sol, 0.00095); assert.equal(feeRec.venue_ref, "SIGFEE"); assert.equal(feeRec.usd, 0.1425, "priced at the candidate's SOL price (150), fresher than the feed's 100");
    assert.deepEqual(deps.global, [0.00095, 0.00095]); assert.deepEqual(deps.outcomes, [0.019, 0.019]);
    const nar = hub.narration("UserA", 20).map(x => x.line);
    assert.ok(nar.some(l => /FILLED  BUY MintX/.test(l)) && nar.some(l => /fee/.test(l)), nar.join("\n"));

    // Stop flattens (nothing open now) and forgets the user; the other keeps running.
    const s = await hub.stop("UserA");
    assert.equal(s.ok, true); assert.equal(hub.has("UserA"), false); assert.equal(hub.has("UserB"), true);
    assert.equal(hub.status("UserA").running, false);
  } finally { await hub.stopAll(); await feed.stop(); }

  // A loss pays nothing; the exposed default wallet is refused as a fee destination.
  const feed2 = new ScriptedFeed({ venue: "pumpfun", script: [] }); feed2.solPrice = 100; await feed2.start();
  const deps2 = feeDeps("free");
  const hub2 = new VelocityHub({ feed: feed2, rootDir: tmp(), platformWallet: EXPOSED_DEFAULT_PLATFORM_WALLET, fee: deps2, makeLiveRouter: ({ secret, wallet }) => (routers[wallet] = new FakeLive({ secret, wallet, sellSol: 0.03 })), log: { log() {}, error() {}, warn() {} } });
  assert.equal(hub2.feeOk, true, "the operator's choice of wallet stands");
  try {
    // $400: one $25 stake, and a $60 day budget that still covers a second stake after the first loses.
    // On a $100 bankroll the day's budget is one stake, so a single loss ends the day — which is the
    // governor working, and the reason the page no longer suggests anyone try this with pocket change.
    assert.equal((await hub2.start({ wallet: "UserC", secret: "sC", settings: { bankrollUsd: 400 } })).ok, true);
    const now = Date.now();
    feed2.emitEvent({ kind: "candidate", id: "MintY", payload: goodCandidatePayload("MintY"), t_venue: now - 100 });
    await new Promise(r => setTimeout(r, 50)); await hub2.users.get("UserC").engine.enqueue(() => {});
    feed2.emitEvent({ kind: "tick", id: "MintY", payload: tickPayload("MintY", 17_000, { dynamics: { scores: 5, velocity: -0.6, acceleration: -0.2, trend: "crashing" } }), t_venue: now + 500 });
    await new Promise(r => setTimeout(r, 80)); await hub2.users.get("UserC").engine.enqueue(() => {}); await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(routers.UserC.transfers, [], "a losing trade pays no fee");
    assert.deepEqual(deps2.outcomes, [-0.021]);
    routers.UserC.sellSol = 0.09; routers.UserC.tokens = {};
    feed2.emitEvent({ kind: "candidate", id: "MintZ", payload: goodCandidatePayload("MintZ"), t_venue: now + 1000 });
    await new Promise(r => setTimeout(r, 50)); await hub2.users.get("UserC").engine.enqueue(() => {});
    feed2.emitEvent({ kind: "tick", id: "MintZ", payload: tickPayload("MintZ", 17_000, { dynamics: { scores: 5, velocity: -0.6, acceleration: -0.2, trend: "crashing" } }), t_venue: now + 1500 });
    await new Promise(r => setTimeout(r, 80)); await hub2.users.get("UserC").engine.enqueue(() => {}); await new Promise(r => setTimeout(r, 30));
    assert.equal(routers.UserC.transfers.length, 1, "the profit's fee goes to the configured wallet");
    assert.equal(routers.UserC.transfers[0].to, EXPOSED_DEFAULT_PLATFORM_WALLET);
    assert.equal(hub2.users.get("UserC").engine.ledger.query({ kind: "fee", limit: 1 }).length, 1);
  } finally { await hub2.stopAll(); await feed2.stop(); }

  // A wallet that cannot cover one order is refused at start.
  const feed3 = new ScriptedFeed({ venue: "pumpfun", script: [] }); await feed3.start();
  const hub3 = new VelocityHub({ feed: feed3, rootDir: tmp(), platformWallet: "PLATFORM_FRESH_WALLET", fee: feeDeps(), makeLiveRouter: ({ secret, wallet }) => new FakeLive({ secret, wallet, balanceSol: 0.01 }), log: { log() {}, error() {}, warn() {} } });
  // With no price for the quote asset there is no answer either way, and guessing one is how a
  // funded Robinhood Chain wallet used to be judged against SOL's order of magnitude.
  try { const r = await hub3.start({ wallet: "UserD", secret: "sD" }); assert.equal(r.ok, false); assert.match(r.error, /no SOL price yet/); assert.equal(hub3.has("UserD"), false); }
  finally { await hub3.stopAll(); await feed3.stop(); }

  // Given a price, the check is about the money: 0.01 SOL at $200 is $2, under one $10 stake.
  const feed4 = new ScriptedFeed({ venue: "pumpfun", script: [] }); feed4.solPrice = 200; await feed4.start();
  const hub4 = new VelocityHub({ feed: feed4, rootDir: tmp(), platformWallet: "PLATFORM_FRESH_WALLET", fee: feeDeps(), makeLiveRouter: ({ secret, wallet }) => new FakeLive({ secret, wallet, balanceSol: 0.01 }), log: { log() {}, error() {}, warn() {} } });
  try { const r = await hub4.start({ wallet: "UserE", secret: "sE" }); assert.equal(r.ok, false); assert.match(r.error, /below one minimum stake/); }
  finally { await hub4.stopAll(); await feed4.stop(); }

  // And the same wallet with enough in it goes live.
  const feed5 = new ScriptedFeed({ venue: "pumpfun", script: [] }); feed5.solPrice = 200; await feed5.start();
  const hub5 = new VelocityHub({ feed: feed5, rootDir: tmp(), platformWallet: "PLATFORM_FRESH_WALLET", fee: feeDeps(), makeLiveRouter: ({ secret, wallet }) => new FakeLive({ secret, wallet, balanceSol: 0.5 }), log: { log() {}, error() {}, warn() {} } });
  try { const r = await hub5.start({ wallet: "UserF", secret: "sF" }); assert.equal(r.ok, true, r.error); assert.equal(hub5.users.get("UserF").engine.store.venueMode("pumpfun"), "live"); }
  finally { await hub5.stopAll(); await feed5.stop(); }
});

test("T11: a shared feed view forwards events and reference-counts watches", async () => {
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] }); await feed.start();
  const v1 = new SharedFeedView(feed), v2 = new SharedFeedView(feed);
  const got = []; v1.on("event", e => got.push(e.id)); await v1.start(); await v2.start();
  feed.emitEvent({ kind: "tick", id: "M", payload: {} });
  assert.deepEqual(got, ["M"]); assert.equal(v1.eventsEmitted, 1);
  v1.watch("M"); v2.watch("M"); v1.unwatch("M");
  assert.ok(feed.watched.has("M"), "still watched by v2");
  v2.unwatch("M"); assert.ok(!feed.watched.has("M"));
  await v1.stop(); feed.emitEvent({ kind: "tick", id: "N", payload: {} }); assert.deepEqual(got, ["M"], "a stopped view hears nothing");
  await feed.stop();
});

test("T11: a flat fee rate takes that share of realized profit, nothing on a loss, nothing from the owner", async () => {
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] }); await feed.start();
  const deps = { ...feeDeps("free"), isOwnerWallet: w => w === "Owner" };
  const hub = new VelocityHub({ feed, rootDir: tmp(), platformWallet: "PLATFORM_FRESH_WALLET", fee: deps, feePct: 5, log: { log() {}, error() {}, warn() {} } });
  assert.equal(hub.feePct, 5);
  assert.deepEqual(hub.flatFee(0.05, 0.09, "UserE"), { fee: 0.002, net: 0.04, rate: 5, type: "profit-share" }, "5% of 0.04 SOL profit");
  assert.equal(hub.flatFee(0.05, 0.04, "UserE").fee, 0, "a loss pays nothing");
  assert.equal(hub.flatFee(0.05, 0.0505, "UserE").fee, 0, "dust pays nothing");
  assert.equal(hub.flatFee(0.05, 0.09, "Owner").fee, 0, "the owner pays nothing");
  // Unset falls back to the one standard rate, never to the retired free/pro/vip ladder.
  assert.equal(new VelocityHub({ feed, rootDir: tmp(), platformWallet: "P", fee: deps, log: { error() {} } }).feePct, DEFAULT_FEE_PCT, "unset means the one standard rate");
  await feed.stop();
});

test("T11: a stop's halt does not outlive the next start; pause freezes entries and resume lifts it", async () => {
  const root = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  feed.solPrice = 100;
  const hub = new VelocityHub({ feed, rootDir: root, platformWallet: "PLATFORM_FRESH_WALLET", fee: feeDeps("pro"), makeLiveRouter: ({ secret, wallet }) => new FakeLive({ secret, wallet }), log: { log() {}, error() {}, warn() {} } });
  await feed.start();
  try {
    await hub.start({ wallet: "UserC", secret: "sC", settings: { bankrollUsd: 100 } });
    await hub.stop("UserC"); // halt("flatten", "user stop") is persisted in the user's store
    const again = await hub.start({ wallet: "UserC", secret: "sC", settings: { bankrollUsd: 100 } });
    assert.equal(again.ok, true);
    assert.equal(again.status.halt.mode, null, "the old user stop is gone: the bot judges tokens again");
    const p = await hub.pause("UserC");
    assert.equal(p.status.halt.mode, "freeze"); assert.match(p.status.halt.reason, /paused by user/);
    assert.equal(hub.status("UserC").running, true, "paused is still running: positions keep their exit plans");
    const r = hub.resume("UserC");
    assert.equal(r.status.halt.mode, null);
    assert.equal(hub.pause("Nobody") instanceof Promise, true); assert.equal((await hub.pause("Nobody")).ok, false);
  } finally { await hub.stopAll(); await feed.stop(); }
});

test("T11: the sweep sells every token in both wallets: open positions through the engine, the rest through the routers, graduated PONS reported", async () => {
  const root = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] }); feed.solPrice = 100;
  const ponsFeed = new ScriptedFeed({ venue: "pons", script: [] }); ponsFeed.solPrice = 2000;
  ponsFeed.rpc = {
    walletTokens: async () => [{ instrument: "0xheld", qty: 500 }, { instrument: "0xgrad", qty: 300 }, { instrument: "0xdust", qty: 0.2 }, { instrument: "0xrandom", qty: 10 }],
    launchInfo: async (t) => t === "0xheld" ? { curve: "0xcurve1", graduated: false } : t === "0xgrad" ? { curve: "0xcurve2", graduated: true } : null,
    curveInfo: async () => ({ quoteReserve: 3, tokenReserve: 9e8, feeBps: 100, creatorTaxBps: 0 }),
    blockNumber: async () => 5000,
    // the chain's logs: 0xrandom came from 0xcurve9, a curve the factory never mentioned; 0xair from nobody useful
    transfersTo: async (addr, { fromBlock, toBlock }) => ({ tokens: new Map([["0xrandom", new Set(["0xcurve9"])], ["0xair", new Set(["0xsomeone"])]]), scannedTo: toBlock, head: toBlock, done: true }),
    curveFor: async function (t, senders) { const i = await this.launchInfo(t); if (i) return { curve: i.curve, graduated: i.graduated, via: "factory" }; return senders.includes("0xcurve9") ? { curve: "0xcurve9", graduated: false, via: "transfer" } : null; },
  };
  const routers = {};
  class FakeEvm { constructor() { this.ready = false; this.address = "0xme"; this.known = new Set(); this.tokens = { "0xheld": 500, "0xgrad": 300 }; this.closed = []; }
    async init() { this.ready = true; return this.preflight(); } async preflight() { return { wallet: this.address, balanceSol: 0.05, quote: "ETH" }; } async health() { return { ok: true, latencyMs: 1 }; }
    track(t) { this.known.add(t); } async positions() { return [...this.known].filter(t => this.tokens[t] > 0).map(t => ({ instrument: t, qty: this.tokens[t] })); }
    async submit() { return failure({ id: "x" }, "UNUSED", ""); }
    async close(p, pct, ctx) { this.closed.push({ instrument: p.instrument, curve: ctx?.reference?.curve?.address }); this.tokens[p.instrument] = 0; return { ok: true, fill: { price: 0.00001, qty: 500, notional_usd: 12, fee_usd: 0, t_sent: 1, t_filled: 2, latency_ms: 1, venue_ref: "0xtx", sol_received: 0.006 } }; }
    async transferSol() { return "0xfee"; } }
  const hub = new VelocityHub({ feed, ponsFeed, rootDir: root, platformWallet: "PLATFORM_FRESH_WALLET", platformEvmWallet: "0x" + "1".repeat(40), fee: feeDeps("pro"), makeLiveRouter: ({ secret, wallet }) => (routers[wallet] = new FakeLive({ secret, wallet })), makePonsRouter: () => (routers.evm = new FakeEvm()), log: { log() {}, error() {}, warn() {} } });
  await feed.start(); await ponsFeed.start();
  try {
    await hub.start({ wallet: "UserS", secret: "sS", evmSecret: "0xkey", settings: { bankrollUsd: 100, pons: true } });
    // an open pump.fun position, plus a token the wallet holds that the store never tracked
    const now = Date.now();
    feed.emitEvent({ kind: "candidate", id: "MintX", payload: goodCandidatePayload("MintX"), t_venue: now - 100 });
    await new Promise(r => setTimeout(r, 50)); await hub.users.get("UserS").engine.enqueue(() => {});
    assert.equal(hub.users.get("UserS").engine.store.openPositions("pumpfun").length, 1);
    routers.UserS.tokens.MintOrphan = 2000;
    const r = await hub.sweepWallet("UserS", { secret: "sS", evmSecret: "0xkey" });
    assert.equal(r.ok, true);
    assert.equal(hub.users.get("UserS").engine.store.openPositions("pumpfun").length, 0, "the open position was closed through the engine");
    assert.ok(r.report.some(x => x.venue === "pumpfun" && x.instrument === "MintX" && x.ok && x.position), "booked as a position close");
    assert.ok(r.report.some(x => x.venue === "pumpfun" && x.instrument === "MintOrphan" && x.ok), "the orphan was sold straight through the router");
    assert.ok(routers.evm.closed.some(c => c.instrument === "0xheld" && c.curve === "0xcurve1"), "the RH holding was sold on its curve");
    assert.ok(r.report.some(x => x.instrument === "0xgrad" && x.code === "GRADUATED"), "a graduated curve is reported, not attempted");
    assert.ok(routers.evm.closed.some(c => c.instrument === "0xrandom" && c.curve === "0xcurve9"), "a token the factory never mentioned is sold on the curve that sent it to us");
    assert.ok(fs.existsSync(path.join(root, "UserS", "rh-scan.json")), "the scan is kept on disk");
    assert.ok(!r.report.some(x => x.instrument === "0xdust"), "dust is ignored");
    assert.equal(hub.users.get("UserS").engine.ledger.query({ kind: "exit", limit: 5 }).some(e => e.reason === "USER_SWEEP"), true);
    // The same sweep as a background job: the call returns at once, status follows it, a second call while it runs joins it.
    routers.UserS.tokens.MintOrphan2 = 2000; routers.evm.tokens["0xheld"] = 700;
    const j = hub.startSweep("UserS", { secret: "sS", evmSecret: "0xkey" });
    assert.equal(j.started, true); assert.equal(j.sweep.done, false);
    assert.equal(hub.startSweep("UserS", { secret: "sS", evmSecret: "0xkey" }).started, false, "one sweep at a time");
    for (let i = 0; i < 100 && !hub.status("UserS").sweep.done; i++) await new Promise(r => setTimeout(r, 20));
    const sv = hub.status("UserS").sweep;
    assert.equal(sv.done, true); assert.ok(sv.report.some(x => x.instrument === "MintOrphan2" && x.ok)); assert.ok(sv.report.some(x => x.instrument === "0xheld" && x.ok)); assert.equal(sv.current, null);
    // The holdings list: every token, its curve state, what a sell would fetch
    routers.evm.tokens["0xheld"] = 900; routers.UserS.tokens.MintOrphan3 = 50;
    const hl = await hub.listHoldings("UserS", { secret: "sS", evmSecret: "0xkey" });
    const heldRow = hl.eth.find(x => x.instrument === "0xheld"), gradRow = hl.eth.find(x => x.instrument === "0xgrad"), randRow = hl.eth.find(x => x.instrument === "0xrandom");
    assert.equal(heldRow.state, "curve"); assert.ok(heldRow.sellEth > 0); assert.equal(gradRow.state, "graduated"); assert.equal(randRow.state, "curve"); assert.equal(randRow.via, "transfer");
    assert.ok(hl.sol.some(x => x.instrument === "MintOrphan3" && x.qty === 50));
    // One holding by itself, tracked or not, through the router
    routers.evm.tokens["0xheld"] = 900;
    const one = await hub.sellHolding("UserS", { venue: "pons", instrument: "0xheld", evmSecret: "0xkey" });
    assert.equal(one.ok, true); assert.equal(one.received, 0.006); assert.equal(routers.evm.tokens["0xheld"], 0);
  } finally { await hub.stopAll(); await feed.stop(); await ponsFeed.stop(); }
});

test("T11: requireOwner will not act for a wallet the caller did not sign in as", async () => {
  const { makeRequireOwner, issueAuthToken } = await import("../../src/middleware/wallet-auth.mjs");
  const guard = makeRequireOwner({ adminSecret: "s3cret" });
  const run = (over) => new Promise(resolve => {
    const req = { headers: {}, body: {}, query: {}, params: {}, ...over };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b, req }); } };
    guard(req, res, () => resolve({ status: null, passed: true, req }));
  });
  const alice = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", bob = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const tok = issueAuthToken(alice, "free");
  const auth = { authorization: `Bearer ${tok}` };

  assert.equal((await run({ headers: {}, body: { wallet: alice } })).status, 401, "no token: refused");
  assert.equal((await run({ headers: { "x-wallet": alice }, body: { wallet: alice } })).status, 401, "a header is not ownership");
  assert.equal((await run({ headers: auth, body: { wallet: bob } })).status, 403, "signed in as alice, acting on bob: refused");
  assert.equal((await run({ headers: auth, query: { wallet: bob } })).status, 403, "the query string is checked too");

  const own = await run({ headers: auth, body: { wallet: alice } });
  assert.equal(own.passed, true); assert.equal(own.req.ownerWallet, alice);
  // A request that names no wallet resolves to the signed-in one rather than skipping the check.
  const implied = await run({ headers: auth, body: {} });
  assert.equal(implied.passed, true); assert.equal(implied.req.ownerWallet, alice);
  // The support key still works, and only that key.
  assert.equal((await run({ headers: { "x-admin-secret": "s3cret" }, body: { wallet: bob } })).passed, true);
  assert.equal((await run({ headers: { "x-admin-secret": "wrong" }, body: { wallet: bob } })).status, 401);

  // The two header-trusting middlewares are gone, not merely unused.
  const mod = await import("../../src/middleware/wallet-auth.mjs");
  assert.equal(mod.requireVerifiedWallet, undefined);
  assert.equal(mod.requireStrictAuth, undefined);
});

test("T11: the daily loss budget cannot silently overrule the position count", async () => {
  const { userEnvelope } = await import("../../src/velocity/hub.mjs");
  // worst_case_fraction is 1.0 on a memecoin, so the day's budget is also a concurrency limit.
  // On a $100 bankroll the default 15% budget is $25 -- exactly one $25 stake. Asking for four
  // positions used to leave the envelope saying four and the sizer refusing the second with
  // DAILY_BUDGET_EXHAUSTED, which reads like a bug rather than a setting.
  // $100 at $25 a trade: the day defaults to what four could lose ($100), capped at 35% ($35), which
  // funds one. A $25 stake is a quarter of this account -- the constraint is the stake, not the rule.
  const chunky = userEnvelope({ bankrollUsd: 100, perTradeMaxUsd: 25, maxPositions: 4 });
  assert.equal(chunky.daily_loss_limit_usd, 35);
  assert.equal(chunky.max_concurrent_positions, 1, "the envelope says what the budget can actually fund");
  assert.deepEqual(chunky.positions_capped_by_daily_budget, { asked: 4, allowed: 1, daily_loss_limit_usd: 35, per_trade_max_usd: 25 });
  assert.equal(chunky.portfolio_max_exposure_usd, 25, "exposure follows the real position count");

  // The same $100 at the $10 floor gets three positions for $30 of exposure -- more diversification
  // than the single $25 bet above, on less money at risk. That is what lowering the floor bought.
  const small = userEnvelope({ bankrollUsd: 100, maxPositions: 4 });
  assert.equal(small.per_trade_max_usd, 10);
  assert.equal(small.max_concurrent_positions, 3);
  assert.equal(small.portfolio_max_exposure_usd, 30);

  // Enough budget for the positions asked: nothing is capped and nothing is reported.
  const ok = userEnvelope({ bankrollUsd: 1000, perTradeMaxUsd: 25, maxPositions: 4 });
  assert.equal(ok.daily_loss_limit_usd, 100, "four $25 stakes, well under 35% of $1000");
  assert.equal(ok.max_concurrent_positions, 4);
  assert.equal(ok.positions_capped_by_daily_budget, undefined);

  // Naming a budget still overrides the default in both directions.
  const raised = userEnvelope({ bankrollUsd: 100, perTradeMaxUsd: 25, maxPositions: 4, dailyLossUsd: 100 });
  assert.equal(raised.max_concurrent_positions, 4);
  const tight = userEnvelope({ bankrollUsd: 1000, perTradeMaxUsd: 25, maxPositions: 4, dailyLossUsd: 30 });
  assert.equal(tight.max_concurrent_positions, 1);
});

test("T11: an alert reaches whatever the operator pasted, and a flaky receiver does not lose it", async () => {
  const { Alerter } = await import("../../src/velocity/core/alerts.mjs");
  const posts = [];
  const alerter = new Alerter({
    store: { alert: (level, text) => ({ level, text }) },
    ledger: { append: r => posts.push({ ledger: r }) },
    webhookUrl: "https://hooks.example.com/T000/B000",
    statusUrl: "https://bondli.up.railway.app",
    sleepImpl: async () => {},
    fetchImpl: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; },
  });
  const r = await alerter.send("error", "pumpfun is live but its router failed to initialize");
  assert.equal(r.delivered, true);
  const sent = posts.find(p => p.url).body;
  // Slack reads text, Discord reads content, ntfy reads message: one paste, any of the three.
  assert.ok(sent.text.includes("pumpfun is live"));
  assert.equal(sent.content, sent.text);
  assert.equal(sent.message, sent.text);
  assert.match(sent.text, /^\u{1F534} ERROR:/u, "an operator reading this on a phone sees the severity first");
  assert.ok(sent.text.includes("https://bondli.up.railway.app/halt"), "and can actually stop the bot from it");

  // A receiver that is briefly down: retried, not dropped.
  let calls = 0;
  const flaky = new Alerter({
    store: { alert: () => ({}) }, ledger: { append: () => {} },
    webhookUrl: "https://hooks.example.com/x", statusUrl: "", sleepImpl: async () => {},
    fetchImpl: async () => { calls++; if (calls < 3) throw new Error("ECONNRESET"); return { ok: true }; },
  });
  assert.equal((await flaky.send("warn", "governor froze entries")).delivered, true);
  assert.equal(calls, 3);

  // No URL configured: the alert still reaches the ledger, and says it was not delivered.
  const offline = new Alerter({ store: { alert: () => ({}) }, ledger: { append: r => posts.push({ ledger: r }) }, webhookUrl: null });
  const off = await offline.send("error", "flatten left 2 positions open");
  assert.equal(off.delivered, false);
  assert.equal(posts.at(-1).ledger.text, "flatten left 2 positions open");
});

test("T11: Robinhood Chain can be traded on its own, with no SOL funded at all", async () => {
  const { userEnvelope } = await import("../../src/velocity/hub.mjs");
  // Turning pump.fun off zeroes its exposure and its slots, exactly as PONS already did. A venue
  // with no exposure is never sized and never entered.
  const rhOnly = userEnvelope({ bankrollUsd: 300, maxPositions: 4, pumpfun: false, pons: true });
  assert.equal(rhOnly.venues.pumpfun.max_exposure_usd, 0);
  assert.equal(rhOnly.venues.pumpfun.max_concurrent, 0);
  assert.ok(rhOnly.venues.pons.max_exposure_usd > 0);
  assert.equal(rhOnly.venues.pons.max_concurrent, rhOnly.max_concurrent_positions);

  // The mirror image still works, and leaving it unsaid still means pump.fun is on.
  const solOnly = userEnvelope({ bankrollUsd: 300, maxPositions: 4, pons: false });
  assert.ok(solOnly.venues.pumpfun.max_exposure_usd > 0);
  assert.equal(solOnly.venues.pons.max_exposure_usd, 0);
  const both = userEnvelope({ bankrollUsd: 300, maxPositions: 4, pons: true });
  assert.ok(both.venues.pumpfun.max_exposure_usd > 0 && both.venues.pons.max_exposure_usd > 0);

  // The sizer refuses a venue with no exposure outright, so nothing can leak onto the chain that
  // was switched off -- not a probe, not a floor, not a reconciled adoption.
  const { Sizer } = await import("../../src/velocity/core/risk.mjs");
  const sizer = new Sizer(rhOnly);
  const d = (venue) => ({ venue, p_win: 0.45, payoff: 3, stop_fraction: 1 });
  const port = { open: [], realized_today_usd: 0 };
  assert.equal(sizer.size({ decision: d("pumpfun"), portfolio: port, throttle: 1 }).stake_usd, 0);
  assert.match(sizer.size({ decision: d("pumpfun"), portfolio: port, throttle: 1 }).reasons[0], /VENUE_DISABLED/);
  assert.ok(sizer.size({ decision: d("pons"), portfolio: port, throttle: 1 }).stake_usd > 0);
});

test("T11: a position the venue will not sell can be given up on, and the banner dismissed", async () => {
  const { Engine } = await import("../../src/velocity/core/engine.mjs");
  const { loadRiskEnvelope } = await import("../../src/velocity/core/risk.mjs");
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { PumpfunPaperRouter } = await import("../../src/velocity/venues/pumpfun/router.mjs");
  const fsx = await import("node:fs"), osx = await import("node:os"), px = await import("node:path");
  const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), "rel-"));
  const base = JSON.parse(fsx.readFileSync(px.resolve("src/velocity/config/risk.example.json"), "utf8"));
  const cfg = { ...base, bankroll_usd: 200, per_trade_max_usd: 25, portfolio_max_exposure_usd: 100, daily_loss_limit_usd: 100, max_concurrent_positions: 2 };
  cfg.venues = { ...base.venues, pumpfun: { ...base.venues.pumpfun, max_exposure_usd: 100, min_stake_usd: 10 }, polymarket: { ...base.venues.polymarket, max_exposure_usd: 0 } };
  fsx.writeFileSync(px.join(dir, "r.json"), JSON.stringify(cfg));
  const e = new Engine({ dataDir: dir, envelope: loadRiskEnvelope(px.join(dir, "r.json")),
    venues: { pumpfun: { mode: "paper", edge: makePumpfunEdge({ aggression: 1 }), router: new PumpfunPaperRouter({ bookFile: px.join(dir, "b.json"), latencyMs: 0 }) } } });
  let now = Date.now(); e.clock = () => now;
  await e.start({ reconcile: false });
  try {
    e.store.upsertPosition({ id: "stuck", venue: "pumpfun", instrument: "MintStuck", status: "open", paper: false,
      qty: 156551, remaining_qty: 156551, cost_usd: 10, notional_usd: 10, stake_usd: 10, proceeds_usd: 0,
      entryTime: now - 240_000, entryMark: 9000, tier: 2,
      lastExitError: { code: "REVERT", reason: "sell would revert (custom error 0x42301c23)", tried: "USER_SELL", at: now, count: 2 } });

    // Dismissing the banner touches nothing else: the position is still open and still held.
    assert.deepEqual(e.clearExitError("stuck"), { ok: true, cleared: true });
    assert.equal(e.store.state.positions.stuck.lastExitError, undefined);
    assert.equal(e.store.state.positions.stuck.status, "open");
    assert.deepEqual(e.clearExitError("stuck"), { ok: true, cleared: false }, "dismissing twice is harmless");

    // Giving up frees the slot without inventing a result.
    const before = e.store.state.day.realizedUsd;
    const r = e.releasePosition("stuck", { by: "user", note: "curve refuses every sell" });
    assert.deepEqual({ ok: r.ok, qty: r.qty, instrument: r.instrument }, { ok: true, qty: 156551, instrument: "MintStuck" });
    assert.equal(e.store.openPositions("pumpfun").length, 0, "the slot is free");
    assert.equal(e.store.state.day.realizedUsd, before, "no profit or loss is booked: nothing was realized");
    assert.equal(e.ledger.query({ kind: "outcome" }).length, 0, "and it is not counted as a trade");
    const exit = e.ledger.query({ kind: "exit", limit: 1 })[0];
    assert.equal(exit.reason, "RELEASED"); assert.equal(exit.released, true);
    assert.equal(exit.proceeds_usd, 0); assert.equal(exit.qty, 156551);
    assert.equal(exit.detail, "curve refuses every sell");
    // The statistics the governor and the learner read must not see it at all.
    assert.equal(Object.keys(e.modeStats()).length, 0);

    assert.equal(e.releasePosition("stuck").ok, false, "releasing twice is refused");
    assert.equal(e.releasePosition("nope").ok, false);
  } finally { await e.stop(); fsx.rmSync(dir, { recursive: true, force: true }); }
});

// Paper: the whole machine on the real feed, with only the fills simulated. What must hold is that
// it needs no funded wallet, can never reach a live router, and is never charged a fee -- and that
// it is still the same engine, so a paper run tells you something about a live one.
test("T11: a paper run trades the live feed with simulated money and cannot touch a real wallet", async () => {
  const root = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  feed.solPrice = 100;
  const routers = {};
  const deps = feeDeps("pro");
  // An empty wallet: a live start would be refused by the preflight before it placed anything.
  const hub = new VelocityHub({ feed, rootDir: root, platformWallet: "PLATFORM_FRESH_WALLET", fee: deps,
    makeLiveRouter: ({ secret, wallet }) => (routers[wallet] = new FakeLive({ secret, wallet, balanceSol: 0 })),
    log: { log() {}, error() {}, warn() {} } });
  await feed.start();
  try {
    const live = await hub.start({ wallet: "Broke", secret: "s0", settings: { bankrollUsd: 100 } });
    assert.equal(live.ok, false, "an empty wallet cannot start a live run");
    await hub.stop("Broke").catch(() => {});

    const r = await hub.start({ wallet: "Paper", secret: "s1", settings: { bankrollUsd: 100, paper: true } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.status.venues.pumpfun.mode, "paper", "the venue stays simulated");
    assert.equal(r.settings.paper, true, "and the panel can see that it did");

    // The same feed, the same gates: a candidate is judged and filled, just not with money.
    const now = Date.now();
    feed.emitEvent({ kind: "candidate", id: "MintP", payload: goodCandidatePayload("MintP"), t_venue: now - 100 });
    await new Promise(res => setTimeout(res, 50));
    const eng = hub.users.get("Paper").engine;
    const pos = eng.store.openPositions()[0];
    assert.ok(pos, "paper still buys: " + JSON.stringify(eng.funnel()));
    assert.equal(pos.paper, true);

    // Close it at a profit. The real day's ledger never moves and no fee is transferred.
    feed.emitEvent({ kind: "tick", id: "MintP", payload: tickPayload("MintP", 4_000), t_venue: now + 900 });
    await new Promise(res => setTimeout(res, 50));
    assert.equal(eng.store.openPositions().length, 0);
    assert.equal(eng.store.state.day.realizedUsd, 0, "simulated money never touches the real day");
    assert.ok(eng.store.state.day.paperTrades >= 1);
    assert.equal(routers.Paper?.transfers?.length ?? 0, 0, "no fee is taken on pretend profit");
  } finally { await hub.stop("Paper").catch(() => {}); await feed.stop(); }
});

// The fee is owed whether or not the transfer lands. A throw in transferSol used to vanish into the
// outcome handler's catch: no record, no retry, the money simply not collected.
test("T11: a fee whose transfer fails is recorded as owed and collected on the next close that works", async () => {
  const root = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  feed.solPrice = 100;
  const routers = {};
  const hub = new VelocityHub({ feed, rootDir: root, platformWallet: "PLATFORM_FRESH_WALLET", fee: feeDeps("pro"), makeLiveRouter: ({ secret, wallet }) => (routers[wallet] = new FakeLive({ secret, wallet })), log: { log() {}, error() {}, warn() {} } });
  await feed.start();
  try {
    const r = await hub.start({ wallet: "Owed", secret: "s", settings: { bankrollUsd: 100, aggression: 2 } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const live = routers.Owed;
    let fail = true;
    live.transferSol = async (to, sol) => { if (fail) throw new Error("blockhash not found"); live.transfers.push({ to, sol }); return "SIGLATE"; };
    const eng = hub.users.get("Owed").engine;
    const trade = async (id) => {
      const now = Date.now();
      feed.emitEvent({ kind: "candidate", id, payload: goodCandidatePayload(id), t_venue: now - 100 });
      await new Promise(res => setTimeout(res, 50)); await eng.enqueue(() => {});
      feed.emitEvent({ kind: "tick", id, payload: tickPayload(id, 17_000, { dynamics: { scores: 5, velocity: -0.6, acceleration: -0.2, trend: "crashing" } }), t_venue: now + 500 });
      await new Promise(res => setTimeout(res, 80)); await eng.enqueue(() => {}); await new Promise(res => setTimeout(res, 30));
    };
    await trade("MintOwe1");
    assert.deepEqual(live.transfers, [], "nothing moved");
    const owed = eng.ledger.query({ kind: "fee", limit: 3 }).find(f => f.collected === false);
    assert.ok(owed, "the fee is on the record as owed, with the reason");
    assert.equal(owed.owed_sol, 0.00095); assert.match(owed.error, /blockhash/);
    assert.equal(hub.status("Owed").owedFees.length, 1, "and the operator can see it");

    // The path works again: the next profitable close pays its own fee AND the one owed.
    fail = false;
    await trade("MintOwe2");
    assert.deepEqual(live.transfers.map(t => t.sol), [0.00095, 0.00095], "this trade's fee, then the owed one");
    assert.equal(hub.status("Owed").owedFees.length, 0);
    const late = eng.ledger.query({ kind: "fee", limit: 5 }).find(f => /collected late/.test(f.note || ""));
    assert.ok(late); assert.equal(late.venue_ref, "SIGLATE");
  } finally { await hub.stop("Owed").catch(() => {}); await feed.stop(); }
});

// The landing page's heartbeat is every bot's closes with no wallet named. Two things must hold: no
// record carries a wallet, and a paper close is never counted as money -- it would be the easiest
// way in the world to make the site look like it is winning.
test("T11: the public pulse names no wallet and counts no paper money", async () => {
  const root = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  feed.solPrice = 100;
  const routers = {};
  const hub = new VelocityHub({ feed, rootDir: root, platformWallet: "PLATFORM_FRESH_WALLET", fee: feeDeps("pro"), makeLiveRouter: ({ secret, wallet }) => (routers[wallet] = new FakeLive({ secret, wallet })), log: { log() {}, error() {}, warn() {} } });
  await feed.start();
  try {
    assert.deepEqual({ ...hub.pulse(), ts: 0 }, { bots: 0, live: 0, closes: 0, wins: 0, pnl_usd: 0, best: [], recent: [], tape: [], windowMs: 24 * 60 * 60_000, ts: 0 }, "an empty site has an empty pulse, not an invented one");
    const live = await hub.start({ wallet: "Real", secret: "s1", settings: { bankrollUsd: 100, aggression: 2 } });
    const paper = await hub.start({ wallet: "Pretend", secret: "s2", settings: { bankrollUsd: 100, aggression: 2, paper: true } });
    assert.ok(live.ok && paper.ok);
    const now = Date.now();
    feed.emitEvent({ kind: "candidate", id: "MintP", payload: goodCandidatePayload("MintP"), t_venue: now - 100 });
    await new Promise(res => setTimeout(res, 50));
    for (const w of ["Real", "Pretend"]) await hub.users.get(w).engine.enqueue(() => {});
    feed.emitEvent({ kind: "tick", id: "MintP", payload: tickPayload("MintP", 17_000, { dynamics: { scores: 5, velocity: -0.6, acceleration: -0.2, trend: "crashing" } }), t_venue: now + 500 });
    await new Promise(res => setTimeout(res, 80));
    for (const w of ["Real", "Pretend"]) await hub.users.get(w).engine.enqueue(() => {});
    const p = hub.pulse();
    assert.equal(p.bots, 2); assert.equal(p.live, 1, "the paper bot is a bot, not a live one");
    assert.equal(p.closes, 1, "the paper close is not a close that happened with money");
    for (const c of [...p.recent, ...p.best]) { assert.equal("wallet" in c, false); assert.equal(c.paper, false); assert.ok(c.instrument && Number.isFinite(c.pnl_pct)); }
    // The tape shows the paper close too, but flagged, and with nothing on it that sizes a bankroll
    // or points back at a person: no wallet, no position id, no dollar figure.
    assert.equal(p.tape.length, 2, "both closes are on the tape, newest first");
    assert.ok(p.tape[0].ts >= p.tape[1].ts);
    assert.deepEqual(p.tape.map(c => c.paper).sort(), [false, true], "the paper close is on the tape as paper");
    for (const c of p.tape) {
      assert.deepEqual(Object.keys(c).sort(), ["held_ms", "instrument", "paper", "pnl_pct", "reason", "ticker", "ts", "venue"]);
      assert.ok(Number.isFinite(c.pnl_pct) && Number.isFinite(c.held_ms));
    }
    const flat = JSON.stringify(p);
    assert.equal(flat.includes("Real"), false, "no wallet, anywhere in it");
    assert.equal(flat.includes("Pretend"), false);
    assert.doesNotMatch(flat, /"(wallet|user|positionId)"/, "no wallet, user or position id key anywhere in the pulse");
    // The user's own card sees their own closes, paper flagged as paper.
    const mine = hub.status("Pretend").status.closes;
    assert.equal(mine.length, 1); assert.equal(mine[0].paper, true);
  } finally { for (const w of ["Real", "Pretend"]) await hub.stop(w).catch(() => {}); await feed.stop(); }
});

test("T11: a live fill is called out once for the whole hub, with its tx; paper never; the close reports back; the public route names no wallet", async () => {
  const root = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] });
  feed.solPrice = 100;
  const posts = [];
  // The hub's own callouts object, with a fetch double in place of the webhook. minTier 0 so the
  // fixture's tier does not decide the test; the tier gate itself is T21's.
  const callouts = new Callouts({ ledger: new Ledger(path.join(root, "_hub", "callouts.jsonl")), channels: { webhookUrl: "https://hook.test/calls" }, minTier: 0, statusUrl: "https://bondli.fun",
    fetchImpl: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; } });
  const hub = new VelocityHub({ feed, rootDir: root, platformWallet: "PLATFORM_FRESH_WALLET", fee: feeDeps(), callouts, makeLiveRouter: ({ secret, wallet }) => new FakeLive({ secret, wallet }), log: { log() {}, error() {}, warn() {} } });
  assert.equal(hub.callouts, callouts, "the injected object is the hub's, not a second one");
  await feed.start();
  try {
    // Calls are the user's choice: A and B opted in, Pretend is paper (opted in, never posts), Quiet did not opt in.
    assert.equal((await hub.start({ wallet: "UserA", secret: "sA", settings: { bankrollUsd: 100, aggression: 2, callouts: true } })).ok, true);
    assert.equal((await hub.start({ wallet: "UserB", secret: "sB", settings: { bankrollUsd: 100, aggression: 2, callouts: true } })).ok, true);
    assert.equal((await hub.start({ wallet: "Pretend", secret: "sP", settings: { bankrollUsd: 100, aggression: 2, paper: true, callouts: true } })).ok, true);
    assert.equal((await hub.start({ wallet: "Quiet", secret: "sQ", settings: { bankrollUsd: 100, aggression: 2 } })).ok, true);
    assert.equal(hub.status("Quiet").settings.callouts, false, "off unless they said so");
    const now = Date.now();
    feed.emitEvent({ kind: "candidate", id: "MintX", payload: goodCandidatePayload("MintX"), t_venue: now - 100 });
    await new Promise(r => setTimeout(r, 60));
    for (const w of ["UserA", "UserB", "Pretend", "Quiet"]) { await hub.users.get(w).engine.enqueue(() => {}); assert.equal(hub.users.get(w).engine.store.openPositions("pumpfun").length, 1, `${w} holds MintX`); }
    await new Promise(r => setTimeout(r, 20));
    // Four engines bought the same token; two live and opted in, one paper, one quiet. One call, carrying the buy's own tx.
    assert.equal(posts.length, 1, JSON.stringify(posts));
    assert.match(JSON.stringify(posts[0].body), /SIGBUY/);
    assert.equal(hub.users.get("UserA").engine.store.openPositions("pumpfun")[0].venue_ref, "SIGBUY", "the position remembers its buy tx");
    const feedRows = callouts.feed();
    assert.equal(feedRows.length, 1); assert.equal(feedRows[0].tx, "SIGBUY"); assert.equal(feedRows[0].instrument, "MintX"); assert.equal(feedRows[0].result, null);
    assert.equal(callouts.status().skipped.paper, 1, "the paper engine's fill was offered and refused");
    // The anchor is in the hub's own ledger, before any post.
    assert.ok(fs.existsSync(path.join(root, "_hub", "callouts.jsonl")));
    // The close reports back and the record resolves.
    feed.emitEvent({ kind: "tick", id: "MintX", payload: tickPayload("MintX", 17_000, { dynamics: { scores: 5, velocity: -0.6, acceleration: -0.2, trend: "crashing" } }), t_venue: now + 500 });
    await new Promise(r => setTimeout(r, 80));
    for (const w of ["UserA", "UserB", "Pretend", "Quiet"]) await hub.users.get(w).engine.enqueue(() => {});
    await new Promise(r => setTimeout(r, 40));
    // Four closes on the token; only the called fill's own close is its result.
    assert.equal(callouts.record().resolved, 1, JSON.stringify(callouts.record()));
    assert.ok(posts.length >= 2, "the result was posted");
    assert.ok(callouts.feed()[0].result && Number.isFinite(callouts.feed()[0].result.pnl_pct));
    // The public route: the same rows, and nothing in them names a user.
    const routes = {}; const app = { get: (p, ...h) => { routes[p] = h.at(-1); }, post: () => {} };
    mountVelocityRoutes(app, { hub, requireOwner: (q, s, n) => n(), getTradingWallet: async () => null });
    let out = null; routes["/api/callouts"]({ query: { limit: "5" } }, { set() {}, json: b => { out = b; } });
    assert.equal(out.ok, true); assert.equal(out.calls.length, 1); assert.equal(out.calls[0].tx, "SIGBUY"); assert.equal(out.record.calls, 1);
    const text = JSON.stringify(out);
    assert.doesNotMatch(text, /UserA|UserB|Pretend|wallet/i, "no wallet and no user in the public record");
  } finally { await hub.stopAll(); await feed.stop(); }
});

test("T11: Arc trades on the same EVM key with USDC as the quote; its open position is swept through the engine and the fee leaves in USDC", async () => {
  const root = tmp();
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] }); feed.solPrice = 100;
  const arcFeed = new ScriptedFeed({ venue: "arc", script: [] }); arcFeed.solPrice = 1;
  const routers = {};
  class FakeArc { constructor({ secret }) { this.secret = secret; this.ready = false; this.address = "0xarcme"; this.known = new Set(); this.tokens = {}; this.transfers = []; this.closed = []; }
    async init() { this.ready = true; return this.preflight(); } async preflight() { return { wallet: this.address, balanceSol: 40, balanceUsdc: 40, quote: "USDC", chainId: 5042 }; } async health() { return { ok: true, latencyMs: 1 }; }
    track(t) { this.known.add(t); } async positions() { return [...this.known].filter(t => this.tokens[t] > 0).map(t => ({ instrument: t, qty: this.tokens[t] })); }
    async submit(o) { const t = Date.now(); this.tokens[o.instrument] = 1000; return { ok: true, fill: { orderId: o.id, decisionId: o.decisionId, venue: "arc", instrument: o.instrument, side: "BUY", price: 0.01, qty: 1000, notional_usd: 10, fee_usd: 0.3, t_sent: t, t_filled: t + 3, latency_ms: 3, venue_ref: "0xbuy", sol_spent: 10 } }; }
    async close(p) { this.closed.push(p.instrument); this.tokens[p.instrument] = 0; const t = Date.now(); return { ok: true, fill: { price: 0.014, qty: 1000, notional_usd: 14, fee_usd: 0, t_sent: t, t_filled: t + 3, latency_ms: 3, venue_ref: "0xsell", sol_received: 14 } }; }
    async transferSol(to, amount) { this.transfers.push({ to, amount }); return "0xfee"; } }
  const hub = new VelocityHub({ feed, arcFeed, rootDir: root, platformWallet: "PLATFORM_FRESH_WALLET", platformEvmWallet: "0x" + "2".repeat(40), fee: feeDeps(), makeLiveRouter: ({ secret, wallet }) => new FakeLive({ secret, wallet }), makeArcRouter: ({ secret }) => (routers.arc = new FakeArc({ secret })), log: { log() {}, error() {}, warn() {} } });
  await feed.start(); await arcFeed.start();
  try {
    // Arc alone, pump.fun off: the SOL wallet is never asked to fund anything.
    const s = await hub.start({ wallet: "UserArc", secret: "sA", evmSecret: "0xkey", settings: { bankrollUsd: 100, aggression: 2, pumpfun: false, arc: true } });
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.status.venues.arc.mode, "live"); assert.equal(s.status.venues.pumpfun?.mode ?? "off", "off");
    assert.equal(routers.arc.secret, "0xkey", "the Arc router signs with the EVM key");
    assert.equal(s.settings.arc, true);
    // Without the feed on the site, or without the key, Arc is not offered at all.
    const noKey = new VelocityHub({ feed, arcFeed, rootDir: tmp(), platformWallet: "P", fee: feeDeps(), makeLiveRouter: ({ secret, wallet }) => new FakeLive({ secret, wallet }), makeArcRouter: () => new FakeArc({}), log: { log() {}, error() {}, warn() {} } });
    const r0 = await noKey.start({ wallet: "NoKey", secret: "s", settings: { bankrollUsd: 100, pumpfun: false, arc: true } });
    assert.equal(r0.ok, false); assert.match(r0.error, /turn on at least one chain/);
    // A candidate on the Arc feed, priced in dollars: the engine buys through the Arc router.
    const now = Date.now();
    const payload = { ...goodCandidatePayload("0xjeff"), solPrice: 1, quote: "USDC", mcapUsd: 18_000, vSolInBondingCurve: 18_000,
      curve: { address: "0xpool", hook: "0xhook", quoteReserve: 18_000, tokenReserve: 8e8, feeBps: 300, sellTaxBps: 300, creatorTaxBps: 0, poolFeeBps: 100, native: false, progress: 0.2, bonded: false } };
    // Curve venues say where they are; without this the gate reads 18,000 as SOL on a pump.fun curve and calls it too late.
    payload.token.vSolInBondingCurve = 18_000; payload.token._curvePct = 0.2;
    arcFeed.emitEvent({ kind: "candidate", id: "0xjeff", payload, t_venue: now - 100 });
    await new Promise(r => setTimeout(r, 60));
    const e = hub.users.get("UserArc").engine; await e.enqueue(() => {});
    const open = e.store.openPositions("arc");
    assert.equal(open.length, 1, `arc position expected; funnel ${JSON.stringify(e.funnel())}`);
    assert.equal(open[0].venue_ref, "0xbuy"); assert.equal(open[0].paper, false);
    // The sweep closes it through the engine (so the ledger sees it) and the fee on the profit leaves as USDC to the EVM fee wallet.
    const sw = await hub.sweepWallet("UserArc", { secret: "sA", evmSecret: "0xkey" });
    assert.equal(sw.ok, true);
    assert.equal(e.store.openPositions("arc").length, 0);
    assert.ok(sw.report.some(x => x.venue === "arc" && x.instrument === "0xjeff" && x.ok && x.position), JSON.stringify(sw.report));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(routers.arc.transfers.length, 1, "one fee transfer");
    assert.equal(routers.arc.transfers[0].to, "0x" + "2".repeat(40), "to the EVM fee wallet, not the Solana one");
    assert.ok(routers.arc.transfers[0].amount > 0 && routers.arc.transfers[0].amount < 1, `5% of the $4 profit in USDC: ${routers.arc.transfers[0].amount}`);
    const feeRec = e.ledger.query({ kind: "fee", limit: 1 })[0];
    assert.equal(feeRec.venue, "arc");
    // Holdings list the Arc side under its own key; a leftover token the wallet holds can be sold by hand.
    routers.arc.tokens["0xstray"] = 500; routers.arc.track("0xstray");
    const h = await hub.listHoldings("UserArc", { secret: "sA", evmSecret: "0xkey" });
    assert.ok(h.usdc.some(x => x.venue === "arc" && x.instrument === "0xstray" && x.qty === 500 && !x.tracked), JSON.stringify(h));
    const sold = await hub.sellHolding("UserArc", { venue: "arc", instrument: "0xSTRAY", secret: "sA", evmSecret: "0xkey" });
    assert.equal(sold.ok, true); assert.ok(routers.arc.closed.includes("0xstray"), "sold through the Arc router, address lower-cased");
  } finally { await hub.stopAll(); await feed.stop(); await arcFeed.stop(); }
});

test("T11: the hub tells the activity gate how many bots run, on every start and stop", async () => {
  const feed = new ScriptedFeed({ venue: "pumpfun", script: [] }); feed.solPrice = 100; await feed.start();
  const counts = [];
  const hub = new VelocityHub({ feed, rootDir: tmp(), platformWallet: "P", fee: feeDeps(), onUsers: n => counts.push(n), makeLiveRouter: ({ secret, wallet }) => new FakeLive({ secret, wallet }), log: { log() {}, error() {}, warn() {} } });
  try {
    assert.equal((await hub.start({ wallet: "A", secret: "s", settings: { bankrollUsd: 100, paper: true } })).ok, true);
    assert.equal((await hub.start({ wallet: "B", secret: "s", settings: { bankrollUsd: 100, paper: true } })).ok, true);
    await hub.stop("A");
    assert.deepEqual(counts, [1, 2, 1]);
  } finally { await hub.stopAll(); await feed.stop(); }
  assert.deepEqual(counts, [1, 2, 1, 0], "stopAll reports zero: the gate can idle");
});
