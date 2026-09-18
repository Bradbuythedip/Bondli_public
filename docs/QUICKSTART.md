# Quick start

Node 20 or newer.

```bash
git clone https://github.com/Bradbuythedip/Bondli_public.git
cd Bondli_public
npm install && npm install --prefix app
npm test
```

The suite runs offline: every chain it touches is a fake built inside the test file, so no RPC, API
key or funded wallet is needed to run it or to read it. That is the fastest way to see what the
engine actually promises — the test names are written as sentences.

## Run the stack

```bash
cp .env.example .env
npm run dev          # API on :3001, frontend on :5173
```

Nothing in `.env` is required to boot. Every integration is inert until its key is set, and each one
says so at startup rather than failing later: with no `PUMPPORTAL_API_KEY` the radar decodes
pump.fun trades from Solana program logs for free, with no `ARC_RPC_URL` the Arc feed stays off, and
with no `WALLET_ENCRYPTION_KEY` a development box still works while production refuses to create
custodial wallets at all.

## The environment, by what it is for

Full commentary lives in [`.env.example`](../.env.example); this is the map.

### Reading the chains

| Variable | Why |
|---|---|
| `ALCHEMY_API_KEY` | Solana RPC; also enables enhanced wallet reads. `RPC_URL` overrides it |
| `RADAR_TRADE_SOURCE` | `onchain` (default, free) decodes pump.fun trades from program logs; `auto` uses PumpPortal's metered stream and falls back |
| `PUMPPORTAL_API_KEY` | only for the metered stream; the keyed socket bills per event |
| `RADAR_STREAM_RPC_URL` | the websocket carrying the on-chain trade stream, if the public one drops |
| `VELOCITY_PONS`, `PONS_RPC_URL`, `PONS_POLL_MS` | Robinhood Chain (PONS) |
| `VELOCITY_ARC`, `ARC_RPC_URL`, `ARC_POLL_MS` | Arc (Argus). Use your own endpoint: the free one throttles transaction submission |

### Holding money

| Variable | Why |
|---|---|
| `WALLET_ENCRYPTION_KEY` | 64 hex characters. Seals every custodial key at rest. Production refuses to create wallets without it |
| `JWT_SECRET` | 64 hex characters. Signs the wallet sign-in tokens; changing it signs everyone out |
| `PLATFORM_WALLET` | where SOL performance fees go. **Create a fresh wallet for it.** The address this project shipped with is accepted rather than refused, so an operator is never silently cut off from their own fees, but it warns at every boot and its key is not one to trust |
| `PLATFORM_EVM_WALLET` | where ETH (Robinhood Chain) and USDC (Arc) fees go |
| `MASTER_SEED` | the operator wallet that funds sub-wallets |

Generate the two secrets with `npm run generate:secrets`.

### Running the hosted service

| Variable | Why |
|---|---|
| `VELOCITY_HOSTED=1` | mount `/api/velocity/*` and run one engine per user off the shared feeds |
| `VELOCITY_DATA_DIR` | per-user ledgers and state. **Put this on a mounted volume**: a container filesystem is wiped on deploy and the ledger is the record of every user's trades |
| `REDIS_URL` | users, tiers, sealed keys |
| `ADMIN_SECRET` | enables the admin routes. Unset means no override exists at all, which is safer |
| `ACTIVITY_GRACE_MIN`, `ALWAYS_ON` | how long the feeds stay hot after the last bot stops |

### Optional

`ALERT_WEBHOOK_URL` for operator alerts (Slack, Discord or ntfy — one URL, any of the three).
`CALLOUT_WEBHOOK_URL`, `CALLOUT_TG_TOKEN`, `CALLOUT_TG_CHAT_ID`, `CALLOUT_MIN_TIER` to publish
callouts to a channel; without them the public record still shows on the site.
`X_BEARER_TOKEN` and `X_DAILY_BUDGET` for social verification. `BAGS_API_KEY` and
`BAGS_PARTNER_WALLET` for Bags.fm. `MIN_STAKE_USD`, `BUY_SLIPPAGE`, `SELL_SLIPPAGE`,
`PRIORITY_FEE_SOL` and `VELOCITY_FEE_PCT` to move the defaults the sizer and routers use.

## Scripts

| Script | What it does |
|---|---|
| `npm test` | the whole suite |
| `npm run dev` | API and frontend together |
| `npm start` | the production server |
| `npm run build` | build the frontend |
| `npm run velocity` | the standalone single-tenant CLI (see [`src/velocity/README.md`](../src/velocity/README.md)) |
| `npm run scan` | the rug scanner, standalone |
| `npm run generate:secrets` | print fresh values for the secrets above |
| `npm run deploy:*` | the Docker deployment path in [`deploy/`](../deploy) |

## The standalone CLI

The hosted service is one way to run the engine. The other is single-tenant, from a terminal, with
one risk file:

```bash
cp src/velocity/config/risk.example.json risk.json
npm run velocity -- validate    # prints the worst day you are agreeing to
npm run velocity -- start       # paper by default
npm run velocity -- status
npm run velocity -- why last    # the trail of the last decision
npm run velocity -- halt flatten
```

Before enabling any venue, check that you are eligible to trade on it where you live. The bot never
circumvents geographic or identity controls.

## Deploying

[`deploy/HOSTED_VELOCITY.md`](../deploy/HOSTED_VELOCITY.md) is the checklist: secrets, the persistent
volume, the frontend build and a one-wallet smoke test. The short version is that the volume is not
optional and `PLATFORM_WALLET` must be a wallet you freshly created.
