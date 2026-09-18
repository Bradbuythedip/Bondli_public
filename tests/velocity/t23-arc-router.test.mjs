// The Arc router against a fake chain: paper fills carry the hook's taxes (the snipe tax at order
// time included), a live buy is dry-run and then sent through the UniversalRouter with the right
// command bytes and price floor, a revert in the dry run costs no gas and comes back with its
// reason, a buy inside the snipe window is refused, a sell never offers minOut 0 and shrinks the
// order before widening the price, a wallet's own sale is found on the PoolManager, and the
// platform fee leaves on the native face of USDC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonRpcProvider, Interface, AbiCoder, Transaction, zeroPadValue } from "ethers";
import { ArcLiveRouter, ArcPaperRouter, arcFillModel, encodeV4Swap, decodeV4Swap, poolKeyFor, SNIPE_REFUSE_MS, UNIVERSAL_ROUTER_ABI, PERMIT2_ABI, ROUTER_ERRORS_ABI } from "../../src/velocity/venues/arc/router.mjs";
import {
  CHAIN_ID, PORTALS, POOL_MANAGER, STATE_VIEW, UNIVERSAL_ROUTER, PERMIT2, USDC_ERC20, QUOTE_IS_NATIVE, SNIPE_TAX_WINDOW_MS, TOKEN_SUPPLY,
  PORTAL_ABI, HOOK_ABI, STATE_VIEW_ABI, ERC20_ABI, TOPICS, poolIdFor, liquidityForSupply, sqrtRatioAtTick, sqrtRatioToX96, tickFromSqrtPriceX96, quoteBuy, quoteSell, snipeTaxBps,
} from "../../src/velocity/venues/arc/chain.mjs";

// The suite is offline by construction. These routers read an explorer and a public signature
// database to turn a bare revert selector into a name -- best effort, never load-bearing. Left
// to the real fetch, this file passes or fails on somebody else's uptime: the selector 0xdeadbeef
// below actually resolves to a name on api.openchain.xyz, so the "nobody can name it" case only
// happened on a machine with no internet.
const offline = async () => { throw new Error("offline: the test suite makes no network calls"); };

const addr = n => "0x" + n.toString(16).padStart(40, "0");
const coder = AbiCoder.defaultAbiCoder();
const portalI = new Interface(PORTAL_ABI), hookI = new Interface(HOOK_ABI), svI = new Interface(STATE_VIEW_ABI), erc = new Interface(ERC20_ABI), urI = new Interface(UNIVERSAL_ROUTER_ABI), p2I = new Interface(PERMIT2_ABI), errI = new Interface(ROUTER_ERRORS_ABI);
const KEY = "0x" + "7".repeat(64);
// The launch as Portal #7 makes it: $5,000 opening mcap to a $45,000 bond, the whole supply in one
// position, the token as currency0 (its address is below the USDC view's).
const TOKEN = addr(0x11), HOOK = addr(0x44), LOCKER = addr(0x33), SPLITTER = addr(0x55), DEV = addr(0x22);
const TICK_START = -398400, TICK_BOND = -376400;
const POOL = poolIdFor({ token: TOKEN, hook: HOOK }).toLowerCase();
const LIQ = BigInt(Math.round(liquidityForSupply({ tickStart: TICK_START, tickBond: TICK_BOND, tokenIs0: true })));
const BAL = 999_999_999_999_999_999_999_999n; // just under 1,000,000 tokens: as a float it rounds UP to 1e24 units
const usdcUnits = (u) => BigInt(Math.round(u * 1e6));
const revert = (msg) => { const e = new Error("execution reverted: " + msg); e.code = 3; e.data = "0x08c379a0" + coder.encode(["string"], [msg]).slice(2); return e; };
const custom = (data, msg = "execution reverted (unknown custom error)") => { const e = new Error(msg); e.code = 3; e.data = data; return e; };

