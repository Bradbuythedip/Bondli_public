/**
 * ═══════════════════════════════════════════════════
 * SESSION MANAGER — Dev Wallet Generation + Funding
 * ═══════════════════════════════════════════════════
 *
 * Flow:
 *   1. User picks SOL budget + token config
 *   2. Backend generates a fresh Keypair (dev wallet)
 *   3. User sends SOL from Phantom → dev wallet
 *   4. Backend confirms deposit on-chain
 *   5. Dev wallet creates token + dev buy
 *   6. Remaining SOL distributes to fleet
 *   7. Fleet trades autonomously
 *
 * Status lifecycle:
 *   awaiting_deposit → funded → creating → live → closing → closed
 */

import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import CONFIG from "./config.mjs";

// ═══════════════════════════════════════
// DEV BUY CALCULATOR
// ═══════════════════════════════════════
export function calculateDevBuy(totalSol) {
  let pct, min, max;

  if (totalSol < 0.4) {
    // Deploy-only mode: tiny budget, just creation fee + minimal dev buy
    pct = 0.60; min = 0.05; max = 0.2;
  } else if (totalSol < 1) {
    pct = 0.50; min = 0.1; max = 0.5;
  } else if (totalSol < 5) {
    pct = 0.40; min = 0.3; max = 2.0;
  } else if (totalSol < 15) {
    pct = 0.25; min = 1.0; max = 4.0;
  } else {
    pct = 0.15; min = 2.0; max = 8.0;
  }

  const raw = totalSol * pct;
  const devBuy = Math.min(max, Math.max(min, raw));
  const fleetBudget = totalSol - devBuy - 0.02;

  return {
    devBuy: +devBuy.toFixed(4),
    creationFee: 0.02,
    fleetBudget: +Math.max(0, fleetBudget).toFixed(4),
    devBuyPercent: +((devBuy / totalSol) * 100).toFixed(1),
    breakdown: {
      totalSol,
      devBuy: +devBuy.toFixed(4),
      creationFee: 0.02,
      fleet: +Math.max(0, fleetBudget).toFixed(4),
    },
  };
}

// ═══════════════════════════════════════
// SESSION STORE
// ═══════════════════════════════════════
export class SessionManager {
  constructor(redis) {
    this.redis = redis;
    this.sessions = new Map();
    this.pollIntervals = new Map();
  }

  // Create a new launch session
  async create({ userWallet, totalSol, tokenConfig, tier, fleetConfig }) {
    // Always generate a fresh keypair for the dev wallet
    const devKeypair = Keypair.generate();
    const devWallet = devKeypair.publicKey.toString();
    const devSecret = bs58.encode(devKeypair.secretKey);

    const isApe = !!(tokenConfig?.existingCA);
    const isDeployOnly = !!(fleetConfig?.deployOnly);
    const devBuyInfo = isApe
      ? { devBuy: 0, creationFee: 0, fleetBudget: totalSol, devBuyPercent: 0 }
      : isDeployOnly
        ? { devBuy: 0, creationFee: 0.02, fleetBudget: 0, devBuyPercent: 0 }
        : calculateDevBuy(totalSol);

    const session = {
      id: "sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      userWallet,
      devWallet,
      devSecret,
      totalSol,
      tier: tier || "free",
      devBuy: devBuyInfo.devBuy,
      creationFee: devBuyInfo.creationFee,
      fleetBudget: devBuyInfo.fleetBudget,
      tokenConfig: {
        name: tokenConfig.name || "",
        ticker: tokenConfig.ticker || "",
        description: tokenConfig.description || "",
        image: tokenConfig.image || null,
        twitter: tokenConfig.twitter || "",
        telegram: tokenConfig.telegram || "",
        website: tokenConfig.website || "",
        existingCA: tokenConfig.existingCA || "",
      },
      fleetConfig: {
        sniperCount: fleetConfig?.sniperCount || 2,
        slippage: fleetConfig?.slippage || 25,
        duration: fleetConfig?.duration || 60,
        jitoTip: fleetConfig?.jitoTip || 0.001,
      },
      useMaster: false,
      status: "awaiting_deposit",
      funded: false,
      depositTx: null,
      tokenCA: tokenConfig.existingCA || null,
      createdAt: new Date().toISOString(),
      fundedAt: null,
      launchedAt: null,
      closedAt: null,
    };

    this.sessions.set(session.id, session);
    if (this.redis) {
      try {
        await this.redis.set("session:" + session.id, JSON.stringify(session), { EX: 86400 });
      } catch {}
    }

    console.log(`[SESSION] Created ${session.id} | dev: ${devWallet} | budget: ${totalSol} SOL | devBuy: ${devBuyInfo.devBuy} SOL`);

    return {
      sessionId: session.id,
      devWallet,
      devSecret,
      totalSol,
      devBuy: devBuyInfo.devBuy,
      creationFee: devBuyInfo.creationFee,
      fleetBudget: devBuyInfo.fleetBudget,
      devBuyPercent: devBuyInfo.devBuyPercent,
      useMaster: false,
      funded: false,
      status: "awaiting_deposit",
    };
  }

