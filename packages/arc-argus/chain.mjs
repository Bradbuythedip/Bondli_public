// ═══ Argus on Arc: addresses, ABI, pool math, log decoding ═══
// Arc is Circle's EVM L1 (chain id 5042). Its gas asset is USDC, and USDC has two faces on this
// chain: the native balance (msg.value, gas, 18 decimals, like ETH) and an enshrined ERC-20 view at
// 0x3600...0000 (6 decimals). They are one balance; getting the face wrong misprices by 10^12.
// Argus is the chain's dominant launchpad and it is NOT a virtual bonding curve: Portal.createLaunch()
// clones a fixed 1,000,000,000-token ERC-20, deploys a per-launch LaunchHook + RevenueSplitter + Locker,
// initializes a Uniswap v4 pool (token/USDC, 1% fee tier, tick spacing 200) with the hook, and deposits
// the whole supply as ONE concentrated position between tickStart and tickBond above the opening price.
// Buys walk the price up through that position; when the tick crosses tickBond a monotonic "bonded"
// latch flips and stays. There is no migration: the pool keeps trading the same position forever.
// What is pinned to a published source and what is not: the Portal events, their topic0 and the
// launches() record layout come from Argus's own onchain/event-signatures.md, addresses.md and
// launch-record-layout.md; the PoolManager and StateView ABIs are Uniswap v4's. The LaunchHook
// interface (its getters, Bonded, TaxCollected, the snipe-tax formula) comes from the reference
// contracts/LaunchHook.sol in that repo, which describes itself as a simplification of the deployed
// hook, and the deployed bytecode could not be read from here. Everything built on it fails closed:
// a hook whose getters do not answer keeps its launch out of the feed (never a candidate), and the
// router dry-runs every swap before sending, so a wrong hook ABI costs trades, not money.
import { Interface, AbiCoder, id as keccakId, keccak256, formatUnits, parseUnits } from "ethers";

export const CHAIN_ID = 5042; // per Argus; third-party Arc docs report 5042002, so the router checks eth_chainId at init
// UNSOURCED: no Argus document names a public RPC (docs/07 says to configure a primary plus a
// fallback and mentions only rpc.arc-scan.org), and none of these answered from the build sandbox.
// They are placeholders for ARC_RPC_URL, not a verified fact, and the first health check will say so.
export const DEFAULT_RPC_URLS = Object.freeze([
  "https://rpc.mainnet.arc.io",
  "https://rpc.blockdaemon.mainnet.arc.io",
  "https://rpc.drpc.mainnet.arc.io",
  "https://rpc.quicknode.mainnet.arc.io",
]);
export const DEFAULT_RPC_URL = DEFAULT_RPC_URLS[0]; // ARC_RPC_URL for a paid one
export const EXPLORER = "https://explorer.arc.io"; // UNSOURCED, see above

// Every Portal that ever launched a token still owns those tokens' records; a newer Portal never
// replaces older launches, so all of them are indexed. Only the hooked v4 family trades through a
// LaunchHook; #1 and #2 are legacy Uniswap v3 launches with the tax inside the token.
// `words` is what LAUNCH_STRUCT_WORDS() answers: the launches(token) record grew across versions,
// so PORTAL_ABI's 11-word decode of launches() holds for #6 and #7 only (LAUNCH_FIELDS below has
// the per-version prefixes). #6 and #7 both answer 11; registry() is the documented way apart.
export const PORTALS = Object.freeze([
  { n: 7, address: "0xB021Be536808f551b31789422Fd28a6c9c6e97Da", family: "v4", startBlock: 20_395_275, words: 11 },
  { n: 6, address: "0xA5628A11c412596E1f63b75a2C0284F843C549d6", family: "v4", startBlock: 20_240_260, words: 11 },
  { n: 5, address: "0x07a688a001f416cC433c68Ff56Aa26bC5131Cc6E", family: "v4", startBlock: 20_081_606, words: 10 },
  { n: 4, address: "0xa36c443A797771Df82533B8B4A86F0AFfd970862", family: "v4", startBlock: 19_690_658, words: 10 },
  { n: 3, address: "0x7A17Ab0106C46C0be30623F3EB7F299CC0058338", family: "v4", startBlock: 19_674_154, words: 9 },
  { n: 2, address: "0xBed9880A0ba12722ba4b8791c0B6F8c74338246C", family: "v3", startBlock: 19_056_397, words: 10 },
  { n: 1, address: "0x0F1C7Cb26D6cD36BD4189E41947658b39437587A", family: "v3", startBlock: 18_817_867, words: 10 },
]);
export const PORTAL = PORTALS[0].address;                                           // where new launches go
export const V4_PORTALS = Object.freeze(PORTALS.filter(p => p.family === "v4").map(p => p.address));
export const PORTAL_SET = new Set(PORTALS.map(p => p.address.toLowerCase()));      // every emitter a Portal log may come from

