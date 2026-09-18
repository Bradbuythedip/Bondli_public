# The Bondli HTTP API

Base URL: `https://bondli.fun` in production, `http://localhost:3001` in development.

Everything is JSON. There are three kinds of route, and the difference matters:

| Kind | Guard | Who may call it |
|---|---|---|
| **Public** | none | anyone; no wallet appears in any response |
| **Owner** | `requireOwner` | only the wallet that signed in, and only for its own wallet |
| **Admin** | `requireAdmin` | only a caller holding `ADMIN_SECRET` |

`requireOwner` is not decoration. It is the first axiom of the system: no route may move money or
read a key without a signature from the wallet it acts on. `tests/api/t15-route-guards.test.mjs`
walks the server source and fails the build if any route that loads a trading wallet is missing it.

---

## Signing in

Wallet-signature auth, no passwords and no accounts.

```http
POST /api/auth/challenge      { "wallet": "<solana pubkey>" }
  -> { "nonce": "...", "message": "..." }

POST /api/auth/verify         { "wallet": "...", "signature": "<base58>", "nonce": "..." }
  -> { "token": "<JWT>", "wallet": "..." }
```

Sign the returned `message` with the wallet (Phantom's `signMessage`), post the signature back, and
use the token as `Authorization: Bearer <JWT>` on every owner route. The token carries the wallet it
was issued to; a request that names a different wallet is refused with 403, not 401 — you are signed
in, just not as that person.

---

## Public data

No authentication, no wallet in any response, safe to poll.

| Route | What it returns |
|---|---|
| `GET /api/callouts?limit=50` | the public track record: each published call with its token, the market cap paid, the declared plan, the transaction, the result if it has closed, and the `sha256` hash written before the call was posted |
| `GET /api/velocity/pulse` | how many bots are trading right now and how many positions closed today, aggregated across every user |
| `GET /api/arc/stats` | Argus launches on Arc as the feed sees them: per-hour and per-day counts, bonded rate, the tax terms creators choose, first-hour buyers and volume, and the last 50 launches |
| `GET /api/radar/live?limit=30` | the newest launches across every venue with the one word the bot has for each: `mayhem`, `copy`, `rug`, `hot` or `watching` |
| `GET /api/radar/scored` | the full scored radar: features, score, rug flags, curve progress |
| `GET /api/activity` | whether the outside world is being polled at all, and why |
| `GET /api/smart-money/status` | the wallet-intelligence aggregate — counts and coverage, never the wallet list |
| `GET /api/sol-price` | the SOL price the engine is using, and when it was read |
| `GET /api/movers` · `GET /api/graduated` · `GET /api/resurgence` | historical movers, graduations, and revival candidates |
| `GET /api/intel/*` | read-only analytics: scores, artwork forensics, dev-wallet profiles, survivor matching, demand authenticity |
| `GET /health` | liveness |

### The callout record

```jsonc
{
  "ok": true,
  "calls": [
    {
      "id": "...", "ts": 1758200000000,
      "venue": "arc", "instrument": "0x…", "name": "…", "ticker": "…",
      "mcapUsd": 41200, "tier": 2,
      "tx": "0x…", "txUrl": "https://explorer.arc.io/tx/0x…",
      "plan": { "label": "runner", "stop_pct": 12, "target_pct": 60, "max_hold_ms": 480000 },
      "result": { "pnl_pct": -8.2, "held_ms": 214000, "reason": "stop_loss" },
      "hash": "9f2c…"
    }
  ],
  "record": { "posted": 128, "resolved": 119, "wins": 41, "winRate": 0.344 },
  "minTier": 2
}
```

`hash` is `sha256(venue|instrument|tx|ts|mcapUsd|tier|plan)`, written to the ledger **before** the
call was posted anywhere. Recompute it from the row to check that the row was not edited afterwards.
Losing calls are in this feed on the same terms as winning ones; paper trades never appear.

### Why `/api/arc/stats` can be empty

Every feed, stream and poller in the server follows one activity gate: nothing outside is polled
unless at least one bot is running, plus a grace period. With no bot running, this route answers
`{ ok: true, enabled: true, live: false, … }` rather than pretending to data it did not fetch. Set
`ALWAYS_ON=1` to keep the feeds hot.

---

## Running a bot

All owner routes. `wallet` is the signed-in wallet; the JWT must match it.

| Route | What it does |
|---|---|
| `POST /api/velocity/start` | start the engine with a risk envelope: aggression, per-trade cap, concurrent positions, daily loss stop, which venues are on, paper or live |
| `POST /api/velocity/stop` | stop it |
| `POST /api/velocity/pause` · `/resume` | freeze entries without touching exits |
| `POST /api/velocity/halt` | **sell all and stop** — flattens every venue in one action |
| `GET /api/velocity/status` | positions, P&L, the day's ledger, the last decisions in the bot's own words |
| `GET /api/velocity/holdings` · `GET /api/velocity/sweep` | what the wallet holds, including tokens the engine has released |
| `POST /api/velocity/sell` · `/close` · `/release` | sell a position, close it, or let go of one the venue will never accept a sell for |
| `POST /api/velocity/clear-error` · `/ack-daily-limit` | acknowledge a condition the panel is showing |
| `GET /api/velocity/health` | the hub: how many engines, whether the fee wallet is configured, each feed's state |

A stop is never partial. A position the venue refuses to sell is *released* rather than held, so the
halt completes instead of hanging on it.

## The trading wallet

All owner routes.

| Route | What it does |
|---|---|
| `POST /api/trading-wallet/create` | generate the custodial trading wallet, sealed at rest with AES-256-GCM |
| `GET /api/trading-wallet/:wallet` | balances, on Solana and on the EVM chains |
| `POST /api/trading-wallet/withdraw` | move funds back out |
| `POST /api/trading-wallet/export` | hand over the private key — to the owner, after a signature, and to nobody else |
| `POST /api/trading-wallet/import` | bring your own key |

Keys are stored with no expiry (`keepForever`); the filesystem is treated as ephemeral and Redis as
the record. Creating a custodial wallet in production is refused outright when
`WALLET_ENCRYPTION_KEY` is unset, rather than silently storing a key in plaintext.

---

## Admin

`requireAdmin` reads `X-Admin-Secret` from the header only — never from a query string, where it
would land in access logs and shared links. With `ADMIN_SECRET` unset there is no override at all,
which is the safer default.

| Route | What it does |
|---|---|
| `GET /api/admin/stats` · `/users` | operational counts |
| `POST /api/admin/whitelist` · `/unwhitelist` | tier overrides |
| `POST /api/launch` | update the launch banner the site polls |
| `GET /api/smart-money/top` | the ranked wallet list |
| `GET /api/fleet*` · `POST /api/close` · `POST /api/fleet/wallet-sell` | the legacy multi-wallet surface |

The smart-money **list** is deliberately not public while the **aggregate** is. A published list of
the wallets a bot follows is bait for those wallets — buy, be copied, sell into the copiers — and a
free signal for every other bot.

---

## Errors

| Status | Meaning |
|---|---|
| 400 | the request is missing something; the body names it |
| 401 | no valid token — sign in with the wallet first |
| 403 | signed in, but not as the wallet this route acts on; or a bad admin secret |
| 404 | no such token, session or position |
| 409 | refused because a bot is running on this wallet — stop it first |
| 503 | an integration this route needs has no key configured |

Error bodies are `{ "error": "<human sentence>" }`. RPC error text is scrubbed before it reaches any
public route: an upstream error can quote the URL it called, and that URL can carry an API key.

---

## Legacy surface

The server still mounts routes from earlier versions of the product — `/api/session/*`,
`/api/auto-trade/*`, `/api/sim/*`, `/api/access/*`, `/api/vip/*`, `/api/incinerator/*` and the
`/api/brad/*` cognitive sidecar. The shipped frontend calls none of them. They are guarded the same
way everything else is (`requireOwner` on anything touching a key, `requireAdmin` on the fleet
routes), and they are documented here only so that a reader of the route table is not surprised by
them.
