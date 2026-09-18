# Bondli on Arc: grant submission

A draft for an Arc ecosystem grant. Every claim here is something the code does today, with the
test that holds it named in brackets; every number marked `{{...}}` is to be copied from the live
record at the time of submission, never typed from memory. The house token is not part of the ask
and is not mentioned again below.

## One paragraph

Bondli is a hosted trading bot for launchpad tokens in their first minutes. Users keep their own
wallet; the bot trades it under a bounded risk envelope, on paper first if they want, and every buy
it makes can be published as a callout that was hashed into a ledger before anyone saw it, losses
included. It runs on pump.fun, on Robinhood Chain, and now on Arc through Argus, where it is the
first trading system whose quote asset is the dollar itself: sizing, marks, P&L and the platform's
fee are all USDC, with no price feed between the trade and the money. The Arc integration is open
source as a standalone package, `@bondli/arc-argus`, the only Argus indexer and pool-math
library we know of; the package, the Arc venue that uses it and the tests that hold every claim below
are public at https://github.com/Bradbuythedip/Bondli_public. We are asking for `{{AMOUNT}}` against
three public deliverables in 90 days.

## What exists today

- **A working Arc venue.** Launch feed over every Argus Portal (all seven; an older Portal still
  owns its launches), Uniswap v4 swap indexing by pool id, hook terms read once, a candidate floor
  that never offers a launch inside the 3-second snipe tax [`t22`]. A live router that pays USDC
  through Permit2 and the UniversalRouter, dry-runs every swap before sending, refuses a buy inside
  the snipe window, never offers a zero price floor, shrinks a sell before widening its price, and
  refuses an RPC that answers for another chain before it reads a balance [`t23`, 18 tests].
- **USDC-native accounting.** `solPrice` on the Arc venue is the constant 1; the fee on a profitable
  close leaves as native USDC to an EVM fee wallet, never converted [`t11`]. Axiom 11 in
  `docs/AXIOMS.md` states the rule.
- **Fail-closed by construction.** The Portal events, topic0 and launch-record layouts are pinned to
  Argus's published documents. The hook interface still comes from the reference contract, and every
  path that depends on it costs trades, not money, if it is wrong: a hook whose getters do not answer
  keeps its launch out of the feed; every swap is dry-run first [`t20`, `t23`, axiom 10].
- **Verified callouts.** A call is the bot's own fill: token, market cap paid, declared exit plan,
  the transaction. It is written to a ledger with `sha256(venue|instrument|tx|ts|mcapUsd|tier|plan)`
  before any channel sees it; the close is posted the same way; paper never posts; the record is
  public with no wallet in it [`t21`, `t11`, axiom 9]. Callouts are opt-in per user.
- **Wallet intelligence on Arc addresses.** The same measured scorer used on pump.fun (FIFO cost
  basis, Wilson-bounded win rate, early-hit rate, ring and wash detection) runs over Arc swaps and
  reaches the radar row for Arc launches [`wallet-intel.test`, `t30`].
- **A public Argus dashboard.** `GET /api/arc/stats`: launches per hour and per day, bonded rate,
  the tax terms creators choose, first-hour buyers and volume, the last 50 launches. No wallet in
  any row [`t30`].
- **Nothing polls unless someone trades.** Feeds, streams and pollers follow one activity gate, so
  the RPC budget is spent only while a bot runs [`t29`].
- **Eleven adversarial reviews** across the Arc modules, the wallet scorer and the callouts, each
  with a money-safety and a correctness lens; every blocking finding fixed and tested. The list is in
  the appendix.

## The ask: three deliverables, 90 days

| # | Deliverable | Public artifact | Weeks |
|---|---|---|---|
| 1 | A verified live record on Arc | One bot trading Argus launches with a small USDC bankroll, every fill called out and hashed, the record at bondli.fun/callouts with `{{CLOSES}}` closes; `@bondli/arc-argus` 1.0 on npm with the deployed hook ABI verified against bytecode and the feed and router as worked examples | 1 to 4 |
| 2 | Argus in public | The `/api/arc/stats` dashboard on the site with charts, plus the Arc wallet-intelligence signal published as an aggregate (never the wallet list); a write-up of what a USDC-quoted launch economy looks like from the data | 5 to 8 |
| 3 | Onboarding | Paper-first Arc onboarding (no funded wallet needed to watch the bot judge Argus launches), in English and Simplified Chinese, with the Arc funding flow (USDC in, USDC out) and a one-action stop | 9 to 12 |

Payment against artifacts: a link that anyone can open, a test that anyone can run.

## Why Arc should want this

- It is USDC-native in the exact sense Arc is built for: no stablecoin bridge, no volatile gas, no
  price oracle between a user and their money.
- It will bring measurable activity, every transaction linked from a public page: the live Arc
  record starts with deliverable 1, and the callout ledger it lands in is already public.
- It leaves public goods behind: the indexer library, the dashboard, the smart-money aggregate, and
  a documented account of what is and is not pinned to published Argus sources.
- It is safe to be associated with: a bot that refuses more than it accepts, that never promises a
  return, and whose losses are on the record it publishes.

## What we will not claim

No return, no win rate other than the one the record shows at submission time, no "guaranteed".
The open list in `docs/AXIOMS.md` is part of this submission.

## Appendix: the review record

Eleven reviews were run on the five new modules (Arc chain, feed, router; wallet intelligence;
callouts), two lenses each plus an integration lens on the router. Blocking findings fixed:

- Tick decode off by one in about one case in seven; fixed and asserted across the whole grid.
- An unknown launch time or tax was priced as free; now priced at the cap.
- A held token could stop ticking (evicted, never adopted, or a poll with no new block); now a held
  token is never evicted and ticks unreadable until the chain answers.
- RPC error text could carry the API key to a public health route; scrubbed, and the route drops it.
- Underfunded-wallet code bypassed the engine's cooldown; aligned.
- A capped buy was booked at the stake, not what the pool took; booked from the receipt.
- Wallet intel was fed a curve delta instead of the trade's own amount, producing zero-cost "wins";
  fixed, with zero-cost buys refused.
- A ring with a staggered member counted three times; rings are now connected components.
- A paper close on a shared token could be posted as a real call's result; calls are bound to the
  position that made them, and are opt-in per user.
- The admin gate had a default secret; it fails closed.
