// T19: the launch banner is $BNDLI on Solana, and a volume still holding an earlier token that never
// launched comes up as $BNDLI too. The banner's content lives in one JSON file on the Railway volume,
// and the defaults only apply when that file is missing -- so renaming the defaults alone changed
// nothing on the live site, which is exactly what happened the first time. Every persisted record
// under an old name has to be recognised and replaced; a record with a real address never is.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultLaunch, mergeLaunch, isLegacyLaunch, LaunchStore, JEFF_POST_URL } from "../../src/api/launch.mjs";

const SRC = fs.readFileSync(path.resolve("app/src/Simple.jsx"), "utf8");
const I18N = fs.readFileSync(path.resolve("app/src/lib/i18n.js"), "utf8");
const SOL = "BNDLpump" + "1".repeat(36);

test("T19: the default banner is $BNDLI on Solana, on pump.fun, with no one else's post attached", () => {
  const d = defaultLaunch();
  assert.equal(d.name, "Bondli"); assert.equal(d.ticker, "BNDLI"); assert.equal(d.chain, "solana"); assert.equal(d.venue, "pump.fun");
  assert.equal(d.tagline, "Bondli's own token. Hold it, trade free.");
  assert.deepEqual(d.links, {}, "the token is its own story: a post is linked only when the operator pushes one");
  // The old post link is still exported for the legacy check, and is not what the defaults point at.
  assert.match(JEFF_POST_URL, /^https:\/\/x\.com\/elonmusk\/status\/1935370021439705302$/);
  assert.notEqual(d.links.post, JEFF_POST_URL);
  assert.equal(d.image, "", "no picture is shown until one is pushed: a wrong one is worse than none");
});

test("T19: a stored fruit-fly record is replaced, a launched token on any chain is kept", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-"));
  const file = path.join(dir, "launch.json");
  // What the Railway volume actually holds today.
  fs.writeFileSync(file, JSON.stringify({ name: "Not a fruit fly", ticker: "", chain: "robinhood", venue: "uniswap-v2", address: "", status: "soon", tagline: "Bondli's own token. Launching on Robinhood Chain.", image: "/fly.png", links: {}, updates: [], updatedAt: 1 }));
  const st = new LaunchStore(file).state;
  assert.equal(st.name, "Bondli"); assert.equal(st.chain, "solana"); assert.equal(st.image, "");
  // A token that actually launched is never rewritten, even on the old chain.
  const evm = "0x" + "ab".repeat(20);
  fs.writeFileSync(file, JSON.stringify({ name: "Not a fruit fly", ticker: "NOTAFLY", chain: "robinhood", venue: "pons", address: evm, status: "live" }));
  assert.equal(new LaunchStore(file).state.address, evm, "a live address is not something to migrate away from");
  assert.equal(isLegacyLaunch({ name: "Bondli", chain: "solana" }), false);
  // Links pushed later survive a reboot; the defaults add none of their own.
  fs.writeFileSync(file, JSON.stringify({ name: "Bondli", chain: "solana", links: { launchpad: "https://pump.fun/coin/x" } }));
  const merged = new LaunchStore(file).state;
  assert.equal(merged.links.post, undefined); assert.equal(merged.links.launchpad, "https://pump.fun/coin/x");
});

test("T19: a stored, never-launched $JEFF banner migrates to $BNDLI; a launched $JEFF with an address does not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-"));
  const file = path.join(dir, "launch.json");
  // What the Railway volume holds after the previous rename: the placeholder, complete with the old post link.
  const jeff = { name: "Jeff", ticker: "JEFF", chain: "solana", venue: "pump.fun", address: "", curve: "", pair: "", status: "soon", tagline: "Bondli's own token. Launching on pump.fun.", image: "", links: { post: JEFF_POST_URL }, updates: [], updatedAt: 1 };
  fs.writeFileSync(file, JSON.stringify(jeff));
  const st = new LaunchStore(file).state;
  assert.equal(st.name, "Bondli"); assert.equal(st.ticker, "BNDLI"); assert.equal(st.chain, "solana");
  assert.equal(st.links.post, undefined, "the old post link goes with the old name");
  assert.equal(isLegacyLaunch({ name: "Jeff", chain: "solana" }), true);
  assert.equal(isLegacyLaunch({ name: "JEFF", ticker: "JEFF" }), true, "case does not matter");
  assert.equal(isLegacyLaunch({ name: "Something", ticker: "jeff" }), true, "the ticker alone names it");
  // A $JEFF that was actually minted is someone's token now: it keeps its name, ticker, address and links.
  fs.writeFileSync(file, JSON.stringify({ ...jeff, address: SOL, status: "live" }));
  const live = new LaunchStore(file).state;
  assert.equal(live.name, "Jeff"); assert.equal(live.ticker, "JEFF"); assert.equal(live.address, SOL); assert.equal(live.links.post, JEFF_POST_URL);
  assert.equal(isLegacyLaunch({ name: "Jeff", chain: "solana", address: SOL }), false, "a token that exists is never renamed under people");
  // And the migration is a one-time event: once the store is $BNDLI it is not touched again.
  assert.equal(isLegacyLaunch(st), false);
});

test("T19: a Solana address is checked as base58 and kept case-sensitive; an EVM one still lowercases", () => {
  const d = defaultLaunch();
  assert.throws(() => mergeLaunch(d, { address: "0x" + "ab".repeat(20) }), /base58 Solana address/);
  const s = mergeLaunch(d, { address: SOL });
  assert.equal(s.address, SOL, "base58 is case-sensitive: never lowercased");
  assert.equal(s.status, "live", "an address pushed without a status goes live by itself, as before");
  const r = mergeLaunch(d, { chain: "robinhood", address: "0x" + "AB".repeat(20) });
  assert.equal(r.address, "0x" + "ab".repeat(20));
  assert.throws(() => mergeLaunch(d, { chain: "base" }), /chain must be one of/);
});

test("T19: nothing about the token is hard-coded in the banner", () => {
  const banner = SRC.slice(SRC.indexOf("function Launch("), SRC.indexOf("function Launch(") + 6000);
  // The other chain's NAME may appear (the badge still has to say where a Robinhood token is); the old
  // token's name and picture may not.
  assert.doesNotMatch(banner, /FRUIT FLY|fruit fly|fly\.png|NOT A</);
  assert.match(banner, /String\(l\.name \|\| ""\)\.toUpperCase\(\)/, "the name comes from the server");
  assert.match(banner, /\{l\.image && <img src=\{l\.image\}/, "no image means no image, not a stale one");
  assert.match(banner, /l\.links\?\.post/, "the post is linked when the server names one");
  // The badge's words come from the dictionary; the chain's name is still filled in from the server's record.
  assert.match(banner, /t\("launch\.soon", \{ chain: chainName \}\)/);
  assert.match(I18N, /"launch\.soon": "SOON ON \{chain\}"/);
  assert.doesNotMatch(SRC, /FREN|NOTAFLY/);
});
