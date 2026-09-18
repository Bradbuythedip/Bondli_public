// T6: kill the process between "order sent" and "fill recorded"; on restart the
// ledger shows the stage reached, and a torn final line is tolerated.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger, ORDER_STAGES } from "../../src/velocity/core/ledger.mjs";
import { Store } from "../../src/velocity/core/store.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "velocity-t6-"));
}

test("T6: order stage survives a crash between sent and filled", () => {
  const dir = tmpDir();
  const file = path.join(dir, "ledger.jsonl");
  let t = 1_000;
  const now = () => (t += 10);

  const ledger = new Ledger(file, { now });
  const decision = ledger.append({ kind: "decision", id: "d1", venue: "pumpfun", action: "GO", reasons: ["tier2"] });
  ledger.append({ kind: "order", orderId: "o1", decisionId: decision.id, venue: "pumpfun", stage: "sized", stake_usd: 25 });
  ledger.append({ kind: "order", orderId: "o1", decisionId: decision.id, venue: "pumpfun", stage: "sent", t_sent: now() });
  // crash: no fill ever recorded, process object discarded

  const reopened = new Ledger(file, { now });
  const stage = reopened.orderStage("o1");
  assert.equal(stage.stage, "sent");
  assert.equal(reopened.seq, 3);
  assert.equal(reopened.trail("d1").length, 3);
  assert.deepEqual(ORDER_STAGES, ["sized", "sent", "filled", "failed", "unwound"]);
});

test("T6: torn final line is ignored, earlier records intact", () => {
  const dir = tmpDir();
  const file = path.join(dir, "ledger.jsonl");
  const ledger = new Ledger(file);
  ledger.append({ kind: "decision", id: "d1", venue: "polymarket", action: "REJECT", reasons: ["no edge"] });
  ledger.append({ kind: "order", orderId: "o9", decisionId: "d1", venue: "polymarket", stage: "sent" });
  fs.appendFileSync(file, '{"seq":3,"kind":"fill","orderId":"o9","pri'); // crash mid-write

  const reopened = new Ledger(file);
  assert.equal(reopened.seq, 2);
  assert.equal(reopened.orderStage("o9").stage, "sent");
  const next = reopened.append({ kind: "order", orderId: "o9", decisionId: "d1", venue: "polymarket", stage: "failed", reason: "crash" });
  assert.equal(next.seq, 3);
  const all = new Ledger(file).readAll();
  assert.equal(all.length, 3);
  assert.equal(all[2].stage, "failed");
});

test("T6: ledger refuses unknown kinds and orders without a stage", () => {
  const ledger = new Ledger(path.join(tmpDir(), "l.jsonl"));
  assert.throws(() => ledger.append({ kind: "vibes" }));
  assert.throws(() => ledger.append({ kind: "order", orderId: "x" }));
});

test("T6: store snapshot is atomic and a torn snapshot falls back to defaults", () => {
  const dir = tmpDir();
  const file = path.join(dir, "state.json");
  const store = new Store(file, { now: () => 5_000 });
  store.setVenueMode("pumpfun", "paper");
  store.upsertPosition({ id: "p1", venue: "pumpfun", status: "open" });
  store.save();
  assert.ok(!fs.existsSync(`${file}.tmp`));
  const again = new Store(file, { now: () => 6_000 });
  assert.equal(again.venueMode("pumpfun"), "paper");
  assert.equal(again.openPositions().length, 1);
  fs.writeFileSync(file, '{"version":1,"positions":{"p1":');
  const torn = new Store(file);
  assert.equal(torn.openPositions().length, 0);
  assert.equal(torn.venueMode("pumpfun"), "off");
  assert.throws(() => torn.setHalt("pause", "x"));
  torn.setHalt("freeze", "test");
  assert.equal(torn.isHalted().mode, "freeze");
});
