# What the customer is owed

Someone hands this bot money and walks away. Everything below follows from that one fact. Each
axiom names the rule, what breaks it, and where in the code it is held — so a change that would
violate one has to argue with this file first.

## 1. Money leaves only by a trade they asked for or a fee they were told about.
Nothing else. No route may move funds without the owner's signature. The count is deliberately not
written down here — it goes stale the moment a route is added, and `tests/api/t15` enforces the
property instead: it walks the server's own source and fails the build if any route that loads a
trading wallet is missing `requireOwner`. The fee is one rate, stated on the site, taken only from realized
profit, and zero for anyone holding `$BNDLI` (`hub.settleFee`, `t14`). A fee whose transfer fails is
recorded as owed and collected later — never silently dropped (`hub.collectOwed`, `t11`). On
Robinhood Chain the fee leaves in ETH and on Arc in USDC, each to the EVM fee wallet, never
converted and never to the Solana one (`QUOTE_OF`, `feeWalletFor`, `t11`).

## 2. The bot never holds what it cannot manage.
A position with no readable price has no stop loss behind it, so it is sold on that fact alone after
45s (`blind-exit`, `t5`). A held token always ticks, readable or not (`t12`, `t22`), and a cached
price whose pool has stopped answering is reported as unreadable, never as current (`t22`). A sell
the venue will never accept — graduated, or refused five times running the same way — releases the position rather
than holding a slot forever and raising an error nobody can clear (`TERMINAL_EXIT_CODES`,
`releaseAfterFailures`, `t9`).

## 3. Every number on screen reconciles with its own parts.
The header P&L must equal what its subtitle says. A venue joining mid-run brings its open positions
into the baseline (`t10`). A partial sell shrinks what is still at risk (`notional_usd`, `t10`).
Rent charged at entry is credited when it comes back (`reclaimRent`, `t10`). Simulated money never
touches the real day's ledger (`t7`, `t11`). Fees are recorded on the venue and in the asset they
were paid (`hub.settleFee`).

## 4. A loss is bounded before it happens, not explained after.
The stop loss fires on the position's own mark on every tick. A sell never accepts a price below 85%
of the curve's own quote — size shrinks before price widens, and `minOut` is never zero (`t13`). The
EV gate prices costs at the smallest stake the sizer could return, so a trade that cannot clear its
own drag is refused (`pipeline.mjs`). Losing more always means betting less, smoothly, with no
lockout to game (`governor` daily taper, `t7`); the only hard stop is a fault, at 3x the limit.

## 5. They can stop everything, always, in one action.
`Sell all & stop` flattens every venue. A position that cannot be sold is released so the stop
completes rather than hanging on it (axiom 2). Pause freezes entries, never exits.

## 6. They can try it before funding it.
Paper mode runs the same feed, gates, sizes, plans and exits with only the router simulated. It
needs no funded wallet, cannot reach a live router, is never charged, and is labelled from the
server's own settings so the switch cannot relabel real money (`hub.start`, `t11`, `t17`).

## 7. They can see why, in the bot's own words, without noise.
Every decision, order, fill, exit and outcome is in the ledger with its reason. A halted governor
says so once per five minutes, not once per candidate (`noteHalted`, `t9`). An error on screen is
one they can act on or one that goes away on its own; a banner is never remade faster than it can be
dismissed (axiom 2).

## 8. Nothing is lost to our own failure.
Custodial keys live in Redis with no TTL (`keepForever`, `t16`); the filesystem is ephemeral and
treated as such. A crash mid-trade reconciles from the ledger and the chain, and a sale we lost the
signature for is recovered before anything is booked as a loss (`findRecentSale`, `t9`, `t13`).
Alerts go to `ALERT_WEBHOOK_URL`; the code is ready, the variable is the operator's to set.

## 9. A call is a fill, never an opinion.
Anything the site or a channel says the bot "called" is a buy the bot made with real money: the
token, the market cap it paid, the plan it declared, and the transaction. The record is written to
its own ledger with `sha256(venue|instrument|tx|ts|mcapUsd|tier|plan)` before any channel sees it, so it cannot be
edited after the fact; the close is posted the same way, losses included. Paper never posts, below
the tier never posts, one call per token per hour across every user, and no row names a wallet or a
user (`Callouts`, `t21`, `t11`, `/api/callouts`).

## 10. A new venue costs trades before it can cost money.
Arc's Portal events and launch records are pinned to Argus's published documents; its hook
interface still comes from a reference contract. Everything built on that fails closed: a hook
whose getters do not answer keeps its launch out of the feed, every swap is dry-run before it is
sent, a buy inside the snipe window is refused, an RPC that answers for another chain is refused at
go-live, and an unknown tax is priced at the cap (`arc/chain.mjs`, `arc/router.mjs`, `t20`, `t23`).

## 11. On Arc the quote asset is the dollar, and nothing is priced through anything else.
Every venue before this one carried a price feed between the trade and the money: SOL or ETH, read
from an exchange, stale by a minute, gone in an outage, and behind a whole class of loss (`t12`,
`t22`: the unreadable tick). On Arc the pool is quoted in USDC, gas is USDC, the fee is USDC, the
stake, the mark, the P&L and the platform's cut are all the same unit, and `solPrice` on the venue is
the constant 1 (`arc/feed.mjs`, `QUOTE_OF`). There is no price to lose, so the only unreadable
price on Arc is a pool that will not answer, and that is reported as such (axiom 2).

## What is still open
- Entry quality on Robinhood Chain: 4% win rate over the last 24 live closes. The miss ledger
  (`engine.misses()`) records which hard rule refused each token that then ran; that is the
  instrument. Not yet acted on.
- `send failed` appeared in the live failure list once; not yet root-caused.
- The Arc hook ABI (getters, `Bonded`, `TaxCollected`, the snipe-tax formula) is from the reference
  contract, not the deployed bytecode; the explorer is unreachable from the build box. First live
  Arc trades should be small and watched, and `ARC_RPC_URL` should be the operator's own endpoint.
- The narrative-wave feature and the smart-money feature are bounded weights with no realized
  outcomes behind them yet; the learner will move them once the ledger has enough closes.
- `$BNDLI` is not launched. Until the mint exists and `BNDLI_MINT` is set, every fee is charged as
  before and the site's ticker links to the X profile instead of pump.fun. The mint address goes into
  the launch banner and the env, never into a doc.
- The launch thread (`docs/TWEETS.md`) carries placeholders for every number; each must be copied
  from `/api/callouts` at posting time, and a tweet whose number cannot be filled from the record is
  dropped, not estimated. The lore (`docs/LORE.md`) is checked against this file and against the
  site copy; when either changes, the lore is re-read before it is quoted anywhere.
- The frog is in (`app/public/fren.png`); the palette in `app/src/lib/theme.js` is measured off it.
  Any new ink or state colour has to be measured against the card again, not eyeballed.
