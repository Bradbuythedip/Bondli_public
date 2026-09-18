// BONDLI v4.0 Config — Alchemy RPC
import "dotenv/config";

// Alchemy RPC — API key in URL path: https://solana-mainnet.g.alchemy.com/v2/{KEY}
const _alchemyKey = process.env.ALCHEMY_API_KEY || "";
const _alchemyRpc = _alchemyKey ? `https://solana-mainnet.g.alchemy.com/v2/${_alchemyKey}` : "";
const _alchemyWs  = _alchemyKey ? `wss://solana-mainnet.g.alchemy.com/v2/${_alchemyKey}` : "";

export const CONFIG = {
  // Alchemy RPC (Solana mainnet)
  RPC_URL:           process.env.RPC_URL || _alchemyRpc || "https://api.mainnet-beta.solana.com",
  WS_URL:            process.env.WS_URL || _alchemyWs || "",
  ALCHEMY_API_KEY:   _alchemyKey,
  MASTER_SEED:       process.env.MASTER_SEED || "",
  TOKEN_CA:          process.env.TOKEN_CA || process.argv[2] || "",
  TOKEN_WEIGHTS:     process.env.TOKEN_WEIGHTS || "",
  TOTAL_SOL:         parseFloat(process.env.TOTAL_SOL || "1"),
  SLIPPAGE_BPS:      parseInt(process.env.SLIPPAGE_BPS || "200"),
  PRIORITY_FEE:      parseInt(process.env.PRIORITY_FEE || "10000"),
  JITO_TIP:          parseInt(process.env.JITO_TIP || "1000"),
  RUN_DURATION_MIN:  parseInt(process.env.RUN_DURATION_MINUTES || "60"),
  DRY_RUN:           process.env.DRY_RUN === "true",
  X_BEARER_TOKEN:    process.env.X_BEARER_TOKEN || "",
  API_PORT:          parseInt(process.env.API_PORT || "3001"),
  API_SECRET:        process.env.API_SECRET || null,          // no default: a published secret is not a secret
  PLATFORM_WALLET:   process.env.PLATFORM_WALLET || null,     // no default: money never goes somewhere by accident
  FEE_SALT:          process.env.FEE_SALT || null,            // no default: see fee-engine.mjs

  // Bags.fm integration — https://dev.bags.fm
  BAGS_API_KEY:            process.env.BAGS_API_KEY || "",
  BAGS_FEE_SWEEP_HOURS:    parseInt(process.env.BAGS_FEE_SWEEP_HOURS || "6"),
  BAGS_PARTNER_WALLET:     process.env.BAGS_PARTNER_WALLET || "",
  BAGS_AGENT_JWT:          process.env.BAGS_AGENT_JWT || "",                          // agent auth JWT (365-day validity)
};

export default CONFIG;
