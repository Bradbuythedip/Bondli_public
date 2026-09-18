// T25: the Arc feed and the public callouts are wired where they must be. The server file has no
// seam to render in isolation, so these pin the source: the feed is built beside the PONS one and
// handed to the hub, its tokens reach the radar with their own chain, and a fill reaches the
// callouts through the hub with the buy's own transaction on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SERVER = fs.readFileSync(path.resolve("src/api/server.production.mjs"), "utf8");
const HUB = fs.readFileSync(path.resolve("src/velocity/hub.mjs"), "utf8");
const ENGINE = fs.readFileSync(path.resolve("src/velocity/core/engine.mjs"), "utf8");
const SITE = fs.readFileSync(path.resolve("app/src/Simple.jsx"), "utf8");
const CLIENT = fs.readFileSync(path.resolve("app/src/lib/api-client.js"), "utf8");
const I18N = fs.readFileSync(path.resolve("app/src/lib/i18n.js"), "utf8");
const ENV = fs.readFileSync(path.resolve(".env.example"), "utf8");

test("T25: the Arc feed is built from ARC_RPC_URL, handed to the hub, started, and switchable off", () => {
  assert.match(SERVER, /const arcFeed = process\.env\.VELOCITY_ARC !== "0" \? new ArcFeed\(\{ rpcUrl: process\.env\.ARC_RPC_URL \|\| ARC_DEFAULT_RPC/);
  assert.match(SERVER, /feed: hubFeed, ponsFeed, arcFeed,/, "the hub receives the feed");
  // Started by the activity gate with the other feeds, not at boot: nothing polls unless someone is trading.
  assert.match(SERVER, /\["Arc \(Argus\)", arcFeed\]\]\.filter\(\(\[, f\]\) => f\)/);
  // Its trades join the same history the Solana and PONS trades feed, so revival and slow-cook can speak about Arc tokens.
  const ctor = SERVER.indexOf("new ArcFeed({");
  assert.match(SERVER.slice(ctor, ctor + 700), /onTrade: \(t, tr\) => \{\n\s+radar\._revivals\.noteTrade/);
  // The hub keeps it beside the PONS feed and reports it on the health route.
  assert.match(HUB, /this\.arcFeed = arcFeed;/);
  assert.match(HUB, /arc: hub\.arcFeed \? \{ \.\.\.pub\(hub\.arcFeed\.status\?\.\(\)\), tokens: hub\.arcFeed\.tokens\?\.size \?\? null/);
  // The key never lives in the example file.
  assert.match(ENV, /# ARC_RPC_URL=https:\/\/arc-mainnet\.g\.alchemy\.com\/v2\/<key>/);
  assert.doesNotMatch(ENV, /alchemy\.com\/v2\/[A-Za-z0-9_-]{20,}/);
});

test("T25: Arc launches sit in the radar's list with their own chain and link, and count in the hour", () => {
  assert.match(SERVER, /const arcTokens = velocityHub\?\.arcFeed \? \[\.\.\.velocityHub\.arcFeed\.tokens\.values\(\)\] : \[\];/);
  assert.match(SERVER, /const both = \[\.\.\.all, \.\.\.ponsTokens, \.\.\.arcTokens\];/);
  assert.match(SERVER, /chain: pons \? "robinhood" : arc \? "arc" : "solana"/);
  assert.match(SERVER, /t\._source === "arc" \? arcUrl\.replace\("\{ca\}", t\.ca\)/);
  // Arc tokens are judged the way PONS tokens are: by what their own feed last decided, not by the Solana filters.
  assert.match(SERVER, /const pons = t\._source === "pons", arc = t\._source === "arc";[\s\S]{0,400}if \(pons \|\| arc\) \{/);
  assert.match(SERVER, /robinhood: ponsHour, arc: arcHour/);
  // The site shows the chain on the row and the count in the hour strip.
  assert.match(SITE, /tok\.chain === "arc" \? "ARC" : "RH"/);
  // The strip's label is a dictionary key, so the Chinese page does not print the English word.
  assert.match(SITE, /d\.hour\.arc > 0 \? \[\["live\.arc", d\.hour\.arc, "dm"\]\] : \[\]/);
});

test("T25: a fill reaches the callouts through the hub with the buy tx on it; the record is public and hub-wide", () => {
  // The position carries its buy transaction, which is the whole proof a callout offers.
  assert.match(ENGINE, /venue_ref: fill\.venue_ref \|\| null,\n    \};/);
  // One Callouts per hub, on its own ledger, injectable for tests.
  assert.match(HUB, /this\.callouts = callouts \|\| new Callouts\(\{\n\s+ledger: new Ledger\(path\.join\(rootDir, "_hub", "callouts\.jsonl"\)/);
  // Opt-in per user: a call links the buy transaction, and the transaction names the trading wallet.
  assert.match(HUB, /const callouts = settings\.callouts === true;/);
  assert.match(HUB, /engine\.on\("position", p => \{ if \(!callouts\) return; this\.callouts\.onFill\(p, \{ venue: p\.venue, tx: p\.venue_ref \|\| null, mcapUsd: p\.reference\?\.mcapUsd, tier: p\.tier, plan: p\.plan, paper: !!p\.paper \}\)\.catch\(\(\) => \{\}\); \}\);/);
  // Every close reports by position, paper flagged, releases included, so another engine's close of the same token is never this call's result.
  assert.match(HUB, /engine\.on\("outcome", \(\{ position: p, pnl \}\) => \{ this\.callouts\.onOutcome\(\{ position: p, pnl, instrument: p\.instrument, positionId: p\.id, paper: !!p\.paper, reason: p\.exitReason \}\)\.catch\(\(\) => \{\}\); \}\);/);
  assert.match(HUB, /engine\.on\("released", \(\{ position: p \}\) => \{ this\.callouts\.onOutcome\(\{ position: p, pnl: null, instrument: p\.instrument, positionId: p\.id, paper: !!p\.paper, reason: "RELEASED" \}\)/);
  assert.match(SITE, /callouts: calls \}\);/, "the site sends the choice");
  // The toggle's words live in the dictionary under panel.*; the site reads them by key.
  assert.match(SITE, /\{t\("panel\.publicCalls"\)\}\{calls \? t\("panel\.on"\) : ""\}/);
  assert.match(I18N, /"panel\.publicCalls": "Public calls"/);
  assert.match(I18N, /"panel\.on": " · on"/);
  assert.match(SITE, /\{t\("panel\.publicCallsDesc"\)\}/);
  assert.match(I18N, /"panel\.publicCallsDesc": "[^"]*The transaction shows this bot's wallet/);
  // Channels come from the environment; none set still leaves the record on the site.
  assert.match(HUB, /webhookUrl: process\.env\.CALLOUT_WEBHOOK_URL \|\| null/);
  assert.match(HUB, /telegram: process\.env\.CALLOUT_TG_TOKEN && process\.env\.CALLOUT_TG_CHAT_ID \? \{ token: process\.env\.CALLOUT_TG_TOKEN, chatId: process\.env\.CALLOUT_TG_CHAT_ID \} : null/);
  // The public route is unauthenticated and answers from feed()/record() only: never status()'s lastError or a user.
  const route = HUB.indexOf('app.get("/api/callouts"');
  assert.ok(route > 0);
  const body = HUB.slice(route, HUB.indexOf("app.get(", route + 10));
  assert.doesNotMatch(body, /requireOwner/);
  assert.match(body, /calls: hub\.callouts\.feed\(limit\), record: hub\.callouts\.record\(\)/);
  assert.doesNotMatch(body, /lastError|wallet/);
  // The site has a Calls tab that reads it, and the client knows the route.
  assert.match(SITE, /\["calls", "watch\.calls"\]/);
  assert.match(I18N, /"watch\.calls": "Calls"/);
  assert.match(SITE, /tab === "calls" \? <Calls T=\{T\} \/>/);
  assert.match(SITE, /function Calls\(\{ T \}\)/);
  assert.match(CLIENT, /calls\(\) \{ return this\.f\("\/api\/callouts", \{ noauth: true/);
  assert.match(ENV, /# CALLOUT_WEBHOOK_URL=\n# CALLOUT_TG_TOKEN=\n# CALLOUT_TG_CHAT_ID=\n# CALLOUT_MIN_TIER=2/);
});

test("T25: the Arc venue is built in hub.start the way PONS is, on the same EVM key, and every wallet path knows it", () => {
  assert.match(HUB, /const arc = !!settings\.arc && !!this\.arcFeed && !!evmSecret;/);
  assert.match(HUB, /if \(arc\) venues\.arc = \{ mode: "paper", feed: new SharedFeedView\(this\.arcFeed, \{ clock: this\.clock \}\), edge: makePumpfunEdge\(\{ venue: "arc", aggression \}\), router: new ArcPaperRouter\(/);
  assert.match(HUB, /const wanted = \[pumpfun && "pumpfun", pons && "pons", arc && "arc"\]\.filter\(Boolean\);/);
  assert.match(HUB, /!\["pons", "pumpfun", "arc"\]\.includes\(venue\)/, "the sell route accepts arc");
  assert.match(HUB, /for \(const venue of \["pumpfun", "pons", "arc"\]\)/, "the sweep closes arc positions through the engine");
  // The live router refuses an RPC that answers for another chain before it reads a balance.
  const ROUTER = fs.readFileSync(path.resolve("src/velocity/venues/arc/router.mjs"), "utf8");
  const pre = ROUTER.indexOf("async preflight()");
  const body = ROUTER.slice(pre, pre + 900);
  assert.ok(body.indexOf('this.provider.send("eth_chainId", [])') < body.indexOf("getBalance"), "chain id is checked before the balance is read");
  assert.match(body, /Number\(chainHex\) !== CHAIN_ID\) throw/);
  // The site lists Arc holdings and lets a bonded token be sold (the pool keeps trading after the bond).
  assert.match(SITE, /\[\.\.\.hold\.sol, \.\.\.hold\.eth, \.\.\.\(hold\.usdc \|\| \[\]\)\]\.map/);
  assert.match(SITE, /h\.state === "bonded" \|\| h\.state === "unknown" && \(h\.venue === "pumpfun" \|\| h\.venue === "arc"\)/);
});

test("T25: the public health route never carries a feed's error text, because an RPC error can quote the key", () => {
  const route = HUB.indexOf('app.get("/api/velocity/health"');
  assert.ok(route > 0);
  const before = HUB.slice(route - 1400, route);
  assert.match(before, /const pub = s => \{ const \{ lastError, lastHydrateError, \.\.\.rest \} = s \|\| \{\}; return rest; \};/);
  const body = HUB.slice(route, route + 700);
  assert.match(body, /feed: pub\(hub\.feed\.status\?\.\(\)\)/);
  assert.match(body, /\.\.\.pub\(hub\.ponsFeed\.status\?\.\(\)\)/);
  assert.match(body, /\.\.\.pub\(hub\.arcFeed\.status\?\.\(\)\)/);
});

test("T25: the engine's fail cooldown and terminal codes know the Arc router's answers", async () => {
  const { TERMINAL_EXIT_CODES } = await import("../../src/velocity/core/engine.mjs");
  assert.ok(TERMINAL_EXIT_CODES.has("UNSUPPORTED"), "a sell the venue cannot make is released, not retried five times");
  const ENGINE = fs.readFileSync(path.resolve("src/velocity/venues/arc/router.mjs"), "utf8");
  assert.match(ENGINE, /failure\(order, "INSUFFICIENT_SOL", `wallet has \$\{bal\.toFixed\(4\)\} USDC/, "the engine's name for an underfunded quote wallet, so the cooldown applies");
  assert.doesNotMatch(ENGINE, /INSUFFICIENT_USDC/);
  const CORE = fs.readFileSync(path.resolve("src/velocity/core/engine.mjs"), "utf8");
  assert.match(CORE, /\["SEND_FAILED", "UNCONFIRMED", "INSUFFICIENT_SOL", "ROUTER_THREW", "STALE_SOL_PRICE", "REVERT"\]\.includes\(r\.failure\.code\)/);
});