// Shared Uniswap v4 infrastructure on Arc. There is no single Argus pool or hook contract: each launch
// deploys its own, and their addresses arrive in the Portal's PartsDeployed event.
export const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
export const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
export const POSITION_MANAGER = "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B";
export const UNIVERSAL_ROUTER = "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1";
// ASSUMPTION: the v4 Quoter from Uniswap's own SDK chain table, unverified on Arc and used by nothing
// yet; it is the fallback the router should ask when a dry run reverts with V4TooLittleReceived
// (foreign liquidity in the pool, see quoteBuy).
export const V4_QUOTER = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";
export const USDC_ERC20 = "0x3600000000000000000000000000000000000000";                // the 6-decimal face
export const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000";           // how a v4 pool key spells the gas asset
// ASSUMPTION: Permit2 at its canonical CREATE2 address. Neither the Argus repo nor the Arc research
// names it; the UniversalRouter pulls ERC-20 input through Permit2, so the router must confirm this
// address has code on Arc (eth_getCode) before it approves anything to it.
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// The quote currency in the pool key is an ERC-20, not native address(0). Portal.sol builds the key
// from the caller's `p.quoteAsset` ("bool tokenIsToken0 = token < p.quoteAsset; address currency0 =
// tokenIsToken0 ? token : p.quoteAsset;"), stores tokenIsToken0 in the record (it could only vary with
// a non-zero quote address), and everything downstream moves the quote with ERC-20 calls:
// RevenueSplitter.depositRevenue does "IERC20Minimal(quoteAsset).transfer(argusTreasury, argusShare)"
// and Locker.harvestFees approves currency0/currency1 as ERC-20s. The default quote is the USDC view
// at 0x3600...; v6+ Portals let a creator pick another ERC-20 (ARGUS is approved). So a buy through the
// UniversalRouter pays with the 6-decimal ERC-20 via Permit2, never with msg.value.
// That reading comes from the reference Portal.sol, which is a simplification of the deployed one,
// so these two constants are the expectation and not the measurement. The chain states the fact for
// free in every pool's Initialize log (currency0/currency1): quoteFaceOf() turns that into the face,
// and a launch whose pool does not match is refused rather than priced 10^12 off.
export const QUOTE_IS_NATIVE = false;
export const QUOTE_DECIMALS = 6;     // the ERC-20 face of USDC
export const NATIVE_DECIMALS = 18;   // the gas face of the same balance
export const TOKEN_DECIMALS = 18;
export const TOKEN_SUPPLY = 1_000_000_000;
export const TOKEN_SUPPLY_UNITS = 10n ** 27n;
export const BASIS_POINTS = 10_000;
export const POOL_FEE_PIPS = 10_000; // v4 fee units, 1e6 = 100%: this is the 1% tier
export const TICK_SPACING = 200;
export const MAX_LEG_TAX_BPS = 1000; // LaunchHook.MAX_LEG_TAX_BPS: a side's tax is 0..10%, not both zero
// Argus documents a three-second snipe surcharge on buys after launch, up to 99% on top of the leg
// tax. The feed refuses candidates younger than this; the edge's own minimum age is much longer anyway.
export const SNIPE_TAX_WINDOW_MS = 3_000;
export const SNIPE_TAX_CAP_BPS = 9_900; // LaunchHook.COMBINED_RATE_CAP_BPS: leg tax + snipe tax never exceed this
// Uniswap v4 TickMath: the sqrt prices at MIN_TICK and MAX_TICK. A swap that empties the position
// keeps walking through zero liquidity until it hits the router's limit, one inside these.
export const MIN_TICK = -887272, MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

// The launches(token) record, newest layout first, as onchain/launch-record-layout.md documents it:
// Portal #3 answers words 0-8, #4 and #5 words 0-9, #6 and #7 all eleven. The one definition the
// feed's word decoder, the router and PORTAL_ABI share, so a swapped field fails one test, not none.
export const LAUNCH_FIELDS = Object.freeze([
  { name: "creator", type: "address" }, { name: "tickStart", type: "int24" }, { name: "tokenIsToken0", type: "bool" },
  { name: "locker", type: "address" }, { name: "hook", type: "address" }, { name: "splitter", type: "address" },
  { name: "buyTaxBps", type: "uint16" }, { name: "sellTaxBps", type: "uint16" }, { name: "positionId", type: "uint256" },
  { name: "tickBond", type: "int24" }, { name: "quoteAsset", type: "address" },
].map(Object.freeze));
/** The ABI tuple a Portal of `words` words returns from launches(token). */
export const launchTupleTypes = (words) => LAUNCH_FIELDS.slice(0, Number(words)).map(f => f.type);

