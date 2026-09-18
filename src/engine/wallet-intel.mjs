// ═══ Wallet intel: which pump.fun wallets are actually smart, measured from our own stream ═══
// The on-chain trade stream (radar-onchain.mjs) delivers every buy and sell with the full buyer
// pubkey, the slot and the amounts. That is everything a wallet's track record is made of, so this
// keeps the ledger itself instead of asking a leaderboard API: FIFO cost basis per (wallet, mint),
// a position closes when the tokens are gone or after 24h, win = realized SOL after fees > 0.
//
// Raw profitability crowns the wrong wallets. Same-block snipers are 87% profitable and exit within
// minutes; co-firing rings look like "five smart wallets bought"; wash bots have a thousand trades
// at zero pnl; a fresh wallet with a perfect record is a rotated insider. So every wallet carries
// exclusion flags, a wallet is unproven (score 0) until it has closed enough positions, the win rate
// is a Wilson lower bound so 5/5 never outranks 70/100, the best trade is dropped before pnl is
// scored, and every contribution decays so a good month two months ago is not still an edge.
//
// Memory is bounded by design: per wallet only aggregates and a capped ring of closed positions
// survive; the only raw trades kept are the open FIFO lots, and those die with the position at 24h.
// The two things this replaces (the prefix-keyed smartWallets object and SmartMoneyTracker) counted
// a graduation as a win for every buyer, which is the lottery bias the research warns about.

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const INTEL_DEFAULTS = Object.freeze({
  persistEveryMs: 5 * MIN,
  windows: Object.freeze({ shortMs: 7 * DAY, longMs: 30 * DAY }),
  minClosed: 20,               // closed positions before a wallet can score at all
  earlyWindowMs: 5 * MIN,      // a buy this soon after create is "early"
  runnerMultiple: 3,           // an early buy is a hit when the mint later does this multiple of the entry mcap, or graduates
  closeAfterMs: 24 * HOUR,     // a position still open after this is closed: what was not sold is sunk
  halfLifeMs: 14 * DAY,        // decay of every contribution to the score
  feeBps: 100,                 // pump.fun takes 1% on both legs; realized pnl is after it
  txCostSol: 0.0002,           // base + priority fee per swap, the part the curve never shows
  dustFraction: 0.005,         // tokens left below this share of what was bought is "sold out"
  sniperShare: 0.2,            // creation-slot (or +1) buys above this share of all buys
  sniperMinBuys: 3,            // ...judged only once there are this many buys to take a share of
  minHoldMs: 60_000,           // median hold under this is a bot, whatever it earns
  minHoldSample: 5,            // closed positions before the hold rule is applied
  cohortWindowMs: 60_000,      // two early buyers this close together co-fired
  cohortMinLaunches: 3,        // co-fired on this many launches: a partner
  cohortMinPartners: 2,        // this many partners: a ring
  cohortBuyersPerMint: 40,     // only the first early buyers are paired (rings fire early; pairing is quadratic)
  washWindowMs: 60_000,        // buy and sell out inside this...
  washPnlFraction: 0.05,       // ...at pnl within this share of cost: a round trip
  washMinRoundTrips: 5,
  fixedSizeShare: 0.8,         // this share of buys at one exact size, with...
  fixedSizeMinBuys: 10,        // ...at least this many buys, reads as a bot
  freshWinRate: 0.6,           // a wallet younger than shortMs with a Wilson bound this high...
  freshEarlyHit: 0.5,          // ...or an early hit rate this high is a showcase wallet
  smartThreshold: 0.35,        // score a buyer needs to count in smartBuyers
  pnlScaleSol: 5,              // robust 30d pnl saturates the pnl term around this many SOL
  weights: Object.freeze({ pnl: 0.35, winRate: 0.3, earlyHit: 0.25, breadth: 0.1 }),
  cohortPenalty: 0.5,          // a ring member keeps a score (the ring counts once) but half of it
  maxWallets: 50_000,
  maxClosesPerWallet: 100,
  maxEarlyPerWallet: 100,
  maxBuyersPerMint: 300,       // smartBuyers looks at the first minutes; a mint's late buyers are not kept
  maxPartners: 32,
  maxSizes: 16,
  mintTtlMs: 25 * HOUR,        // outcome labels end at 24h after create
  sweepEveryMs: MIN,
  storeKey: "wallet:intel:v1",
});

