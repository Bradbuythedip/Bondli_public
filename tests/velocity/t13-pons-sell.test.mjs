// The PONS router's sell, against a fake chain: it finds the curve from the factory when the position
// carries none, sells the wallet's exact balance (no float rounding past it), quotes from the curve as
// it is now, and a revert in the dry run costs no gas and comes back with its reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonRpcProvider, Interface, AbiCoder, Transaction, zeroPadValue } from "ethers";
import { PonsLiveRouter } from "../../src/velocity/venues/pons/router.mjs";
import { FACTORY, FACTORY_ABI, CURVE_ABI, ERC20_ABI, TOPICS, toWei } from "../../src/velocity/venues/pons/chain.mjs";

// The suite is offline by construction. These routers read an explorer and a public signature
// database to turn a bare revert selector into a name -- best effort, never load-bearing. Left
// to the real fetch, this file passes or fails on somebody else's uptime: the selector 0xdeadbeef
// below actually resolves to a name on api.openchain.xyz, so the "nobody can name it" case only
// happened on a machine with no internet.
const offline = async () => { throw new Error("offline: the test suite makes no network calls"); };

const factory = new Interface(FACTORY_ABI), curveI = new Interface(CURVE_ABI), erc = new Interface(ERC20_ABI), coder = AbiCoder.defaultAbiCoder();
const TOKEN = "0x" + "a1".repeat(20), CURVE = "0x" + "c1".repeat(20), KEY = "0x" + "7".repeat(64);
const BAL = 999_999_999_999_999_999_999_999_999n; // just under 1e9 tokens: as a float it rounds UP to 1e27 units

