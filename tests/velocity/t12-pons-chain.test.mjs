// PONS on Robinhood Chain: the pure parts (log decoding, curve math) before any RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, zeroPadValue } from "ethers";
import { decodeLog, TOPICS, curveBuyQuote, curveSellQuote, mcapQuote, curveProgress, FACTORY, CHAIN_ID, toWei, toEth } from "../../src/velocity/venues/pons/chain.mjs";

const coder = AbiCoder.defaultAbiCoder();
const addr = n => "0x" + n.toString(16).padStart(40, "0");
const topicAddr = a => zeroPadValue(a, 32);

test("T12: factory and curve logs decode to plain records; foreign logs are null", () => {
  assert.equal(CHAIN_ID, 4663);
  const launch = { address: FACTORY, blockNumber: 100, transactionHash: "0xaa", topics: [TOPICS.TokenLaunched, topicAddr(addr(1)), topicAddr(addr(2)), topicAddr(addr(3))], data: coder.encode(["address", "uint256", "uint256"], [addr(0), 7, toWei(4)]) };
  assert.deepEqual(decodeLog(launch), { kind: "launch", token: addr(1), curve: addr(2), deployer: addr(3), pairToken: addr(0), graduationThreshold: 4, block: 100, tx: "0xaa" });
  const buy = { address: addr(2), blockNumber: 101, transactionHash: "0xbb", index: 3, topics: [TOPICS.CurveBuy, topicAddr(addr(9)), topicAddr(addr(9))], data: coder.encode(["uint256", "uint256", "uint256", "uint256"], [toWei(0.05), 12_000_000n * 10n ** 18n, toWei(0.0005), 0]) };
  const b = decodeLog(buy);
  assert.equal(b.kind, "buy"); assert.equal(b.wallet, addr(9)); assert.equal(b.quote, 0.05); assert.equal(b.tokens, 12_000_000); assert.equal(b.fee, 0.0005); assert.equal(b.logIndex, 3);
  const sell = { ...buy, topics: [TOPICS.CurveSell, topicAddr(addr(9)), topicAddr(addr(9))], data: coder.encode(["uint256", "uint256", "uint256", "uint256"], [5_000_000n * 10n ** 18n, toWei(0.02), toWei(0.0002), 0]) };
  const s = decodeLog(sell); assert.equal(s.kind, "sell"); assert.equal(s.tokens, 5_000_000); assert.equal(s.quote, 0.02);
  assert.equal(decodeLog({ topics: ["0x" + "1".repeat(64)], data: "0x" }), null);
  assert.equal(decodeLog({ topics: [TOPICS.CurveBuy], data: "0x" }), null, "malformed data is not a trade");
  assert.equal(toEth(toWei(1.5)), 1.5);
});

test("T12: curve math is constant product with quote-side fees; progress and mcap read off the reserves", () => {
  const r = { quoteReserve: 3, tokenReserve: 1_000_000_000 };
  const b = curveBuyQuote(r, 0.1, 100); // 1% fee: 0.099 spent
  assert.ok(Math.abs(b.tokensOut - (1e9 - (3 * 1e9) / 3.099)) < 1e-3);
  assert.ok(b.slippage_bps > 300 && b.slippage_bps < 340, `${b.slippage_bps}`);
  assert.ok(Math.abs(b.feeQuote - 0.001) < 1e-9);
  const s = curveSellQuote({ quoteReserve: 3.099, tokenReserve: 1e9 - b.tokensOut }, b.tokensOut, 100);
  assert.ok(s.quoteOut > 0.097 && s.quoteOut < 0.099, `round trip loses the two fees: ${s.quoteOut}`);
  assert.equal(mcapQuote(r), 3);
  assert.equal(curveProgress(2, 4), 0.5); assert.equal(curveProgress(9, 4), 1); assert.equal(curveProgress(1, 0), 0);
});

