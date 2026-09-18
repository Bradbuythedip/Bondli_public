// ═══ Arc routers: paper (single-position model) and live (ethers wallet on Arc) (DP4) ═══
// Fill records keep the engine's field names: sol_spent / sol_received are the QUOTE asset (USDC)
// spent and received, gas included, and reference.solPrice is the USDC price in USD, which is 1.
// There is no ETH-style quote price to fetch or to go stale here, so the NO_QUOTE_PRICE and
// STALE_QUOTE_PRICE refusals the PONS router makes do not exist on this venue: a missing solPrice
// is read as the dollar it is.
//
// One balance, two faces. Arc's gas asset is USDC. The wallet's native balance (getBalance, msg.value,
// gas) carries it with 18 decimals like ETH; the enshrined ERC-20 at 0x3600...0000 shows the SAME
// money with 6 decimals. Moving one moves the other. Preflight reads the native face (one call, no
// contract), the swap pays through the ERC-20 face (Permit2 pulls it), and the platform fee leaves
// as a native transfer. Getting a face wrong is not a rounding error, it is a factor of 10^12.
import { Wallet, JsonRpcProvider, Contract, Interface, AbiCoder, MaxUint256, ZeroAddress, zeroPadValue, parseUnits } from "ethers";
import { PaperRouter, Router, failure } from "../../core/router.mjs";
import { errorText } from "../../core/feed.mjs";
import {
  EXPLORER, CHAIN_ID, DEFAULT_RPC_URLS, PORTALS, POOL_MANAGER, STATE_VIEW, UNIVERSAL_ROUTER, PERMIT2, USDC_ERC20,
  QUOTE_IS_NATIVE, QUOTE_DECIMALS, NATIVE_DECIMALS, TOKEN_DECIMALS, POOL_FEE_PIPS, TICK_SPACING, SNIPE_TAX_WINDOW_MS,
  HOOK_ABI, STATE_VIEW_ABI, ERC20_ABI, TOPICS, hookIface, portalIface, erc20Iface,
  decodeLog, classifySwap, quoteBuy, quoteSell, snipeTaxBps, poolIdFor, toUsdc, toUsdcUnits, toNativeUsdc, toTokens, SNIPE_TAX_CAP_BPS,
} from "./chain.mjs";
import { decodeLaunchWords } from "./feed.mjs";

// The worst price a sell may ever accept, as a share of the pool's own quote for that exact size.
// Below this the trade is not worth making at all: the position is better left open for one more
// tick than handed over at a price nobody would agree to in advance.
const MIN_SELL_KEEP = 0.85;
// Half a second past the hook's own window, for a clock that is not the chain's. Inside it a buy
// pays up to 99% to the hook: not a trade, a donation.
export const SNIPE_REFUSE_MS = SNIPE_TAX_WINDOW_MS + 500;
// What a swap's gas could cost in USDC when the node will not say: Arc gas is cheap, but a buy that
// leaves the wallet unable to pay for its own sell is a position that cannot be closed.
const GAS_RESERVE_USDC = 0.05;
const MAX_UINT160 = (1n << 160n) - 1n, MAX_UINT48 = (1n << 48n) - 1n;

// UniversalRouter: one call, a byte string of commands, one ABI-encoded input per command. A v4
// swap is command 0x10 whose input is (bytes actions, bytes[] params): swap the exact input in a
// single pool, settle everything owed in the input currency, take everything owed in the output.
export const UR_COMMANDS = Object.freeze({ V4_SWAP: 0x10 });
export const V4_ACTIONS = Object.freeze({ SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f });
export const UNIVERSAL_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
];
export const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];
// Errors the trade can revert with that no ABI in chain.mjs declares: the UniversalRouter's, v4's
// core and its Permit2 pull. Named here so a dry run's failure says which limit it hit instead of
// eight hex digits.
export const ROUTER_ERRORS_ABI = [
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error TransactionDeadlinePassed()",
  "error InsufficientBalance()",
  "error InsufficientToken()",
  "error PoolNotInitialized()",
  "error HookCallFailed()",
  "error CurrencyNotSettled()",
  "error DeltaNotPositive(address currency)",
  "error DeltaNotNegative(address currency)",
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error AllowanceExpired(uint256 deadline)",
  "error InsufficientAllowance(uint256 amount)",
];
export const universalRouterIface = new Interface(UNIVERSAL_ROUTER_ABI);
export const permit2Iface = new Interface(PERMIT2_ABI);
export const routerErrorsIface = new Interface(ROUTER_ERRORS_ABI);
const SWAP_PARAMS = "tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)";
const coder = AbiCoder.defaultAbiCoder();
const lower = (a) => String(a).toLowerCase();
const isZero = (a) => !a || /^0x0*$/.test(String(a));

/** The v4 pool key the Portal registered: currencies in address order, the 1% tier, the launch's hook. */
export function poolKeyFor(pool) {
  const quote = QUOTE_IS_NATIVE ? ZeroAddress : pool.quoteAsset || USDC_ERC20;
  const tokenIs0 = pool.tokenIs0 ?? BigInt(pool.token) < BigInt(quote);
  return { currency0: tokenIs0 ? pool.token : quote, currency1: tokenIs0 ? quote : pool.token, fee: pool.fee ?? POOL_FEE_PIPS, tickSpacing: pool.tickSpacing ?? TICK_SPACING, hooks: pool.hook, tokenIs0, quote };
}

/**
 * The exact bytes of one exact-input swap through the UniversalRouter, as execute() takes them.
 * A buy pays the quote currency for the token, a sell the reverse; zeroForOne follows from which
 * side of the key the input sits on. Returns { commands, inputs } plus what they encode, so a
 * caller (or a test) can read back what will be sent.
 */