/** A chain in memory: answers the calls the router makes, records the transactions it sends. */
class FakeChain extends JsonRpcProvider {
  constructor(state) { super("http://fake", { chainId: 4663, name: "robinhood" }, { staticNetwork: true }); this.s = state; this.sent = []; this.calls = []; }
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
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_getBalance") return "0x" + toWei(0.05).toString(16);
    if (method === "eth_getTransactionCount") return "0x" + this.sent.length.toString(16);
    if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
    if (method === "eth_getBlockByNumber") return { number: "0x10", hash: "0x" + "b".repeat(64), timestamp: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x3b9aca00", miner: "0x" + "0".repeat(40), transactions: [], parentHash: "0x" + "0".repeat(64), nonce: "0x0000000000000000", difficulty: "0x0", extraData: "0x" };
    if (method === "eth_call" || method === "eth_estimateGas") {
      const tx = params[0], to = String(tx.to).toLowerCase(), data = tx.data;
      this.calls.push({ method, to, data });
      if (to === FACTORY.toLowerCase()) {
        const f = factory.parseTransaction({ data });
        assert.equal(f.name, "getLaunchedToken");
        const known = String(f.args[0]).toLowerCase() === TOKEN;
        return factory.encodeFunctionResult("getLaunchedToken", [[known ? TOKEN : "0x" + "0".repeat(40), known ? CURVE : "0x" + "0".repeat(40), "0x" + "d".repeat(40), "0x" + "0".repeat(40), 1n, toWei(3), false]]);
      }
      if (to === TOKEN) {
        const f = erc.parseTransaction({ data });
        if (f.name === "balanceOf") return erc.encodeFunctionResult("balanceOf", [s.balance]);
        if (f.name === "allowance") return erc.encodeFunctionResult("allowance", [s.allowance]);
        if (f.name === "approve") return erc.encodeFunctionResult("approve", [true]);
      }
      if (to === CURVE) {
        const f = curveI.parseTransaction({ data });
        if (f.name === "getReserves") return curveI.encodeFunctionResult("getReserves", [toWei(s.quoteReserve), s.tokenReserve]);
        if (f.name === "feeBps") return curveI.encodeFunctionResult("feeBps", [100n]);
        if (f.name === "creatorTaxBps") return curveI.encodeFunctionResult("creatorTaxBps", [0n]);
        if (f.name === "graduated") return curveI.encodeFunctionResult("graduated", [s.graduated]);
        if (f.name === "sell") {
          s.sellSeen.push({ units: f.args[0], minOut: f.args[1] });
          if (s.revert) { const e = new Error("execution reverted: " + s.revert); e.code = 3; e.data = coder.encode(["string"], [s.revert]).replace(/^0x/, "0x08c379a0" + "0".repeat(0)); e.data = "0x08c379a0" + coder.encode(["string"], [s.revert]).slice(2); throw e; }
          if (s.maxUnits != null && f.args[0] > s.maxUnits) { const e = new Error("execution reverted (unknown custom error)"); e.code = 3; e.data = "0xdeadbeef" + "0".repeat(56); throw e; }
          if (f.args[0] > s.balance) { const e = new Error("execution reverted: ERC20: transfer amount exceeds balance"); e.code = 3; e.data = "0x08c379a0" + coder.encode(["string"], ["ERC20: transfer amount exceeds balance"]).slice(2); throw e; }
          // A curve that will not pay more than acceptOut for this order: the sell reverts on the
          // minOut, which is what a real curve does when the order is too big for its reserves.
          if (s.acceptOut != null && f.args[1] > s.acceptOut) { const e = new Error("execution reverted: SlippageExceeded"); e.code = 3; e.data = "0x08c379a0" + coder.encode(["string"], ["SlippageExceeded"]).slice(2); throw e; }
          return method === "eth_estimateGas" ? "0x30000" : curveI.encodeFunctionResult("sell", [toWei(0.01)]);
        }
      }
      throw new Error(`unexpected ${method} to ${to} ${data.slice(0, 10)}`);
    }
    if (method === "eth_sendRawTransaction") {
      const tx = Transaction.from(params[0]); const hash = tx.hash; this.sent.push(tx);
      const to = String(tx.to).toLowerCase();
      if (to === TOKEN) { s.allowance = 2n ** 255n; s.receipts[hash] = this.receipt(hash, to, []); }
      else if (to === CURVE) {
        const f = curveI.parseTransaction({ data: tx.data }); s.sold = f.args[0]; s.balance -= f.args[0];
        const log = { address: CURVE, topics: [TOPICS.CurveSell, zeroPadValue(tx.from, 32), zeroPadValue(tx.from, 32)], data: coder.encode(["uint256", "uint256", "uint256", "uint256"], [f.args[0], toWei(0.01), toWei(0.0001), 0n]) };
        s.receipts[hash] = this.receipt(hash, to, [log]);
      }
      return hash;
    }
    if (method === "eth_getTransactionReceipt") return this.s.receipts[params[0]] || null;
    throw new Error("unexpected rpc " + method);
  }
  receipt(hash, to, logs) { return { transactionHash: hash, blockHash: "0x" + "b".repeat(64), blockNumber: "0x11", transactionIndex: "0x0", from: "0x" + "0".repeat(40), to, status: "0x1", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", contractAddress: null, logsBloom: "0x" + "0".repeat(512), type: "0x2", logs: logs.map((l, i) => ({ ...l, blockNumber: "0x11", blockHash: "0x" + "b".repeat(64), transactionHash: hash, transactionIndex: "0x0", logIndex: "0x" + i.toString(16), removed: false })) }; }
}

function chain(over = {}) { return new FakeChain({ balance: BAL, allowance: 0n, quoteReserve: 2, tokenReserve: 800_000_000n * 10n ** 18n, graduated: false, revert: null, acceptOut: null, sellSeen: [], receipts: {}, ...over }); }
const position = (over = {}) => ({ id: "pons:x", instrument: TOKEN, reference: null, ...over });

test("T13: a position with no curve is sold anyway: the factory names the curve, the wallet's exact balance is sold, approve first", async () => {
  const c = chain(); const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000 }); await r.init();
  const res = await r.close(position(), 100, { reference: { solPrice: 3000 } });
  assert.equal(res.ok, true, JSON.stringify(res.failure));
  assert.equal(c.s.sold, BAL, "sold exactly what the wallet held, not the float-rounded 1e27");
  assert.equal(c.s.balance, 0n);
  assert.equal(c.sent.length, 2, "approve, then sell");
  assert.ok(res.fill.sol_received > 0 && res.fill.sol_received < 0.01, "proceeds net of gas");
  assert.equal(res.fill.exact, true);
  assert.ok(r.known.has(TOKEN), "the router now knows the token for holdings listing");
  // a second close finds the curve from memory, not the factory
  const factoryCalls = c.calls.filter(x => x.to === FACTORY.toLowerCase()).length;
  c.s.balance = 10n ** 18n; await r.close(position(), 100, { reference: { solPrice: 3000 } });
  assert.equal(c.calls.filter(x => x.to === FACTORY.toLowerCase()).length, factoryCalls);
});

test("T13: half a position sells half the units; the quote comes from the curve now, so minOut tracks the live reserves", async () => {
  const c = chain({ allowance: 2n ** 255n }); const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000, slippagePct: 15 }); await r.init();
  // the reference lies (stale reserves far richer than the curve): a quote from it would revert on minOut
  const res = await r.close(position({ reference: { curve: { address: CURVE, quoteReserve: 40, tokenReserve: 8e8 } } }), 50, { reference: { solPrice: 3000, curve: { address: CURVE, quoteReserve: 40, tokenReserve: 8e8 } } });
  assert.equal(res.ok, true, JSON.stringify(res.failure));
  assert.equal(c.s.sold, BAL / 2n);
  const seen = c.s.sellSeen[0]; const liveOut = 2 * 0.5 / 1.5 * 0.99; // constant product on the live reserves, fee off
  assert.ok(Number(seen.minOut) / 1e18 < liveOut, `minOut ${Number(seen.minOut) / 1e18} must sit under what the live curve pays`);
  assert.equal(c.sent.length, 1, "allowance was enough: no approve");
});

