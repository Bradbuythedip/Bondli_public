# Arc grant application: answers, field by field

Paste-ready answers for the Circle / Arc grant form. Every factual claim is something the code does
today; the tests that hold each one are named in `docs/GRANT-ARC.md`. Fields marked `[FILL]` are
yours alone (names, links, files) and are left blank rather than guessed. Do not type a number from
memory: `{{...}}` values come from the live record at submission time.

---

**Project X handle**
@shitanalystXBT

**Project GitHub URL**
https://github.com/Bradbuythedip/Bondli_public

**Where are you and your founders located?**
United States

**Where is your business located?**
United States

**Is your business incorporated?**
No

---

## Project Abstract

**Project Name**
Bondli

**One-line description**
A hosted bot that trades launchpad tokens in their first minutes on the user's own wallet, USDC-native on Arc through Argus, with every buy it makes publishable as a callout that was hashed into a ledger before anyone saw it.

**What problem are you solving, why is it important, and what has kept it from being solved so far?**
Launchpad trading is where most new on-chain users first touch a chain, and it is run by hand or by closed bots with no record. A human cannot judge a launch in its first ninety seconds; the bots that can are opaque, publish only their wins, and hold the user's keys. Two things have kept this unsolved. First, every venue before Arc put a volatile price feed between the trade and the money (SOL or ETH read from an exchange, stale by a minute, gone in an outage), which is a whole class of loss on its own and makes honest accounting hard. Second, nobody has been willing to publish a verifiable record: a track record that cannot be edited after the fact, losses included, is more work than a highlight reel and worse marketing. On Arc the first problem disappears, since the pool, the gas, the stake and the fee are all USDC. The second we solved by construction.

**What is your solution to that problem?**
Bondli runs one trading engine per user, on a custodial wallet they fund and can drain with one action, under a bounded risk envelope (per-trade cap, position cap, a daily loss taper). It reads launches on Arc directly from every Argus Portal and the Uniswap v4 PoolManager, judges each one through the same gates it uses on pump.fun and Robinhood Chain, and trades through the UniversalRouter with Permit2, dry-running every swap before sending, refusing any buy inside the 3-second snipe tax, and never offering a zero price floor. Every fill can be published as a callout: token, market cap paid, declared exit plan, the transaction, written to a ledger with sha256(venue|instrument|tx|ts|mcapUsd|tier|plan) before any channel sees it; the close is posted the same way, and paper trades never post. Users can run it on paper first with no funded wallet. The Arc chain layer is open source as `@bondli/arc-argus`, the only published Argus indexer and pool-math library we know of, and the Argus launch data is public at bondli.fun/api/arc/stats.

