# Repository structure

The tree, annotated. Generated against the published file list; the counts are real.

```
.
├── README.md                     what this is, and the reviewer's map of claim → file → test
├── LICENSE                       MIT
├── .env.example                  every environment variable, with commentary and no values
├── package.json                  scripts and dependencies
├── docker-compose.brad.yml       the optional BRAD cognitive sidecar
│
├── .github/workflows/
│   └── test.yml                  CI: install, run the suite, check the Arc package parses
│
├── docs/                         (11 documents)
│   ├── AXIOMS.md                 what the customer is owed — the rules the code answers to
│   ├── ARC_INTEGRATION.md        Arc and Argus: USDC's two faces, the feed, the router, what is pinned
│   ├── ARCHITECTURE_OVERVIEW.md  the stack, end to end
│   ├── BONDLI_API.md             the HTTP API: public, owner and admin routes
│   ├── BONDING_CURVE.md          pump.fun bonding-curve mechanics
│   ├── QUICKSTART.md             setup, environment, scripts
│   ├── REPO_STRUCTURE.md         this file
│   ├── PUBLIC_MIRROR.md          what the public mirror leaves out, and why
│   ├── GRANT-ARC.md              the Arc grant submission: what exists, and the test behind each claim
│   ├── LORE.md                   the story the site tells, checked against the code
│   └── TWEETS.md                 launch thread drafts, with every number left as a placeholder
│
├── packages/
│   └── arc-argus/                (4)  the Arc/Argus chain layer, published standalone
│       ├── chain.mjs             Portals, events, launch-record layouts, v4 pool math, tax model,
│       │                         swap encodings — pure functions, no network
│       ├── index.mjs             the public surface
│       ├── package.json          @bondli/arc-argus
│       └── README.md             what is pinned to a published source and what is not
│
├── src/
│   ├── api/                      (10)
│   │   ├── server.production.mjs the HTTP + WebSocket server, the radar, the scored feed
│   │   ├── activity.mjs          the gate: nothing outside is polled unless a bot is running
│   │   ├── radar-onchain.mjs     pump.fun trades decoded from Solana program logs
│   │   ├── copycat.mjs           same-name relaunches are adverts, never bought
│   │   ├── mayhem.mjs            Mayhem-mode tokens are never looked at
│   │   ├── revival.mjs           a token that wakes up after an hour flat
│   │   ├── launch.mjs            the launch banner the site polls
│   │   ├── launch-trend.mjs      launches per minute, as a trend
│   │   ├── verdict-tag.mjs       the one word the radar has for a token
│   │   └── access-check.mjs      tier resolution
│   │
│   ├── velocity/                 the trading engine
│   │   ├── hub.mjs               one engine per user, the performance fee, the wallet paths
│   │   ├── index.mjs             the single-tenant CLI
│   │   ├── README.md             the operator's documentation
│   │   ├── HOSTED_DESIGN.md      the axiomatic design pass behind the hosted service
│   │   ├── config/
│   │   │   └── risk.example.json the risk envelope template
│   │   ├── core/                 (22)
│   │   │   ├── engine.mjs        wiring, entries, exits, reconciliation
│   │   │   ├── events.mjs        the MarketEvent contract every venue emits
│   │   │   ├── feed.mjs          the feed base and the shared view
│   │   │   ├── pipeline.mjs      the venue-agnostic gate runner
│   │   │   ├── risk.mjs          the envelope, validation, fractional Kelly
│   │   │   ├── plans.mjs         the exit-plan table
│   │   │   ├── exits.mjs         plans fixed at entry, three exit layers
│   │   │   ├── router.mjs        the router interface and the paper router
│   │   │   ├── ledger.mjs        the append-only JSONL record, fsynced
│   │   │   ├── store.mjs         the atomic state snapshot
│   │   │   ├── governor.mjs      blind spots, tilt, regime, the daily taper
│   │   │   ├── learner.mjs       bounded retraining, rules it may never invert
│   │   │   ├── supervisor.mjs    heartbeat, watchdogs, the HALT file
│   │   │   ├── callouts.mjs      the public record, hashed before it is posted
│   │   │   ├── holder-waiver.mjs the house-token fee waiver
│   │   │   ├── alerts.mjs        operator alerts
│   │   │   ├── replay.mjs        capture and deterministic replay
│   │   │   └── …                 build, promote, stats, server, watch
│   │   └── venues/
│   │       ├── pumpfun/          (3)  feed · edge · router — Solana bonding curves
│   │       ├── pons/             (3)  feed · chain · router — Robinhood Chain
│   │       ├── arc/              (3)  feed · chain · router — Argus on Arc, USDC-quoted
│   │       ├── polymarket/       (3)  feed · edge · router — CLI only
│   │       └── perps/            (1)  a disabled stub
│   │
│   ├── engine/                   (45)  scoring, rug detection, intelligence
│   │   ├── meme-intelligence.mjs the scorer: 40+ features, RAG memory, online updates
│   │   ├── wallet-intel.mjs      which wallets are actually smart, measured from our own stream
│   │   ├── rug-scanner.mjs       the rug signals
│   │   ├── artwork-scanner.mjs   perceptual hashing and image forensics
│   │   ├── dev-wallet-tracker.mjs dev history and serial ruggers
│   │   ├── demand-authenticity.mjs manufactured demand
│   │   ├── volume-legitimacy.mjs wash trading
│   │   ├── survivorship-bias.mjs the survivor archetype
│   │   ├── price-feeds.mjs       quote prices, with staleness treated as absence
│   │   ├── fee-engine.mjs        the fee ladder
│   │   ├── brad-*.mjs            the optional cognitive sidecar and its paper trader
│   │   └── …                     regime, tilt, correlation, resurgence, movers, Bags, X
│   │
│   ├── autoape/
│   │   ├── gates/                (6)  disqualifiers, viability, confidence, curve, window, portfolio
│   │   ├── pipeline.js           the gate order
│   │   ├── sizing.js             stake from score and bankroll
│   │   ├── exit-plan.js          plan selection
│   │   └── recovery.js           watchlist promotion and re-entry
│   │
│   ├── scoring/memetic/          (21)  linguistic, absurdity, cultural timing, influencer,
│   │                                   community, visual, temporal + background workers and data
│   └── middleware/               (2)   wallet-auth (requireOwner) and keyvault (AES-256-GCM):
│                                       the two things standing between a request and a custodial key
│
├── app/                          the React + Vite frontend
│   ├── src/Simple.jsx            the whole interface
│   ├── src/lib/                  api client, i18n (English + 简体中文), theme, share cards
│   ├── public/                   icons, the frog, the manifest
│   └── vite.config.js · vercel.json
│
├── tests/                        (42 files)
│   ├── velocity/                 (19 + 2 helpers)  T1–T27: feed, replay, risk, slippage, exits,
│   │                             ledger crash, governor, learner, reconcile, live path, hub,
│   │                             PONS chain and sell, holder waiver, Arc chain/feed/router, callouts
│   ├── api/                      (13)  route guards, custody durability, funding gate, image paint,
│   │                             launch banner, wallet-intel wiring, Arc + callouts wiring, wave
│   │                             wiring, viral surfaces, activity gate, Arc grant surfaces
│   ├── radar/                    (7)   copycat, launch, mayhem, onchain, revival, slowcook,
│   │                             wallet intelligence
│   └── helpers/                  (1)   the offline guard: proves the suite calls nothing outside
│
├── tools/                        (5)
│   ├── tx-audit.mjs              reconcile the ledger against the chain, one signature at a time
│   ├── gate-stats.mjs            offline calibration of the entry gates
│   ├── mayhem-probe.mjs          what a token looks like from each source the radar can read
│   ├── launch-push.mjs           push the launch banner
│   └── sync-public.mjs           build the public mirror (see PUBLIC_MIRROR.md)
│
└── deploy/                       (5)  Dockerfile, compose, nginx, deploy.sh, HOSTED_VELOCITY.md
```

## Reading order

For a reviewer with an hour:

1. [`docs/AXIOMS.md`](AXIOMS.md) — what the system promises, and the open list of what is still wrong.
2. `tests/api/t15-route-guards.test.mjs` — the shortest test that shows how the promises are held.
3. [`docs/ARC_INTEGRATION.md`](ARC_INTEGRATION.md) and `packages/arc-argus/` — the USDC-native venue.
4. `src/velocity/core/engine.mjs` — where a candidate becomes a position and a position becomes an outcome.
5. `src/velocity/core/callouts.mjs` — why the public track record cannot be edited after the fact.
