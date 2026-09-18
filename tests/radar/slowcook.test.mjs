// The stale clock throws away everything older than 15 minutes. Some of those are still filling up:
// steady buyers, SOL coming in, the curve climbing. This is that pattern, and what must hold is that
// it fires only on the real thing — never on one burst, never on something fading, never on a token
// coasting sideways — and that it buys the token nothing but the clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RevivalTracker, revivalFilter, SLOWCOOK_DEFAULTS } from "../../src/api/revival.mjs";
import { checkDisqualifiers, TIMING_DISQUALIFIERS } from "../../src/autoape/gates/disqualifiers.js";

const MIN = 60_000;
const T0 = 1_800_000_000_000;

/** A token grinding up: `perBucket` fresh buyers in each 5-minute bucket, curve climbing `step` a bucket. */
function cook(tr, mint, { buckets = 6, perBucket = 3, step = 1, from = T0 - 30 * MIN, curve0 = 20, sol = 0.2, sellSol = 0 } = {}) {
  let w = 0;
  for (let b = 0; b < buckets; b++) {
    const at = from + b * 5 * MIN, curve = curve0 + b * step;
    for (let i = 0; i < perBucket; i++) tr.noteTrade(mint, { side: "buy", sol, wallet: `${mint}w${w++}`, curvePct: curve, ts: at + i * 30_000 });
    if (sellSol) tr.noteTrade(mint, { side: "sell", sol: sellSol, wallet: `${mint}s${b}`, curvePct: curve, ts: at + 4 * MIN });
  }
}
const sig = (tr, mint, ageMin = 40, now = T0) => tr.slowCook(mint, { createdAt: now - ageMin * MIN, now });

test("slowcook: steady buyers, SOL in, curve up — over a window the stale clock has already closed", () => {
  const tr = new RevivalTracker();
  cook(tr, "M");
  const s = sig(tr, "M");
  assert.equal(s.slowCook, true, JSON.stringify(s));
  assert.ok(s.buyers >= SLOWCOOK_DEFAULTS.minBuyers, `${s.buyers} distinct buyers`);
  // 5, not 6: the window's newest bucket starts at `now`, so it holds no past trades. The bar is
  // minActiveBuckets, which is what "steady" actually means here.
  assert.equal(s.activeBuckets, 5, "a buyer in every bucket of the window that has any past in it");
  assert.ok(s.netSol > 0);
  assert.ok(s.curveDelta >= SLOWCOOK_DEFAULTS.minCurveDeltaPts);
  assert.ok(s.recentShare >= SLOWCOOK_DEFAULTS.minRecentShare);
  // and this is the whole point: at 40 minutes old the launch feed's clock has long since run out
  assert.ok(s.ageMs > 15 * MIN);
});

test("slowcook: one burst is not a slow cook, however many buyers it brings", () => {
  const tr = new RevivalTracker();
  // 12 buyers, all inside one 5-minute bucket
  for (let i = 0; i < 12; i++) tr.noteTrade("B", { side: "buy", sol: 0.3, wallet: "b" + i, curvePct: 20 + i, ts: T0 - 2 * MIN + i * 5000 });
  const s = sig(tr, "B");
  assert.equal(s.slowCook, false);
  assert.ok(s.reasons.includes("ONE_BURST"), JSON.stringify(s.reasons));
});

test("slowcook: a token whose buying is all in the older half is fading, not cooking", () => {
  const tr = new RevivalTracker();
  cook(tr, "F", { buckets: 3, perBucket: 4, from: T0 - 30 * MIN });   // busy 30-15 min ago, silent since
  const s = sig(tr, "F");
  assert.equal(s.slowCook, false);
  assert.ok(s.reasons.includes("FADING"), JSON.stringify(s));
});

test("slowcook: a flat curve, SOL flowing out, or too few buyers each refuse it", () => {
  const flat = new RevivalTracker(); cook(flat, "C", { step: 0 });
  assert.ok(sig(flat, "C").reasons.includes("CURVE_NOT_MOVING"), "sideways is simmering, not cooking");

  const out = new RevivalTracker(); cook(out, "S", { sol: 0.1, sellSol: 1 });
  assert.ok(sig(out, "S").reasons.includes("SOL_FLOWING_OUT"));

  const thin = new RevivalTracker(); cook(thin, "T", { perBucket: 1, buckets: 6 });
  assert.ok(sig(thin, "T").reasons.includes("FEW_BUYERS"), "six buyers over half an hour is not a crowd");

  const whale = new RevivalTracker();
  for (let b = 0; b < 6; b++) for (let i = 0; i < 3; i++) whale.noteTrade("W", { side: "buy", sol: 2, wallet: "whale", curvePct: 20 + b, ts: T0 - 30 * MIN + b * 5 * MIN + i * 30_000 });
  assert.ok(sig(whale, "W").reasons.includes("FEW_BUYERS"), "volume from one wallet is one buyer");
});