export function encodeV4Swap({ pool, side, amountIn, minOut }) {
  const key = poolKeyFor(pool);
  const buy = side === "BUY";
  const inputCurrency = buy ? key.quote : pool.token, outputCurrency = buy ? pool.token : key.quote;
  const zeroForOne = lower(inputCurrency) === lower(key.currency0);
  const actions = "0x" + [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL].map(a => a.toString(16).padStart(2, "0")).join("");
  const params = [
    coder.encode([SWAP_PARAMS], [[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], zeroForOne, amountIn, minOut, "0x"]]),
    coder.encode(["address", "uint256"], [inputCurrency, amountIn]),
    coder.encode(["address", "uint256"], [outputCurrency, minOut]),
  ];
  const commands = "0x" + UR_COMMANDS.V4_SWAP.toString(16).padStart(2, "0");
  return { commands, inputs: [coder.encode(["bytes", "bytes[]"], [actions, params])], actions, key, zeroForOne, inputCurrency, outputCurrency, amountIn, minOut };
}

/** Read an execute() call back into the swap it carries, or null when it is not one v4 swap. */
export function decodeV4Swap(commands, inputs) {
  if (String(commands).toLowerCase() !== "0x10" || !inputs?.length) return null;
  const [actions, params] = coder.decode(["bytes", "bytes[]"], inputs[0]);
  const [p] = coder.decode([SWAP_PARAMS], params[0]);
  const [settleCurrency, settleAmount] = coder.decode(["address", "uint256"], params[1]);
  const [takeCurrency, takeAmount] = coder.decode(["address", "uint256"], params[2]);
  return {
    actions: String(actions),
    key: { currency0: p.poolKey.currency0, currency1: p.poolKey.currency1, fee: Number(p.poolKey.fee), tickSpacing: Number(p.poolKey.tickSpacing), hooks: p.poolKey.hooks },
    zeroForOne: p.zeroForOne, amountIn: BigInt(p.amountIn), minOut: BigInt(p.amountOutMinimum), hookData: p.hookData,
    settle: { currency: settleCurrency, amount: BigInt(settleAmount) }, take: { currency: takeCurrency, amount: BigInt(takeAmount) },
  };
}

/** The pool as the paper model needs it, straight from a candidate's reference.curve. */
function poolFromReference(ref = {}) {
  const c = ref.curve || {};
  if (c.sqrtPriceX96 == null || c.liquidity == null || c.tickStart == null || c.tickBond == null) return null;
  return {
    sqrtPriceX96: BigInt(c.sqrtPriceX96), liquidity: c.liquidity, tickStart: c.tickStart, tickBond: c.tickBond,
    buyTaxBps: c.feeBps, sellTaxBps: c.sellTaxBps, tokenIs0: c.tokenIs0, quoteDecimals: c.quoteDecimals ?? QUOTE_DECIMALS,
    lpFeePips: c.poolFeeBps != null ? c.poolFeeBps * 100 : POOL_FEE_PIPS,
  };
}
/** How old the launch is at `now`, from the candidate's own record; null when it does not know. */
function launchAgeMs(ref = {}, now) {
  const t = ref.token || {};
  if (t._ageUnknown) return null;
  if (Number.isFinite(Number(t.createdAt)) && Number(t.createdAt) > 0 && Number.isFinite(now)) return now - Number(t.createdAt);
  if (Number.isFinite(Number(t._ageMs))) return Number(t._ageMs);
  return null;
}

/**
 * Paper fills from the same single-position math the live router quotes with. The snipe tax is
 * charged at order time: a paper buy inside the hook's window shows the 99% it would have paid,
 * because a model that ignored it would teach the learner that sniping works.
 */
export function arcFillModel(order, ctx = {}) {
  const ref = order.reference || {};
  const price = Number(ref.solPrice) > 0 ? Number(ref.solPrice) : 1; // USDC is the dollar
  const pool = poolFromReference(ref);
  if (!pool) return { reject: "NO_POOL", reason: "reference has no pool state (sqrtPriceX96, liquidity, ticks)" };
  if (pool.buyTaxBps == null || pool.sellTaxBps == null) return { reject: "NO_POOL", reason: "reference has no hook terms yet (taxes unknown)" };
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const age = launchAgeMs(ref, now);
  // An unknown launch time is priced as the launch block on a buy, as chain.mjs does; a sell owes no snipe tax.
  const snipeBps = age == null ? (order.side === "BUY" ? SNIPE_TAX_CAP_BPS : 0) : snipeTaxBps(age);
  if (order.side === "BUY") {
    const usdcIn = Number(order.stake_usd) / price;
    if (!(usdcIn > 0)) return { reject: "ZERO_STAKE", reason: "stake is zero" };
    const q = quoteBuy({ ...pool, snipeBps }, usdcIn);
    if (!(q.tokensOut > 0)) return { reject: "NO_POOL", reason: "the position has nothing left to buy" };
    return { price: q.avgPrice * price, qty: q.tokensOut, notional_usd: q.usdcUsed * price, slippage_bps: q.slippage_bps, fee_usd: (q.usdcTaxed + q.usdcLpFee) * price, tax_usd: q.usdcTaxed * price, snipe_bps: snipeBps, capped: q.capped };
  }
  const qty = Number(order.qty) || 0;
  if (!(qty > 0)) return { reject: "ZERO_QTY", reason: "nothing to sell" };
  const q = quoteSell({ ...pool, snipeBps }, qty);
  return { price: q.avgPrice * price, qty: q.tokensUsed, notional_usd: q.usdcOut * price, slippage_bps: q.slippage_bps, fee_usd: (q.usdcTaxed + q.tokensLpFee * q.spot) * price, tax_usd: q.usdcTaxed * price, snipe_bps: snipeBps, capped: q.capped };
}

export class ArcPaperRouter extends PaperRouter {
  constructor({ bookFile, clock, latencyMs = 5 } = {}) {
    const now = clock || (() => Date.now());
    // The model needs the order's time to charge the snipe tax; the paper book's clock is the one
    // source of it, so it rides in the context.
    super({ venue: "arc", clock, bookFile, fillModel: (order, ctx = {}) => arcFillModel(order, { now: now(), ...ctx }), latencyMs });
  }
}

