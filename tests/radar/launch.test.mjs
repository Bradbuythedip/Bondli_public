// The launch banner state: a push changes only what it names, updates stack newest first, bad input throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeLaunch, defaultLaunch, LaunchStore } from "../../src/api/launch.mjs";

test("launch: a pushed address goes live on its own, ticker and links merge, updates cap newest first", () => {
  let s = defaultLaunch();
  assert.equal(s.status, "soon");
  // An EVM address is only valid on the EVM chain; the default is Solana now, so say which.
  s = mergeLaunch(s, { chain: "robinhood", address: "0x" + "ab".repeat(20), ticker: "FLY", links: { x: "https://x.com/bondli" } }, 1000);
  assert.equal(s.status, "live"); assert.equal(s.address, "0x" + "ab".repeat(20)); assert.equal(s.ticker, "FLY"); assert.equal(s.links.x, "https://x.com/bondli");
  s = mergeLaunch(s, { update: "one" }, 2000); s = mergeLaunch(s, { update: "two" }, 3000);
  assert.deepEqual(s.updates.map(u => u.text), ["two", "one"]); assert.equal(s.name, "Bondli");
  for (let i = 0; i < 30; i++) s = mergeLaunch(s, { update: "u" + i }, 4000 + i);
  assert.equal(s.updates.length, 20); assert.equal(s.updates[0].text, "u29");
  s = mergeLaunch(s, { links: { x: "" }, status: "graduated" }, 9000);
  assert.equal(s.links.x, undefined); assert.equal(s.status, "graduated");
  assert.throws(() => mergeLaunch(s, { status: "moon" }), /status/); assert.throws(() => mergeLaunch(s, { address: "nope" }), /address/);
  assert.equal(mergeLaunch(s, { reset: true }, 9999).address, "");
  const v = mergeLaunch(defaultLaunch(), { chain: "robinhood", venue: "pons", pair: "0x" + "ef".repeat(20) }, 1);
  assert.equal(v.venue, "pons"); assert.equal(v.pair, "0x" + "ef".repeat(20)); assert.equal(defaultLaunch().venue, "pump.fun");
  assert.throws(() => mergeLaunch(v, { venue: "raydium" }), /venue/);
});

test("launch: the store persists to disk and reads back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-")); const file = path.join(dir, "sub", "launch.json");
  const a = new LaunchStore(file); a.push({ chain: "robinhood", address: "0x" + "cd".repeat(20), update: "born" }, 5);
  const b = new LaunchStore(file); assert.equal(b.state.address, "0x" + "cd".repeat(20)); assert.equal(b.state.updates[0].text, "born"); assert.equal(b.state.status, "live");
});
