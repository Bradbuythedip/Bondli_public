// BONDLI v3.0 — On-Chain Payment Verification
// Verifies SOL payments on Solana before granting access
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const PLATFORM_WALLET = process.env.PLATFORM_WALLET || "anal.sol";
const ACCESS_FEE_SOL  = parseFloat(process.env.ACCESS_FEE_SOL || "0.1");
const GRACE_LAMPORTS  = 5000; // tiny tolerance for rounding

// Resolve .sol domain to pubkey (via SNS or hardcoded)
async function resolvePlatformWallet(connection) {
  // If it looks like a pubkey already, use it
  try {
    new PublicKey(PLATFORM_WALLET);
    return PLATFORM_WALLET;
  } catch {
    // It is a .sol domain — resolve via Bonfida SNS
    // For production, resolve via @bonfida/spl-name-service
    // Fallback: hardcode the resolved address in .env
    console.warn("[PAY] .sol domain detected. Set PLATFORM_WALLET_RESOLVED in .env for production.");
    return process.env.PLATFORM_WALLET_RESOLVED || null;
  }
}

export class PaymentVerifier {
  constructor(connection) {
    this.connection = connection || new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
    this.verifiedPayments = new Map(); // txSig -> { wallet, amount, time }
    this.platformPubkey = null;
  }

  async init() {
    this.platformPubkey = await resolvePlatformWallet(this.connection);
    if (!this.platformPubkey) {
      console.error("[PAY] Could not resolve platform wallet. Set PLATFORM_WALLET_RESOLVED.");
    }
    return this;
  }

  // Verify a payment transaction
  async verifyPayment(txSig, claimedWallet) {
    // 1. Check if already verified (replay protection)
    if (this.verifiedPayments.has(txSig)) {
      const existing = this.verifiedPayments.get(txSig);
      if (existing.wallet === claimedWallet) {
        return { verified: true, cached: true, ...existing };
      }
      return { verified: false, error: "Transaction already used by different wallet" };
    }

    // 2. Fetch transaction from chain
    let tx;
    try {
      tx = await this.connection.getParsedTransaction(txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    } catch (e) {
      return { verified: false, error: `Failed to fetch transaction: ${e.message}` };
    }

    if (!tx) {
      return { verified: false, error: "Transaction not found. It may still be confirming." };
    }

    // 3. Check transaction succeeded
    if (tx.meta?.err) {
      return { verified: false, error: "Transaction failed on-chain" };
    }

    // 4. Check age (reject payments older than 1 hour)
    const txTime = (tx.blockTime || 0) * 1000;
    const age = Date.now() - txTime;
    if (age > 3600_000) {
      return { verified: false, error: "Transaction too old (>1 hour). Send a new payment." };
    }

    // 5. Find SOL transfer to platform wallet
    const instructions = tx.transaction?.message?.instructions || [];
    let paymentFound = false;
    let amount = 0;

    for (const ix of instructions) {
      if (ix.program === "system" && ix.parsed?.type === "transfer") {
        const info = ix.parsed.info;
        // Check destination matches platform
        if (info.destination === this.platformPubkey) {
          amount = info.lamports / LAMPORTS_PER_SOL;
          // Check sender matches claimed wallet
          if (info.source === claimedWallet) {
            paymentFound = true;
          }
        }
      }
    }

    if (!paymentFound) {
      return {
        verified: false,
        error: `No matching payment found. Expected ${ACCESS_FEE_SOL} SOL from ${claimedWallet} to platform wallet.`,
      };
    }

    // 6. Check amount meets minimum
    const minLamports = ACCESS_FEE_SOL * LAMPORTS_PER_SOL - GRACE_LAMPORTS;
    if (amount * LAMPORTS_PER_SOL < minLamports) {
      return {
        verified: false,
        error: `Insufficient payment. Sent ${amount} SOL, required ${ACCESS_FEE_SOL} SOL.`,
      };
    }

    // 7. Verified!
    const record = {
      wallet: claimedWallet,
      amount,
      txSig,
      time: Date.now(),
      blockTime: txTime,
    };
    this.verifiedPayments.set(txSig, record);

    return { verified: true, ...record };
  }

  // Check if a wallet has any verified payment
  isWalletPaid(wallet) {
    for (const record of this.verifiedPayments.values()) {
      if (record.wallet === wallet) return true;
    }
    return false;
  }

  // Get payment stats
  stats() {
    return {
      totalVerified: this.verifiedPayments.size,
      totalRevenue: Array.from(this.verifiedPayments.values()).reduce((s, r) => s + r.amount, 0),
    };
  }
}

export default PaymentVerifier;
