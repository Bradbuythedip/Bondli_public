/**
 * Module 2: Visual Memetics
 *
 * CoinCLIP (arXiv 2024): image-based methods outperform text for viability prediction.
 * The lo-fi paradox: WIF's crude Shiba in a beanie = 100,000x. Polish triggers suspicion.
 * Sontag: "The ultimate Camp statement: it's good because it's awful."
 *
 * Target: <100ms (sharp for image analysis)
 */

import { createClient } from 'redis';

let redis = null;
let sharp = null;

// Lazy-load sharp (may not be installed in all environments)
async function getSharp() {
  if (sharp === undefined) {
    try {
      sharp = (await import('sharp')).default;
    } catch {
      sharp = null;
    }
  }
  return sharp;
}

async function getRedis() {
  if (!redis) {
    redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    redis.on('error', () => {});
    try { await redis.connect(); } catch { redis = null; }
  }
  return redis;
}

const WEIGHTS = {
  loFiScore: 0.25,
  characterPresence: 0.25,
  anthropomorphism: 0.10,
  colorAnalysis: 0.10,
  complexity: 0.10,
  memeTemplate: 0.10,
  entropy: 0.10
};

// Pepe-green color signature RGB ranges
const PEPE_GREEN = { r: [80, 160], g: [140, 220], b: [40, 120] };

/**
 * Fetch and cache image buffer
 */
async function fetchImage(uri) {
  if (!uri) return null;

  const r = await getRedis();
  const cacheKey = `meme:visual:${Buffer.from(uri).toString('base64').slice(0, 64)}`;

  if (r) {
    const cached = await r.get(cacheKey);
    if (cached) return Buffer.from(cached, 'base64');
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(uri, {
      signal: controller.signal,
      headers: { 'User-Agent': 'bondli-scanner/1.0' }
    });
    clearTimeout(timeout);

    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());

    if (r) {
      await r.set(cacheKey, buffer.toString('base64'), { EX: 86400 }); // 24h TTL
    }

    return buffer;
  } catch {
    return null;
  }
}

/**
 * Color analysis using HSV histogram
 */
async function analyzeColors(sharpInstance, metadata) {
  try {
    const { data, info } = await sharpInstance
      .resize(64, 64, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    const pixelCount = info.width * info.height;
    const colors = new Map();
    let warmCount = 0;
    let coolCount = 0;
    let totalSaturation = 0;

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i], g = data[i + 1], b = data[i + 2];

      // Quantize to 16-color palette for counting
      const qr = Math.floor(r / 64);
      const qg = Math.floor(g / 64);
      const qb = Math.floor(b / 64);
      const key = `${qr},${qg},${qb}`;
      colors.set(key, (colors.get(key) || 0) + 1);

      // Warm vs cool (rough heuristic based on R vs B dominance)
      if (r > b) warmCount++;
      else coolCount++;

      // Saturation estimate
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      totalSaturation += max > 0 ? (max - min) / max : 0;
    }

    const colorCount = colors.size;
    const warmRatio = warmCount / pixelCount;
    const avgSaturation = totalSaturation / pixelCount;

    // Optimal: 3-6 distinct color groups
    let colorScore;
    if (colorCount >= 3 && colorCount <= 6) colorScore = 1.0;
    else if (colorCount >= 2 && colorCount <= 10) colorScore = 0.7;
    else colorScore = 0.4;

    // Warm colors = higher arousal (Berger & Milkman)
    const warmScore = warmRatio > 0.5 ? 0.7 + warmRatio * 0.3 : 0.4;

    return {
      score: (colorScore * 0.4 + warmScore * 0.3 + avgSaturation * 0.3),
      colorCount,
      warmRatio,
      avgSaturation
    };
  } catch {
    return { score: 0.5, colorCount: 0, warmRatio: 0.5, avgSaturation: 0.5 };
  }
}

/**
 * Lo-Fi Score - THE KEY INVERSION: higher lo-fi = BETTER
 * Low resolution, JPEG artifacts, limited palette, deep-fried = authentic
 */