/** A live router on an EVM wallet. `secret` is the 0x-prefixed private key of a dedicated wallet. */
export class ArcLiveRouter extends Router {
  constructor({ secret = null, rpcUrl = null, provider = null, slippagePct = 15, confirmTimeoutMs = 15_000, gasLimitBuy = 600_000n, gasLimitSell = 600_000n, clock, fetchImpl = globalThis.fetch } = {}) {
    super({ venue: "arc", mode: "live", clock });
    this.secret = secret; this.rpcUrl = rpcUrl; this.provider = provider; this.slippagePct = slippagePct; this.confirmTimeoutMs = confirmTimeoutMs;
    this.gasLimitBuy = gasLimitBuy; this.gasLimitSell = gasLimitSell;
    // Best effort, never load-bearing: the explorer ABI and the signature database only turn a bare
    // selector into a name. Injectable so the suite never depends on somebody else's uptime.
    this.fetch = fetchImpl;
    this.ready = false; this.address = null; this.known = new Set(); this._pools = new Map(); // tokens this wallet has been told about (EVM has no account enumeration)
    this._permit2Code = null; // whether Permit2 has code on this chain, once checked
    this._approved = new Set(); // currencies whose Permit2 path this process has already set up
  }

  async init() {
    if (this.secret == null) this.secret = process.env.ARC_PRIVATE_KEY;
    if (this.rpcUrl == null) this.rpcUrl = process.env.ARC_RPC_URL || DEFAULT_RPC_URLS[0];
    if (!this.secret) throw new Error("arc live router needs an EVM private key (ARC_PRIVATE_KEY, 0x-hex) for a dedicated wallet");
    if (!this.provider) this.provider = new JsonRpcProvider(this.rpcUrl, { chainId: CHAIN_ID, name: "arc" }, { staticNetwork: true });
    this.wallet = new Wallet(this.secret.trim(), this.provider);
    this.address = this.wallet.address;
    this.ready = true;
    return this.preflight();
  }

  /** The wallet's USDC, read from the native face: getBalance answers in 18 decimals, and that is
   *  the same money the 6-decimal ERC-20 view shows. `balanceSol` keeps the engine's name for
   *  "quote balance" because the engine reads that field on every venue. */
  async preflight() {
    if (!this.ready) throw new Error("call init() first");
    const t0 = Date.now();
    // The provider is pinned to Arc's chain id, so a transaction signed here is invalid anywhere
    // else; an RPC that answers for another chain is still refused here, at go-live, rather than
    // discovered at the first send.
    const chainHex = await this.provider.send("eth_chainId", []);
    if (Number(chainHex) !== CHAIN_ID) throw new Error(`the Arc RPC answers for chain ${Number(chainHex)}, not Arc (${CHAIN_ID}); check ARC_RPC_URL`);
    const wei = await this.provider.getBalance(this.address);
    const balanceUsdc = toNativeUsdc(wei);
    return { wallet: this.address, balanceSol: balanceUsdc, balanceUsdc, quote: "USDC", rpc: String(this.rpcUrl || "").split("?")[0], rpcLatencyMs: Date.now() - t0, chainId: CHAIN_ID };
  }

  track(token) { this.known.add(lower(token)); }
  async _quoteBalance() { return toNativeUsdc(await this.provider.getBalance(this.address)); }
  async _tokenBalance(token) { const c = new Contract(token, ERC20_ABI, this.provider); return toTokens(await c.balanceOf(this.address)); }

  async _waitReceipt(hash, budgetMs) {
    const deadline = this.clock() + budgetMs;
    while (this.clock() < deadline) {
      const r = await this.provider.getTransactionReceipt(hash).catch(() => null);
      if (r) return r;
      await new Promise(res => setTimeout(res, 800));
    }
    return null;
  }

  /** What one swap's gas could cost, in USDC: the node's fee if it will say, a fixed reserve if not. */
  async _gasReserve(gasLimit) {
    try {
      const fee = await this.provider.getFeeData();
      const price = fee.maxFeePerGas ?? fee.gasPrice;
      if (price != null && price > 0n) return Math.max(GAS_RESERVE_USDC / 10, toNativeUsdc(BigInt(gasLimit) * BigInt(price)));
    } catch {}
    return GAS_RESERVE_USDC;
  }

