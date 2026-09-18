/**
 * Module 1: Linguistic & Processing Fluency
 *
 * Based on Alter & Oppenheimer (PNAS 2006): stimuli that are easy to process
 * feel more familiar, less risky, more trustworthy. Pronounceable tickers
 * outperformed by $85-112 on IPO day 1.
 *
 * Target: <5ms execution
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load data files once at startup
const bigramFreqs = JSON.parse(readFileSync(join(__dirname, 'data/bigram-frequencies.json'), 'utf8'));
const memeKeywords = JSON.parse(readFileSync(join(__dirname, 'data/meme-keywords.json'), 'utf8'));
const englishWords = JSON.parse(readFileSync(join(__dirname, 'data/english-10k.json'), 'utf8'));

// Build flat keyword set and category map for fast lookup
const allKeywords = new Map();
const categoryKeywords = {};
for (const [category, words] of Object.entries(memeKeywords)) {
  if (category === '_description' || category === 'combo_bonuses') continue;
  categoryKeywords[category] = new Set(words.map(w => w.toLowerCase()));
  for (const word of words) {
    allKeywords.set(word.toLowerCase(), category);
  }
}

const englishWordSet = new Set(englishWords.words.map(w => w.toLowerCase()));

// Plosive initial consonants
const PLOSIVES = new Set(['p', 'b', 't', 'd', 'k', 'g']);

// Front vs back vowels for bouba/kiki effect
const FRONT_VOWELS = new Set(['i', 'e']);
const BACK_VOWELS = new Set(['o', 'u', 'a']);

// Irony / self-aware phrases for emoji and description analysis
const RELEVANT_EMOJIS = {
  dog: ['🐕', '🐶', '🐾', '🦮', '🐩'],
  cat: ['🐱', '🐈', '😺', '🐾'],
  frog: ['🐸', '🐊'],
  moon: ['🌙', '🌕', '🌑', '🚀'],
  fire: ['🔥', '💥', '⚡'],
  money: ['💰', '💎', '🤑', '💵', '💸'],
  rocket: ['🚀', '🛸'],
  animal: ['🐕', '🐶', '🐱', '🐸', '🐧', '🦊', '🐻', '🐼', '🦁', '🐯']
};

const WEIGHTS = {
  pronounceability: 0.20,
  memeKeyword: 0.20,
  conceptCompression: 0.15,
  creativeSpelling: 0.10,
  syllables: 0.10,
  tickerLength: 0.10,
  plosiveInitial: 0.05,
  vowelHarmony: 0.03,
  emojiCongruence: 0.04,
  repetition: 0.02,
  unused: 0.01 // buffer
};

/**
 * Calculate pronounceability using bigram transition frequencies
 */
function scorePronounceability(text) {
  const clean = text.toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length < 2) return 0.5;

  let total = 0;
  let count = 0;
  for (let i = 0; i < clean.length - 1; i++) {
    const bigram = clean.substring(i, i + 2);
    const freq = bigramFreqs[bigram];
    if (freq !== undefined) {
      total += freq;
      count++;
    } else {
      total += 0.02; // unknown bigram = very low
      count++;
    }
  }

  return count > 0 ? Math.min(1.0, total / count) : 0.3;
}

/**
 * Count syllables using a simple heuristic
 */
function countSyllables(text) {
  const clean = text.toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length === 0) return 1;

  // Count vowel groups
  const matches = clean.match(/[aeiouy]+/g);
  let count = matches ? matches.length : 1;

  // Adjust for silent e
  if (clean.endsWith('e') && count > 1) count--;
  // Minimum 1 syllable
  return Math.max(1, count);
}

function scoreSyllables(text) {
  const count = countSyllables(text);
  const map = { 1: 1.0, 2: 0.9, 3: 0.7, 4: 0.4 };
  return map[count] ?? 0.2;
}

/**
 * Check if first phoneme is a plosive
 */
function scorePlosiveInitial(text) {
  const first = text.toLowerCase().replace(/[^a-z]/g, '')[0];
  return PLOSIVES.has(first) ? 0.3 : 0.0;
}

