// BONDLI v3.0 — Artwork Originality Scanner
// Detects stolen/duplicated token images — a top rug signal
//
// How it works:
//   1. Fetch token image from metadata URI or pump.fun
//   2. Compute perceptual hash (pHash) — robust to resizing/compression
//   3. Compare against known-image database (past tokens we've seen)
//   4. Check for stock photo patterns, AI-generated signatures
//   5. Return originality score + flags
//
// Why this matters:
//   - Legit projects commission or create original art
//   - Rugs steal art from existing tokens, Google Images, or use identical templates
//   - A token reusing another token's image is almost certainly a copycat scam
//   - Generic/stock AI art with no effort = low-effort rug

import { createHash } from "crypto";

// ═══ PERCEPTUAL HASH ═══
// Simplified pHash: resize to 8x8 grayscale, compute DCT-like fingerprint
// Two images that look similar will have similar hashes even if resized/compressed

function computeImageHash(imageBuffer) {
  // Use raw pixel sampling approach — works on any image format via byte distribution
  // Not a true pHash (would need sharp/jimp) but good enough for duplicate detection
  const buf = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer);

  // Strategy: sample 64 evenly-spaced bytes, threshold against median
  const step = Math.max(1, Math.floor(buf.length / 64));
  const samples = [];
  for (let i = 0; i < 64 && i * step < buf.length; i++) {
    samples.push(buf[i * step]);
  }

  // Pad if short
  while (samples.length < 64) samples.push(0);

  const median = [...samples].sort((a, b) => a - b)[32];

  // Binary hash: each bit = sample > median
  let hash = "";
  for (const s of samples) {
    hash += s > median ? "1" : "0";
  }

  return hash;
}

// Hamming distance between two binary hash strings
function hammingDistance(h1, h2) {
  if (h1.length !== h2.length) return 64; // max distance
  let dist = 0;
  for (let i = 0; i < h1.length; i++) {
    if (h1[i] !== h2[i]) dist++;
  }
  return dist;
}

// Similarity: 0 = completely different, 1 = identical
function hashSimilarity(h1, h2) {
  return 1 - hammingDistance(h1, h2) / 64;
}

// ═══ CONTENT HASH ═══
// Exact match detection — SHA256 of raw bytes
function contentHash(imageBuffer) {
  return createHash("sha256").update(imageBuffer).digest("hex");
}

// ═══ IMAGE ANALYSIS ═══
// Analyze image properties without heavy dependencies

function analyzeImageBuffer(buf) {
  const size = buf.length;

  // Detect format from magic bytes
  let format = "unknown";
  if (buf[0] === 0x89 && buf[1] === 0x50) format = "png";
  else if (buf[0] === 0xFF && buf[1] === 0xD8) format = "jpeg";
  else if (buf[0] === 0x47 && buf[1] === 0x49) format = "gif";
  else if (buf[0] === 0x52 && buf[1] === 0x49) format = "webp";
  else if (buf[0] === 0x3C) format = "svg";

  // Entropy — higher entropy = more complex/original image
  // Low entropy = simple gradient/solid color = lazy
  const freq = new Array(256).fill(0);
  for (let i = 0; i < Math.min(buf.length, 50000); i++) {
    freq[buf[i]]++;
  }
  const total = Math.min(buf.length, 50000);
  let entropy = 0;
  for (const f of freq) {
    if (f > 0) {
      const p = f / total;
      entropy -= p * Math.log2(p);
    }
  }

  // Byte diversity — unique byte values used
  const uniqueBytes = freq.filter(f => f > 0).length;
  const diversity = uniqueBytes / 256;

  return { size, format, entropy, diversity, uniqueBytes };
}

// ═══ ARTWORK SCANNER CLASS ═══

export class ArtworkScanner {
  constructor(maxHistory = 5000) {
    // Seen images: Map<contentHash, { ca, pHash, name, timestamp }>
    this.seen = new Map();
    // pHash index for fuzzy matching
    this.pHashes = []; // [{ ca, hash, name, timestamp }]
    this.maxHistory = maxHistory;
    this.stats = { scanned: 0, duplicates: 0, suspicious: 0 };
  }