/** The chain in memory: answers the calls the router makes, records the transactions it sends. */
class FakeChain extends JsonRpcProvider {
  constructor(state) { super("http://fake", { chainId: CHAIN_ID, name: "arc" }, { staticNetwork: true }); this.s = state; this.sent = []; this.calls = []; }
  pool() { return { sqrtPriceX96: BigInt(this.s.sqrt), liquidity: Number(LIQ), tickStart: TICK_START, tickBond: TICK_BOND, buyTaxBps: 300, sellTaxBps: 500, snipeBps: 0, tokenIs0: true }; }
  async _send(payloads) {
    const out = [];
    for (const p of Array.isArray(payloads) ? payloads : [payloads]) {
      try { out.push({ id: p.id, jsonrpc: "2.0", result: await this.rpc(p.method, p.params || []) }); }
      catch (e) { out.push({ id: p.id, jsonrpc: "2.0", error: { code: e.code || -32000, message: e.message, data: e.data } }); }
    }
    return out;
  }
  async rpc(method, params) {
    const s = this.s;
    if (method === "eth_chainId") return "0x" + CHAIN_ID.toString(16);
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_getBalance") return "0x" + s.native.toString(16);
    if (method === "eth_getCode") return String(params[0]).toLowerCase() === PERMIT2.toLowerCase() && s.permit2Deployed ? "0x6080604052" : "0x";
    if (method === "eth_getTransactionCount") return "0x" + this.sent.length.toString(16);
    if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
    if (method === "eth_getBlockByNumber") return { number: "0x10", hash: "0x" + "b".repeat(64), timestamp: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x3b9aca00", miner: "0x" + "0".repeat(40), transactions: [], parentHash: "0x" + "0".repeat(64), nonce: "0x0000000000000000", difficulty: "0x0", extraData: "0x" };
    if (method === "eth_call" || method === "eth_estimateGas") {
      const tx = params[0], to = String(tx.to).toLowerCase(), data = tx.data;
      this.calls.push({ method, to, data });
      if (PORTALS.some(p => p.address.toLowerCase() === to)) {
        const f = portalI.parseTransaction({ data });
        assert.equal(f.name, "launches");
        // Only Portal #7 knows the token; every other Portal answers an empty record (hook = 0).
        const known = String(f.args[0]).toLowerCase() === TOKEN && to === PORTALS[0].address.toLowerCase();
        return portalI.encodeFunctionResult("launches", [known ? DEV : addr(0), known ? TICK_START : 0, known, known ? LOCKER : addr(0), known ? HOOK : addr(0), known ? SPLITTER : addr(0), 300, 500, 1n, known ? TICK_BOND : 0, known ? USDC_ERC20 : addr(0)]);
      }
      if (to === STATE_VIEW.toLowerCase()) {
        const f = svI.parseTransaction({ data });
        assert.equal(String(f.args[0]).toLowerCase(), POOL, "the pool id the router reads is the launch's");
        if (f.name === "getSlot0") return svI.encodeFunctionResult("getSlot0", [BigInt(s.sqrt), tickFromSqrtPriceX96(BigInt(s.sqrt)), 0, 10000]);
        if (f.name === "getLiquidity") return svI.encodeFunctionResult("getLiquidity", [LIQ]);
      }
      if (to === HOOK) {
        const f = hookI.parseTransaction({ data });
        if (f.name === "buyTaxBps") return hookI.encodeFunctionResult("buyTaxBps", [300]);
        if (f.name === "sellTaxBps") return hookI.encodeFunctionResult("sellTaxBps", [500]);
        if (f.name === "launchedAt") return hookI.encodeFunctionResult("launchedAt", [BigInt(Math.floor(s.launchedAtMs / 1000))]);
        if (f.name === "currentSnipeTaxBps") return hookI.encodeFunctionResult("currentSnipeTaxBps", [BigInt(snipeTaxBps(s.nowMs() - s.launchedAtMs))]);
        if (f.name === "tickStart") return hookI.encodeFunctionResult("tickStart", [TICK_START]);
        if (f.name === "tickBond") return hookI.encodeFunctionResult("tickBond", [TICK_BOND]);
      }
      if (to === USDC_ERC20.toLowerCase() || to === TOKEN) {
        const f = erc.parseTransaction({ data });
        const bal = to === TOKEN ? s.tokenBalance : s.native / 10n ** 12n; // the same money on its 6-decimal face
        if (f.name === "balanceOf") return erc.encodeFunctionResult("balanceOf", [bal]);
        if (f.name === "allowance") { assert.equal(String(f.args[1]).toLowerCase(), PERMIT2.toLowerCase(), "the ERC-20 is approved to Permit2, never to the router"); return erc.encodeFunctionResult("allowance", [s.erc20Allowance[to] || 0n]); }
        if (f.name === "approve") return erc.encodeFunctionResult("approve", [true]);
      }
      if (to === PERMIT2.toLowerCase()) {
        const f = p2I.parseTransaction({ data });
        if (f.name === "allowance") { assert.equal(String(f.args[2]).toLowerCase(), UNIVERSAL_ROUTER.toLowerCase()); const a = s.permit2Allowance[String(f.args[1]).toLowerCase()]; return p2I.encodeFunctionResult("allowance", [a ? a.amount : 0n, a ? a.expiration : 0n, 0n]); }
        if (f.name === "approve") return method === "eth_estimateGas" ? "0xc350" : "0x";
      }
      if (to === UNIVERSAL_ROUTER.toLowerCase()) {
        const f = urI.parseTransaction({ data, value: tx.value ? BigInt(tx.value) : 0n });
        assert.equal(f.name, "execute");
        const sw = decodeV4Swap(f.args[0], f.args[1]);
        assert.ok(sw, "one V4_SWAP command");
        const buy = String(sw.take.currency).toLowerCase() === TOKEN;
        s.swapsSeen.push({ method, side: buy ? "BUY" : "SELL", ...sw, value: tx.value ? BigInt(tx.value) : 0n, deadline: Number(f.args[2]) });
        this.simulate(sw, buy);
        return method === "eth_estimateGas" ? "0x50000" : "0x";
      }
      throw new Error(`unexpected ${method} to ${to} ${String(data).slice(0, 10)}`);
    }
    if (method === "eth_sendRawTransaction") {
      const tx = Transaction.from(params[0]); const hash = tx.hash; this.sent.push(tx);
      const to = String(tx.to).toLowerCase();
      if (to === USDC_ERC20.toLowerCase() || to === TOKEN) { s.erc20Allowance[to] = 2n ** 255n; s.receipts[hash] = this.receipt(hash, to, []); }
      else if (to === PERMIT2.toLowerCase()) { const f = p2I.parseTransaction({ data: tx.data }); s.permit2Allowance[String(f.args[0]).toLowerCase()] = { amount: BigInt(f.args[2]), expiration: BigInt(f.args[3]) }; s.receipts[hash] = this.receipt(hash, to, []); }
      else if (to === UNIVERSAL_ROUTER.toLowerCase()) {
        const f = urI.parseTransaction({ data: tx.data, value: tx.value }); const sw = decodeV4Swap(f.args[0], f.args[1]);
        const buy = String(sw.take.currency).toLowerCase() === TOKEN;
        const { swapLog, taxLog } = this.simulate(sw, buy, true);
        s.receipts[hash] = this.receipt(hash, to, [taxLog, swapLog]);
      }
      else if (s.native > 0n) { s.native -= tx.value; s.transfers.push({ to, value: tx.value, gasLimit: tx.gasLimit }); s.receipts[hash] = this.receipt(hash, to, []); }
      return hash;
    }
    if (method === "eth_getTransactionReceipt") return this.s.receipts[params[0]] || null;
    throw new Error("unexpected rpc " + method);
  }
  /** The pool's own answer to a swap: reverts the way the router or the hook would, and when
   *  `apply` is set moves the price and the balances the way the chain would. */
  simulate(sw, buy, apply = false) {
    const s = this.s, pool = this.pool();
    if (s.revert) throw revert(s.revert);
    if (s.customRevert) throw custom(s.customRevert);
    let out, log;
    if (buy) {
      const q = quoteBuy(pool, Number(sw.amountIn) / 1e6);
      out = BigInt(Math.floor(q.tokensOut * 1e6)) * 10n ** 12n;
      if (out < sw.minOut) throw custom(errI.encodeErrorResult("V4TooLittleReceived", [sw.minOut, out]));
      if (apply) { s.sqrt = q.sqrtPriceAfter.toString(); s.tokenBalance += out; s.native -= sw.amountIn * 10n ** 12n; }
      log = { tokens: out, quote: usdcUnits(q.usdcUsed - q.usdcTaxed), tax: usdcUnits(q.usdcTaxed), isBuy: true };
    } else {
      if (sw.amountIn > s.tokenBalance) throw revert("ERC20: transfer amount exceeds balance");
      if (s.maxUnits != null && sw.amountIn > s.maxUnits) throw custom("0xdeadbeef" + "0".repeat(56));
      const q = quoteSell(pool, Number(sw.amountIn) / 1e18);
      out = usdcUnits(q.usdcOut);
      // A pool that will not pay more than acceptOut for this order: the sell reverts on minOut,
      // which is what the router does when the order is too big for what the pool holds.
      if (s.acceptOut != null && sw.minOut > s.acceptOut) throw custom(errI.encodeErrorResult("V4TooLittleReceived", [sw.minOut, s.acceptOut]));
      if (out < sw.minOut) throw custom(errI.encodeErrorResult("V4TooLittleReceived", [sw.minOut, out]));
      if (apply) { s.sqrt = q.sqrtPriceAfter.toString(); s.tokenBalance -= sw.amountIn; s.sold = (s.sold || 0n) + sw.amountIn; s.native += out * 10n ** 12n; }
      log = { tokens: sw.amountIn, quote: usdcUnits(q.usdcGross), tax: usdcUnits(q.usdcTaxed), isBuy: false };
    }
    // Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee): the swapper's deltas.
    const a0 = log.isBuy ? log.tokens : -log.tokens, a1 = log.isBuy ? -log.quote : log.quote;
    const swapLog = { address: POOL_MANAGER, topics: [TOPICS.Swap, POOL, zeroPadValue(UNIVERSAL_ROUTER, 32)], data: coder.encode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], [a0, a1, BigInt(s.sqrt), LIQ, tickFromSqrtPriceX96(BigInt(s.sqrt)), 10000]) };
    const taxLog = { address: HOOK, topics: [TOPICS.TaxCollected], data: coder.encode(["bool", "uint256", "address"], [log.isBuy, log.tax, USDC_ERC20]) };
    return { swapLog, taxLog };
  }
  receipt(hash, to, logs) { return { transactionHash: hash, blockHash: "0x" + "b".repeat(64), blockNumber: "0x11", transactionIndex: "0x0", from: "0x" + "0".repeat(40), to, status: "0x1", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", contractAddress: null, logsBloom: "0x" + "0".repeat(512), type: "0x2", logs: logs.map((l, i) => ({ ...l, blockNumber: "0x11", blockHash: "0x" + "b".repeat(64), transactionHash: hash, transactionIndex: "0x0", logIndex: "0x" + i.toString(16), removed: false })) }; }
}

let now = 1_800_000_000_000; const clock = () => now;
/** A wallet with 100 USDC (native face, 18 decimals), a launch a minute old, the pool sitting where a
 *  250 USDC buy left it so it holds USDC to pay a sell. */
function chain(over = {}) {
  const opened = { sqrt: sqrtRatioToX96(sqrtRatioAtTick(TICK_START)).toString() };
  const afterBuy = quoteBuy({ sqrtPriceX96: BigInt(opened.sqrt), liquidity: Number(LIQ), tickStart: TICK_START, tickBond: TICK_BOND, buyTaxBps: 300, sellTaxBps: 500, snipeBps: 0, tokenIs0: true }, 250);
  return new FakeChain({ native: 100n * 10n ** 18n, tokenBalance: BAL, erc20Allowance: {}, permit2Allowance: {}, permit2Deployed: true, sqrt: afterBuy.sqrtPriceAfter.toString(), launchedAtMs: now - 60_000, nowMs: clock, revert: null, customRevert: null, acceptOut: null, maxUnits: null, swapsSeen: [], transfers: [], receipts: {}, ...over });
}
const approvedAll = () => ({ erc20Allowance: { [USDC_ERC20.toLowerCase()]: 2n ** 255n, [TOKEN]: 2n ** 255n }, permit2Allowance: { [USDC_ERC20.toLowerCase()]: { amount: 2n ** 160n - 1n, expiration: 2n ** 48n - 1n }, [TOKEN]: { amount: 2n ** 160n - 1n, expiration: 2n ** 48n - 1n } } });
const reference = (c, over = {}) => ({
  solPrice: 1, solPriceAt: now, quote: "USDC", mcapUsd: 6000,
  token: { ca: TOKEN, createdAt: c.s.launchedAtMs, _ageMs: now - c.s.launchedAtMs },
  curve: { address: POOL, hook: HOOK, quoteReserve: 240, tokenReserve: 9.5e8, feeBps: 300, sellTaxBps: 500, creatorTaxBps: 0, poolFeeBps: 100, native: QUOTE_IS_NATIVE, progress: 0.1, bonded: false, tickStart: TICK_START, tickBond: TICK_BOND, sqrtPriceX96: c.s.sqrt, liquidity: LIQ.toString(), tokenIs0: true, quoteAsset: USDC_ERC20, quoteDecimals: 6 },
  ...over,
});
const order = (c, over = {}) => ({ id: "arc:o1", decisionId: "d1", instrument: TOKEN, side: "BUY", stake_usd: 25, max_slippage_bps: 2000, reference: reference(c), ...over });
const position = (over = {}) => ({ id: "arc:x", instrument: TOKEN, reference: null, ...over });
const router = async (c, over = {}) => { const r = new ArcLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000, clock, ...over }); await r.init(); return r; };