test("T12: the feed turns chain logs into radar-shaped candidates; the snipe-tax window is never a candidate", async () => {
  const { PonsFeed } = await import("../../src/velocity/venues/pons/feed.mjs");
  const coder2 = AbiCoder.defaultAbiCoder();
  let now = 1_800_000_000_000; const clock = () => now;
  const CURVE = addr(0x22), TOKEN = addr(0x11), DEV = addr(0x33);
  const buyLog = (wallet, eth, tokens, blk) => ({ address: CURVE, blockNumber: blk, transactionHash: "0x" + blk.toString(16), index: 0, topics: [TOPICS.CurveBuy, topicAddr(wallet), topicAddr(wallet)], data: coder2.encode(["uint256", "uint256", "uint256", "uint256"], [toWei(eth), BigInt(Math.round(tokens)) * 10n ** 18n, toWei(eth * 0.01), 0]) });
  const sellLog = (wallet, tokens, eth, blk) => ({ address: CURVE, blockNumber: blk, transactionHash: "0xs" + blk.toString(16), index: 1, topics: [TOPICS.CurveSell, topicAddr(wallet), topicAddr(wallet)], data: coder2.encode(["uint256", "uint256", "uint256", "uint256"], [BigInt(Math.round(tokens)) * 10n ** 18n, toWei(eth), toWei(eth * 0.01), 0]) });
  let head = 1000, pending = [], chainReal = 0; // what the curve's getters would answer
  const rpc = {
    blockNumber: async () => head,
    logs: async (f) => { const mine = pending.filter(l => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock && (Array.isArray(f.address) ? f.address.map(a => a.toLowerCase()).includes(l.address.toLowerCase()) : f.address.toLowerCase() === l.address.toLowerCase()) && f.topics[0].includes(l.topics[0])); return mine; },
    curveInfo: async () => ({ quoteReserve: 3 + chainReal, tokenReserve: 1_000_000_000 - chainReal * 1e8, realQuoteReserve: chainReal, feeBps: 100, creatorTaxBps: 0, graduationThreshold: 4, native: true }),
    tokenMeta: async () => ({ name: "Hood Cat", symbol: "HCAT" }),
  };
  const feed = new PonsFeed({ rpc, pollMs: 1000, ethPrice: 2000, clock });
  const events = []; feed.on("event", e => { if (e.kind !== "feed_health") events.push(e); });
  // block 1001: launch + the dev's first buy
  pending.push({ address: FACTORY, blockNumber: 1001, transactionHash: "0xl", topics: [TOPICS.TokenLaunched, topicAddr(TOKEN), topicAddr(CURVE), topicAddr(DEV)], data: coder2.encode(["address", "uint256", "uint256"], [addr(0), 1, toWei(4)]) });
  pending.push(buyLog(DEV, 0.2, 60_000_000, 1001));
  head = 1001; await feed.pollOnce();
  const t = feed.token(TOKEN);
  assert.equal(t.name, "Hood Cat"); assert.equal(t.ticker, "HCAT"); assert.equal(t.devWallet, DEV); assert.equal(t.buys, 1);
  assert.ok(t.mcapUsd > 0, "market cap from the hydrated reserves");
  assert.equal(events.filter(e => e.kind === "candidate").length, 0, "inside the 60s snipe-tax window: not a candidate");
  // 90 seconds later: eight distinct buyers and one sell
  now += 90_000; head = 1010; pending = []; chainReal = 0.6;
  for (let i = 0; i < 8; i++) pending.push(buyLog(addr(0x100 + i), 0.05, 12_000_000, 1005 + (i % 3)));
  pending.push(sellLog(addr(0x100), 5_000_000, 0.02, 1008));
  await feed.pollOnce();
  const c = events.find(e => e.kind === "candidate");
  assert.ok(c, "a candidate after the window");
  assert.equal(c.venue, "pons"); assert.equal(c.id, TOKEN);
  const p = c.payload;
  assert.equal(p.token.buys, 9); assert.equal(p.token.sells, 1); assert.equal(p.token.uniqueBuyers.size, 9);
  assert.equal(p.solPrice, 2000); assert.equal(p.quote, "ETH"); assert.equal(p.curve.address, CURVE);
  assert.ok(p.token._curvePct > 0 && p.token._curvePct < 1, `progress ${p.token._curvePct}`);
  assert.ok(p.scores.apeScore > 0); assert.ok(p.qf.rg_devSellSpeed === 0); assert.ok(p.dynamics.trend);
  assert.ok(p.qf._rg_quickFlipRate > 0, "the buyer who sold inside a minute is a quick flip");
  // the same numbers again do not re-emit; a watched token gets ticks regardless
  const n = events.length; feed.watch(TOKEN); now += 2000; head = 1011; await feed.pollOnce();
  assert.ok(events.filter(e => e.kind === "tick").length >= 1, "a watched token ticks every poll");
  const before = events.filter(e => e.kind === "candidate").length; now += 2000; head = 1012; await feed.pollOnce(); now += 2000; head = 1013; await feed.pollOnce();
  assert.ok(events.filter(e => e.kind === "candidate").length <= before + 1, "same numbers: at most one more decision as the trend settles");
  assert.ok(feed.status().healthy);
});

