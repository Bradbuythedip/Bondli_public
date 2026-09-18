// BONDLI v3.0 — Payment API Routes
import { Router } from "express";
import { paymentSchema } from "../middleware/validate.mjs";
import { paymentLimiter } from "../middleware/rate-limiter.mjs";
import { issueToken } from "../middleware/auth.mjs";

export function createPaymentRoutes(paymentVerifier) {
  const router = Router();

  // Get payment info (what to pay, where)
  router.get("/api/payment/info", (req, res) => {
    res.json({
      wallet: process.env.PLATFORM_WALLET || "anal.sol",
      walletResolved: process.env.PLATFORM_WALLET_RESOLVED || null,
      amount: parseFloat(process.env.ACCESS_FEE_SOL || "0.1"),
      currency: "SOL",
      note: "Send exact amount to the platform wallet, then verify with your tx signature.",
    });
  });

  // Verify payment and issue session token
  router.post("/api/payment/verify", paymentLimiter, paymentSchema, async (req, res) => {
    try {
      const { wallet, txSig } = req.body;
      const result = await paymentVerifier.verifyPayment(txSig, wallet);

      if (!result.verified) {
        return res.status(400).json({
          verified: false,
          error: result.error,
        });
      }

      // Issue JWT session token
      const token = issueToken(wallet, txSig);

      res.json({
        verified: true,
        token,
        expiresIn: "24h",
        wallet: result.wallet,
        amount: result.amount,
      });
    } catch (e) {
      console.error("[PAY] Verification error:", e);
      res.status(500).json({ verified: false, error: "Verification failed. Try again." });
    }
  });

  // Check if wallet has active session (for reconnection)
  router.get("/api/payment/status", (req, res) => {
    const wallet = req.query.wallet;
    if (!wallet) return res.status(400).json({ error: "wallet query param required" });

    const paid = paymentVerifier.isWalletPaid(wallet);
    res.json({ wallet, paid });
  });

  // Payment stats (admin only)
  router.get("/api/payment/stats", (req, res) => {
    const secret = req.headers["x-admin-secret"];
    if (secret !== process.env.API_SECRET) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json(paymentVerifier.stats());
  });

  return router;
}

export default createPaymentRoutes;