// The default-RPC assertion below reads the environment; the operator's own endpoint must not leak into it.
delete process.env.ARC_RPC_URL;

test("T23: the paper model prices a buy and a sell through the position with the hook's taxes, and a buy inside the snipe window shows the tax it would pay", () => {
  const c = chain();
  const ref = reference(c);
  const buy = arcFillModel({ side: "BUY", stake_usd: 25, reference: ref }, { now });
  const q = quoteBuy(c.pool(), 25);
  assert.equal(buy.qty, q.tokensOut); assert.equal(buy.notional_usd, 25); assert.equal(buy.snipe_bps, 0);
  assert.ok(Math.abs(buy.fee_usd - (0.75 + 24.25 * 0.01)) < 1e-9, `3% to the hook and 1% of the rest to the pool: ${buy.fee_usd}`);
  assert.ok(buy.price > 0 && Math.abs(buy.price - 25 / q.tokensOut) < 1e-15, "USD per token is the stake over the tokens, taxes in");
  assert.ok(buy.slippage_bps > 0);
  // A quote price is not needed: USDC is the dollar. The PONS model refuses here; this one fills.
  const noPrice = arcFillModel({ side: "BUY", stake_usd: 25, reference: { ...ref, solPrice: undefined } }, { now });
  assert.equal(noPrice.reject, undefined); assert.equal(noPrice.qty, buy.qty);
  // One second after launch the hook takes 618bps of snipe tax on top of the 3% leg tax.
  const young = arcFillModel({ side: "BUY", stake_usd: 25, reference: { ...ref, token: { ...ref.token, createdAt: now - 1000 } } }, { now });
  assert.equal(young.snipe_bps, 618); assert.ok(young.tax_usd > 25 * 0.09 && young.tax_usd < 25 * 0.0919, `9.18% withheld: ${young.tax_usd}`);
  assert.ok(young.qty < buy.qty * 0.95, "and the fill is visibly worse");
  const launchBlock = arcFillModel({ side: "BUY", stake_usd: 25, reference: { ...ref, token: { ...ref.token, createdAt: now } } }, { now });
  assert.equal(launchBlock.snipe_bps, 9900); assert.ok(launchBlock.fee_usd > 24.7, "99%: a donation, and the paper book says so");
  // Selling: 1% of the tokens to the pool, 5% of the USDC to the hook.
  const sell = arcFillModel({ side: "SELL", qty: buy.qty, reference: ref }, { now });
  const qs = quoteSell(c.pool(), buy.qty);
  assert.equal(sell.notional_usd, qs.usdcOut); assert.ok(sell.notional_usd > 22 && sell.notional_usd < 23.5, `round trip loses the taxes and two pool fees: ${sell.notional_usd}`);
  assert.ok(Math.abs(sell.tax_usd - qs.usdcGross * 0.05) < 1e-9);
  // Nothing to price from: the reference is not hydrated yet.
  assert.equal(arcFillModel({ side: "BUY", stake_usd: 25, reference: { ...ref, curve: { ...ref.curve, sqrtPriceX96: null } } }, { now }).reject, "NO_POOL");
  assert.equal(arcFillModel({ side: "BUY", stake_usd: 25, reference: { ...ref, curve: { ...ref.curve, feeBps: null } } }, { now }).reject, "NO_POOL", "a tax of 'not known yet' is never priced as none");
  assert.equal(arcFillModel({ side: "BUY", stake_usd: 0, reference: ref }, { now }).reject, "ZERO_STAKE");
  assert.equal(arcFillModel({ side: "SELL", qty: 0, reference: ref }, { now }).reject, "ZERO_QTY");
});

