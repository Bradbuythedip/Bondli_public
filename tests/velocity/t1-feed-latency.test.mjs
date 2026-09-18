// T1: p95 of (t_observed - t_venue) inside the per-venue bound, and every adapter
// turns its raw source into valid MarketEvents without touching the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateEvent, LatencyHistogram, resetSequence } from "../../src/velocity/core/events.mjs";
import { ScriptedFeed } from "../../src/velocity/core/feed.mjs";
import { ReplayFeed, writeCapture, readCapture } from "../../src/velocity/core/replay.mjs";
import { PumpfunFeed, parseScoredResponse, parsePumpPortalTrade } from "../../src/velocity/venues/pumpfun/feed.mjs";
import { PolymarketFeed, parseMarket, parseClobMessage, FileFactSource } from "../../src/velocity/venues/polymarket/feed.mjs";
import { PerpsFeed } from "../../src/velocity/venues/perps/stub.mjs";

test("T1: latency histogram p95 within bound on a one-hour-equivalent capture", () => {
  const h = new LatencyHistogram();
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 3600; i++) h.record(rnd() * 400);      // pump.fun: bound 500ms
  assert.ok(h.percentile(95) <= 500, `p95 ${h.percentile(95)}`);
  assert.equal(h.count, 3600);
  const slow = new LatencyHistogram();
  for (let i = 0; i < 100; i++) slow.record(i < 90 ? 100 : 900);
  assert.ok(slow.percentile(95) > 500, "a 10% tail of 900ms must breach a 500ms bound");
});

test("T1: scripted feed stamps t_observed from its clock and reports status", async () => {
  let now = 10_000;
  const feed = new ScriptedFeed({ venue: "pumpfun", clock: () => now, latencyBoundMs: 500, script: [
    { delayMs: 0, kind: "candidate", id: "A", payload: { x: 1 }, lagMs: 120 },
    { delayMs: 0, kind: "tick", id: "A", payload: { mcapUsd: 5000 }, lagMs: 40 },
  ] });
  const got = [];
  feed.on("event", e => got.push(e));
  await feed.start();
  await new Promise(r => setTimeout(r, 30));
  await feed.stop();
  const real = got.filter(e => e.kind !== "feed_health");
  assert.equal(real.length, 2);
  for (const e of real) assert.deepEqual(validateEvent(e), []);
  assert.equal(real[0].t_observed - real[0].t_venue, 120);
  const st = feed.status();
  assert.equal(st.withinBound, true);
  assert.equal(st.events, 2);
});

test("T1: pump.fun feed parses bondli scored radar into candidates and ticks", async () => {
  const canned = {
    ts: 1_700_000_000_000, solPrice: 150, gradMc: 67000, count: 1,
    tokens: [{
      token: { ca: "MintAAA", name: "cat", ticker: "CAT", createdAt: 1_699_999_940_000, buys: 12, sells: 3, mcapUsd: 9000, vSolInBondingCurve: 12, uniqueBuyers: 9, trades: [{ time: 1_699_999_990_000, side: "buy", sol: 0.5 }], spark: [8000, 9000] },
      qf: { rg_devSellSpeed: 0.1, _rg_sybilScore: 0.05 },
      dynamics: { scores: 3, velocity: 0.2, acceleration: 0.01, trend: "rising" },
      scores: { apeScore: 66, scoreTimestamp: 1_700_000_000_000, rugFlagCount: 0 },
      t_venue: 1_699_999_990_000,
    }],
  };
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/radar/scored")) return res.end(JSON.stringify(canned));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const feed = new PumpfunFeed({ bondliUrl: `http://127.0.0.1:${port}`, clock: () => 1_700_000_000_250 });
  const got = [];
  feed.on("event", e => got.push(e));
  const n = await feed.pollOnce();
  assert.equal(n, 1);
  const cand = got.find(e => e.kind === "candidate");
  assert.equal(cand.id, "MintAAA");
  assert.equal(cand.payload.token.uniqueBuyers.size, 9);
  assert.equal(cand.payload.scores.apeScore, 66);
  assert.equal(cand.payload.qf.rg_devSellSpeed, 0.1);
  assert.equal(cand.t_observed - cand.t_venue, 10_250);
  feed.watch("MintAAA");
  const ticks = await feed.tickOnce();
  assert.equal(ticks, 1);
  assert.equal(got.filter(e => e.kind === "tick")[0].payload.mcapUsd, 9000);
  server.close();

  const rows = parseScoredResponse({ tokens: [{ token: { ca: "X", uniqueBuyers: 2 } }], solPrice: 1 });
  assert.equal(rows[0].payload.token.uniqueBuyers.size, 2);
  const tick = parsePumpPortalTrade({ mint: "X", txType: "buy", marketCapSol: 40, vSolInBondingCurve: 35, solAmount: 0.2, traderPublicKey: "W" }, 150);
  assert.equal(tick.payload.mcapUsd, 6000);
  assert.equal(parsePumpPortalTrade({ mint: "X", txType: "create" }, 150), null);
});

