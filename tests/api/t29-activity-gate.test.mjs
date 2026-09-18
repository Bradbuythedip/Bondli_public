// T29: nothing outside is polled unless someone is trading. The gate itself is a small state
// machine; the rest is where the server consults it, pinned on the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ActivityGate } from "../../src/api/activity.mjs";

const SRC = fs.readFileSync(path.resolve("src/api/server.production.mjs"), "utf8");
const HUB = fs.readFileSync(path.resolve("src/velocity/hub.mjs"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("T29: the gate opens on the first bot, stays open through the grace, and closes only once nobody is back", async () => {
  const seen = [];
  const g = new ActivityGate({ graceMs: 40, log: { log() {}, error() {} } });
  g.on((a, why) => seen.push([a, why]));
  assert.equal(g.active(), false); assert.deepEqual(seen, [[false, "subscribed"]]);
  g.note(1);
  assert.equal(g.active(), true); assert.equal(seen.at(-1)[0], true);
  g.note(2); g.note(1);
  assert.equal(seen.length, 2, "more bots is not a transition");
  g.note(0);
  assert.equal(g.active(), true, "still active inside the grace");
  await sleep(15);
  g.note(1); // someone came back inside the grace: the timer is cancelled
  await sleep(50);
  assert.equal(g.active(), true, "a restart inside the grace never idled");
  g.note(0);
  await sleep(60);
  assert.equal(g.active(), false, "idle once the grace passed with nobody back");
  assert.match(seen.at(-1)[1], /no bot for/);
  assert.equal(g.status().transitions, 2, "open once, closed once: the restart inside the grace was no transition");
  // ALWAYS_ON: never idle, whatever the count.
  const on = new ActivityGate({ graceMs: 5, alwaysOn: true, log: { log() {} } });
  assert.equal(on.active(), true); on.note(0); await sleep(15); assert.equal(on.active(), true);
});

test("T29: every module-level poller, the PumpPortal socket, the on-chain stream and the three feeds follow the gate", () => {
  assert.match(SRC, /const activity = new ActivityGate\(\{ graceMs: \(parseInt\(process\.env\.ACTIVITY_GRACE_MIN \|\| "10"\) \|\| 10\) \* 60_000, alwaysOn: process\.env\.ALWAYS_ON === "1" \}\);/);
  const gatedPollers = (SRC.match(/^setInterval\(gated\(/gm) || []).length;
  const barePollers = (SRC.match(/^setInterval\((?!gated\()/gm) || []).length;
  assert.ok(gatedPollers >= 14, `gated pollers: ${gatedPollers}`);
  // The only module-level interval left bare is the in-memory revival prune, which calls nothing outside.
  assert.equal(barePollers, 1, `bare module-level pollers: ${barePollers}`);
  assert.match(SRC, /^setInterval\(\(\) => radar\._revivals\.prune\(\)/m);
  assert.match(SRC, /function connectPumpPortal\(\) \{\n  if \(!activity\.active\(\)\) return;/);
  assert.match(SRC, /if \(!activity\.active\(\)\) \{ console\.log\("\[RADAR\] WS closed: idle"\); radar\.ws = null; return; \}/, "no reconnect while idle");
  assert.match(SRC, /function chooseTradeSource\(\) \{\n  if \(!activity\.active\(\)\) \{ if \(radar\._onchain\) \{ radar\._onchain\.stop\(\)/, "the on-chain stream stops when idle");
  assert.match(SRC, /onUsers: \(n\) => activity\.note\(n\)/, "the hub reports its bot count");
  assert.match(SRC, /if \(active && !f\.running\) f\.start\(\)/); assert.match(SRC, /else if \(!active && f\.running\) \{ f\.stop\(\)\.catch\(\(\) => \{\}\); if \("_block" in f\) f\._block = null;/);
  assert.doesNotMatch(SRC, /^  hubFeed\.start\(\)/m, "feeds no longer start at boot");
  assert.doesNotMatch(SRC, /^connectPumpPortal\(\);$/m, "the socket no longer connects at boot");
  assert.match(SRC, /app\.get\("\/api\/activity"/);
  assert.match(HUB, /this\.onUsers\?\.\(this\.users\.size\);/g);
  assert.equal((HUB.match(/this\.onUsers\?\.\(this\.users\.size\);/g) || []).length, 2, "reported on start and on stop");
});
