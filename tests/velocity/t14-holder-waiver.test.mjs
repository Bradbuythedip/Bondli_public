// The house-token fee waiver: hold one $BNDLI and the performance fee is zero. What must hold is that
// it is inert until the token exists, that it never charges someone because a node blinked, and that
// it never invents a waiver out of a failure. $BNDLI is an SPL mint on Solana, read against the user's
// own Solana wallet -- so the addresses here are base58 pubkeys, not the EVM ones this used to use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HolderWaiver } from "../../src/velocity/core/holder-waiver.mjs";

// Base58 has no 0, O, I or l; these are shaped like real pubkeys so the address check passes.
const ADDR = (n) => ("Bndi" + String(n).repeat(44)).replace(/0/g, "9").slice(0, 44);
const TOKEN = "BNDLpump" + "1".repeat(36);

function waiver({ balance = 0, clock, minTokens = 1 } = {}) {
  let t = 0;
  const w = new HolderWaiver({ token: TOKEN, minTokens, connection: {}, clock: clock || (() => t), symbol: "BNDLI" });
  w._balance = balance;
  w.balanceOf = async () => { if (w._throw) throw new Error("rpc down"); return w._balance; };
  w._advance = (ms) => { t += ms; };
  return w;
}

test("T14: with no token configured nothing is read and nothing is waived", async () => {
  const off = new HolderWaiver({});
  assert.equal(off.enabled, false);
  assert.equal(await off.holds(ADDR(1)), false);
  assert.equal(off.status().enabled, false);
  // a token that is not an address is a misconfiguration, not a waiver for everyone
  const bad = new HolderWaiver({ token: "BNDLI" });
  assert.equal(bad.enabled, false);
  assert.equal(bad.status().misconfigured, true);
  assert.equal(await bad.holds(ADDR(1)), false);
});

test("T14: one token is enough, none is not, and the threshold is configurable", async () => {
  const w = waiver({ balance: 0 });
  assert.equal(await w.holds(ADDR(2)), false);
  w._balance = 1; w.forget(ADDR(2));
  assert.equal(await w.holds(ADDR(2)), true);
  w._balance = 0.4; w.forget(ADDR(2));
  assert.equal(await w.holds(ADDR(2)), false, "a fraction of a token is not holding one");
  const big = waiver({ balance: 5000, minTokens: 10_000 });
  assert.equal(await big.holds(ADDR(3)), false);
  big._balance = 10_000; big.forget(ADDR(3));
  assert.equal(await big.holds(ADDR(3)), true);
});

test("T14: the answer is cached, so a close does not cost an RPC call each time", async () => {
  const w = waiver({ balance: 3 });
  assert.equal(await w.holds(ADDR(4)), true);
  const reads = w.reads;
  for (let i = 0; i < 20; i++) await w.holds(ADDR(4));
  assert.equal(w.reads, reads, "twenty more closes, no further reads");
  w._balance = 0;
  assert.equal(await w.holds(ADDR(4)), true, "still cached");
  w._advance(6 * 60_000);
  assert.equal(await w.holds(ADDR(4)), false, "after the TTL it reads again and sees they sold");
});

test("T14: an unreadable balance keeps the last good answer and never invents one", async () => {
  const w = waiver({ balance: 7 });
  assert.equal(await w.holds(ADDR(5)), true);
  w._throw = true; w._advance(6 * 60_000);
  assert.equal(await w.holds(ADDR(5)), true, "a node blink does not start charging a holder");
  assert.equal(await w.holds(ADDR(6)), false, "a wallet never read successfully is charged, not waived");
  assert.ok(w.status().errors >= 1);
  assert.equal(w.status().lastError, "rpc down");
  // once the node is back the truth wins again
  w._throw = false; w._balance = 0; w._advance(6 * 60_000);
  assert.equal(await w.holds(ADDR(5)), false);
});

test("T14: a garbage address is never waived and never read", async () => {
  const w = waiver({ balance: 99 });
  const reads = w.reads;
  // An EVM address is garbage HERE: the waiver moved to Solana, and 0x... must never be read as one.
  for (const bad of [null, undefined, "", "0x" + "ab".repeat(20), "not-an-address!", ADDR(1).slice(0, 20)]) assert.equal(await w.holds(bad), false);
  assert.equal(w.reads, reads);
});

// The fee is binary: one rate, or nothing because you hold the token (or are the owner, or did not
// profit). The old free/pro/vip ladder must not be able to decide anything here.
test("T14: one flat rate, no tiers, whatever the fee engine would have said", async () => {
  const { VelocityHub, DEFAULT_FEE_PCT } = await import("../../src/velocity/hub.mjs");
  let tierAsked = 0;
  const feeStub = {
    isOwnerWallet: (w) => w === "OWNER",
    recordTradeOutcome: () => {}, recordGlobalFee: () => {},
    // If anything still reaches for a tier, this notices.
    resolveTier: () => { tierAsked++; return { tier: "vip" }; },
    calculateFee: () => { tierAsked++; return { fee: 999, net: 999 }; },
    getUser: async () => { tierAsked++; return {}; },
  };
  const hub = (feePct) => new VelocityHub({ feed: { solPrice: 200 }, rootDir: "/tmp/velocity-test", platformWallet: "P", fee: feeStub, feePct, log: { log() {}, warn() {}, error() {} } });

  assert.equal(DEFAULT_FEE_PCT, 5);
  // An unset or nonsense rate falls back to the standard rate, never to the ladder.
  for (const v of [null, undefined, "", "abc", NaN]) assert.equal(hub(v).feePct, DEFAULT_FEE_PCT, `feePct ${String(v)}`);
  assert.equal(hub(0).feePct, 0, "an explicit zero is honoured");
  assert.equal(hub(3).feePct, 3);

  const h = hub(5);
  assert.equal(h.flatFee(1, 2, "USER").fee, 0.05, "5% of one SOL of profit");
  assert.equal(h.flatFee(1, 2, "OWNER").fee, 0, "the owner pays nothing");
  assert.equal(h.flatFee(2, 1, "USER").fee, 0, "a loss costs nothing");
  assert.equal(h.flatFee(1, 1.0005, "USER").fee, 0, "dust costs nothing");
  assert.equal(tierAsked, 0, "nothing on the fee path asked for a tier");
});