async function analyzeLoFi(sharpInstance, metadata, buffer) {
  try {
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const format = metadata.format || '';
    let score = 0;

    // Low resolution bonus
    if (width < 200 || height < 200) score += 0.3;
    else if (width < 500 || height < 500) score += 0.2;
    else if (width < 1000 || height < 1000) score += 0.1;
    // High res = penalty (polished = suspicious)

    // JPEG format = compression artifacts likely
    if (format === 'jpeg' || format === 'jpg') score += 0.1;

    // Compression ratio (small file for image size = heavily compressed)
    const pixelCount = width * height;
    if (pixelCount > 0) {
      const bytesPerPixel = buffer.length / pixelCount;
      if (bytesPerPixel < 0.5) score += 0.25; // very compressed
      else if (bytesPerPixel < 1.0) score += 0.15;
      else if (bytesPerPixel < 2.0) score += 0.05;
    }

    // Limited color palette detection
    const { data } = await sharpInstance
      .resize(32, 32, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const uniqueColors = new Set();
    for (let i = 0; i < data.length; i += 3) {
      // Quantize to ~64 colors
      const key = `${Math.floor(data[i] / 32)},${Math.floor(data[i + 1] / 32)},${Math.floor(data[i + 2] / 32)}`;
      uniqueColors.add(key);
    }

    if (uniqueColors.size < 16) score += 0.2; // very limited palette
    else if (uniqueColors.size < 32) score += 0.1;

    // Deep-fried detection: high saturation variance + oversharpening
    // Approximated by checking if many pixels are near max saturation
    let saturatedPixels = 0;
    for (let i = 0; i < data.length; i += 3) {
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      if (max > 200 && (max - min) > 150) saturatedPixels++;
    }
    const satRatio = saturatedPixels / (data.length / 3);
    if (satRatio > 0.3) score += 0.15; // deep-fried

    return { score: Math.min(1.0, score), uniqueColors: uniqueColors.size, satRatio };
  } catch {
    return { score: 0.5, uniqueColors: 0, satRatio: 0 };
  }
}

/**
 * Character presence detection using edge/contour analysis
 */
async function analyzeCharacterPresence(sharpInstance) {
  try {
    // Edge detection via Sobel-like approach (greyscale gradient)
    const { data: grey } = await sharpInstance
      .resize(64, 64, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const width = 64;
    let edgeSum = 0;
    let faceRegionIntensity = 0;
    const centerRegion = { count: 0, edges: 0 };

    for (let y = 1; y < 63; y++) {
      for (let x = 1; x < 63; x++) {
        const idx = y * width + x;
        // Sobel-like horizontal + vertical gradient
        const gx = Math.abs(grey[idx + 1] - grey[idx - 1]);
        const gy = Math.abs(grey[(y + 1) * width + x] - grey[(y - 1) * width + x]);
        const edge = Math.sqrt(gx * gx + gy * gy);
        edgeSum += edge;

        // Center region = likely face/character area
        if (x >= 16 && x <= 48 && y >= 8 && y <= 48) {
          centerRegion.edges += edge;
          centerRegion.count++;
        }
      }
    }

    const avgEdge = edgeSum / (62 * 62);
    const centerAvgEdge = centerRegion.count > 0 ? centerRegion.edges / centerRegion.count : 0;

    // Character likely present if center has more edges than average
    const hasCharacter = centerAvgEdge > avgEdge * 1.2;

    // Score based on character likelihood
    let score = hasCharacter ? 0.8 : 0.4;
    let species = 'unknown';

    // Check for Pepe-green dominance
    const { data: rgb } = await sharpInstance
      .resize(32, 32, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let pepePixels = 0;
    for (let i = 0; i < rgb.length; i += 3) {
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      if (r >= PEPE_GREEN.r[0] && r <= PEPE_GREEN.r[1] &&
          g >= PEPE_GREEN.g[0] && g <= PEPE_GREEN.g[1] &&
          b >= PEPE_GREEN.b[0] && b <= PEPE_GREEN.b[1]) {
        pepePixels++;
      }
    }

    if (pepePixels / (rgb.length / 3) > 0.15) {
      species = 'pepe_derivative';
      score = Math.max(score, 0.9);
    }

    return {
      score,
      hasCharacter,
      species,
      edgeDensity: avgEdge,
      centerFocus: centerAvgEdge / (avgEdge || 1)
    };
  } catch {
    return { score: 0.5, hasCharacter: false, species: 'unknown', edgeDensity: 0, centerFocus: 0 };
  }
}

/**
 * Anthropomorphism detection
 * Waytz's 3-factor theory: agent knowledge, effectance motivation, sociality motivation
 */
function scoreAnthropomorphism(characterResult, name = '') {
  const lower = name.toLowerCase();
  let score = 0;

  if (!characterResult.hasCharacter) return { score: 0.2, signals: [] };

  const signals = [];

  // Clothing/accessories keywords in name suggest anthropomorphism
  const anthropoKeywords = [
    'hat', 'cap', 'glasses', 'suit', 'dress', 'shirt', 'hoodie',
    'crown', 'tie', 'scarf', 'boots', 'shoes', 'watch', 'ring',
    'smoking', 'drinking', 'reading', 'driving', 'gaming',
    'mr', 'mrs', 'sir', 'lord', 'king', 'queen', 'professor', 'doctor',
    'chef', 'captain', 'general', 'detective'
  ];

  for (const kw of anthropoKeywords) {
    if (lower.includes(kw)) {
      score += 0.2;
      signals.push(kw);
    }
  }

  // WIF pattern: animal + accessory
  const animalKeywords = ['dog', 'cat', 'frog', 'inu', 'shiba', 'pepe', 'doge', 'bird', 'penguin'];
  const hasAnimal = animalKeywords.some(a => lower.includes(a));
  if (hasAnimal && signals.length > 0) {
    score += 0.3; // Animal + human trait = peak anthropomorphism
    signals.push('animal_with_human_trait');
  }

  return { score: Math.min(1.0, score), signals };
}

/**
 * Visual complexity - sweet spot is medium-low
 */
function scoreVisualComplexity(edgeDensity) {
  // Normalized edge density: 0 = flat, 100+ = very complex
  if (edgeDensity < 5) return 0.3;    // too simple
  if (edgeDensity < 15) return 0.8;   // sweet spot: medium-low
  if (edgeDensity < 30) return 1.0;   // good complexity
  if (edgeDensity < 50) return 0.6;   // getting complex
  return 0.3;                          // too complex for thumbnail
}

/**
 * Meme template detection
 */
async function analyzeMemeTemplate(sharpInstance) {
  try {
    const { data } = await sharpInstance
      .resize(64, 64, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let score = 0;
    const signals = [];

    // Check for Impact font-like white text regions at top/bottom
    // (bright pixels concentrated in top 1/4 or bottom 1/4)
    let topBright = 0, bottomBright = 0, totalBright = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const idx = (y * 64 + x) * 3;
        const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        if (brightness > 220) {
          totalBright++;
          if (y < 16) topBright++;
          if (y >= 48) bottomBright++;
        }
      }
    }

    if (topBright > 50 && bottomBright > 50) {
      score += 0.4; // Impact font overlay pattern
      signals.push('impact_font_overlay');
    }

    // Black border detection (demotivational poster)
    let borderBlack = 0;
    for (let i = 0; i < 64; i++) {
      // Top row
      const topIdx = i * 3;
      if (data[topIdx] < 20 && data[topIdx + 1] < 20 && data[topIdx + 2] < 20) borderBlack++;
      // Bottom row
      const botIdx = (63 * 64 + i) * 3;
      if (data[botIdx] < 20 && data[botIdx + 1] < 20 && data[botIdx + 2] < 20) borderBlack++;
      // Left col
      const leftIdx = (i * 64) * 3;
      if (data[leftIdx] < 20 && data[leftIdx + 1] < 20 && data[leftIdx + 2] < 20) borderBlack++;
      // Right col
      const rightIdx = (i * 64 + 63) * 3;
      if (data[rightIdx] < 20 && data[rightIdx + 1] < 20 && data[rightIdx + 2] < 20) borderBlack++;
    }
    if (borderBlack > 200) {
      score += 0.3;
      signals.push('demotivational_border');
    }

    // Pepe-green detection handled elsewhere but flag here too
    let pepePixels = 0;
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r >= PEPE_GREEN.r[0] && r <= PEPE_GREEN.r[1] &&
          g >= PEPE_GREEN.g[0] && g <= PEPE_GREEN.g[1] &&
          b >= PEPE_GREEN.b[0] && b <= PEPE_GREEN.b[1]) {
        pepePixels++;
      }
    }
    if (pepePixels / (64 * 64) > 0.1) {
      score += 0.3;
      signals.push('pepe_green_signature');
    }

    return { score: Math.min(1.0, score), signals };
  } catch {
    return { score: 0.5, signals: [] };
  }
}

