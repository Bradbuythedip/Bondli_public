# Architecture

One sentence: a shared launch feed per chain, one isolated trading engine per user reading those
feeds, and a ledger under each engine that every number on the screen is derived from.

```
   Solana                Robinhood Chain            Arc (chain 5042)
   pump.fun              PONS V2 curves             Argus · Uniswap v4
      │                       │                          │
      │ program logs          │ eth_getLogs              │ eth_getLogs
      ▼                       ▼                          ▼
  ┌──────────┐           ┌──────────┐              ┌──────────┐
  │  radar   │           │ PonsFeed │              │ ArcFeed  │      ← ONE of each,
  │ (onchain)│           │          │              │          │        shared by every user
  └────┬─────┘           └────┬─────┘              └────┬─────┘
       │                      │                         │
       └──────────┬───────────┴─────────────┬───────────┘
                  │   the same MarketEvent shape from all three
                  ▼
        ┌───────────────────────────────────────────────┐
        │  scoring · gates · sizing · plans · exits      │   ← venue-agnostic
        │  src/engine · src/autoape · src/velocity/core  │
        └───────────────────┬───────────────────────────┘
                            │
      ┌─────────────────────┼─────────────────────┐
      ▼                     ▼                     ▼
  Engine(alice)        Engine(bob)           Engine(carol)     ← one per user:
  own wallet           own wallet            own wallet          own risk envelope,
  own ledger           own ledger            own ledger          own halt state
      │                     │                     │
      └─────────────────────┴─────────────────────┘
                            │
                    ┌───────▼────────┐
                    │  VelocityHub   │  performance fee, callouts, wallet paths
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │  Express + WS  │  → React frontend (EN / 简体中文)
                    └────────────────┘
```

## Why it is shaped like this

**One feed, many engines.** The hosted service costs one radar and one trade stream however many
users are running bots. Each engine sees the feed through a `SharedFeedView` and keeps its own
watch list, so a token one user holds is ticked for that user without every other engine paying for
it.

**The venue is an adapter, not a special case.** A venue supplies three things — a feed that emits
`MarketEvent`s, an edge that turns a token into a candidate, and a router that can buy, sell and
report a fill. Everything above that is shared: the same gates judge a pump.fun curve, a PONS curve
and an Argus pool, the same sizer stakes them and the same exit plans close them. Adding Arc added
three files and changed nothing in the engine.

**The ledger is the truth.** Every decision, order, fill, exit, outcome, fee, halt and governor
verdict is appended to a per-user JSONL ledger and fsynced. State is a snapshot written atomically
beside it. After a crash the engine reconciles from the ledger and the chain — and before booking a
100% loss on a sale it lost the signature for, it goes and looks for that sale on chain first.

## The pieces

| Layer | Where | What it does |
|---|---|---|
| Feeds | `src/velocity/venues/*/feed.mjs`, `src/api/radar-onchain.mjs` | decode launches and trades into one event shape; keep per-token state (buyers, spark, market cap, curve progress) |
| Scoring | `src/engine/`, `src/scoring/memetic/` | 40+ features per token: holder distribution, buy pressure, chart shape, dev-wallet history, artwork forensics, memetic signals |
| Rug detection | `src/engine/rug-scanner.mjs`, `dev-wallet-tracker.mjs`, `demand-authenticity.mjs`, `volume-legitimacy.mjs` | dev dumps, sybil clusters, wash trading, staircase charts, liquidity drains, serial ruggers |
| Wallet intelligence | `src/engine/wallet-intel.mjs` | which wallets are actually smart, measured from our own stream: FIFO cost basis, Wilson-bounded win rate, early-hit rate, ring and wash exclusion |
| Gates | `src/autoape/gates/` | the hard refusals and the soft ones, by aggression level |
| Sizing | `src/velocity/core/risk.mjs` | fractional Kelly inside an immutable envelope; bankroll from the wallet itself |
| Plans and exits | `src/velocity/core/plans.mjs`, `exits.mjs` | the plan is fixed at entry; three exit layers fire in order |
| Governor | `src/velocity/core/governor.mjs` | blind spots, tilt, regime; a smooth daily taper rather than a cliff |
| Learner | `src/velocity/core/learner.mjs` | bounded retraining on realized outcomes, with rules it may never invert |
| Routers | `src/velocity/venues/*/router.mjs` | the only code that spends money; paper and live share one interface |
| Callouts | `src/velocity/core/callouts.mjs` | the public record, hashed into the ledger before it is posted |
| Hub | `src/velocity/hub.mjs` | one engine per user, the fee, the wallet paths, the halt |
| API | `src/api/server.production.mjs` | HTTP and WebSocket; the radar; the activity gate |
| Frontend | `app/` | React and Vite, English and Simplified Chinese |

## Storage

Redis holds users, tiers and custodial wallet keys — sealed with AES-256-GCM under
`WALLET_ENCRYPTION_KEY`, with no TTL, because a key that expires is a wallet that becomes
unrecoverable. The per-user ledgers and state live on disk under `VELOCITY_DATA_DIR`, which must be a
mounted volume in production; a container filesystem is wiped on every deploy and the ledger is the
record of every user's trades.

## The activity gate

Every feed, stream and poller registers with one gate that knows how many bots are running. With
nobody trading, nothing outside is polled: no RPC calls on three chains, no trade stream, no price
feeds. The gate opens on the first bot and closes a grace period after the last one stops, so a user
who stops and restarts does not pay the cold start twice.

## What runs where

```
Vercel            Railway                           chains
(frontend)        (API + Redis + the engines)
   │                   │                               │
   │  bondli.fun       │  api                          │
   ├── REST / WS ─────►├── RPC ───────────────────────►│  Solana · Robinhood Chain · Arc
   │  React SPA        │  Express + ws                 │
   │  static, CDN      │  Redis (users, sealed keys)   │
   │                   │  volume (ledgers, state)      │
```

Deployment specifics are in [../deploy/HOSTED_VELOCITY.md](../deploy/HOSTED_VELOCITY.md). The design
pass that produced the hosted service — givens, functional requirements, design parameters and the
matrix — is in [../src/velocity/HOSTED_DESIGN.md](../src/velocity/HOSTED_DESIGN.md).