export const PORTAL_ABI = [
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, bytes32 poolId, string imageURI, string website, string twitter, string telegram)",
  "event PartsDeployed(address indexed token, address locker, address hook, address splitter)",
  "event CurveOpened(address indexed token, bytes32 indexed poolId, address locker, uint256 positionId, uint128 liquidity, int24 tickLower, int24 tickUpper)",
  `function launches(address token) view returns (${LAUNCH_FIELDS.map(f => `${f.type} ${f.name}`).join(", ")})`,
  "function tokenCount() view returns (uint256)",
  "function allTokens(uint256 i) view returns (address)",
  "function getTokens(uint256 offset, uint256 limit) view returns (address[])",
  "function LAUNCH_STRUCT_WORDS() view returns (uint256)",
  "function POOL_FEE() view returns (uint24)",
  "function TICK_SPACING() view returns (int24)",
  "function poolManager() view returns (address)",
  "function positionManager() view returns (address)",
  "function registry() view returns (address)",
];
// The hook emits nothing that names a trader: TaxCollected carries the side, the amount and the quote
// asset, Bonded carries the time and tick. Who traded comes from the transaction's `from` or from the
// token's own Transfer log in the same receipt, never from a hook or PoolManager event (the Swap
// event's `sender` is the router that unlocked the PoolManager, not the wallet).
export const HOOK_ABI = [
  "event Bonded(uint256 atTimestamp, int24 atTick)",
  "event TaxCollected(bool isBuy, uint256 amount, address quoteAsset)",
  "function buyTaxBps() view returns (uint16)",
  "function sellTaxBps() view returns (uint16)",
  "function poolFee() view returns (uint24)",
  "function totalFeeBps(bool isBuy) view returns (uint256)",
  "function currentSnipeTaxBps() view returns (uint256)",
  "function bonded() view returns (bool)",
  "function bondBound() view returns (bool)",
  "function bondTick() view returns (int24)",
  "function tickStart() view returns (int24)",
  "function tickBond() view returns (int24)",
  "function launchedAt() view returns (uint256)",
  "function milestoneProgress(int24 currentTick) view returns (int256)",
  "function poolId() view returns (bytes32)",
  "function token() view returns (address)",
  "function quoteAsset() view returns (address)",
  "function splitter() view returns (address)",
  "function portal() view returns (address)",
  "function poolManager() view returns (address)",
];
// Uniswap v4 PoolManager: one contract for every pool, so logs are filtered by pool id (topic 1),
// never by address alone. Swap amounts are the swapper's deltas: negative is what they paid.
export const POOL_MANAGER_ABI = [
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
];
export const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)",
];
export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
];
export const portalIface = new Interface(PORTAL_ABI);
export const hookIface = new Interface(HOOK_ABI);
export const poolManagerIface = new Interface(POOL_MANAGER_ABI);
export const stateViewIface = new Interface(STATE_VIEW_ABI);
export const erc20Iface = new Interface(ERC20_ABI);
export const TOPICS = Object.freeze({
  TokenCreated: keccakId("TokenCreated(address,address,string,string,bytes32,string,string,string,string)"),
  PartsDeployed: keccakId("PartsDeployed(address,address,address,address)"),
  CurveOpened: keccakId("CurveOpened(address,bytes32,address,uint256,uint128,int24,int24)"),
  Initialize: keccakId("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"),
  Swap: keccakId("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  ModifyLiquidity: keccakId("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
  Bonded: keccakId("Bonded(uint256,int24)"),
  TaxCollected: keccakId("TaxCollected(bool,uint256,address)"),
});

export const toUsdc = (units, decimals = QUOTE_DECIMALS) => Number(formatUnits(BigInt(units), decimals));
// Rounds half-up to the quote's own resolution, so anything under half a unit (1e-7 USDC on the
// 6-decimal face) comes back 0n: a min-out floor of 0n accepts any price, so every caller checks
// `> 0n` before it signs, and a max-in should be floored by the caller rather than rounded here.
export const toUsdcUnits = (usdc, decimals = QUOTE_DECIMALS) => parseUnits(Number(usdc).toFixed(decimals), decimals);
export const toNativeUsdc = (wei) => Number(formatUnits(BigInt(wei), NATIVE_DECIMALS)); // a getBalance() answer
export const toTokens = (units, decimals = TOKEN_DECIMALS) => Number(formatUnits(BigInt(units), decimals));
export const toTokenUnits = (tokens, decimals = TOKEN_DECIMALS) => parseUnits(Number(tokens).toFixed(decimals), decimals);

const lower = (a) => String(a).toLowerCase();
/** The Portal's own rule for currency order: the launch token is currency0 when its address is the smaller. */
export function tokenIsToken0(token, quoteAsset = USDC_ERC20) { return BigInt(token) < BigInt(quoteAsset); }
/** The v4 pool id the Portal computes: keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)). */
export function poolIdFor({ token, quoteAsset = USDC_ERC20, hook, fee = POOL_FEE_PIPS, tickSpacing = TICK_SPACING }) {
  const t0 = tokenIsToken0(token, quoteAsset);
  return keccak256(AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [t0 ? token : quoteAsset, t0 ? quoteAsset : token, fee, tickSpacing, hook]));
}

