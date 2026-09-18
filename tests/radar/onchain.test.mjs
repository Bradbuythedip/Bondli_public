// On-chain pump.fun trade decoding, offline, against a real TradeEvent sample.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTradeEvent, pumpTradesFromLogs, toPortalTrade, PUMP_PROGRAM, TRADE_DISC_B64, decodeCreateEvent, pumpEventsFromLogs, toPortalCreate, CREATE_DISC_B64 } from "../../src/api/radar-onchain.mjs";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

const SAMPLE = "vdt/007mYe4I2s9bQJeDK7Vsc0abb1HZtkn00oEApJL31hHDmDkdn4elBH4AAAAANMdMxxcLAAABQFvoWh4tpYvdaQpW4wxu9sWX0f+5ye2VIR53vUXOYLdYSHFnAAAAAJ7V3KMRAAAArWn3u2uCAQCeKbmnCgAAAK3R5G/agwAA";

test("decodes a real TradeEvent with fixed offsets", () => {
  const t = decodeTradeEvent(Buffer.from(SAMPLE, "base64"));
  assert.equal(t.mint, "bZn91ZcKVcSZRwVmmKGiQ6yZJd71fyAw3y4TMekpump");
  assert.equal(t.solAmount, 2.114233735);
  assert.ok(Math.abs(t.tokenAmount - 12196755.85106) < 0.01);
  assert.equal(t.isBuy, true);
  assert.equal(t.user, "5LENpdG1eX9jhcxZ1J2X9qst2LVN7nFDMZ9FWdAZwUQe");
  assert.equal(t.timestamp, 1735477336);
  assert.equal(t.vSol, 75763602846);
  assert.equal(t.vTok, 424874203376045);
  assert.equal(decodeTradeEvent(Buffer.from(SAMPLE, "base64").subarray(0, 100)), null);
});

test("maps to PumpPortal's wire shape", () => {
  const p = toPortalTrade(decodeTradeEvent(Buffer.from(SAMPLE, "base64")), "sig1", 123);
  assert.equal(p.txType, "buy");
  assert.equal(p.mint, "bZn91ZcKVcSZRwVmmKGiQ6yZJd71fyAw3y4TMekpump");
  assert.equal(p.traderPublicKey, "5LENpdG1eX9jhcxZ1J2X9qst2LVN7nFDMZ9FWdAZwUQe");
  assert.equal(p.vSolInBondingCurve, 75.763602846);
  assert.ok(Math.abs(p.marketCapSol - 178.32) < 0.05);
  assert.equal(p.source, "onchain");
  assert.equal(p.signature, "sig1");
});

test("only decodes events emitted while pump.fun is executing", () => {
  const dataLine = "Program data: " + SAMPLE;
  const nested = [
    "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
    `Program ${PUMP_PROGRAM} invoke [2]`,
    "Program log: Instruction: Buy",
    dataLine,
    `Program ${PUMP_PROGRAM} success`,
    "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success",
  ];
  assert.equal(pumpTradesFromLogs(nested).length, 1);
  const collision = [
    "Program MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG invoke [1]",
    dataLine,
    "Program MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG success",
  ];
  assert.equal(pumpTradesFromLogs(collision).length, 0);
  assert.equal(pumpTradesFromLogs([`Program ${PUMP_PROGRAM} invoke [1]`, "Program data: " + TRADE_DISC_B64 + "AAAA", `Program ${PUMP_PROGRAM} success`]).length, 0, "garbage payload is skipped");
  assert.equal(pumpTradesFromLogs(null).length, 0);
});

// A CreateEvent is the launch itself, with the metadata uri in it. Decoding it is what lets the
// radar see a launch -- and fetch its picture -- at second zero, without PumpPortal's websocket.
// No live sample is checked in (the RPC is not reachable offline), so the event is built here from
// the documented Anchor/Borsh layout: 8-byte discriminator, three length-prefixed strings, then
// mint / bonding curve / creator pubkeys, then the fields pump.fun appended later.
const KEY = (n) => new PublicKey(Buffer.alloc(32, n));
function borshStr(s) { const b = Buffer.from(s, "utf8"); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); return Buffer.concat([len, b]); }
function createEventBytes({ name, symbol, uri, mint, curve, user, trailing = true }) {
  const disc = createHash("sha256").update("event:CreateEvent").digest().subarray(0, 8);
  const parts = [disc, borshStr(name), borshStr(symbol), borshStr(uri), mint.toBuffer(), curve.toBuffer(), user.toBuffer()];
  if (trailing) {
    const creator = KEY(9).toBuffer(); const ts = Buffer.alloc(8); ts.writeBigInt64LE(1758000000n);
    const vTok = Buffer.alloc(8); vTok.writeBigUInt64LE(1073000000000000n); const vSol = Buffer.alloc(8); vSol.writeBigUInt64LE(30000000000n);
    parts.push(creator, ts, vTok, vSol);
  }
  return Buffer.concat(parts);
}

