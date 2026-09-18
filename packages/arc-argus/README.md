# @bondli/arc-argus

Argus, the launchpad on Arc (Circle's USDC-gas L1, chain id 5042), as data. This is the layer a
trading client, an indexer or a dashboard needs and nobody has published (this one is not on npm yet either — install it from the repository): every Portal that ever
launched a token, the events they emit, the shape of their `launches(token)` records across seven
versions, the Uniswap v4 pool a launch opens, the hook's tax model including the 99% snipe tax that
decays over the first three seconds, and the exact swap encodings for the UniversalRouter through
Permit2. Pure functions over `ethers`; nothing in the module touches the network.

Lifted out of [bondli](https://github.com/Bradbuythedip/Bondli_public), where the same code drives a feed
(`src/velocity/venues/arc/feed.mjs`) and a fail-closed router (`src/velocity/venues/arc/router.mjs`)
that trade launches live. Those two files are the worked example of how to use it.

## What is pinned to a published source, and what is not

- Portal events (`TokenCreated`, `PartsDeployed`, `CurveOpened`), their topic0 and the launch-record
  layout per Portal version come from Argus's own `onchain/event-signatures.md`,
  `onchain/addresses.md` and `onchain/launch-record-layout.md`, fetched and matched.
- The PoolManager and StateView ABIs are Uniswap v4's.
- The LaunchHook interface (its getters, `Bonded`, `TaxCollected`, the snipe-tax formula) comes from
  the reference `contracts/LaunchHook.sol` in that repository, which describes itself as a
  simplification of the deployed hook. Everything built on it fails closed: a hook whose getters do
  not answer keeps its launch out of a feed, and a client that dry-runs before sending loses trades,
  not money. Verify against the deployed bytecode before you rely on it for anything else.

## Use

```js
import { PORTALS, TOPICS, decodeLog, priceFromSqrtX96, mcapQuote, snipeTaxBps, quoteBuy, quoteSell, poolIdFor } from "@bondli/arc-argus";

// Every Portal, newest first; index all of them, an older Portal still owns its launches.
const addresses = PORTALS.map(p => p.address);
// logs from eth_getLogs({ address: addresses, topics: [[TOPICS.TokenCreated, TOPICS.PartsDeployed, TOPICS.CurveOpened]] })
for (const log of logs) { const r = decodeLog(log); if (r?.kind === "launch") console.log(r.token, r.name, r.poolId); }

// A pool's price in USDC per token, and the market cap of the fixed 1e9 supply.
const price = priceFromSqrtX96(slot0.sqrtPriceX96, { tokenIs0 });
const mcapUsdc = mcapQuote(price);

// What the hook withholds from a buy this many milliseconds after launch: 9900, 618, 19, 0.
snipeTaxBps(1000);

// A quote through the single launch position, taxes and the 1% pool fee included.
quoteBuy({ sqrtPriceX96, liquidity, tickStart, tickBond, tokenIs0, buyTaxBps: 300, snipeBps: 0 }, 250);
```

## Exports

Addresses and constants: `CHAIN_ID`, `DEFAULT_RPC_URLS`, `EXPLORER`, `PORTALS`, `V4_PORTALS`,
`POOL_MANAGER`, `STATE_VIEW`, `POSITION_MANAGER`, `UNIVERSAL_ROUTER`, `V4_QUOTER`, `USDC_ERC20`,
`PERMIT2`, `QUOTE_IS_NATIVE`, decimals, `TOKEN_SUPPLY`, `POOL_FEE_PIPS`, `TICK_SPACING`,
`MAX_LEG_TAX_BPS`, `SNIPE_TAX_WINDOW_MS`, `SNIPE_TAX_CAP_BPS`.

ABI and topics: `PORTAL_ABI`, `HOOK_ABI`, `POOL_MANAGER_ABI`, `STATE_VIEW_ABI`, `ERC20_ABI`, the
`Interface` objects, `TOPICS`.

Decoding and math: `decodeLog`, `classifySwap`, `priceFromSqrtX96`, `mcapQuote`, `snipeTaxBps`,
`combinedTaxBps`, `progress`, `liquidityForSupply`, `quoteBuy`, `quoteSell`, `poolIdFor`,
`tokenIsToken0`, `tickFromSqrtPriceX96`, `sqrtRatioAtTick`, and the unit helpers for USDC's two
faces (native 18 decimals, ERC-20 view 6 decimals; one balance, never confuse them).

## Tests

`npm test` from the package runs the chain suite: every topic equals the keccak of its signature and
the published topic0; logs round-trip through ethers; prices for both currency orders and both quote
faces; the snipe-tax schedule; buy and sell quotes against a brute-force tiny-step simulation; the
tick decode across the whole grid.
