// T15: no route may reach a user's custodial trading wallet without proving ownership.
//
// This is a STRUCTURAL test, not a behavioural one. The hosted service holds every user's trading
// key, so "which routes can touch a key" is a property of the source that has to be checked
// mechanically -- an audit found six routes that signed a transaction with the key named in the
// REQUEST BODY, with no credential of any kind, sitting beside the money routes that were correctly
// guarded. The frontend never called any of them; they were legacy surface nobody re-read.
//
// If this fails, do not add the route to an exemption list. Add requireOwner, or delete the route.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("src/api/server.production.mjs");
const ROUTE = /^\s*app\.(get|post|put|delete)\("([^"]+)"\s*,?\s*(\w+)?/;

/** Every route in the file, with the middleware named immediately after its path (if any). */
function routes(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = ROUTE.exec(l);
    if (m) out.push({ line: i, method: m[1].toUpperCase(), path: m[2], guard: m[3] === "async" ? null : m[3] || null });
  });
  return out;
}
const enclosing = (all, n) => [...all].reverse().find(r => r.line <= n) || null;

test("T15: every route that loads a trading wallet is behind requireOwner", () => {
  const lines = fs.readFileSync(SRC, "utf8").split("\n");
  const all = routes(lines);
  assert.ok(all.length > 50, `expected to find the route table, found ${all.length}`);

  const unguarded = new Map();
  lines.forEach((l, i) => {
    if (!l.includes("getTradingWallet(")) return;
    if (/(const|async function|function)\s+getTradingWallet/.test(l)) return; // the definition itself
    const r = enclosing(all, i);
    if (r && r.guard !== "requireOwner") unguarded.set(r.path, r);
  });

  assert.deepEqual([...unguarded.keys()], [],
    `these routes reach a user's custodial wallet with no ownership check:\n` +
    [...unguarded.values()].map(r => `  ${r.method} ${r.path}  (line ${r.line + 1}, guard: ${r.guard || "none"})`).join("\n"));
});

test("T15: nothing that signs with a custodial key is reachable without requireOwner", () => {
  const lines = fs.readFileSync(SRC, "utf8").split("\n");
  const all = routes(lines);
  // Rebuilding a Keypair from a stored secret is the moment a request becomes able to move money.
  const SIGNS = /Keypair\.fromSecretKey|new EvmWallet\(/;
  const unguarded = new Map();
  lines.forEach((l, i) => {
    if (!SIGNS.test(l)) return;
    const r = enclosing(all, i);
    if (r && r.guard !== "requireOwner") unguarded.set(r.path, { r, line: i + 1, code: l.trim().slice(0, 90) });
  });
  assert.deepEqual([...unguarded.keys()], [],
    `these routes build a signing key with no ownership check:\n` +
    [...unguarded.values()].map(u => `  ${u.r.method} ${u.r.path}  (line ${u.line})\n    ${u.code}`).join("\n"));
});

test("T15: requireOwner is still the guard these tests are checking for", async () => {
  // If the middleware is renamed or weakened, the greps above go quietly green. Pin the behaviour.
  const { makeRequireOwner, issueAuthToken } = await import("../../src/middleware/wallet-auth.mjs");
  const guard = makeRequireOwner({ adminSecret: null });
  const run = (over) => new Promise(resolve => {
    const req = { headers: {}, body: {}, query: {}, params: {}, ...over };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    guard(req, res, () => resolve({ status: null, passed: true }));
  });
  const victim = "V".repeat(44), attacker = "A".repeat(44);
  assert.equal((await run({ body: { wallet: victim } })).status, 401, "a bare body naming a victim is refused");
  assert.equal((await run({ params: { wallet: victim } })).status, 401, "and so is a path parameter");
  const asAttacker = { authorization: `Bearer ${issueAuthToken(attacker, "free")}` };
  assert.equal((await run({ headers: asAttacker, body: { wallet: victim } })).status, 403);
  assert.equal((await run({ headers: asAttacker, params: { wallet: victim } })).status, 403);
  assert.equal((await run({ headers: asAttacker, body: { wallet: attacker } })).passed, true);
  // The 401 tells the frontend to sign in and retry, which is why guarding a live route is safe.
  assert.equal((await run({ body: { wallet: victim } })).body.auth_required, true);
});
