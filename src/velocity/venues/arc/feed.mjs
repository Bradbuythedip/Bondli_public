// ═══ Arc feed: Argus launches and Uniswap v4 swaps as MarketEvents (DP1) ═══
// Polls the chain's logs: TokenCreated / PartsDeployed / CurveOpened on every Portal that ever
// launched a token, then Swap on the shared PoolManager for the pools those launches opened. Keeps
// the same per-token state the pump.fun radar and the PONS feed keep (buys, sells, distinct buyers,
// trades, spark, mcap, progress), scores it with the same composite, and emits candidates with the
// same payload shape, so the same gates, sizer and exits judge it.
// The quote asset is USDC, which IS the dollar: every "solPrice" field on this venue is 1. The
// field keeps the engine's name because the engine reads it by that name on every venue.
// There is no graduation here. Argus never migrates a pool: the same position trades before and
// after the bond tick, so `graduated` is always false and the engine's pre-graduation exit must
// not fire. What the bond tick does flip is `bonded`, which is exposed as its own flag.
// Two liquidities, never confused: the PoolManager's Swap log and StateView.getLiquidity report the
// pool's ACTIVE liquidity at the current tick, which is the launch position's L only while the price
// sits inside the range. A buy that runs to the bond crosses the position's edge and the log says 0
// (and a price far past the bond, since the router's limit is the tick maximum); a third-party LP
// after bonding makes it larger. What the engine and both routers need is the POSITION's L, which
// the Locker holds forever, so `liquidity` on a token is always that, and the raw reading is kept
// beside it as `activeLiquidity` for the record.
import { JsonRpcProvider, Contract, zeroPadValue } from "ethers";
import { Feed, errorText } from "../../core/feed.mjs";
// Score, features and dynamics read only the per-token state every EVM launchpad feed keeps
// (trades with full wallets, buyers, spark, mcap), nothing chain-specific: imported, not copied.
import { Dynamics, quickFeatures, scoreToken } from "../pons/feed.mjs";
import {
  PORTALS, POOL_MANAGER, STATE_VIEW, USDC_ERC20, DEFAULT_RPC_URL, EXPLORER, SNIPE_TAX_WINDOW_MS, QUOTE_IS_NATIVE, QUOTE_DECIMALS, TOKEN_DECIMALS, POOL_FEE_PIPS,
  HOOK_ABI, STATE_VIEW_ABI, ERC20_ABI, TOPICS, portalIface,
  decodeLog, classifySwap, priceFromSqrtX96, mcapQuote, progress, poolIdFor, tokenIsToken0, sqrtRatioAtTick, sqrtRatioFromX96, sqrtRatioToX96, liquidityForSupply, toTokens, CHAIN_ID } from "./chain.mjs";

const zeroPad = (a) => zeroPadValue(String(a).toLowerCase(), 32);
const lower = (a) => String(a).toLowerCase();
// The 3-second snipe tax plus two seconds of slack for a clock that is not the chain's: a buy
// before this is a donation to the hook, so nothing younger is offered as a candidate.
export const CANDIDATE_MIN_AGE_MS = SNIPE_TAX_WINDOW_MS + 2_000;

/**
 * The Portal's launches(token) record, decoded by word position. The record grew across Portal
 * versions (9, 10 or 11 words), and the ABI's 11-word decode reverts on the shorter ones, so the
 * raw return is split into 32-byte words and read as a prefix of the newest layout:
 * creator, tickStart, tokenIsToken0, locker, hook, splitter, buyTaxBps, sellTaxBps, positionId,
 * [tickBond], [quoteAsset]. ASSUMPTION: older records are prefixes of the newest one; a field the
 * record does not carry comes back null and is read from the hook instead.
 */
export function decodeLaunchWords(hex) {
  const body = String(hex || "").replace(/^0x/, "");
  if (body.length < 9 * 64) return null;
  const word = (i) => body.slice(i * 64, i * 64 + 64);
  const addr = (i) => "0x" + word(i).slice(24);
  const int24 = (i) => { const v = BigInt("0x" + word(i)); return Number(v > 2n ** 255n ? v - 2n ** 256n : v); };
  const uint = (i) => Number(BigInt("0x" + word(i)));
  const words = Math.floor(body.length / 64);
  const hook = addr(4);
  if (/^0x0+$/.test(hook)) return null;
  return {
    creator: addr(0), tickStart: int24(1), tokenIsToken0: uint(2) !== 0, locker: addr(3), hook, splitter: addr(5),
    buyTaxBps: uint(6), sellTaxBps: uint(7), positionId: BigInt("0x" + word(8)).toString(),
    tickBond: words >= 10 ? int24(9) : null, quoteAsset: words >= 11 ? addr(10) : null, words,
  };
}

/**
 * What the single launch position holds at a price inside it, in whole units: the tokens still
 * above the price (below it when the token is currency1) and the USDC buys have put in. This is
 * what the engine reads as the curve's reserves; there is no other pool state.
 * Uniswap's own amounts for a range at price sp: above = L (hi - sp) / (sp hi), below = L (sp - lo).
 */
