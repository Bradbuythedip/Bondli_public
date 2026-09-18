// Verified callouts: the bot's own fills, anchored in the ledger before they are posted anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Callouts, resultLine, heldLabel } from "../../src/velocity/core/callouts.mjs";
import { RECORD_KINDS } from "../../src/velocity/core/ledger.mjs";

const T0 = 1_700_000_000_000;
const TG = "https://api.telegram.org/bot123:abc/sendMessage";
const HOOK = "https://hooks.example.com/T000/B000";

/** Everything at the boundary is injected: a ledger that records, a clock we move, a fetch that captures. */
function harness({ telegramThrows = false, webhookThrows = false, minTier = 2, dedupeMs, statusUrl = "https://bondli.up.railway.app" } = {}) {
  let now = T0;
  const log = [];  // every boundary event in the order it happened, so ordering itself can be asserted
  const ledgerRecords = [];
  const ledger = {
    append(r) { if (!RECORD_KINDS.includes(r.kind)) throw new Error(`unknown kind ${r.kind}`); const rec = { seq: ledgerRecords.length + 1, ts: r.ts ?? now, ...r }; ledgerRecords.push(rec); log.push({ ledger: rec }); return rec; },
    query({ kind, limit = 100 }) { return ledgerRecords.filter(r => !kind || r.kind === kind).slice(-limit); },
  };
  const requests = [];
  let tgMessageId = 100;
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push({ url, body });
    log.push({ fetch: url });
    if (url.startsWith("https://api.telegram.org")) {
      if (telegramThrows) throw new Error("ECONNRESET");
      return { ok: true, json: async () => ({ ok: true, result: { message_id: ++tgMessageId } }) };
    }
    if (webhookThrows) throw new Error("ECONNRESET");
    return { ok: true };
  };
  const callouts = new Callouts({
    ledger, clock: () => now, fetchImpl, sleepImpl: async () => {}, statusUrl, minTier, dedupeMs,
    channels: { webhookUrl: HOOK, telegram: { token: "123:abc", chatId: "-1001" } },
  });
  return { callouts, ledgerRecords, requests, log, tick: ms => { now += ms; }, now: () => now };
}

const position = (instrument, over = {}) => ({
  id: `pumpfun:${instrument}:${T0}`, venue: "pumpfun", instrument, tier: 2, paper: false, entryTime: T0, cost_usd: 25,
  plan: { key: 2, label: "STRONG", mode: "bondli_layers", max_hold_ms: 15 * 60_000 },
  reference: { name: "cat", ticker: "CAT", mcapUsd: 18_000 },
  wallet: "OwnerWalletThatMustNeverLeak", userId: "user-42",
  ...over,
});

test("T21: a live tier-2 fill is anchored in the ledger first, then posted to both channels with its tx and hash", async () => {
  const h = harness();
  const r = await h.callouts.onFill(position("MintA"), { venue: "pumpfun", tx: "5igAbcSig", mcapUsd: 18_000, tier: 2, plan: { key: 2, label: "STRONG", max_hold_ms: 15 * 60_000 }, paper: false });
  assert.equal(r.posted, true);
  assert.deepEqual(r.channels, { webhook: "ok", telegram: "ok" });
  assert.equal(typeof r.id, "string");

  // The anchor: the same hash any reader can recompute from the public fields, written before any fetch.
  // The recipe covers everything the call declares: venue|instrument|tx|ts|mcapUsd|tier|plan.
  const expected = createHash("sha256").update(`pumpfun|MintA|5igAbcSig|${T0}|18000|2|STRONG, max hold 15m`).digest("hex");
  assert.equal(r.hash, expected);
  const firstLedger = h.log.findIndex(e => e.ledger?.kind === "callout" && e.ledger.phase === "call");
  const firstFetch = h.log.findIndex(e => e.fetch);
  assert.ok(firstLedger >= 0 && firstFetch >= 0 && firstLedger < firstFetch, "the ledger record must land before the first post goes out");
  const anchor = h.ledgerRecords.find(x => x.phase === "call");
  assert.equal(anchor.hash, expected);
  assert.equal(anchor.tx, "5igAbcSig");
  assert.equal(anchor.ts, T0);
  assert.equal(anchor.wallet, undefined);

  // Both channels got the tx and the hash prefix.
  const hook = h.requests.find(q => q.url === HOOK).body;
  const tg = h.requests.find(q => q.url === TG).body;
  assert.ok(hook.text.includes("5igAbcSig") && hook.text.includes(expected.slice(0, 16)));
  assert.equal(hook.content, hook.text);
  assert.ok(hook.text.includes("solscan.io/tx/5igAbcSig"), "the tx is a link anyone can open");
  assert.ok(hook.text.includes("$18,000") && hook.text.includes("tier 2") && hook.text.includes("STRONG"), "mcap at post, tier and the declared plan");
  assert.ok(hook.text.includes("https://bondli.up.railway.app/callouts"));
  assert.equal(tg.chat_id, "-1001");
  assert.equal(tg.parse_mode, "HTML");
  assert.ok(tg.text.includes("5igAbcSig") && tg.text.includes(expected.slice(0, 16)));
  assert.ok(!hook.text.includes("OwnerWallet") && !tg.text.includes("OwnerWallet"));

  // The delivery outcome is in the ledger too.
  const delivery = h.ledgerRecords.find(x => x.phase === "delivery");
  assert.deepEqual(delivery.channels, { webhook: "ok", telegram: "ok" });
  assert.equal(delivery.posted, true);
});

