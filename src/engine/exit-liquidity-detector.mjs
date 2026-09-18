// BONDLI — Exit Liquidity Detector
//
// The problem: No platform tells you when you're about to become someone else's exit.
//
// Before every buy, analyze WHO is selling into your order:
// - Block 0-1 snipers dumping? → YOU ARE THE EXIT LIQUIDITY
// - Dev wallet distributing? → YOU ARE THE EXIT LIQUIDITY
// - KOL wallet that tweeted about it selling? → bag dump in progress
// - Organic holders taking profit? → normal, proceed with caution
// - No concentrated sellers? → clean order book, green light
//
// In auto-ape mode: if exit liquidity risk > threshold, reduce size or skip.

import { Connection, PublicKey } from "@solana/web3.js";
import CONFIG from "./config.mjs";

export class ExitLiquidityDetector {
  constructor() {
    this.connection = new Connection(CONFIG.RPC_URL, "confirmed");
    this.knownSnipers = new Set(); // populated from Redis/tracker
    this.knownKols = new Set();    // populated from KOL monitor
  }

  /**
   * Analyze who is selling into your potential buy.
   * Call BEFORE executing a trade.
   *
   * @param {string} mint - Token mint address
   * @param {Object} tokenData - Token data with devWallet, early buyers, etc.
   * @returns {Object} Exit liquidity analysis
   */
  async analyze(mint, tokenData = {}) {
    const result = {
      mint,
      risk: "UNKNOWN",    // GREEN | CAUTION | WARNING | DANGER
      riskScore: 0,        // 0-100 (higher = more dangerous)
      sellerBreakdown: {
        snipers: 0,        // block 0-1 snipers
        devWallet: 0,      // dev selling
        kolWallets: 0,     // KOL bag dumps
        earlyBuyers: 0,    // early accumulators exiting
        organic: 0,        // normal profit-taking
        unknown: 0,
      },
      warnings: [],
      sellerDetails: [],
    };

    try {
      // Get recent sell transactions
      const sigs = await this.connection.getSignaturesForAddress(
        new PublicKey(mint), { limit: 50 }, "confirmed"
      );

      if (!sigs.length) {
        result.risk = "GREEN";
        result.warnings.push("No recent activity");
        return result;
      }

      // Sample recent transactions to identify sellers
      const sample = sigs.slice(0, 20);
      const txPromises = sample.map(s =>
        this.connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
      );
      const txs = (await Promise.all(txPromises)).filter(Boolean);

      const sellers = new Map(); // wallet → { totalSold, entryBlock, classification }
      const devWallet = (tokenData.devWallet || "").toLowerCase();
      const earlyBuyers = new Set((tokenData.earlyBuyers || []).map(w => w.toLowerCase()));

      for (const tx of txs) {
        if (!tx.meta) continue;
        const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey?.toBase58();
        if (!feePayer) continue;

        // Check for token sells (balance decreasing)
        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];

        for (const post of postBalances) {
          if (post.mint !== mint) continue;
          const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
          const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmount || 0);
          const postAmt = parseFloat(post.uiTokenAmount?.uiAmount || 0);

          if (postAmt < preAmt) {
            // This is a sell
            const seller = feePayer.toLowerCase();
            const existing = sellers.get(seller) || { totalSold: 0, txCount: 0, classification: "unknown" };
            existing.totalSold += preAmt - postAmt;
            existing.txCount++;

            // Classify the seller
            if (seller === devWallet) {
              existing.classification = "dev";
            } else if (this.knownSnipers.has(seller)) {
              existing.classification = "sniper";
            } else if (this.knownKols.has(seller)) {
              existing.classification = "kol";
            } else if (earlyBuyers.has(seller)) {
              existing.classification = "early_buyer";
            } else {
              existing.classification = "organic";
            }

            sellers.set(seller, existing);
          }
        }
      }