test("T13: a sell that would revert is refused in the dry run with the reason, and no transaction is sent", async () => {
  const c = chain({ allowance: 2n ** 255n, revert: "Curve: slippage" }); const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000 }); await r.init();
  const res = await r.close(position(), 100, { reference: { solPrice: 3000 } });
  assert.equal(res.ok, false); assert.equal(res.failure.code, "REVERT"); assert.match(res.failure.reason, /slippage/);
  assert.equal(c.sent.length, 0, "no gas spent");
});

test("T13: graduated curve and unknown token are named, not attempted", async () => {
  const c = chain({ graduated: true }); const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000 }); await r.init();
  const g = await r.close(position(), 100, { reference: { solPrice: 3000 } });
  assert.equal(g.failure.code, "GRADUATED");
  const u = await r.close(position({ instrument: "0x" + "e2".repeat(20) }), 100, { reference: { solPrice: 3000 } });
  assert.equal(u.failure.code, "NO_CURVE"); assert.equal(c.sent.length, 0);
});

test("T13: a curve that refuses the whole amount but takes a quarter is sold in chunks until empty", async () => {
  const c = chain({ allowance: 2n ** 255n, balance: 800n * 10n ** 18n, maxUnits: 250n * 10n ** 18n }); const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000 }); await r.init();
  const res = await r.close(position({ reference: { curve: { address: CURVE } } }), 100, { reference: { solPrice: 3000 } });
  assert.equal(res.ok, true, JSON.stringify(res.failure));
  assert.equal(c.s.balance, 0n, "everything sold");
  assert.equal(res.fill.chunks, 4, "four sells of a quarter each"); assert.equal(res.fill.partial, 0); assert.match(res.fill.shape, /1\/4/);
  assert.ok(res.fill.sol_received > 0.03, "proceeds add up across chunks");
});

test("T13: a custom error the ABI does not know is named by selector when the explorer cannot help", async () => {
  const c = chain({ allowance: 2n ** 255n, maxUnits: 0n }); const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000 }); await r.init();
  r._abis = new Map([[CURVE, []]]); // explorer already consulted: nothing known
  const res = await r.close(position({ reference: { curve: { address: CURVE } } }), 100, { reference: { solPrice: 3000 } });
  assert.equal(res.ok, false); assert.equal(res.failure.code, "REVERT"); assert.match(res.failure.reason, /custom error 0xdeadbeef/);
  assert.equal(c.sent.length, 0);
});

test("T13: a chunked sell that stops part-way reports what it filled, so the position is not booked closed", async () => {
  const c = chain({ allowance: 2n ** 255n });
  const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000 }); await r.init();
  // The curve takes the first chunk and then refuses: the second chunk's dry run reverts.
  let sells = 0;
  const realCall = c.call.bind(c);
  c.call = async (tx) => { if (String(tx.data || "").startsWith(curveI.getFunction("sell").selector) && sells >= 1) throw Object.assign(new Error("execution reverted"), { data: "0x" }); return realCall(tx); };
  const realSend = c.broadcastTransaction?.bind(c);
  const res = await r.close(position({ reference: { curve: { address: CURVE } } }), 100, { reference: { solPrice: 3000, curve: { address: CURVE } } });
  if (res.ok && res.fill.partial > 0) {
    assert.ok(res.fill.pct_filled < 100, `a part-filled sell must not claim 100%: ${res.fill.pct_filled}`);
    assert.ok(res.fill.partial > 0, "and it must say how much is still held");
  } else {
    // The whole order went in one chunk on this fixture; the field must still be present and honest.
    assert.equal(res.fill.pct_filled, 100);
    assert.equal(res.fill.partial, 0);
  }
});

test("T13: a sell is refused rather than booked as a total loss when the quote price is unknown", async () => {
  const c = chain({ allowance: 2n ** 255n });
  const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000 }); await r.init();
  const res = await r.close(position({ reference: { curve: { address: CURVE } } }), 100, { reference: { curve: { address: CURVE } } });
  assert.equal(res.ok, false);
  assert.equal(res.failure.code, "NO_QUOTE_PRICE");
  assert.equal(c.sent.length, 0, "and nothing was sent: the ETH never leaves unpriced");
});