/**
 * Which face of USDC a pool's quote currency is, read from the currency the pool key names: the
 * native gas asset is address(0) in a v4 key and carries 18 decimals, the ERC-20 view at 0x3600...
 * carries 6. Anything else (an ARGUS-quoted launch, a typo) is null: not a quote this venue prices.
 */
export function quoteFaceOf(currency) {
  const c = lower(currency ?? "");
  if (c === NATIVE_CURRENCY) return { native: true, decimals: NATIVE_DECIMALS };
  if (c === lower(USDC_ERC20)) return { native: false, decimals: QUOTE_DECIMALS };
  return null;
}
/** The currency in an Initialize record that is not the launch token, or null when neither side is it. */
export function quoteCurrencyOf(initRec, token) {
  const t = lower(token), c0 = lower(initRec?.currency0), c1 = lower(initRec?.currency1);
  return c0 === t ? c1 : c1 === t ? c0 : null;
}
/**
 * Does a pool's Initialize record describe the key poolIdFor() would build for this launch? The two
 * agree exactly when the reference Portal.sol is the deployed one; a mismatch means the quote face,
 * the fee tier or the hook is not what this module assumes, and the launch must not be priced.
 */
export function poolKeyMatches(initRec, { token, quoteAsset = USDC_ERC20, hook, fee = POOL_FEE_PIPS, tickSpacing = TICK_SPACING }) {
  if (!initRec || !token || !hook) return false;
  const t0 = tokenIsToken0(token, quoteAsset);
  return lower(initRec.currency0) === lower(t0 ? token : quoteAsset) && lower(initRec.currency1) === lower(t0 ? quoteAsset : token)
    && lower(initRec.hooks) === lower(hook) && Number(initRec.fee) === Number(fee) && Number(initRec.tickSpacing) === Number(tickSpacing);
}

/**
 * The URL a browser can load for a launch's picture. TokenCreated carries whatever the creator
 * typed: an https URL, an ipfs:// URI or a bare CID. Only the first loads as an <img> src, so the
 * other two are pointed at a public gateway. An empty or unusable value is "" (no picture), never
 * a broken link. Whether Argus URIs name an image or a metadata JSON that names one is unknown
 * until a real launch is read; a JSON answer needs the feed to follow it the way the pump.fun path does.
 */
export function imageUrlOf(imageURI, gateway = "https://ipfs.io/ipfs/") {
  const u = String(imageURI ?? "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (/^ipfs:\/\//i.test(u)) return gateway + u.slice(7).replace(/^ipfs\//i, "");
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|ba[a-z2-7]{50,})(\/.*)?$/.test(u)) return gateway + u;
  return "";
}

/**
 * Decode one Portal or PoolManager log into a plain record, or null for anything else. The emitter
 * is checked as well as the topic: a TokenCreated from an address that is not a Portal, or a Swap
 * from a contract that is not the PoolManager, is somebody else's event with the same signature, and
 * a receipt fed in whole must not adopt it.
 * Raw integers that do not fit a double (liquidity, sqrtPriceX96, swap amounts, position ids) come
 * back as decimal strings so a record survives JSON; the math helpers accept them as they are.
 */
