# Velocity Trader

Autonomous multi-venue trading core built on bondli (scorer, gates, exits,
execution) and the BRAD bridge (blind-spot governor). Design, requirements,
design matrix and interaction spec: `BRAD/prompts/VELOCITY_TRADER_ONESHOT.md`.

Two venues in the first release: pump.fun (the fast side, through bondli's
radar) and Polymarket (the accurate side: resolved facts and negative-risk
consistency). Perps and equities are disabled adapter stubs.

Excluded by constraint: bondli's fleet wallets, wash volume and anti-detection
modules. Nothing here manufactures volume or poses as retail.

## Operator flow

```
cp src/velocity/config/risk.example.json risk.json     # E1: the only place capital is set
npm run velocity -- validate                             # prints the worst day you are agreeing to
npm run velocity -- start                                # E3: paper by default, control on 127.0.0.1:3210
npm run velocity -- status                               # E5: one screen (also http://127.0.0.1:3210/)
npm run velocity -- why last                             # E6: the trail of the last decision
npm run velocity -- halt freeze | flatten                # E4: kill switch (falls back to a HALT file)
npm run velocity -- resume pumpfun                       # a halt is never lifted automatically
npm run velocity -- promote polymarket                   # E7: paper-to-live checklist
npm run velocity -- venue polymarket live                # refused until the gate is green
```

Before enabling any venue, verify you are eligible to trade on it where you
live. The bot never circumvents geo or KYC controls.

## Files

```
src/velocity/
  index.mjs                CLI
  config/risk.example.json risk envelope template (USD, immutable at runtime)
  core/
    events.mjs             MarketEvent schema, latency histogram          (DP1 contract)
    feed.mjs, replay.mjs   feed base, scripted feed, capture and replay   (DP1)
    pipeline.mjs           venue-agnostic gate runner                     (DP2)
    plans.mjs              static exit plan table                         (DP2/DP5)
    risk.mjs               envelope loader, validator, fractional Kelly   (DP3)
    router.mjs             router interface, paper router with unwind    (DP4)
    exits.mjs              plans at entry, layered exit monitor           (DP5)
    ledger.mjs, store.mjs  append-only JSONL ledger, atomic snapshot      (DP6)
    governor.mjs           blind spots, tilt, regime -> throttle/halt     (DP7)
    learner.mjs            bounded retrain, sacred inversions, checksums  (DP8)
    supervisor.mjs         heartbeat, watchdogs, HALT file, dead-man      (DP9)
    engine.mjs             wiring, entries, exits, reconciliation
    promote.mjs, stats.mjs promotion gate, realized statistics
    server.mjs, alerts.mjs control server, alerts
    build.mjs              engine from velocity.config.json
  venues/
    pumpfun/    feed (bondli /api/radar/scored), edge (bondli gates), router (curve model, live via smartSend)
    polymarket/ feed (Gamma + CLOB WS + fact sources), edge (resolved_fact, consistency), router (book walk, live via clob-client)
    perps/      stub, disabled
tests/velocity/  T1..T9 (node --test)
```

## Runtime files (data/velocity)

`ledger.jsonl` every decision, order stage, fill, exit, outcome, halt, governor
verdict and alert, with reasons, fsynced. `state.json` the current picture,
written atomically. `paper-book-<venue>.json` the paper venue's truth for
reconciliation. `weights/` every learner version. `heartbeat`, `HALT`.

## Config

`velocity.config.json` (all optional, defaults shown in `core/build.mjs`):

```json
{
  "dataDir": "./data/velocity",
  "riskFile": "./risk.json",
  "host": "127.0.0.1", "port": 3210,
  "alerts": { "webhook": null },
  "venues": {
    "pumpfun":    { "mode": "paper", "bondliUrl": "http://127.0.0.1:3001", "minScore": 25, "pollMs": 2000, "tickMs": 1000, "pumpportal": false, "aggression": 1 },
    "polymarket": { "mode": "paper", "maxMarkets": 150, "minLiquidity": 1000,
                    "factSources": [{ "type": "file", "path": "./data/velocity/facts.json", "source": "manual", "confidence": 0.95 }] },
    "perps":      { "mode": "off" }
  }
}
```

