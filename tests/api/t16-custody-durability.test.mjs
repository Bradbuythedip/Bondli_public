// T16: a custodial record must outlive every deploy, and must never be replaced by a fresh one.
//
// Redis is the ONLY durable store for user keys -- Railway wipes the filesystem on each deploy and
// the in-memory maps die with the process. An audit found every custodial record written with a
// 30-day expiry that no read refreshed, and /api/trading-wallet/create minting a new keypair when
// the old one could not be loaded. Together that is: user funds a wallet, comes back 31 days later,
// clicks the one button the UI offers, and their funded address becomes unreachable forever. No
// attacker required.
//
// These are source-level checks because the store lives inside an 11k-line server module with no
// seam to test through. If one fails, do not add an exemption: keys are not cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(path.resolve("src/api/server.production.mjs"), "utf8");
const LINES = SRC.split("\n");

// Records that ARE the product's memory of who owns what. Losing one loses a user's money.
const CUSTODIAL = ["tw:", "tkown:", "user:", "extra_wallets:"];

test("T16: no custodial record is written with an expiry", () => {
  const offenders = [];
  LINES.forEach((l, i) => {
    if (!/redis\.set\(/.test(l) || !/\bEX\b\s*:/.test(l)) return;
    const key = CUSTODIAL.find(k => l.includes(`"${k}"`));
    if (key) offenders.push(`  line ${i + 1}: ${key} written with an expiry\n    ${l.trim().slice(0, 120)}`);
  });
  assert.deepEqual(offenders, [], `custodial keys are permanent records, not cache:\n${offenders.join("\n")}`);
});

test("T16: custodial writes go through keepForever, so the rule is enforced in one place", () => {
  assert.match(SRC, /async function keepForever\(key, value\)/, "the helper exists");
  assert.doesNotMatch(SRC.slice(SRC.indexOf("async function keepForever")).slice(0, 300), /\bEX\b/,
    "and it never sets an expiry");
  for (const key of CUSTODIAL) {
    const writes = LINES.filter(l => l.includes(`redis.set("${key}`) || l.includes(`keepForever("${key}`));
    assert.ok(writes.length > 0, `${key} is written somewhere`);
    const raw = writes.filter(l => l.includes("redis.set("));
    assert.deepEqual(raw, [], `${key} must be written through keepForever, not redis.set directly:\n${raw.join("\n")}`);
  }
});

test("T16: reading a wallet clears an expiry an older build left on it", () => {
  // The records already in production carry a clock. Reading is the only moment we are certain the
  // record still exists, so it is the only chance to save it.
  assert.match(SRC, /async function stopTheClock\(key\)/);
  assert.match(SRC, /redis\.persist\(key\)/, "and it actually removes the expiry");
  const get = SRC.slice(SRC.indexOf("async function getTradingWallet"));
  const body = get.slice(0, get.indexOf("\n}\n") + 3);
  assert.match(body, /stopTheClock\("tw:" \+ userPubkey\)/, "getTradingWallet rescues the key it just read");
  assert.match(body, /stopTheClock\("tkown:"/, "and the reverse index that points at it");
});

test("T16: create refuses to mint a wallet over one the account already has", () => {
  const i = SRC.indexOf('app.post("/api/trading-wallet/create"');
  assert.ok(i > 0, "the route exists");
  const route = SRC.slice(i, SRC.indexOf("\n});", i));
  const generate = route.indexOf("Keypair.generate()");
  assert.ok(generate > 0, "it generates a keypair somewhere");
  const before = route.slice(0, generate);
  // Every one of these has to be true BEFORE a new key is minted.
  assert.match(before, /getTradingWallet\(wallet\)/, "the key is looked for first");
  assert.match(before, /prior\?\.tradingWallet/, "and the user record naming an existing wallet is checked");
  assert.match(before, /status\(409\)/, "which refuses rather than replacing");
  assert.match(before, /_redisError/, "and an unreachable store also refuses, rather than assuming 'none'");
  assert.match(before, /status\(503\)/);
});

test("T16: a balance reading is only cached when every leg of it succeeded", () => {
  // Robinhood Chain is a separate chain behind a separate RPC and fails separately. The ETH leg
  // used to be wrapped in a bare catch that left the figure null, and the reading was cached anyway
  // because rpcFailed only tracked Solana -- so one hiccup on the PONS node froze the ETH number
  // for fifteen seconds, and the "last known good" path could then serve that same reading forever.
  const i = SRC.indexOf('app.get("/api/trading-wallet/:wallet"');   // SRC is already the file's text
  assert.ok(i > 0, "the balance route exists");
  const route = SRC.slice(i, SRC.indexOf("\n});", i));
  assert.match(route, /let ethBalance = null, ethFailed = false/, "the ETH leg reports its own failure");
  assert.doesNotMatch(route, /getBalance\(tw\.evmAddress\)\)\)\.toFixed\(6\); \} catch \{\}/, "and is not swallowed");
  // Arc is a third leg on the same address behind its own RPC, and it fails on its own too.
  assert.match(route, /let usdcBalance = null, usdcFailed = false/, "the Arc leg reports its own failure");
  assert.match(route, /if \(!rpcFailed && !ethFailed && !usdcFailed\) setCachedBalance/, "a partial reading is never cached");
  // A failed leg keeps the last good number rather than reporting null as if it were a balance.
  assert.match(route, /prev && prev\.ethBalance != null \? prev\.ethBalance : null/);
  assert.match(route, /prev && prev\.usdcBalance != null \? prev\.usdcBalance : null/);
  // And every response the client cannot trust as live says so, naming each leg that is stale.
  assert.match(route, /const staleLegs = \[ethFailed && "eth", usdcFailed && "arc"\]\.filter\(Boolean\)/);
  for (const marker of [/stale: staleLegs\.length \? staleLegs : null/, /stale: \["sol", "eth"\]/, /stale: \["tokens"\]/])
    assert.match(route, marker, `stale responses are labelled: ${marker}`);
  assert.match(route, /as_of: Date\.now\(\)/, "and dated");
});