test("slowcook: too young, unknown age, and never traded are all refused", () => {
  const tr = new RevivalTracker(); cook(tr, "M");
  assert.deepEqual(sig(tr, "M", 5).reasons, ["TOO_YOUNG_TO_BE_SLOW"], "inside the launch feed's own window");
  assert.deepEqual(tr.slowCook("M", { now: T0 }).reasons, ["AGE_UNKNOWN"]);
  assert.deepEqual(tr.slowCook("NOPE", { createdAt: T0 - 40 * MIN, now: T0 }).reasons, ["NO_TRADES"]);
});

test("slowcook: it is a different pattern from a revival, and neither answers for the other", () => {
  const tr = new RevivalTracker();
  cook(tr, "M", { buckets: 12, from: T0 - 60 * MIN });   // an hour of steady climbing
  assert.equal(sig(tr, "M", 90).slowCook, true);
  const rev = tr.signal("M", { createdAt: T0 - 90 * MIN, now: T0 });
  assert.equal(rev.revival, false, "it never went flat, so it is not a revival");
  assert.ok(rev.reasons.includes("NOT_FLAT_BEFORE") || rev.reasons.includes("NO_ACCELERATION"), JSON.stringify(rev.reasons));
});

test("slowcook: the one-actor filter still applies, and it is the same filter revivals use", () => {
  const tr = new RevivalTracker(); cook(tr, "M");
  const s = sig(tr, "M");
  assert.equal(s.slowCook, true);
  for (const [qf, why] of [
    [{ rg_devSellSpeed: 0.4 }, "DEV_SELLING_INTO_IT"],
    [{ _rg_sybilScore: 0.5 }, "BUYERS_ONE_SOURCE"],
    [{ _rg_freshWalletRatio: 0.8 }, "BUYERS_FRESH_WALLETS"],
    [{ _rg_singleWalletDominance: 0.7 }, "ONE_WALLET_VOLUME"],
  ]) {
    const f = revivalFilter({ ca: "M" }, qf, s);
    assert.equal(f.pass, false); assert.ok(f.reasons.includes(why), `${why}: ${f.reasons}`);
  }
  assert.equal(revivalFilter({ ca: "M" }, {}, s).pass, true, "a clean token passes");
});

// ── What the waiver is worth, and what it is not ──

const token = (over = {}) => ({ ca: "M", createdAt: Date.now() - 40 * MIN, buys: 22, sells: 6, uniqueBuyers: new Set(["a", "b", "c", "d", "e", "f", "g", "h"]), ...over });

test("slowcook: all it waives is the clock — every rug rule still judges the token", () => {
  const clean = token();
  const before = checkDisqualifiers(clean, {}, { staleMin: 15 });
  assert.equal(before.pass, false);
  assert.deepEqual(before.flags, ["STALE"]);
  assert.equal(before.timingOnly, true, "being 40 minutes old is not a rug finding");

  const after = checkDisqualifiers(clean, {}, { staleMin: Infinity });
  assert.equal(after.pass, true, "with the clock waived the clean token is judged on its merits");

  // the same waiver on a token that IS dangerous changes nothing about the refusal
  const dangerous = token();
  const r = checkDisqualifiers(dangerous, { rg_devSellSpeed: 0.9, _rg_devHoldPct: 0.5 }, { staleMin: Infinity });
  assert.equal(r.pass, false);
  assert.ok(r.flags.includes("DEV_SELLING") && r.flags.includes("DEV_HOLDS_SUPPLY"));
  assert.equal(r.timingOnly, false, "a dev emptying the curve is not a timing problem");
});

test("slowcook: a timing refusal is never reported as a rug, and a mixed one is never reported as timing", () => {
  for (const f of ["TOO_LATE", "STALE", "TOO_FEW_BUYERS", "TOO_YOUNG"]) assert.ok(TIMING_DISQUALIFIERS.has(f), f);
  for (const f of ["DEV_SELLING", "SYBIL_ATTACK", "BOTTED_VOLUME", "FREEZE_AUTHORITY"]) assert.ok(!TIMING_DISQUALIFIERS.has(f), f);

  // a clean token that is merely too new and too thin: timing, all of it
  const early = checkDisqualifiers({ ca: "E", createdAt: Date.now() - 5_000, buys: 2, sells: 0, uniqueBuyers: new Set(["a"]) }, {}, {});
  assert.equal(early.timingOnly, true, JSON.stringify(early.flags));
  assert.ok(early.flags.includes("TOO_YOUNG") && early.flags.includes("TOO_FEW_BUYERS"));

  // one rug flag among the timing ones and it is a rug refusal
  const mixed = checkDisqualifiers(token(), { rg_devSellSpeed: 0.9 }, { staleMin: 15 });
  assert.ok(mixed.flags.includes("STALE") && mixed.flags.includes("DEV_SELLING"));
  assert.equal(mixed.timingOnly, false);

  // and a token that passes has nothing to classify
  assert.equal(checkDisqualifiers(token(), {}, { staleMin: Infinity }).timingOnly, false);
});

// ── The word the page shows ──