export function positionReserves({ sqrtPriceX96, liquidity, tickStart, tickBond, tokenIs0, quoteDecimals = QUOTE_DECIMALS }) {
  const L = Number(liquidity);
  if (!(L > 0) || sqrtPriceX96 == null) return { quoteReserve: 0, tokenReserve: 0 };
  const start = sqrtRatioAtTick(tickStart), bond = sqrtRatioAtTick(tickBond);
  const lo = Math.min(start, bond), hi = Math.max(start, bond);
  const sp = Math.min(hi, Math.max(lo, sqrtRatioFromX96(sqrtPriceX96)));
  const is0 = tokenIs0 ?? Number(tickBond) > Number(tickStart);
  const above = (L * (hi - sp)) / (sp * hi), below = L * (sp - lo);
  return is0 ? { tokenReserve: above / 10 ** TOKEN_DECIMALS, quoteReserve: below / 10 ** quoteDecimals }
    : { tokenReserve: below / 10 ** TOKEN_DECIMALS, quoteReserve: above / 10 ** quoteDecimals };
}

/** The chain, behind a handful of calls, so a test can fake it. */
export function ethersRpc(rpcUrl = process.env.ARC_RPC_URL || DEFAULT_RPC_URL) {
  // The chain is named up front: a provider left to detect it retries every second, loudly, for as
  // long as the RPC is unreachable, and the chain id is not something the RPC gets to decide.
  const provider = new JsonRpcProvider(rpcUrl, { chainId: CHAIN_ID, name: "arc" }, { staticNetwork: true, batchMaxCount: 10 });
  const stateView = new Contract(STATE_VIEW, STATE_VIEW_ABI, provider);
  return {
    provider,
    blockNumber: () => provider.getBlockNumber(),
    logs: (filter) => provider.getLogs(filter),
    /** The hook's immutable launch terms, plus the one latch that moves. launchedAt comes back in ms. */
    async hookInfo(hook) {
      const h = new Contract(hook, HOOK_ABI, provider);
      const [buyTaxBps, sellTaxBps, bonded, launchedAt, tickStart, tickBond, token, quoteAsset] = await Promise.all([
        h.buyTaxBps(), h.sellTaxBps(), h.bonded().catch(() => false), h.launchedAt().catch(() => 0n), h.tickStart(), h.tickBond(), h.token(),
        // Hooks from before Portal #6 have no quoteAsset() and are USDC by construction: that revert
        // is an answer. A timeout or a rate limit on the same call is not, and reading it as "USDC"
        // would relabel an ARGUS-quoted launch as one the router can pay for, so it fails the read.
        h.quoteAsset().catch((err) => { if (err?.code === "CALL_EXCEPTION") return USDC_ERC20; throw err; }),
      ]);
      const quote = lower(quoteAsset || USDC_ERC20);
      // Only the USDC view has a known face; another quote asset says its own decimals.
      const quoteDecimals = quote === lower(USDC_ERC20) ? QUOTE_DECIMALS : Number(await new Contract(quote, ERC20_ABI, provider).decimals().catch(() => QUOTE_DECIMALS));
      return {
        buyTaxBps: Number(buyTaxBps), sellTaxBps: Number(sellTaxBps), bonded: !!bonded, launchedAt: Number(launchedAt) * 1000,
        tickStart: Number(tickStart), tickBond: Number(tickBond), token: lower(token), quoteAsset: quote, quoteDecimals,
        tokenIs0: tokenIsToken0(lower(token), quote), poolId: lower(poolIdFor({ token: lower(token), quoteAsset: quote, hook })),
      };
    },
    async slot0(poolId) {
      const r = await stateView.getSlot0(poolId);
      return { sqrtPriceX96: r.sqrtPriceX96.toString(), tick: Number(r.tick), lpFeePips: Number(r.lpFee) };
    },
    async liquidity(poolId) { return (await stateView.getLiquidity(poolId)).toString(); },
    async tokenMeta(token) {
      const c = new Contract(token, ERC20_ABI, provider);
      const [name, symbol] = await Promise.all([c.name().catch(() => ""), c.symbol().catch(() => "")]);
      return { name, symbol };
    },
    /** Who sent the transaction a swap sits in. The hook names no trader in any event and the
     *  PoolManager's Swap `sender` is the router, so the wallet is the transaction's own `from`. */
    async txFrom(hash) {
      const tx = await provider.getTransaction(hash);
      return tx?.from ? lower(tx.from) : null;
    },
    /** A launch the feed did not see (it happened before this process started): ask every Portal,
     *  newest first, since each Portal keeps the records of the tokens it launched forever. */
    async launchInfo(token) {
      const data = portalIface.encodeFunctionData("launches", [token]);
      for (const p of PORTALS) {
        if (p.family !== "v4") continue; // legacy v3 launches have no hook or v4 pool to trade
        let rec = null;
        try { rec = decodeLaunchWords(await provider.call({ to: p.address, data })); } catch { continue; }
        if (!rec) continue;
        const quoteAsset = lower(rec.quoteAsset || USDC_ERC20);
        return { token: lower(token), portal: lower(p.address), creator: lower(rec.creator), hook: lower(rec.hook), locker: lower(rec.locker), splitter: lower(rec.splitter), quoteAsset, poolId: lower(poolIdFor({ token: lower(token), quoteAsset, hook: rec.hook })) };
      }
      return null;
    },
    /** Every ERC-20 an address holds. An EVM node cannot list them; a provider's token-balance
     *  method can (Alchemy-style), and the chain's explorer can. Whichever answers first wins; both failing throws. */
    async walletTokens(address) {
      const errors = [];
      try {
        const rows = []; let pageKey = undefined;
        for (let i = 0; i < 20; i++) {
          const res = await provider.send("alchemy_getTokenBalances", pageKey ? [address, "erc20", { pageKey }] : [address, "erc20"]);
          rows.push(...(res?.tokenBalances || []).filter(b => b.tokenBalance && b.tokenBalance !== "0x" && BigInt(b.tokenBalance) > 0n));
          pageKey = res?.pageKey; if (!pageKey) break;
        }
        const out = [];
        for (const b of rows) { let dec = 18; try { dec = Number(await new Contract(b.contractAddress, ERC20_ABI, provider).decimals()); } catch {} out.push({ instrument: lower(b.contractAddress), qty: toTokens(BigInt(b.tokenBalance), dec) }); }
        return out.filter(x => x.qty > 0);
      } catch (err) { errors.push(`rpc: ${err.shortMessage || err.message}`); }
      try {
        const items = []; let params = "";
        for (let i = 0; i < 20; i++) {
          const r = await fetch(`${EXPLORER}/api/v2/addresses/${address}/tokens?type=ERC-20${params}`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) bondli/1.0" }, signal: AbortSignal.timeout(10_000) });
          if (!r.ok) throw new Error(`explorer ${r.status}`);
          const d = await r.json(); items.push(...(d.items || []));
          const np = d.next_page_params; if (!np) break;
          params = "&" + Object.entries(np).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
        }
        return items.map(i => ({ instrument: lower(i.token?.address || ""), qty: toTokens(BigInt(i.value || "0"), Number(i.token?.decimals ?? 18)), symbol: i.token?.symbol || "" })).filter(x => x.instrument && x.qty > 0);
      } catch (err) { errors.push(err.message); }
      throw new Error(errors.join("; "));
    },
    /** Every ERC-20 Transfer into an address, read from the chain's logs, so nothing depends on a
     *  provider's index or the explorer. The same walk the PONS rpc does; it lives inside that
     *  module's closure over its own provider, which is why it is repeated here rather than shared.
     *  Scans [fromBlock, toBlock] in chunks the node accepts, within a time budget; returns how far it got. */
    async transfersTo(address, { fromBlock, toBlock = null, budgetMs = 20_000, chunk = 50_000 } = {}) {
      const head = toBlock ?? await provider.getBlockNumber();
      const topic = "0x" + "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)
      const me = zeroPad(address);
      const tokens = new Map(); const t0 = Date.now(); let at = Math.max(0, fromBlock), size = chunk;
      while (at <= head && Date.now() - t0 < budgetMs) {
        const to = Math.min(head, at + size - 1);
        let logs;
        try { logs = await provider.getLogs({ fromBlock: at, toBlock: to, topics: [topic, null, me] }); }
        catch (err) { if (size > 500) { size = Math.floor(size / 4); continue; } throw err; }
        for (const l of logs) {
          if (!l.topics || l.topics.length !== 3) continue; // ERC-721 transfers carry a 4th topic
          const token = lower(l.address), from = "0x" + String(l.topics[1]).slice(26).toLowerCase();
          if (!tokens.has(token)) tokens.set(token, new Set()); tokens.get(token).add(from);
        }
        at = to + 1;
        if (logs.length < 2000 && size < chunk) size = Math.min(chunk, size * 2);
      }
      return { tokens, scannedTo: at - 1, head, done: at > head };
    },
  };
}