test("T21: a paper fill posts nothing and writes nothing", async () => {
  const h = harness();
  const r = await h.callouts.onFill(position("MintP", { paper: true }), { venue: "pumpfun", tx: "paper-1", mcapUsd: 18_000, tier: 3, paper: true });
  assert.equal(r.posted, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.ledgerRecords.length, 0);
  assert.equal(h.callouts.feed().length, 0);
  // The option wins over the position: a paper flag on either side is enough to stay silent.
  const r2 = await h.callouts.onFill(position("MintQ", { paper: false }), { venue: "pumpfun", tx: "x", mcapUsd: 1, tier: 3, paper: true });
  assert.equal(r2.posted, false);
  assert.equal(h.requests.length, 0);
});

test("T21: a fill below minTier is traded but not called", async () => {
  const h = harness({ minTier: 2 });
  const r = await h.callouts.onFill(position("MintT", { tier: 1 }), { venue: "pumpfun", tx: "sigT", mcapUsd: 9_000, tier: 1, paper: false });
  assert.equal(r.posted, false);
  assert.match(r.reason, /tier 1/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.ledgerRecords.length, 0);
  assert.equal(h.callouts.status().skipped.tier, 1);
});

test("T21: one callout per instrument per hour, across the whole hub; a fresh hour calls again", async () => {
  const h = harness();
  assert.equal((await h.callouts.onFill(position("MintD"), { venue: "pumpfun", tx: "sig1", mcapUsd: 10_000, tier: 2, paper: false })).posted, true);
  const posts = h.requests.length;
  h.tick(30 * 60_000);
  // Another user's engine buying the same coin: same instrument, different position, still one call.
  const again = await h.callouts.onFill(position("MintD", { id: "other-user-pos", wallet: "SomeoneElse" }), { venue: "pumpfun", tx: "sig2", mcapUsd: 14_000, tier: 3, paper: false });
  assert.equal(again.posted, false);
  assert.equal(again.reason, "already called");
  assert.equal(h.requests.length, posts);
  assert.equal(h.callouts.feed().length, 1);
  h.tick(31 * 60_000);
  const later = await h.callouts.onFill(position("MintD"), { venue: "pumpfun", tx: "sig3", mcapUsd: 12_000, tier: 2, paper: false });
  assert.equal(later.posted, true);
  assert.equal(h.callouts.feed().length, 2);
});