export function decodeLog(log) {
  const topic = log?.topics?.[0];
  const from = lower(log?.address ?? "");
  const base = { block: log?.blockNumber, tx: log?.transactionHash, logIndex: log?.index ?? log?.logIndex };
  try {
    if (topic === TOPICS.TokenCreated || topic === TOPICS.PartsDeployed || topic === TOPICS.CurveOpened) {
      if (!PORTAL_SET.has(from)) return null;
      const e = portalIface.parseLog({ topics: log.topics, data: log.data });
      if (topic === TOPICS.TokenCreated) return { kind: "launch", portal: from, token: lower(e.args.token), creator: lower(e.args.creator), name: e.args.name, symbol: e.args.symbol, poolId: lower(e.args.poolId), imageURI: e.args.imageURI, website: e.args.website, twitter: e.args.twitter, telegram: e.args.telegram, ...base };
      if (topic === TOPICS.PartsDeployed) return { kind: "parts", portal: from, token: lower(e.args.token), locker: lower(e.args.locker), hook: lower(e.args.hook), splitter: lower(e.args.splitter), ...base };
      return { kind: "opened", portal: from, token: lower(e.args.token), poolId: lower(e.args.poolId), locker: lower(e.args.locker), positionId: e.args.positionId.toString(), liquidity: e.args.liquidity.toString(), tickLower: Number(e.args.tickLower), tickUpper: Number(e.args.tickUpper), ...base };
    }
    if (topic === TOPICS.Swap || topic === TOPICS.Initialize) {
      if (from !== lower(POOL_MANAGER)) return null;
      const e = poolManagerIface.parseLog({ topics: log.topics, data: log.data });
      if (topic === TOPICS.Swap) return { kind: "swap", poolId: lower(e.args.id), sender: lower(e.args.sender), amount0: e.args.amount0.toString(), amount1: e.args.amount1.toString(), sqrtPriceX96: e.args.sqrtPriceX96.toString(), liquidity: e.args.liquidity.toString(), tick: Number(e.args.tick), fee: Number(e.args.fee), ...base };
      return { kind: "initialize", poolId: lower(e.args.id), currency0: lower(e.args.currency0), currency1: lower(e.args.currency1), fee: Number(e.args.fee), tickSpacing: Number(e.args.tickSpacing), hooks: lower(e.args.hooks), sqrtPriceX96: e.args.sqrtPriceX96.toString(), tick: Number(e.args.tick), ...base };
    }
  } catch { return null; }
  return null;
}

/**
 * A decoded swap as a trade of the launch token. v4 deltas are the swapper's: the token leg positive
 * is a buy. The quote amount is the pool's own delta, before the hook's tax on top of it.
 */
export function classifySwap(swap, { tokenIs0, quoteDecimals = QUOTE_DECIMALS }) {
  const a0 = BigInt(swap.amount0), a1 = BigInt(swap.amount1);
  const tokenDelta = tokenIs0 ? a0 : a1, quoteDelta = tokenIs0 ? a1 : a0;
  const abs = (x) => (x < 0n ? -x : x);
  // A swap that moved no tokens (a buy the empty position could not fill) is neither side.
  return { side: tokenDelta > 0n ? "buy" : tokenDelta < 0n ? "sell" : null, tokens: toTokens(abs(tokenDelta)), quote: toUsdc(abs(quoteDelta), quoteDecimals) };
}

// ── Tick and price arithmetic. A sqrt price here is the plain ratio (sqrtPriceX96 / 2^96), which a
// double carries with more precision than any quote needs. ──
const Q96 = 2 ** 96;
export const sqrtRatioAtTick = (tick) => Math.pow(1.0001, tick / 2);
export const sqrtRatioFromX96 = (x) => Number(x) / Q96;
export const sqrtRatioToX96 = (r) => BigInt(Math.round(r * Q96));
// The float log of a price that sits exactly on a tick lands a hair either side of the integer, and a
// plain floor answered the tick below one time in nine. Within a ten-thousandth of a whole tick the
// price IS that tick; anywhere else it is between two and floors like the contract's own TickMath.
export const tickFromSqrtPriceX96 = (x) => {
  const v = (2 * Math.log(sqrtRatioFromX96(x))) / Math.log(1.0001);
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-4 ? r : Math.floor(v);
};

/**
 * The position's edges as sqrt ratios, and the current sqrt price held inside them: outside the
 * position there is no liquidity at all, so nothing trades there. A price that is not a number (or
 * is zero) stays NaN so callers can refuse it rather than quote from an edge they were never given.
 */
