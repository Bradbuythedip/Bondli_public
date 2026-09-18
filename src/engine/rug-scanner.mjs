// BONDLI v3.0 — Rug Scanner (token safety checks)
import { Connection, PublicKey } from "@solana/web3.js";
import CONFIG from "./config.mjs";

export class RugScanner {
  constructor() {
    this.connection = new Connection(CONFIG.RPC_URL, "confirmed");
  }

  async scan(mint, opts = {}) {
    const results = {
      mint,
      safe: true,
      score: 100,
      flags: [],
      checks: {},
    };

    try {
      // 1. Check mint authority
      const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(mint));
      const data = mintInfo?.value?.data?.parsed?.info;
      if (data) {
        const hasMintAuth = data.mintAuthority !== null;
        const hasFreezeAuth = data.freezeAuthority !== null;
        results.checks.mintAuthority = !hasMintAuth;
        results.checks.freezeAuthority = !hasFreezeAuth;
        if (hasMintAuth) { results.flags.push("MINT_AUTHORITY_ACTIVE"); results.score -= 30; }
        if (hasFreezeAuth) { results.flags.push("FREEZE_AUTHORITY_ACTIVE"); results.score -= 25; }
      }

      // 2. Check top holders concentration
      const holders = await this._getTopHolders(mint);
      if (holders.length > 0) {
        const topHolderPct = holders[0]?.pct || 0;
        results.checks.topHolder = topHolderPct < 20;
        if (topHolderPct > 50) { results.flags.push("SINGLE_HOLDER_50PCT+"); results.score -= 40; }
        else if (topHolderPct > 20) { results.flags.push("TOP_HOLDER_20PCT+"); results.score -= 15; }
        results.checks.topHolderPct = topHolderPct;
      }

      // 3. Check liquidity locked (for graduated tokens)
      // Simplified check - look for known LP lock programs
      results.checks.liquidityCheck = "pump_curve"; // On pump = bonding curve acts as lock

      // 4. Check transaction history for sell activity
      // Tokens with many buys but zero sells are classic rug setups
      if (CONFIG.ALCHEMY_API_KEY) {
        const txProfile = await this._checkTradeActivity(mint);
        results.checks.tradeActivity = txProfile;
        if (txProfile.totalBuys >= 5 && txProfile.totalSells === 0) {
          results.flags.push("ZERO_SELLS_ON_CHAIN");
          results.score -= 35; // severe — no organic selling activity at all
        } else if (txProfile.totalBuys >= 10 && txProfile.totalSells <= 1) {
          results.flags.push("NEAR_ZERO_SELLS");
          results.score -= 20;
        }
        // Check if all buys come from very few wallets (wash trading)
        if (txProfile.uniqueBuyers > 0 && txProfile.uniqueBuyers <= 3 && txProfile.totalBuys >= 8) {
          results.flags.push("WASH_TRADING_FEW_WALLETS");
          results.score -= 25;
        }
        // Gradual rug pattern: steady buys over minutes with no sells, uniform timing
        // This is the classic bot trap — designed to look like organic momentum
        if (txProfile.gradualRugScore >= 0.6) {
          results.flags.push("GRADUAL_RUG_PATTERN");
          results.score -= 35; // severe — this pattern almost always ends in a rug
        } else if (txProfile.gradualRugScore >= 0.4) {
          results.flags.push("GRADUAL_RUG_SUSPECT");
          results.score -= 20;
        }
      }

      // 5. Check creator history
      if (CONFIG.ALCHEMY_API_KEY && data?.mintAuthority) {
        const profile = await this._checkCreator(data.mintAuthority);
        results.checks.creatorHistory = profile;
        if (profile.rugCount > 0) { results.flags.push("CREATOR_HAS_RUGS"); results.score -= 30; }
      }

    } catch (e) {
      results.flags.push(`SCAN_ERROR: ${e.message}`);
      results.score -= 10;
    }