test("T23: the paper router fills on the arc venue at the order's own time", async () => {
  const c = chain();
  const r = new ArcPaperRouter({ clock });
  const res = await r.submit(order(c));
  assert.equal(res.ok, true, JSON.stringify(res.failure)); assert.equal(res.fill.venue, "arc"); assert.equal(res.fill.paper, true); assert.equal(res.fill.notional_usd, 25);
  const closed = await r.close({ id: "arc:x", instrument: TOKEN, notional_usd: 25, reference: reference(c) }, 100);
  assert.equal(closed.ok, true); assert.ok(closed.fill.notional_usd > 22 && closed.fill.notional_usd < 23.5);
  // The paper clock, not the wall clock, decides the snipe tax: at the launch's own second the model charges 99%.
  const c2 = chain({ launchedAtMs: now });
  const sniped = await r.submit(order(c2, { id: "arc:o2", max_slippage_bps: Infinity }));
  assert.equal(sniped.ok, true); assert.ok(sniped.fill.fee_usd > 24.7, `the snipe tax is in the paper fee: ${sniped.fill.fee_usd}`);
});

test("T23: init and preflight read the wallet's USDC from the native face and report it under the engine's name", async () => {
  const c = chain();
  const r = new ArcLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, clock });
  const pre = await r.init();
  assert.equal(r.venue, "arc"); assert.equal(r.mode, "live"); assert.equal(r.ready, true); assert.ok(/^0x[0-9a-fA-F]{40}$/.test(r.address));
  assert.equal(pre.wallet, r.address); assert.equal(pre.chainId, 5042); assert.equal(pre.quote, "USDC");
  assert.equal(pre.balanceUsdc, 100, "1e20 wei on the 18-decimal face is 100 USDC, not 1e14");
  assert.equal(pre.balanceSol, pre.balanceUsdc, "the engine reads the quote balance as balanceSol on every venue");
  assert.equal(pre.rpc, "https://rpc.mainnet.arc.io", "the default RPC when none is configured");
  const h = await r.health(); assert.equal(h.ok, true); assert.match(h.detail, /block 16/);
  await assert.rejects(new ArcLiveRouter({ fetchImpl: offline, secret: "", provider: c }).init(), /ARC_PRIVATE_KEY/);
});

