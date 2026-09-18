// ═══ VELOCITY — Polymarket edge models (DP2 plugin) ═══
// Model 1, resolved_fact : the market's rules name a source, that source says the
//                          event is decided, and the winning side still trades below 1.
// Model 2, consistency   : a negative-risk group whose YES asks sum below 1 (buy all),
//                          or whose NO asks sum below n-1 (buy all NO). All legs or none.
// Model 3, stale_quote   : off until models 1 and 2 pass the promotion gate.
// The edge keeps the venue picture (markets, groups, books, facts) and turns
// events into candidates; the GateRunner does the judging.

import { planFor } from "../../core/plans.mjs";

function normSource(s) {
  return String(s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").trim();
}
export function sourcesMatch(ruleSource, factSource) {
  const a = normSource(ruleSource), b = normSource(factSource);
  if (!a || !b) return false;
  const host = s => s.split(/[\s/]/)[0];
  return a.includes(b) || b.includes(a) || (host(a) && host(a) === host(b));
}

export function makePolymarketEdge({
  margin = 0.02,
  consistencyMargin = 0.01,
  minAskSize = 20,
  factMinConfidence = 0.95,
  consistencyPWin = 0.995,
  gasUsd = 0.5,
  nominalStakeUsd = 100,
  enableStaleQuote = false,
} = {}) {
  const markets = new Map();   // conditionId -> market
  const groups = new Map();    // groupId -> Set(conditionId), from Gamma events (complete sets only)
  const books = new Map();     // tokenId -> book
  const facts = new Map();     // conditionId -> fact

  const feeFraction = m => (Number(m?.feeRateBps) || 0) / 10_000;

  function resolvedFactCandidate(conditionId, why) {
    const m = markets.get(conditionId), f = facts.get(conditionId);
    if (!m || !f) return null;
    const idx = m.outcomes.findIndex(o => String(o).toLowerCase() === String(f.outcome).toLowerCase());
    if (idx < 0) return null;
    const tokenId = m.tokenIds[idx];
    const book = books.get(tokenId) || null;
    return { model: "resolved_fact", instrument: tokenId, market: m, fact: f, outcomeIndex: idx, book, tier: 1, group: m.groupId || m.conditionId, why,
      reference: { ask: book?.bestAsk ?? null, book, feeRateBps: m.feeRateBps || 0, conditionId: m.conditionId } };
  }

  function consistencyCandidates(groupId, why) {
    const ids = groups.get(groupId);
    if (!ids || ids.size < 2) return [];
    const legsYes = [], legsNo = [];
    for (const cid of ids) {
      const m = markets.get(cid);
      if (!m || m.tokenIds.length < 2) return [];
      const yes = books.get(m.tokenIds[0]), no = books.get(m.tokenIds[1]);
      if (!yes || yes.bestAsk == null || !no || no.bestAsk == null) return [];
      legsYes.push({ conditionId: cid, tokenId: m.tokenIds[0], instrument: m.tokenIds[0], side: "BUY", price: yes.bestAsk, size: yes.askSize, market: m, reference: { book: yes, feeRateBps: m.feeRateBps || 0, conditionId: cid } });
      legsNo.push({ conditionId: cid, tokenId: m.tokenIds[1], instrument: m.tokenIds[1], side: "BUY", price: no.bestAsk, size: no.askSize, market: m, reference: { book: no, feeRateBps: m.feeRateBps || 0, conditionId: cid } });
    }
    const n = ids.size;
    const sumYes = legsYes.reduce((s, l) => s + l.price, 0);
    const sumNo = legsNo.reduce((s, l) => s + l.price, 0);
    const out = [];
    // Buy every YES: pays exactly 1 for a cost of sumYes.
    out.push({ model: "consistency", instrument: `group:${groupId}:yes`, groupId, legs: legsYes, cost: sumYes, payout: 1, n, tier: 1, group: groupId, why });
    // Buy every NO: pays exactly n-1 for a cost of sumNo.
    out.push({ model: "consistency", instrument: `group:${groupId}:no`, groupId, legs: legsNo, cost: sumNo, payout: n - 1, n, tier: 1, group: groupId, why });
    return out;
  }

  return {
    venue: "polymarket",
    name: "polymarket_models",
    state: { markets, groups, books, facts },

    ingest(event) {
      const p = event.payload || {};
      if (event.kind === "market") {
        if (p.isGroup) { groups.set(p.groupId, new Set(p.conditionIds)); return consistencyCandidates(p.groupId, "group"); }
        if (p.conditionId) { markets.set(p.conditionId, p); return facts.has(p.conditionId) ? [resolvedFactCandidate(p.conditionId, "market")].filter(Boolean) : []; }
        return [];
      }
      if (event.kind === "fact") {
        if (!p.conditionId) return [];
        facts.set(p.conditionId, p);
        return [resolvedFactCandidate(p.conditionId, "fact")].filter(Boolean);
      }
      if (event.kind === "book") {
        books.set(String(event.id), p);
        const out = [];
        for (const [cid, m] of markets) {
          if (!m.tokenIds.includes(String(event.id))) continue;
          if (facts.has(cid)) { const c = resolvedFactCandidate(cid, "book"); if (c) out.push(c); }
          if (m.negRisk && m.groupId && groups.has(m.groupId)) out.push(...consistencyCandidates(m.groupId, "book"));
        }
        return out;
      }
      return [];
    },

    gates: [
      { name: "market_open", check: c => {
          const ms = c.model === "consistency" ? c.legs.map(l => l.market) : [c.market];
          const bad = ms.filter(m => !m.active || m.closed || m.acceptingOrders === false).map(m => `CLOSED:${m.conditionId.slice(0, 10)}`);
          return { pass: bad.length === 0, reasons: bad };
        } },
      { name: "not_disputed", check: c => {
          const ms = c.model === "consistency" ? c.legs.map(l => l.market) : [c.market];
          const bad = ms.filter(m => /disput|challeng/i.test(JSON.stringify(m.umaResolutionStatus || ""))).map(m => `DISPUTED:${m.conditionId.slice(0, 10)}`);
          return { pass: bad.length === 0, reasons: bad };
        } },
      { name: "rules_source_match", check: c => {
          if (c.model !== "resolved_fact") return { pass: true };
          if (!c.market.resolutionSource) return { pass: false, reasons: ["NO_RESOLUTION_SOURCE_IN_RULES"] };
          if (!sourcesMatch(c.market.resolutionSource, c.fact.source)) return { pass: false, reasons: [`SOURCE_MISMATCH:${c.market.resolutionSource}!=${c.fact.source}`] };
          return { pass: true };
        } },
      { name: "fact_confidence", check: c => c.model !== "resolved_fact" ? { pass: true } : { pass: (c.fact.confidence || 0) >= factMinConfidence, reasons: [`FACT_CONFIDENCE_${c.fact.confidence}`] } },
      { name: "book_present", check: c => {
          if (c.model === "consistency") {
            const thin = c.legs.filter(l => !(l.size >= minAskSize)).map(l => `THIN:${l.tokenId}`);
            return { pass: thin.length === 0, reasons: thin };
          }
          if (!c.book || c.book.bestAsk == null) return { pass: false, reasons: ["NO_BOOK"] };
          if (!(c.book.askSize >= minAskSize)) return { pass: false, reasons: [`THIN_ASK_${c.book.askSize}`] };
          return { pass: true };
        } },
      { name: "price_room", check: c => {
          if (c.model === "consistency") {
            const fees = c.legs.reduce((s, l) => s + feeFraction(l.market), 0) / c.legs.length;
            const room = c.payout - c.cost - c.cost * fees;
            return { pass: room > consistencyMargin * c.payout, reasons: [`SUM_${c.cost.toFixed(4)}_NO_ROOM_VS_${c.payout}`] };
          }
          const ask = c.book.bestAsk;
          const ceiling = 1 - feeFraction(c.market) - margin;
          return { pass: ask <= ceiling && ask > 0, reasons: [`ASK_${ask}_ABOVE_${ceiling.toFixed(4)}`] };
        } },
      { name: "model_enabled", check: c => c.model === "stale_quote" && !enableStaleQuote ? { pass: false, reasons: ["STALE_QUOTE_DISABLED"] } : { pass: true } },
    ],

    estimate(c) {
      if (c.model === "consistency") {
        const payoff = (c.payout - c.cost) / c.cost; // per unit stake, when every leg fills
        return { p_win: consistencyPWin, payoff, confidence: 0.9, tier: 1, stop_fraction: planFor("polymarket", "consistency").worst_case_fraction, group: c.groupId,
          reasons: [`consistency ${c.n} legs cost ${c.cost.toFixed(4)} pays ${c.payout}`] };
      }
      const ask = c.book.bestAsk;
      return { p_win: c.fact.confidence, payoff: (1 - ask) / ask, confidence: c.fact.confidence, tier: 1, stop_fraction: planFor("polymarket", "resolved_fact").worst_case_fraction, group: c.group,
        reasons: [`resolved by ${c.fact.source} -> ${c.fact.outcome} @ ask ${ask}`] };
    },

    costs(c) {
      const fee = c.model === "consistency" ? c.legs.reduce((s, l) => s + feeFraction(l.market), 0) / c.legs.length : feeFraction(c.market);
      const payoff = c.model === "consistency" ? (c.payout - c.cost) / c.cost : (1 - c.book.bestAsk) / c.book.bestAsk;
      const gas = gasUsd / nominalStakeUsd;
      // Fees are charged on proceeds; express as a fraction of stake. Spread is already in the ask.
      return { fraction: fee * payoff + gas, detail: { fee, gas } };
    },
  };
}