/** Wilson score interval, lower bound. n may be fractional (decayed counts). */
export function wilsonLower(wins, n, z = 1.96) {
  if (!(n > 0)) return 0;
  const p = Math.min(1, Math.max(0, wins / n)), z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/** Weight of a contribution ageMs old: 1 now, 1/2 at one half-life, never negative. */
export function decayWeight(ageMs, halfLifeMs) {
  if (!(ageMs > 0)) return 1;
  return Math.pow(2, -ageMs / halfLifeMs);
}

/** Take `tokens` from FIFO lots in place; returns what was matched and what it cost. */
export function fifoTake(lots, tokens) {
  let need = tokens, matched = 0, cost = 0;
  while (need > 1e-9 && lots.length) {
    const lot = lots[0], take = Math.min(lot.t, need);
    cost += take * lot.c; lot.t -= take; need -= take; matched += take;
    if (lot.t <= 1e-9) lots.shift();
  }
  return { matched, cost };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const key = (wallet, mint) => `${wallet}|${mint}`;

function emptyScore(wallet, fundedByKnown) {
  return { wallet, score: 0, closed: 0, wins: 0, winRateLower: 0, pnlSol30d: 0, robustPnlSol30d: 0, pnlSol7d: 0, earlyBuys: 0, earlyHits: 0, earlyHitRate: 0, medianHoldMs: null, profitableMints: 0, buys: 0, ageMs: null, lastSeen: null, flags: { sniper: false, cohort: false, fresh: false, wash: false, deployerFunded: fundedByKnown ? false : null }, cohort: null };
}

export class WalletIntel {
  /**
   * @param clock      () -> ms; injected so a test can replay a month in a millisecond
   * @param store      async get(key)/set(key, value); Redis in production, a Map in tests; null = never persists
   * @param fundedBy   optional (wallet) -> funder address | null, sync or async; absent = the flag is unknown (null)
   */
  constructor({ clock = () => Date.now(), store = null, fundedBy = null, log = null, ...opts } = {}) {
    this.o = { ...INTEL_DEFAULTS, ...opts, windows: { ...INTEL_DEFAULTS.windows, ...(opts.windows || {}) }, weights: { ...INTEL_DEFAULTS.weights, ...(opts.weights || {}) } };
    this.clock = clock; this.store = store; this.fundedBy = fundedBy; this.log = log;
    this.wallets = new Map();   // wallet -> aggregates (see _wallet)
    this.mints = new Map();     // mint -> launch record: create slot/ts, peaks, early buyers, first buyers
    this.positions = new Map(); // wallet|mint -> open FIFO position
    this.lastSweepAt = 0; this.lastPersistAt = 0; this._persisting = null;
    this.counters = { trades: 0, creates: 0, closed: 0, forcedCloses: 0, ignoredSells: 0, persisted: 0, persistErrors: 0, loadedAt: null };
  }

  // ── ingest ──────────────────────────────────────────────────────────────────

  onCreate({ mint, creator = null, ts, slot = null } = {}) {
    if (!mint) return;
    const now = Number.isFinite(ts) ? ts : this.clock();
    const m = this._mint(mint, now);
    m.creator = creator || m.creator; m.createTs = now; m.createSlot = Number.isFinite(slot) ? slot : m.createSlot;
    this.counters.creates++;
    this._sweep(now);
  }

  /** One buy or sell from the stream. mcapUsd is optional: the mint's last mark is used without it. */
  onTrade({ mint, wallet, isBuy, sol, tokens, ts, slot = null, signature = null, mcapUsd = null } = {}) {
    if (!mint || !wallet || !(sol >= 0) || !(tokens > 0)) return;
    // A buy with no cost is not a cost basis: booked at zero it would close as a guaranteed win.
    if (isBuy && !(sol > 0)) { this.counters.ignoredBuys = (this.counters.ignoredBuys || 0) + 1; return; }
    const now = Number.isFinite(ts) ? ts : this.clock();
    this.counters.trades++;
    const m = this._mint(mint, now), w = this._wallet(wallet, now);
    w.last = Math.max(w.last, now); w.dirty = true;
    if (mcapUsd > 0) m.lastMcap = mcapUsd;
    if (isBuy) this._buy(m, w, wallet, { sol, tokens, ts: now, slot, mcapUsd: mcapUsd > 0 ? mcapUsd : m.lastMcap });
    else this._sell(m, w, wallet, { sol, tokens, ts: now });
    this._sweep(now);
    this._maybePersist(now);
  }

  /** A market cap observation for outcome labels: peak within 5m/15m/1h/24h of create. */
  markMcap(mint, mcapUsd, ts) {
    if (!mint || !(mcapUsd > 0)) return;
    const now = Number.isFinite(ts) ? ts : this.clock();
    const m = this._mint(mint, now);
    m.lastMcap = mcapUsd;
    if (m.createTs != null) {
      const age = now - m.createTs;
      if (age <= 5 * MIN) m.peak.m5 = Math.max(m.peak.m5, mcapUsd);
      if (age <= 15 * MIN) m.peak.m15 = Math.max(m.peak.m15, mcapUsd);
      if (age <= HOUR) m.peak.h1 = Math.max(m.peak.h1, mcapUsd);
      if (age <= DAY) m.peak.h24 = Math.max(m.peak.h24, mcapUsd);
      if (age > DAY) return; // the label window is over; a late run is not what "early" was betting on
    }
    this._resolveRunners(m, mcapUsd);
    this._sweep(now);
  }

  onGraduated(mint, ts) {
    if (!mint) return;
    const now = Number.isFinite(ts) ? ts : this.clock();
    const m = this._mint(mint, now);
    if (m.graduatedTs == null) m.graduatedTs = now;
    this._resolveRunners(m, m.lastMcap);
  }

  _buy(m, w, wallet, { sol, tokens, ts, slot, mcapUsd }) {
    const o = this.o;
    w.buys++;
    // Exact repeated sizes are a bot tell; the tally is capped so a wallet cannot grow it without bound.
    const sz = sol.toFixed(3);
    if (sz in w.sizes) w.sizes[sz]++; else if (Object.keys(w.sizes).length < o.maxSizes) w.sizes[sz] = 1;
    const sniped = m.createSlot != null && Number.isFinite(slot) && slot <= m.createSlot + 1;
    if (sniped) w.sniperBuys++;
    if (!m.buyers.has(wallet) && m.buyers.size < o.maxBuyersPerMint) m.buyers.set(wallet, { ts, slot, sol, sniped });
    const early = m.createTs != null && ts - m.createTs <= o.earlyWindowMs;
    if (early && !m.earlyBuyers.has(wallet)) {
      // The same entry object lives in the wallet's ring and the mint's pending map, so a later run
      // marks the wallet's record in place without a search.
      const entry = { ts, mint: m.mint, entryMcap: mcapUsd > 0 ? mcapUsd : 0, hit: false };
      m.earlyBuyers.set(wallet, entry); m.pendingEarly++;
      w.early.push(entry); if (w.early.length > o.maxEarlyPerWallet) w.early.shift();
      if (m.graduatedTs != null) this._resolveRunners(m, m.lastMcap);
      this._pairCohort(m, w, wallet, ts);
    }
    if (this.fundedBy) this._checkFunder(m, w, wallet);
    const k = key(wallet, m.mint);
    let p = this.positions.get(k);
    if (!p) { p = { wallet, mint: m.mint, opened: ts, slot, lots: [], bought: 0, left: 0, cost: 0, proceeds: 0, buys: 0, sells: 0, firstSell: null, lastBuy: ts, early }; this.positions.set(k, p); }
    p.lots.push({ t: tokens, c: (sol * (1 + o.feeBps / 1e4)) / tokens });
    p.bought += tokens; p.left += tokens; p.buys++; p.lastBuy = ts;
  }

  _sell(m, w, wallet, { sol, tokens, ts }) {
    w.sells++;
    const k = key(wallet, m.mint), p = this.positions.get(k);
    if (!p) { this.counters.ignoredSells++; return; } // tokens we never saw bought: no cost basis, no pnl
    const { matched, cost } = fifoTake(p.lots, tokens);
    if (!(matched > 0)) { this.counters.ignoredSells++; return; }
    // A sell bigger than what we saw bought is partly tokens from before we watched: only the matched share counts.
    p.proceeds += sol * (1 - this.o.feeBps / 1e4) * (matched / tokens);
    p.cost += cost; p.left -= matched; p.sells++;
    if (p.firstSell == null) p.firstSell = ts;
    if (p.left <= p.bought * this.o.dustFraction) this._close(p, ts, "sold");
  }

  _close(p, ts, why) {
    const o = this.o, w = this._wallet(p.wallet, ts);
    let sunk = 0; for (const lot of p.lots) sunk += lot.t * lot.c; // what was paid for tokens never sold
    const pnl = p.proceeds - p.cost - sunk - o.txCostSol * (p.buys + p.sells);
    const holdMs = (p.firstSell ?? ts) - p.opened;
    const rec = { ts, mint: p.mint, pnl: round(pnl, 6), win: pnl > 0, holdMs, swaps: p.buys + p.sells, early: p.early };
    w.closes.push(rec); if (w.closes.length > o.maxClosesPerWallet) w.closes.shift();
    if (why === "sold" && holdMs <= o.washWindowMs && Math.abs(pnl) <= o.washPnlFraction * Math.max(p.cost, 1e-9)) w.wash++;
    w.dirty = true;
    this.positions.delete(key(p.wallet, p.mint));
    this.counters.closed++; if (why === "forced") this.counters.forcedCloses++;
  }

  _resolveRunners(m, mcap) {
    if (!m.pendingEarly) return;
    for (const [wallet, e] of m.earlyBuyers) {
      if (e.hit) continue;
      if (m.graduatedTs != null || (e.entryMcap > 0 && mcap >= this.o.runnerMultiple * e.entryMcap)) {
        e.hit = true; m.pendingEarly--;
        const w = this.wallets.get(wallet); if (w) w.dirty = true;
      }
    }
  }

  /** Early buyers of one launch that fired within cohortWindowMs of each other are partners for a launch. */
  _pairCohort(m, w, wallet, ts) {
    const o = this.o;
    for (const other of m.coFirst) {
      if (other.wallet === wallet || Math.abs(ts - other.ts) > o.cohortWindowMs) continue;
      const ow = this.wallets.get(other.wallet); if (!ow) continue;
      this._bumpPartner(w, other.wallet); this._bumpPartner(ow, wallet); ow.dirty = true;
    }
    if (m.coFirst.length < o.cohortBuyersPerMint) m.coFirst.push({ wallet, ts });
  }
  _bumpPartner(w, other) {
    if (other in w.partners) { w.partners[other]++; return; }
    const keys = Object.keys(w.partners);
    if (keys.length >= this.o.maxPartners) {
      // Evict the weakest so a real ring partner, who keeps accumulating, is never the one dropped.
      let weakest = keys[0]; for (const k of keys) if (w.partners[k] < w.partners[weakest]) weakest = k;
      if (w.partners[weakest] > 1) return;
      delete w.partners[weakest];
    }
    w.partners[other] = 1;
  }

  _checkFunder(m, w, wallet) {
    const credit = f => { w.funder = f || null; if (w.funder && m.creator && w.funder === m.creator) { w.deployerFundedBuys++; w.dirty = true; } };
    if (w.funder !== undefined) { credit(w.funder); return; }
    let r;
    try { r = this.fundedBy(wallet); } catch { w.funder = null; return; }
    if (r && typeof r.then === "function") { w.funder = null; r.then(credit, () => {}); } else credit(r);
  }

  // ── records ─────────────────────────────────────────────────────────────────

  _mint(mint, now) {
    let m = this.mints.get(mint);
    if (!m) { m = { mint, creator: null, createTs: null, createSlot: null, seenTs: now, lastMcap: 0, peak: { m5: 0, m15: 0, h1: 0, h24: 0 }, graduatedTs: null, buyers: new Map(), earlyBuyers: new Map(), pendingEarly: 0, coFirst: [] }; this.mints.set(mint, m); }
    return m;
  }
  _wallet(wallet, now) {
    let w = this.wallets.get(wallet);
    if (!w) { w = { first: now, last: now, buys: 0, sells: 0, sniperBuys: 0, closes: [], early: [], partners: {}, wash: 0, sizes: {}, funder: undefined, deployerFundedBuys: 0, dirty: true, cache: null }; this.wallets.set(wallet, w); }
    return w;
  }

  // ── scoring ─────────────────────────────────────────────────────────────────

  walletScore(wallet, now = this.clock()) {
    const w = this.wallets.get(wallet);
    if (!w) return emptyScore(wallet, !!this.fundedBy);
    if (w.cache && !w.dirty && now - w.cache.at < MIN) return w.cache.value;
    const value = this._score(wallet, w, now);
    w.cache = { at: now, value }; w.dirty = false;
    return value;
  }

  _score(wallet, w, now) {
    const o = this.o, { longMs, shortMs } = o.windows;
    // The rings are chronological, so pruning is a shift from the front. Beyond 30d nothing counts.
    while (w.closes.length && now - w.closes[0].ts > longMs) w.closes.shift();
    while (w.early.length && now - w.early[0].ts > longMs) w.early.shift();
    const out = emptyScore(wallet, !!this.fundedBy);
    out.closed = w.closes.length; out.buys = w.buys; out.ageMs = now - w.first; out.lastSeen = w.last;
    let pnl30 = 0, pnl7 = 0, best = -Infinity, nEff = 0, winsEff = 0, pnlEff = 0, bestEff = -Infinity;
    const holds = [], profitable = new Set();
    for (const c of w.closes) {
      const wt = decayWeight(now - c.ts, o.halfLifeMs);
      pnl30 += c.pnl; if (now - c.ts <= shortMs) pnl7 += c.pnl;
      best = Math.max(best, c.pnl);
      nEff += wt; pnlEff += wt * c.pnl; bestEff = Math.max(bestEff, wt * c.pnl);
      if (c.win) { winsEff += wt; out.wins++; profitable.add(c.mint); }
      holds.push(c.holdMs);
    }
    out.pnlSol30d = round(pnl30, 4); out.pnlSol7d = round(pnl7, 4);
    out.robustPnlSol30d = round(pnl30 - Math.max(best, 0), 4);
    out.winRateLower = round(wilsonLower(winsEff, nEff), 4);
    out.medianHoldMs = median(holds);
    out.profitableMints = profitable.size;
    let eN = 0, eHit = 0;
    // An early buy is labelled by what the mint does in its first day; until that day is up an
    // unresolved entry is neither a hit nor a miss, and counting it as a miss would mark a wallet
    // down for buying a launch seconds ago.
    let earlyBuys = 0;
    for (const e of w.early) { if (!e.hit && now - e.ts < DAY) continue; earlyBuys++; const wt = decayWeight(now - e.ts, o.halfLifeMs); eN += wt; if (e.hit) { eHit += wt; out.earlyHits++; } }
    out.earlyBuys = earlyBuys; out.earlyHitRate = out.earlyBuys ? round(out.earlyHits / out.earlyBuys, 4) : 0;
    const earlyEff = eN > 0 ? eHit / eN : 0;

    const f = out.flags;
    f.sniper = (w.buys >= o.sniperMinBuys && w.sniperBuys / w.buys > o.sniperShare) || (out.closed >= o.minHoldSample && out.medianHoldMs < o.minHoldMs);
    const partners = Object.keys(w.partners).filter(k => w.partners[k] >= o.cohortMinLaunches);
    if (partners.length >= o.cohortMinPartners) { f.cohort = true; out.cohort = [wallet, ...partners].sort().join(","); }
    let maxSize = 0; for (const k in w.sizes) maxSize = Math.max(maxSize, w.sizes[k]);
    const fixedSizes = w.buys >= o.fixedSizeMinBuys && maxSize / w.buys >= o.fixedSizeShare;
    f.wash = w.wash >= o.washMinRoundTrips && (w.wash >= out.closed * 0.5 || fixedSizes);
    f.fresh = out.ageMs < shortMs && out.closed >= o.minClosed && (out.winRateLower >= o.freshWinRate || out.earlyHitRate >= o.freshEarlyHit);
    if (this.fundedBy) f.deployerFunded = w.deployerFundedBuys > 0;

    // Unproven is zero, not "a little": a positive score on 3 trades is exactly the lottery bias.
    if (out.closed < o.minClosed || f.sniper || f.wash || f.fresh || f.deployerFunded) return out;
    const robustEff = pnlEff - Math.max(bestEff, 0);
    const pnlPart = Math.tanh(robustEff / o.pnlScaleSol); // -1..1: losing money pulls the score down, it is not floored away
    const breadth = Math.min(1, Math.log1p(profitable.size) / Math.log1p(20));
    let s = o.weights.pnl * pnlPart + o.weights.winRate * out.winRateLower + o.weights.earlyHit * earlyEff + o.weights.breadth * breadth;
    if (f.cohort) s *= o.cohortPenalty;
    out.score = round(Math.min(1, Math.max(0, s)));
    return out;
  }

  /**
   * Smart wallets among a mint's first buyers. Only proven, unflagged wallets count; a ring counts
   * once (its best member); a buy in the creation slot never counts even from a wallet that is
   * otherwise clean. sinceTs defaults to the create time, windowMs to the early window.
   */
  smartBuyers(mint, { sinceTs = null, windowMs = this.o.earlyWindowMs, threshold = this.o.smartThreshold } = {}) {
    const m = this.mints.get(mint);
    const out = { mint, count: 0, wallets: [], sumScore: 0, sumSol: 0, seen: 0 };
    if (!m) return out;
    const from = sinceTs ?? m.createTs ?? m.seenTs, to = from + windowMs, now = this.clock();
    const cands = [];
    for (const [wallet, b] of m.buyers) {
      if (b.ts < from || b.ts > to) continue;
      out.seen++;
      if (b.sniped) continue;
      const s = this.walletScore(wallet, now);
      const f = s.flags;
      if (s.score < threshold || f.sniper || f.wash || f.fresh || f.deployerFunded) continue;
      cands.push({ wallet, score: s.score, ts: b.ts, sol: b.sol, flagged: !!f.cohort });
    }
    // A ring is a connected component over the partner graph, not each wallet's own view of it: two
    // members of one ring can have different partner sets (a staggered fourth member pairs with some
    // and not others), and grouping by each wallet's own key counted such a ring three times.
    const idx = new Map(cands.map((c, i) => [c.wallet, i])), root = cands.map((_, i) => i);
    const find = i => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; } return i; };
    for (const c of cands) {
      if (!c.flagged) continue; // a pair that happens to co-fire is two wallets; a ring is what the flag names
      const w = this.wallets.get(c.wallet); if (!w) continue;
      for (const k in w.partners) { const j = idx.get(k); if (j != null && cands[j].flagged && w.partners[k] >= this.o.cohortMinLaunches) { const a = find(idx.get(c.wallet)), b = find(j); if (a !== b) root[a] = b; } }
    }
    const groups = new Map();
    for (const c of cands) {
      const g = find(idx.get(c.wallet)), prev = groups.get(g);
      if (!prev) groups.set(g, { wallet: c.wallet, score: c.score, ts: c.ts, sol: c.sol, cohort: c.flagged ? 1 : null, members: 1 });
      else { prev.members++; prev.cohort = prev.members; if (c.score > prev.score) Object.assign(prev, { wallet: c.wallet, score: c.score, ts: c.ts, sol: c.sol }); }
    }
    for (const g of groups.values()) if (g.members > 1) g.cohort = g.members;
    out.wallets = [...groups.values()].sort((a, b) => b.score - a.score);
    out.count = out.wallets.length;
    for (const x of out.wallets) { out.sumScore += x.score; out.sumSol += x.sol; }
    out.sumScore = round(out.sumScore); out.sumSol = round(out.sumSol, 4);
    return out;
  }

  top(n = 50) {
    const now = this.clock(), rows = [];
    for (const wallet of this.wallets.keys()) { const s = this.walletScore(wallet, now); if (s.score > 0) rows.push(s); }
    return rows.sort((a, b) => b.score - a.score || b.robustPnlSol30d - a.robustPnlSol30d).slice(0, n);
  }

  status() {
    const now = this.clock();
    this._sweep(now);
    let scored = 0, open = this.positions.size; const flagged = { sniper: 0, cohort: 0, fresh: 0, wash: 0, deployerFunded: 0 };
    for (const [wallet, w] of this.wallets) {
      if (!w.closes.length && !w.early.length) continue; // nothing to say about a wallet with no record yet
      const s = this.walletScore(wallet, now);
      if (s.score > 0) scored++;
      for (const k in flagged) if (s.flags[k]) flagged[k]++;
    }
    return { wallets: this.wallets.size, mints: this.mints.size, openPositions: open, scored, flagged, ...this.counters, lastSweepAt: this.lastSweepAt || null, lastPersistAt: this.lastPersistAt || null, persisting: !!this._persisting };
  }

  // ── housekeeping ────────────────────────────────────────────────────────────

  /** Close what is overdue, forget mints past their label window and wallets silent for a month, cap the table. */
  _sweep(now, force = false) {
    const o = this.o;
    if (!force && now - this.lastSweepAt < o.sweepEveryMs) return;
    this.lastSweepAt = now;
    for (const p of [...this.positions.values()]) if (now - p.opened >= o.closeAfterMs) this._close(p, now, "forced");
    for (const [mint, m] of this.mints) if (now - (m.createTs ?? m.seenTs) > o.mintTtlMs) this.mints.delete(mint);
    const { longMs } = o.windows;
    for (const [wallet, w] of this.wallets) if (now - w.last > longMs) this.wallets.delete(wallet);
    if (this.wallets.size > o.maxWallets) {
      const holding = new Set(); for (const p of this.positions.values()) holding.add(p.wallet);
      const rows = [...this.wallets].filter(([k]) => !holding.has(k)).sort((a, b) => a[1].last - b[1].last);
      for (let i = 0; i < rows.length && this.wallets.size > o.maxWallets; i++) this.wallets.delete(rows[i][0]);
    }
  }

  // ── persistence ─────────────────────────────────────────────────────────────

  /** Compact state: aggregates, capped rings and open lots. Nothing here grows with trade count. */
  snapshot() {
    const now = this.clock();
    this._sweep(now, true);
    const wallets = [];
    for (const [k, w] of this.wallets) {
      if (!w.closes.length && !w.early.length && !w.buys) continue;
      wallets.push([k, { f: w.first, l: w.last, b: w.buys, s: w.sells, sb: w.sniperBuys, wa: w.wash, fd: w.funder === undefined ? undefined : w.funder, dfb: w.deployerFundedBuys, sz: w.sizes, pt: w.partners,
        cl: w.closes.map(c => [c.ts, c.mint, c.pnl, c.win ? 1 : 0, c.holdMs, c.swaps, c.early ? 1 : 0]),
        ea: w.early.map(e => [e.ts, e.mint, e.entryMcap, e.hit ? 1 : 0]) }]);
    }
    const mints = [];
    for (const [k, m] of this.mints) mints.push([k, { c: m.creator, ct: m.createTs, cs: m.createSlot, st: m.seenTs, lm: m.lastMcap, pk: m.peak, g: m.graduatedTs,
      by: [...m.buyers].map(([w, b]) => [w, b.ts, b.slot, b.sol, b.sniped ? 1 : 0]), eb: [...m.earlyBuyers.keys()], cf: m.coFirst.map(x => [x.wallet, x.ts]) }]);
    const positions = [...this.positions.values()].map(p => ({ w: p.wallet, m: p.mint, o: p.opened, sl: p.slot, lots: p.lots.map(l => [l.t, l.c]), bt: p.bought, lf: p.left, c: p.cost, pr: p.proceeds, b: p.buys, s: p.sells, fs: p.firstSell, lb: p.lastBuy, e: p.early ? 1 : 0 }));
    return { v: 1, at: now, wallets, mints, positions, counters: { ...this.counters } };
  }

  restore(snap) {
    if (!snap || snap.v !== 1) return false;
    this.wallets.clear(); this.mints.clear(); this.positions.clear();
    for (const [k, s] of snap.wallets || []) {
      this.wallets.set(k, { first: s.f, last: s.l, buys: s.b, sells: s.s, sniperBuys: s.sb, wash: s.wa, funder: s.fd === undefined ? undefined : s.fd, deployerFundedBuys: s.dfb || 0, sizes: s.sz || {}, partners: s.pt || {},
        closes: (s.cl || []).map(([ts, mint, pnl, win, holdMs, swaps, early]) => ({ ts, mint, pnl, win: !!win, holdMs, swaps, early: !!early })),
        early: (s.ea || []).map(([ts, mint, entryMcap, hit]) => ({ ts, mint, entryMcap, hit: !!hit })), dirty: true, cache: null });
    }
    for (const [k, s] of snap.mints || []) {
      const m = this._mint(k, s.st);
      m.creator = s.c; m.createTs = s.ct; m.createSlot = s.cs; m.lastMcap = s.lm || 0; m.peak = { ...m.peak, ...(s.pk || {}) }; m.graduatedTs = s.g ?? null;
      for (const [w, ts, slot, sol, sniped] of s.by || []) m.buyers.set(w, { ts, slot, sol, sniped: !!sniped });
      for (const w of s.eb || []) {
        // Relink to the wallet's own entry object so a later run still marks it in place.
        const e = this.wallets.get(w)?.early.find(x => x.mint === k);
        if (e) { m.earlyBuyers.set(w, e); if (!e.hit) m.pendingEarly++; }
      }
      m.coFirst = (s.cf || []).map(([wallet, ts]) => ({ wallet, ts }));
    }
    for (const p of snap.positions || []) {
      this.positions.set(key(p.w, p.m), { wallet: p.w, mint: p.m, opened: p.o, slot: p.sl, lots: p.lots.map(([t, c]) => ({ t, c })), bought: p.bt, left: p.lf, cost: p.c, proceeds: p.pr, buys: p.b, sells: p.s, firstSell: p.fs, lastBuy: p.lb, early: !!p.e });
    }
    if (snap.counters) this.counters = { ...this.counters, ...snap.counters };
    this.counters.loadedAt = this.clock();
    return true;
  }

  async persist() {
    if (!this.store) return false;
    const now = this.clock();
    await this.store.set(this.o.storeKey, JSON.stringify(this.snapshot()));
    this.lastPersistAt = now; this.counters.persisted++;
    return true;
  }

  async load() {
    if (!this.store) return false;
    const raw = await this.store.get(this.o.storeKey);
    if (!raw) return false;
    try { return this.restore(typeof raw === "string" ? JSON.parse(raw) : raw); }
    catch (e) { this.log?.warn?.(`[WALLET-INTEL] snapshot unreadable: ${e.message}`); return false; }
  }

  _maybePersist(now) {
    if (!this.store || this._persisting || now - this.lastPersistAt < this.o.persistEveryMs) return;
    // Never on the stream's thread: a slow Redis must not stall trade processing, and one write at a time.
    this._persisting = this.persist().catch(e => { this.counters.persistErrors++; this.log?.warn?.(`[WALLET-INTEL] persist failed: ${e.message}`); }).finally(() => { this._persisting = null; });
  }
}
