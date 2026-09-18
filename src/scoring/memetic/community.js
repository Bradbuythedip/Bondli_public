/**
 * Module 4: Community & Network Structure
 *
 * THE MOST VALUABLE MODULE. Two critical findings:
 * 1. Solidus Labs: >98% of pump.fun tokens are manipulated. Detecting the organic 2% = highest alpha.
 * 2. Weng et al.: structural diversity of early adopters is the strongest predictor of viral breakout.
 *
 * Target: <200ms (with Alchemy wallet analysis)
 */

import { createClient } from 'redis';

let redis = null;

async function getRedis() {
  if (!redis) {
    redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    redis.on('error', () => {});
    try { await redis.connect(); } catch { redis = null; }
  }
  return redis;
}

const WEIGHTS = {
  structuralDiversity: 0.25,
  sybilRatio: 0.15,
  holderAgeEntropy: 0.10,
  synchronizedBuying: 0.10,
  devTransparency: 0.10,
  engagementAuthenticity: 0.08,
  remixDerivativeCount: 0.07,
  committedCoreRatio: 0.05,
  engagementHalfLife: 0.05,
  socialPresence: 0.03,
  dunbarTierHealth: 0.02
};

/**
 * Shannon entropy calculation
 */
function shannonEntropy(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Structural Diversity - MOST IMPORTANT FEATURE IN THE ENTIRE SYSTEM
 *
 * Cluster early buyers by transaction-overlap graph.
 * More distinct clusters = more diverse community = higher viral potential.
 *
 * Uses Alchemy getSignaturesForAddress for 2-hop transaction graph.
 */
async function scoreStructuralDiversity(input) {
  try {
    const { earlyBuyers = [], alchemy } = input;
    if (earlyBuyers.length < 5) return { score: 0.3, clusters: 0 };

    const r = await getRedis();
    const buyers = earlyBuyers.slice(0, 50); // First 50 unique buyers

    // Build adjacency via shared transaction partners (2-hop overlap)
    const walletTxPartners = new Map();

    for (const wallet of buyers) {
      // Check cache first
      const cacheKey = `wallet:partners:${wallet}`;
      let partners = null;

      if (r) {
        const cached = await r.get(cacheKey);
        if (cached) partners = JSON.parse(cached);
      }

      if (!partners && alchemy) {
        try {
          const sigs = await alchemy.core.getSignaturesForAddress(wallet, { limit: 20 });
          partners = [];
          for (const sig of sigs || []) {
            // Extract counterparties from transactions
            if (sig.to && sig.to !== wallet) partners.push(sig.to);
            if (sig.from && sig.from !== wallet) partners.push(sig.from);
          }
          partners = [...new Set(partners)].slice(0, 50);

          if (r) {
            await r.set(cacheKey, JSON.stringify(partners), { EX: 3600 }); // 1h TTL
          }
        } catch {
          partners = [];
        }
      }

      walletTxPartners.set(wallet, new Set(partners || []));
    }

    // Build overlap graph: two buyers are connected if they share transaction partners
    const adjacency = new Map();
    for (const wallet of buyers) {
      adjacency.set(wallet, new Set());
    }

    for (let i = 0; i < buyers.length; i++) {
      for (let j = i + 1; j < buyers.length; j++) {
        const partnersI = walletTxPartners.get(buyers[i]) || new Set();
        const partnersJ = walletTxPartners.get(buyers[j]) || new Set();

        // Check overlap
        let overlap = 0;
        for (const p of partnersI) {
          if (partnersJ.has(p)) overlap++;
        }

        // Connected if >2 shared partners (likely same community)
        if (overlap >= 2) {
          adjacency.get(buyers[i]).add(buyers[j]);
          adjacency.get(buyers[j]).add(buyers[i]);
        }
      }
    }

    // Connected component analysis (BFS)
    const visited = new Set();
    let clusters = 0;

    for (const wallet of buyers) {
      if (visited.has(wallet)) continue;
      clusters++;
      const queue = [wallet];
      while (queue.length > 0) {
        const current = queue.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        for (const neighbor of (adjacency.get(current) || [])) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
    }

    // Score based on cluster count
    let score;
    if (clusters >= 10) score = 1.0;
    else if (clusters >= 5) score = 0.9;
    else if (clusters >= 3) score = 0.5;
    else if (clusters === 2) score = 0.3;
    else score = 0.1; // All connected = coordinated

    return { score, clusters };
  } catch {
    return { score: 0.5, clusters: -1 };
  }
}

/**
 * Holder age entropy - diverse wallet ages = organic
 */
async function scoreHolderAgeEntropy(input) {
  try {
    const { holders = [], alchemy } = input;
    if (holders.length < 5) return { score: 0.5, entropy: 0 };

    const now = Date.now();
    const ageBuckets = new Array(10).fill(0);

    for (const wallet of holders.slice(0, 100)) {
      let walletAge = 0;

      // Try to get wallet creation age via first transaction
      const r = await getRedis();
      const cacheKey = `wallet:age:${wallet}`;

      if (r) {
        const cached = await r.get(cacheKey);
        if (cached) {
          walletAge = parseInt(cached);
        }
      }

      if (walletAge === 0 && alchemy) {
        try {
          const sigs = await alchemy.core.getSignaturesForAddress(wallet, { limit: 1 });
          if (sigs && sigs.length > 0 && sigs[0].blockTime) {
            walletAge = now - (sigs[0].blockTime * 1000);
            if (r) await r.set(cacheKey, String(walletAge), { EX: 3600 });
          }
        } catch {}
      }

      // Bin into 10 age buckets (0-1day, 1-7d, 7-30d, 30-90d, 90-180d, 180-365d, 1-2y, 2-3y, 3-5y, 5y+)
      const days = walletAge / (1000 * 60 * 60 * 24);
      let bucket;
      if (days < 1) bucket = 0;
      else if (days < 7) bucket = 1;
      else if (days < 30) bucket = 2;
      else if (days < 90) bucket = 3;
      else if (days < 180) bucket = 4;
      else if (days < 365) bucket = 5;
      else if (days < 730) bucket = 6;
      else if (days < 1095) bucket = 7;
      else if (days < 1825) bucket = 8;
      else bucket = 9;

      ageBuckets[bucket]++;
    }

    const entropy = shannonEntropy(ageBuckets);
    const maxEntropy = Math.log2(10); // max possible with 10 buckets
    const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

    return { score: normalizedEntropy, entropy, ageBuckets };
  } catch {
    return { score: 0.5, entropy: 0, ageBuckets: [] };
  }
}

/**
 * Sybil detection - fraction of holders funded from same parent
 */
async function scoreSybilRatio(input) {
  try {
    const { holders = [], alchemy } = input;
    if (holders.length < 5) return { score: 0.5, sybilRatio: 0 };

    const funders = new Map(); // funder -> count of funded holders

    for (const wallet of holders.slice(0, 50)) {
      if (!alchemy) break;

      try {
        const sigs = await alchemy.core.getSignaturesForAddress(wallet, { limit: 5 });
        for (const sig of sigs || []) {
          if (sig.from && sig.from !== wallet) {
            funders.set(sig.from, (funders.get(sig.from) || 0) + 1);
          }
        }
      } catch {}
    }

    // Find max shared funder
    let maxShared = 0;
    for (const count of funders.values()) {
      maxShared = Math.max(maxShared, count);
    }

    const sybilRatio = holders.length > 0 ? maxShared / Math.min(holders.length, 50) : 0;

    // Inverted: 1.0 - sybilRatio
    return {
      score: Math.max(0, 1.0 - sybilRatio),
      sybilRatio,
      maxSharedFunder: maxShared
    };
  } catch {
    return { score: 0.5, sybilRatio: 0 };
  }
}

/**
 * Synchronized buying detection
 * >5 wallets buying within 3-second window = bots
 */
function scoreSynchronizedBuying(input) {
  try {
    const { transactions = [] } = input;
    if (transactions.length < 10) return { score: 0.5, burstRatio: 0 };

    // Sort by timestamp
    const sorted = [...transactions]
      .filter(tx => tx.type === 'buy' && tx.timestamp)
      .sort((a, b) => a.timestamp - b.timestamp);

    let burstCount = 0;
    const windowMs = 3000; // 3 seconds

    for (let i = 0; i < sorted.length; i++) {
      let windowBuyers = 1;
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].timestamp - sorted[i].timestamp <= windowMs) {
          windowBuyers++;
        } else break;
      }
      if (windowBuyers >= 5) burstCount++;
    }

    const burstRatio = burstCount / sorted.length;
    const score = Math.max(0, 1.0 - (burstRatio * 10));

    return { score, burstRatio, burstCount };
  } catch {
    return { score: 0.5, burstRatio: 0 };
  }
}