test("T23: a buy is approved once, dry-run, then sent as one V4_SWAP with the pool key, the exact input and the price floor", async () => {
  const c = chain();
  const r = await router(c, { slippagePct: 15 });
  const q = quoteBuy(c.pool(), 25);
  const res = await r.submit(order(c));
  assert.equal(res.ok, true, JSON.stringify(res.failure));
  // approve USDC to Permit2, Permit2.approve(UniversalRouter), then the swap
  assert.equal(c.sent.length, 3, "two one-time approvals and one swap");
  assert.equal(String(c.sent[0].to).toLowerCase(), USDC_ERC20.toLowerCase()); assert.equal(String(erc.parseTransaction({ data: c.sent[0].data }).args[0]).toLowerCase(), PERMIT2.toLowerCase());
  assert.equal(String(c.sent[1].to).toLowerCase(), PERMIT2.toLowerCase()); assert.equal(String(p2I.parseTransaction({ data: c.sent[1].data }).args[1]).toLowerCase(), UNIVERSAL_ROUTER.toLowerCase());
  assert.equal(String(c.sent[2].to).toLowerCase(), UNIVERSAL_ROUTER.toLowerCase());
  // The dry run ran the exact call before anything was sent: a staticCall and a gas estimate to the router.
  const dry = c.s.swapsSeen.filter(x => x.method === "eth_call"), est = c.s.swapsSeen.filter(x => x.method === "eth_estimateGas");
  assert.ok(dry.length >= 1 && est.length >= 1, "staticCall and estimateGas");
  assert.equal(c.calls.findIndex(x => x.to === UNIVERSAL_ROUTER.toLowerCase()) >= 0, true);
  // What went on the wire: command 0x10, actions SWAP_EXACT_IN_SINGLE / SETTLE_ALL / TAKE_ALL, the launch's pool key.
  const f = urI.parseTransaction({ data: c.sent[2].data, value: c.sent[2].value });
  assert.equal(f.args[0], "0x10");
  const sw = decodeV4Swap(f.args[0], f.args[1]);
  assert.equal(sw.actions, "0x060c0f");
  assert.deepEqual({ ...sw.key, currency0: sw.key.currency0.toLowerCase(), currency1: sw.key.currency1.toLowerCase(), hooks: sw.key.hooks.toLowerCase() }, { currency0: TOKEN, currency1: USDC_ERC20.toLowerCase(), fee: 10000, tickSpacing: 200, hooks: HOOK });
  assert.equal(sw.zeroForOne, false, "paying currency1 (USDC) for currency0 (the token)");
  assert.equal(sw.amountIn, 25_000_000n, "25 USDC on the 6-decimal face, never 25e18");
  assert.equal(c.sent[2].value, 0n, "an ERC-20 quote is pulled through Permit2, not sent as msg.value");
  assert.deepEqual({ c: sw.settle.currency.toLowerCase(), a: sw.settle.amount }, { c: USDC_ERC20.toLowerCase(), a: 25_000_000n });
  assert.deepEqual({ c: sw.take.currency.toLowerCase(), a: sw.take.amount }, { c: TOKEN, a: sw.minOut });
  const floor = BigInt(Math.floor(q.tokensOut * 0.85 * 1e6)) * 10n ** 12n;
  assert.equal(sw.minOut, floor, "minOut is the pool's quote at 15% slippage");
  assert.ok(sw.minOut > 0n);
  assert.equal(sw.hookData, "0x");
  // The fill: tokens from the Swap log, USDC spent is the exact input plus gas, taxes and fees named.
  assert.equal(res.fill.venue, "arc"); assert.equal(res.fill.side, "BUY"); assert.equal(res.fill.exact, true); assert.equal(res.fill.venue_ref, c.sent[2].hash);
  assert.ok(Math.abs(res.fill.qty - q.tokensOut) < 1e-6 * q.tokensOut, `qty from the log: ${res.fill.qty}`);
  assert.ok(res.fill.sol_spent > 25 && res.fill.sol_spent < 25.001, `25 USDC plus gas on the native face: ${res.fill.sol_spent}`);
  assert.ok(res.fill.fee_usd > 0.75 && res.fill.fee_usd < 1.1, `3% hook tax + 1% pool fee + gas: ${res.fill.fee_usd}`);
  assert.ok(Math.abs(res.fill.price - res.fill.sol_spent / res.fill.qty) < 1e-18);
  assert.ok(r.known.has(TOKEN));
  // A second buy sends only the swap: the approvals are on chain and remembered.
  const again = await r.submit(order(c, { id: "arc:o2" }));
  assert.equal(again.ok, true, JSON.stringify(again.failure)); assert.equal(c.sent.length, 4);
});

test("T23: a dry run that reverts sends nothing and names the reason, from Error(string) or from the router's own ABI", async () => {
  const c = chain({ ...approvedAll(), revert: "SwapPaused" });
  const r = await router(c);
  const res = await r.submit(order(c));
  assert.equal(res.ok, false); assert.equal(res.failure.code, "REVERT"); assert.match(res.failure.reason, /SwapPaused/);
  assert.equal(c.sent.length, 0, "no gas spent");
  // A custom error the v4 router throws is named by its ABI, arguments included.
  const c2 = chain({ ...approvedAll(), customRevert: errI.encodeErrorResult("V4TooLittleReceived", [5n, 3n]) });
  const r2 = await router(c2);
  const res2 = await r2.submit(order(c2));
  assert.equal(res2.failure.code, "REVERT"); assert.match(res2.failure.reason, /V4TooLittleReceived\(5, 3\)/); assert.equal(c2.sent.length, 0);
  // One nobody declares is named by selector when the explorer cannot help.
  const c3 = chain({ ...approvedAll(), customRevert: "0xdeadbeef" + "0".repeat(56) });
  const r3 = await router(c3); r3._abis = new Map([[HOOK, []]]); r3._selectors = new Map([["0xdeadbeef", null]]); // explorer and signature database already consulted: nothing known
  const res3 = await r3.submit(order(c3));
  assert.equal(res3.failure.code, "REVERT"); assert.match(res3.failure.reason, /custom error 0xdeadbeef/); assert.equal(c3.sent.length, 0);
});