/** How long to wait before the next poll. A poll every 1.5s against an RPC that has started
 *  refusing (a rate limit on the public endpoint, an outage) would keep hammering it and fill the
 *  log with the same line; each consecutive failure doubles the wait, to a minute at most, and the
 *  first success brings it straight back. */
export function pollDelay(pollMs, errors) {
  if (!(errors > 0)) return pollMs;
  return Math.min(60_000, pollMs * 2 ** Math.min(errors, 6));
}

/** A liquidity reading is known when it is a positive integer; '0' (a swap that pushed past the position) is not. */
const liqKnown = v => { try { return v != null && BigInt(v) > 0n; } catch { return false; } };

export class ArcFeed extends Feed {
  constructor({ rpc = null, rpcUrl, pollMs = 1_500, fromBlock = null, maxTokens = 3000, clock, onTrade = null, ...rest } = {}) {
    super({ venue: "arc", name: "arc-feed", staleAfterMs: rest.staleAfterMs ?? Math.max(8_000, 3 * pollMs), latencyBoundMs: rest.latencyBoundMs ?? 2_500, clock });
    this.rpc = rpc || ethersRpc(rpcUrl);
    this.pollMs = pollMs; this.fromBlock = fromBlock; this.maxTokens = maxTokens;
    // "solPrice" = quote price in USD, by the engine's convention. The quote is USDC, so it is 1
    // and never fetched; solPriceAt is the feed's start so nothing reads it as a missing price.
    this.solPrice = 1; this.solPriceAt = this.clock();
    this.tokens = new Map(); this.byPool = new Map(); this.byHook = new Map(); this.dyn = new Dynamics();
    this._parts = new Map(); // PartsDeployed seen before its TokenCreated, by token
    this._txFrom = new Map(); // transaction hash -> sender, so a burst of swaps in one tx costs one read
    this._lastEmitted = new Map(); this._timers = []; this._block = null; this.errors = 0; this.reemitMs = rest.reemitMs ?? 30_000;
    this.lastError = null; this.hydrateErrors = 0; this.lastHydrateError = null; this.ticks = 0; this.candidates = 0; this.polls = 0;
    this._adopt = new Set(); this._adoptAt = new Map(); this._adoptTries = new Map(); // watched tokens the feed has yet to find on a Portal
    this.onTrade = typeof onTrade === "function" ? onTrade : null; // one buy or sell, for anything that keeps its own history
  }

