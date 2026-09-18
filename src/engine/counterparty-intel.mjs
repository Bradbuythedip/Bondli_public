// BONDLI — Counter-Party Intelligence
//
// On every trade, classify WHO you're trading against:
//   BUYERS:  retail (good), smart money (very good), bots (neutral)
//   SELLERS: dev distributing (bad), snipers dumping (bad), organic profit-taking (neutral)
//
// NET SIGNAL = buyer quality - seller quality
// Surfaces intel BEFORE you trade, not just scores it silently.

import { Connection, PublicKey } from "@solana/web3.js";
import CONFIG from "./config.mjs";

// Wallet classification tiers
const WALLET_TYPES = {
  SMART_MONEY: { label: "Smart Money", weight: 2.0, color: "#00ff88" },
  RETAIL: { label: "Retail", weight: 1.0, color: "#44aaff" },
  BOT: { label: "Bot", weight: 0.3, color: "#888888" },
  SNIPER: { label: "Sniper", weight: -1.5, color: "#ff4444" },
  DEV: { label: "Dev", weight: -2.0, color: "#ff0000" },
  KOL: { label: "KOL", weight: 0.5, color: "#ffaa00" }, // neutral — could be pumping or dumping
  FRESH: { label: "Fresh Wallet", weight: -0.5, color: "#cc44cc" },
};

export class CounterpartyIntel {
  constructor() {
    this.connection = new Connection(CONFIG.RPC_URL, "confirmed");
    this.walletProfiles = new Map(); // address → { type, winRate, avgHold, txCount }
    this.smartMoneySet = new Set();
    this.sniperSet = new Set();
    this.botSet = new Set();
    this.kolSet = new Set();
  }

  /**
   * Analyze counterparty composition for a token.
   *
   * @param {string} mint - Token address
   * @param {Object} opts
   * @param {string} opts.devWallet - Known dev wallet
   * @param {Set} opts.earlyBuyers - Set of early buyer addresses
   * @returns {Object} Counterparty analysis
   */
  async analyze(mint, opts = {}) {
    const result = {
      mint,
      buyers: { smartMoney: 0, retail: 0, bot: 0, fresh: 0, total: 0 },
      sellers: { dev: 0, sniper: 0, kol: 0, retail: 0, organic: 0, total: 0 },
      netSignal: 0,          // positive = you're trading WITH smart money
      buyerQuality: 0,       // 0-100
      sellerRisk: 0,         // 0-100
      summary: "",
      recommendation: "NEUTRAL",
    };

    try {
      const sigs = await this.connection.getSignaturesForAddress(
        new PublicKey(mint), { limit: 50 }, "confirmed"
      );

      const sample = sigs.slice(0, 15);
      const txPromises = sample.map(s =>
        this.connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
      );
      const txs = (await Promise.all(txPromises)).filter(Boolean);

      const devWallet = (opts.devWallet || "").toLowerCase();
      const buyerWallets = new Map();
      const sellerWallets = new Map();

      for (const tx of txs) {
        if (!tx.meta) continue;
        const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey?.toBase58();
        if (!feePayer) continue;

        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];

        for (const post of postBalances) {
          if (post.mint !== mint) continue;
          const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
          const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmount || 0);
          const postAmt = parseFloat(post.uiTokenAmount?.uiAmount || 0);

          const wallet = feePayer.toLowerCase();
          const type = this._classifyWallet(wallet, devWallet);

          if (postAmt > preAmt) {
            // Buy
            buyerWallets.set(wallet, type);
          } else if (postAmt < preAmt) {
            // Sell
            sellerWallets.set(wallet, type);
          }
        }
      }

      // Aggregate buyer types
      for (const [, type] of buyerWallets) {
        result.buyers.total++;
        if (type === "SMART_MONEY") result.buyers.smartMoney++;
        else if (type === "BOT") result.buyers.bot++;
        else if (type === "FRESH") result.buyers.fresh++;
        else result.buyers.retail++;
      }

      // Aggregate seller types
      for (const [, type] of sellerWallets) {
        result.sellers.total++;
        if (type === "DEV") result.sellers.dev++;
        else if (type === "SNIPER") result.sellers.sniper++;
        else if (type === "KOL") result.sellers.kol++;
        else result.sellers.organic++;
      }

      // Calculate quality scores
      const bTotal = result.buyers.total || 1;
      result.buyerQuality = Math.round(
        (result.buyers.smartMoney / bTotal) * 100 * 2 +
        (result.buyers.retail / bTotal) * 100 * 1 +
        (result.buyers.bot / bTotal) * 100 * 0.3
      );
      result.buyerQuality = Math.min(100, result.buyerQuality);

      const sTotal = result.sellers.total || 1;
      result.sellerRisk = Math.round(
        (result.sellers.dev / sTotal) * 100 * 2 +
        (result.sellers.sniper / sTotal) * 100 * 1.5 +
        (result.sellers.kol / sTotal) * 100
      );
      result.sellerRisk = Math.min(100, result.sellerRisk);

      // Net signal
      result.netSignal = result.buyerQuality - result.sellerRisk;

      // Generate summary
      if (result.buyers.total > 0) {
        const parts = [];
        if (result.buyers.smartMoney > 0) parts.push(`${Math.round(result.buyers.smartMoney / bTotal * 100)}% smart money`);
        if (result.buyers.retail > 0) parts.push(`${Math.round(result.buyers.retail / bTotal * 100)}% retail`);
        if (result.buyers.bot > 0) parts.push(`${Math.round(result.buyers.bot / bTotal * 100)}% bots`);
        result.summary += `Buyers: ${parts.join(", ")}. `;
      }

      if (result.sellers.total > 0) {
        const parts = [];
        if (result.sellers.dev > 0) parts.push(`${Math.round(result.sellers.dev / sTotal * 100)}% dev`);
        if (result.sellers.sniper > 0) parts.push(`${Math.round(result.sellers.sniper / sTotal * 100)}% snipers`);
        if (result.sellers.organic > 0) parts.push(`${Math.round(result.sellers.organic / sTotal * 100)}% organic`);
        result.summary += `Sellers: ${parts.join(", ")}.`;
      }

      // Recommendation
      if (result.netSignal > 50) result.recommendation = "STRONG_BUY";
      else if (result.netSignal > 20) result.recommendation = "BUY";
      else if (result.netSignal > -20) result.recommendation = "NEUTRAL";
      else if (result.netSignal > -50) result.recommendation = "CAUTION";
      else result.recommendation = "AVOID";

    } catch (e) {
      result.summary = `Analysis error: ${e.message}`;
    }

    return result;
  }

  _classifyWallet(wallet, devWallet) {
    if (wallet === devWallet) return "DEV";
    if (this.sniperSet.has(wallet)) return "SNIPER";
    if (this.smartMoneySet.has(wallet)) return "SMART_MONEY";
    if (this.botSet.has(wallet)) return "BOT";
    if (this.kolSet.has(wallet)) return "KOL";
    return "RETAIL";
  }

  // Register wallet classifications from external sources
  registerSmartMoney(wallets) { for (const w of wallets) this.smartMoneySet.add(w.toLowerCase()); }
  registerSnipers(wallets) { for (const w of wallets) this.sniperSet.add(w.toLowerCase()); }
  registerBots(wallets) { for (const w of wallets) this.botSet.add(w.toLowerCase()); }
  registerKols(wallets) { for (const w of wallets) this.kolSet.add(w.toLowerCase()); }
}

export { WALLET_TYPES };
export default CounterpartyIntel;