test("T23: a buy inside the snipe window is refused before anything is read or sent, and the chain's own launch time is checked too", async () => {
  // The candidate says it is two seconds old.
  const c = chain({ ...approvedAll(), launchedAtMs: now - 2000 });
  const r = await router(c);
  const res = await r.submit(order(c));
  assert.equal(res.ok, false); assert.equal(res.failure.code, "SNIPE_WINDOW"); assert.match(res.failure.reason, /snipe/);
  assert.equal(c.sent.length, 0); assert.equal(c.calls.length, 0, "refused from the reference alone, no RPC");
  // The candidate lies about its age (or does not know it); the hook's launchedAt says one second.
  const c2 = chain({ ...approvedAll(), launchedAtMs: now - 1000 });
  const r2 = await router(c2);
  const stale = order(c2); stale.reference.token = { ca: TOKEN, createdAt: now - 60_000 };
  const res2 = await r2.submit(stale);
  assert.equal(res2.failure.code, "SNIPE_WINDOW"); assert.equal(c2.sent.length, 0);
  const unknown = order(c2); unknown.reference.token = { ca: TOKEN, _ageUnknown: true };
  assert.equal((await r2.submit(unknown)).failure.code, "SNIPE_WINDOW");
  // Exactly the window plus the slack is old enough.
  const c3 = chain({ ...approvedAll(), launchedAtMs: now - SNIPE_REFUSE_MS });
  const r3 = await router(c3);
  assert.equal((await r3.submit(order(c3))).ok, true);
  assert.equal(SNIPE_REFUSE_MS, SNIPE_TAX_WINDOW_MS + 500);
});

test("T23: a wallet that cannot cover the stake and its gas is refused; a slippage cap and a foreign quote asset are too", async () => {
  const c = chain({ ...approvedAll(), native: 20n * 10n ** 18n });
  const r = await router(c);
  const res = await r.submit(order(c));
  // The engine's generic name, so its fail cooldown applies; the reason still says USDC.
  assert.equal(res.failure.code, "INSUFFICIENT_SOL"); assert.match(res.failure.reason, /20\.0000 USDC/); assert.equal(c.sent.length, 0);
  const capped = await r.submit(order(c, { stake_usd: 5, max_slippage_bps: 1 }));
  assert.equal(capped.failure.code, "SLIPPAGE_CAP");
  const o = order(c); o.reference.curve.quoteAsset = addr(0x99);
  assert.equal((await r.submit(o)).failure.code, "UNSUPPORTED");
  const noPool = order(c); noPool.reference.curve = { address: POOL };
  assert.equal((await r.submit(noPool)).failure.code, "NO_POOL");
  assert.equal((await new ArcLiveRouter({ fetchImpl: offline, secret: KEY, provider: c }).submit(order(c))).failure.code, "NOT_READY");
  assert.equal((await r.submit(order(c, { legs: [{ instrument: TOKEN }] }))).failure.code, "UNSUPPORTED");
});

test("T23: a sell without Permit2 on the chain is refused rather than approved into the void", async () => {
  const c = chain({ permit2Deployed: false });
  const r = await router(c);
  const res = await r.close(position(), 100, { reference: reference(c) });
  assert.equal(res.ok, false); assert.equal(res.failure.code, "UNSUPPORTED"); assert.match(res.failure.reason, /Permit2/);
  assert.equal(c.sent.length, 0);
});

test("T23: a position with no pool is sold anyway: the Portal names the hook, the wallet's exact balance is sold through Permit2 after two one-time approvals", async () => {
  const c = chain();
  const r = await router(c);
  const expect = quoteSell(c.pool(), Number(BAL) / 1e18); // from the pool as it stands before the sell moves it
  const res = await r.close(position(), 100, { reference: { solPrice: 1 } });
  assert.equal(res.ok, true, JSON.stringify(res.failure));
  assert.equal(c.s.sold, BAL, "sold exactly what the wallet held, not the float-rounded 1e24");
  assert.equal(c.s.tokenBalance, 0n);
  assert.equal(c.sent.length, 3, "approve the token to Permit2, Permit2 to the router, then sell");
  assert.equal(String(c.sent[0].to).toLowerCase(), TOKEN); assert.equal(String(c.sent[1].to).toLowerCase(), PERMIT2.toLowerCase()); assert.equal(String(c.sent[2].to).toLowerCase(), UNIVERSAL_ROUTER.toLowerCase());
  const sw = decodeV4Swap(...urI.parseTransaction({ data: c.sent[2].data }).args.slice(0, 2));
  assert.equal(sw.zeroForOne, true, "paying currency0 (the token) for currency1 (USDC)");
  assert.equal(sw.amountIn, BAL); assert.equal(sw.settle.currency.toLowerCase(), TOKEN); assert.equal(sw.take.currency.toLowerCase(), USDC_ERC20.toLowerCase());
  assert.ok(sw.minOut > 0n);
  assert.ok(res.fill.sol_received > 0 && res.fill.sol_received <= expect.usdcOut && res.fill.sol_received > expect.usdcOut * 0.999, `proceeds net of the hook's tax and gas: ${res.fill.sol_received} vs ${expect.usdcOut}`);
  assert.equal(res.fill.exact, true); assert.equal(res.fill.venue, "arc"); assert.equal(res.fill.pct_filled, 100); assert.equal(res.fill.partial, 0); assert.equal(res.fill.chunks, 1);
  assert.ok(r.known.has(TOKEN), "the router now knows the token for holdings listing");
  // a second close finds the pool from memory, not the Portals
  const portalCalls = c.calls.filter(x => PORTALS.some(p => p.address.toLowerCase() === x.to)).length;
  assert.ok(portalCalls >= 1, "the Portal was asked once");
  c.s.tokenBalance = 10n ** 18n; await r.close(position(), 100, { reference: { solPrice: 1 } });
  assert.equal(c.calls.filter(x => PORTALS.some(p => p.address.toLowerCase() === x.to)).length, portalCalls);
  assert.equal(c.sent.length, 4, "the approvals are not repeated");
});