/**
 * Social presence check
 */
function scoreSocialPresence(input) {
  const { twitter, telegram, website, discord, twitterAge = 0 } = input;
  let score = 0;

  if (twitter) score += 0.2;
  if (telegram) score += 0.2;
  if (website) score += 0.15;
  if (discord) score += 0.15;

  // Account age bonus (>7 days pre-launch)
  if (twitterAge > 7 * 24 * 60 * 60 * 1000) score += 0.3;

  return Math.min(1.0, score);
}

/**
 * Engagement authenticity
 * Real discussions: 3+ reply depth, diverse repliers, mixed sentiment
 */
function scoreEngagementAuthenticity(input) {
  const {
    avgReplyDepth = 0,
    uniqueReplierRatio = 0,
    sentimentDiversity = 0,
    contentDuplicationRate = 0
  } = input;

  let score = 0;

  // Reply chain depth (real = 3+, bots = 1)
  if (avgReplyDepth >= 3) score += 0.3;
  else if (avgReplyDepth >= 2) score += 0.2;
  else if (avgReplyDepth >= 1) score += 0.1;

  // Unique replier ratio
  score += uniqueReplierRatio * 0.3;

  // Sentiment diversity (real communities have mixed sentiment)
  score += sentimentDiversity * 0.2;

  // Content duplication rate (astroturfers > 80% duplication)
  if (contentDuplicationRate < 0.2) score += 0.2;
  else if (contentDuplicationRate < 0.5) score += 0.1;
  else if (contentDuplicationRate > 0.8) score -= 0.2;

  return { score: Math.max(0, Math.min(1.0, score)) };
}