pump.fun needs bondli's server running (it exposes `GET /api/radar/scored`).
Trades reach bondli's radar in one of two ways, set by `RADAR_TRADE_SOURCE` in
`.env`: `onchain` decodes pump.fun trades from the Solana program logs for free
(default when no key is set, recommended), or PumpPortal's keyed stream, which
is metered at about 0.01 SOL per 10,000 events and refuses without a funded key.
Leave the feed's `pumpportal` option off: bondli's scored endpoint already carries
the trades, and a second keyed connection would be billed too.
Polymarket facts come from sources you name; a file source is a JSON array of
`{ "conditionId", "outcome", "source", "confidence", "t_fact" }`. The edge only
acts when the market's own rules name the same source.

Live pump.fun needs `MASTER_SEED` and an RPC. Live Polymarket needs
`POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER` and the packages
`@polymarket/clob-client` and `ethers`. On-chain redemption of resolved
Polymarket positions is not automated in live mode; paper mode models it.

### Aggression

`venues.pumpfun.aggression` is the risk dial, one knob for all three gates: 0 safe, 1 as designed,
2 normal, 3 degen (`AGGRESSION` in venues/pumpfun/edge.mjs). Gate 2/3: the score floor, the
speculative-tier floor, the sybil and fresh-wallet limits, how far along the bonding curve an entry is
allowed, the price-spike rule, whether decelerating buys or an unstable score block an entry, and
whether a watchlist token is taken as a speculative entry (2 and 3). Gate 1, from 2 up: the coordinated
dump threshold, how old a token can be (15 / 30 / 60 min), how far along the curve is too late
(80 / 90 / 95%), and the holder-concentration limit (70 / 80 / 90%). The hard rug rules (dev selling,
self-snipe, sybil, pump-and-dump, freeze authority, serial ruggers) never move. Read at start; restart
after changing it.

### Robinhood Chain (PONS)

A second curve venue, `pons`: PONS V2 launches on Robinhood Chain (chain 4663, ETH quote). The feed
(`venues/pons/feed.mjs`) polls the chain's logs for `TokenLaunched` on the factory and `CurveBuy` /
`CurveSell` / `CurveCompleted` on every curve it has seen, keeps the same per-token state the pump.fun
radar keeps, scores it with the same composite, and emits candidates with the same payload shape. The
same gates, sizer, plans and exits judge it; `reference.solPrice` on this venue is the ETH price and
`sol_spent` / `sol_received` are ETH. Two venue-specific rules: nothing is a candidate inside the
60-second snipe-tax window (the factory can tax early buys at up to 99%), and curve progress comes
from `token._curvePct` (real quote reserve over the graduation threshold), not from "vSol / 85".
The live router (`venues/pons/router.mjs`) is an ethers wallet: `buy(quoteIn, minTokensOut, to)`
with ETH value, `approve` + `sell(tokensIn, minQuoteOut, to)`, fills read from the receipt's curve
log, gas counted in the quote spent. Hosted users get an ETH key beside their SOL key; the bot trades
PONS when the ETH wallet holds more than 0.003 and the user leaves the chain on.

### Revivals

The launch feed only sees the first hour. The radar also keeps a 72-hour window of 5-minute buckets
per mint (distinct buyers, net SOL, curve progress) and fires a **revival** when a token older than
an hour is flat for an hour and then gets 5-minute distinct buyers at 3x the prior hour's pace with
SOL flowing in and the curve up 5+ points (`src/api/revival.mjs`). A firing signal still has to pass
the filter (dev not selling into it, buyers not from one source, a graduated token needs a pool
with real liquidity, never Mayhem or a copy). Survivors reach the same judge as model
`bondli_revival`: every rug rule applies, the age rules do not, the tier is always speculative, the
plan is `revival` (8% stop, 6-minute hold), and the stake is capped at half of `per_trade_max_usd`.

### Bankroll from the wallet

`"bankroll_source": "wallet"` in risk.json makes the live wallet the bankroll: free SOL (less
`wallet_reserve_sol`, default 0.02, kept for fees and rent) at the radar's SOL price, plus what is
already open, is the equity fractional Kelly sizes from. The reading is refreshed after every live
fill and every 30s; with no fresh reading (5 min) or no SOL price nothing is sized (`WALLET_UNKNOWN`,
`NO_SOL_PRICE`), never guessed. Paper venues keep `bankroll_usd`. The absolute caps (per trade,
portfolio, daily loss) still apply unchanged. `velocity status` shows the wallet and equity.

## Deviations from the design doc

Two, both in the direction of fewer parts: the risk file is JSON, not YAML
(no parser dependency); live state is one atomically written JSON snapshot,
not Redis (no service dependency). Same requirements, same tests.
