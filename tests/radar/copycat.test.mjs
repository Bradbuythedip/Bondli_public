// Same-name launches: the copies are ads, never candidates; the original is marked as promoted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CopycatIndex, copycatKey } from "../../src/api/copycat.mjs";
import { makePumpfunEdge, waveLeaderOf, pumpfunFeatures } from "../../src/velocity/venues/pumpfun/edge.mjs";
import { goodCandidatePayload } from "../velocity/helpers/fixtures.mjs";

test("copycat: later launches with the same name and ticker point at the first one", () => {
  const ix = new CopycatIndex({ windowMs: 60_000 });
  const t0 = 1_000_000;
  assert.equal(ix.note({ ca: "A", name: "Haaland Hair", ticker: "HAIR", createdAt: t0 }), null);
  assert.deepEqual(ix.note({ ca: "B", name: "haaland  hair!", ticker: "hair", createdAt: t0 + 5_000 }), { copyOf: "A", copies: 1, key: "haalandhair|hair" });
  assert.deepEqual(ix.note({ ca: "C", name: "HAALAND HAIR", ticker: "$HAIR", createdAt: t0 + 9_000 }), { copyOf: "A", copies: 2, key: "haalandhair|hair" });
  assert.deepEqual(ix.copiesOf("A"), { copies: 2, lastCopyAt: t0 + 9_000 });
  assert.deepEqual(ix.copiesOf("B"), { copies: 0, lastCopyAt: 0 });
  // a copy is never itself treated as an original for the next copy
  assert.equal(ix.note({ ca: "D", name: "Haaland Hair", ticker: "HAIR", createdAt: t0 + 12_000 }).copyOf, "A");
  // outside the window the name is free again
  assert.equal(ix.note({ ca: "E", name: "Haaland Hair", ticker: "HAIR", createdAt: t0 + 200_000 }), null);
  // same name, different ticker: not a copy; noting the same mint twice is idempotent
  assert.equal(ix.note({ ca: "F", name: "Haaland Hair", ticker: "HH", createdAt: t0 + 201_000 }), null);
  assert.equal(ix.note({ ca: "E", name: "Haaland Hair", ticker: "HAIR", createdAt: t0 + 200_000 }), null);
  assert.equal(copycatKey("", "X"), null); assert.equal(copycatKey("a", "X"), null); assert.equal(copycatKey("Ab", ""), null);
});

test("copycat: the velocity edge never produces a candidate for a copy", () => {
  const edge = makePumpfunEdge();
  const p = goodCandidatePayload("MintCopy"); p.token._copyOf = "MintOriginal";
  assert.equal(edge.ingest({ kind: "candidate", payload: p }).length, 0);
});

test("copycat: the wave behind an original reads its pace, and only an original with copies has one", () => {
  const ix = new CopycatIndex({ windowMs: 60 * 60_000 });
  const t0 = 1_000_000, m = 60_000;
  ix.note({ ca: "A", name: "Frog", ticker: "FROG", createdAt: t0 });
  assert.equal(ix.wave("A", t0 + m), null, "no copies yet: no wave, not a wave of zero");
  for (const [i, dt] of [[1, 0.5], [2, 1.2], [3, 2.0], [4, 2.6]].map(x => x)) ix.note({ ca: "C" + i, name: "frog", ticker: "frog", createdAt: t0 + dt * m });
  // Four copies in the last three minutes, none in the three before: building.
  let w = ix.wave("A", t0 + 3 * m);
  assert.equal(w.copies, 4); assert.equal(w.recent, 4); assert.equal(w.prior, 0); assert.equal(w.rising, true); assert.equal(w.fading, false); assert.equal(w.perMin, 1.33);
  // Six minutes on with nothing new: the four are now in the prior window, none recent: fading.
  w = ix.wave("A", t0 + 6 * m);
  assert.equal(w.recent, 0); assert.equal(w.prior, 4); assert.equal(w.rising, false); assert.equal(w.fading, true);
  // Twelve minutes on, both windows empty: neither building nor fading, just old.
  w = ix.wave("A", t0 + 12 * m);
  assert.equal(w.fading, false); assert.equal(w.rising, false); assert.equal(w.copies, 4);
  // A copy has no wave of its own; a name the index never saw has none.
  assert.equal(ix.wave("C2", t0 + 3 * m), null); assert.equal(ix.wave("Nobody", t0), null);
  // Feature: size saturates at four, direction scales it, no wave is missing (never a zero).
  assert.equal(waveLeaderOf(null), null);
  assert.equal(waveLeaderOf({ copies: 0 }), null);
  assert.equal(waveLeaderOf({ copies: 2, rising: true }), 0.5);
  assert.equal(waveLeaderOf({ copies: 4, rising: true }), 1);
  assert.equal(waveLeaderOf({ copies: 8, rising: false, fading: false }), 0.7);
  assert.equal(waveLeaderOf({ copies: 4, rising: false, fading: true }), 0.25);
  const f = pumpfunFeatures({ scores: { apeScore: 50 }, token: {}, qf: { _wave: { copies: 3, rising: true } } });
  assert.equal(f.waveLeader, 0.75);
  assert.equal(pumpfunFeatures({ scores: { apeScore: 50 }, token: {}, qf: {} }).waveLeader, null, "absent is missing, never zero");
});