test("T23: half a position sells half the units; the quote comes from the pool now, so minOut tracks the live price", async () => {
  const c = chain(approvedAll());
  const r = await router(c, { slippagePct: 15 });
  // the reference lies (a price far above the pool's): a floor from it would revert
  const rich = reference(c, { curve: { ...reference(c).curve, sqrtPriceX96: sqrtRatioToX96(sqrtRatioAtTick(TICK_BOND)).toString() } });
  const res = await r.close(position({ reference: rich }), 50, { reference: rich });
  assert.equal(res.ok, true, JSON.stringify(res.failure));
  assert.equal(c.s.sold, BAL / 2n);
  const seen = c.s.swapsSeen[0];
  const live = quoteSell({ ...c.pool(), sqrtPriceX96: BigInt(rich.curve.sqrtPriceX96) }, Number(BAL / 2n) / 1e18);
  assert.ok(Number(seen.minOut) / 1e6 < live.usdcOut * 0.5, `minOut ${Number(seen.minOut) / 1e6} must sit under what the live pool pays, not the reference's ${live.usdcOut}`);
  assert.equal(c.sent.length, 1, "allowances were enough: no approve");
});

test("T23: a sell that would revert is refused in the dry run with the reason, and no transaction is sent; a token the Portals do not know is named", async () => {
  const c = chain({ ...approvedAll(), revert: "Locked" });
  const r = await router(c);
  const res = await r.close(position(), 100, { reference: reference(c) });
  assert.equal(res.ok, false); assert.equal(res.failure.code, "REVERT"); assert.match(res.failure.reason, /Locked/);
  assert.equal(c.sent.length, 0, "no gas spent");
  const u = await r.close(position({ instrument: addr(0xe2) }), 100, { reference: { solPrice: 1 } });
  assert.equal(u.failure.code, "NO_POOL"); assert.equal(c.sent.length, 0);
  c.s.tokenBalance = 0n; c.s.revert = null;
  assert.equal((await r.close(position(), 100, { reference: reference(c) })).failure.code, "NO_POSITION");
});

test("T23: a pool that refuses the whole amount but takes a quarter is sold in chunks until empty", async () => {
  const c = chain({ ...approvedAll(), tokenBalance: 800n * 10n ** 18n, maxUnits: 250n * 10n ** 18n });
  const r = await router(c);
  const res = await r.close(position({ reference: reference(c) }), 100, { reference: reference(c) });
  assert.equal(res.ok, true, JSON.stringify(res.failure));
  assert.equal(c.s.tokenBalance, 0n, "everything sold");
  assert.equal(res.fill.chunks, 4, "four sells of a quarter each"); assert.equal(res.fill.partial, 0); assert.match(res.fill.shape, /1\/4/);
  assert.ok(res.fill.sol_received > 0, "proceeds add up across chunks");
  assert.equal(c.sent.length, 4);
});

// The PONS sell ladder once ended at keep = 0, which sends minOut = 0: a sell that accepts ANY
// price, including near zero, on a thin pool where a sandwich costs a few dollars to run. It also
// tried every price at full size before ever trying a smaller size. That is how a close came back
// at -72% on an exit rule that only fires in profit. This router is born with the fixed ladder.
test("T23: a sell never offers the position at any price, and shrinks the order before widening the price", async () => {
  // The pool will only pay a little: nothing near a full-size quote clears, but a small order does.
  const full = quoteSell({ ...chain().pool() }, Number(BAL) / 1e18);
  const c = chain({ ...approvedAll(), acceptOut: usdcUnits(full.usdcOut * 0.3) });
  const r = await router(c);
  const res = await r.close(position({ reference: reference(c) }), 100, { reference: reference(c) });
  assert.equal(res.ok, true, res.failure?.reason);
  // Every minOut the router ever put in front of the pool, in a dry run or for real, kept at least
  // 85% of that order's own quote. None was zero.
  assert.ok(c.s.swapsSeen.length > 0);
  for (const seen of c.s.swapsSeen) assert.ok(seen.minOut > 0n, "no sell is ever offered with no price floor");
  // Size was the lever, not price: it reached an accepted order by shrinking, at the normal keep.
  const first = c.s.swapsSeen[0], accepted = c.s.swapsSeen.find(x => x.minOut <= c.s.acceptOut);
  assert.ok(accepted, "it found an order the pool accepts");
  assert.ok(accepted.amountIn < first.amountIn, "by selling less, not by accepting less per token");
  const firstKeep = Number(first.minOut) / (full.usdcOut * 1e6);
  assert.ok(firstKeep > 0.849 && firstKeep < 0.851, `the first offer keeps 85% of the full-size quote: ${firstKeep}`);
});

test("T23: when no order clears at a fair price the sell fails and is retried, rather than dumping at zero", async () => {
  // The pool pays essentially nothing at any size: there is no honest sell here.
  const c = chain({ ...approvedAll(), acceptOut: 1n });
  const r = await router(c, { slippagePct: 10 });
  const res = await r.close(position({ reference: reference(c) }), 100, { reference: reference(c) });
  assert.equal(res.ok, false);
  assert.equal(res.failure.code, "REVERT"); assert.match(res.failure.reason, /V4TooLittleReceived/);
  assert.equal(c.sent.length, 0, "and nothing was sent: the position is worth more open than given away");
  for (const seen of c.s.swapsSeen) assert.ok(seen.minOut > 0n);
  assert.equal(c.s.swapsSeen.length, 8, "all, half, a quarter, an eighth at the normal 90% keep, then again at the 85% floor, then nothing");
  const keeps = c.s.swapsSeen.map(x => Number(x.minOut) / (quoteSell(c.pool(), Number(x.amountIn) / 1e18).usdcOut * 1e6));
  assert.ok(keeps.slice(0, 4).every(k => k > 0.899 && k < 0.901) && keeps.slice(4).every(k => k > 0.849 && k < 0.851), `sizes first, then the floor: ${keeps.map(k => k.toFixed(3))}`);
});

