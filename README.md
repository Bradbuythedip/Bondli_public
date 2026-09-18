<p align="center">
  <img src="app/public/fren.png" alt="Bondli" width="140" />
</p>

# Bondli

**A bot that trades launchpad tokens in their first minutes. You keep the wallet.**

[![Live](https://img.shields.io/badge/live-bondli.fun-00ff88?style=flat-square)](https://bondli.fun)
[![Tests](https://img.shields.io/badge/tests-npm%20test-brightgreen?style=flat-square)](#run-the-tests)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![X](https://img.shields.io/badge/X-@shitanalystXBT-1DA1F2?style=flat-square)](https://x.com/shitanalystXBT)

The trading engine behind [bondli.fun](https://bondli.fun): the feeds, the gates, the sizing, the
exits, the routers for three chains, the verified-callout ledger, and the tests that hold every claim
on this page. It is the repository referenced by our
[Arc ecosystem grant application](docs/GRANT-ARC-APPLICATION.md).

The public mirror is [Bondli_public](https://github.com/Bradbuythedip/Bondli_public); what it leaves
out, and why, is in [docs/PUBLIC_MIRROR.md](docs/PUBLIC_MIRROR.md).

---

## What it does

A human cannot judge a token launch in its first ninety seconds. Bondli runs one trading engine per
user, on a wallet the user funds and can empty in one action, and it judges every launch on three
venues through the same gates:

| Venue | Chain | Quote asset | Launchpad |
|---|---|---|---|
| `pumpfun` | Solana | SOL | pump.fun bonding curves |
| `pons` | Robinhood Chain | ETH | PONS V2 curves |
| `arc` | Arc (Circle's L1, chain 5042) | **USDC** | Argus — Uniswap v4 with a launch hook |

On Arc the quote asset is the dollar itself: the stake, the mark, the profit, the gas and the
platform's fee are all USDC, with no price feed between the trade and the money. That integration is
documented in [docs/ARC_INTEGRATION.md](docs/ARC_INTEGRATION.md) and published as a standalone
package, [`@bondli/arc-argus`](packages/arc-argus) — the only Argus indexer and pool-math library we
know of.

A fourth adapter, Polymarket, and a disabled perps stub live under `src/velocity/venues/` and are
driven by the standalone CLI rather than the hosted service.

---

## What the customer is owed

Eleven rules the code is built around. Each one names where it is held and the test that holds it —
the full text is in [docs/AXIOMS.md](docs/AXIOMS.md), and a change that would violate one has to
argue with that file first.

1. **Money leaves only by a trade they asked for or a fee they were told about.** Every route that
   moves money or reads a key is behind `requireOwner`, and a structural test walks the source to
   prove it — if a route loads a trading wallet without that guard, the suite fails.
2. **The bot never holds what it cannot manage.** A position with no readable price has no stop loss
   behind it, so it is sold on that fact alone after 45 seconds.
3. **Every number on screen reconciles with its own parts.** A venue that joins mid-run brings its
   open positions into the baseline, so a position the baseline never saw is not a gain.
4. **A loss is bounded before it happens.** Losing more always means betting less, smoothly, with no
   lockout to game; the only hard stop is a fault at 3× the daily limit.
5. **They can stop everything, always, in one action.**
6. **They can try it before funding it.** Paper mode runs the same feed, gates, sizes, plans and
   exits with only the router simulated.
7. **They can see why, in the bot's own words.**
8. **Nothing is lost to our own failure.** Custodial keys are sealed with AES-256-GCM and stored with
   no expiry; a crash mid-trade reconciles from the ledger and the chain.
9. **A call is a fill, never an opinion.** See below.
10. **A new venue costs trades before it can cost money.**
11. **On Arc the quote asset is the dollar, and nothing is priced through anything else.**

---

## Verified callouts

Anything the site or a channel says the bot "called" is a buy the bot made with real money.

Before a word reaches any channel, the record is written to the bot's own ledger with
`sha256(venue | instrument | tx | ts | mcapUsd | tier | plan)`. The close is posted the same way,
losses included. Paper trades never post, one call per token per hour across every user, and no row
names a wallet or a user.

That ordering is the point: the hash is anchored at post time, so the track record cannot be trimmed,
back-dated or quietly improved afterwards. The public feed is `GET /api/callouts`; the code is
[`src/velocity/core/callouts.mjs`](src/velocity/core/callouts.mjs) and the tests are
`tests/velocity/t21-callouts.test.mjs`.

---

## A reviewer's map

Every claim above, with the file that implements it and the test that holds it. `npm test` runs all
of them, offline, with no keys.

| Claim | Implementation | Test |
|---|---|---|
| No route touches a custodial key without proving ownership | `src/middleware/wallet-auth.mjs` | `tests/api/t15-route-guards.test.mjs` |
| Keys are sealed at rest and never expire | `src/middleware/keyvault.mjs` | `tests/api/t16-custody-durability.test.mjs`, `tests/api/keyvault-auth.test.mjs` |
| Paper mode cannot reach a live router and is never charged | `src/velocity/hub.mjs` | `tests/api/t17-funding-gate.test.mjs`, `t11-hub` |
| The risk envelope is immutable at runtime and validated up front | `src/velocity/core/risk.mjs` | `tests/velocity/t3-risk-property.test.mjs` |
| Exit plans are fixed at entry; three layers fire in order | `src/velocity/core/exits.mjs`, `plans.mjs` | `tests/velocity/t5-exit-plans.test.mjs` |
| A crash mid-trade reconciles from the ledger and the chain | `src/velocity/core/engine.mjs` | `tests/velocity/t9-reconcile.test.mjs`, `t6-ledger-crash` |
| Losing more means betting less, with no lockout | `src/velocity/core/governor.mjs` | `tests/velocity/t7-governor.test.mjs` |
| The learner cannot invert a sacred rule or drift past its bounds | `src/velocity/core/learner.mjs` | `tests/velocity/t8-learner.test.mjs` |
| The fee is taken only from realized profit, in the venue's own asset | `src/velocity/hub.mjs` `settleFee` | `tests/velocity/t11-hub.test.mjs` |
| Holding the house token waives the fee; an unreadable balance never charges a holder | `src/velocity/core/holder-waiver.mjs` | `tests/velocity/t14-holder-waiver.test.mjs` |
| A call is bound to the fill that made it, and is hashed before it is posted | `src/velocity/core/callouts.mjs` | `tests/velocity/t21-callouts.test.mjs` |
| Argus events, topics and record layouts decode correctly | `packages/arc-argus/chain.mjs` | `tests/velocity/t20-arc-chain.test.mjs` |
| A held token ticks every poll, readable or not | `src/velocity/venues/arc/feed.mjs`, `pons/feed.mjs` | `tests/velocity/t22-arc-feed.test.mjs`, `t27-feed-held-safety` |
| Every swap is dry-run; no buy in the snipe window; no sell at any price | `src/velocity/venues/arc/router.mjs` | `tests/velocity/t23-arc-router.test.mjs` |
| A PONS sell shrinks size before widening price, and `minOut` is never 0 | `src/velocity/venues/pons/router.mjs` | `tests/velocity/t13-pons-sell.test.mjs` |
| Smart-money scoring is measured, ring-aware and wash-aware | `src/engine/wallet-intel.mjs` | `tests/radar/wallet-intel.test.mjs` |
| Arc launch data is public with no wallet in any row | `src/api/server.production.mjs` `/api/arc/stats` | `tests/api/t30-arc-grant-surfaces.test.mjs` |
| Nothing outside is polled unless someone is trading | `src/api/activity.mjs` | `tests/api/t29-activity-gate.test.mjs` |
| A copy of a live launch is never bought | `src/api/copycat.mjs` | `tests/radar/copycat.test.mjs` |
| Replay of a captured feed is deterministic | `src/velocity/core/replay.mjs` | `tests/velocity/t2-replay-determinism.test.mjs` |

---

## Layout

```
src/velocity/        the trading engine: feed, gates, sizing, plans, exits, ledger,
  core/              governor, learner, supervisor, callouts
  venues/            pumpfun · pons · arc · polymarket · perps (stub)
  hub.mjs            one engine per user, the performance fee, the wallet paths
packages/arc-argus/  the Arc/Argus chain layer, published on its own
src/api/             the HTTP server, the radar, the activity gate
src/engine/          scoring, rug detection, wallet intelligence, price feeds
src/autoape/         the entry gates and the exit-plan table
src/scoring/memetic/ the memetic feature extractors
app/                 the React frontend (English and Simplified Chinese)
tests/               the suite: velocity · radar · api
docs/                architecture, axioms, the Arc integration, the grant documents
```

A fuller tree is in [docs/REPO_STRUCTURE.md](docs/REPO_STRUCTURE.md).

---

## Run the tests

```bash
npm install && npm install --prefix app
npm test
npm run test:offline     # the same suite, with every call to the outside world made to throw
```

The whole suite runs offline and green. No RPC, no API key and no funded wallet: every chain the
tests touch is a fake built inside the test file, and the routers are driven through injected fakes
rather than a node.

`test:offline` is how that claim stays true. It reruns the suite with `fetch` replaced by one that
throws for anything outside this machine, so a code path that quietly reaches the internet fails the
build instead of making the suite depend on somebody else's uptime. CI runs both.

## Run the stack

```bash
cp .env.example .env     # nothing is required to boot; every integration is off until its key is set
npm run dev              # API on :3001, frontend on :5173
```

Deployment notes for the hosted service are in [deploy/HOSTED_VELOCITY.md](deploy/HOSTED_VELOCITY.md)
and [docs/QUICKSTART.md](docs/QUICKSTART.md).

---

## Public endpoints

| Endpoint | What it is |
|---|---|
| `GET /api/callouts` | the public track record: every published call, its transaction, its result, its hash |
| `GET /api/velocity/pulse` | bots trading now and closes today; no wallet named |
| `GET /api/arc/stats` | Argus launches as the feed sees them, aggregated, no wallet in any row |
| `GET /api/radar/live` | the newest launches and the one word the bot has for each |
| `GET /api/activity` | whether the outside world is being polled at all |

---

## Documentation

| Document | What it covers |
|---|---|
| [docs/AXIOMS.md](docs/AXIOMS.md) | what the customer is owed, where each rule is held, and what is still open |
| [docs/ARC_INTEGRATION.md](docs/ARC_INTEGRATION.md) | Arc and Argus: USDC's two faces, the feed, the router, what is and is not pinned |
| [docs/GRANT-ARC.md](docs/GRANT-ARC.md) | the Arc grant submission: what exists, the deliverables, the review record |
| [docs/GRANT-ARC-APPLICATION.md](docs/GRANT-ARC-APPLICATION.md) | the application, field by field |
| [docs/ARCHITECTURE_OVERVIEW.md](docs/ARCHITECTURE_OVERVIEW.md) | the stack, end to end |
| [docs/BONDING_CURVE.md](docs/BONDING_CURVE.md) | pump.fun bonding-curve mechanics |
| [docs/BONDLI_API.md](docs/BONDLI_API.md) | the HTTP API |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | setup, environment variables, scripts |
| [docs/REPO_STRUCTURE.md](docs/REPO_STRUCTURE.md) | the file tree |
| [docs/PUBLIC_MIRROR.md](docs/PUBLIC_MIRROR.md) | what this mirror leaves out, and why |
| [src/velocity/README.md](src/velocity/README.md) | the engine's own operator documentation |
| [src/velocity/HOSTED_DESIGN.md](src/velocity/HOSTED_DESIGN.md) | the axiomatic design pass behind the hosted service |

---

## What we do not claim

No return. No win rate other than the one the public record shows at the time you read it. Nothing
here is advice, and nothing here is guaranteed. The open list at the bottom of
[docs/AXIOMS.md](docs/AXIOMS.md) is part of the documentation, not an appendix to it: it says what is
still wrong.

The performance fee is 5% of realized profit on a closed position, taken in the venue's own asset,
never from a loss, and waived entirely for holders of the house token. That token is not launched; 
until it is, every fee is charged exactly as described.

---

MIT © Bondli
