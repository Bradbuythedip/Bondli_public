// BONDLI v3.0 — PumpFun Bonding Curve Client
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import CONFIG from "./config.mjs";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_FEE = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJt85gtBk6jR");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMP_EVENT_AUTH = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const RENT_PROGRAM = new PublicKey("SysvarRent111111111111111111111111111111111");
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

export class PumpFunClient {
  constructor(connection) {
    this.connection = connection || new Connection(CONFIG.RPC_URL, "confirmed");
    this.dryRun = CONFIG.DRY_RUN;
  }

  // Derive bonding curve PDA for a given mint
  async getBondingCurve(mint) {
    const [curve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
      PUMP_PROGRAM
    );
    return curve;
  }

  // Fetch bonding curve state
  async getCurveState(mint) {
    const curve = await this.getBondingCurve(mint);
    const info = await this.connection.getAccountInfo(curve);
    if (!info) return null;
    // Decode: virtualTokenReserves(u64) + virtualSolReserves(u64) + realTokenReserves(u64) + realSolReserves(u64) + tokenTotalSupply(u64)
    const data = info.data;
    return {
      address: curve.toBase58(),
      virtualTokenReserves: Number(data.readBigUInt64LE(8)),
      virtualSolReserves:   Number(data.readBigUInt64LE(16)),
      realTokenReserves:    Number(data.readBigUInt64LE(24)),
      realSolReserves:      Number(data.readBigUInt64LE(32)),
      tokenTotalSupply:     Number(data.readBigUInt64LE(40)),
      graduated:            Number(data.readBigUInt64LE(32)) >= 85_000_000_000, // ~85 SOL threshold
    };
  }

  // Calculate price from curve state
  getPrice(state) {
    if (!state) return 0;
    return state.virtualSolReserves / state.virtualTokenReserves;
  }

  // Estimate tokens out for SOL in (buy)
  estimateBuy(state, solAmount) {
    const lamports = solAmount * 1e9;
    const newSolReserves = state.virtualSolReserves + lamports;
    const newTokenReserves = (state.virtualSolReserves * state.virtualTokenReserves) / newSolReserves;
    return Math.floor(state.virtualTokenReserves - newTokenReserves);
  }

  // Estimate SOL out for tokens in (sell)
  estimateSell(state, tokenAmount) {
    const newTokenReserves = state.virtualTokenReserves + tokenAmount;
    const newSolReserves = (state.virtualSolReserves * state.virtualTokenReserves) / newTokenReserves;
    return Math.floor(state.virtualSolReserves - newSolReserves);
  }

  // Execute buy
  async buy(keypair, mint, solAmount, opts = {}) {
    const slippage = opts.slippage || CONFIG.SLIPPAGE_BPS;
    const state = await this.getCurveState(mint);
    if (!state) throw new Error("Bonding curve not found");
    if (state.graduated) throw new Error("Token graduated - use Raydium");

    const tokensOut = this.estimateBuy(state, solAmount);
    const minTokens = Math.floor(tokensOut * (1 - slippage / 10000));

    if (this.dryRun) {
      return {
        type: "buy", mint, solAmount, tokensOut, minTokens,
        price: this.getPrice(state), dryRun: true,
        sig: "DRY_" + Date.now().toString(36),
      };
    }

    // Build and send transaction (simplified - actual impl needs full IX encoding)
    const sig = await this._sendPumpTx(keypair, mint, "buy", solAmount, minTokens, opts);
    return { type: "buy", mint, solAmount, tokensOut, sig, price: this.getPrice(state) };
  }

  // Execute sell
  async sell(keypair, mint, tokenAmount, opts = {}) {
    const slippage = opts.slippage || CONFIG.SLIPPAGE_BPS;
    const state = await this.getCurveState(mint);
    if (!state) throw new Error("Bonding curve not found");
    if (state.graduated) throw new Error("Token graduated - use Raydium");

    const solOut = this.estimateSell(state, tokenAmount);
    const minSol = Math.floor(solOut * (1 - slippage / 10000));

    if (this.dryRun) {
      return {
        type: "sell", mint, tokenAmount, solOut: solOut / 1e9, minSol: minSol / 1e9,
        price: this.getPrice(state), dryRun: true,
        sig: "DRY_" + Date.now().toString(36),
      };
    }

    const sig = await this._sendPumpTx(keypair, mint, "sell", tokenAmount, minSol, opts);
    return { type: "sell", mint, tokenAmount, solOut: solOut / 1e9, sig, price: this.getPrice(state) };
  }

  async _sendPumpTx(keypair, mint, side, amount, minOut, opts) {
    const tx = await this.buildPumpTx(keypair, mint, side, amount, minOut, opts);
    console.log(`[PUMP] ${side.toUpperCase()} ${amount} on ${mint}`);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    await this.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  // Build and sign the pump.fun buy/sell transaction without sending it.
  // Callers that want a different send path (e.g. RPC + Jito race) use this.
  async buildPumpTx(keypair, mint, side, amount, minOut, opts = {}) {
    const mintPk = new PublicKey(mint);
    const curve = await this.getBondingCurve(mint);
    const curveAta = getAssociatedTokenAddressSync(mintPk, curve, true);
    const userAta = getAssociatedTokenAddressSync(mintPk, keypair.publicKey, true);

    const tx = new Transaction();
    tx.feePayer = keypair.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    // Priority fee via compute budget
    if (CONFIG.PRIORITY_FEE > 0) {
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.PRIORITY_FEE }));
    }

    // Build pump.fun instruction data: discriminator(8) + amount(u64) + minOut(u64)
    const data = Buffer.alloc(24);
    const disc = side === "buy" ? BUY_DISCRIMINATOR : SELL_DISCRIMINATOR;
    disc.copy(data, 0);
    data.writeBigUInt64LE(BigInt(Math.floor(side === "buy" ? amount * 1e9 : amount)), 8);
    data.writeBigUInt64LE(BigInt(Math.floor(minOut)), 16);

    const keys = [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE, isSigner: false, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: curveAta, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTH, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ];

    tx.add(new TransactionInstruction({ programId: PUMP_PROGRAM, keys, data }));
    tx.sign(keypair);
    return tx;
  }
}

export default PumpFunClient;