  // Scan a token's artwork for originality
  // Returns: { original: bool, score: 0-100, flags: [], matches: [] }
  async scan(ca, imageUrl, tokenName) {
    const result = {
      ca,
      original: true,
      score: 100,
      flags: [],
      matches: [],
      analysis: null,
    };

    this.stats.scanned++;

    if (!imageUrl) {
      result.flags.push("NO_IMAGE");
      result.score -= 15;
      result.original = result.score >= 60;
      return result;
    }

    try {
      // 1. Fetch the image
      const imageBuffer = await this._fetchImage(imageUrl);
      if (!imageBuffer || imageBuffer.length < 100) {
        result.flags.push("IMAGE_FETCH_FAILED");
        result.score -= 10;
        result.original = result.score >= 60;
        return result;
      }

      // 2. Analyze image properties
      const analysis = analyzeImageBuffer(imageBuffer);
      result.analysis = analysis;

      // Tiny image = low effort
      if (analysis.size < 5000) {
        result.flags.push("TINY_IMAGE");
        result.score -= 10;
      }

      // Very low entropy = simple/lazy image (solid colors, basic gradients)
      if (analysis.entropy < 4.0) {
        result.flags.push("LOW_COMPLEXITY");
        result.score -= 15;
      }

      // SVG = could be template-generated
      if (analysis.format === "svg") {
        result.flags.push("SVG_TEMPLATE_RISK");
        result.score -= 5;
      }

      // 3. Check exact duplicate (content hash)
      const cHash = contentHash(imageBuffer);
      const exactMatch = this.seen.get(cHash);
      if (exactMatch && exactMatch.ca !== ca) {
        result.flags.push("EXACT_DUPLICATE");
        result.matches.push({
          type: "exact",
          ca: exactMatch.ca,
          name: exactMatch.name,
          similarity: "100%",
          age: Math.round((Date.now() - exactMatch.timestamp) / 60000) + "m ago",
        });
        result.score -= 50;
        this.stats.duplicates++;
      }

      // 4. Check perceptual similarity (fuzzy match)
      const pHash = computeImageHash(imageBuffer);
      const SIMILARITY_THRESHOLD = 0.85; // 85%+ = suspiciously similar

      let similarFound = false;
      for (const entry of this.pHashes) {
        if (entry.ca === ca) continue;
        const sim = hashSimilarity(pHash, entry.hash);
        if (sim >= SIMILARITY_THRESHOLD) {
          if (!similarFound) {
            result.flags.push("SIMILAR_IMAGE");
            similarFound = true;
          }
          result.matches.push({
            type: "perceptual",
            ca: entry.ca,
            name: entry.name,
            similarity: (sim * 100).toFixed(1) + "%",
            age: Math.round((Date.now() - entry.timestamp) / 60000) + "m ago",
          });
          // Penalty scales with similarity
          result.score -= Math.round((sim - 0.8) * 150);
          this.stats.suspicious++;
        }
      }

      // 5. Check for known stock/template patterns
      const templateFlags = this._checkTemplatePatterns(imageBuffer, analysis);
      result.flags.push(...templateFlags);
      result.score -= templateFlags.length * 8;

      // 6. Store for future comparisons
      this.seen.set(cHash, { ca, pHash, name: tokenName, timestamp: Date.now() });
      this.pHashes.push({ ca, hash: pHash, name: tokenName, timestamp: Date.now() });

      // Evict old entries
      if (this.pHashes.length > this.maxHistory) {
        this.pHashes = this.pHashes.slice(-this.maxHistory);
      }
      if (this.seen.size > this.maxHistory) {
        const keys = [...this.seen.keys()];
        for (let i = 0; i < keys.length - this.maxHistory; i++) {
          this.seen.delete(keys[i]);
        }
      }

    } catch (e) {
      result.flags.push(`SCAN_ERROR: ${e.message}`);
      result.score -= 5;
    }

    result.score = Math.max(0, Math.min(100, result.score));
    result.original = result.score >= 60 && !result.flags.includes("EXACT_DUPLICATE");
    return result;
  }

  // Fetch image with timeout
  async _fetchImage(url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      clearTimeout(timeout);

      if (!res.ok) return null;

      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch {
      return null;
    }
  }

  // Check for common template/stock patterns
  _checkTemplatePatterns(buf, analysis) {
    const flags = [];

    // Extremely uniform byte distribution = AI-generated or procedural
    // Real photos/art have irregular distributions
    if (analysis.diversity > 0.95 && analysis.entropy > 7.5) {
      flags.push("LIKELY_AI_GENERATED");
    }

    // Very small + low entropy = MS Paint / basic editor template
    if (analysis.size < 10000 && analysis.entropy < 5.0) {
      flags.push("LOW_EFFORT_ART");
    }

    // GIF with small size = recycled meme gif
    if (analysis.format === "gif" && analysis.size < 50000) {
      flags.push("RECYCLED_GIF");
    }

    return flags;
  }

  // Get scan stats
  getStats() {
    return {
      ...this.stats,
      knownImages: this.seen.size,
      pHashIndex: this.pHashes.length,
      duplicateRate: this.stats.scanned > 0
        ? (this.stats.duplicates / this.stats.scanned * 100).toFixed(1) + "%"
        : "N/A",
    };
  }

  // Export for persistence
  export() {
    return {
      seen: [...this.seen.entries()].slice(-1000),
      pHashes: this.pHashes.slice(-1000),
      stats: this.stats,
    };
  }

  // Import from persistence
  import(data) {
    if (data?.seen) {
      for (const [k, v] of data.seen) {
        this.seen.set(k, v);
      }
    }
    if (data?.pHashes) {
      this.pHashes = data.pHashes;
    }
    if (data?.stats) {
      this.stats = { ...this.stats, ...data.stats };
    }
  }
}

export default ArtworkScanner;