test("T21: the outcome is folded into the record and posted as a reply, losses included", async () => {
  const h = harness();
  const call = await h.callouts.onFill(position("MintO"), { venue: "pumpfun", tx: "sigO", mcapUsd: 18_000, tier: 2, paper: false });
  const tgMessageId = h.requests.find(q => q.url === TG) && h.ledgerRecords.find(x => x.phase === "delivery").messageIds.telegram;
  assert.equal(typeof tgMessageId, "number");
  h.tick(3 * 60_000);
  const before = h.requests.length;
  const out = await h.callouts.onOutcome({ kind: "outcome", venue: "pumpfun", instrument: "MintO", positionId: `pumpfun:MintO:${T0}`, pnl_usd: 10.5, pnl_pct: 42, held_ms: 3 * 60_000, reason: "TARGET_2", paper: false });
  assert.equal(out.posted, true);
  assert.equal(out.id, call.id);
  assert.equal(h.requests.length, before + 2);
  const hook = h.requests.slice(before).find(q => q.url === HOOK).body;
  const tg = h.requests.slice(before).find(q => q.url === TG).body;
  assert.ok(hook.text.includes("+42% in 3m"), hook.text);
  assert.ok(tg.text.includes("+42% in 3m"));
  assert.equal(tg.reply_to_message_id, tgMessageId, "the follow-up threads under the original post");

  const row = h.callouts.feed()[0];
  assert.deepEqual(row.result, { pnl_pct: 42, held_ms: 180_000, reason: "TARGET_2" });
  const ledgerResult = h.ledgerRecords.find(x => x.phase === "result");
  assert.equal(ledgerResult.id, call.id);
  assert.deepEqual(ledgerResult.result, row.result);
  assert.deepEqual(h.callouts.record(), { calls: 1, resolved: 1, wins: 1, winRate: 1, avgPct: 42, best: 42 });

  // A loser is posted with the same enthusiasm.
  h.tick(60 * 60_000 + 1);
  await h.callouts.onFill(position("MintL"), { venue: "pumpfun", tx: "sigL", mcapUsd: 9_000, tier: 2, paper: false });
  h.tick(45_000);
  const n = h.requests.length;
  const lost = await h.callouts.onOutcome({ kind: "outcome", venue: "pumpfun", instrument: "MintL", pnl_pct: -8, held_ms: 45_000, reason: "STOP_LOSS", paper: false });
  assert.equal(lost.posted, true);
  assert.ok(h.requests.slice(n).find(q => q.url === HOOK).body.text.includes("-8% stopped"));
  assert.deepEqual(h.callouts.record(), { calls: 2, resolved: 2, wins: 1, winRate: 0.5, avgPct: 17, best: 42 });

  // An outcome for something never called is nothing to post.
  const stranger = await h.callouts.onOutcome({ venue: "pumpfun", instrument: "NeverCalled", pnl_pct: 300, held_ms: 1000, reason: "TARGET_3" });
  assert.equal(stranger.posted, false);
  assert.equal(h.requests.length, n + 2);
});

test("T21: a channel that throws is recorded as error, the other still posts, and nothing throws out", async () => {
  const h = harness({ telegramThrows: true });
  const r = await h.callouts.onFill(position("MintE"), { venue: "pons", tx: "0xdeadbeef", mcapUsd: 5_000, tier: 2, paper: false });
  assert.equal(r.posted, true, "one channel reaching people is a post");
  assert.deepEqual(r.channels, { webhook: "ok", telegram: "error" });
  assert.equal(h.requests.filter(q => q.url === HOOK).length, 1);
  assert.equal(h.requests.filter(q => q.url === TG).length, 2, "a dead receiver is retried once, then given up on");
  const delivery = h.ledgerRecords.find(x => x.phase === "delivery");
  assert.equal(delivery.channels.telegram, "error");
  assert.equal(delivery.errors.telegram, "ECONNRESET");
  assert.equal(delivery.posted, true);
  assert.match(h.callouts.status().lastError, /telegram: ECONNRESET/);
  // The anchor was written regardless and the dedupe holds: a fill whose channels are down is still called.
  assert.ok(h.ledgerRecords.find(x => x.phase === "call" && x.hash === r.hash));
  assert.equal((await h.callouts.onFill(position("MintE"), { venue: "pons", tx: "0xagain", mcapUsd: 5_000, tier: 2, paper: false })).reason, "already called");

  // Every channel dead: still no throw, the record says so, and the trade is unaffected.
  const dark = harness({ telegramThrows: true, webhookThrows: true });
  const d = await dark.callouts.onFill(position("MintZ"), { venue: "pumpfun", tx: "sigZ", mcapUsd: 5_000, tier: 2, paper: false });
  assert.equal(d.posted, false);
  assert.deepEqual(d.channels, { webhook: "error", telegram: "error" });
  assert.equal(dark.ledgerRecords.find(x => x.phase === "delivery").posted, false);
  const o = await dark.callouts.onOutcome({ venue: "pumpfun", instrument: "MintZ", pnl_pct: 5, held_ms: 1000, reason: "TARGET_1" });
  assert.equal(o.posted, false);
  assert.equal(dark.callouts.record().resolved, 1, "the record is kept even when nobody could be told");

  // A ledger that fails is the worst boundary there is, and even that never reaches the engine.
  const broken = new Callouts({ ledger: { append() { throw new Error("disk full"); } }, clock: () => T0, fetchImpl: async () => ({ ok: true }), channels: { webhookUrl: HOOK } });
  const b = await broken.onFill(position("MintB"), { venue: "pumpfun", tx: "sigB", mcapUsd: 1, tier: 2, paper: false });
  assert.equal(b.posted, false);
  assert.equal(b.error, "disk full");
});