  token(ca) { return this.tokens.get(lower(ca)) || null; }

  /** A position opened before this process started is watched for a token the feed never saw launch:
   *  it is adopted from the Portals on the next poll, so the position gets its price and its exits. */
  watch(id) {
    const ca = lower(id);
    super.watch(ca);
    if (!this.tokens.has(ca)) this._adopt.add(ca);
  }
  unwatch(id) { const ca = lower(id); super.unwatch(ca); this._adopt.delete(ca); this._adoptAt.delete(ca); this._adoptTries.delete(ca); }
  /** A watched token the Portals could not name is asked about again, later and less often, never dropped:
   *  dropping it would leave a held position with no tick at all, readable or not. */
  _adoptLater(ca, now) {
    this.adoptFailures = (this.adoptFailures || 0) + 1;
    const tries = (this._adoptTries.get(ca) || 0) + 1; this._adoptTries.set(ca, tries);
    this._adoptAt.set(ca, now + Math.min(60_000, this.pollMs * 2 ** Math.min(tries, 6)));
  }
  async _adoptWatched(now) {
    if (!this._adopt.size || !this.rpc.launchInfo) return;
    for (const ca of [...this._adopt]) {
      if ((this._adoptAt.get(ca) || 0) > now) continue;
      try {
        const info = await this.rpc.launchInfo(ca);
        if (!info) { this._adoptLater(ca, now); continue; }
        this._adopt.delete(ca); this._adoptAt.delete(ca); this._adoptTries.delete(ca);
        const t = this.apply({ kind: "launch", ...info, name: "", symbol: "", block: null, tx: null }, now - CANDIDATE_MIN_AGE_MS - 1);
        if (t) {
          this.apply({ kind: "parts", token: ca, hook: info.hook, locker: info.locker, splitter: info.splitter }, now);
          // The hook knows when it launched, so an adopted token's age is real once hydrated;
          // until then it is unknown, and unknown is never judged as a fresh launch.
          t._ageUnknown = true; t._adopted = true;
          await this._hydrate(t);
        }
      } catch (err) { this._adoptLater(ca, now); this.lastHydrateError = `adopt ${ca.slice(0, 10)}: ${errorText(err, 180)}`; }
    }
  }