/**
 * Vowel harmony - bouba/kiki effect
 * Balanced 40-60% front vowels = optimal
 */
function scoreVowelHarmony(text) {
  const clean = text.toLowerCase().replace(/[^a-z]/g, '');
  let front = 0, back = 0;

  for (const ch of clean) {
    if (FRONT_VOWELS.has(ch)) front++;
    if (BACK_VOWELS.has(ch)) back++;
  }

  const total = front + back;
  if (total === 0) return 0.5;

  const frontRatio = front / total;
  // Optimal: 40-60% front vowels
  if (frontRatio >= 0.4 && frontRatio <= 0.6) return 1.0;
  if (frontRatio >= 0.3 && frontRatio <= 0.7) return 0.7;
  return 0.4;
}

/**
 * Match against categorized meme keyword lexicon
 * Returns score and matched categories
 */
function scoreMemeKeywords(name, symbol) {
  const text = `${name} ${symbol}`.toLowerCase();
  const tokens = text.split(/[\s_\-./]+/);
  const matchedCategories = new Set();
  let matchCount = 0;

  for (const token of tokens) {
    // Direct match
    if (allKeywords.has(token)) {
      matchedCategories.add(allKeywords.get(token));
      matchCount++;
      continue;
    }
    // Substring match for compound names
    for (const [keyword, category] of allKeywords) {
      if (keyword.length >= 3 && token.includes(keyword)) {
        matchedCategories.add(category);
        matchCount++;
        break;
      }
    }
  }

  let score = Math.min(1.0, matchCount * 0.3);

  // Combo bonuses from research
  const cats = [...matchedCategories];
  if (cats.includes('animals') && cats.includes('crypto_culture')) score = Math.min(1.0, score + 0.3);
  if (cats.includes('animals') && cats.includes('absurdist')) score = Math.min(1.0, score + 0.25);
  if (cats.includes('internet_culture') && cats.includes('crypto_culture')) score = Math.min(1.0, score + 0.2);
  if (cats.includes('japanese') && cats.includes('animals')) score = Math.min(1.0, score + 0.25);

  return { score, categories: cats, matchCount };
}

/**
 * Creative spelling - Levenshtein distance from nearest English word
 * 0 = real word (good). 1-2 = intentional misspelling (peak). 3+ = gibberish.
 */
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization for speed
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

function scoreCreativeSpelling(text) {
  const clean = text.toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length < 2) return 0.3;

  // Check if it IS a real word
  if (englishWordSet.has(clean)) return 0.7; // real word = good

  // Find minimum Levenshtein distance to any English word
  let minDist = Infinity;
  for (const word of englishWords.words) {
    // Only compare words of similar length for speed
    if (Math.abs(word.length - clean.length) > 3) continue;
    const dist = levenshteinDistance(clean, word.toLowerCase());
    minDist = Math.min(minDist, dist);
    if (dist <= 1) break; // early exit - close enough
  }

  // 0 = exact match (handled above)
  // 1-2 = HODL/BUIDL pattern = peak
  if (minDist <= 2) return 1.0;
  // 3 = moderate creativity
  if (minDist === 3) return 0.5;
  // 4+ = gibberish
  return 0.2;
}

/**
 * Ticker length scoring
 */
function scoreTickerLength(symbol) {
  const len = (symbol || '').replace(/[^a-zA-Z0-9]/g, '').length;
  const map = { 3: 0.9, 4: 1.0, 5: 0.8, 6: 0.5 };
  return map[len] ?? (len < 3 ? 0.6 : 0.2);
}

/**
 * Emoji congruence in metadata
 */
function scoreEmojiCongruence(name, description = '') {
  const text = `${name} ${description}`;
  const emojis = text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu) || [];

  if (emojis.length === 0) return 0.1;
  if (emojis.length > 5) return -0.2; // spam

  let score = Math.min(0.3, emojis.length * 0.1);

  // Check congruence
  const nameLower = name.toLowerCase();
  for (const [concept, conceptEmojis] of Object.entries(RELEVANT_EMOJIS)) {
    if (nameLower.includes(concept)) {
      for (const emoji of emojis) {
        if (conceptEmojis.includes(emoji)) {
          score = 0.5;
          break;
        }
      }
    }
  }

  return score;
}