test("slowcook: the page never calls a timing refusal a rug, and never calls a rug anything else", async () => {
  const { tagFor, VERDICT_TAGS } = await import("../../src/api/verdict-tag.mjs");

  // the complaint, exactly: a clean token refused for the clock
  assert.equal(tagFor({ enter: false, gate: "timing", reasons: ["STALE"] }), "late");
  assert.equal(tagFor({ enter: false, gate: "timing", reasons: ["TOO_LATE"] }), "late");
  assert.equal(tagFor({ enter: false, gate: "timing", reasons: ["TOO_FEW_BUYERS"] }), "fewbuyers");
  assert.equal(tagFor({ enter: false, gate: "timing", reasons: ["TOO_YOUNG"] }), "new");

  // a rug is a rug whatever else is true of the token — being a slow cook does not soften it
  assert.equal(tagFor({ enter: false, gate: "rug", reasons: ["DEV_SELLING"] }), "rug");
  assert.equal(tagFor({ enter: false, gate: "rug", reasons: ["DEV_SELLING"] }, true), "rug", "cooking never outranks a rug finding");

  // still cooking, refused for score or timing: say that, it is the useful thing
  assert.equal(tagFor({ enter: false, gate: "viability", reasons: ["SCORE_BELOW_FLOOR"] }, true), "cooking");
  assert.equal(tagFor({ enter: false, gate: "timing", reasons: ["STALE"] }, true), "cooking");
  assert.equal(tagFor({ enter: true, gate: null, reasons: [] }, true), "hot", "entering beats every label");

  assert.equal(tagFor({ enter: false, gate: "viability", reasons: ["MCAP_BELOW_FLOOR"] }), "small");
  assert.equal(tagFor({ enter: false, gate: "confidence", reasons: ["WATCHLIST"] }), "close");
  assert.equal(tagFor({ enter: false, gate: "window", reasons: ["SCORE_TOO_OLD"] }), "close");
  assert.equal(tagFor(null), "weak");
  assert.equal(tagFor({ enter: false, gate: "wat", reasons: [] }), "weak", "an unknown gate is never a rug");

  // every word the function can produce is one the page knows how to render
  for (const gate of ["rug", "timing", "viability", "confidence", "window", null, "unknown"])
    for (const reasons of [[], ["STALE"], ["TOO_LATE"], ["TOO_YOUNG"], ["TOO_FEW_BUYERS"], ["MCAP_BELOW_FLOOR"], ["SCORE_BELOW_FLOOR"]])
      for (const c of [true, false])
        assert.ok(VERDICT_TAGS.includes(tagFor({ enter: false, gate, reasons }, c)), `${gate} ${reasons} ${c}`);
});

// ── Robinhood Chain feeds the same history ──

test("slowcook: PONS trades reach the tracker, so a Robinhood Chain token can cook too", async () => {
  const { PonsFeed } = await import("../../src/velocity/venues/pons/feed.mjs");
  const addr = n => "0x" + n.toString(16).padStart(40, "0");
  const tok = addr(0x61), curve = addr(0x62);
  const tr = new RevivalTracker();
  const seen = [];
  const rpc = { blockNumber: async () => 1, logs: async () => [], curveInfo: async () => ({}), tokenMeta: async () => ({}) };
  const feed = new PonsFeed({ rpc, ethPrice: 2000, onTrade: (t, x) => { seen.push(x); tr.noteTrade(t.ca, { side: x.side, sol: x.quote, wallet: x.wallet, curvePct: x.curvePct, ts: x.ts }); } });
  feed.apply({ kind: "launch", token: tok, curve, deployer: addr(0x63), pairToken: addr(0), graduationThreshold: 4, block: 1, tx: "0x" });

  // half an hour of steady buying, three fresh wallets every five minutes, the curve climbing
  let w = 0;
  for (let b = 0; b < 6; b++) for (let i = 0; i < 3; i++)
    feed.apply({ kind: "buy", curve, wallet: "0xb" + w++, quote: 0.05, fee: 0, tax: 0, tokens: 1e6, tx: "0x" }, T0 - 28 * MIN + b * 5 * MIN + i * 30_000);

  assert.equal(seen.length, 18, "every trade reached the listener");
  assert.ok(seen.every(x => x.side === "buy" && x.wallet && x.ts), JSON.stringify(seen[0]));
  const s = tr.slowCook(tok, { createdAt: T0 - 45 * MIN, now: T0 });
  assert.equal(s.slowCook, true, JSON.stringify(s));
  assert.equal(s.buyers, 15, "the 3 from the bucket that falls outside the 30-minute window do not count");
  assert.equal(s.activeBuckets, 5);

  // and a listener that throws never stops the feed applying the trade
  const rude = new PonsFeed({ rpc, ethPrice: 2000, onTrade: () => { throw new Error("boom"); } });
  rude.apply({ kind: "launch", token: tok, curve, deployer: addr(0x63), pairToken: addr(0), graduationThreshold: 4, block: 1, tx: "0x" });
  rude.apply({ kind: "buy", curve, wallet: "0xb1", quote: 0.05, fee: 0, tax: 0, tokens: 1e6, tx: "0x" }, T0);
  assert.equal(rude.tokens.get(tok).buys, 1, "the trade was applied despite the listener throwing");
});
