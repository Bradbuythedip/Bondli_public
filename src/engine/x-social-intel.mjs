/**
 * X/Twitter Social Intelligence Module
 * Free tier: ~1,500 tweet reads/month
 *
 * Uses X API v2 to validate token social presence:
 *   - Profile existence & follower count
 *   - Account age (fresh = suspicious)
 *   - Recent tweet engagement
 *   - Follower/following ratio (bot detection)
 */

const X_API_BASE = "https://api.twitter.com/2";
const CACHE_TTL = 15 * 60 * 1000; // 15 min cache to conserve rate limits

export class XSocialIntel {
  constructor(bearerToken = null) {
    this.bearerToken = bearerToken || process.env.X_BEARER_TOKEN || null;
    this.cache = new Map(); // username → { data, fetchedAt }
    this.authFailed = false; // set on a 401/403: the credential is wrong, so stop spending quota on it
    this.requestCount = 0;
    this.monthlyLimit = 1500; // free tier
    this.resetAt = this._nextMonthReset();
  }

  get enabled() {
    return !!this.bearerToken && !this.authFailed;
  }

  /**
   * Analyze a token's Twitter presence
   * @param {string} twitterUrl - The twitter/x.com URL from token metadata
   * @returns {{ score, flags, profile }} Social signal data
   */
  async analyze(twitterUrl) {
    if (!this.enabled || !twitterUrl) {
      return { score: 0, flags: ["no_x_api"], profile: null };
    }

    const username = this._extractUsername(twitterUrl);
    if (!username) {
      return { score: 0, flags: ["invalid_url"], profile: null };
    }

    // Check cache
    const cached = this.cache.get(username);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return cached.data;
    }

    // Rate limit check
    if (this.requestCount >= this.monthlyLimit) {
      if (Date.now() > this.resetAt) {
        this.requestCount = 0;
        this.resetAt = this._nextMonthReset();
      } else {
        return { score: 0, flags: ["rate_limited"], profile: null };
      }
    }

    try {
      const profile = await this._fetchProfile(username);
      if (!profile) {
        return { score: 0, flags: ["account_not_found"], profile: null };
      }

      const result = this._scoreProfile(profile);
      this.cache.set(username, { data: result, fetchedAt: Date.now() });
      return result;
    } catch (e) {
      console.error(`[X-INTEL] Error analyzing @${username}:`, e.message);
      return { score: 0, flags: ["api_error"], profile: null };
    }
  }

  /**
   * Fetch user profile from X API v2
   */
  async _fetchProfile(username) {
    this.requestCount++;
    const url = `${X_API_BASE}/users/by/username/${encodeURIComponent(username)}?user.fields=public_metrics,created_at,description,verified`;

    const resp = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      if (resp.status === 429) {
        console.warn("[X-INTEL] Rate limited by X API");
        return null;
      }
      if (resp.status === 404) return null;
      // A rejected or unauthorised credential will be rejected every time. Stop calling rather than
      // spending the month's quota on 401s and marking every token as checked with a useless answer.
      if (resp.status === 401 || resp.status === 403) {
        this.authFailed = true;
        console.error(`[X-INTEL] X API ${resp.status}: the bearer token was refused. Social verification is off until it is replaced.`);
        return null;
      }
      throw new Error(`X API ${resp.status}: ${await resp.text()}`);
    }

    const json = await resp.json();
    return json.data || null;
  }

  /**
   * Score a profile for legitimacy signals
   */
  _scoreProfile(profile) {
    const flags = [];
    let score = 0;

    const metrics = profile.public_metrics || {};
    const followers = metrics.followers_count || 0;
    const following = metrics.following_count || 0;
    const tweets = metrics.tweet_count || 0;

    // Account age (older = more trustworthy)
    const createdAt = profile.created_at ? new Date(profile.created_at) : new Date();
    const ageDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

    if (ageDays < 7) {
      flags.push("fresh_account");
      score -= 15;
    } else if (ageDays < 30) {
      flags.push("new_account");
      score -= 5;
    } else if (ageDays > 365) {
      score += 10;
    }

    // Follower count
    if (followers >= 10000) score += 15;
    else if (followers >= 1000) score += 10;
    else if (followers >= 100) score += 5;
    else if (followers < 10) {
      flags.push("low_followers");
      score -= 5;
    }

    // Follower/following ratio (bot detection)
    const ratio = following > 0 ? followers / following : 0;
    if (ratio < 0.1 && following > 100) {
      flags.push("suspicious_ratio");
      score -= 10;
    } else if (ratio > 2) {
      score += 5;
    }

    // Tweet activity
    if (tweets < 5) {
      flags.push("no_tweets");
      score -= 10;
    } else if (tweets > 100) {
      score += 5;
    }

    // Verified badge
    if (profile.verified) {
      score += 15;
      flags.push("verified");
    }

    // Description present
    if (profile.description && profile.description.length > 20) {
      score += 3;
    }

    return {
      score: Math.max(0, Math.min(100, 50 + score)),
      flags,
      profile: {
        username: profile.username,
        name: profile.name,
        followers,
        following,
        tweets,
        ageDays: Math.round(ageDays),
        verified: !!profile.verified,
        description: (profile.description || "").slice(0, 100),
      },
    };
  }

  _extractUsername(url) {
    if (!url) return null;
    // Handle: twitter.com/user, x.com/user, @user
    const match = url.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/);
    if (match) return match[1];
    if (url.startsWith("@")) return url.slice(1);
    if (/^[a-zA-Z0-9_]{1,15}$/.test(url)) return url;
    return null;
  }

  _nextMonthReset() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  }

  getStats() {
    return {
      enabled: this.enabled,
      configured: !!this.bearerToken,
      authFailed: !!this.authFailed,        // a 401/403 turned it off; the token needs replacing
      requestsUsed: this.requestCount,      // calls sent this process, which on a pay-per-use plan is spend
      monthlyLimit: this.monthlyLimit,
      cacheSize: this.cache.size,
      remaining: Math.max(0, this.monthlyLimit - this.requestCount),
    };
  }
}

export default XSocialIntel;
