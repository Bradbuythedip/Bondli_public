// BONDLI v4.0 — Trade Router (PumpFun vs Bags/Meteora vs Raydium)
//
// Tri-path routing:
//   1. Bags token (Meteora DBC) → route through Bags API
//   2. PumpFun token (on bonding curve) → route through PumpFun
//   3. Graduated token → route through Raydium/Jupiter
//
// The router is launchpad-agnostic — callers don't need to know
// where a token lives. Just call buy/sell with the mint.

import { PumpFunClient } from "./pumpfun-client.mjs";
import { RaydiumClient } from "./raydium-client.mjs";
import { BagsClient } from "./bags-client.mjs";
import CONFIG from "./config.mjs";
import { Connection } from "@solana/web3.js";

export class TradeRouter {
  constructor() {
    this.connection = new Connection(CONFIG.RPC_URL, "confirmed");
    this.pump = new PumpFunClient(this.connection);
    this.ray = new RaydiumClient(this.connection);
    this.bags = new BagsClient();
    this.graduated = new Map(); // mint -> { value, timestamp }
    this.bagsTokens = new Map(); // mint -> { isBags, timestamp }
    this.CACHE_TTL = 30_000;
    this.BAGS_CACHE_TTL = 120_000; // Bags check is expensive, cache longer
  }

  // Determine token source: "bags" | "pump" | "graduated"
  async getRoute(mint) {
    // Check Bags cache first
    const bagsCached = this.bagsTokens.get(mint);
    if (bagsCached && Date.now() - bagsCached.timestamp < this.BAGS_CACHE_TTL) {
      if (bagsCached.isBags) return "bags";
    }

    // Check if token has _source flag (set by bags-client normalization)
    // This is the fast path for tokens we already know about
    if (bagsCached?.isBags) return "bags";

    // Check PumpFun graduation
    const grad = await this.isGraduated(mint);
    if (grad) return "graduated";

    // Check if it's a Bags token (slower, API call)
    try {
      const isBags = await this.bags.isBagsToken(mint);
      this.bagsTokens.set(mint, { isBags, timestamp: Date.now() });
      if (isBags) return "bags";
    } catch {
      // If Bags API fails, assume not a Bags token
    }

    return "pump";
  }

  // Mark a mint as a known Bags token (called when token comes from Bags monitor)
  markBagsToken(mint) {
    this.bagsTokens.set(mint, { isBags: true, timestamp: Date.now() });
  }

  async isGraduated(mint) {
    const cached = this.graduated.get(mint);
    if (cached && (cached.value === true || Date.now() - cached.timestamp < this.CACHE_TTL)) {
      return cached.value;
    }
    try {
      const state = await this.pump.getCurveState(mint);
      const grad = state ? state.graduated : true;
      this.graduated.set(mint, { value: grad, timestamp: Date.now() });
      return grad;
    } catch {
      return cached?.value ?? false;
    }
  }

  async buy(keypair, mint, solAmount, opts = {}) {
    const route = opts._source === "bags" ? "bags" : await this.getRoute(mint);

    if (route === "bags") {
      console.log(`[ROUTER] ${mint.slice(0,8)}... Bags/Meteora DBC -> Bags API`);
      return this.bags.trade({
        mint,
        wallet: keypair.publicKey.toBase58(),
        side: "buy",
        amount: solAmount,
        slippage: opts.slippage,
        signedTx: opts.signedTx,
      });
    }

    if (route === "graduated") {
      console.log(`[ROUTER] ${mint.slice(0,8)}... graduated -> Jupiter`);
      return this.ray.buy(keypair, mint, solAmount, opts);
    }

    console.log(`[ROUTER] ${mint.slice(0,8)}... on curve -> PumpFun`);
    return this.pump.buy(keypair, mint, solAmount, opts);
  }

  async sell(keypair, mint, tokenAmount, opts = {}) {
    const route = opts._source === "bags" ? "bags" : await this.getRoute(mint);

    if (route === "bags") {
      console.log(`[ROUTER] ${mint.slice(0,8)}... Bags/Meteora DBC -> Bags API`);
      return this.bags.trade({
        mint,
        wallet: keypair.publicKey.toBase58(),
        side: "sell",
        amount: tokenAmount,
        slippage: opts.slippage,
        signedTx: opts.signedTx,
      });
    }

    if (route === "graduated") {
      return this.ray.sell(keypair, mint, tokenAmount, opts);
    }

    return this.pump.sell(keypair, mint, tokenAmount, opts);
  }

  async getCurveInfo(mint) {
    // Check if Bags token first
    const bagsCached = this.bagsTokens.get(mint);
    if (bagsCached?.isBags) {
      try {
        const token = await this.bags.getToken(mint);
        return {
          exists: true,
          graduated: false, // Bags tokens don't "graduate" — they stay on Meteora DBC
          source: "bags",
          price: token.priceUsd || 0,
          liquidity: token.liquidity || 0,
          holderCount: token.holderCount || 0,
          creatorFee: 0.01, // 1% perpetual
        };
      } catch {
        return { exists: false, source: "bags" };
      }
    }

    try {
      const state = await this.pump.getCurveState(mint);
      if (!state) return { exists: false };
      return {
        exists: true,
        graduated: state.graduated,
        source: "pump",
        price: this.pump.getPrice(state),
        solReserves: state.realSolReserves / 1e9,
        progress: Math.min(100, (state.realSolReserves / 85e9) * 100),
        ...state,
      };
    } catch (e) {
      return { exists: false, error: e.message };
    }
  }

  // Get Bags client for direct API access
  getBagsClient() {
    return this.bags;
  }
}

export default TradeRouter;