function rangeOf({ sqrtPriceX96, tickStart, tickBond, tokenIs0 }) {
  const start = sqrtRatioAtTick(tickStart), bond = sqrtRatioAtTick(tickBond);
  const lo = Math.min(start, bond), hi = Math.max(start, bond);
  // Missing, malformed or zero (Number(null) is 0, and v4's floor is MIN_SQRT_PRICE) is no price at all.
  const raw = sqrtPriceX96 == null ? NaN : sqrtRatioFromX96(sqrtPriceX96);
  const sp = Number.isFinite(raw) && raw > 0 ? Math.min(hi, Math.max(lo, raw)) : NaN;
  return { start, bond, sp, tokenIs0: tokenIs0 ?? Number(tickBond) > Number(tickStart) };
}
const bounded = (tickStart, tickBond) => Number.isFinite(Number(tickStart)) && Number.isFinite(Number(tickBond)) && tickStart != null && tickBond != null;

/**
 * A pool price held inside the launch position. When a buy drains the position, v4 keeps walking the
 * tick through zero liquidity until the router's own limit (one inside MIN/MAX_SQRT_PRICE), and that
 * is the number slot0 and the Swap log then report: a price with no liquidity behind it, 1e50 USDC per
 * token. The position's far edge is the last price anything traded at, so that is the mark.
 */
export function clampSqrtPriceX96(sqrtPriceX96, { tickStart, tickBond }) {
  if (!bounded(tickStart, tickBond)) return BigInt(sqrtPriceX96);
  const { sp, start } = rangeOf({ sqrtPriceX96, tickStart, tickBond });
  return sqrtRatioToX96(Number.isFinite(sp) ? sp : start);
}

/**
 * USDC per token from a pool's sqrtPriceX96. The raw ratio is currency1 units per currency0 unit;
 * when the token is currency0 that is quote per token, otherwise the inverse. Decimals differ
 * (18 for the token, 6 for the USDC view, 18 for a native-decimal quote), so the raw ratio is
 * rescaled by 10^(tokenDecimals - quoteDecimals). Given the position's ticks the price is clamped
 * into it first (see clampSqrtPriceX96); every mark that reaches the book should pass them.
 */
export function priceFromSqrtX96(sqrtPriceX96, { tokenIs0, quoteDecimals = QUOTE_DECIMALS, tokenDecimals = TOKEN_DECIMALS, tickStart, tickBond }) {
  const ratio = bounded(tickStart, tickBond) ? rangeOf({ sqrtPriceX96, tickStart, tickBond }).sp : sqrtRatioFromX96(sqrtPriceX96);
  const raw = ratio ** 2;
  if (!(raw > 0)) return 0;
  const scale = 10 ** (tokenDecimals - quoteDecimals);
  return tokenIs0 ? raw * scale : scale / raw;
}
/** Market cap in the quote asset: the price times the fixed supply. */
export function mcapQuote(price) { return Number(price) > 0 ? Number(price) * TOKEN_SUPPLY : 0; }

/**
 * The hook's snipe surcharge for an ordinary trader `elapsedMs` after launch. Argus documents only
 * the shape: it runs for three seconds and the combined rate never exceeds 99%. The curve inside the
 * window (whole seconds since launchedAt, 9900 >> ((elapsed * 14) / 3): 9900, 618, 19, then 0) is
 * the reference LaunchHook.sol's, which that file itself asks to be verified, so nothing trusts the
 * intermediate steps: the feed refuses the whole window and the live router re-reads
 * currentSnipeTaxBps() from the hook before it sends. An unknown launch time is inside the window.
 * The Portal and the splitter are exempt, which is how the creator's own dev buy gets through.
 */
export function snipeTaxBps(elapsedMs) {
  const ms = Number(elapsedMs);
  if (elapsedMs == null || !Number.isFinite(ms)) return SNIPE_TAX_CAP_BPS;
  const elapsed = Math.max(0, Math.floor(ms / 1000));
  if (elapsed >= 3) return 0;
  const shift = Math.floor((elapsed * 14) / 3);
  return shift >= 31 ? 0 : SNIPE_TAX_CAP_BPS >> shift;
}
/**
 * What the hook withholds from a side: leg tax plus snipe tax, never past the 99% cap. A leg tax that
 * has not been read yet (the feed keeps it null until the hook answers) or a snipe tax nobody
 * computed is priced at the cap, not at zero: an unknown cost is the worst case until it is known.
 */
export function combinedTaxBps(legBps, snipeBps = 0) {
  const leg = Number(legBps), snipe = Number(snipeBps ?? 0);
  if (legBps == null || !Number.isFinite(leg) || !Number.isFinite(snipe)) return SNIPE_TAX_CAP_BPS;
  return Math.min(SNIPE_TAX_CAP_BPS, leg + snipe);
}

