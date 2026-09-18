// BONDLI — Access Check Route
// Add this to your Express server routes

// Whitelist from env: WHITELISTED_WALLETS=bigtrench.sol,wallet2,wallet3
const getWhitelist = () => {
  const raw = process.env.WHITELISTED_WALLETS || "";
  return new Set(raw.split(",").map(w => w.trim()).filter(Boolean));
};

// Simple in-memory paid set (replace with Redis/DB for persistence)
const paidWallets = new Set();

export function setupAccessRoutes(app) {

  // Check if wallet has access (whitelisted or paid)
  app.get("/api/access/check", (req, res) => {
    const wallet = req.query.wallet;
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    const whitelist = getWhitelist();
    const whitelisted = whitelist.has(wallet);
    const paid = paidWallets.has(wallet);

    res.json({
      access: whitelisted || paid,
      whitelisted,
      paid,
      fee: whitelisted ? 0 : 10,
    });
  });

  // Mark wallet as paid (called after on-chain verification)
  app.post("/api/access/grant", (req, res) => {
    const secret = req.headers["x-api-secret"];
    if (secret !== process.env.API_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }

    const { wallet } = req.body || {};
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    paidWallets.add(wallet);
    console.log("[ACCESS] Granted to:", wallet);
    res.json({ ok: true, wallet });
  });

  // Admin: view whitelist
  app.get("/api/access/whitelist", (req, res) => {
    const secret = req.headers["x-api-secret"];
    if (secret !== process.env.API_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }

    const whitelist = getWhitelist();
    res.json({ wallets: [...whitelist], count: whitelist.size });
  });
}
