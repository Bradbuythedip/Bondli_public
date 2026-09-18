// T2: replaying the same event capture twice yields byte-identical decisions,
// and each edge model accepts and rejects what the design says it should.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEvent, resetSequence } from "../../src/velocity/core/events.mjs";
import { GateRunner } from "../../src/velocity/core/pipeline.mjs";
import { makePumpfunEdge } from "../../src/velocity/venues/pumpfun/edge.mjs";
import { makePolymarketEdge, sourcesMatch } from "../../src/velocity/venues/polymarket/edge.mjs";

const T0 = 1_700_000_000_000;

function goodToken(over = {}) {
  return {
    ca: "MintGood", name: "cat", ticker: "CAT", createdAt: T0 - 4 * 60_000, buys: 40, sells: 12, mcapUsd: 18_000,
    vSolInBondingCurve: 20, uniqueBuyers: { size: 25 }, volumeSol: 30, devWallet: "DevA",
    trades: Array.from({ length: 12 }, (_, i) => ({ time: T0 - 60_000 + i * 4_000, side: i % 4 === 3 ? "sell" : "buy", sol: 0.4 })),
    spark: [16_500, 17_200, 18_000, 17_600, 17_900, 18_000], _memeticQuick: 0.7, _survivorMatch: 55, _stabilityCount: 3, ...over,
  };
}
const goodQf = { rg_devSellSpeed: 0.05, _rg_sybilScore: 0.05, _rg_freshWalletRatio: 0.2, rg_holderConcentration: 0.2, ch_healthScore: 0.7, rg_walletAgeScore: 0.6, _whaleBullish: 0.25 };
const goodScores = { apeScore: 68, scoreTimestamp: T0, rugFlagCount: 0 };
const goodDyn = { scores: 4, velocity: 0.1, acceleration: 0.01, trend: "rising" };

function pumpEvents() {
  return [
    makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintGood", t_venue: T0 - 500, t_observed: T0, payload: { token: goodToken(), qf: goodQf, scores: goodScores, dynamics: goodDyn, solPrice: 150, mcapUsd: 18_000, vSolInBondingCurve: 20 } }),
    makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintDump", t_venue: T0 - 500, t_observed: T0 + 1000, payload: { token: goodToken({ ca: "MintDump" }), qf: { ...goodQf, rg_devSellSpeed: 0.9 }, scores: goodScores, dynamics: goodDyn, solPrice: 150 } }),
    makeEvent({ venue: "pumpfun", kind: "candidate", id: "MintLow", t_venue: T0 - 500, t_observed: T0 + 2000, payload: { token: goodToken({ ca: "MintLow" }), qf: goodQf, scores: { ...goodScores, apeScore: 30 }, dynamics: goodDyn, solPrice: 150 } }),
    makeEvent({ venue: "pumpfun", kind: "tick", id: "MintGood", t_venue: T0 + 2500, t_observed: T0 + 3000, payload: { mcapUsd: 19_000 } }),
  ];
}

function market(cid, tokens, over = {}) {
  return { conditionId: cid, id: cid, question: cid, outcomes: ["Yes", "No"], tokenIds: tokens, negRisk: false, groupId: null, active: true, closed: false, acceptingOrders: true, feeRateBps: 0, resolutionSource: "espn.com", umaResolutionStatus: null, ...over };
}
function polyEvents() {
  const e = [];
  let t = T0;
  const ev = (kind, id, payload) => e.push(makeEvent({ venue: "polymarket", kind, id, payload, t_venue: t - 100, t_observed: (t += 100) }));
  ev("market", "0xA", market("0xA", ["A1", "A2"]));
  ev("book", "A1", { tokenId: "A1", bestBid: 0.94, bidSize: 100, bestAsk: 0.96, askSize: 80, bids: [], asks: [] });
  ev("fact", "0xA", { conditionId: "0xA", outcome: "Yes", source: "https://www.espn.com/nba/boxscore", confidence: 0.98, t_fact: t });
  ev("book", "A1", { tokenId: "A1", bestBid: 0.97, bidSize: 100, bestAsk: 0.995, askSize: 80, bids: [], asks: [] });   // no room now
  ev("market", "0xB", market("0xB", ["B1", "B2"], { resolutionSource: "reuters.com" }));
  ev("book", "B1", { tokenId: "B1", bestBid: 0.9, bidSize: 50, bestAsk: 0.95, askSize: 50, bids: [], asks: [] });
  ev("fact", "0xB", { conditionId: "0xB", outcome: "Yes", source: "espn.com", confidence: 0.98, t_fact: t });          // source mismatch
  // negative-risk group of three
  for (const k of ["C1", "C2", "C3"]) ev("market", `0x${k}`, market(`0x${k}`, [`${k}Y`, `${k}N`], { negRisk: true, groupId: "G1" }));
  for (const k of ["C1", "C2", "C3"]) ev("book", `${k}Y`, { tokenId: `${k}Y`, bestBid: 0.3, bidSize: 100, bestAsk: 0.31, askSize: 100, bids: [], asks: [] });
  for (const k of ["C1", "C2", "C3"]) ev("book", `${k}N`, { tokenId: `${k}N`, bestBid: 0.68, bidSize: 100, bestAsk: 0.70, askSize: 100, bids: [], asks: [] });
  ev("market", "group:G1", { isGroup: true, groupId: "G1", conditionIds: ["0xC1", "0xC2", "0xC3"] });                   // sum YES asks 0.93 < 1
  return e;
}

