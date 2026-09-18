// T24: the wallet ledger is fed from the one place the full buyer pubkey exists, and its answer
// reaches the edge. The server file has no seam to render in isolation, so these assertions are on
// the source; what they pin is that the hooks sit where the stream delivers what they need.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHTS, FEATURE_SIGNS, WEIGHT_CONSTRAINTS, SACRED_INVERSIONS } from "../../src/velocity/core/learner.mjs";
import { pumpfunFeatures } from "../../src/velocity/venues/pumpfun/edge.mjs";

const SRC = fs.readFileSync(path.resolve("src/api/server.production.mjs"), "utf8");

test("T24: creates, trades and graduations feed the wallet ledger with full pubkeys", () => {
  const create = SRC.indexOf("walletIntel.onCreate({ mint, creator: trader || null");
  const trade = SRC.indexOf("walletIntel.onTrade({ mint, wallet: trader, isBuy: data.txType === \"buy\"");
  const grad = SRC.indexOf("walletIntel.onGraduated(mint, now)");
  assert.ok(create > 0 && trade > 0 && grad > 0);
  // The trade hook must use the FULL address, never the 8-character prefix token.trades keeps.
  assert.doesNotMatch(SRC.slice(trade, trade + 200), /trader\.slice\(0, 8\)/);
  // Sells are fed too: a sell is what closes a position and makes a wallet's record measurable.
  assert.match(SRC.slice(trade - 400, trade), /data\.txType === "buy" \|\| data\.txType === "sell"/);
  // Persistence is Redis (the filesystem does not survive a redeploy), and a missing Redis is null, not a crash.
  assert.match(SRC, /new WalletIntel\(\{ store: redis \? \{ get: \(k\) => redis\.get\(k\), set: \(k, v\) => redis\.set\(k, v\) \} : null/);
});

test("T24: the measured signal reaches the features, the edge and the learner, and the wallet list is not public", () => {
  assert.match(SRC, /_smartMoney: \(\(\) => \{ const sm = walletIntel\.smartBuyers\(t\.ca \|\| ca, \{ sinceTs: t\.createdAt \|\| null, windowMs: 60_000 \}\)/);
  const f = pumpfunFeatures({ scores: { apeScore: 50 }, token: {}, qf: { _smartMoney: { count: 2, score: 0.8 } } });
  assert.equal(f.smartMoney, 0.8);
  assert.equal(pumpfunFeatures({ scores: { apeScore: 50 }, token: {}, qf: {} }).smartMoney, null, "absent is missing, never zero");
  assert.equal(DEFAULT_WEIGHTS.pumpfun.smartMoney, 0.10);
  assert.ok(Math.abs(Object.values(DEFAULT_WEIGHTS.pumpfun).reduce((a, b) => a + b, 0) - 1) < 1e-9, "the weights still sum to one");
  assert.equal(FEATURE_SIGNS.pumpfun.smartMoney, 1);
  assert.ok(WEIGHT_CONSTRAINTS.pumpfun.smartMoney.max <= 0.30);
  // Not sacred, on purpose: labelled smart wallets get baited (buy, be copied, sell into the copiers),
  // so the data may honestly show the signal counting the other way, and the learner must be free
  // to say so. The constraint floor keeps it from being dropped; the sign follows the evidence.
  assert.equal(SACRED_INVERSIONS.pumpfun.smartMoney, undefined);
  assert.ok(WEIGHT_CONSTRAINTS.pumpfun.smartMoney.min >= 0.03, "never dropped, only re-weighted");
  // The list of wallets is the operator's; the aggregate is public.
  assert.match(SRC, /app\.get\("\/api\/smart-money\/top", requireAdmin,/);
  assert.match(SRC, /app\.get\("\/api\/smart-money\/status", \(req, res\)/);
});

test("T24: the trade hook books the trade's own SOL, never the curve delta; the admin gate has no default and reads only the header", () => {
  const trade = SRC.indexOf("walletIntel.onTrade({ mint, wallet: trader, isBuy: data.txType === \"buy\"");
  assert.ok(trade > 0);
  assert.match(SRC.slice(trade, trade + 260), /sol: Number\(data\.solAmount\) > 0 \? Number\(data\.solAmount\) : sol,/);
  assert.match(SRC, /const ADMIN_SECRET = process\.env\.ADMIN_SECRET \|\| null;/);
  assert.doesNotMatch(SRC, /bondli_default/);
  const gate = SRC.indexOf("function requireAdmin(req, res, next)");
  const body = SRC.slice(gate, gate + 400);
  assert.match(body, /const secret = req\.headers\["x-admin-secret"\];/);
  assert.doesNotMatch(body, /req\.query/);
  assert.match(body, /if \(!ADMIN_SECRET \|\| !secret \|\| secret !== ADMIN_SECRET\) return res\.status\(403\)/);
});