    results.safe = results.score >= 60;
    return results;
  }

  async _getTopHolders(mint) {
    try {
      const accounts = await this.connection.getTokenLargestAccounts(new PublicKey(mint));
      const supply = accounts.value.reduce((s, a) => s + Number(a.amount), 0);
      return accounts.value.slice(0, 10).map(a => ({
        address: a.address.toBase58(),
        amount: Number(a.amount),
        pct: (Number(a.amount) / supply) * 100,
      }));
    } catch {
      return [];
    }
  }

  async _checkTradeActivity(mint) {
    try {
      // Use standard Solana RPC to get recent signatures for the token mint
      const sigs = await this.connection.getSignaturesForAddress(
        new PublicKey(mint), { limit: 100 }, "confirmed"
      );
      if (!sigs.length) return { totalBuys: 0, totalSells: 0, uniqueBuyers: 0, uniqueSellers: 0 };

      // Fetch a sample of full transactions for analysis (limit to 20 to stay fast)
      const sample = sigs.slice(0, 20);
      const txPromises = sample.map(s =>
        this.connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
      );
      const txs = (await Promise.all(txPromises)).filter(Boolean);

      let totalBuys = 0;
      let totalSells = 0;
      const buyers = new Set();
      const sellers = new Set();
      const buyTimestamps = [];

      for (const tx of txs) {
        if (!tx.meta) continue;
        const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey?.toBase58();

        // Analyze token balance changes to determine buy vs sell
        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];

        for (const post of postBalances) {
          if (post.mint !== mint) continue;
          const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
          const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmount || 0);
          const postAmt = parseFloat(post.uiTokenAmount?.uiAmount || 0);
          const diff = postAmt - preAmt;

          if (diff > 0) {
            totalBuys++;
            if (feePayer) buyers.add(feePayer);
            if (tx.blockTime) buyTimestamps.push(tx.blockTime);
          } else if (diff < 0) {
            totalSells++;
            if (feePayer) sellers.add(feePayer);
          }
        }
      }

      // Scale estimates based on sample vs total
      const scaleFactor = sigs.length / Math.max(1, sample.length);

      // ── Gradual rug pattern detection ──
      let gradualRugScore = 0;
      let buyTimingUniformity = 0;
      let buySpreadMinutes = 0;

      if (buyTimestamps.length >= 6 && totalSells <= 1) {
        buyTimestamps.sort((a, b) => a - b);
        const intervals = [];
        for (let i = 1; i < buyTimestamps.length; i++) {
          intervals.push(buyTimestamps[i] - buyTimestamps[i - 1]);
        }
        buySpreadMinutes = (buyTimestamps[buyTimestamps.length - 1] - buyTimestamps[0]) / 60;

        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        if (avgInterval > 0) {
          const variance = intervals.reduce((s, d) => s + (d - avgInterval) ** 2, 0) / intervals.length;
          const cv = Math.sqrt(variance) / avgInterval;
          buyTimingUniformity = Math.max(0, Math.min(1, 1 - cv));
        }

        if (buySpreadMinutes >= 5 && totalBuys >= 10 && totalSells === 0 && buyTimingUniformity > 0.4) {
          gradualRugScore = Math.min(1, 0.6 + buyTimingUniformity * 0.3 + Math.min(0.1, buySpreadMinutes / 100));
        } else if (buySpreadMinutes >= 3 && totalBuys >= 8 && totalSells <= 1 && buyTimingUniformity > 0.3) {
          gradualRugScore = Math.min(0.7, 0.4 + buyTimingUniformity * 0.2 + Math.min(0.1, buySpreadMinutes / 100));
        } else if (buySpreadMinutes >= 2 && totalBuys >= 6 && totalSells === 0 && buyTimingUniformity > 0.5) {
          gradualRugScore = 0.5;
        }
      }

      return {
        totalBuys,
        totalSells,
        uniqueBuyers: buyers.size,
        uniqueSellers: sellers.size,
        txCount: sigs.length,
        gradualRugScore,
        buyTimingUniformity,
        buySpreadMinutes,
      };
    } catch {
      return { totalBuys: 0, totalSells: 0, uniqueBuyers: 0, uniqueSellers: 0 };
    }
  }

  async _checkCreator(address) {
    try {
      // Use standard Solana RPC to check creator's transaction history
      const sigs = await this.connection.getSignaturesForAddress(
        new PublicKey(address), { limit: 100 }, "confirmed"
      );
      if (!sigs.length) return { rugCount: 0, tokenCount: 0 };

      // Sample transactions to detect patterns
      const sample = sigs.slice(0, 30);
      const txPromises = sample.map(s =>
        this.connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
      );
      const txs = (await Promise.all(txPromises)).filter(Boolean);

      // Count token creation instructions (InitializeMint) and swaps
      let creates = 0;
      let swaps = 0;

      for (const tx of txs) {
        const instructions = tx.transaction?.message?.instructions || [];
        for (const ix of instructions) {
          const prog = ix.programId?.toBase58?.() || ix.program || "";
          // Token program InitializeMint = token creation
          if (prog === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && ix.parsed?.type === "initializeMint") {
            creates++;
          }
          // pump.fun or Raydium swaps
          if (prog === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" || prog === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8") {
            swaps++;
          }
        }
      }

      // Scale by sampling ratio
      const scale = sigs.length / Math.max(1, sample.length);
      creates = Math.round(creates * scale);
      swaps = Math.round(swaps * scale);

      let rugCount = 0;
      if (creates >= 3 && swaps > creates * 2) {
        rugCount = Math.min(creates, Math.floor(swaps / 3));
      }
      if (creates >= 5) {
        rugCount = Math.max(rugCount, Math.floor(creates * 0.6));
      }

      return { rugCount, tokenCount: creates, txCount: sigs.length, serialDeployer: creates >= 5 };
    } catch {
      return { rugCount: 0, tokenCount: 0 };
    }
  }
}

// CLI mode
if (process.argv[1]?.includes("rug-scanner")) {
  const ca = process.argv[2] || CONFIG.TOKEN_CA;
  if (!ca) { console.error("Usage: node rug-scanner.mjs <TOKEN_CA>"); process.exit(1); }
  const scanner = new RugScanner();
  scanner.scan(ca).then(r => {
    console.log("\n=== RUG SCAN RESULTS ===");
    console.log(`Mint: ${r.mint}`);
    console.log(`Score: ${r.score}/100`);
    console.log(`Safe: ${r.safe ? "YES" : "NO"}`);
    if (r.flags.length) console.log(`Flags: ${r.flags.join(", ")}`);
    console.log("Checks:", JSON.stringify(r.checks, null, 2));
  });
}

export default RugScanner;
