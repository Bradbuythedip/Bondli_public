# Hosted Velocity on bondli.fun — deploy checklist

Design: `src/velocity/HOSTED_DESIGN.md`. Backend on Railway, frontend on Vercel. Setup and the full
environment are in `docs/QUICKSTART.md`.

## 1. Secrets (generate locally, paste into Railway → Variables)

```bash
node -e "const c=require('crypto');console.log('WALLET_ENCRYPTION_KEY='+c.randomBytes(32).toString('hex'));console.log('JWT_SECRET='+c.randomBytes(32).toString('hex'))"
```

| variable | value | why |
|---|---|---|
| `WALLET_ENCRYPTION_KEY` | 64 hex chars from above | seals every trading-wallet key in Redis; without it production refuses to create wallets |
| `JWT_SECRET` | 64 hex chars from above | signs the 7-day sign-in tokens; changing it signs everyone out |
| `PLATFORM_WALLET` | a **fresh** wallet's public key | where performance fees go. The shipped default is accepted with a loud warning at every boot rather than refused — so a misconfiguration never silently stops your fees — but it must be replaced |
| `VELOCITY_HOSTED` | `1` | mounts `/api/velocity/*` and starts the shared radar feed |
| `VELOCITY_DATA_DIR` | `/app/data/velocity/users` | per-user ledgers and state; must be on the volume below |
| `RPC_URL` | your Alchemy/Helius mainnet URL | signing, balances, confirmations |
| `RADAR_TRADE_SOURCE` | `onchain` | free trade stream; `RADAR_STREAM_RPC_URL` to a Helius endpoint if the public one drops |
| `REDIS_URL` | from the Railway Redis plugin | users, wallets (sealed), tiers |

| `VELOCITY_PONS` | `1` | Robinhood Chain (PONS launchpad) feed beside pump.fun; `0` to turn it off |
| `PONS_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` or a QuickNode/dRPC endpoint | the public RPC is rate-limited; a paid one for production |
| `PLATFORM_EVM_WALLET` | a **fresh** 0x address you control | where ETH performance fees go; unset means PONS profits are not charged |

Keep `NETWORK_FEE_PCT` / `FREE_PROFIT_CUT` as they are unless you want different fee rates; velocity uses the same `calculateFee` as the rest of the site.

## 2. Persistent disk (required)

Railway's filesystem is wiped on every deploy. Velocity's ledger is the record of every user's trades and the source of truth for reconciliation after a restart.

1. Railway → your backend service → **Volumes** → **Add Volume**, mount path `/app/data`.
2. Set `VELOCITY_DATA_DIR=/app/data/velocity/users` (above).
3. Redeploy. Confirm with `GET /api/velocity/health` → `{ ok: true, users: 0, feeConfigured: true, feed: {...} }`.

`feeConfigured: false` means `PLATFORM_WALLET` is unset or is the exposed default; the bot trades but collects nothing until that is fixed.

## 3. Frontend (Vercel)

`app/src/lib/constants.js` already points at the Railway API. Push the branch; Vercel builds `app/`. The Velocity panel appears under Auto-Ape on the wallet page for any connected wallet with a trading wallet.

Update `PLATFORM_WALLET` in `app/src/lib/constants.js` to the same fresh wallet (it is shown to users on payment screens).

## 4. Smoke test with one wallet

1. Connect Phantom → Create trading wallet → the first sensitive call asks Phantom to sign a message (sign-in). Fund the trading wallet with ~0.5 SOL.
2. Velocity → set Aggression 2, Per trade $10, Open at once 4, Daily loss stop $15 → START. Expect the panel to show the wallet balance and `watching the radar…`, then reject lines with reasons.
3. Watch for `FILLED`, `SOLD`, `P&L`. On the first profitable close a `fee` line appears with the transfer signature; the same amount lands in `PLATFORM_WALLET`.
4. SELL ALL & STOP → positions sold, engine gone from `/api/velocity/health`.
5. Redeploy (or restart) with a position open: on boot the hub is empty (users must press START again); the volume keeps their ledger, and reconcile on the next start adopts what the wallet holds.

## 5. What is still single-tenant by design

- One radar, one trade stream, one SOL price for everyone: `FR6`.
- Engines live in the API process. Beyond a few dozen concurrent users move the hub to its own Railway service that reads `/api/radar/scored` over HTTP (the feed already supports it; drop the in-process `fetchImpl`).
- Users must press START after a backend deploy. A restore-on-boot from Redis (`velocity:running` set) is the next step if that becomes a complaint.
