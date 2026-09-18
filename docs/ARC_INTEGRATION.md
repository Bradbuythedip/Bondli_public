# Bondli on Arc: the USDC-native venue

Arc is Circle's EVM L1. Its gas asset is USDC, and Argus is its launchpad. Bondli
trades Argus launches in their first minutes with the same engine it runs on pump.fun and on
Robinhood Chain — but with one difference that changes the accounting everywhere: **the quote asset
is the dollar itself.**

On every other venue there is a price feed between the trade and the money. A stake is SOL or ETH,
read from an exchange, stale by a minute, absent in an outage. That feed is a whole class of loss
before any trade goes wrong, and it makes an honest record hard to keep: the same position is worth
two different numbers depending on when you asked.

On Arc there is nothing to ask. The pool is quoted in USDC, gas is USDC, the stake is USDC, the mark
is USDC, the profit is USDC and the platform's fee leaves in USDC. `solPrice` on the Arc venue is the
constant `1` — the field keeps the engine's name because the engine reads it by that name on every
venue, and on this one it is not a price, it is an identity.

That is axiom 11 in [`docs/AXIOMS.md`](AXIOMS.md), and `tests/velocity/t22-arc-feed.test.mjs` holds it.

**The chain id is `5042`, and we do not treat that as settled.** It is the figure Argus's own
documents give; third-party Arc documentation reports `5042002`. Rather than pick one and hope, the
router asks the node: `preflight()` sends `eth_chainId` and refuses to go live against an RPC that
answers for anything else, so a wrong constant costs a refusal at start-up instead of a transaction
signed for the wrong chain.

---

## The shape of the integration

```
  Argus Portals (7)                    Uniswap v4                   the engine
  ─────────────────                    ──────────                   ──────────
  TokenCreated    ─┐
  PartsDeployed    ├─► ArcFeed ──► pool id, sqrtPriceX96 ──► MarketEvent ─┐
  CurveOpened     ─┘      │        StateView.getLiquidity                 │
                          │        LaunchHook: taxes, launchedAt          ├─► the same gates,
  PoolManager.Swap ───────┘        position reserves, progress            │   sizer, plans and
                                                                          │   exits as pump.fun
  UniversalRouter ◄── ArcLiveRouter ◄── order ◄─────────────────────────┘
       │   Permit2
       └─► v4 swap: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
```

Three files, plus one published package:

| What | Where | Lines |
|---|---|---|
| The chain layer, as a standalone package | [`packages/arc-argus/`](../packages/arc-argus/) | 490 |
| The launch and swap feed | `src/velocity/venues/arc/feed.mjs` | 566 |
| The live router and the paper model | `src/velocity/venues/arc/router.mjs` | 622 |
| The in-repo re-export, so the venue and the package never drift | `src/velocity/venues/arc/chain.mjs` | 4 |

`@bondli/arc-argus` is packaged to stand on its own, and we know of no other Argus indexer or
pool-math library. It is not on npm yet — publishing 1.0 is milestone 1 of the grant — so today it
is installed from this repository. It is pure functions over `ethers`, and nothing in the module
touches the network, so an indexer, a dashboard or another trading client can use it without taking
Bondli's engine. The feed and the router here are its worked example.

---

## One balance, two faces

Arc's gas asset is USDC, and USDC appears on the chain twice:

| Face | Address | Decimals | Used for |
|---|---|---|---|
| Native | — (`msg.value`, `getBalance`) | 18 | gas, the wallet's balance, the platform fee transfer |
| ERC-20 | `0x3600000000000000000000000000000000000000` | 6 | the pool's currency, Permit2 pulls, swap amounts |

They are **one balance**. Moving one moves the other. Getting the face wrong is not a rounding error,
it is a factor of 10^12, so the two are never converted ad hoc: `toUsdc`, `toUsdcUnits` and
`toNativeUsdc` in the package are the only places the decimals are named.

The router reads the native face in `preflight()` (one call, no contract), pays the swap through the
ERC-20 face, and sends the fee as a native transfer. `tests/velocity/t23-arc-router.test.mjs` asserts
each of those three separately.

---

## What is pinned to a published source, and what is not

This is the part a reviewer should read first, because it is the part that could be wrong.

**Pinned.** The Portal addresses, the three launch events (`TokenCreated`, `PartsDeployed`,
`CurveOpened`), their `topic0`, and the layout of the `launches(token)` record for each Portal
version come from Argus's own `onchain/addresses.md`, `onchain/event-signatures.md` and
`onchain/launch-record-layout.md`. The `PoolManager` and `StateView` ABIs are Uniswap v4's. Every
topic is asserted to equal the keccak of the signature as written here, and `TokenCreated` and `Swap`
are additionally pinned to the `topic0` Argus and Uniswap publish (`t20-arc-chain`). So a typo in a
signature cannot survive a test run, and for the two topics with a published constant, neither can a
wrong signature.

**Not pinned.** The `LaunchHook` interface — its getters, the `Bonded` and `TaxCollected` events, and
the snipe-tax formula — comes from the reference `contracts/LaunchHook.sol` in Argus's repository,
which describes itself as a simplification of the deployed hook. The deployed bytecode could not be
read from the build environment.

So everything built on the hook **fails closed**, and costs trades rather than money:

- a hook whose getters do not answer keeps its launch out of the feed entirely — never a candidate;
- an unknown launch time or an unknown tax is priced at the 99% cap, not as free;
- every swap is dry-run against the node before it is sent;
- a buy inside the 3-second snipe window is refused before anything is read or sent;
- a sell is never offered below 85% of the pool's own quote for that exact size;
- `minOut` is never zero;
- the router refuses an RPC that answers for another chain id before it reads a balance.