/**
 * Committed core ratio
 * RPI (2011): 10% committed minority → majority adoption
 * Centola (Science 2018): 25% overturns conventions
 */
function scoreCommittedCoreRatio(input) {
  const { totalMembers = 0, activeMembers = 0 } = input;
  if (totalMembers === 0) return 0.1;

  const ratio = activeMembers / totalMembers;

  if (ratio >= 0.25) return 1.0;
  if (ratio >= 0.10) return 0.7;
  if (ratio >= 0.05) return 0.3;
  return 0.1;
}

/**
 * Dunbar tier health
 * Map community size against Dunbar layers (5→15→50→150→500)
 */
function scoreDunbarTierHealth(input) {
  const { totalMembers = 0, activeMembers = 0 } = input;
  if (totalMembers === 0) return 0.1;

  // Determine which Dunbar tier we're in
  let expectedActive;
  if (totalMembers <= 5) expectedActive = totalMembers;       // intimate group
  else if (totalMembers <= 15) expectedActive = 5;             // close friends
  else if (totalMembers <= 50) expectedActive = 12;            // friends
  else if (totalMembers <= 150) expectedActive = 30;           // social group
  else if (totalMembers <= 500) expectedActive = 50;           // acquaintances
  else expectedActive = 100;                                    // large community

  const healthRatio = activeMembers / expectedActive;

  if (healthRatio >= 1.0) return 1.0;
  if (healthRatio >= 0.5) return 0.7;
  if (healthRatio >= 0.2) return 0.4;
  return 0.1;
}

/**
 * Dev transparency
 */
function scoreDevTransparency(input) {
  const {
    devHoldPercent = 0,
    hasPublicIdentity = false,
    priorLaunches = 0,
    priorRugs = 0,
    soldPercentIn1h = 0
  } = input;

  let score = 0;

  // Dev holds <5% = fair launch
  if (devHoldPercent < 5) score += 0.8;
  else if (devHoldPercent < 10) score += 0.5;
  else if (devHoldPercent < 20) score += 0.2;

  // Public identity
  if (hasPublicIdentity) score += 0.2;

  // Prior successful launches
  if (priorLaunches > 0 && priorRugs === 0) score += 0.3;

  // Sold >50% in 1hr = massive red flag
  if (soldPercentIn1h > 50) score -= 0.8;
  else if (soldPercentIn1h > 25) score -= 0.4;

  return Math.max(0, Math.min(1.0, score));
}

/**
 * Remix derivative count
 * Third parties creating derivative content = organic community formation
 */
async function scoreRemixDerivativeCount(tokenAddress) {
  try {
    const r = await getRedis();
    if (!r) return 0.1;

    const count = parseInt(await r.get(`token:derivatives:${tokenAddress}`) || '0');

    if (count >= 10) return 1.0;
    if (count >= 5) return 0.8;
    if (count >= 3) return 0.6;
    if (count >= 1) return 0.4;
    return 0.1;
  } catch {
    return 0.1;
  }
}

/**
 * Engagement half-life
 * Time for daily mention volume to decay to 50% of peak
 */