  /** Apply one decoded log. Exposed for tests and replays. A swap record carries `wallet` when
   *  the poll attributed it; without one the swap counts as a trade with no buyer behind it. */
  apply(rec, now = this.clock()) {
    if (!rec) return;
    if (rec.kind === "launch") {
      if (this.tokens.has(rec.token)) return;
      const quoteAsset = lower(rec.quoteAsset || USDC_ERC20);
      const t = { ca: rec.token, poolId: rec.poolId ? lower(rec.poolId) : null, portal: rec.portal || null, hook: null, locker: null, splitter: null,
        name: rec.name || "", ticker: rec.symbol || "", image: rec.imageURI || "", website: rec.website || "", twitter: rec.twitter || "", telegram: rec.telegram || "",
        // Against USDC until the hook says otherwise: a launch quoted in another ERC-20 has its swaps
        // in the launch block read with this order for one poll, then is set aside once the hook is read.
        devWallet: rec.creator, createdAt: now, block: rec.block, quoteAsset, quoteDecimals: QUOTE_DECIMALS, tokenIs0: tokenIsToken0(rec.token, quoteAsset),
        buys: 0, sells: 0, uniqueBuyers: new Set(), trades: [], spark: [], volumeQuote: 0, volumeUsd: 0, devInitialQuote: 0,
        // null, not 0: the taxes are placeholders until _hydrate reads the hook, and a tax of "not
        // known yet" priced as "none" is how the EV gate once approved tokens that charged 10% a
        // side. Everything downstream must be able to tell ignorance from a reading.
        feeBps: null, sellTaxBps: null, creatorTaxBps: 0, poolFeeBps: POOL_FEE_PIPS / 100,
        sqrtPriceX96: null, liquidity: null, activeLiquidity: null, liquiditySource: null, tick: null, tickStart: null, tickBond: null, quoteReserve: 0, tokenReserve: 0,
        price: 0, mcapQuote: 0, mcapUsd: 0, progress: 0, bonded: false, graduated: false, _curvePct: 0, _source: "arc", _apeScore: 0, _scoredAt: 0, _pending: true };
      this.tokens.set(t.ca, t);
      // A launch seen on chain with no picture is counted, and the last picture seen is kept, so the
      // health page can say whether the radar's empty images are the Portal's doing or this feed's.
      if (rec.block != null) { if (t.image) this.lastImageURI = t.image; else this.noImage = (this.noImage || 0) + 1; }
      if (t.poolId) this.byPool.set(t.poolId, t);
      const parts = this._parts.get(t.ca); if (parts) { this._parts.delete(t.ca); this.apply(parts, now); }
      // Room is made from tokens nobody holds. A held token is never evicted: an adopted position is
      // hours old and would be the first to go, and a token that leaves the map stops ticking.
      if (this.tokens.size > this.maxTokens) { const oldest = [...this.tokens.values()].filter(x => !this.watched.has(x.ca)).sort((a, b) => a.createdAt - b.createdAt)[0]; if (oldest) this._forget(oldest); }
      return t;
    }
    if (rec.kind === "parts") {
      const t = this.tokens.get(rec.token);
      if (!t) { this._parts.set(rec.token, rec); return; }
      t.hook = lower(rec.hook); t.locker = lower(rec.locker); t.splitter = lower(rec.splitter);
      this.byHook.set(t.hook, t);
      if (!t.poolId) { t.poolId = lower(poolIdFor({ token: t.ca, quoteAsset: t.quoteAsset, hook: t.hook })); this.byPool.set(t.poolId, t); }
      return t;
    }
    if (rec.kind === "opened") {
      const t = this.tokens.get(rec.token); if (!t) return;
      // The log's `liquidity` may be the position's L or the supply the Portal passed as liquidityDelta,
      // depending on the Portal version, so it is kept apart and only serves once it has been checked.
      t.eventLiquidity = rec.liquidity; t.positionId = rec.positionId;
      // The log already carries the range; the hook read confirms it later, and until then these serve.
      if (t.tickStart == null && Number.isFinite(Number(rec.tickLower))) { t.tickStart = Number(rec.tickLower); t.tickBond = Number(rec.tickUpper); }
      if (rec.poolId && !t.poolId) { t.poolId = lower(rec.poolId); this.byPool.set(t.poolId, t); }
      this._settleLiquidity(t);
      return t;
    }
    if (rec.kind === "swap") {
      const t = this.byPool.get(lower(rec.poolId)); if (!t) return;
      const { side, tokens, quote } = classifySwap(rec, { tokenIs0: t.tokenIs0, quoteDecimals: t.quoteDecimals });
      if (!side) return; // moved no tokens: not a trade of this token
      // Without the transaction's sender the swap still counts as a trade, but the Swap log's own
      // `sender` is the router, and a router counted as a buyer is one whale across every swap it
      // relays: it is named on the trade for the record and never among the buyers.
      const buy = side === "buy", wallet = rec.wallet || null, attributed = !!wallet;
      if (!attributed) this.unattributedSwaps = (this.unattributedSwaps || 0) + 1;
      if (buy) { t.buys++; if (attributed) { t.uniqueBuyers.add(wallet); if (wallet === t.devWallet && t.buys === 1) t.devInitialQuote = quote; } } else t.sells++;
      t.volumeQuote += quote; t.volumeUsd = t.volumeQuote * this.solPrice;
      t.trades.push({ side, quote, sol: quote, tokens, wallet: wallet || rec.sender, attributed, time: now, tx: rec.tx });
      if (t.trades.length > 100) t.trades = t.trades.slice(-100);
      // The swap carries the pool's state after it: no read is fresher than this. Its liquidity is
      // the pool's active liquidity, a reading about the position only while the price is inside it.
      t.sqrtPriceX96 = rec.sqrtPriceX96; t.tick = rec.tick;
      this._noteLiquidity(t, rec.liquidity);
      this._remark(t);
      // A listener's failure is its own problem: the feed must not stop applying trades over it.
      if (this.onTrade) { try { this.onTrade(t, { side, quote, tokens, wallet: wallet || rec.sender, attributed, curvePct: t.progress * 100, ts: now, tx: rec.tx || null }); } catch {} }
      return t;
    }
  }

  _forget(t) {
    this.tokens.delete(t.ca); if (t.poolId) this.byPool.delete(t.poolId); if (t.hook) this.byHook.delete(t.hook);
    this._lastEmitted.delete(t.ca); this.dyn.h.delete(t.ca); // or the maps outlive the tokens they are about
    if (this.watched.has(t.ca)) this._adopt.add(t.ca);
  }

  /** The tick sits inside the launch position (both edges included: the price can rest on either). */
  _inRange(t) {
    if (t.tick == null || t.tickStart == null || t.tickBond == null) return true; // nothing says otherwise yet
    return Math.min(t.tickStart, t.tickBond) <= t.tick && t.tick <= Math.max(t.tickStart, t.tickBond);
  }
  /** One reading of the pool's active liquidity, from a Swap log or StateView. It becomes the
   *  position's L only when the price is inside the range, where the position is what is active;
   *  a zero (the price ran past the bond) or a number read outside the range says nothing about the
   *  position and must not overwrite what is known, or every bonded token would carry L = 0 into
   *  the reserves, the fill model and the sell quote. */
  _noteLiquidity(t, reading) {
    if (reading == null) return;
    if (!liqKnown(reading)) { t.activeLiquidity = "0"; return; }
    t.activeLiquidity = String(reading);
    if (this._inRange(t)) { t.liquidity = String(reading); t.liquiditySource = "pool"; }
  }
  /** Until the pool has been read inside the range, the position's L comes from what the launch
   *  itself says: CurveOpened's figure when it is L (some Portal versions log the supply they passed
   *  as liquidityDelta instead, off by 1e8 and more), else the L the whole supply in this range
   *  implies. Either is replaced by the pool's own number the first time it is read in range. */
  _settleLiquidity(t) {
    if (liqKnown(t.liquidity) || t.tickStart == null || t.tickBond == null) return;
    const implied = liquidityForSupply({ tickStart: t.tickStart, tickBond: t.tickBond, tokenIs0: t.tokenIs0 });
    const ev = liqKnown(t.eventLiquidity) ? Number(t.eventLiquidity) : 0;
    if (ev > 0 && implied > 0 && Math.abs(ev / implied - 1) < 0.05) { t.liquidity = String(t.eventLiquidity); t.liquiditySource = "event"; }
    else if (implied > 0 && Number.isFinite(implied)) { t.liquidity = BigInt(Math.round(implied)).toString(); t.liquiditySource = "supply"; }
  }

