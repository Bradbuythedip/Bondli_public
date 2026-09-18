// BONDLI — Persistent User Store (Redis, no TTL on user records)
// Tracks: wallet, tier, first seen, launches, volume, profit, referrals, last active
// v4.0: VIP referral system with custom codes, tiered commissions, payout tracking

import { calculateReferralSplit } from "../engine/fee-engine.mjs";

export class UserStore {
  constructor(redis) {
    this.redis = redis;
    this.prefix = "user:";
  }

  // Get or create user — called on every authenticated request
  async getOrCreate(wallet) {
    const key = this.prefix + wallet;
    let data = await this.redis.hGetAll(key);

    if (!data || !data.wallet) {
      // New user
      data = {
        wallet,
        tier: "free",
        firstSeen: Date.now().toString(),
        lastActive: Date.now().toString(),
        totalLaunches: "0",
        totalDeploys: "0",
        totalSolIn: "0",           // total SOL deposited into sessions
        totalSolOut: "0",          // total SOL recovered/returned
        totalProfit: "0",          // net profit across all sessions
        totalPlatformCut: "0",     // total fees paid to platform
        totalTokensCreated: "0",
        referralCode: this._genRefCode(wallet),
        referredBy: "",
        referredByTier: "",        // tier of the person who referred this user
        referralCount: "0",
        referralEarnings: "0",     // SOL earned from referrals
        referralPendingPayout: "0", // SOL pending withdrawal
        referralTotalPaid: "0",    // SOL already withdrawn
        // VIP referral management
        customRefCode: "",         // VIP can set custom codes
        referralTier: "standard",  // standard | silver | gold | diamond (based on performance)
        referralNetwork: "0",      // total users in referral network (direct + indirect)
        referralVolume: "0",       // total trading volume from referred users
        banned: "false",
        notes: "",
      };
      await this.redis.hSet(key, data);
      console.log(`[USER] New user: ${wallet.slice(0, 8)}... | ref: ${data.referralCode}`);
    }

    return this._parse(data);
  }

  // Get user (returns null if not found)
  async get(wallet) {
    const key = this.prefix + wallet;
    const data = await this.redis.hGetAll(key);
    if (!data || !data.wallet) return null;
    return this._parse(data);
  }

  // Update user fields
  async update(wallet, fields) {
    const key = this.prefix + wallet;
    const stringFields = {};
    for (const [k, v] of Object.entries(fields)) {
      stringFields[k] = String(v);
    }
    stringFields.lastActive = Date.now().toString();
    await this.redis.hSet(key, stringFields);
  }

  // Record a launch (create token + fleet)
  async recordLaunch(wallet, ca, solIn) {
    const user = await this.getOrCreate(wallet);
    await this.update(wallet, {
      totalLaunches: user.totalLaunches + 1,
      totalSolIn: +(user.totalSolIn + solIn).toFixed(6),
      lastCA: ca,
      lastLaunchAt: Date.now().toString(),
    });

    // Push to launch history (keep 200)
    await this.redis.lPush("launches:" + wallet, JSON.stringify({ ca, solIn, time: Date.now() }));
    await this.redis.lTrim("launches:" + wallet, 0, 199);

    // Track referral volume
    if (user.referredBy) {
      const referrer = await this.get(user.referredBy);
      if (referrer) {
        await this.update(user.referredBy, {
          referralVolume: +(referrer.referralVolume + solIn).toFixed(6),
        });
        // Auto-upgrade referral tier based on network volume
        await this._updateReferralTier(user.referredBy);
      }
    }
  }

  // Record a deploy-only (no fleet)
  async recordDeploy(wallet, ca) {
    const user = await this.getOrCreate(wallet);
    await this.update(wallet, {
      totalDeploys: user.totalDeploys + 1,
      totalTokensCreated: user.totalTokensCreated + 1,
      lastCA: ca,
      lastDeployAt: Date.now().toString(),
    });
  }

  // Record session close / sweep results — with referral revenue sharing
  async recordClose(wallet, solOut, platformCut, netProfit) {
    const user = await this.getOrCreate(wallet);
    await this.update(wallet, {
      totalSolOut: +(user.totalSolOut + solOut).toFixed(6),
      totalPlatformCut: +(user.totalPlatformCut + platformCut).toFixed(6),
      totalProfit: +(user.totalProfit + netProfit).toFixed(6),
    });

    // Distribute referral commission
    if (user.referredBy && platformCut > 0.0001) {
      const referrer = await this.get(user.referredBy);
      if (referrer) {
        const { referrerCut } = calculateReferralSplit(platformCut, referrer.tier);
        if (referrerCut > 0.0001) {
          await this.update(user.referredBy, {
            referralEarnings: +(referrer.referralEarnings + referrerCut).toFixed(6),
            referralPendingPayout: +(referrer.referralPendingPayout + referrerCut).toFixed(6),
          });
          // Log referral event
          await this._logReferralEvent(user.referredBy, wallet, referrerCut, platformCut);
        }
      }
    }
  }

  // Set tier (pro upgrade, vip whitelist)
  async setTier(wallet, tier) {
    await this.update(wallet, { tier, tierChangedAt: Date.now().toString() });
  }