/**
 * Image entropy - Shannon entropy of pixel values
 */
function calculateEntropy(data) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i++) {
    hist[data[i]]++;
  }

  let entropy = 0;
  const total = data.length;
  for (const count of hist) {
    if (count === 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  return entropy; // 0-8 bits
}

function scoreImageEntropy(entropy) {
  // Very low (<3) = lazy gradient/solid color
  // Very high (>7) = noisy photo
  // Medium (4-6) = designed meme art
  if (entropy >= 4 && entropy <= 6) return 1.0;
  if (entropy >= 3 && entropy <= 7) return 0.7;
  return 0.3;
}

/**
 * Main scoring function
 */
export async function scoreVisual(input) {
  try {
    const { imageUri, name = '' } = input;
    if (!imageUri) return { score: 0.5, features: { noImage: true } };

    const sharpLib = await getSharp();
    if (!sharpLib) {
      return { score: 0.5, features: { error: 'sharp not available' } };
    }

    const buffer = await fetchImage(imageUri);
    if (!buffer) {
      return { score: 0.5, features: { error: 'image fetch failed' } };
    }

    const img = sharpLib(buffer);
    const metadata = await img.metadata();

    // Run all analyses in parallel
    const [colorResult, loFiResult, characterResult, memeTemplateResult] = await Promise.allSettled([
      analyzeColors(sharpLib(buffer), metadata),
      analyzeLoFi(sharpLib(buffer), metadata, buffer),
      analyzeCharacterPresence(sharpLib(buffer)),
      analyzeMemeTemplate(sharpLib(buffer))
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : { score: 0.5 }));

    // Entropy from greyscale
    let entropy = 5; // default
    try {
      const { data } = await sharpLib(buffer).resize(64, 64).greyscale().raw().toBuffer({ resolveWithObject: true });
      entropy = calculateEntropy(data);
    } catch {}

    const anthropomorphism = scoreAnthropomorphism(characterResult, name);
    const complexity = scoreVisualComplexity(characterResult.edgeDensity || 15);
    const entropyScore = scoreImageEntropy(entropy);

    const features = {
      loFiScore: loFiResult.score,
      characterPresence: characterResult.score,
      characterSpecies: characterResult.species,
      hasCharacter: characterResult.hasCharacter,
      anthropomorphism: anthropomorphism.score,
      anthropomorphismSignals: anthropomorphism.signals,
      colorAnalysis: colorResult.score,
      colorCount: colorResult.colorCount,
      warmRatio: colorResult.warmRatio,
      visualComplexity: complexity,
      memeTemplate: memeTemplateResult.score,
      memeTemplateSignals: memeTemplateResult.signals,
      entropy: entropyScore,
      rawEntropy: entropy,
      imageWidth: metadata.width,
      imageHeight: metadata.height,
      imageFormat: metadata.format
    };

    const score = Math.max(0, Math.min(1.0,
      loFiResult.score * WEIGHTS.loFiScore +
      characterResult.score * WEIGHTS.characterPresence +
      anthropomorphism.score * WEIGHTS.anthropomorphism +
      colorResult.score * WEIGHTS.colorAnalysis +
      complexity * WEIGHTS.complexity +
      memeTemplateResult.score * WEIGHTS.memeTemplate +
      entropyScore * WEIGHTS.entropy
    ));

    return { score, features };
  } catch (err) {
    console.error('[visual] Error:', err.message);
    return { score: 0.5, features: { error: err.message } };
  }
}

export default scoreVisual;