/**
 * Repetition score - alliteration, rhyme, reduplication
 */
function scoreRepetition(text) {
  const clean = text.toLowerCase().replace(/[^a-z\s]/g, '');
  const words = clean.split(/\s+/).filter(w => w.length > 0);
  let score = 0;

  // Alliteration - same first letter
  if (words.length >= 2) {
    const firstLetters = words.map(w => w[0]);
    const alliterationGroups = {};
    for (const l of firstLetters) {
      alliterationGroups[l] = (alliterationGroups[l] || 0) + 1;
    }
    for (const count of Object.values(alliterationGroups)) {
      if (count >= 2) score += 0.15;
    }
  }

  // Reduplication (booboo, mama, bonkbonk)
  if (clean.length >= 4) {
    const half = Math.floor(clean.length / 2);
    if (clean.substring(0, half) === clean.substring(half, half * 2)) {
      score += 0.15;
    }
  }

  return Math.min(0.3, score);
}

/**
 * Concept compression - can it be expressed in ≤5 words?
 * Memes that compress to a single mental image propagate fastest.
 */
function scoreConceptCompression(name, description = '') {
  const nameWords = name.split(/[\s_\-]+/).filter(w => w.length > 0);

  // Name itself is the concept - shorter = more compressed
  if (nameWords.length <= 2) return 1.0;
  if (nameWords.length <= 3) return 0.8;
  if (nameWords.length <= 5) return 0.5;

  // Long compound names - check if they evoke a single image
  // "HarryPotterObamaSonic10Inu" = absurd mashup (rescued by absurdity module)
  if (nameWords.length > 5) return 0.3;

  return 0.5;
}

/**
 * Main scoring function
 */
export async function scoreLinguistic(input) {
  try {
    const { name = '', symbol = '', description = '' } = input;
    if (!name && !symbol) return { score: 0.5, features: {} };

    const pronounceability = scorePronounceability(name || symbol);
    const syllables = scoreSyllables(name || symbol);
    const plosiveInitial = scorePlosiveInitial(name || symbol);
    const vowelHarmony = scoreVowelHarmony(name || symbol);
    const { score: memeKeyword, categories, matchCount } = scoreMemeKeywords(name, symbol);
    const creativeSpelling = scoreCreativeSpelling(name || symbol);
    const tickerLength = scoreTickerLength(symbol);
    const emojiCongruence = scoreEmojiCongruence(name, description);
    const repetition = scoreRepetition(name);
    const conceptCompression = scoreConceptCompression(name, description);

    const features = {
      pronounceability,
      syllableCount: countSyllables(name || symbol),
      syllableScore: syllables,
      plosiveInitial,
      vowelHarmony,
      memeKeywordScore: memeKeyword,
      memeKeywordCategories: categories,
      memeKeywordMatchCount: matchCount,
      creativeSpelling,
      tickerLength,
      emojiCongruence,
      repetition,
      conceptCompression
    };

    // Weighted composite
    const score = Math.max(0, Math.min(1.0,
      pronounceability * WEIGHTS.pronounceability +
      memeKeyword * WEIGHTS.memeKeyword +
      conceptCompression * WEIGHTS.conceptCompression +
      creativeSpelling * WEIGHTS.creativeSpelling +
      syllables * WEIGHTS.syllables +
      tickerLength * WEIGHTS.tickerLength +
      plosiveInitial * WEIGHTS.plosiveInitial +
      vowelHarmony * WEIGHTS.vowelHarmony +
      emojiCongruence * WEIGHTS.emojiCongruence +
      repetition * WEIGHTS.repetition
    ));

    return { score, features };
  } catch (err) {
    console.error('[linguistic] Error:', err.message);
    return { score: 0.5, features: { error: err.message } };
  }
}

export default scoreLinguistic;