/**
 * 0..1 of the way from the opening tick to the bond tick, LaunchHook.milestoneProgress() in floats.
 * Direction is whatever the currency order made it: the bond tick is above the start when the token
 * is currency0 and below it otherwise, and the ratio is the same either way. Display only: the
 * hook's bonded latch does not clear when the tick retreats, this number does. A bound that is not
 * known (Portal #3 records carry no tickBond until the hook answers) is null, never a false zero.
 */
export function progress(tick, tickStart, tickBond) {
  if (!bounded(tickStart, tickBond) || tick == null || !Number.isFinite(Number(tick))) return null;
  const span = Number(tickBond) - Number(tickStart);
  if (!span) return 0;
  return Math.min(1, Math.max(0, (Number(tick) - Number(tickStart)) / span));
}

/**
 * Liquidity of the launch position: the whole supply, one-sided, between tickStart and tickBond with
 * the price sitting at tickStart. Uniswap's own amount-to-liquidity formulas for a range entirely
 * above (token is currency0) or entirely below (token is currency1) the current price.
 */
export function liquidityForSupply({ tickStart, tickBond, tokenIs0 = Number(tickBond) > Number(tickStart), supply = TOKEN_SUPPLY, tokenDecimals = TOKEN_DECIMALS }) {
  const a = Math.min(sqrtRatioAtTick(tickStart), sqrtRatioAtTick(tickBond)), b = Math.max(sqrtRatioAtTick(tickStart), sqrtRatioAtTick(tickBond));
  const units = supply * 10 ** tokenDecimals;
  return tokenIs0 ? (units * a * b) / (b - a) : units / (b - a);
}

/**
 * Buy quote inside the single launch position, so Uniswap's within-range formulas are exact:
 *   quote is currency1 (token is 0): dy = L * (sqrtQ - sqrtP), dx = L * (sqrtQ - sqrtP) / (sqrtP * sqrtQ)
 *   quote is currency0 (token is 1): dx = L * (1/sqrtQ - 1/sqrtP), dy = L * (sqrtP - sqrtQ)
 * Money flow as the hook and the pool take it: the hook keeps (buyTax + snipe) bps of the USDC the
 * trader specified, in beforeSwap and before the pool sees any of it; the pool takes its 1% fee off
 * what reaches it, and the rest moves the price. A buy that would run past tickBond stops there with
 * `capped` set: beyond the position there is nothing to buy, the pool leaves the rest unconsumed, but
 * the tax on the whole stake is already gone, so `usdcUsed` (what leaves the wallet) is the consumed
 * pool leg plus the full tax. A capped buy is not an order the routers should send.
 * The model assumes the launch position is the only liquidity, which v4 does not enforce (anyone can
 * add a range on top and the reference hook does not stop them). Foreign liquidity makes the quote
 * optimistic, which the dry run's min-out then rejects; the fallback for that is the v4 Quoter.
 * @param pool  { sqrtPriceX96, liquidity, tickStart, tickBond, buyTaxBps, snipeBps, tokenIs0?, quoteDecimals?, lpFeePips? }
 * @param usdcIn  USDC the trader sends, tax included
 */
export function quoteBuy(pool, usdcIn) {
  const { bond, start, sp, tokenIs0 } = rangeOf(pool);
  const L = Number(pool.liquidity), qd = pool.quoteDecimals ?? QUOTE_DECIMALS, feeFrac = (pool.lpFeePips ?? POOL_FEE_PIPS) / 1e6;
  const taxFrac = combinedTaxBps(pool.buyTaxBps, pool.snipeBps) / BASIS_POINTS;
  const spot = Number.isFinite(sp) ? priceFromSqrtX96(sqrtRatioToX96(sp), { tokenIs0, quoteDecimals: qd }) : 0;
  if (!(L > 0) || !(usdcIn > 0) || !Number.isFinite(sp)) return { tokensOut: 0, usdcUsed: 0, usdcTaxed: 0, usdcLpFee: 0, sqrtPriceAfter: sqrtRatioToX96(Number.isFinite(sp) ? sp : start), priceAfter: spot, avgPrice: 0, spot, slippage_bps: 0, capped: false };
  let moving = usdcIn * (1 - taxFrac) * (1 - feeFrac) * 10 ** qd; // raw quote units that move the price
  let sq, capped = false, tokensRaw;
  if (tokenIs0) {
    sq = sp + moving / L;
    if (sq > bond) { sq = bond; capped = true; moving = L * (bond - sp); }
    tokensRaw = (L * (sq - sp)) / (sp * sq);
  } else {
    sq = 1 / (1 / sp + moving / L);
    if (sq < bond) { sq = bond; capped = true; moving = L * (1 / bond - 1 / sp); }
    tokensRaw = L * (sp - sq);
  }
  const usdcToPool = moving / (1 - feeFrac) / 10 ** qd;
  const usdcTaxed = usdcIn * taxFrac;
  const usdcUsed = usdcToPool + usdcTaxed;
  const tokensOut = tokensRaw / 10 ** TOKEN_DECIMALS;
  const impact = tokensOut > 0 ? moving / 10 ** qd / tokensOut : spot;
  return {
    tokensOut, usdcUsed, usdcTaxed, usdcLpFee: usdcToPool * feeFrac,
    sqrtPriceAfter: sqrtRatioToX96(sq), priceAfter: priceFromSqrtX96(sqrtRatioToX96(sq), { tokenIs0, quoteDecimals: qd }),
    avgPrice: tokensOut > 0 ? usdcUsed / tokensOut : 0, spot, slippage_bps: (impact / spot - 1) * 1e4, capped,
    tickStart: Number(pool.tickStart), tickBond: Number(pool.tickBond),
  };
}