Verifying the hook ABI against deployed bytecode is milestone 1 of the Arc grant application
([`docs/GRANT-ARC.md`](GRANT-ARC.md)).

---

## Things Argus does that a bonding curve does not

Argus is not a virtual curve, and treating it like one would misprice every trade:

- **`Portal.createLaunch()` opens a real Uniswap v4 pool.** The whole fixed supply of 1,000,000,000
  tokens is deposited as **one** concentrated position between `tickStart` and `tickBond`. Buys walk
  the price up through that single position.
- **There is no graduation and no migration.** When the tick crosses `tickBond` a monotonic `bonded`
  latch flips and stays; the same pool and the same position keep trading. `graduated` is therefore
  always `false` on this venue and the engine's pre-graduation exit must never fire
  (`t22-arc-feed`).
- **Active liquidity is not the position's liquidity.** `Swap` logs and `StateView.getLiquidity`
  report liquidity *at the current tick*, which equals the launch position's `L` only while the price
  sits inside the range — a buy that runs to the bond reads `0`, and a third-party LP after bonding
  reads larger. The Locker holds the position forever, so the feed always carries the **position's**
  `L` and keeps the raw reading beside it as `activeLiquidity`.
- **The launch record grew across Portal versions** (9, 10 or 11 words), and an 11-word ABI decode
  reverts on the shorter ones. `decodeLaunchWords` reads the raw return by word position as a prefix
  of the newest layout; a field a record does not carry comes back `null` and is read from the hook.
- **Older Portals still own their launches.** All seven are indexed and a newer Portal never
  replaces an older one's tokens — but only the five v4 Portals carry a `LaunchHook` and a v4 pool.
  The first two are legacy Uniswap v3 launches with the tax inside the token, and this engine does
  not price or trade them.
- **The snipe tax is 99% decaying over three seconds**, as the reference hook computes it:
  `9900 >> ((whole seconds since launch * 14) / 3)`, which is 9900, 618, 19, then 0 basis points. The
  candidate floor sits at the window plus two seconds of slack, because the bot's clock is not the
  chain's, and the leg tax plus the surcharge is capped at 99% together.

---

## Money safety on this venue

| Rule | Where | Test |
|---|---|---|
| Every swap is dry-run before it is sent | `router.mjs` `_dryRun` | `t23` |
| A buy inside the snipe window is refused, and the chain's own launch time is checked too | `router.mjs` `submit` | `t23` |
| Size shrinks before price widens; no sell below 85% of the pool's quote; `minOut` never 0 | `router.mjs` `_sellShape`, `close` | `t23` |
| An RPC answering for another chain is refused before going live | `router.mjs` `preflight` | `t23` |
| The wallet must cover the stake **and** its gas | `router.mjs` `submit` | `t23` |
| A held token ticks every poll, readable or not, and says when it is unreadable | `feed.mjs` | `t22`, `t27` |
| A watched token the Portals cannot name is retried with backoff, never dropped | `feed.mjs` `_adoptLater` | `t27` |
| A failing RPC is polled less and less, to a minute at most, and recovers immediately | `feed.mjs` `pollDelay` | `t22` |
| The fee leaves as native USDC to the EVM fee wallet, never converted | `hub.mjs` `settleFee` | `t11`, `t23` |
| RPC error text never reaches a public health route (it can quote the API key) | `hub.mjs` health | `t25` |

---

## Argus as public data

`GET /api/arc/stats` publishes what the feed sees, with no wallet in any row:

- launches in the last hour and the last day, and how many bonded;
- the tax terms creators actually choose, as a histogram;
- first-hour buyers per launch, summed across the hour's launches, and volume;
- the last 50 launches with market cap, progress, bonded flag, buy and sell tax, and an explorer
  link;
- the Arc wallet-intelligence signal as an **aggregate only**. The list of wallets the bot considers
  smart stays behind the admin key: publishing it is bait for the wallets themselves and a gift to
  every other bot.

The route is cached for 15 seconds and is live only while a bot is running — nothing outside is
polled unless someone is trading (`src/api/activity.mjs`, `t29`).

Wallet intelligence on Arc is the same measured scorer used on pump.fun: FIFO cost basis, a Wilson
lower bound on win rate so 5/5 never outranks 70/100, early-hit rate, and ring and wash detection
with rings as connected components. It runs over Arc swaps attributed to the transaction's sender,
never to the router (`t22`, `t30`, `tests/radar/wallet-intel.test.mjs`).

---

## Running it

```bash
npm install
npm test                     # the whole suite, no network and no keys required

# just the Arc surface
node --test tests/velocity/t20-arc-chain.test.mjs \
            tests/velocity/t22-arc-feed.test.mjs \
            tests/velocity/t23-arc-router.test.mjs \
            tests/api/t25-arc-callouts-wiring.test.mjs \
            tests/api/t30-arc-grant-surfaces.test.mjs
```

`t20`, `t22` and `t23` run against a fake chain built in the test file; `t25` and `t30` assert on the
server's own source, where there is no seam to render in isolation. Nothing reaches the network — 
`npm run test:offline` reruns the whole suite with every outbound call made to throw — and no key,
RPC or funded wallet is needed to run or read any of it.

To point a server at the real chain:

```bash
ARC_RPC_URL=https://<your endpoint>   # an RPC with an API key; the free one throttles submission
VELOCITY_ARC=1                        # 0 turns the Argus feed off
ARC_POLL_MS=1500                      # blocks are ~500ms
PLATFORM_EVM_WALLET=0x...             # where the USDC performance fee goes
```

The RPC endpoints in `DEFAULT_RPC_URLS` are placeholders, not verified facts: no Argus document names
a public Arc RPC, and none of them answered from the build environment. Set `ARC_RPC_URL` to your own.
