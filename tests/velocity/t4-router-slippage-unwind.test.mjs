// T4: slippage cap honored on modeled fills; a two-leg order with one failing
// leg unwinds inside T_unwind; the paper book survives as venue truth;
// live routers refuse cleanly without keys or packages.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PumpfunPaperRouter, PumpfunLiveRouter, curveBuy, curveSell, reservesFromReference, tradeLocalBody } from "../../src/velocity/venues/pumpfun/router.mjs";
import { PolymarketPaperRouter, PolymarketLiveRouter, walkBook } from "../../src/velocity/venues/polymarket/router.mjs";
import { PerpsRouter } from "../../src/velocity/venues/perps/stub.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "velocity-t4-"));

test("T4: bonding-curve math is exact and symmetric", () => {
  const res = { vSol: 30, vTokens: 1_073_000_000 };
  const b = curveBuy(res, 1);
  assert.ok(b.tokensOut > 0 && b.slippage_bps > 0);
  const after = { vSol: 31, vTokens: res.vTokens - b.tokensOut };
  const s = curveSell(after, b.tokensOut);
  assert.ok(Math.abs(s.solOut - 1) < 1e-9, "selling back returns the SOL");
  const r = reservesFromReference({ vSolInBondingCurve: 40, mcapUsd: 9000, solPrice: 150 });
  assert.ok(Math.abs(r.vSol / r.vTokens - 60 / 1e9) < 1e-15, "spot derived from mcap");
});

test("T4: pump.fun paper fill honors the slippage cap with nothing at risk", async () => {
  const dir = tmp();
  let t = 1000;
  const router = new PumpfunPaperRouter({ bookFile: path.join(dir, "book.json"), clock: () => (t += 1), latencyMs: 0 });
  const ref = { vSolInBondingCurve: 30, mcapUsd: 4500, solPrice: 150 };
  const small = await router.submit({ id: "o1", decisionId: "d1", instrument: "MintA", side: "BUY", stake_usd: 15, max_slippage_bps: 300, reference: ref });
  assert.equal(small.ok, true);
  assert.ok(small.fill.slippage_bps > 0 && small.fill.slippage_bps <= 300);
  assert.ok(small.fill.qty > 0);
  const big = await router.submit({ id: "o2", decisionId: "d2", instrument: "MintB", side: "BUY", stake_usd: 3000, max_slippage_bps: 300, reference: ref });
  assert.equal(big.ok, false);
  assert.equal(big.failure.code, "SLIPPAGE_CAP");
  const pos = await router.positions();
  assert.equal(pos.length, 1, "the capped order left nothing in the book");
  const reopened = new PumpfunPaperRouter({ bookFile: path.join(dir, "book.json"), clock: () => 9999 });
  assert.equal((await reopened.positions())[0].instrument, "MintA", "paper book persists as venue truth");
  const closed = await reopened.close({ id: "p1", instrument: "MintA", notional_usd: 15 }, 100, { reference: ref });
  assert.equal(closed.ok, true);
  assert.equal((await reopened.positions()).length, 0);
});

test("T4: polymarket book walk and thin-book rejection", () => {
  const asks = [{ price: 0.96, size: 10 }, { price: 0.97, size: 100 }];
  const r = walkBook(asks, "BUY", 50);
  assert.ok(r.price > 0.96 && r.price < 0.97);
  assert.ok(r.slippage_bps > 0 && r.slippage_bps < 110);
  const thin = walkBook(asks, "BUY", 5000);
  assert.equal(thin.reject, "NO_LIQUIDITY");
});

test("T4: two-leg order with a failing leg unwinds the filled leg inside T_unwind", async () => {
  const dir = tmp();
  let t = 5000;
  const router = new PolymarketPaperRouter({ bookFile: path.join(dir, "book.json"), clock: () => (t += 50), latencyMs: 0, unwindBudgetMs: 2000 });
  const good = { book: { bids: [{ price: 0.29, size: 500 }], asks: [{ price: 0.31, size: 500 }] } };
  const thin = { book: { bids: [], asks: [{ price: 0.31, size: 1 }] } };
  const r = await router.submit({ id: "set1", decisionId: "dS", instrument: "group:G:yes", side: "BUY", max_slippage_bps: 50, legs: [
    { instrument: "C1Y", side: "BUY", stake_usd: 30, reference: good },
    { instrument: "C2Y", side: "BUY", stake_usd: 30, reference: thin },
    { instrument: "C3Y", side: "BUY", stake_usd: 30, reference: good },
  ] });
  assert.equal(r.ok, false);
  assert.equal(r.failure.code, "LEG_FAILED");
  assert.equal(r.failure.leg, "C2Y");
  assert.equal(r.unwound.length, 1);
  assert.equal(r.unwound[0].instrument, "C1Y");
  assert.equal(r.unwound[0].side, "SELL");
  assert.ok(r.failure.t_unwind_ms <= 2000 && r.failure.within_budget);
  assert.equal((await router.positions()).length, 0, "no partial leg survives");
  const ok = await router.submit({ id: "set2", decisionId: "dS2", instrument: "group:G:yes", side: "BUY", max_slippage_bps: 50, legs: [
    { instrument: "C1Y", side: "BUY", stake_usd: 30, reference: good },
    { instrument: "C3Y", side: "BUY", stake_usd: 30, reference: good },
  ] });
  assert.equal(ok.ok, true);
  assert.equal(ok.fills.length, 2);
  assert.equal((await router.positions()).length, 2);
});