test("T23: an Arc position whose tokens are gone is checked against the PoolManager first, by the transaction's sender", async () => {
  const c = chain({ ...approvedAll(), tokenBalance: 0n });
  const r = await router(c);
  const me = r.address.toLowerCase(), someoneElse = "0x" + "9".repeat(40);
  const sqrt = BigInt(c.s.sqrt);
  // A swap as the PoolManager logs it: the sender is the router, whoever traded.
  const swapLog = (tokens, usdc, side, block, tx) => ({
    address: POOL_MANAGER, blockNumber: block, transactionHash: tx, index: 0,
    topics: [TOPICS.Swap, POOL, zeroPadValue(UNIVERSAL_ROUTER, 32)],
    data: coder.encode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], [side === "sell" ? -BigInt(tokens) * 10n ** 18n : BigInt(tokens) * 10n ** 18n, side === "sell" ? usdcUnits(usdc) : -usdcUnits(usdc), sqrt, LIQ, TICK_START, 10000]),
  });
  const from = { "0xother": someoneElse, "0xmine": me, "0xmybuy": me };
  c.getBlockNumber = async () => 1000;
  c.getBlock = async (n) => ({ timestamp: 1_700_000 + n });     // seconds
  c.getTransaction = async (hash) => ({ hash, from: from[hash] });
  // The receipt of our sale carries the hook's TaxCollected: 5% of the 10 USDC the pool paid.
  c.getTransactionReceipt = async (hash) => hash === "0xmine" ? { status: 1, gasUsed: 0n, effectiveGasPrice: 0n, logs: [{ address: HOOK, topics: [TOPICS.TaxCollected], data: coder.encode(["bool", "uint256", "address"], [false, usdcUnits(0.5), USDC_ERC20]) }] } : null;
  // Three swaps on this pool: a stranger's sale, our own buy, then our sale. Ours is the one that explains the empty wallet.
  c.getLogs = async (f) => { assert.equal(String(f.address).toLowerCase(), POOL_MANAGER.toLowerCase()); assert.equal(f.topics[0], TOPICS.Swap); assert.equal(String(f.topics[1]).toLowerCase(), POOL); return [swapLog(100, 5, "sell", 990, "0xother"), swapLog(1000, 12, "buy", 992, "0xmybuy"), swapLog(1000, 10, "sell", 995, "0xmine")]; };
  const sale = await r.findRecentSale(TOKEN, { since: 0 });
  assert.deepEqual({ sig: sale.sig, sol: sale.solReceived, qty: sale.qty }, { sig: "0xmine", sol: 9.5, qty: 1000 }, "the wallet's own sale, with what the pool paid less what the hook kept");
  assert.equal(sale.at, (1_700_000 + 995) * 1000);
  // A sale from before this position was opened is not this position's exit.
  assert.equal(await r.findRecentSale(TOKEN, { since: (1_700_000 + 999) * 1000 }), null);
  // Nobody we know sold: nothing to recover, and the engine books the loss it was going to book.
  c.getLogs = async () => [swapLog(100, 5, "sell", 990, "0xother"), swapLog(1000, 12, "buy", 992, "0xmybuy")];
  assert.equal(await r.findRecentSale(TOKEN, { since: 0 }), null);
  // An RPC that will not answer must not invent a sale.
  c.getLogs = async () => { throw new Error("rate limited"); };
  assert.equal(await r.findRecentSale(TOKEN, { since: 0 }), null);
});

test("T23: the platform fee leaves as a native transfer of USDC on the 18-decimal face", async () => {
  const c = chain();
  const r = await router(c);
  const feeWallet = addr(0xfee);
  const hash = await r.transferSol(feeWallet, 1.5);
  assert.equal(c.sent.length, 1); assert.equal(c.sent[0].hash, hash);
  assert.equal(String(c.sent[0].to).toLowerCase(), feeWallet); assert.equal(c.sent[0].value, 1_500_000_000_000_000_000n, "1.5 USDC is 1.5e18 wei, not 1.5e6");
  assert.equal(c.sent[0].gasLimit, 21_000n, "a plain transfer, no contract call");
  assert.equal(c.s.native, 100n * 10n ** 18n - 1_500_000_000_000_000_000n);
  assert.equal(await r.transferQuote(feeWallet, 0.25), c.sent[1].hash);
  assert.deepEqual(await r.positions(), [], "nothing tracked yet");
  r.track(TOKEN); assert.deepEqual(await r.positions(), [{ instrument: TOKEN, qty: Number(BAL) / 1e18 }]);
});

test("T23: the swap encoder round-trips and follows the Portal's currency order for either side", () => {
  const pool = { token: TOKEN, poolId: POOL, hook: HOOK, quoteAsset: USDC_ERC20, quoteDecimals: 6, tokenIs0: true };
  const buy = encodeV4Swap({ pool, side: "BUY", amountIn: 25_000_000n, minOut: 7n });
  assert.equal(buy.commands, "0x10"); assert.equal(buy.inputs.length, 1); assert.equal(buy.zeroForOne, false);
  assert.deepEqual(decodeV4Swap(buy.commands, buy.inputs), { actions: "0x060c0f", key: { currency0: poolKeyFor(pool).currency0, currency1: poolKeyFor(pool).currency1, fee: 10000, tickSpacing: 200, hooks: poolKeyFor(pool).hooks }, zeroForOne: false, amountIn: 25_000_000n, minOut: 7n, hookData: "0x", settle: { currency: poolKeyFor(pool).currency1, amount: 25_000_000n }, take: { currency: poolKeyFor(pool).currency0, amount: 7n } });
  // A token above the USDC view's address is currency1: a buy then goes zero-for-one.
  const high = { ...pool, token: "0x" + "f".repeat(40), tokenIs0: undefined };
  const k = poolKeyFor(high); assert.equal(k.tokenIs0, false); assert.equal(k.currency0.toLowerCase(), USDC_ERC20.toLowerCase());
  assert.equal(encodeV4Swap({ pool: high, side: "BUY", amountIn: 1n, minOut: 1n }).zeroForOne, true);
  assert.equal(encodeV4Swap({ pool: high, side: "SELL", amountIn: 1n, minOut: 1n }).zeroForOne, false);
  assert.equal(decodeV4Swap("0x0b", ["0x"]), null, "anything but one V4_SWAP is not ours");
  assert.equal(TOKEN_SUPPLY, 1e9);
});