test("T12: the edge on pons refuses the snipe-tax window and reads the curve's own progress", async () => {
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { goodCandidatePayload } = await import("./helpers/fixtures.mjs");
  const edge = makePumpfunEdge({ venue: "pons", aggression: 2 });
  assert.equal(edge.venue, "pons");
  const p = goodCandidatePayload("0xabc"); p.token.createdAt = Date.now() - 50_000; p.token._curvePct = 0.3;
  const [c] = edge.ingest({ kind: "candidate", payload: p });
  assert.ok(edge.gates[0].check(c).reasons.includes("TOO_YOUNG"), "50s old: inside the 60s snipe tax");
  p.token.createdAt = Date.now() - 4 * 60_000;
  const [c2] = edge.ingest({ kind: "candidate", payload: p });
  for (const g of edge.gates) { const r = g.check(c2); assert.equal(r.pass, true, `${g.name}: ${JSON.stringify(r.reasons)}`); }
  p.token._curvePct = 0.95; p.token.vSolInBondingCurve = 1; // the venue says 95% even though "vSol" would read as 1%
  const [c3] = edge.ingest({ kind: "candidate", payload: p });
  assert.ok(edge.gates[0].check(c3).reasons.includes("TOO_LATE"));
  assert.equal(edge.estimate(c2, {}).plan_key, c2.tier);
});

test("T12: a launch quoted in an ERC-20 is never tracked; the router could not trade it", async () => {
  const { PonsFeed } = await import("../../src/velocity/venues/pons/feed.mjs");
  const feed = new PonsFeed({ rpc: { blockNumber: async () => 1, logs: async () => [], curveInfo: async () => ({}), tokenMeta: async () => ({}) }, ethPrice: 2000 });
  assert.equal(feed.apply({ kind: "launch", token: addr(0x51), curve: addr(0x52), deployer: addr(0x53), pairToken: addr(0x77), graduationThreshold: 4, block: 1, tx: "0x" }), undefined);
  assert.equal(feed.tokens.size, 0); assert.equal(feed.skippedQuote, 1);
  assert.ok(feed.apply({ kind: "launch", token: addr(0x61), curve: addr(0x62), deployer: addr(0x63), pairToken: addr(0), graduationThreshold: 4, block: 1, tx: "0x" }));
  assert.equal(feed.tokens.size, 1);
});

test("T12: the PONS feed reports the dev's share of supply from the dev's own curve trades", async () => {
  const { quickFeatures } = await import("../../src/velocity/venues/pons/feed.mjs");
  const now = Date.now();
  const t = { devWallet: "0xdev", devInitialQuote: 0.5, uniqueBuyers: new Set(["0xdev", "0xa"]), spark: [1000], mcapUsd: 1000, trades: [
    { side: "buy", quote: 0.5, tokens: 150_000_000, wallet: "0xdev", time: now - 60_000 }, { side: "buy", quote: 0.05, tokens: 5_000_000, wallet: "0xa", time: now - 30_000 }, { side: "sell", quote: 0.1, tokens: 30_000_000, wallet: "0xdev", time: now - 10_000 } ] };
  assert.equal(quickFeatures(t, now)._rg_devHoldPct, 0.12);
});