  // Apply referral code
  async applyReferral(wallet, refCode) {
    const user = await this.getOrCreate(wallet);
    if (user.referredBy) return { ok: false, error: "Already referred" };

    // Find referrer by code (check custom codes first, then default)
    let referrerWallet = await this.redis.get("ref:" + refCode);
    if (!referrerWallet) {
      referrerWallet = await this.redis.get("customref:" + refCode.toLowerCase());
    }
    if (!referrerWallet) return { ok: false, error: "Invalid referral code" };
    if (referrerWallet === wallet) return { ok: false, error: "Cannot refer yourself" };

    const referrer = await this.get(referrerWallet);
    if (!referrer) return { ok: false, error: "Referrer not found" };

    // Apply
    await this.update(wallet, {
      referredBy: referrerWallet,
      referredByTier: referrer.tier,
    });
    await this.update(referrerWallet, {
      referralCount: referrer.referralCount + 1,
      referralNetwork: referrer.referralNetwork + 1,
    });

    return { ok: true, referrer: referrerWallet.slice(0, 8) + "..." };
  }

  // ── VIP Referral Management ──

  // Create custom referral code (VIP only)
  async createCustomRefCode(wallet, code) {
    const user = await this.getOrCreate(wallet);
    if (user.tier !== "vip" && user.tier !== "pro" && !user.whitelisted) {
      return { ok: false, error: "VIP tier required" };
    }
    // Validate code
    const clean = code.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (clean.length < 3 || clean.length > 20) {
      return { ok: false, error: "Code must be 3-20 alphanumeric characters" };
    }
    // Check uniqueness
    const existing = await this.redis.get("customref:" + clean);
    if (existing && existing !== wallet) {
      return { ok: false, error: "Code already taken" };
    }
    // Remove old custom code if exists
    if (user.customRefCode) {
      await this.redis.del("customref:" + user.customRefCode.toLowerCase());
    }
    // Set new code
    await this.redis.set("customref:" + clean, wallet);
    await this.update(wallet, { customRefCode: clean });
    return { ok: true, code: clean };
  }

  // Get referral dashboard data (for VIP dashboard)
  async getReferralDashboard(wallet) {
    const user = await this.getOrCreate(wallet);
    const referredUsers = await this._getReferredUsers(wallet);

    // Calculate stats
    const activeRefs = referredUsers.filter(u => Date.now() - u.lastActive < 604800000); // active in 7d
    const totalVolume = referredUsers.reduce((s, u) => s + u.totalSolIn, 0);
    const totalProfit = referredUsers.reduce((s, u) => s + Math.max(0, u.totalProfit), 0);

    // Get recent referral events
    const events = await this._getReferralEvents(wallet, 50);

    return {
      referralCode: user.customRefCode || user.referralCode,
      defaultCode: user.referralCode,
      customCode: user.customRefCode,
      referralCount: user.referralCount,
      referralNetwork: user.referralNetwork,
      referralEarnings: user.referralEarnings,
      referralPendingPayout: user.referralPendingPayout,
      referralTotalPaid: user.referralTotalPaid,
      referralTier: user.referralTier,
      referralVolume: user.referralVolume,
      activeReferrals: activeRefs.length,
      totalReferralVolume: +totalVolume.toFixed(4),
      totalReferralProfit: +totalProfit.toFixed(4),
      referredUsers: referredUsers.map(u => ({
        wallet: u.wallet.slice(0, 4) + "..." + u.wallet.slice(-4),
        tier: u.tier,
        joinedAt: u.firstSeen,
        lastActive: u.lastActive,
        volume: +u.totalSolIn.toFixed(4),
        profit: +u.totalProfit.toFixed(4),
        platformCut: +u.totalPlatformCut.toFixed(6),
      })),
      recentEvents: events,
      tier: user.tier,
    };
  }

  // Mark referral payout as claimed
  async claimReferralPayout(wallet) {
    const user = await this.getOrCreate(wallet);
    const amount = user.referralPendingPayout;
    if (amount < 0.001) return { ok: false, error: "Minimum payout: 0.001 SOL" };

    await this.update(wallet, {
      referralPendingPayout: 0,
      referralTotalPaid: +(user.referralTotalPaid + amount).toFixed(6),
    });
    return { ok: true, amount, destination: wallet };
  }

  // Get launch history
  async getLaunchHistory(wallet, limit = 20) {
    const items = await this.redis.lRange("launches:" + wallet, 0, limit - 1);
    return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
  }

  // Rate limit check — returns { allowed: bool, remaining: int, resetIn: int }
  async checkRateLimit(wallet, action, maxPerHour) {
    const key = `rl:${action}:${wallet}`;
    const count = parseInt(await this.redis.get(key) || "0");
    if (count >= maxPerHour) {
      const ttl = await this.redis.ttl(key);
      return { allowed: false, remaining: 0, resetIn: ttl };
    }
    await this.redis.incr(key);
    if (count === 0) await this.redis.expire(key, 3600); // 1 hour window
    return { allowed: true, remaining: maxPerHour - count - 1, resetIn: 0 };
  }

