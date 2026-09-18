// BONDLI — Redis Session Store (30-day TTL for session data)

export class SessionStore {
  constructor(redis) {
    this.redis = redis;
    this.prefix = "session:";
    this.TTL = 30 * 86400; // 30 days
  }

  // Store user session
  async createSession(wallet, data) {
    const key = `${this.prefix}${wallet}`;
    await this.redis.hSet(key, {
      wallet,
      createdAt: Date.now().toString(),
      lastActive: Date.now().toString(),
      launchCount: "0",
      totalSolUsed: "0",
      ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    });
    await this.redis.expire(key, this.TTL);
    return true;
  }

  // Get session
  async getSession(wallet) {
    const key = `${this.prefix}${wallet}`;
    const data = await this.redis.hGetAll(key);
    if (!data || !data.wallet) return null;
    return data;
  }

  // Update session activity (refreshes TTL)
  async touch(wallet) {
    const key = `${this.prefix}${wallet}`;
    await this.redis.hSet(key, "lastActive", Date.now().toString());
    await this.redis.expire(key, this.TTL);
  }

  // Track launch
  async recordLaunch(wallet, ca, sol) {
    const key = `${this.prefix}${wallet}`;
    const session = await this.getSession(wallet);
    if (!session) return false;

    const count = parseInt(session.launchCount || "0") + 1;
    const totalSol = parseFloat(session.totalSolUsed || "0") + sol;
    await this.redis.hSet(key, {
      launchCount: count.toString(),
      totalSolUsed: totalSol.toString(),
      lastCA: ca,
      lastLaunch: Date.now().toString(),
    });
    await this.redis.expire(key, this.TTL);

    // Also track in launch history (keep 200)
    await this.redis.lPush(`launches:${wallet}`, JSON.stringify({ ca, sol, time: Date.now() }));
    await this.redis.lTrim(`launches:${wallet}`, 0, 199);

    return true;
  }

  // Get user launch history
  async getLaunchHistory(wallet, limit = 20) {
    const items = await this.redis.lRange(`launches:${wallet}`, 0, limit - 1);
    return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
  }

  // Count active sessions
  async activeCount() {
    const keys = await this.redis.keys(`${this.prefix}*`);
    return keys.length;
  }

  // Get all sessions (admin)
  async allSessions() {
    const keys = await this.redis.keys(`${this.prefix}*`);
    const sessions = [];
    for (const key of keys) {
      const data = await this.redis.hGetAll(key);
      if (data.wallet) sessions.push(data);
    }
    return sessions;
  }
}

export default SessionStore;