test("T12: a token watched before the feed saw it launch is adopted from the factory and ticks", async () => {
  const { PonsFeed } = await import("../../src/velocity/venues/pons/feed.mjs");
  let now = 1_800_000_000_000; const clock = () => now;
  const TOKEN = addr(0x71), CURVE = addr(0x72);
  const rpc = { blockNumber: async () => 5000, logs: async () => [], curveInfo: async () => ({ quoteReserve: 3.4, tokenReserve: 9e8, realQuoteReserve: 0.4, feeBps: 100, creatorTaxBps: 0, graduationThreshold: 4, native: true }), tokenMeta: async () => ({ name: "Old Cat", symbol: "OCAT" }),
    launchInfo: async (t) => t === TOKEN ? { token: TOKEN, curve: CURVE, deployer: addr(0x73), pairToken: addr(0), graduationThreshold: 4, graduated: false } : null };
  const feed = new PonsFeed({ rpc, pollMs: 1000, ethPrice: 2000, clock });
  const events = []; feed.on("event", e => { if (e.kind !== "feed_health") events.push(e); });
  feed.watch(TOKEN); // the engine restarted with this position open; the feed never saw its launch
  assert.equal(feed.tokens.size, 0); assert.equal(feed.status().pendingAdopt, 1);
  await feed.pollOnce();
  const t = feed.token(TOKEN);
  assert.ok(t && t._adopted, "adopted from the factory"); assert.equal(t.name, "Old Cat"); assert.equal(t.curve, CURVE);
  const tick = events.find(e => e.kind === "tick" && e.id === TOKEN);
  assert.ok(tick, "the position gets a price on the first poll"); assert.ok(tick.payload.mcapUsd > 0); assert.equal(tick.payload.curve.address, CURVE);
  assert.equal(events.filter(e => e.kind === "candidate" && e.id === TOKEN).length, 0, "an adopted token of unknown age is priced, not judged as a launch");
  assert.equal(feed.status().pendingAdopt, 0);
});

test("T12: a funded Robinhood Chain wallet is judged in ETH, not against Solana's constants", async () => {
  const { Engine } = await import("../../src/velocity/core/engine.mjs");
  const { loadRiskEnvelope } = await import("../../src/velocity/core/risk.mjs");
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { PonsPaperRouter } = await import("../../src/velocity/venues/pons/router.mjs");
  const fsx = await import("node:fs"); const osx = await import("node:os"); const px = await import("node:path");

  const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), "pons-live-"));
  const base = JSON.parse(fsx.readFileSync(px.resolve("src/velocity/config/risk.example.json"), "utf8"));
  const cfg = { ...base, bankroll_usd: 100, per_trade_max_usd: 10, portfolio_max_exposure_usd: 40, daily_loss_limit_usd: 35, max_concurrent_positions: 4 };
  cfg.venues = { ...base.venues, pumpfun: { ...base.venues.pumpfun, max_exposure_usd: 0, max_concurrent: 0 },
    pons: { ...base.venues.pons, max_exposure_usd: 40, max_concurrent: 4, min_stake_usd: 10 },
    polymarket: { ...base.venues.polymarket, max_exposure_usd: 0 } };
  fsx.writeFileSync(px.join(dir, "r.json"), JSON.stringify(cfg));

  const router = (balanceEth) => ({
    ready: true,
    async init() { return this.preflight(); },
    async preflight() { return { wallet: "0xbot", balanceSol: balanceEth, quote: "ETH" }; },
    async positions() { return []; }, async health() { return { ok: true }; },
  });
  const mk = (balanceEth, ethPrice) => {
    const e = new Engine({ dataDir: fsx.mkdtempSync(px.join(osx.tmpdir(), "pe-")), envelope: loadRiskEnvelope(px.join(dir, "r.json")),
      venues: { pons: { mode: "paper", edge: makePumpfunEdge({ venue: "pons", aggression: 1 }),
        router: new PonsPaperRouter({ bookFile: px.join(dir, `b${balanceEth}.json`) }), liveRouter: router(balanceEth) } } });
    if (ethPrice) e.quotePrice.pons = ethPrice;
    return e;
  };

  // 0.0086 ETH at $3500 is $30 -- three of the $10 stakes this envelope allows. The old check added
  // a literal 0.006 SOL fee reserve, worth about $21 in ETH, and refused it.
  const ok = mk(0.0086, 3500);
  try {
    await ok.start({ reconcile: false });
    const r = await ok.setVenueMode("pons", "live", { override: true, by: "user" });
    assert.equal(r.ok, true, r.error);
    assert.equal(ok.store.venueMode("pons"), "live", "a $30 ETH wallet trades real money");
  } finally { await ok.stop(); }

  // Genuinely too small is still refused, and the message is in ETH.
  const small = mk(0.0005, 3500);
  try {
    await small.start({ reconcile: false });
    const r = await small.setVenueMode("pons", "live", { override: true, by: "user" });
    assert.equal(r.ok, false);
    assert.match(r.error, /0\.00050 ETH, below one minimum stake/);
    assert.doesNotMatch(r.error, /SOL/);
  } finally { await small.stop(); }

  // The reserve kept back is the venue's own, not Solana's.
  assert.equal(mk(1, 3500).quoteReserve("pons"), 0.001);
  assert.equal(mk(1, 3500).quoteReserve("pumpfun"), 0.02);
  fsx.rmSync(dir, { recursive: true, force: true });
});