  // Admin: get all users
  async allUsers(limit = 100) {
    const keys = await this.redis.keys(this.prefix + "*");
    const users = [];
    for (const key of keys.slice(0, limit)) {
      const data = await this.redis.hGetAll(key);
      if (data.wallet) users.push(this._parse(data));
    }
    return users.sort((a, b) => b.totalSolIn - a.totalSolIn); // sort by volume
  }

  // Admin: platform stats
  async platformStats() {
    const users = await this.allUsers(10000);
    return {
      totalUsers: users.length,
      freeUsers: users.filter(u => u.tier === "free").length,
      proUsers: users.filter(u => u.tier === "pro").length,
      vipUsers: users.filter(u => u.tier === "vip").length,
      totalLaunches: users.reduce((s, u) => s + u.totalLaunches, 0),
      totalSolVolume: +users.reduce((s, u) => s + u.totalSolIn, 0).toFixed(2),
      totalPlatformRevenue: +users.reduce((s, u) => s + u.totalPlatformCut, 0).toFixed(6),
      totalReferralEarnings: +users.reduce((s, u) => s + u.referralEarnings, 0).toFixed(6),
      totalReferralPaid: +users.reduce((s, u) => s + u.referralTotalPaid, 0).toFixed(6),
      activeToday: users.filter(u => Date.now() - u.lastActive < 86400000).length,
      activeWeek: users.filter(u => Date.now() - u.lastActive < 604800000).length,
      topReferrers: users
        .filter(u => u.referralCount > 0)
        .sort((a, b) => b.referralEarnings - a.referralEarnings)
        .slice(0, 10)
        .map(u => ({
          wallet: u.wallet.slice(0, 4) + "..." + u.wallet.slice(-4),
          tier: u.tier,
          referrals: u.referralCount,
          earnings: u.referralEarnings,
          volume: u.referralVolume,
        })),
    };
  }

  // ── Internal helpers ──

  // Get all users referred by a wallet
  async _getReferredUsers(wallet) {
    const allUserKeys = await this.redis.keys(this.prefix + "*");
    const referred = [];
    for (const key of allUserKeys) {
      const data = await this.redis.hGetAll(key);
      if (data.referredBy === wallet) {
        referred.push(this._parse(data));
      }
    }
    return referred.sort((a, b) => b.totalSolIn - a.totalSolIn);
  }

  // Log referral commission event
  async _logReferralEvent(referrerWallet, userWallet, commission, platformCut) {
    const event = JSON.stringify({
      user: userWallet.slice(0, 4) + "..." + userWallet.slice(-4),
      commission: +commission.toFixed(6),
      platformCut: +platformCut.toFixed(6),
      time: Date.now(),
    });
    await this.redis.lPush("refevents:" + referrerWallet, event);
    await this.redis.lTrim("refevents:" + referrerWallet, 0, 199);
  }

  // Get referral events for a wallet
  async _getReferralEvents(wallet, limit = 50) {
    const items = await this.redis.lRange("refevents:" + wallet, 0, limit - 1);
    return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
  }

  // Auto-upgrade referral tier based on network performance
  async _updateReferralTier(wallet) {
    const user = await this.get(wallet);
    if (!user) return;
    const vol = user.referralVolume;
    const refs = user.referralCount;
    let tier = "standard";
    if (vol >= 1000 || refs >= 50) tier = "diamond";
    else if (vol >= 100 || refs >= 20) tier = "gold";
    else if (vol >= 10 || refs >= 5) tier = "silver";
    if (tier !== user.referralTier) {
      await this.update(wallet, { referralTier: tier });
    }
  }

  // Parse Redis strings to typed values
  _parse(data) {
    return {
      ...data,
      totalLaunches: parseInt(data.totalLaunches || "0"),
      totalDeploys: parseInt(data.totalDeploys || "0"),
      totalSolIn: parseFloat(data.totalSolIn || "0"),
      totalSolOut: parseFloat(data.totalSolOut || "0"),
      totalProfit: parseFloat(data.totalProfit || "0"),
      totalPlatformCut: parseFloat(data.totalPlatformCut || "0"),
      totalTokensCreated: parseInt(data.totalTokensCreated || "0"),
      referralCount: parseInt(data.referralCount || "0"),
      referralEarnings: parseFloat(data.referralEarnings || "0"),
      referralPendingPayout: parseFloat(data.referralPendingPayout || "0"),
      referralTotalPaid: parseFloat(data.referralTotalPaid || "0"),
      referralNetwork: parseInt(data.referralNetwork || "0"),
      referralVolume: parseFloat(data.referralVolume || "0"),
      firstSeen: parseInt(data.firstSeen || "0"),
      lastActive: parseInt(data.lastActive || "0"),
      banned: data.banned === "true",
      whitelisted: data.whitelisted === "true" || data.whitelisted === true,
    };
  }

  // Generate unique referral code from wallet
  _genRefCode(wallet) {
    const code = wallet.slice(0, 4) + wallet.slice(-4);
    // Store reverse lookup
    this.redis.set("ref:" + code, wallet).catch(() => {});
    return code;
  }
}

export default UserStore;