test("T21: the public feed carries no wallet or user anywhere, and is newest first with the fields a reader needs", async () => {
  const h = harness();
  await h.callouts.onFill(position("MintF1"), { venue: "pumpfun", tx: "sigF1", mcapUsd: 18_000, tier: 2, paper: false });
  h.tick(1000);
  await h.callouts.onFill(position("MintF2", { venue: "pons", reference: { name: "dog", ticker: "DOG", mcapUsd: 7_000, wallet: "LeakyRef" } }), { venue: "pons", tx: "0xF2", mcapUsd: 7_000, tier: 3, paper: false });
  await h.callouts.onOutcome({ venue: "pumpfun", instrument: "MintF1", pnl_pct: 12.5, held_ms: 90_000, reason: "TARGET_1" });
  const feed = h.callouts.feed(10);
  assert.equal(feed.length, 2);
  assert.equal(feed[0].instrument, "MintF2");
  assert.equal(feed[1].instrument, "MintF1");
  const json = JSON.stringify(feed);
  assert.ok(!/wallet/i.test(json), json);
  assert.ok(!/user/i.test(json), json);
  assert.ok(!json.includes("OwnerWallet") && !json.includes("LeakyRef") && !json.includes("user-42"));
  assert.deepEqual(Object.keys(feed[0]).sort(), ["hash", "id", "instrument", "mcapUsd", "name", "plan", "result", "ticker", "tier", "ts", "tx", "txUrl", "url", "venue"]);
  assert.equal(feed[0].result, null);
  assert.deepEqual(feed[1].result, { pnl_pct: 12.5, held_ms: 90_000, reason: "TARGET_1" });
  assert.equal(feed[0].url, "https://www.ponsfamily.com/launchpad/MintF2");
  assert.equal(feed[1].url, "https://pump.fun/coin/MintF1");
  assert.equal(feed[0].hash.length, 64);
  assert.equal(h.callouts.feed(1).length, 1);
  // The same anchor is also in the ledger, and the ledger record leaks nothing either.
  assert.ok(!/wallet|user/i.test(JSON.stringify(h.ledgerRecords)));
});

test("T21: a restart rebuilds the record and the dedupe window from the ledger, so nothing is called twice", async () => {
  const h = harness();
  const first = await h.callouts.onFill(position("MintR"), { venue: "pumpfun", tx: "sigR", mcapUsd: 18_000, tier: 2, paper: false });
  await h.callouts.onOutcome({ venue: "pumpfun", instrument: "MintR", pnl_pct: 20, held_ms: 60_000, reason: "TARGET_1" });
  h.tick(10 * 60_000);
  await h.callouts.onFill(position("MintS"), { venue: "pumpfun", tx: "sigS", mcapUsd: 8_000, tier: 2, paper: false });
  const posts = h.requests.length;
  // Same ledger, new process.
  const ledger = { append: r => ({ ...r }), query: ({ kind, limit = 100 }) => h.ledgerRecords.filter(r => r.kind === kind).slice(-limit) };
  const reborn = new Callouts({ ledger, clock: h.now, fetchImpl: async (url, opts) => { h.requests.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; }, sleepImpl: async () => {}, channels: { webhookUrl: HOOK } });
  assert.deepEqual(reborn.feed().map(c => c.instrument), ["MintS", "MintR"]);
  assert.deepEqual(reborn.record(), { calls: 2, resolved: 1, wins: 1, winRate: 1, avgPct: 20, best: 20 });
  assert.equal(reborn.feed()[1].hash, first.hash);
  assert.equal((await reborn.onFill(position("MintS"), { venue: "pumpfun", tx: "sigS2", mcapUsd: 8_000, tier: 2, paper: false })).reason, "already called");
  assert.equal(h.requests.length, posts);
});

test("T21: result lines read the way a person says them", () => {
  assert.equal(resultLine({ pnl_pct: 42, held_ms: 3 * 60_000, reason: "TARGET_2" }), "+42% in 3m");
  assert.equal(resultLine({ pnl_pct: -8, held_ms: 45_000, reason: "STOP_LOSS" }), "-8% stopped after 45s");
  assert.equal(resultLine({ pnl_pct: -3.5, held_ms: 4 * 60_000, reason: "STALL" }), "-3.5% cut flat after 4m");
  assert.equal(resultLine({ pnl_pct: -12, held_ms: 15 * 60_000, reason: "MAX_HOLD" }), "-12% timed out after 15m");
  assert.equal(resultLine({ pnl_pct: 0, held_ms: 500, reason: "DOA" }), "0% cut flat after 1s", "flat is not a win");
  assert.equal(heldLabel(75 * 60_000), "1h15m");
});