test("T1: polymarket feed parses Gamma markets, CLOB books, and file facts", async () => {
  const m = parseMarket({
    id: 501, conditionId: "0xabc", question: "Will X win?", outcomes: '["Yes","No"]', clobTokenIds: '["111","222"]',
    outcomePrices: '["0.97","0.03"]', negRisk: false, endDate: "2026-10-01", active: true, closed: false, liquidity: "25000",
    volume24hr: 12000, description: "This market resolves to Yes if X wins. Resolution source: espn.com official box score.",
  });
  assert.equal(m.tokenIds[0], "111");
  assert.equal(m.resolutionSource, "espn.com official box score");
  assert.equal(m.outcomePrices[1], 0.03);
  assert.equal(parseMarket({ conditionId: "0x1", outcomes: '["A"]', clobTokenIds: "[]" }), null);

  const cache = new Map();
  const books = parseClobMessage([{ event_type: "book", asset_id: "111", market: "0xabc", timestamp: "1700000000000",
    bids: [{ price: "0.95", size: "100" }, { price: "0.96", size: "50" }], asks: [{ price: "0.98", size: "40" }, { price: "0.97", size: "10" }] }], cache);
  assert.equal(books.length, 1);
  assert.equal(books[0].payload.bestBid, 0.96);
  assert.equal(books[0].payload.bestAsk, 0.97);
  assert.equal(books[0].payload.askSize, 10);
  const change = parseClobMessage({ event_type: "price_change", market: "0xabc", timestamp: "1700000000500", price_changes: [{ asset_id: "111", side: "SELL", price: "0.975", size: "30" }] }, cache);
  assert.equal(change[0].payload.bestAsk, 0.975);
  assert.equal(change[0].payload.bestBid, 0.96);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velocity-t1-"));
  const factFile = path.join(dir, "facts.json");
  fs.writeFileSync(factFile, JSON.stringify([{ conditionId: "0xabc", outcome: "Yes", source: "espn.com", confidence: 0.98, t_fact: 1_700_000_000_000 }]));
  const feed = new PolymarketFeed({ factSources: [new FileFactSource({ path: factFile })], clock: () => 1_700_000_000_100 });
  const got = [];
  feed.on("event", e => got.push(e));
  assert.equal(await feed.pollFacts(), 1);
  assert.equal(await feed.pollFacts(), 0, "same fact is not re-emitted");
  const fact = got.find(e => e.kind === "fact");
  assert.equal(fact.payload.outcome, "Yes");
  assert.equal(fact.t_observed - fact.t_venue, 100);
  assert.equal(feed.handleWsMessage(JSON.stringify([{ event_type: "book", asset_id: "222", bids: [], asks: [{ price: "0.05", size: "1" }] }])), 1);
  assert.deepEqual(validateEvent(got.at(-1)), []);
});

test("T1: capture and replay reproduce the same events with the same times", async () => {
  resetSequence(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velocity-t1r-"));
  const file = path.join(dir, "cap.jsonl");
  let now = 5_000;
  const src = new ScriptedFeed({ venue: "polymarket", clock: () => now, script: [{ kind: "book", id: "111", payload: { bestAsk: 0.9 }, lagMs: 50 }] });
  const events = [];
  src.on("event", e => e.kind !== "feed_health" && events.push(e));
  await src.start(); await new Promise(r => setTimeout(r, 20)); await src.stop();
  writeCapture(file, events);
  const replay = new ReplayFeed({ venue: "polymarket", events: readCapture(file), clock: () => 999_999 });
  const out = [];
  replay.on("event", e => out.push(e));
  await replay.start();
  assert.equal(out.length, 1);
  assert.equal(out[0].t_observed, events[0].t_observed);
  assert.equal(out[0].t_venue, events[0].t_venue);
});

test("T1: perps stub refuses to start", async () => {
  await assert.rejects(() => new PerpsFeed().start(), /disabled/);
});