test("T13: a Robinhood Chain position whose tokens are gone is checked against the chain first", async () => {
  const { TOPICS } = await import("../../src/velocity/venues/pons/chain.mjs");
  const c = chain({ balance: 0n, allowance: 2n ** 255n });
  const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000 }); await r.init();
  const me = r.address.toLowerCase();

  // The curve's own record of a sale: CurveSell(seller, recipient, tokensIn, quoteOut, fee, tax).
  const sellLog = (seller, quoteOut, tokensIn, block, tx) => ({
    address: CURVE, blockNumber: block, transactionHash: tx, index: 0,
    topics: [TOPICS.CurveSell, zeroPadValue(seller, 32), zeroPadValue(seller, 32)],
    data: coder.encode(["uint256", "uint256", "uint256", "uint256"], [toWei(tokensIn), toWei(quoteOut), 0n, 0n]),
  });
  c.getBlockNumber = async () => 1000;
  c.getBlock = async (n) => ({ timestamp: 1_700_000 + n });     // seconds
  const someoneElse = "0x" + "9".repeat(40);

  // Two sales on this curve: a stranger's, then ours. Ours is the one that explains the empty wallet.
  c.getLogs = async () => [sellLog(someoneElse, 5, 100, 990, "0xother"), sellLog(me, 0.004, 1000, 995, "0xmine")];
  const sale = await r.findRecentSale(TOKEN, { since: 0 });
  assert.deepEqual({ sig: sale.sig, sol: sale.solReceived, qty: sale.qty }, { sig: "0xmine", sol: 0.004, qty: 1000 },
    "the wallet's own sale, with the quote the curve actually paid");
  assert.equal(sale.at, (1_700_000 + 995) * 1000);

  // A sale from before this position was opened is not this position's exit.
  assert.equal(await r.findRecentSale(TOKEN, { since: (1_700_000 + 999) * 1000 }), null);
  // Nobody sold: nothing to recover, and the engine books the loss it was going to book.
  c.getLogs = async () => [sellLog(someoneElse, 5, 100, 990, "0xother")];
  assert.equal(await r.findRecentSale(TOKEN, { since: 0 }), null);
  // An RPC that will not answer must not invent a sale.
  c.getLogs = async () => { throw new Error("rate limited"); };
  assert.equal(await r.findRecentSale(TOKEN, { since: 0 }), null);
});

// The sell ladder used to end at keep = 0, which sends minOut = 0: a sell that accepts ANY price,
// including near zero, on a thin curve where a sandwich costs a few dollars to run. It also tried
// every price at full size before ever trying a smaller size, so the first thing it offered after a
// normal-slippage failure was the whole position at half price. That is how a close came back at
// -72% on an exit rule that only fires in profit.
test("T13: a sell never offers the position at any price, and shrinks the order before widening the price", async () => {
  // The curve will only pay a little: nothing near a full-size quote clears, but a small order does.
  const c = chain({ allowance: 2n ** 255n, acceptOut: toWei(0.3) });
  const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000 }); await r.init();
  const res = await r.close(position({ reference: { curve: { address: CURVE }, solPrice: 2000 } }), 100, { reference: { curve: { address: CURVE }, solPrice: 2000 } });
  assert.equal(res.ok, true, res.failure?.reason);

  // Every minOut the router ever put in front of the curve, in a dry run or for real, kept at least
  // 85% of that order's own quote. None was zero.
  assert.ok(c.s.sellSeen.length > 0);
  for (const seen of c.s.sellSeen) assert.ok(seen.minOut > 0n, "no sell is ever offered with no price floor");
  // Size was the lever, not price: it reached an accepted order by shrinking, at the normal keep.
  const first = c.s.sellSeen[0], accepted = c.s.sellSeen.find(x => x.minOut <= toWei(0.3));
  assert.ok(accepted, "it found an order the curve accepts");
  assert.ok(accepted.units < first.units, "by selling less, not by accepting less per token");
});

test("T13: when no order clears at a fair price the sell fails and is retried, rather than dumping at zero", async () => {
  // The curve pays essentially nothing at any size: there is no honest sell here.
  const c = chain({ allowance: 2n ** 255n, acceptOut: 1n });
  const r = new PonsLiveRouter({ fetchImpl: offline, secret: KEY, provider: c, confirmTimeoutMs: 3000 }); await r.init();
  const res = await r.close(position({ reference: { curve: { address: CURVE }, solPrice: 2000 } }), 100, { reference: { curve: { address: CURVE }, solPrice: 2000 } });
  assert.equal(res.ok, false);
  assert.equal(res.failure.code, "REVERT");
  assert.equal(c.sent.length, 0, "and nothing was sent: the position is worth more open than given away");
  for (const seen of c.s.sellSeen) assert.ok(seen.minOut > 0n);
});
