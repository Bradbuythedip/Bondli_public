// BONDLI v3.0 — Signal Detector (Tatum RPC + X API Wallet Profiling)
import { Connection, PublicKey } from "@solana/web3.js";
import CONFIG from "./config.mjs";

export class SignalDetector {
  constructor() {
    this.profiles = new Map();
    this.connection = new Connection(CONFIG.RPC_URL, "confirmed");
  }

  // Profile a wallet using Solana RPC transaction history
  async profileWallet(address) {
    if (this.profiles.has(address)) return this.profiles.get(address);

    const profile = {
      address,
      txCount: 0,
      pumpTxCount: 0,
      avgHoldTime: 0,
      winRate: 0,
      totalVolume: 0,
      firstSeen: null,
      isBot: false,
      riskScore: 0,
    };

    try {
      if (CONFIG.ALCHEMY_API_KEY) {
        const sigs = await this.connection.getSignaturesForAddress(
          new PublicKey(address), { limit: 50 }, "confirmed"
        );
        profile.txCount = sigs.length;
        if (sigs.length > 0) {
          profile.firstSeen = sigs[sigs.length - 1]?.blockTime;
        }

        // Bot detection: high frequency, low variance in timing
        if (profile.txCount >= 20) {
          const gaps = [];
          for (let i = 1; i < Math.min(sigs.length, 20); i++) {
            if (sigs[i-1].blockTime && sigs[i].blockTime) {
              gaps.push(sigs[i-1].blockTime - sigs[i].blockTime);
            }
          }
          if (gaps.length > 0) {
            const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            const variance = gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length;
            const cv = Math.sqrt(variance) / avgGap;
            profile.isBot = cv < 0.3 && avgGap < 10;
          }
        }

        profile.riskScore = this._calcRisk(profile);
      }
    } catch (e) {
      console.error(`[SIGNAL] Profile error for ${address.slice(0,8)}: ${e.message}`);
    }

    this.profiles.set(address, profile);
    return profile;
  }

  // Check X/Twitter for token mentions
  async getTokenSentiment(tokenName) {
    if (!CONFIG.X_BEARER_TOKEN) return { mentions: 0, sentiment: "neutral" };

    try {
      const res = await fetch(
        `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(tokenName)}&max_results=100`,
        { headers: { Authorization: `Bearer ${CONFIG.X_BEARER_TOKEN}` } }
      );
      if (!res.ok) return { mentions: 0, sentiment: "neutral" };
      const data = await res.json();
      const count = data.meta?.result_count || 0;
      return {
        mentions: count,
        sentiment: count > 50 ? "hot" : count > 10 ? "warm" : "cold",
        trending: count > 100,
      };
    } catch {
      return { mentions: 0, sentiment: "neutral" };
    }
  }

  _calcRisk(profile) {
    let risk = 0;
    if (profile.isBot) risk += 40;
    if (profile.txCount < 5) risk += 20; // new wallet
    if (!profile.firstSeen || Date.now()/1000 - profile.firstSeen < 86400) risk += 25; // <1 day old
    return Math.min(100, risk);
  }
}

export default SignalDetector;