test("T12: a curve's own fees are priced honestly, and an unread tax is not free", async () => {
  const { makePumpfunEdge, AGGRESSION } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { checkDisqualifiers } = await import("../../src/autoape/gates/disqualifiers.js");
  const pons = makePumpfunEdge({ venue: "pons", aggression: 1 });
  const cand = (curve) => ({ solPrice: 3500, reference: { solPrice: 3500, vSolInBondingCurve: 3, curve } });

  // A curve the feed has read: its real numbers are used. 1% fee + 5% creator tax = 12% round trip.
  const known = pons.costs(cand({ feeBps: 100, creatorTaxBps: 500 }), 10);
  assert.equal(+known.detail.feeFractionRoundTrip.toFixed(4), 0.12);
  // And a cheap curve is priced cheaply -- this is not a flat penalty on the venue.
  assert.equal(+pons.costs(cand({ feeBps: 100, creatorTaxBps: 0 }), 10).detail.feeFractionRoundTrip.toFixed(4), 0.02);

  // Not read yet. The feed's placeholders are null, and null must not read as "no tax": that is what
  // let 25 trades through at an assumed 2% while they really cost about 22%.
  const unread = pons.costs(cand({ feeBps: null, creatorTaxBps: null }), 10);
  assert.equal(+unread.detail.feeFractionRoundTrip.toFixed(4), 0.12, "an unknown tax is assumed expensive");
  assert.equal(+pons.costs(cand(undefined), 10).detail.feeFractionRoundTrip.toFixed(4), 0.12, "and so is no curve at all");
  // It must never fall through to pump.fun's flat 3%, which is a number from the other chain.
  assert.notEqual(+pons.costs(cand(undefined), 10).detail.feeFractionRoundTrip.toFixed(4), 0.03);
  // pump.fun itself is untouched.
  assert.equal(+makePumpfunEdge({ aggression: 1 }).costs({ solPrice: 200, reference: { solPrice: 200 } }, 10).detail.feeFractionRoundTrip.toFixed(4), 0.03);

  // The hard cap: a round trip past the dial's limit is refused outright, whatever the token does.
  const tok = (taxBps) => ({ ca: "0xa", createdAt: Date.now() - 5 * 60_000, buys: 20, sells: 4, uniqueBuyers: { size: 12 }, trades: [], spark: [], curve: { feeBps: 100, creatorTaxBps: taxBps } });
  assert.equal(AGGRESSION[1].maxRoundTripBps, 600);
  assert.ok(checkDisqualifiers(tok(500), {}, AGGRESSION[1]).flags.includes("FEE_TOO_HIGH"), "1% + 5% = 12% round trip");
  assert.ok(!checkDisqualifiers(tok(100), {}, AGGRESSION[1]).flags.includes("FEE_TOO_HIGH"), "1% + 1% = 4% is fine");
  // Degen tolerates more, and still not a 10% tax.
  assert.equal(AGGRESSION[3].maxRoundTripBps, 1000);
  assert.ok(!checkDisqualifiers(tok(300), {}, AGGRESSION[3]).flags.includes("FEE_TOO_HIGH"));
  assert.ok(checkDisqualifiers(tok(1000), {}, AGGRESSION[3]).flags.includes("FEE_TOO_HIGH"));
  // Unread economics are not a reason to refuse here -- the cost model already assumes the worst.
  assert.ok(!checkDisqualifiers(tok(null), {}, AGGRESSION[1]).flags.includes("FEE_TOO_HIGH"));

  // pump.fun has no curve fees of its own and must never trip this rule.
  const solTok = { ca: "M", createdAt: Date.now() - 5 * 60_000, buys: 20, sells: 4, uniqueBuyers: { size: 12 }, trades: [], spark: [] };
  assert.ok(!checkDisqualifiers(solTok, {}, AGGRESSION[1]).flags.includes("FEE_TOO_HIGH"));
});