test("the CreateEvent discriminator prefix is the sha256 of the Anchor event name", () => {
  const disc = createHash("sha256").update("event:CreateEvent").digest().subarray(0, 8);
  assert.equal(disc.toString("hex"), "1b72a94ddeeb6376");
  assert.ok(disc.toString("base64").startsWith(CREATE_DISC_B64), `${disc.toString("base64")} starts with ${CREATE_DISC_B64}`);
  assert.equal(CREATE_DISC_B64.length, 10, "ten characters: the eleventh depends on the byte after the discriminator");
});

test("decodes a CreateEvent: name, symbol, uri and the keys, with and without the appended fields", () => {
  const mint = KEY(1), curve = KEY(2), user = KEY(3);
  const full = decodeCreateEvent(createEventBytes({ name: "Frog", symbol: "FROG", uri: "https://ipfs.io/ipfs/bafkreiabc", mint, curve, user }));
  assert.equal(full.name, "Frog"); assert.equal(full.symbol, "FROG"); assert.equal(full.uri, "https://ipfs.io/ipfs/bafkreiabc");
  assert.equal(full.mint, mint.toBase58()); assert.equal(full.bondingCurve, curve.toBase58()); assert.equal(full.user, user.toBase58());
  assert.equal(full.creator, KEY(9).toBase58()); assert.equal(full.timestamp, 1758000000); assert.equal(full.vSol, 30000000000); assert.equal(full.vTok, 1073000000000000);
  // The layout pump.fun shipped first, before creator/timestamp/reserves were appended.
  const old = decodeCreateEvent(createEventBytes({ name: "Old", symbol: "OLD", uri: "ipfs://Qm1", mint, curve, user, trailing: false }));
  assert.equal(old.uri, "ipfs://Qm1"); assert.equal(old.creator, null); assert.equal(old.vSol, null);
  // Garbage is null, never a throw: a truncated string length must not read past the buffer.
  assert.equal(decodeCreateEvent(createEventBytes({ name: "x", symbol: "y", uri: "z", mint, curve, user }).subarray(0, 40)), null);
  const bad = createEventBytes({ name: "x", symbol: "y", uri: "z", mint, curve, user }); bad.writeUInt32LE(0xffffffff, 8);
  assert.equal(decodeCreateEvent(bad), null);
});

test("one walk of the logs yields creates and trades, only while pump.fun is executing", () => {
  const mint = KEY(4), curve = KEY(5), user = KEY(6);
  const createLine = "Program data: " + createEventBytes({ name: "N", symbol: "S", uri: "u", mint, curve, user }).toString("base64");
  const logs = [
    `Program ${PUMP_PROGRAM} invoke [1]`, createLine, "Program data: " + SAMPLE, `Program ${PUMP_PROGRAM} success`,
    "Program SomeOtherProgram1111111111111111111111111 invoke [1]", createLine, "Program SomeOtherProgram1111111111111111111111111 success",
  ];
  const ev = pumpEventsFromLogs(logs);
  assert.equal(ev.creates.length, 1, "the create under a foreign program is not ours");
  assert.equal(ev.trades.length, 1);
  assert.equal(ev.creates[0].mint, mint.toBase58());
  assert.deepEqual(pumpTradesFromLogs(logs).map(t => t.mint), ev.trades.map(t => t.mint), "the old entry point still returns the trades");
});

test("a create maps to PumpPortal's create shape so the radar's create branch needs no change", () => {
  const mint = KEY(7), curve = KEY(8), user = KEY(3);
  const c = decodeCreateEvent(createEventBytes({ name: "Frog", symbol: "FROG", uri: "ipfs://Qm2", mint, curve, user }));
  const p = toPortalCreate(c, "sigC", 456);
  assert.equal(p.txType, "create"); assert.equal(p.mint, mint.toBase58()); assert.equal(p.traderPublicKey, user.toBase58());
  assert.equal(p.name, "Frog"); assert.equal(p.symbol, "FROG"); assert.equal(p.uri, "ipfs://Qm2", "the uri is what makes the picture fetchable at second zero");
  assert.equal(p.vSolInBondingCurve, 30); assert.ok(Math.abs(p.marketCapSol - 27.96) < 0.05, "opening market cap from the opening reserves");
  assert.equal(p.source, "onchain"); assert.equal(p.signature, "sigC"); assert.equal(p.slot, 456);
});