  /** The trade this receipt carried on `pool`, the hook's tax on it, and the gas it burned, in USDC. */
  _receiptDeltas(receipt, pool) {
    const gasUsdc = receipt.gasUsed != null && (receipt.gasPrice ?? receipt.effectiveGasPrice) != null ? toNativeUsdc(BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice ?? receipt.effectiveGasPrice)) : 0;
    const logs = receipt.logs || [];
    const swap = logs.filter(l => lower(l.address) === lower(POOL_MANAGER) && lower(l.topics?.[1] || "") === lower(pool.poolId)).map(decodeLog).find(r => r?.kind === "swap") || null;
    const trade = swap ? { ...classifySwap(swap, { tokenIs0: pool.tokenIs0, quoteDecimals: pool.quoteDecimals }), sqrtPriceX96: swap.sqrtPriceX96, tick: swap.tick } : null;
    let tax = 0;
    for (const l of logs) {
      if (lower(l.address) !== lower(pool.hook) || l.topics?.[0] !== TOPICS.TaxCollected) continue;
      try { const e = hookIface.parseLog({ topics: l.topics, data: l.data }); tax += toUsdc(e.args.amount, pool.quoteDecimals); } catch {}
    }
    return { gasUsdc, trade, tax, reverted: receipt.status === 0 };
  }

  /** The pool behind a token: from the reference, from memory, or from the Portals (an adopted
   *  position can carry none). Each Portal keeps its launches' records forever, so every v4 Portal
   *  is asked, newest first. */
  async _poolFor(instrument, hint = null) {
    const key = lower(instrument);
    if (hint?.hook && hint?.address) {
      const pool = { token: key, poolId: lower(hint.address), hook: lower(hint.hook), quoteAsset: lower(hint.quoteAsset || USDC_ERC20), quoteDecimals: hint.quoteDecimals ?? QUOTE_DECIMALS, tokenIs0: hint.tokenIs0 ?? (BigInt(key) < BigInt(hint.quoteAsset || USDC_ERC20)), tickStart: hint.tickStart ?? null, tickBond: hint.tickBond ?? null };
      this._pools.set(key, pool); return pool;
    }
    if (this._pools.has(key)) return this._pools.get(key);
    const data = portalIface.encodeFunctionData("launches", [instrument]);
    for (const p of PORTALS) {
      if (p.family !== "v4") continue;
      let rec = null;
      try { rec = decodeLaunchWords(await this.provider.call({ to: p.address, data })); } catch { continue; }
      if (!rec) continue;
      const quoteAsset = lower(rec.quoteAsset || USDC_ERC20);
      const pool = { token: key, poolId: lower(poolIdFor({ token: key, quoteAsset, hook: rec.hook })), hook: lower(rec.hook), quoteAsset, quoteDecimals: QUOTE_DECIMALS, tokenIs0: rec.tokenIsToken0, tickStart: rec.tickStart, tickBond: rec.tickBond, portal: lower(p.address) };
      this._pools.set(key, pool);
      return pool;
    }
    return null;
  }

  /** What the pool and its hook say right now: price, liquidity, taxes, the launch time the snipe
   *  window is measured from, and the ticks when the pool record did not carry them. */
  async _poolNow(pool) {
    const sv = new Contract(STATE_VIEW, STATE_VIEW_ABI, this.provider);
    const h = new Contract(pool.hook, HOOK_ABI, this.provider);
    const [slot, liquidity, buyTaxBps, sellTaxBps, launchedAt, snipe, tickStart, tickBond] = await Promise.all([
      sv.getSlot0(pool.poolId), sv.getLiquidity(pool.poolId), h.buyTaxBps(), h.sellTaxBps(), h.launchedAt().catch(() => 0n), h.currentSnipeTaxBps().catch(() => 0n),
      pool.tickStart == null ? h.tickStart() : pool.tickStart, pool.tickBond == null ? h.tickBond() : pool.tickBond,
    ]);
    pool.tickStart = Number(tickStart); pool.tickBond = Number(tickBond);
    return {
      sqrtPriceX96: BigInt(slot.sqrtPriceX96), tick: Number(slot.tick), lpFeePips: Number(slot.lpFee) || POOL_FEE_PIPS, liquidity: liquidity.toString(),
      buyTaxBps: Number(buyTaxBps), sellTaxBps: Number(sellTaxBps), launchedAt: Number(launchedAt) * 1000, snipeBps: Number(snipe),
      tickStart: pool.tickStart, tickBond: pool.tickBond, tokenIs0: pool.tokenIs0, quoteDecimals: pool.quoteDecimals,
    };
  }

  /** The Permit2 path for one currency, set up once: the ERC-20 lets Permit2 move it, Permit2 lets
   *  the UniversalRouter draw on that. Both approvals are one-time and unbounded, so a hot path
   *  pays no approval gas. Permit2's address is assumed canonical (chain.mjs), so its code is
   *  checked before anything is approved to it. Returns null when ready, or a failure. */
  async _ensurePermit2(currency, units, orderId) {
    if (this._permit2Code == null) {
      const code = await this.provider.getCode(PERMIT2).catch(() => "0x");
      this._permit2Code = !isZero(code);
    }
    if (!this._permit2Code) return failure({ id: orderId }, "UNSUPPORTED", `Permit2 has no code at ${PERMIT2} on this chain; the UniversalRouter cannot pull ERC-20 input`);
    const key = lower(currency);
    const erc = new Contract(currency, ERC20_ABI, this.wallet);
    const p2 = new Contract(PERMIT2, PERMIT2_ABI, this.wallet);
    const nowSec = BigInt(Math.floor(this.clock() / 1000));
    if (!this._approved.has(key)) {
      const allowance = BigInt(await erc.allowance(this.address, PERMIT2));
      if (allowance < units) {
        const a = await erc.approve(PERMIT2, MaxUint256);
        const ar = await this._waitReceipt(a.hash, this.confirmTimeoutMs);
        if (!ar) return failure({ id: orderId }, "UNCONFIRMED", `approve ${a.hash} not confirmed within ${this.confirmTimeoutMs}ms`, { venue_ref: a.hash });
        if (ar.status === 0) return failure({ id: orderId }, "SEND_FAILED", `approve ${a.hash} reverted`, { venue_ref: a.hash });
      }
      const [amount, expiration] = await p2.allowance(this.address, currency, UNIVERSAL_ROUTER);
      if (BigInt(amount) < units || BigInt(expiration) <= nowSec) {
        const a = await p2.approve(currency, UNIVERSAL_ROUTER, MAX_UINT160, MAX_UINT48);
        const ar = await this._waitReceipt(a.hash, this.confirmTimeoutMs);
        if (!ar) return failure({ id: orderId }, "UNCONFIRMED", `permit2 approve ${a.hash} not confirmed within ${this.confirmTimeoutMs}ms`, { venue_ref: a.hash });
        if (ar.status === 0) return failure({ id: orderId }, "SEND_FAILED", `permit2 approve ${a.hash} reverted`, { venue_ref: a.hash });
      }
      this._approved.add(key);
    }
    return null;
  }

  /** The exact call that would be sent, run without sending it. Returns { ok:true, gasLimit } or
   *  { ok:false, err }: a revert here costs nothing and carries its reason. */
  async _dryRun(swap, { gasLimit, value = 0n }) {
    const ur = new Contract(UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, this.wallet);
    const deadline = this._deadline();
    try {
      await ur.execute.staticCall(swap.commands, swap.inputs, deadline, { value });
      let limit = gasLimit;
      try { const est = await ur.execute.estimateGas(swap.commands, swap.inputs, deadline, { value }); limit = est * 13n / 10n; if (limit < gasLimit) limit = gasLimit; } catch {}
      return { ok: true, gasLimit: limit };
    } catch (err) { return { ok: false, err }; }
  }
  _deadline() { return Math.floor(this.clock() / 1000) + 120; }
  _isRevert(e) { return e?.code === "CALL_EXCEPTION" || /revert|CALL_EXCEPTION|execution/i.test(String(e?.message || e?.shortMessage || "")); }

  async submit(order) {
    if (!this.ready) return failure(order, "NOT_READY", "call init() first");
    if (order.legs?.length) return failure(order, "UNSUPPORTED", "arc has no multi-leg orders");
    const ref = order.reference || {}, price = Number(ref.solPrice) > 0 ? Number(ref.solPrice) : 1;
    const hint = ref.curve || {};
    if (!hint.address || !hint.hook) return failure(order, "NO_POOL", "reference has no pool id and hook");
    if (hint.quoteAsset && lower(hint.quoteAsset) !== lower(USDC_ERC20)) return failure(order, "UNSUPPORTED", "this launch is quoted in an ERC-20 other than USDC");
    // The candidate's own record of the launch time first: a refusal here costs no RPC. The hook's
    // launchedAt is checked again below, because the chain's clock is the one the tax runs on.
    const age = launchAgeMs(ref, this.clock());
    if (age != null && age < SNIPE_REFUSE_MS) return failure(order, "SNIPE_WINDOW", `launch is ${Math.round(age)}ms old; a buy inside ${SNIPE_REFUSE_MS}ms pays the hook's snipe tax`);
    const est = arcFillModel({ ...order, side: "BUY" }, { now: this.clock() });
    if (est.reject) return failure(order, est.reject, est.reason);
    if (Number.isFinite(order.max_slippage_bps) && est.slippage_bps > order.max_slippage_bps) return failure(order, "SLIPPAGE_CAP", `pool slippage ${est.slippage_bps.toFixed(1)}bps > cap ${order.max_slippage_bps}bps`);
    const usdcIn = +(Number(order.stake_usd) / price).toFixed(QUOTE_DECIMALS);
    const t_sent = this.clock();
    let hash = null;
    try {
      const pool = await this._poolFor(order.instrument, hint);
      const now = await this._poolNow(pool);
      const chainAge = now.launchedAt > 0 ? this.clock() - now.launchedAt : null;
      if ((chainAge != null && chainAge < SNIPE_REFUSE_MS) || now.snipeBps > 0) return failure(order, "SNIPE_WINDOW", `the hook still charges ${now.snipeBps}bps snipe tax (launched ${chainAge == null ? "?" : Math.round(chainAge)}ms ago)`);
      const q = quoteBuy({ ...now, snipeBps: 0 }, usdcIn);
      if (!(q.tokensOut > 0)) return failure(order, "NO_POOL", "the position has nothing left to buy at this price");
      const reserve = await this._gasReserve(this.gasLimitBuy);
      const bal = await this._quoteBalance();
      // The engine's own name for "quote balance too low" (its fail cooldown is keyed on it), as balanceSol is for the balance.
      if (bal < usdcIn + reserve) return failure(order, "INSUFFICIENT_SOL", `wallet has ${bal.toFixed(4)} USDC, order needs ${(usdcIn + reserve).toFixed(4)} with gas`);
      const amountIn = QUOTE_IS_NATIVE ? parseUnits(usdcIn.toFixed(NATIVE_DECIMALS), NATIVE_DECIMALS) : toUsdcUnits(usdcIn, pool.quoteDecimals);
      // Whole units of the token, never a float rounding up past what the pool will give.
      const minOut = BigInt(Math.floor(q.tokensOut * (1 - this.slippagePct / 100) * 1e6)) * 10n ** BigInt(TOKEN_DECIMALS - 6);
      if (!(minOut > 0n)) return failure(order, "NO_POOL", "the quote is too small to set a price floor");
      if (!QUOTE_IS_NATIVE) { const f = await this._ensurePermit2(pool.quoteAsset, amountIn, order.id); if (f) return f; }
      const swap = encodeV4Swap({ pool, side: "BUY", amountIn, minOut });
      const value = QUOTE_IS_NATIVE ? amountIn : 0n;
      const dry = await this._dryRun(swap, { gasLimit: this.gasLimitBuy, value });
      if (!dry.ok) {
        if (!this._isRevert(dry.err)) throw dry.err;
        return failure(order, "REVERT", `buy would revert (${await this._explainRevert(pool, dry.err)})`.slice(0, 300));
      }
      const ur = new Contract(UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, this.wallet);
      const tx = await ur.execute(swap.commands, swap.inputs, this._deadline(), { value, gasLimit: dry.gasLimit });
      hash = tx.hash; this.track(order.instrument);
      const receipt = await this._waitReceipt(hash, this.confirmTimeoutMs);
      if (!receipt) return failure(order, "UNCONFIRMED", `tx ${hash} not confirmed within ${this.confirmTimeoutMs}ms`, { venue_ref: hash, t_sent });
      const d = this._receiptDeltas(receipt, pool);
      if (d.reverted) return failure(order, "SEND_FAILED", `tx ${hash} reverted`, { venue_ref: hash, fee_usd: d.gasUsdc * price });
      const t_filled = this.clock();
      const qty = d.trade?.tokens || q.tokensOut;
      // What the wallet actually paid: the pool's USDC leg plus the hook's tax, plus the gas. An
      // exact-input buy that runs into the bond tick consumes less than amountIn and SETTLE_ALL
      // settles only the debt, so the stake is the ceiling, not the cost; the receipt is the truth.
      const spent = (d.trade ? d.trade.quote + d.tax : usdcIn) + d.gasUsdc;
      const fee = (d.trade ? d.tax + d.trade.quote * (now.lpFeePips / 1e6) : q.usdcTaxed + q.usdcLpFee) + d.gasUsdc;
      return { ok: true, fill: { orderId: order.id, decisionId: order.decisionId || null, venue: "arc", instrument: order.instrument, side: "BUY", price: qty > 0 ? (spent * price) / qty : est.price, qty, notional_usd: +(spent * price).toFixed(4), slippage_bps: +q.slippage_bps.toFixed(2), fee_usd: +(fee * price).toFixed(4), t_sent, t_filled, latency_ms: t_filled - t_sent, venue_ref: hash, sol_spent: spent, exact: !!d.trade } };
    } catch (err) {
      return failure(order, "SEND_FAILED", errorText(err.reason || err, 300), hash ? { venue_ref: hash, t_sent } : {});
    }
  }

  /** A revert's reason. Error(string) and Panic decode by themselves; a custom error is looked up
   *  in the ABIs this venue knows (the UniversalRouter's and v4's, the hook's, the Portal's, the
   *  token's), then in the verified sources on the explorer for the hook and the token (a sell
   *  pulls tokens through Permit2, so the token's own code can be what refuses), then in a public
   *  signature database. Cached per hook; nothing here being reachable leaves the raw selector. */
  async _explainRevert(pool, err) {
    const data = err?.data || err?.info?.error?.data || null;
    const plain = err?.reason || err?.shortMessage || err?.message || "reverted";
    if (!data || typeof data !== "string" || data.length < 10 || err?.reason || /^0x(08c379a0|4e487b71)/i.test(data)) return plain.slice(0, 160);
    for (const iface of [routerErrorsIface, hookIface, portalIface, erc20Iface]) {
      try { const e = iface.parseError(data); if (e) return `${e.name}${e.args?.length ? `(${e.args.map(String).join(", ")})` : ""}`; } catch {}
    }
    if (!this._abis) this._abis = new Map();
    const key = lower(pool.hook);
    try {
      if (!this._abis.has(key)) {
        const abis = [];
        for (const addr of [key, pool.token && lower(pool.token)].filter(Boolean)) {
          const res = await this.fetch(`${EXPLORER}/api/v2/smart-contracts/${addr}`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) bondli/1.0" }, signal: AbortSignal.timeout(6000) });
          if (!res.ok) throw new Error(`explorer ${res.status}`);
          const j = await res.json();
          if (Array.isArray(j.abi)) abis.push(j.abi);
          for (const impl of j.implementations || []) { if (impl.address) { const r2 = await this.fetch(`${EXPLORER}/api/v2/smart-contracts/${impl.address}`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 bondli/1.0" }, signal: AbortSignal.timeout(6000) }).catch(() => null); const j2 = r2?.ok ? await r2.json() : null; if (Array.isArray(j2?.abi)) abis.push(j2.abi); } }
        }
        this._abis.set(key, abis.map(a => new Interface(a.filter(x => x.type === "error"))));
      }
      for (const iface of this._abis.get(key)) { const e = iface.parseError(data); if (e) return `${e.name}${e.args?.length ? `(${e.args.map(String).join(", ")})` : ""}`; }
      const named = await this._lookupSelector(data.slice(0, 10));
      return named ? `${named} (${data.slice(0, 10)})` : `custom error ${data.slice(0, 10)}`;
    } catch (e2) { return `custom error ${data.slice(0, 10)}, explorer ${e2.message.slice(0, 40)}`; }
  }

  /** Name a 4-byte error selector from a public signature database. Cached, best effort, never fatal. */
  async _lookupSelector(sel) {
    if (!this._selectors) this._selectors = new Map();
    if (this._selectors.has(sel)) return this._selectors.get(sel);
    let name = null;
    try {
      const r = await this.fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${sel}&filter=true`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(4000) });
      if (r.ok) { const j = await r.json(); name = j?.result?.function?.[sel]?.[0]?.name || null; }
    } catch {}
    this._selectors.set(sel, name);
    return name;
  }

  /** Find a sell the pool will take, without agreeing to be robbed to get one.
   *
   *  What refuses a sell is SIZE: past the opening tick the position holds no USDC at all, and a
   *  hook or a thin pool can refuse the whole order while taking a quarter. So every size is tried
   *  at a fair price before the price is widened at all, and the floor is a floor: the ladder
   *  ends at MIN_SELL_KEEP, never at a minOut of zero. A zero minOut is a sell that accepts ANY
   *  price on a pool where a sandwich costs a few dollars to run; it is how the PONS router once
   *  closed at -72% on an exit rule that only fires in profit. A sell that can only succeed with
   *  no price floor is a sell that should fail and be retried.
   *  Returns { ok, units, keep, minOut, note } or { ok:false, err }. */
  async _sellShape(pool, units, now) {
    const normal = Math.max(MIN_SELL_KEEP, 1 - this.slippagePct / 100);
    const keeps = normal > MIN_SELL_KEEP ? [normal, MIN_SELL_KEEP] : [normal];
    const fractions = [1n, 2n, 4n, 8n];
    let err = null;
    for (const keep of keeps) {
      for (const div of fractions) {
        const u = units / div; if (u <= 0n) break;
        const q = quoteSell({ ...now, snipeBps: 0 }, toTokens(u));
        const minOut = toUsdcUnits(Math.max(0, (q.usdcOut || 0) * keep), pool.quoteDecimals);
        if (!(minOut > 0n)) continue; // no floor is not a shape, it is a blank cheque
        const swap = encodeV4Swap({ pool, side: "SELL", amountIn: u, minOut });
        const dry = await this._dryRun(swap, { gasLimit: this.gasLimitSell });
        if (dry.ok) return { ok: true, units: u, keep, minOut, gasLimit: dry.gasLimit, note: `${div === 1n ? "all" : `1/${div}`} at ${Math.round(keep * 100)}% of quote` };
        err = dry.err;
        if (!this._isRevert(err)) return { ok: false, err };
      }
    }
    return { ok: false, err: err || new Error("no sell size has a price floor: the pool holds no USDC for it") };
  }

  /** Sell pct of what the wallet holds. Sizes from the wallet's exact balance (a float rounding up
   *  by one unit would revert), quotes from the pool as it is now (not a stale reference), dry-runs
   *  the sell before paying gas so a revert comes back with its reason instead of a burned fee,
   *  and lets the node estimate gas. There is no GRADUATED here: Argus never moves a pool, so the
   *  same position takes the sell before and after the bond tick. */
  async close(position, pct = 100, ctx = {}) {
    if (!this.ready) return failure({ id: position.id }, "NOT_READY", "call init() first");
    const ref = ctx.reference || position.reference || {}, price = Number(ref.solPrice) > 0 ? Number(ref.solPrice) : 1;
    const hint = ref.curve?.hook && ref.curve?.address ? ref.curve : (position.curve?.hook ? position.curve : null);
    const t_sent = this.clock();
    let hash = null;
    try {
      const pool = await this._poolFor(position.instrument, hint).catch(() => null);
      if (!pool) return failure({ id: position.id }, "NO_POOL", "no Portal knows this token; not an Argus launch, sell by hand");
      // The same guard as the buy side: a sell paid out in something other than USDC would be booked in the wrong asset.
      if (pool.quoteAsset && lower(pool.quoteAsset) !== lower(USDC_ERC20)) return failure({ id: position.id }, "UNSUPPORTED", "this launch is quoted in an ERC-20 other than USDC; sell by hand");
      this.track(position.instrument);
      if (position.pendingExit?.sig) {
        const prev = await this.resolvePending({ instrument: position.instrument, side: "SELL", sig: position.pendingExit.sig, at: position.pendingExit.at, reference: { ...ref, solPrice: price }, pool });
        if (prev.ok) return { ...prev, fill: { ...prev.fill, orderId: `${position.id}:close`, decisionId: position.decisionId, pending_pct: Number(position.pendingExit.pct) || 100 } };
        if (!prev.failure.expired) return prev;
      }
      const token = new Contract(position.instrument, ERC20_ABI, this.wallet);
      const balUnits = BigInt(await token.balanceOf(this.address));
      if (!(balUnits > 0n)) return failure({ id: position.id }, "NO_POSITION", "no token balance to sell");
      const held = toTokens(balUnits);
      const p = Math.min(100, Math.max(1, Math.round(pct)));
      const units = p >= 100 ? balUnits : balUnits * BigInt(p) / 100n;
      if (!(units > 0n)) return failure({ id: position.id }, "NO_POSITION", "nothing left to sell at that share");
      const now = await this._poolNow(pool);
      const permit = await this._ensurePermit2(position.instrument, units, position.id); if (permit) return permit;
      const shape = await this._sellShape(pool, units, now);
      if (!shape.ok) return failure({ id: position.id }, "REVERT", `sell would revert (${await this._explainRevert(pool, shape.err)})`.slice(0, 300));
      const ur = new Contract(UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI, this.wallet);
      let leftUnits = units, gotQuote = 0, feeQuote = 0, gasUsdc = 0, qtySold = 0, chunks = 0, lastHash = null, exact = true, gasLimit = shape.gasLimit;
      let state = now;
      while (leftUnits > 0n && chunks < 8) {
        const u = leftUnits < shape.units ? leftUnits : shape.units;
        const tIn = toTokens(u), q = quoteSell({ ...state, snipeBps: 0 }, tIn);
        const minOut = chunks === 0 ? shape.minOut : toUsdcUnits(Math.max(0, (q.usdcOut || 0) * shape.keep), pool.quoteDecimals);
        if (!(minOut > 0n)) break;
        const swap = encodeV4Swap({ pool, side: "SELL", amountIn: u, minOut });
        if (chunks > 0) { const dry = await this._dryRun(swap, { gasLimit: this.gasLimitSell }); if (!dry.ok) break; gasLimit = dry.gasLimit; }
        const tx = await ur.execute(swap.commands, swap.inputs, this._deadline(), { gasLimit });
        hash = lastHash = tx.hash;
        const receipt = await this._waitReceipt(hash, this.confirmTimeoutMs);
        if (!receipt) { if (chunks === 0) return failure({ id: position.id }, "UNCONFIRMED", `tx ${hash} not confirmed within ${this.confirmTimeoutMs}ms`, { venue_ref: hash, t_sent }); break; }
        const d = this._receiptDeltas(receipt, pool);
        if (d.reverted) { if (chunks === 0) return failure({ id: position.id }, "SEND_FAILED", `tx ${hash} reverted`, { venue_ref: hash, fee_usd: d.gasUsdc * price }); gasUsdc += d.gasUsdc; break; }
        // The pool paid the swap's quote; the hook kept its tax out of that before the wallet saw it.
        gasUsdc += d.gasUsdc; gotQuote += d.trade ? Math.max(0, d.trade.quote - d.tax) : q.usdcOut; feeQuote += d.trade ? d.tax + tIn * (state.lpFeePips / 1e6) * q.spot : q.usdcTaxed; qtySold += d.trade?.tokens || tIn; exact = exact && !!d.trade;
        leftUnits -= u; chunks++;
        // the pool moved: re-read it for the next chunk's quote
        if (leftUnits > 0n) { try { state = await this._poolNow(pool); } catch { if (d.trade?.sqrtPriceX96) state = { ...state, sqrtPriceX96: BigInt(d.trade.sqrtPriceX96) }; } }
      }
      const t_filled = this.clock();
      const got = Math.max(0, gotQuote - gasUsdc);
      // The loop stops early when a chunk reverts, times out, or hits the chunk limit, and the tokens
      // it did not reach are still in the wallet. Say how much of the ORDER actually filled: the
      // engine closes a position on the percentage it asked for, and an ok on a 100% request that
      // sold 60% books the position closed and abandons the rest.
      const unsold = leftUnits > 0n ? toTokens(leftUnits) : 0;
      const pctFilled = units > 0n ? Math.min(100, (Number(units - leftUnits) / Number(units)) * 100) : 0;
      return { ok: true, fill: { orderId: `${position.id}:close`, decisionId: position.decisionId, venue: "arc", instrument: position.instrument, side: "SELL", price: qtySold > 0 ? (got * price) / qtySold : 0, qty: qtySold, notional_usd: +(got * price).toFixed(4), slippage_bps: null, fee_usd: +((feeQuote + gasUsdc) * price).toFixed(4), t_sent, t_filled, latency_ms: t_filled - t_sent, venue_ref: lastHash, sol_received: got, exact, held_before: held, chunks, partial: unsold, pct_filled: +pctFilled.toFixed(2), shape: shape.note } };
    } catch (err) {
      return failure({ id: position.id }, "SEND_FAILED", errorText(err.reason || err, 300), hash ? { venue_ref: hash, t_sent } : {});
    }
  }

  /** The wallet holds none of a token and the engine has no pending signature for it. Before that
   *  is booked as a total loss, look for the sale on chain. The PoolManager logs every swap on the
   *  pool, but names the router as sender, so each candidate sale's transaction is read for its
   *  `from`; the receipt then says what the pool paid and what the hook kept.
   *  Returns { sig, solReceived, qty, at } for the most recent sale by this wallet since `since`. */
  async findRecentSale(instrument, { since = 0, blocks = 5000 } = {}) {
    if (!this.ready) return null;
    const pool = await this._poolFor(instrument).catch(() => null);
    if (!pool) return null;
    let logs;
    try {
      const head = await this.provider.getBlockNumber();
      logs = await this.provider.getLogs({ address: POOL_MANAGER, topics: [TOPICS.Swap, zeroPadValue(pool.poolId, 32)], fromBlock: Math.max(0, head - blocks), toBlock: head });
    } catch { return null; }
    const me = lower(this.address);
    // Newest first: the sale that emptied the wallet is the last one, not the first.
    for (const log of (logs || []).slice().reverse()) {
      const r = decodeLog(log);
      if (!r || r.kind !== "swap") continue;
      const trade = classifySwap(r, { tokenIs0: pool.tokenIs0, quoteDecimals: pool.quoteDecimals });
      if (trade.side !== "sell") continue;
      let from = null;
      try { const tx = await this.provider.getTransaction(r.tx); from = tx?.from ? lower(tx.from) : null; } catch {}
      if (from !== me) continue;
      let at = null;
      try { const b = await this.provider.getBlock(log.blockNumber); at = b?.timestamp ? b.timestamp * 1000 : null; } catch {}
      if (since && at && at < since) break;
      let tax = 0;
      try { const rc = await this.provider.getTransactionReceipt(r.tx); if (rc) tax = this._receiptDeltas(rc, pool).tax; } catch {}
      return { sig: r.tx, solReceived: Math.max(0, trade.quote - tax), qty: trade.tokens, at: at || this.clock() };
    }
    return null;
  }

  /** A transaction sent earlier: did it land? Reads the receipt and books what it carried. */
  async resolvePending({ instrument, side, sig, at, reference = {}, pool = null }) {
    const receipt = await this.provider.getTransactionReceipt(sig).catch(() => null);
    const price = Number(reference.solPrice) > 0 ? Number(reference.solPrice) : 1, t = this.clock();
    if (!receipt) {
      const expired = at && t - at > 10 * 60_000;
      return failure({ id: sig }, expired ? "DROPPED" : "PENDING", expired ? `tx ${sig} never landed` : `tx ${sig} still pending`, { expired: !!expired, venue_ref: sig });
    }
    const p = pool || await this._poolFor(instrument, reference.curve?.hook ? reference.curve : null).catch(() => null);
    if (!p) return failure({ id: sig }, "UNREADABLE", `tx ${sig}: no pool known for ${instrument}`, { expired: true, venue_ref: sig });
    const d = this._receiptDeltas(receipt, p);
    if (d.reverted) return failure({ id: sig }, "SEND_FAILED", `tx ${sig} reverted`, { expired: true, venue_ref: sig, fee_usd: d.gasUsdc * price });
    if (!d.trade) return failure({ id: sig }, "UNREADABLE", `tx ${sig} carries no swap on the pool`, { expired: true, venue_ref: sig });
    if (!(d.trade.tokens > 0)) return failure({ id: sig }, "UNREADABLE", `tx ${sig}: the swap moved no tokens`, { expired: true, venue_ref: sig });
    if (side === "BUY") { const spent = d.trade.quote + d.tax + d.gasUsdc; return { ok: true, fill: { venue: "arc", instrument, side: "BUY", price: (spent * price) / d.trade.tokens, qty: d.trade.tokens, notional_usd: +(spent * price).toFixed(4), slippage_bps: null, fee_usd: 0, t_sent: at || t, t_filled: t, latency_ms: at ? t - at : 0, venue_ref: sig, sol_spent: spent, late: true } }; }
    const got = Math.max(0, d.trade.quote - d.tax - d.gasUsdc);
    return { ok: true, fill: { venue: "arc", instrument, side: "SELL", price: d.trade.tokens > 0 ? (got * price) / d.trade.tokens : 0, qty: d.trade.tokens, notional_usd: +(got * price).toFixed(4), slippage_bps: null, fee_usd: 0, t_sent: at || t, t_filled: t, latency_ms: at ? t - at : 0, venue_ref: sig, sol_received: got, late: true } };
  }

  /** Plain USDC transfer from the trading wallet (the platform's performance fee), on the native
   *  face: `usdc` whole USDC becomes 18-decimal wei in msg.value, no contract call. Returns the hash. */
  async transferSol(to, usdc) {
    if (!this.ready) throw new Error("call init() first");
    const tx = await this.wallet.sendTransaction({ to, value: parseUnits(Number(usdc).toFixed(NATIVE_DECIMALS), NATIVE_DECIMALS), gasLimit: 21_000n });
    await this._waitReceipt(tx.hash, this.confirmTimeoutMs);
    return tx.hash;
  }
  transferQuote(to, amount) { return this.transferSol(to, amount); }

  async health() {
    if (!this.ready) return { ok: false, latencyMs: null, detail: "not initialised" };
    const t0 = Date.now();
    try { const b = await this.provider.getBlockNumber(); return { ok: true, latencyMs: Date.now() - t0, detail: `block ${b}` }; }
    catch (err) { return { ok: false, latencyMs: Date.now() - t0, detail: errorText(err, 200) }; }
  }

  /** Balances of the tokens this router knows about. An EVM wallet has no account list to enumerate. */
  async positions() {
    if (!this.ready) return [];
    const out = [];
    for (const token of this.known) { try { const qty = await this._tokenBalance(token); if (qty > 0) out.push({ instrument: token, qty }); } catch {} }
    return out;
  }
}
