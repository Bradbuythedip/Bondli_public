// T27: a held token is a position with money in it, and the two EVM feeds owe it a tick every poll
// whatever happens to the feed's own bookkeeping: it is never evicted to make room, one the chain
// cannot name yet is asked about again and ticks unreadable meanwhile, and nothing a feed says
// about an error can carry the RPC key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorText } from "../../src/velocity/core/feed.mjs";
import { ArcFeed } from "../../src/velocity/venues/arc/feed.mjs";
import { PonsFeed } from "../../src/velocity/venues/pons/feed.mjs";

const addr = n => "0x" + n.toString(16).padStart(40, "0");
const KEYED = "server response 503 Service Unavailable (request={  }, response={  }, error=null, info={ \"requestUrl\": \"https://arc-mainnet.g.alchemy.com/v2/SECRETKEY123abc\", \"responseStatus\": \"503\" })";

test("T27: an error's text keeps its meaning and loses every URL", () => {
  const e = new Error(KEYED); e.shortMessage = "server response 503 Service Unavailable";
  assert.equal(errorText(e), "server response 503 Service Unavailable", "ethers' short message, with no request block");
  const plain = new Error(KEYED);
  assert.doesNotMatch(errorText(plain), /SECRETKEY|alchemy/); assert.match(errorText(plain), /<rpc>/);
  assert.equal(errorText("execution reverted"), "execution reverted");
  assert.equal(errorText(null), "");
  assert.equal(errorText(new Error("x".repeat(500)), 40).length, 40);
});

test("T27: arc: a held token is never evicted; one the Portals cannot name ticks unreadable, is retried later, and the feed's errors carry no key", async () => {
  let now = 1_800_000_000_000; const clock = () => now;
  let lookups = 0;
  const rpc = { blockNumber: async () => 1000, logs: async () => [], launchInfo: async () => { lookups++; return null; },
    hookInfo: async () => { throw new Error(KEYED); }, slot0: async () => { throw new Error(KEYED); }, liquidity: async () => "0", tokenMeta: async () => ({ name: "", symbol: "" }) };
  const feed = new ArcFeed({ rpc, pollMs: 1500, maxTokens: 2, clock });
  const events = []; feed.on("event", e => { if (e.kind !== "feed_health") events.push(e); });
  const launch = (n, createdAt) => feed.apply({ kind: "launch", token: addr(n), creator: addr(0x99), name: "t" + n, symbol: "T" + n, poolId: null, imageURI: "", website: "", twitter: "", telegram: "", block: 1, tx: "0x" + n }, createdAt);
  // The oldest token is held; three newer launches arrive with room for two.
  launch(0xa1, now - 3_600_000); feed.watch(addr(0xa1));
  launch(0xa2, now - 100); launch(0xa3, now - 50); launch(0xa4, now - 10);
  assert.ok(feed.token(addr(0xa1)), "the held token, oldest by far, is still here");
  assert.equal(feed.tokens.size, 2); assert.equal(feed.token(addr(0xa2)), null, "room came from the oldest token nobody holds");
  // A watched token no Portal knows: an unreadable tick every poll, and the lookup backs off.
  feed.watch(addr(0xb1));
  await feed.pollOnce();
  let ghost = events.filter(e => e.kind === "tick" && e.id === addr(0xb1));
  assert.equal(ghost.length, 1); assert.deepEqual(ghost[0].payload, { unreadable: true, source: "arc", solPrice: 1, solPriceAt: feed.solPriceAt, quote: "USDC", token: { ca: addr(0xb1), curve: null, graduated: false, bonded: false, _ageMs: null } });
  assert.equal(lookups, 1); assert.equal(feed.status().pendingAdopt, 1); assert.equal(feed.status().adoptFailures, 1);
  // The chain has not moved since: the poll reads nothing, and still every held token is ticked.
  events.length = 0; await feed.pollOnce();
  assert.equal(lookups, 1, "asked again later, not every poll"); assert.equal(events.filter(e => e.kind === "tick" && e.id === addr(0xb1)).length, 1, "but ticked again");
  assert.equal(events.filter(e => e.kind === "tick" && e.id === addr(0xa1)).length, 1, "the held token too, on a poll with no new block");
  now += 4_000; await feed.pollOnce(); assert.equal(lookups, 2, "and asked again once the wait is over");
  assert.equal(feed.status().pendingAdopt, 1, "still waiting, never dropped");
  // The held token's hook throws with the key in the message: the status page never sees it.
  const st = feed.status();
  assert.doesNotMatch(JSON.stringify(st), /SECRETKEY|alchemy/, JSON.stringify(st));
  feed._noteError(new Error(KEYED));
  assert.doesNotMatch(JSON.stringify(feed.status()), /SECRETKEY|alchemy/); assert.match(feed.status().lastError, /<rpc>/);
  // Eviction of a held token by any other path re-queues it for adoption rather than losing it.
  feed._forget(feed.token(addr(0xa1)));
  assert.equal(feed.token(addr(0xa1)), null); assert.equal(feed.status().pendingAdopt, 2);
  events.length = 0; await feed.pollOnce();
  assert.equal(events.filter(e => e.kind === "tick" && e.id === addr(0xa1) && e.payload.unreadable).length, 1, "and it ticks unreadable meanwhile");
});

test("T27: pons: the same three guarantees", async () => {
  let now = 1_800_000_000_000; const clock = () => now;
  let lookups = 0;
  const rpc = { blockNumber: async () => 1000, logs: async () => [], launchInfo: async () => { lookups++; return null; },
    curveInfo: async () => { throw new Error(KEYED); }, tokenMeta: async () => ({ name: "", symbol: "" }) };
  const feed = new PonsFeed({ rpc, pollMs: 2000, maxTokens: 2, ethPrice: 3000, clock });
  const events = []; feed.on("event", e => { if (e.kind !== "feed_health") events.push(e); });
  const launch = (n, createdAt) => feed.apply({ kind: "launch", token: addr(n), curve: addr(0xc000 + n), deployer: addr(0x99), pairToken: addr(0), graduationThreshold: 4, block: 1, tx: "0x" + n }, createdAt);
  launch(0xa1, now - 3_600_000); feed.watch(addr(0xa1));
  launch(0xa2, now - 100); launch(0xa3, now - 50); launch(0xa4, now - 10);
  assert.ok(feed.token(addr(0xa1)), "held, so kept"); assert.equal(feed.tokens.size, 2); assert.equal(feed.token(addr(0xa2)), null);
  feed.watch(addr(0xb1));
  await feed.pollOnce();
  const ghost = events.filter(e => e.kind === "tick" && e.id === addr(0xb1));
  assert.equal(ghost.length, 1); assert.equal(ghost[0].payload.unreadable, true); assert.equal(ghost[0].payload.token.curve, null);
  assert.equal(lookups, 1); assert.equal(feed.status().pendingAdopt, 1);
  events.length = 0; await feed.pollOnce();
  assert.equal(lookups, 1, "backed off"); assert.equal(events.filter(e => e.kind === "tick" && e.id === addr(0xb1)).length, 1);
  // The held token's curve read throws with the key: unreadable tick, scrubbed status.
  const held = events.filter(e => e.kind === "tick" && e.id === addr(0xa1));
  assert.equal(held.length, 1); assert.equal(held[0].payload.unreadable, true, "a curve that will not answer is not a price");
  assert.doesNotMatch(JSON.stringify(feed.status()), /SECRETKEY|alchemy/);
  feed._noteError(new Error(KEYED));
  assert.doesNotMatch(JSON.stringify(feed.status()), /SECRETKEY|alchemy/);
});