  _remark(t) {
    if (t.sqrtPriceX96 != null) {
      // A swap that empties the range leaves the pool's price wherever the router's limit was, far
      // past the bond, with nothing to trade there. Beyond the position's edge there is no price,
      // so the reading is held at the edge before anything is marked or scored off it. The tick is
      // left as read: `progress` clamps it on its own and the bonded latch needs to see the crossing.
      if (t.tickStart != null && t.tickBond != null) {
        const a = sqrtRatioToX96(sqrtRatioAtTick(t.tickStart)), b = sqrtRatioToX96(sqrtRatioAtTick(t.tickBond));
        const lo = a < b ? a : b, hi = a < b ? b : a;
        let x = null; try { x = BigInt(t.sqrtPriceX96); } catch {}
        if (x != null && (x < lo || x > hi)) { t.sqrtPriceX96 = (x < lo ? lo : hi).toString(); t._priceClamped = true; this.clampedReads = (this.clampedReads || 0) + 1; }
        else t._priceClamped = false;
      }
      t.price = priceFromSqrtX96(t.sqrtPriceX96, { tokenIs0: t.tokenIs0, quoteDecimals: t.quoteDecimals });
      t.mcapQuote = mcapQuote(t.price); t.mcapUsd = Math.round(t.mcapQuote * this.solPrice);
    }
    if (t.tickStart != null && t.tickBond != null) {
      this._settleLiquidity(t);
      const r = positionReserves(t); t.quoteReserve = r.quoteReserve; t.tokenReserve = r.tokenReserve;
      if (t.tick != null) {
        t.progress = progress(t.tick, t.tickStart, t.tickBond);
        // The hook's latch is monotonic: once the tick has crossed the bond it stays bonded whatever
        // the price does after, so the feed's flag only ever goes one way too.
        if (t.progress >= 1) t.bonded = true;
      }
    }
    t._curvePct = t.progress; // never 1 for "graduated": there is no graduation on this venue
    if (t.mcapUsd > 0) { t.spark.push(t.mcapUsd); if (t.spark.length > 60) t.spark = t.spark.slice(-60); }
  }

  /** Taxes and ticks from the hook once, the pool's price and liquidity every time, names once. */
  async _hydrate(t) {
    if (!t.hook) { t._hydrateError = "no hook yet"; return; } // PartsDeployed has not arrived: nothing to read
    try {
      const [hook, slot, liq, meta] = await Promise.all([
        t._hookRead ? null : this.rpc.hookInfo(t.hook),
        t.poolId ? this.rpc.slot0(t.poolId) : null,
        // Read until the pool has answered inside the range; out of range it answers 0 for the
        // position that is still there, so there is nothing to learn from asking.
        t.poolId && t.liquiditySource !== "pool" && this._inRange(t) ? this.rpc.liquidity(t.poolId) : null,
        t.name ? null : this.rpc.tokenMeta(t.ca),
      ]);
      if (hook) {
        // An adopted token's hook comes off a Portal record decoded by position; a wrong word would
        // hand this token another launch's taxes, ticks and age, so the hook has to name it back.
        if (hook.token && hook.token !== t.ca) throw new Error(`hook ${t.hook.slice(0, 10)} answers for ${hook.token.slice(0, 10)}, not this token`);
        Object.assign(t, { feeBps: hook.buyTaxBps, buyTaxBps: hook.buyTaxBps, sellTaxBps: hook.sellTaxBps, tickStart: hook.tickStart, tickBond: hook.tickBond });
        if (hook.bonded) t.bonded = true;
        if (hook.quoteAsset) { t.quoteAsset = lower(hook.quoteAsset); t.quoteDecimals = hook.quoteDecimals ?? t.quoteDecimals; t.tokenIs0 = hook.tokenIs0 ?? tokenIsToken0(t.ca, t.quoteAsset); }
        if (hook.poolId && !t.poolId) { t.poolId = lower(hook.poolId); this.byPool.set(t.poolId, t); }
        // The contract measures the snipe window from launchedAt; so does the candidate floor.
        if (Number.isFinite(hook.launchedAt) && hook.launchedAt > 0) { t.createdAt = hook.launchedAt; t._ageUnknown = false; }
        // The router pays in the USDC view through Permit2; a launch quoted in anything else is not
        // something it can buy, and its "USDC" mcap would be in the wrong asset anyway.
        if (t.quoteAsset !== lower(USDC_ERC20)) { if (!t.unsupportedQuote) this.skippedQuote = (this.skippedQuote || 0) + 1; t.unsupportedQuote = true; }
        t._hookRead = true;
      }
      if (slot) { t.sqrtPriceX96 = slot.sqrtPriceX96; t.tick = slot.tick; if (slot.lpFeePips) t.poolFeeBps = slot.lpFeePips / 100; }
      t._readFailedAt = null; // the pool answered: whatever is cached is current again
      this._noteLiquidity(t, liq);
      if (meta) { t.name = meta.name || t.name; t.ticker = meta.symbol || t.ticker; }
      t._pending = false; t._hydratedAt = this.clock();
      this._remark(t);
    } catch (err) {
      t._hydrateError = errorText(err, 200); this.hydrateErrors++; this.lastHydrateError = `${t.ca.slice(0, 10)}: ${errorText(err, 180)}`;
      // The cached price is left in place for the record, but it is no longer a price: a held token
      // whose pool stopped answering must reach the exit layer as unreadable, not marked at a
      // frozen number forever. The engine's blind exit has its own grace for a transient failure.
      if (t.poolId) t._readFailedAt = t._readFailedAt || this.clock();
    }
  }

