#!/usr/bin/env node
// tx-audit: reconcile the velocity ledger against the chain, one signature at a time.
//
//   node tools/tx-audit.mjs [--data ./data/velocity] [--limit 40] [--since <ms>]
//   node tools/tx-audit.mjs --chain [--limit 60]      every transaction on the wallet, ledger or not
//
// Every live fill and exit records a venue_ref (the transaction signature) and a USD figure the
// router measured. This fetches each transaction and reports the wallet's TRUE lamport change,
// found by locating the wallet in the account list rather than assuming an index. When the ledger
// and the wallet disagree about how much money exists, the per-signature difference says where.
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DATA = arg("--data", "./data/velocity");
const LIMIT = +arg("--limit", 40);
const SINCE = +arg("--since", 0);
const CHAIN = process.argv.includes("--chain");

const usd = n => (n < 0 ? "-" : "+") + "$" + Math.abs(n).toFixed(4);
const sol = n => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(6);

/** The wallet's own lamport and token change in a confirmed transaction, by account key, not index. */
export function walletDelta(tx, { owner, mint }) {
  const meta = tx?.meta;
  if (!meta) return null;
  const msg = tx.transaction?.message;
  let keys = [];
  try {
    // Versioned transactions resolve extra keys from lookup tables; getAccountKeys merges them.
    const ak = msg?.getAccountKeys?.({ accountKeysFromLookups: meta.loadedAddresses });
    keys = ak ? ak.keySegments().flat().map(k => k.toBase58()) : (msg?.staticAccountKeys || msg?.accountKeys || []).map(k => k.toBase58?.() ?? String(k));
  } catch { keys = (msg?.staticAccountKeys || []).map(k => k.toBase58?.() ?? String(k)); }
  const idx = keys.indexOf(owner);
  const lamports = idx >= 0 ? (meta.postBalances?.[idx] ?? 0) - (meta.preBalances?.[idx] ?? 0) : null;
  const own = list => (list || []).filter(b => b.owner === owner && (!mint || b.mint === mint))
    .reduce((s, b) => s + (Number(b.uiTokenAmount?.uiAmount) || 0), 0);
  return {
    index: idx,
    indexZeroIsWallet: keys[0] === owner,
    solDelta: lamports == null ? null : lamports / 1e9,
    solDeltaAtIndexZero: ((meta.postBalances?.[0] ?? 0) - (meta.preBalances?.[0] ?? 0)) / 1e9,
    tokenDelta: own(meta.postTokenBalances) - own(meta.preTokenBalances),
    feeSol: (meta.fee ?? 0) / 1e9,
    err: meta.err || null,
  };
}

/** Every transaction the chain has for this wallet, marked against what the ledger knows.
 *  The ledger can only report what the bot did; this reports what happened. */
async function chainHistory(conn, web3, owner, known) {
  const sigs = await conn.getSignaturesForAddress(new web3.PublicKey(owner), { limit: LIMIT });
  console.log(`chain history: ${sigs.length} transaction(s), newest first\n`);
  console.log("time                  sol_change     fee  status    source   note");
  let bot = 0, other = 0, otherSol = 0;
  for (const s of sigs) {
    let tx = null;
    try { tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); } catch {}
    await new Promise(r => setTimeout(r, 120)); // a free RPC tier will rate-limit a tight loop
    const d = tx ? walletDelta(tx, { owner }) : null;
    const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString().replace("T", " ").slice(0, 19) : "(no block time)";
    const rec = known.get(s.signature);
    const src = rec ? "bot" : "NOT-BOT";
    if (rec) bot++; else { other++; otherSol += d?.solDelta ?? 0; }
    const note = rec ? `${rec.kind} ${String(rec.instrument || "").slice(0, 8)}` : (s.err ? "failed" : "") + " " + s.signature.slice(0, 16) + "…";
    console.log(`${when}  ${sol(d?.solDelta ?? 0).padStart(11)}  ${(d?.feeSol ?? 0).toFixed(6)}  ${(s.err ? "failed" : "ok").padEnd(8)}  ${src.padEnd(7)}  ${note}`);
  }
  console.log(`\n${bot} transaction(s) the velocity ledger knows about, ${other} it does not.`);
  if (other) console.log(`Those ${other} moved ${sol(otherSol)} SOL. Anything here the bot did not send came from somewhere else with this key: another process, a wallet app, or a person.`);
  if (sigs.length === LIMIT) console.log(`Showing the newest ${LIMIT}; raise --limit to see further back.`);
}