function runAll(events, mkRunner) {
  const runner = mkRunner();
  const out = [];
  for (const ev of events) out.push(...runner.run(ev, { governor: { halt: false, throttle: 1 } }));
  return out;
}

test("T2: pump.fun replay is byte-identical and gates behave", () => {
  resetSequence(0);
  const a = runAll(pumpEvents(), () => new GateRunner({ venue: "pumpfun", edge: makePumpfunEdge() }));
  resetSequence(0);
  const b = runAll(pumpEvents(), () => new GateRunner({ venue: "pumpfun", edge: makePumpfunEdge() }));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.length, 3, "ticks are not candidates");
  const good = a.find(d => d.instrument === "MintGood");
  assert.equal(good.action, "GO");
  assert.equal(good.tier, 2);
  assert.ok(good.ev > 0);
  assert.equal(good.stop_fraction, 1.0);
  assert.equal(good.group, "DevA");
  const dump = a.find(d => d.instrument === "MintDump");
  assert.equal(dump.action, "REJECT");
  assert.equal(dump.gate, "disqualifiers");
  assert.ok(dump.reasons.includes("DEV_SELLING"));
  const low = a.find(d => d.instrument === "MintLow");
  assert.equal(low.gate, "viability");
});

test("T2: governor halt vetoes before any venue gate runs", () => {
  const runner = new GateRunner({ venue: "pumpfun", edge: makePumpfunEdge() });
  const [d] = runner.run(pumpEvents()[0], { governor: { halt: true, haltReason: "daily_limit" } });
  assert.equal(d.action, "REJECT");
  assert.equal(d.gate, "governor");
  const [z] = runner.run(pumpEvents()[0], { governor: { throttle: 0 } });
  assert.equal(z.reasons[0], "THROTTLE_ZERO");
});

test("T2: polymarket replay is byte-identical; resolved-fact and consistency models judge correctly", () => {
  resetSequence(0);
  const a = runAll(polyEvents(), () => new GateRunner({ venue: "polymarket", edge: makePolymarketEdge() }));
  resetSequence(0);
  const b = runAll(polyEvents(), () => new GateRunner({ venue: "polymarket", edge: makePolymarketEdge() }));
  assert.equal(JSON.stringify(a), JSON.stringify(b));

  const factGo = a.filter(d => d.model === "resolved_fact" && d.instrument === "A1");
  assert.equal(factGo[0].action, "GO", JSON.stringify(factGo[0]));
  assert.ok(Math.abs(factGo[0].payoff - (1 - 0.96) / 0.96) < 1e-6);
  assert.equal(factGo[1].action, "REJECT");
  assert.equal(factGo[1].gate, "price_room");
  const mismatch = a.find(d => d.instrument === "B1");
  assert.equal(mismatch.gate, "rules_source_match");

  const cons = a.filter(d => d.model === "consistency");
  assert.ok(cons.length >= 2, "group completion produces both YES-set and NO-set candidates");
  const yesSet = cons.find(d => d.instrument === "group:G1:yes");
  assert.equal(yesSet.action, "GO");
  assert.equal(yesSet.legs.length, 3);
  assert.ok(Math.abs(yesSet.payoff - (1 - 0.93) / 0.93) < 1e-6);
  const noSet = cons.find(d => d.instrument === "group:G1:no");
  assert.equal(noSet.action, "REJECT", "NO asks sum 2.10 > n-1 = 2, no room");
  assert.equal(noSet.gate, "price_room");
});

test("T2: consistency needs the full group from Gamma, never a partial set", () => {
  const edge = makePolymarketEdge();
  const runner = new GateRunner({ venue: "polymarket", edge });
  let t = T0;
  const ev = (kind, id, payload) => makeEvent({ venue: "polymarket", kind, id, payload, t_venue: t, t_observed: (t += 10) });
  runner.run(ev("market", "0xD1", market("0xD1", ["D1Y", "D1N"], { negRisk: true, groupId: "G2" })));
  runner.run(ev("market", "0xD2", market("0xD2", ["D2Y", "D2N"], { negRisk: true, groupId: "G2" })));
  for (const k of ["D1", "D2"]) {
    runner.run(ev("book", `${k}Y`, { tokenId: `${k}Y`, bestAsk: 0.2, askSize: 100, bestBid: 0.19, bidSize: 1 }));
    runner.run(ev("book", `${k}N`, { tokenId: `${k}N`, bestAsk: 0.81, askSize: 100, bestBid: 0.8, bidSize: 1 }));
  }
  // Without the group event no consistency candidate exists, even though 0.2+0.2 < 1.
  const before = runner.run(ev("book", "D1Y", { tokenId: "D1Y", bestAsk: 0.2, askSize: 100, bestBid: 0.19, bidSize: 1 }));
  assert.equal(before.filter(d => d.model === "consistency").length, 0);
  // The group says there is a third market we have no book for: still nothing.
  const partial = runner.run(ev("market", "group:G2", { isGroup: true, groupId: "G2", conditionIds: ["0xD1", "0xD2", "0xD3"] }));
  assert.equal(partial.length, 0);
});

test("T2: source matching is host-based and tolerant of protocol and paths", () => {
  assert.ok(sourcesMatch("espn.com official box score", "https://www.espn.com/nba/boxscore"));
  assert.ok(!sourcesMatch("reuters.com", "espn.com"));
  assert.ok(!sourcesMatch("", "espn.com"));
});