async function scoreEngagementHalfLife(tokenAddress) {
  try {
    const r = await getRedis();
    if (!r) return 0.5;

    const halfLifeHours = parseFloat(await r.get(`token:halflife:${tokenAddress}`) || '0');

    if (halfLifeHours > 24) return 1.0;  // sticky
    if (halfLifeHours > 6) return 0.6;   // medium
    if (halfLifeHours > 1) return 0.3;   // short
    if (halfLifeHours > 0) return 0.1;   // flash
    return 0.5; // no data
  } catch {
    return 0.5;
  }
}

/**
 * Main scoring function
 */
export async function scoreCommunity(input) {
  try {
    const {
      earlyBuyers = [], holders = [], transactions = [],
      tokenAddress = '', alchemy = null,
      twitter, telegram, website, discord, twitterAge,
      avgReplyDepth, uniqueReplierRatio, sentimentDiversity, contentDuplicationRate,
      totalMembers = 0, activeMembers = 0,
      devHoldPercent, hasPublicIdentity, priorLaunches, priorRugs, soldPercentIn1h
    } = input;

    // Run all sub-scores in parallel
    const [
      structuralDiversityResult,
      holderAgeResult,
      sybilResult,
      syncResult,
      remixResult,
      halfLifeResult
    ] = await Promise.allSettled([
      scoreStructuralDiversity({ earlyBuyers, alchemy }),
      scoreHolderAgeEntropy({ holders, alchemy }),
      scoreSybilRatio({ holders, alchemy }),
      Promise.resolve(scoreSynchronizedBuying({ transactions })),
      scoreRemixDerivativeCount(tokenAddress),
      scoreEngagementHalfLife(tokenAddress)
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : { score: 0.5 }));

    // Synchronous scores
    const socialPresence = scoreSocialPresence({ twitter, telegram, website, discord, twitterAge });
    const engagementAuth = scoreEngagementAuthenticity({
      avgReplyDepth, uniqueReplierRatio, sentimentDiversity, contentDuplicationRate
    });
    const committedCore = scoreCommittedCoreRatio({ totalMembers, activeMembers });
    const dunbarHealth = scoreDunbarTierHealth({ totalMembers, activeMembers });
    const devTransparency = scoreDevTransparency({
      devHoldPercent, hasPublicIdentity, priorLaunches, priorRugs, soldPercentIn1h
    });

    const features = {
      structuralDiversity: structuralDiversityResult.score ?? structuralDiversityResult,
      structuralDiversityClusters: structuralDiversityResult.clusters,
      holderAgeEntropy: holderAgeResult.score ?? holderAgeResult,
      sybilRatio: sybilResult.score ?? sybilResult,
      sybilRatioRaw: sybilResult.sybilRatio,
      synchronizedBuying: syncResult.score ?? syncResult,
      burstRatio: syncResult.burstRatio,
      socialPresence,
      engagementAuthenticity: engagementAuth.score,
      committedCoreRatio: committedCore,
      dunbarTierHealth: dunbarHealth,
      devTransparency,
      remixDerivativeCount: typeof remixResult === 'number' ? remixResult : remixResult.score ?? 0.1,
      engagementHalfLife: typeof halfLifeResult === 'number' ? halfLifeResult : halfLifeResult.score ?? 0.5
    };

    const sd = features.structuralDiversity;
    const sy = features.sybilRatio;
    const ha = features.holderAgeEntropy;
    const sb = features.synchronizedBuying;
    const dt = features.devTransparency;
    const ea = features.engagementAuthenticity;
    const rd = features.remixDerivativeCount;
    const cc = features.committedCoreRatio;
    const eh = features.engagementHalfLife;
    const sp = features.socialPresence;
    const dh = features.dunbarTierHealth;

    const score = Math.max(0, Math.min(1.0,
      sd * WEIGHTS.structuralDiversity +
      sy * WEIGHTS.sybilRatio +
      ha * WEIGHTS.holderAgeEntropy +
      sb * WEIGHTS.synchronizedBuying +
      dt * WEIGHTS.devTransparency +
      ea * WEIGHTS.engagementAuthenticity +
      rd * WEIGHTS.remixDerivativeCount +
      cc * WEIGHTS.committedCoreRatio +
      eh * WEIGHTS.engagementHalfLife +
      sp * WEIGHTS.socialPresence +
      dh * WEIGHTS.dunbarTierHealth
    ));

    return { score, features };
  } catch (err) {
    console.error('[community] Error:', err.message);
    return { score: 0.5, features: { error: err.message } };
  }
}

export default scoreCommunity;