  payloadFor(t, now = this.clock()) {
    const qf = quickFeatures(t, now);
    t._apeScore = scoreToken(t, qf, now); t._scoredAt = now;
    const dynamics = this.dyn.record(t.ca, t._apeScore, now);
    t._lastQf = qf; t._lastDyn = dynamics;
    const { uniqueBuyers, trades, ...rest } = t;
    // An adopted token whose hook never said when it launched has a placeholder createdAt, not an
    // age; the router already declines to price a snipe window it cannot measure, and the payload says the same.
    const token = { ...rest, uniqueBuyers: { size: uniqueBuyers.size }, trades: trades.slice(-60), vSolInBondingCurve: t.quoteReserve, mcapSol: t.mcapQuote, _ageMs: t._ageUnknown ? null : now - t.createdAt };
    return {
      token, qf, dynamics, scores: { apeScore: t._apeScore, scoreTimestamp: now },
      solPrice: this.solPrice, solPriceAt: this.solPriceAt, quote: "USDC",
      mcapUsd: t.mcapUsd, vSolInBondingCurve: t.quoteReserve,
      // A round trip here costs buyTax + sellTax + the pool's 1% on each leg; there is no separate
      // creator tax (the creator's share comes out of the leg tax through the splitter).
      curve: { address: t.poolId, hook: t.hook, quoteReserve: t.quoteReserve, tokenReserve: t.tokenReserve, feeBps: t.feeBps, sellTaxBps: t.sellTaxBps, creatorTaxBps: 0, poolFeeBps: t.poolFeeBps, native: QUOTE_IS_NATIVE,
        progress: t.progress, bonded: t.bonded, tickStart: t.tickStart, tickBond: t.tickBond, sqrtPriceX96: t.sqrtPriceX96, liquidity: t.liquidity, activeLiquidity: t.activeLiquidity, liquiditySource: t.liquiditySource, tokenIs0: t.tokenIs0, quoteAsset: t.quoteAsset, quoteDecimals: t.quoteDecimals },
    };
  }

  _changed(t, payload, now) {
    const key = `${payload.scores.apeScore | 0}|${t.buys}|${t.sells}|${Math.round(t.mcapUsd / 250)}|${payload.dynamics.trend}`;
    const prev = this._lastEmitted.get(t.ca);
    if (prev && prev.key === key && now - prev.at < this.reemitMs) return false;
    this._lastEmitted.set(t.ca, { key, at: now }); return true;
  }

  /** The wallet behind a swap: the transaction's sender. The hook emits nothing that names a
   *  trader and the Swap event's `sender` is the router that unlocked the PoolManager. */
  async _walletOf(rec) {
    if (!rec.tx || !this.rpc.txFrom) return null;
    if (this._txFrom.has(rec.tx)) return this._txFrom.get(rec.tx);
    let from = null;
    try { from = await this.rpc.txFrom(rec.tx); } catch { this.attributionErrors = (this.attributionErrors || 0) + 1; }
    if (this._txFrom.size > 5000) this._txFrom.clear();
    // A lookup that failed is not an answer: caching null would pin every swap in that transaction
    // on the router's address for good, and count the router as a buyer.
    if (from) this._txFrom.set(rec.tx, from);
    return from;
  }