/**
 * Sell quote, the same position walked back toward tickStart. The pool's 1% fee comes off the tokens
 * sent in, the hook keeps (sellTax + snipe) bps of the USDC the pool pays out. Below tickStart the
 * position holds nothing, so a sell that would cross it is capped there: the pool can only give back
 * the USDC it took in, and `tokensUsed` is what it accepted. The same single-position assumption as
 * quoteBuy: foreign liquidity overquotes every chunk of a ladder, and the v4 Quoter is the fallback.
 * @param pool  { sqrtPriceX96, liquidity, tickStart, tickBond, sellTaxBps, snipeBps, tokenIs0?, quoteDecimals?, lpFeePips? }
 * @param tokensIn  tokens the trader sends
 */
export function quoteSell(pool, tokensIn) {
  const { start, sp, tokenIs0 } = rangeOf(pool);
  const L = Number(pool.liquidity), qd = pool.quoteDecimals ?? QUOTE_DECIMALS, feeFrac = (pool.lpFeePips ?? POOL_FEE_PIPS) / 1e6;
  const taxFrac = combinedTaxBps(pool.sellTaxBps, pool.snipeBps) / BASIS_POINTS;
  const spot = Number.isFinite(sp) ? priceFromSqrtX96(sqrtRatioToX96(sp), { tokenIs0, quoteDecimals: qd }) : 0;
  if (!(L > 0) || !(tokensIn > 0) || !Number.isFinite(sp)) return { usdcOut: 0, usdcGross: 0, usdcTaxed: 0, tokensUsed: 0, tokensLpFee: 0, sqrtPriceAfter: sqrtRatioToX96(Number.isFinite(sp) ? sp : start), priceAfter: spot, avgPrice: 0, spot, slippage_bps: 0, capped: false };
  let moving = tokensIn * (1 - feeFrac) * 10 ** TOKEN_DECIMALS; // raw token units that move the price
  let sq, capped = false, quoteRaw;
  if (tokenIs0) {
    sq = 1 / (1 / sp + moving / L);
    if (sq < start) { sq = start; capped = true; moving = L * (1 / start - 1 / sp); }
    quoteRaw = L * (sp - sq);
  } else {
    sq = sp + moving / L;
    if (sq > start) { sq = start; capped = true; moving = L * (start - sp); }
    quoteRaw = (L * (sq - sp)) / (sp * sq);
  }
  const tokensUsed = moving / (1 - feeFrac) / 10 ** TOKEN_DECIMALS;
  const usdcGross = quoteRaw / 10 ** qd;
  const usdcOut = usdcGross * (1 - taxFrac);
  const impact = moving > 0 ? usdcGross / (moving / 10 ** TOKEN_DECIMALS) : spot;
  return {
    usdcOut, usdcGross, usdcTaxed: usdcGross - usdcOut, tokensUsed, tokensLpFee: tokensUsed * feeFrac,
    sqrtPriceAfter: sqrtRatioToX96(sq), priceAfter: priceFromSqrtX96(sqrtRatioToX96(sq), { tokenIs0, quoteDecimals: qd }),
    avgPrice: tokensUsed > 0 ? usdcOut / tokensUsed : 0, spot, slippage_bps: (1 - impact / spot) * 1e4, capped,
    tickStart: Number(pool.tickStart), tickBond: Number(pool.tickBond),
  };
}