// A held token used to emit nothing at all when its curve read failed, because the "is the price
// readable" guard sat above the held-tick emit. No tick means the engine never runs an exit check:
// no stop loss, no crash exit, no trail, and the position rides to whatever the blind time exit
// finds minutes later. A held position must always produce a tick, even to say it cannot be priced.
test("T12: a held token whose curve read fails still ticks, and the tick says it is unreadable", async () => {
  const { PonsFeed } = await import("../../src/velocity/venues/pons/feed.mjs");
  let now = 1_800_000_000_000; const clock = () => now;
  const TOKEN = addr(0x81), CURVE = addr(0x82);
  let broken = false, head = 5000;
  const rpc = { blockNumber: async () => head, logs: async () => [],
    curveInfo: async () => { if (broken) throw new Error("execution reverted"); return { quoteReserve: 3.4, tokenReserve: 9e8, realQuoteReserve: 0.4, feeBps: 100, creatorTaxBps: 0, graduationThreshold: 4, native: true }; },
    tokenMeta: async () => ({ name: "Ghost", symbol: "GHST" }),
    launchInfo: async (t) => t === TOKEN ? { token: TOKEN, curve: CURVE, deployer: addr(0x83), pairToken: addr(0), graduationThreshold: 4, graduated: false } : null };
  const feed = new PonsFeed({ rpc, pollMs: 1000, ethPrice: 2000, clock });
  const events = []; feed.on("event", e => { if (e.kind !== "feed_health") events.push(e); });
  feed.watch(TOKEN);
  await feed.pollOnce();
  const good = events.filter(e => e.kind === "tick" && e.id === TOKEN);
  assert.equal(good.length, 1); assert.ok(good[0].payload.mcapUsd > 0);

  // Now the curve stops answering and the cached reading is wiped, the way a graduated pool or a
  // reverting read leaves it.
  broken = true;
  const t = feed.token(TOKEN);
  t.mcapUsd = 0; t._hydratedAt = 0;
  events.length = 0;
  now += 10_000; head += 5;
  await feed.pollOnce();
  const ticks = events.filter(e => e.kind === "tick" && e.id === TOKEN);
  assert.equal(ticks.length, 1, "a held position still gets a tick when it cannot be priced");
  assert.equal(ticks[0].payload.unreadable, true, "and the tick says so, so the exit layer can act on it");
  assert.equal(feed.status().unreadableTicks ?? feed.unreadableTicks, 1);
  // It is not offered as something to buy while it cannot be priced.
  assert.equal(events.filter(e => e.kind === "candidate" && e.id === TOKEN).length, 0);
});
