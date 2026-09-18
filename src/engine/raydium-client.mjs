// BONDLI v3.0 — Raydium/Jupiter Post-Graduation Trading
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import CONFIG from "./config.mjs";

const JUPITER_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP  = "https://quote-api.jup.ag/v6/swap";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export class RaydiumClient {
  constructor(connection) {
    this.connection = connection || new Connection(CONFIG.RPC_URL, "confirmed");
    this.dryRun = CONFIG.DRY_RUN;
  }

  // Get Jupiter quote
  async getQuote(inputMint, outputMint, amount, slippageBps) {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: (slippageBps || CONFIG.SLIPPAGE_BPS).toString(),
    });
    const res = await fetch(`${JUPITER_QUOTE}?${params}`);
    if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
    return res.json();
  }

  // Buy token with SOL via Jupiter
  async buy(keypair, mint, solAmount, opts = {}) {
    const lamports = Math.floor(solAmount * 1e9);
    const quote = await this.getQuote(SOL_MINT, mint, lamports, opts.slippage);

    if (this.dryRun) {
      return {
        type: "buy", mint, solAmount,
        tokensOut: parseInt(quote.outAmount),
        price: lamports / parseInt(quote.outAmount),
        dryRun: true,
        sig: "DRY_RAY_" + Date.now().toString(36),
      };
    }

    const swapRes = await fetch(JUPITER_SWAP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE,
      }),
    });
    const { swapTransaction } = await swapRes.json();
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([keypair]);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await this.connection.confirmTransaction(sig, "confirmed");
    return { type: "buy", mint, solAmount, tokensOut: parseInt(quote.outAmount), sig };
  }

  // Sell token for SOL via Jupiter
  async sell(keypair, mint, tokenAmount, opts = {}) {
    const quote = await this.getQuote(mint, SOL_MINT, tokenAmount, opts.slippage);

    if (this.dryRun) {
      return {
        type: "sell", mint, tokenAmount,
        solOut: parseInt(quote.outAmount) / 1e9,
        dryRun: true,
        sig: "DRY_RAY_" + Date.now().toString(36),
      };
    }

    const swapRes = await fetch(JUPITER_SWAP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE,
      }),
    });
    const { swapTransaction } = await swapRes.json();
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([keypair]);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await this.connection.confirmTransaction(sig, "confirmed");
    return { type: "sell", mint, tokenAmount, solOut: parseInt(quote.outAmount) / 1e9, sig };
  }
}

export default RaydiumClient;
