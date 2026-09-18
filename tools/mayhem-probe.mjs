#!/usr/bin/env node
// mayhem-probe: what does a pump.fun token look like from each source the radar can read?
//   node tools/mayhem-probe.mjs <mint> [<mint> ...]
// Prints, per mint: every pump.fun coin-API field whose name mentions mayhem/mode/type, the bonding
// curve account's byte length and the bytes after the reserves (complete flag, creator, and whatever
// follows), and the radar's verdict from src/api/mayhem.mjs. Run it on one token you know is Mayhem
// and one you know is not; the difference is the signal the detector should trust.
import "dotenv/config";
import { detectMayhem, decodeCurveFlags, PUMP_PROGRAM } from "../src/api/mayhem.mjs";

const mints = process.argv.slice(2).filter(Boolean);
if (!mints.length) { console.error("usage: node tools/mayhem-probe.mjs <mint> [<mint> ...]"); process.exit(2); }
const web3 = await import("@solana/web3.js");
const rpc = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const conn = new web3.Connection(rpc, "confirmed");

for (const mint of mints) {
  console.log(`\n== ${mint}`);
  let meta = null;
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json", Origin: "https://pump.fun", Referer: "https://pump.fun/" }, signal: AbortSignal.timeout(10000) });
    meta = r.ok ? await r.json() : null;
    console.log(`coin api: ${r.status}${meta ? `  name=${meta.name} created=${meta.created_timestamp ? new Date(meta.created_timestamp).toISOString() : "?"}` : ""}`);
    if (meta) { const keys = Object.keys(meta).filter(k => /mayhem|mode|type|program|pool|version/i.test(k)); console.log(`  fields: ${keys.map(k => `${k}=${JSON.stringify(meta[k])}`).join("  ") || "(none mention mayhem/mode/type)"}`); }
  } catch (e) { console.log(`coin api: ${e.message}`); }
  let curve = null;
  try {
    const [bc] = web3.PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new web3.PublicKey(mint).toBuffer()], new web3.PublicKey(PUMP_PROGRAM));
    const info = await conn.getAccountInfo(bc);
    curve = info?.data || null;
    console.log(`bonding curve ${bc.toBase58()}: ${curve ? curve.length + " bytes" : "not found"}`);
    if (curve) { const f = decodeCurveFlags(curve); console.log(`  complete=${f.complete} creator=${f.creator}  bytes after creator: ${f.tailHex || "(none)"}  -> flag byte ${f.flagByte == null ? "absent" : f.flagByte}`); }
  } catch (e) { console.log(`bonding curve: ${e.message}`); }
  const v = detectMayhem({ meta, curve });
  console.log(`verdict: ${v.mayhem ? "MAYHEM" : "not mayhem"} (${v.source || "no signal"})`);
}