async function main() {
  const secret = process.env.MASTER_SEED;
  if (!secret) { console.error("tx-audit needs MASTER_SEED in .env (read-only: it only derives the public key)"); process.exit(2); }
  const [web3, bs58] = await Promise.all([import("@solana/web3.js"), import("bs58")]);
  const kp = web3.Keypair.fromSecretKey((bs58.default || bs58).decode(secret.trim()));
  const owner = kp.publicKey.toBase58();
  const rpc = process.env.RPC_URL || (await import("../src/engine/config.mjs")).default.RPC_URL;
  const conn = new web3.Connection(rpc, "confirmed");

  const file = path.join(DATA, "ledger.jsonl");
  const recs = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const traded = recs.filter(r => (r.kind === "fill" || r.kind === "exit") && r.venue_ref && r.paper !== true && (r.ts || 0) >= SINCE).slice(-LIMIT);
  const fees = recs.filter(r => r.kind === "fee" && (r.ts || 0) >= SINCE);

  console.log(`wallet ${owner}`);
  console.log(`rpc    ${String(rpc).split("?")[0]}`);
  console.log(`ledger ${file}: ${traded.length} live fills/exits with a signature${fees.length ? `, ${fees.length} fee records` : ""}\n`);
  const bal = await conn.getBalance(kp.publicKey, "confirmed");
  console.log(`wallet balance now: ${(bal / 1e9).toFixed(6)} SOL\n`);

  if (CHAIN) {
    const known = new Map(recs.filter(r => r.venue_ref).map(r => [r.venue_ref, r]));
    return chainHistory(conn, web3, owner, known);
  }

  console.log("time      side  instrument  booked_usd   true_sol     tx_fee  idx  on-chain");
  let bookedUsd = 0, trueSol = 0, feeSol = 0, missing = 0, mismatchIdx = 0;
  for (const r of traded) {
    const side = r.kind === "fill" ? "BUY " : "SELL";
    const booked = r.kind === "fill" ? -(r.notional_usd || 0) : +(r.proceeds_usd || 0);
    bookedUsd += booked;
    let tx = null;
    try { tx = await conn.getTransaction(r.venue_ref, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); } catch (e) { tx = null; }
    const d = tx ? walletDelta(tx, { owner, mint: r.instrument }) : null;
    const when = new Date(r.ts).toISOString().slice(11, 19);
    const inst = String(r.instrument || "").slice(0, 8);
    if (!d) { missing++; console.log(`${when}  ${side}  ${inst}  ${usd(booked).padStart(10)}   ${"not on chain".padStart(10)}          -    -  MISSING`); continue; }
    trueSol += d.solDelta ?? 0; feeSol += d.feeSol;
    if (!d.indexZeroIsWallet) mismatchIdx++;
    const note = [d.err ? "FAILED" : "ok", d.index < 0 ? "wallet not in tx!" : "", !d.indexZeroIsWallet ? `index0 != wallet (${sol(d.solDeltaAtIndexZero)} there)` : "", `tokens ${d.tokenDelta >= 0 ? "+" : ""}${d.tokenDelta.toFixed(4)}`].filter(Boolean).join("  ");
    console.log(`${when}  ${side}  ${inst}  ${usd(booked).padStart(10)}   ${sol(d.solDelta ?? 0).padStart(10)}  ${d.feeSol.toFixed(6)}  ${String(d.index).padStart(3)}  ${note}`);
  }

  const feeUsd = fees.reduce((s, f) => s + (f.usd || 0), 0);
  console.log(`\nledger says:  ${usd(bookedUsd)} from fills and exits, ${usd(-feeUsd)} in recorded failed-send fees`);
  console.log(`chain says:   ${sol(trueSol)} SOL across those same transactions (${feeSol.toFixed(6)} SOL of it transaction fees)`);
  if (missing) console.log(`${missing} signature(s) could not be fetched: a non-archive RPC drops older transactions, so treat those rows as unknown rather than as zero.`);
  if (mismatchIdx) console.log(`\n${mismatchIdx} transaction(s) do NOT have the wallet at account index 0. The router measures the delta at index 0, so those bookings are wrong by the difference shown.`);
  else if (traded.length) console.log(`\nEvery transaction has the wallet at account index 0, so the router's index-0 reading matched the wallet.`);
  console.log(`\nWhat the chain total does not include: SOL still locked in token accounts (about 0.00204 each, not refunded unless the account is closed), and any transaction older than this RPC keeps.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exit(1); });
