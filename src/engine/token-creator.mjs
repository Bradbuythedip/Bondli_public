/**
 * PUMP.FUN TOKEN CREATOR — via Official @pump-fun/pump-sdk
 * No PumpPortal middleman. Direct on-chain via pump.fun's own SDK.
 *
 * npm install @pump-fun/pump-sdk
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";

// ═══════════════════════════════════════
// IPFS UPLOAD (unchanged, with retries)
// ═══════════════════════════════════════

async function uploadMetadata(config, maxRetries = 5) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      let hasImage = false;

      if (config.image && config.image.startsWith("data:")) {
        const m = config.image.match(/^data:(.+);base64,(.+)$/);
        if (m) {
          form.append("file", new Blob([Buffer.from(m[2], "base64")], { type: m[1] }), "token." + (m[1].includes("png") ? "png" : "jpg"));
          hasImage = true;
        }
      } else if (config.image && config.image.startsWith("http")) {
        const r = await fetch(config.image);
        form.append("file", await r.blob(), "token.png");
        hasImage = true;
      }

      if (!hasImage) {
        const px = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMU+M9QDwADgQF/Nnl5XgAAAABJRU5ErkJggg==", "base64");
        form.append("file", new Blob([px], { type: "image/png" }), "token.png");
      }

      form.append("name", config.name || "Token");
      form.append("symbol", config.ticker || "TKN");
      form.append("description", config.description || "");
      form.append("twitter", config.twitter || "");
      form.append("telegram", config.telegram || "");
      form.append("website", config.website || "");
      form.append("showName", "true");

      console.log(`[IPFS] Attempt ${attempt}/${maxRetries}...`);

      const resp = await fetch("https://pump.fun/api/ipfs", {
        method: "POST",
        body: form,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Origin": "https://pump.fun",
          "Referer": "https://pump.fun/",
        },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);

      const data = await resp.json();
      console.log(`[IPFS] Response: ${JSON.stringify(data).slice(0, 300)}`);

      const uri = data.metadataUri || data.uri;
      if (!uri) throw new Error("No metadataUri in response");

      console.log(`[IPFS] ✅ ${uri}`);
      return { metadataUri: uri, metadata: data.metadata || data };

    } catch (e) {
      lastError = e;
      console.warn(`[IPFS] Attempt ${attempt} failed: ${e.message}`);
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════
// CREATE TOKEN — Official SDK
// ═══════════════════════════════════════

export async function createToken(connection, creator, tokenConfig, options = {}) {
  const { devBuySol = 0, jitoTip = 0.001 } = options;
  const tipMicroLamports = Math.round((jitoTip * 1e9) / 600_000 * 1e6); // Convert SOL tip to microLamports per CU

  console.log(`\n${"═".repeat(50)}`);
  console.log(`[CREATE] ${tokenConfig.name} ($${tokenConfig.ticker})`);
  console.log(`[CREATE] Creator: ${creator.publicKey.toBase58()}`);
  console.log(`[CREATE] Dev buy: ${devBuySol} SOL`);

  // Check balance
  const bal = await connection.getBalance(creator.publicKey);
  console.log(`[CREATE] Balance: ${bal / 1e9} SOL`);
  if (bal < 0.01 * 1e9) {
    throw new Error(`Balance too low: ${(bal / 1e9).toFixed(4)} SOL (need 0.01+)`);
  }

  // Step 1: Upload metadata to IPFS
  const { metadataUri } = await uploadMetadata(tokenConfig);

  // Step 2: Initialize SDKs
  const sdk = new PumpSdk(connection);
  const onlineSdk = new OnlinePumpSdk(connection);
  console.log(`[CREATE] SDK initialized`);

  // Step 3: Generate mint keypair
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  console.log(`[CREATE] Mint: ${mint.toBase58()}`);

  // Step 4: Build instructions
  let instructions;

  if (devBuySol > 0) {
    // Create + initial buy in same transaction
    const global = await onlineSdk.fetchGlobal();
    const feeConfig = await onlineSdk.fetchFeeConfig();
    console.log(`[CREATE] Fetched global + feeConfig`);

    const solAmount = new BN(Math.floor(devBuySol * 1e9));
    const tokenAmount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: null,
      amount: solAmount,
    });
    console.log(`[CREATE] Dev buy: ${devBuySol} SOL → ~${tokenAmount.toString()} tokens`);

    instructions = await sdk.createAndBuyInstructions({
      global,
      mint,
      name: tokenConfig.name || "Token",
      symbol: tokenConfig.ticker || "TKN",
      uri: metadataUri,
      creator: creator.publicKey,
      user: creator.publicKey,
      solAmount,
      amount: tokenAmount,
    });
  } else {
    // Create only (no dev buy)
    const ix = await sdk.createInstruction({
      mint,
      name: tokenConfig.name || "Token",
      symbol: tokenConfig.ticker || "TKN",
      uri: metadataUri,
      creator: creator.publicKey,
      user: creator.publicKey,
    });
    instructions = [ix];
  }

  console.log(`[CREATE] Built ${instructions.length} instruction(s)`);

  // Step 5: Build transaction with priority fee
  const tx = new Transaction();

  // Add compute budget — createAndBuy needs significant compute
  const computeUnits = devBuySol > 0 ? 600_000 : 300_000;
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(20_000, tipMicroLamports) }),
  );

  // Add SDK instructions
  for (const ix of instructions) {
    tx.add(ix);
  }

  // Step 6: Send with retries
  let txSig;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[CREATE] Send attempt ${attempt}/${maxRetries}...`);

      txSig = await sendAndConfirmTransaction(
        connection,
        tx,
        [creator, mintKeypair],
        {
          skipPreflight: true,
          commitment: "confirmed",
          maxRetries: 3,
        }
      );

      console.log(`\n[CREATE] ✅ SUCCESS!`);
      console.log(`[CREATE] Mint: ${mint.toBase58()}`);
      console.log(`[CREATE] TX: ${txSig}`);
      console.log(`[CREATE] https://pump.fun/coin/${mint.toBase58()}\n`);
      break;

    } catch (e) {
      console.error(`[CREATE] Attempt ${attempt} failed: ${e.message}`);

      // Extract logs from SendTransactionError
      if (e.getLogs) {
        try {
          const logs = await e.getLogs();
          console.error(`[CREATE] Transaction logs:`);
          logs.forEach(l => console.error(`  ${l}`));
        } catch (logErr) {
          console.error(`[CREATE] Could not get logs: ${logErr.message}`);
        }
      } else if (e.logs) {
        console.error(`[CREATE] Logs:`);
        e.logs.forEach(l => console.error(`  ${l}`));
      }

      // Also try to fetch logs from the signature
      if (e.signature || (e.message && e.message.includes("Transaction "))) {
        try {
          const sig = e.signature || e.message.match(/Transaction (\w+)/)?.[1];
          if (sig) {
            const txInfo = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
            if (txInfo?.meta?.logMessages) {
              console.error(`[CREATE] Fetched tx logs:`);
              txInfo.meta.logMessages.forEach(l => console.error(`  ${l}`));
            }
          }
        } catch (fetchErr) {
          // ignore
        }
      }

      if (attempt === maxRetries) throw e;
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }

  return {
    mint: mint.toBase58(),
    txSig,
    metadataUri,
    pumpUrl: `https://pump.fun/coin/${mint.toBase58()}`,
  };
}

export { uploadMetadata };