      // Aggregate seller classifications
      let totalSellVolume = 0;
      for (const [wallet, info] of sellers) {
        totalSellVolume += info.totalSold;
        result.sellerBreakdown[info.classification === "dev" ? "devWallet" :
          info.classification === "sniper" ? "snipers" :
          info.classification === "kol" ? "kolWallets" :
          info.classification === "early_buyer" ? "earlyBuyers" :
          "organic"]++;

        result.sellerDetails.push({
          wallet: wallet.slice(0, 8) + "...",
          classification: info.classification,
          totalSold: info.totalSold,
          txCount: info.txCount,
        });
      }

      // Calculate risk score
      let riskScore = 0;
      const { snipers, devWallet: devSelling, kolWallets, earlyBuyers: earlyExiting } = result.sellerBreakdown;

      // Dev selling = highest risk
      if (devSelling > 0) {
        riskScore += 40;
        result.warnings.push("DEV_WALLET_SELLING: Developer is distributing tokens. You are likely exit liquidity.");
      }

      // Snipers dumping
      if (snipers > 0) {
        riskScore += 30;
        result.warnings.push(`SNIPER_EXIT: ${snipers} block 0-1 sniper(s) dumping. They entered at near-zero cost.`);
      }

      // KOL bag dump
      if (kolWallets > 0) {
        riskScore += 25;
        result.warnings.push(`KOL_DUMP: ${kolWallets} known KOL wallet(s) selling. Likely promoted then dumped.`);
      }

      // Early buyers exiting
      if (earlyExiting > 2) {
        riskScore += 15;
        result.warnings.push(`EARLY_EXIT: ${earlyExiting} early accumulators taking profit.`);
      }

      // Concentrated selling (few wallets, big volume)
      if (sellers.size <= 3 && totalSellVolume > 0 && sellers.size > 0) {
        const avgPerSeller = totalSellVolume / sellers.size;
        if (avgPerSeller > totalSellVolume * 0.5) {
          riskScore += 15;
          result.warnings.push("CONCENTRATED_SELLING: Few wallets control most sell volume.");
        }
      }

      result.riskScore = Math.min(100, riskScore);
      result.risk = riskScore >= 60 ? "DANGER" : riskScore >= 35 ? "WARNING" : riskScore >= 15 ? "CAUTION" : "GREEN";

    } catch (e) {
      result.warnings.push(`Analysis error: ${e.message}`);
      result.risk = "UNKNOWN";
    }

    return result;
  }

  /**
   * Quick risk check for auto-ape mode (faster, less detailed)
   * Returns: { shouldTrade, adjustedSize, reason }
   */
  async quickCheck(mint, tokenData, baseSolAmount) {
    const analysis = await this.analyze(mint, tokenData);

    if (analysis.risk === "DANGER") {
      return {
        shouldTrade: false,
        adjustedSize: 0,
        reason: analysis.warnings[0] || "HIGH_EXIT_LIQUIDITY_RISK",
        analysis,
      };
    }

    if (analysis.risk === "WARNING") {
      return {
        shouldTrade: true,
        adjustedSize: baseSolAmount * 0.5, // half size
        reason: "REDUCED_SIZE: " + (analysis.warnings[0] || "elevated exit liquidity risk"),
        analysis,
      };
    }

    if (analysis.risk === "CAUTION") {
      return {
        shouldTrade: true,
        adjustedSize: baseSolAmount * 0.75,
        reason: "SLIGHT_REDUCTION: minor exit liquidity signals",
        analysis,
      };
    }

    return {
      shouldTrade: true,
      adjustedSize: baseSolAmount,
      reason: "GREEN: clean order book",
      analysis,
    };
  }

  // Register known sniper/KOL wallets (called by signal detector + KOL monitor)
  addSnipers(wallets) { for (const w of wallets) this.knownSnipers.add(w.toLowerCase()); }
  addKols(wallets) { for (const w of wallets) this.knownKols.add(w.toLowerCase()); }
}

export default ExitLiquidityDetector;
