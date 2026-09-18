// T30: the Arc surfaces the grant submission points at exist and say what the document says.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(path.resolve("src/api/server.production.mjs"), "utf8");

test("T30: the Arc chain layer is a standalone package, and the old path still serves it", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve("packages/arc-argus/package.json"), "utf8"));
  assert.equal(pkg.name, "@bondli/arc-argus"); assert.equal(pkg.peerDependencies.ethers, "^6");
  const a = await import("../../packages/arc-argus/index.mjs"), b = await import("../../src/velocity/venues/arc/chain.mjs");
  assert.equal(a.CHAIN_ID, 5042); assert.equal(b.CHAIN_ID, a.CHAIN_ID); assert.equal(typeof a.quoteBuy, "function"); assert.equal(b.TOPICS.TokenCreated, a.TOPICS.TokenCreated);
  const readme = fs.readFileSync(path.resolve("packages/arc-argus/README.md"), "utf8");
  assert.match(readme, /reference `contracts\/LaunchHook\.sol`/, "the README says what is not pinned to a published source");
  assert.doesNotMatch(readme, /guarantee|returns/i);
});

test("T30: Arc launches are aggregated in public with no wallet, and Arc swaps feed their own wallet ledger", () => {
  const route = SRC.indexOf('app.get("/api/arc/stats"');
  assert.ok(route > 0);
  const body = SRC.slice(route, SRC.indexOf("app.get(", route + 10));
  assert.doesNotMatch(body, /wallet:|devWallet|uniqueBuyers: \[|trades/);
  assert.match(body, /bondedRate/); assert.match(body, /taxTerms: hist/); assert.match(body, /wallets: undefined/, "the smart-money aggregate, never the list");
  assert.match(SRC, /const arcIntel = new WalletIntel\(\{[^\n]*storeKey: "wallet-intel:arc:v1"/);
  assert.match(SRC, /if \(!tr\.attributed \|\| !\(tr\.quote > 0\) \|\| !\(tr\.tokens > 0\)\) return;/, "only attributed swaps with a known USDC leg and tokens are booked");
  assert.match(SRC, /arcIntel\.onTrade\(\{ mint: t\.ca, wallet: tr\.wallet, isBuy: tr\.side === "buy", sol: tr\.quote, tokens: tr\.tokens/);
  assert.match(SRC, /smart: pons \? 0 : \(arc \? arcIntel : walletIntel\)\.smartBuyers/);
  const AX = fs.readFileSync(path.resolve("docs/AXIOMS.md"), "utf8");
  assert.match(AX, /## 11\. On Arc the quote asset is the dollar/);
  const GRANT = fs.readFileSync(path.resolve("docs/GRANT-ARC.md"), "utf8");
  // No promised return and no token in the submission. The placeholders are deliberately NOT asserted:
  // a test that fails when the amount is filled in holds the document in its draft state forever.
  assert.doesNotMatch(GRANT, /guaranteed return|BNDLI|\$JEFF/);
});
