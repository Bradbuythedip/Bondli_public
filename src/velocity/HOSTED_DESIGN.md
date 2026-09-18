# Hosted velocity on bondli.fun, with a performance fee

Axiomatic design pass before code. Givens, then functional requirements, design parameters, the
matrix, what had to be decoupled, and the phases.

## Givens

- bondli.fun exists: React app on Vercel, Express API on Railway with Redis, per-user *trading
  wallets* whose keys the server generates and holds (custodial), an auto-ape UI already wired to
  `/api/auto-trade/*`, a fee engine (`src/engine/fee-engine.mjs`) carrying an older free/pro/vip
  ladder that the hosted trader no longer consults (it keeps only the owner check and the stats), and
  wallet-signature auth middleware (`src/middleware/wallet-auth.mjs`) that no route uses yet.
- velocity works single-tenant: one key from `.env`, one `risk.json`, one `data/velocity` directory.
  Reconciled to the lamport against the chain on 2026-09-10 (tools/tx-audit.mjs).
- Two defects in the existing site that hosted money makes worse: trading-wallet secrets sit in
  Redis in plaintext and `/api/trading-wallet/export` returns them to anyone who posts the user's
  public key; the auto-trade start/stop/update routes accept a bare `wallet` field with no proof of
  ownership. Railway's disk is ephemeral unless a volume is attached; velocity's ledger is a file.

## Functional requirements

| FR | statement |
|---|---|
| FR1 | A signed-in bondli.fun user can start and stop velocity on their own trading wallet from the site, and nobody else can. |
| FR2 | Each user's bot is isolated: its own wallet, risk envelope, ledger, positions, and halt state. |
| FR3 | The platform takes a fee only from realized profit, per closed position, never from a loss, and the fee is visible in the user's ledger and on the page. |
| FR4 | Keys at rest are unreadable without a server-side secret; the site never hands a key to anyone who has not proved ownership of the wallet it belongs to. |
| FR5 | A user sees what their bot is doing live (decisions, orders, fills, exits, P&L) and can kill it in one click. |
| FR6 | The hosted service costs one radar and one trade stream, however many users run bots. |

## Design parameters

| DP | what |
|---|---|
| DP1 | `requireOwner` middleware: Bearer JWT from `/api/auth/verify` (Phantom `signMessage` of a server nonce), and the token's wallet must equal the wallet the request acts on. Applied to every route that reads a key, moves money, or starts a trader. |
| DP2 | `VelocityHub`: one `PumpfunFeed` shared by N `Engine` instances; each engine has `dataDir = data/velocity/users/<wallet>`, a risk envelope built from `risk.example.json` with the user's bankroll source (`wallet`), aggression, and caps, and a `PumpfunLiveRouter` given the decrypted trading-wallet secret directly (never through `process.env`). |
| DP3 | Fee at the final close of a position: one flat rate on realized profit (`DEFAULT_FEE_PCT`, 5%), owner exempt, dust exempt, and **zero for anyone holding the house token** (`HolderWaiver`, checked against the user's Robinhood Chain wallet). There are no tiers: hold it or do not. Paid by a transfer from the user's trading wallet to `PLATFORM_WALLET` (ETH to `PLATFORM_EVM_WALLET` on PONS), recorded as `kind: "fee", scope: "platform"` in the user's ledger with the transfer signature; a waived fee is recorded too, with what it would have been. Partial exits accumulate `sol_received`; the fee is computed once, on the realized total. |
| DP4 | `keyvault.mjs`: AES-256-GCM with `WALLET_ENCRYPTION_KEY`; `saveTradingWallet` seals, `getTradingWallet` opens, plaintext records migrate on first read. Without the key in production, wallet creation refuses. |
| DP5 | `/api/velocity/status` returns the engine's `status()` plus the last decisions; `/api/velocity/decisions` streams the narration (`formatRecord`); `/api/velocity/halt` calls `halt("flatten")`. The panel is the existing auto-ape panel's shape with velocity's vocabulary. |
| DP6 | The bondli server's radar is already the feed; the hub reads it in-process (no HTTP hop) through the same `parseScoredResponse` shape. |

## Design matrix

```
            DP1 auth  DP2 hub  DP3 fee  DP4 vault  DP5 UI  DP6 feed
FR1 start    X         X
FR2 isolate            X                 X
FR3 fee                X        X
FR4 keys     X                           X
FR5 see                X                            X
FR6 one feed           X                                     X
```

Lower-triangular after ordering: auth and the vault come first (they gate everything), the hub
depends on both, the fee and the UI depend on the hub, the feed is shared by construction. The one
coupling worth naming: DP3 (fee) and DP2 (hub) both touch the position's SOL accounting. Resolved by
having the router record `sol_spent` / `sol_received` on every fill (done) and the fee read only
those two numbers at close. The fee never reads the USD figures, which depend on a price feed.

## Information axiom

The fee rule with the fewest ways to be wrong: fee on realized SOL profit of one closed position,
computed from on-chain measured amounts, paid once, from the same wallet that earned it, to one
configured address, refused when that address is the default (the default is a wallet whose key has
been exposed). Everything else in the fee engine (ladders, streaks, referral splits) is applied
through `calculateFee` unchanged so the site's existing economics carry over.

## Decisions taken as given (change one env var to change them)

- Fee rates: the existing fee engine's, i.e. `FREE_PROFIT_CUT` (25%, ladder down to 2%) for free
  tier and `NETWORK_FEE_PCT` (2%) for Pro/VIP. The velocity fee is shown, not hidden, whatever the
  tier.
- Who may run velocity: anyone with a trading wallet. The 5% fee on profit is the only price of admission; there is no tier gate.
- Minimum stake $5, per-trade cap and daily-loss cap from the risk template, bankroll from the
  wallet's free SOL.

## Phases

0. Auth on money routes and keys sealed at rest. Prerequisite; ships alone.
1. Hub, routes, fee. Behind a feature flag (`VELOCITY_HOSTED=1`) until the panel exists.
2. Panel in the app.
3. Deploy: Railway volume at `data/`, env, Vercel build, smoke test with one wallet.