  // Get session (internal, includes secret)
  async get(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session && this.redis) {
      try {
        const raw = await this.redis.get("session:" + sessionId);
        if (raw) { session = JSON.parse(raw); this.sessions.set(sessionId, session); }
      } catch {}
    }
    return session || null;
  }

  // Get session public info (no secrets)
  async getPublic(sessionId) {
    const s = await this.get(sessionId);
    if (!s) return null;
    const { devSecret, ...pub } = s;
    return pub;
  }

  // Update session
  async update(sessionId, updates) {
    const session = await this.get(sessionId);
    if (!session) return null;
    Object.assign(session, updates);
    this.sessions.set(sessionId, session);
    if (this.redis) {
      try { await this.redis.set("session:" + sessionId, JSON.stringify(session), { EX: 86400 }); } catch {}
    }
    return session;
  }

  // ═══ CLOSE SESSION — mark closed + return keys ═══
  async closeSession(sessionId) {
    const session = await this.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };
    
    await this.update(sessionId, {
      status: "closed",
      closedAt: new Date().toISOString(),
    });

    // Gather all keys for this session
    const keys = [];
    if (session.devSecret) {
      keys.push({ role: "dev", pubkey: session.devWallet, secret: session.devSecret });
    }

    // Fleet keys from Redis
    const fleetKeys = await this.getFleetKeys(sessionId);
    if (fleetKeys.length > 0) {
      keys.push(...fleetKeys);
    }

    console.log(`[SESSION] Closed ${sessionId} | ${keys.length} keys available`);
    return { ok: true, keys, sessionId };
  }

  // ═══ FLEET KEY STORAGE ═══
  // Store fleet wallet keys when session launches (called from orchestrator)
  async storeFleetKeys(sessionId, walletKeys) {
    // walletKeys = [{ role, pubkey, secret }, ...]
    if (!walletKeys || walletKeys.length === 0) return;
    
    // Store in memory on session object
    const session = await this.get(sessionId);
    if (session) {
      session._fleetKeys = walletKeys;
      this.sessions.set(sessionId, session);
    }

    // Store in Redis with 48h TTL (longer than session TTL so keys survive)
    if (this.redis) {
      try {
        await this.redis.set(
          "fleetkeys:" + sessionId,
          JSON.stringify(walletKeys),
          { EX: 172800 } // 48 hours
        );
      } catch {}
    }
    console.log(`[SESSION] Stored ${walletKeys.length} fleet keys for ${sessionId}`);
  }

  // Retrieve fleet keys for a session
  async getFleetKeys(sessionId) {
    // Check in-memory first
    const session = this.sessions.get(sessionId);
    if (session?._fleetKeys?.length > 0) {
      return session._fleetKeys;
    }

    // Check Redis
    if (this.redis) {
      try {
        const raw = await this.redis.get("fleetkeys:" + sessionId);
        if (raw) {
          const keys = JSON.parse(raw);
          // Cache in memory
          if (session) {
            session._fleetKeys = keys;
            this.sessions.set(sessionId, session);
          }
          return keys;
        }
      } catch {}
    }

    return [];
  }

  // ═══ GET ALL KEYS for a session (dev + fleet) ═══
  async getAllKeys(sessionId) {
    const session = await this.get(sessionId);
    if (!session) return [];

    const keys = [];
    if (session.devSecret) {
      keys.push({ role: "dev", pubkey: session.devWallet, secret: session.devSecret });
    }
    const fleetKeys = await this.getFleetKeys(sessionId);
    keys.push(...fleetKeys);
    return keys;
  }

  // Verify deposit arrived on-chain
  async verifyDeposit(sessionId, txSig) {
    const session = await this.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };
    if (session.funded) return { ok: true, already: true };

    try {
      const connection = new Connection(CONFIG.RPC_URL, "confirmed");

      const tx = await connection.getTransaction(txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

      if (!tx) return { ok: false, error: "Transaction not found. Wait for confirmation." };
      if (tx.meta?.err) return { ok: false, error: "Transaction failed on-chain" };

      const balance = await connection.getBalance(new PublicKey(session.devWallet));
      const balanceSol = balance / LAMPORTS_PER_SOL;

      const expectedMin = session.totalSol * 0.95;
      if (balanceSol < expectedMin) {
        return {
          ok: false,
          error: `Dev wallet has ${balanceSol.toFixed(4)} SOL, need at least ${expectedMin.toFixed(4)} SOL`,
          current: balanceSol,
          expected: session.totalSol,
        };
      }

      await this.update(sessionId, {
        funded: true,
        depositTx: txSig,
        fundedAt: new Date().toISOString(),
        status: "funded",
        actualDeposit: balanceSol,
      });

      console.log(`[SESSION] ${sessionId} funded | ${balanceSol.toFixed(4)} SOL | tx: ${txSig.slice(0, 12)}...`);

      return {
        ok: true,
        balanceSol,
        devWallet: session.devWallet,
        devBuy: session.devBuy,
        fleetBudget: session.fleetBudget,
      };

    } catch (e) {
      console.error(`[SESSION] Deposit verify error:`, e.message);
      return { ok: false, error: "Verification failed: " + e.message };
    }
  }

  // Get the dev keypair for launching (internal only)
  async getDevKeypair(sessionId) {
    const session = await this.get(sessionId);
    if (!session || !session.devSecret) return null;
    try {
      return Keypair.fromSecretKey(bs58.decode(session.devSecret));
    } catch {
      return null;
    }
  }

  // List user's sessions
  async listForUser(userWallet) {
    const results = [];
    
    // In-memory sessions
    for (const [, session] of this.sessions) {
      if (session.userWallet === userWallet) {
        const { devSecret, _fleetKeys, ...pub } = session;
        results.push(pub);
      }
    }

    // Also scan Redis for any sessions not in memory
    if (this.redis) {
      try {
        let cursor = "0";
        do {
          const [nextCursor, keys] = await this.redis.scan(cursor, "MATCH", "session:sess_*", "COUNT", 100);
          cursor = nextCursor;
          for (const key of keys) {
            const sid = key.replace("session:", "");
            if (!this.sessions.has(sid)) {
              try {
                const raw = await this.redis.get(key);
                if (raw) {
                  const session = JSON.parse(raw);
                  if (session.userWallet === userWallet) {
                    const { devSecret, _fleetKeys, ...pub } = session;
                    results.push(pub);
                    this.sessions.set(sid, session); // cache
                  }
                }
              } catch {}
            }
          }
        } while (cursor !== "0");
      } catch {}
    }

    // Deduplicate by id
    const seen = new Set();
    const unique = [];
    for (const s of results) {
      if (!seen.has(s.id)) { seen.add(s.id); unique.push(s); }
    }

    return unique.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // Get all active sessions (for admin/monitoring)
  async getAllActive() {
    const results = [];
    for (const [, session] of this.sessions) {
      if (session.status !== "closed") {
        const { devSecret, _fleetKeys, ...pub } = session;
        results.push(pub);
      }
    }
    return results;
  }

  // Delete a single session
  async delete(sessionId) {
    this.sessions.delete(sessionId);
    if (this.redis) {
      try {
        await this.redis.del("session:" + sessionId);
        // Keep fleet keys for 48h even after session delete
        // so user can still export them
      } catch {}
    }
    return true;
  }

  // Soft delete — marks closed but keeps keys accessible
  async softDelete(sessionId) {
    await this.update(sessionId, { status: "closed", closedAt: new Date().toISOString() });
    // Remove from memory after 10 minutes (keys still in Redis)
    setTimeout(() => { this.sessions.delete(sessionId); }, 10 * 60 * 1000);
    return true;
  }

  // Delete all sessions for a user
  async deleteAllForUser(userWallet) {
    let count = 0;
    const toDelete = [];
    for (const [id, session] of this.sessions) {
      if (session.userWallet === userWallet) toDelete.push(id);
    }
    for (const id of toDelete) {
      await this.softDelete(id);
      count++;
    }
    return count;
  }
}