test("T21: a call is bound to the fill that made it: a paper close, another engine's close and a second close never resolve it; a fill with no tx is not called", async () => {
  const h = harness();
  const call = await h.callouts.onFill(position("MintB"), { venue: "pumpfun", tx: "sigB", mcapUsd: 18_000, tier: 2, paper: false });
  assert.equal(call.posted, true);
  const before = h.requests.length, results = () => h.ledgerRecords.filter(r => r.phase === "result").length;
  // A paper engine on the shared hub closes the same token at -30%: not a result, not posted, not written.
  let r = await h.callouts.onOutcome({ instrument: "MintB", positionId: `pumpfun:MintB:${T0}`, pnl_pct: -30, held_ms: 59_000, reason: "STOP_LOSS", paper: true });
  assert.equal(r.posted, false); assert.equal(r.reason, "paper");
  // Another user's live position on the same token closes first: it is not the called fill.
  r = await h.callouts.onOutcome({ instrument: "MintB", positionId: `pumpfun:MintB:${T0 + 7}`, pnl_pct: -12, held_ms: 40_000, reason: "CRASH", paper: false });
  assert.equal(r.posted, false); assert.equal(r.reason, "not the called fill");
  assert.equal(h.requests.length, before); assert.equal(results(), 0); assert.equal(h.callouts.feed()[0].result, null);
  // The called fill's own close is the result, and the ledger holds it before any channel hears of it.
  r = await h.callouts.onOutcome({ instrument: "MintB", positionId: `pumpfun:MintB:${T0}`, pnl_pct: 50, held_ms: 120_000, reason: "TARGET_1", paper: false });
  assert.equal(r.posted, true); assert.equal(r.id, call.id); assert.equal(h.callouts.feed()[0].result.pnl_pct, 50);
  const resultAt = h.log.findIndex(e => e.ledger?.phase === "result"), postAt = h.log.findIndex((e, i) => e.fetch && i > h.log.findIndex(x => x.ledger?.phase === "delivery"));
  assert.ok(resultAt >= 0 && resultAt < postAt, "result anchored before it is posted");
  // A second close on a resolved call changes nothing and posts nothing.
  const n = h.requests.length;
  r = await h.callouts.onOutcome({ instrument: "MintB", positionId: `pumpfun:MintB:${T0}`, pnl_pct: 5, held_ms: 1, reason: "TARGET_2", paper: false });
  assert.equal(r.posted, false); assert.equal(h.requests.length, n); assert.equal(h.callouts.feed()[0].result.pnl_pct, 50);
  // A release is a result too, so the call does not stay open forever.
  const c2 = await h.callouts.onFill(position("MintC"), { venue: "pumpfun", tx: "sigC", mcapUsd: 9_000, tier: 2, paper: false });
  r = await h.callouts.onOutcome({ instrument: "MintC", positionId: `pumpfun:MintC:${T0}`, pnl: null, reason: "RELEASED", paper: false });
  assert.equal(r.posted, true); assert.equal(r.id, c2.id); assert.equal(h.callouts.feed()[0].result.reason, "RELEASED");
  // No transaction, no call: the whole point is something anyone can look up.
  const none = await h.callouts.onFill(position("MintD"), { venue: "pumpfun", tx: null, mcapUsd: 9_000, tier: 2, paper: false });
  assert.equal(none.posted, false); assert.equal(none.reason, "no tx"); assert.equal(h.callouts.status().skipped.noTx, 1);
  assert.ok(!h.ledgerRecords.some(x => x.instrument === "MintD"));
  // A token named to page a channel cannot: Slack sees escaped brackets, Discord gets no mentions parsed.
  await h.callouts.onFill(position("MintE", { reference: { name: "<!channel> @everyone", ticker: "PING", mcapUsd: 9_000 } }), { venue: "pumpfun", tx: "sigE", mcapUsd: 9_000, tier: 2, paper: false });
  const hook = h.requests.filter(q => q.url === HOOK).at(-1).body;
  assert.doesNotMatch(hook.text, /<!channel>/); assert.match(hook.text, /&lt;!channel&gt;/); assert.deepEqual(hook.allowed_mentions, { parse: [] });
});
