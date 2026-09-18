// T18: a token picture is never put on screen half-drawn.
//
// The tile used to mount the <img> immediately and fade it in on the load event. load says the BYTES
// arrived, not that there is a frame ready to present: a progressive JPEG or a large PNG can be
// revealed mid-decode and paint in bands, which on a list of twenty-five launches is the flicker the
// page was accused of. decode() resolves only when the frame is ready, so the element is mounted
// after that and never before. Asserted on the source: the tile is inside one large component with
// no seam to render in isolation, and what matters is which API decides when the picture appears.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(path.resolve("app/src/Simple.jsx"), "utf8");
const TILE = SRC.slice(SRC.indexOf("function TokenImg"), SRC.indexOf("// ── Movers"));

test("T18: the picture is revealed only whole, and a picture that arrived is never thrown away", () => {
  assert.ok(TILE.length > 200, "found the tile component");
  // Invisible until whole: the element is in the document at opacity 0 (a full paint nobody sees),
  // and opacity goes to 1 only when `ready` names THIS url -- not a stale one from a recycled row.
  assert.match(TILE, /const loaded = ready === full;/);
  assert.match(TILE, /opacity: loaded \? 1 : 0/);
  assert.match(TILE, /key=\{full\} src=\{full\}/);
  // decode() gates the reveal when it resolves...
  assert.match(TILE, /el\.decode\(\)\.then\(reveal, reveal\)/, "a decode rejection falls through to the pixel check, never to a retry");
  // ...but onerror is the ONLY thing that counts as a miss. A rejected decode with pixels present is
  // a WebKit quirk, and the old tile turned it into a permanent blank on every iPhone.
  assert.match(TILE, /el\.complete && el\.naturalWidth > 0/);
  assert.doesNotMatch(TILE, /new Image\(\)/, "no detached Image: WebKit's decode() is unreliable off-document");
  assert.doesNotMatch(TILE, /decode\(\)\.then\(done, fail\)/);
});

test("T18: a miss is retried past the proxy's negative cache for minutes, then the ticker stands in", () => {
  assert.match(TILE, /onError=\{onError\}/);
  assert.match(TILE, /tries < IMG_RETRY_MS\.length/);
  assert.match(TILE, /else sOk\(false\)/);
  // The schedule has to outlast the metadata (minutes, not a minute) and every gap after the first
  // has to clear the proxy's 30s negative cache, or the retry is an instant 404 that spends a try.
  const sched = JSON.parse(/const IMG_RETRY_MS = (\[[^\]]+\])/.exec(SRC)[1].replace(/_/g, ""));
  assert.ok(sched.reduce((a, b) => a + b, 0) >= 5 * 60_000, "keeps trying for at least five minutes");
  for (const gap of sched.slice(1)) assert.ok(gap >= 30_000, `gap ${gap} is inside the negative cache`);
});