  async pollOnce() {
    const now = this.clock();
    const head = await this.rpc.blockNumber();
    if (this._block == null) this._block = this.fromBlock ?? head; // first poll: from now, not from genesis
    // No new block: nothing to read, but a held position is still owed its tick. A stalled head is
    // exactly when a frozen price must not stand in for a live one.
    if (head < this._block) { await this._adoptWatched(now); await this._tickHeld(now); this.touch(); return 0; }
    const from = this._block, to = Math.min(head, from + 2000);
    // Every Portal, not just the current one: an older Portal still owns its launches' records and
    // its tokens still trade, and a Portal upgrade must not make the feed go blind to them.
    const launches = await this.rpc.logs({ address: PORTALS.map(p => p.address), topics: [[TOPICS.TokenCreated, TOPICS.PartsDeployed, TOPICS.CurveOpened]], fromBlock: from, toBlock: to });
    launches.sort((a, b) => (a.blockNumber - b.blockNumber) || ((a.index ?? a.logIndex ?? 0) - (b.index ?? b.logIndex ?? 0)));
    for (const l of launches) this.apply(decodeLog(l), now);
    await this._adoptWatched(now);
    const pools = [...this.byPool.keys()];
    const touched = new Set();
    for (let i = 0; i < pools.length; i += 200) { // topic lists have a cap on most nodes
      const logs = await this.rpc.logs({ address: POOL_MANAGER, topics: [TOPICS.Swap, pools.slice(i, i + 200)], fromBlock: from, toBlock: to });
      logs.sort((a, b) => (a.blockNumber - b.blockNumber) || ((a.index ?? a.logIndex ?? 0) - (b.index ?? b.logIndex ?? 0)));
      for (const l of logs) {
        const r = decodeLog(l); if (r?.kind !== "swap") continue;
        const t = this.apply({ ...r, wallet: await this._walletOf(r) }, now); if (t) touched.add(t);
      }
    }
    this._block = to + 1;
    let emitted = 0;
    for (const t of this.tokens.values()) {
      const held = this.watched.has(t.ca);
      if (t._pending || (touched.has(t) && now - (t._hydratedAt || 0) > 20_000) || (held && now - (t._hydratedAt || 0) > 4_000)) await this._hydrate(t);
      const readable = this._readable(t);
      if (held) this._emitHeldTick(t, now, readable);
      if (!readable) continue;
      const payload = this.payloadFor(t, now);
      if (t._ageUnknown || now - t.createdAt < CANDIDATE_MIN_AGE_MS) continue; // inside the snipe tax, or of no known age: not even a candidate
      if (t.uniqueBuyers.size < 2 || t.buys < 3) continue; // the pump.fun base filter's floor: two people and three buys before anyone is asked to judge it
      if (!this._changed(t, payload, now)) continue;
      this.emitEvent({ kind: "candidate", id: t.ca, payload, t_venue: now }); emitted++; this.candidates++;
    }
    for (const ca of this.watched) if (!this.tokens.has(ca)) this._emitUnknownTick(ca, now);
    this.polls++;
    this.touch();
    this.markHealth(true, `block ${to}, ${this.tokens.size} tokens, ${emitted} candidates`);
    return emitted;
  }
  /** A price the exit layer may act on: read, current, and in an asset the router can pay in. */
  _readable(t) { return t.mcapUsd > 0 && this.solPrice > 0 && !t._readFailedAt && !t.unsupportedQuote; }
  // A token we HOLD gets a tick every poll, readable or not. A held token whose pool read failed
  // must still reach the exit layer: no tick means no stop loss, no crash exit, no trail, only
  // the sweeper's blind time exit minutes later. An unreadable held position is a fact the exit
  // layer has to be told, not a reason to say nothing. A quote the router cannot pay in is not a
  // price either: a held one still ticks, as unreadable.
  _emitHeldTick(t, now, readable = this._readable(t)) {
    const payload = readable ? { ...this.payloadFor(t, now), source: "arc" }
      : { unreadable: true, source: "arc", solPrice: this.solPrice, solPriceAt: this.solPriceAt, quote: "USDC", token: { ca: t.ca, curve: t.poolId, graduated: false, bonded: !!t.bonded, _ageMs: t._ageUnknown ? null : now - t.createdAt } };
    this.emitEvent({ kind: "tick", id: t.ca, payload, t_venue: now });
    this.ticks++;
    if (!readable) this.unreadableTicks = (this.unreadableTicks || 0) + 1;
  }
  /** A watched token the feed does not hold at all -- not yet adopted, or not on any v4 Portal -- still
   *  gets its unreadable tick, so the exit layer's blind exit arms instead of the position waiting on timers. */
  _emitUnknownTick(ca, now) {
    this.emitEvent({ kind: "tick", id: ca, payload: { unreadable: true, source: "arc", solPrice: this.solPrice, solPriceAt: this.solPriceAt, quote: "USDC", token: { ca, curve: null, graduated: false, bonded: false, _ageMs: null } }, t_venue: now });
    this.ticks++; this.unreadableTicks = (this.unreadableTicks || 0) + 1;
  }
  /** Every held token's tick, on a poll that read nothing new. */
  async _tickHeld(now) {
    for (const ca of this.watched) {
      const t = this.tokens.get(ca);
      if (!t) { this._emitUnknownTick(ca, now); continue; }
      if (t._pending || now - (t._hydratedAt || 0) > 4_000) await this._hydrate(t);
      this._emitHeldTick(t, now);
    }
  }
  /** A poll that threw: counted, kept for the health page with any URL scrubbed out of it. */
  _noteError(err) { this.errors++; this.lastError = `${new Date(this.clock()).toISOString()} ${errorText(err, 260)}`; this.markHealth(false, errorText(err, 200)); }

  async start() {
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try { await this.pollOnce(); this.errors = 0; } catch (err) { this._noteError(err); }
      if (this.running) this._timers.push(setTimeout(tick, pollDelay(this.pollMs, this.errors)));
    };
    tick();
  }
  async stop() { this.running = false; for (const t of this._timers) clearTimeout(t); this._timers = []; this.markHealth(false, "stopped"); }
  /** The base status plus what a poll is doing: how many, how many failed, what the last failure said. */
  status() { return { ...super.status(), polls: this.polls, candidates: this.candidates, ticks: this.ticks, unreadableTicks: this.unreadableTicks || 0, watched: this.watched.size, pendingAdopt: this._adopt?.size || 0, adoptFailures: this.adoptFailures || 0, attributionErrors: this.attributionErrors || 0, block: this._block, errors: this.errors, lastError: this.lastError, hydrateErrors: this.hydrateErrors, lastHydrateError: this.lastHydrateError, skippedQuote: this.skippedQuote || 0, unattributedSwaps: this.unattributedSwaps || 0, clampedReads: this.clampedReads || 0, noImage: this.noImage || 0, lastImageURI: this.lastImageURI || null }; }
}