test("T4: live routers refuse without keys or packages; perps stub refuses always", async () => {
  await assert.rejects(() => new PumpfunLiveRouter({ secret: "" }).init(), /MASTER_SEED/);
  const pf = new PumpfunLiveRouter({ secret: "x" });
  const r = await pf.submit({ id: "o", instrument: "M", stake_usd: 1 });
  assert.equal(r.failure.code, "NOT_READY");
  await assert.rejects(() => new PolymarketLiveRouter({ privateKey: "" }).init(), /POLYMARKET_PRIVATE_KEY/);
  await assert.rejects(() => new PolymarketLiveRouter({ privateKey: "0x" + "1".repeat(64) }).init(), /clob-client|ethers/);
  await assert.rejects(() => new PerpsRouter().submit({}), /disabled/);
});

test("T4: live pump.fun router builds the PumpPortal request bondli itself uses, and maps failures", async () => {
  const buy = tradeLocalBody({ publicKey: "PK", action: "buy", mint: "M", amount: 0.05, denominatedInSol: true, slippagePct: 3, priorityFeeSol: 0.0005 });
  assert.deepEqual(buy, { publicKey: "PK", action: "buy", mint: "M", amount: 0.05, denominatedInSol: "true", slippage: 3, priorityFee: 0.0005, pool: "auto" });
  const sell = tradeLocalBody({ publicKey: "PK", action: "sell", mint: "M", amount: "100%", denominatedInSol: false, slippagePct: 15, priorityFeeSol: 0.0005 });
  assert.equal(sell.amount, "100%"); assert.equal(sell.denominatedInSol, "false");

  // A router with a fake wallet and a builder that answers 400: nothing is sent, failure is explicit.
  const calls = [];
  const r = new PumpfunLiveRouter({ secret: "x", fetchImpl: async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: false, status: 400, text: async () => "bad mint" }; } });
  r.ready = true; r.publicKey = "PK"; r.keypair = { publicKey: "PK" }; r.web3 = { PublicKey: class { constructor(v) { this.v = v; } }, VersionedTransaction: { deserialize() { throw new Error("should not reach") } } };
  r.connection = { getBalance: async () => 5e9, getParsedTokenAccountsByOwner: async () => ({ value: [] }) };
  const res = await r.submit({ id: "o1", instrument: "MintZ", stake_usd: 5, max_slippage_bps: 300, reference: { vSolInBondingCurve: 30, mcapUsd: 4500, solPrice: 100, solPriceAt: Date.now() } });
  assert.equal(res.ok, false);
  assert.equal(res.failure.code, "SEND_FAILED");
  assert.match(res.failure.reason, /trade builder 400/);
  assert.equal(calls[0].action, "buy"); assert.equal(calls[0].amount, 0.05); assert.equal(calls[0].denominatedInSol, "true");

  // Not enough SOL: refused before any network call.
  const poor = new PumpfunLiveRouter({ secret: "x", fetchImpl: async () => { throw new Error("must not be called"); } });
  poor.ready = true; poor.publicKey = "PK"; poor.keypair = { publicKey: "PK" }; poor.web3 = { PublicKey: class { constructor(v) { this.v = v; } } };
  poor.connection = { getBalance: async () => 1e6, getParsedTokenAccountsByOwner: async () => ({ value: [] }) };
  const p = await poor.submit({ id: "o2", instrument: "MintZ", stake_usd: 5, max_slippage_bps: 300, reference: { vSolInBondingCurve: 30, mcapUsd: 4500, solPrice: 100, solPriceAt: Date.now() } });
  assert.equal(p.failure.code, "INSUFFICIENT_SOL");
});

test("T4: live routers resolve keys at init, so a key loaded after construction is still found", async () => {
  const had = process.env.MASTER_SEED;
  delete process.env.MASTER_SEED;
  try {
    const r = new PumpfunLiveRouter({});
    process.env.MASTER_SEED = "x"; // arrives after construction, as with dotenv loaded by the entrypoint
    await assert.rejects(() => r.init(), (err) => !/MASTER_SEED/.test(err.message), "the key was seen; only the fake value fails");
    const explicit = new PumpfunLiveRouter({ secret: "" });
    await assert.rejects(() => explicit.init(), /MASTER_SEED/, "an explicit empty key is not silently replaced");
  } finally {
    if (had == null) delete process.env.MASTER_SEED; else process.env.MASTER_SEED = had;
  }
});