**Describe your team's track record of acquiring the type of users/customers that your solution will require.**
The product is live at bondli.fun with a public landing page, paper mode, a live tape of closes across every bot, and an English and Simplified Chinese interface. Verifiable numbers at submission time: `{{USERS}}` trading wallets created, `{{CLOSES}}` live closes in the public callout record (https://bondli.fun/api/callouts), `{{PAPER_RUNS}}` paper runs. The founder's X account (@shitanalystXBT) is the distribution channel; a lore-driven launch thread in English and Chinese is prepared in the repository (docs/TWEETS.md). We publish losses with wins, which is the acquisition strategy: a record nobody else will show.

---

## Product Alignment Track

**Is your project currently live in production?**
Yes

**Are you live on Arc?**
No, not yet with real money. The Arc venue (feed, router, fee accounting in USDC, public stats) is merged and tested against a fake chain; the first live USDC trades on Arc mainnet are milestone 1 of this application, and the video will show the integration running.

**Which other chain(s) are you currently live on in production?**
Solana (pump.fun) and Robinhood Chain (PONS launchpad).

**Which Circle products are currently integrated into your project?**
USDC. On Arc the bot's quote asset, gas, stake, P&L and platform fee are all USDC: the native 18-decimal balance and the 6-decimal ERC-20 view at 0x3600...0000 are handled as one balance, and the fee on a profitable close leaves as native USDC to an EVM fee wallet (src/velocity/venues/arc/router.mjs, src/velocity/hub.mjs).

**Which Circle products do you plan to integrate into your project?**
USDC (deepening: USDC-denominated risk envelope and reporting across all venues). CCTP, to move a user's USDC between Solana and Arc without leaving the app. Wallets, to replace our own custodial wallet with Circle programmable wallets so the user's funds are held by Circle infrastructure rather than by us. Gateway, if it fits the Solana-to-Arc funding flow better than CCTP for small balances.

---

## Milestones and Timelines

**Milestone 1: A verified live record on Arc (weeks 1 to 4)**
One bot trading Argus launches on Arc mainnet with a small USDC bankroll, every fill called out and hashed, the public record at bondli.fun/callouts. `@bondli/arc-argus` 1.0 published on npm with the deployed LaunchHook ABI verified against bytecode (today it comes from Argus's reference contract, and everything built on it fails closed). Success metric: `{{N}}` live USDC closes on Arc, each linked from the public record; the package installable with its test suite green.

**Milestone 2: Argus in public (weeks 5 to 8)**
The /api/arc/stats dashboard rendered on the site with charts: launches per hour, bonded rate, tax terms creators choose, first-hour buyers and volume. The Arc wallet-intelligence signal (measured, ring- and wash-aware) published as an aggregate, never as a wallet list. A written report on what a USDC-quoted launch economy looks like from the data. Success metric: dashboard live and linked from Arc community channels; report published.

**Milestone 3: USDC onboarding on Arc (weeks 9 to 12)**
Paper-first Arc onboarding (watch the bot judge Argus launches with no funded wallet), in English and Simplified Chinese; a USDC funding flow (USDC in, USDC out, one-action stop); CCTP integrated so Solana users can bring USDC to Arc inside the app. Success metric: `{{N}}` wallets funded on Arc through the flow; `{{N}}` CCTP transfers executed.

---

## Project Traction and Roadmap

**Where can we verify your traction?**
- https://bondli.fun (live product; the tape and the Calls tab are the public record)
- https://bondli.fun/api/callouts (every published call with its transaction and result; hashed before posting)
- https://bondli.fun/api/velocity/pulse (bots trading now, closes today, no wallet named)
- https://bondli.fun/api/arc/stats (Argus launches as the feed sees them)
- https://github.com/Bradbuythedip/bondli (326 tests; `npm test`)
- Arc explorer links for each live trade, from the callout record, once milestone 1 begins

**If any of the traction data is not verifiable on a public link, share verification documents here**
[FILL: Google Drive folder link] Contents: exports of the callout ledger, the hub pulse, and Railway logs for the periods claimed.

**Are you funded?**
No

**Technical Roadmap (one line per milestone: what will exist at completion | Circle product involved | target date | success metric)**
Live Arc trading with a public hashed callout record and @bondli/arc-argus 1.0 on npm with the deployed hook ABI verified | USDC | {{DATE+4w}} | {{N}} live USDC closes on Arc linked from bondli.fun/callouts; package tests green
Argus public dashboard with charts and the Arc smart-money aggregate, plus a data report on a USDC-quoted launch economy | USDC | {{DATE+8w}} | dashboard live at bondli.fun and cited by Arc community channels; report published
Paper-first Arc onboarding in EN and ZH with a USDC funding flow and CCTP from Solana to Arc inside the app | USDC, CCTP | {{DATE+12w}} | {{N}} wallets funded on Arc through the flow; {{N}} CCTP transfers executed

**Are you seeking funding or support for a smart contract audit or security review as part of your application?**
Yes. Bondli deploys no contracts of its own; the review we want is of the Arc trading client (src/velocity/venues/arc/router.mjs and packages/arc-argus) against the deployed Argus hook and the Uniswap v4 router: the swap encodings, the Permit2 grant, the tax accounting, and the fail-closed paths.

**If an internal or 3rd party audit has already been conducted on your contract or security, please summarize the findings.**
Internal adversarial review, September 2026, eleven reviews across the Arc chain, feed and router, the wallet-intelligence scorer and the callouts, with a money-safety lens and a correctness lens each and an integration lens on the router. Every blocking finding was fixed and is held by a test. Findings fixed: a tick decode off by one in about one case in seven; unknown launch time or tax priced as free (now priced at the cap); a held token that could stop ticking after eviction or a poll with no new block (now never evicted, ticks unreadable until the chain answers); RPC error text that could carry an API key to a public health route (scrubbed, and the route drops it); an underfunded-wallet code that bypassed the engine's cooldown; a capped buy booked at the stake instead of what the pool took; the wallet ledger fed a curve delta instead of the trade's own amount (produced zero-cost wins; fixed and zero-cost buys refused); a ring with a staggered member counted three times (rings are now connected components); a paper close on a shared token that could be posted as a real call's result (calls are now bound to the position that made them, and opt-in per user); an admin gate with a default secret (now fails closed). Still open: the Argus hook ABI is taken from the reference contract, not deployed bytecode; every dependent path fails closed until it is verified, which is milestone 1.

---

## Deck and Demo

**Video demo of the product**
[FILL: link]. Record under five minutes: (1) bondli.fun landing page, the tape and the Calls tab; (2) code walkthrough of src/velocity/venues/arc/router.mjs showing the USDC handling (native 18-decimal balance and the 6-decimal ERC-20 view, Permit2 approval, the dry run before every send) and src/velocity/hub.mjs settleFee paying the fee in USDC; (3) a paper run with the Arc chip on, the bot judging Argus launches; (4) if milestone 1 has begun, one live Arc fill and its callout with the explorer link; (5) the roadmap: CCTP and Wallets.

**Transcript of the video (Google Drive folder link)**
[FILL]. The transcript must name USDC and where it appears: packages/arc-argus/chain.mjs (USDC_ERC20, the two decimal faces), src/velocity/venues/arc/router.mjs (balance, approval, swap input in USDC), src/velocity/hub.mjs (QUOTE_OF.arc = "USDC", settleFee).

**Screenshots of the code where each Circle product is integrated (Google Drive folder link)**
[FILL]. Suggested: packages/arc-argus/chain.mjs lines defining USDC_ERC20, QUOTE_DECIMALS, NATIVE_DECIMALS and toUsdc/toNativeUsdc; router.mjs preflight() and _ensurePermit2(); hub.mjs QUOTE_OF and settleFee; docs/AXIOMS.md axiom 11.

**Investor deck**
[FILL: link]. GRANT_PROPOSAL_ONE_PAGER.md in the repository is out of date (it describes an earlier product) and should not be sent as-is.

---

## Co-founders

Format: Founder name | Title | LinkedIn URL | GitHub URL | Bio

[FILL: Founder name] | Founder and engineer | [FILL: LinkedIn URL] | https://github.com/Bradbuythedip | Builder of Bondli end to end: the multi-venue trading engine, the hosted hub, the Arc/Argus integration and the public callout record. Known on X as @shitanalystXBT. [FILL: one sentence of prior background.]

(Add one line per additional co-founder, or state "Solo founder" if none.)

---

## Conflict of Interest

None. No financial, advisory, family or personal relationship with Circle, its subsidiaries, employees or contractors; no Circle equity; no relationship that could influence Circle's decision on this grant.
