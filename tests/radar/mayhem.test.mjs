// Mayhem tokens are excluded before anything else looks at them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMayhem, decodeCurveFlags, MAYHEM_FLAG_OFFSET } from "../../src/api/mayhem.mjs";
import { makePumpfunEdge } from "../../src/velocity/venues/pumpfun/edge.mjs";
import { goodCandidatePayload } from "../velocity/helpers/fixtures.mjs";

test("mayhem: any of three signals marks a token; a plain token is not marked", () => {
  assert.deepEqual(detectMayhem({ create: { mint: "M", txType: "create", isMayhemMode: true } }), { mayhem: true, source: "create:isMayhemMode" });
  assert.deepEqual(detectMayhem({ create: { mint: "M", is_mayhem_mode: "true" } }), { mayhem: true, source: "create:is_mayhem_mode" });
  assert.deepEqual(detectMayhem({ create: { mint: "M", pool: "pump-mayhem" } }), { mayhem: true, source: "create:pool=pump-mayhem" });
  assert.deepEqual(detectMayhem({ meta: { name: "x", is_mayhem_mode: true } }), { mayhem: true, source: "api:is_mayhem_mode" });
  assert.deepEqual(detectMayhem({ meta: { name: "x", mayhem_mode: false, pool: "pump" } }), { mayhem: false, source: null });
  const curve = Buffer.alloc(MAYHEM_FLAG_OFFSET + 1); curve[48] = 0; curve[MAYHEM_FLAG_OFFSET] = 1;
  assert.deepEqual(detectMayhem({ curve }), { mayhem: true, source: `curve:byte${MAYHEM_FLAG_OFFSET}` });
  const old = Buffer.alloc(81); // the pre-Mayhem layout has no flag byte at all
  assert.deepEqual(detectMayhem({ curve: old }), { mayhem: false, source: null });
  assert.deepEqual(detectMayhem({ create: { mint: "M", txType: "create", pool: "pump" }, meta: { name: "x" }, curve: old }), { mayhem: false, source: null });
  const f = decodeCurveFlags(curve); assert.equal(f.complete, false); assert.equal(f.flagByte, 1); assert.equal(f.length, MAYHEM_FLAG_OFFSET + 1);
  assert.equal(decodeCurveFlags(Buffer.alloc(10)).flagByte, null);
});

test("mayhem: the velocity edge never produces a candidate for a marked token", () => {
  const edge = makePumpfunEdge();
  const plain = { kind: "candidate", payload: goodCandidatePayload("MintPlain") };
  assert.equal(edge.ingest(plain).length, 1);
  const p = goodCandidatePayload("MintMayhem"); p.token._mayhem = true;
  assert.equal(edge.ingest({ kind: "candidate", payload: p }).length, 0, "not judged, not scored, not entered");
});
