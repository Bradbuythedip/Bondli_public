/**
 * Module 6: Absurdity, Camp & Narrative
 *
 * FARTCOIN ($2.5B), GOATSEUS MAXIMUS ($1.3B), HarryPotterObamaSonic10Inu.
 * Bimodal distribution: tokens succeed at maximum absurdity OR maximum cultural
 * resonance, never in the moderately professional middle.
 *
 * Counter-signaling theory: low effort signals authenticity.
 * Sontag (1964): Camp = love of artifice, exaggeration.
 *
 * Target: <5ms execution
 */

// Absurdity detection keywords
const JUVENILE_HUMOR = new Set([
  'fart', 'poop', 'butt', 'chungus', 'bonk', 'boop', 'honk', 'derp',
  'burp', 'snot', 'booger', 'weiner', 'peepee', 'doodoo', 'turd',
  'fartcoin', 'poopoo', 'buttcoin', 'thicc', 'chonk', 'moist', 'chunky'
]);

const SELF_REFERENTIAL_CRYPTO = new Set([
  'rug', 'rugpull', 'jeet', 'ponzi', 'scam', 'exit', 'dump', 'rekt',
  'degen', 'ngmi', 'copium', 'hopium', 'cope', 'seethe', 'mald',
  'bagholder', 'paperhands', 'diamondhands', 'apecoin', 'rugcoin',
  'shitcoin', 'memecoin', 'vaporware', 'nothing', 'useless', 'worthless'
]);

const IRONY_PATTERNS = [
  /trust me bro/i,
  /probably nothing/i,
  /not a rug/i,
  /do not buy/i,
  /don'?t buy/i,
  /literally just/i,
  /wen (lambo|moon|rich)/i,
  /for research purposes/i,
  /this is (fine|good|ok)/i,
  /not financial advice/i,
  /dyor/i,
  /no (roadmap|utility|promises|team|whitepaper)/i,
  /zero utility/i,
  /completely useless/i,
  /just a (dog|cat|frog|meme|joke)/i,
  /we are so back/i,
  /it'?s (so )?over/i,
  /have fun staying poor/i,
  /few understand/i,
  /gm/i,
  /ser /i
];

const UNDERDOG_PATTERNS = [
  /made (with|by|using) (chatgpt|ai|gpt|claude)/i,
  /\$\d{1,3} budget/i,
  /first (token|coin|meme) ever/i,
  /community owned/i,
  /fair launch/i,
  /no (team|vc|presale|insider)/i,
  /by the people/i,
  /one of us/i,
  /started as a joke/i,
  /deployed by (accident|mistake)/i,
  /intern/i,
  /dev (is )?(drunk|sleeping|gone)/i
];

const NARRATIVE_INDICATORS = {
  lore: [/lore/i, /chapter/i, /episode/i, /saga/i, /tale/i, /legend/i, /mythology/i, /origin story/i],
  arg: [/hidden/i, /puzzle/i, /mystery/i, /clue/i, /secret/i, /decode/i, /cipher/i, /find/i],
  transmedia: [/telegram/i, /discord/i, /tiktok/i, /youtube/i],
  multiplatform: [/twitter/i, /reddit/i, /4chan/i]
};

const PROFESSIONAL_SIGNALS = [
  'roadmap', 'whitepaper', 'tokenomics', 'team', 'partnership',
  'ecosystem', 'utility', 'governance', 'staking rewards',
  'deflationary', 'audit', 'doxxed', 'kyc'
];

const WEIGHTS = {
  nameAbsurdity: 0.15,
  antiMarketing: 0.15,
  campAesthetic: 0.15,
  narrativeDepth: 0.15,
  bimodalPosition: 0.15,
  irony: 0.10,
  underdog: 0.10,
  metaCommentary: 0.05
};

/**
 * Detect distinct semantic categories in a name
 */
function countSemanticCategories(name) {
  const categories = {
    person: /(?:trump|obama|biden|elon|musk|putin|harry|potter|sonic|mario|jesus|god|satan|devil|santa|gandalf)/i,
    animal: /(?:dog|cat|frog|inu|shiba|pepe|doge|bird|fish|shark|whale|bear|bull|monkey|ape|penguin|duck|owl|fox|wolf|lion|tiger)/i,
    object: /(?:hat|coin|rocket|moon|star|diamond|sword|gun|car|house|tree|flower|rock|stone|ring|crown|crystal)/i,
    concept: /(?:love|death|war|peace|freedom|chaos|order|time|space|dream|hope|fear|rage|doom|fate|luck)/i,
    crypto: /(?:hodl|wagmi|degen|chad|sigma|alpha|based|cope|mald|seethe|rekt|lambo|tendies)/i,
    food: /(?:pizza|burger|taco|sushi|ramen|cake|cookie|cheese|banana|potato|nugget|tendies)/i,
    body: /(?:fart|butt|poop|brain|eye|hand|foot|head|finger|nose|mouth)/i,
    number: /\d+/
  };

  let count = 0;
  for (const pattern of Object.values(categories)) {
    if (pattern.test(name)) count++;
  }
  return count;
}

/**
 * Name absurdity scoring
 */
function scoreNameAbsurdity(name) {
  const lower = name.toLowerCase();
  const words = name.split(/[\s_\-]+|(?=[A-Z])/);
  let score = 0;

  // Word count bonus
  if (words.length >= 5) score += 0.5;
  else if (words.length >= 3) score += 0.3;

  // Unrelated concept mashup
  const categories = countSemanticCategories(name);
  if (categories >= 3) score += 0.3;
  else if (categories >= 2) score += 0.15;

  // Juvenile humor
  for (const keyword of JUVENILE_HUMOR) {
    if (lower.includes(keyword)) {
      score += 0.3;
      break;
    }
  }

  // Self-referential crypto humor
  for (const keyword of SELF_REFERENTIAL_CRYPTO) {
    if (lower.includes(keyword)) {
      score += 0.2;
      break;
    }
  }

  // ALL CAPS bonus (shouting = memetic energy)
  if (name === name.toUpperCase() && name.length > 2) score += 0.1;

  return Math.min(1.0, score);
}

/**
 * Anti-marketing score - INVERTED: absence of professionalism = POSITIVE
 */
function scoreAntiMarketing(input) {
  const { website, whitepaper, team, roadmap, description = '' } = input;
  let score = 0;

  if (!website) score += 0.15;
  if (!whitepaper) score += 0.15;
  if (!team) score += 0.15;
  if (!roadmap) score += 0.15;

  // Minimal description
  if (description.length < 50) score += 0.2;
  if (description.length === 0) score += 0.1;

  // Explicit anti-roadmap language
  const antiPatterns = [
    /no (roadmap|utility|promises)/i,
    /zero utility/i,
    /just a (meme|joke|token)/i,
    /no (team|vc|insider)/i,
    /community (only|driven|first)/i
  ];
  for (const pattern of antiPatterns) {
    if (pattern.test(description)) {
      score += 0.2;
      break;
    }
  }

  // Penalize professional signals in description
  const descLower = description.toLowerCase();
  for (const signal of PROFESSIONAL_SIGNALS) {
    if (descLower.includes(signal)) {
      score -= 0.1;
    }
  }

  return Math.max(0, Math.min(1.0, score));
}

/**
 * Irony cue detection
 */
function scoreIronyCues(name, description = '') {
  const text = `${name} ${description}`;
  let matches = 0;

  for (const pattern of IRONY_PATTERNS) {
    if (pattern.test(text)) matches++;
  }

  if (matches === 0) return 0.0;
  if (matches === 1) return 0.4;
  if (matches === 2) return 0.7;
  return 1.0;
}

/**
 * Camp aesthetic - composite of visual lo-fi × name absurdity × irony
 */
function scoreCampAesthetic(nameAbsurdity, irony, visualLoFi = 0.5) {
  // Camp = exaggeration + artifice + irony
  return Math.min(1.0, (nameAbsurdity * 0.4 + irony * 0.3 + visualLoFi * 0.3));
}

/**
 * Underdog narrative detection
 */
function scoreUnderdogNarrative(name, description = '') {
  const text = `${name} ${description}`;
  let matches = 0;

  for (const pattern of UNDERDOG_PATTERNS) {
    if (pattern.test(text)) matches++;
  }

  if (matches === 0) return 0.1;
  if (matches === 1) return 0.5;
  if (matches === 2) return 0.8;
  return 1.0;
}

/**
 * Narrative depth - lore, ARG, transmedia elements
 */
function scoreNarrativeDepth(input) {
  const { description = '', socialContent = '', telegram = false, discord = false } = input;
  const text = `${description} ${socialContent}`;
  let score = 0.1; // baseline: no lore

  let loreSignals = 0;
  for (const pattern of NARRATIVE_INDICATORS.lore) {
    if (pattern.test(text)) loreSignals++;
  }
  if (loreSignals > 0) score = Math.max(score, 0.4);

  // ARG / mystery elements
  let argSignals = 0;
  for (const pattern of NARRATIVE_INDICATORS.arg) {
    if (pattern.test(text)) argSignals++;
  }
  if (argSignals >= 2) score = Math.max(score, 1.0);
  else if (argSignals > 0) score = Math.max(score, 0.7);

  // Multi-platform presence = transmedia
  let platforms = 0;
  for (const patterns of [NARRATIVE_INDICATORS.transmedia, NARRATIVE_INDICATORS.multiplatform]) {
    for (const pattern of patterns) {
      if (pattern.test(text)) platforms++;
    }
  }
  if (telegram) platforms++;
  if (discord) platforms++;
  if (platforms >= 3) score = Math.max(score, 0.7);

  return Math.min(1.0, score);
}

/**
 * Meta-commentary - token satirizes memecoin culture
 */
function scoreMetaCommentary(name, description = '') {
  const text = `${name} ${description}`.toLowerCase();
  let score = 0;

  // Self-referential crypto naming
  for (const keyword of SELF_REFERENTIAL_CRYPTO) {
    if (text.includes(keyword)) {
      score += 0.15;
    }
  }

  // Explicit meta-commentary patterns
  const metaPatterns = [
    /ponzi/i, /pyramid/i, /exit scam/i, /rug/i,
    /this is a scam/i, /you will lose/i, /casino/i,
    /gambling/i, /degenerate/i, /greater fool/i
  ];
  for (const pattern of metaPatterns) {
    if (pattern.test(text)) score += 0.1;
  }

  return Math.min(0.5, score);
}

/**
 * Bimodal position - how far from the "death zone" middle
 * Tokens succeed at extremes, not in the middle.
 */
function scoreBimodalPosition(absurdityScore, otherModuleScores = {}) {
  const otherScores = Object.values(otherModuleScores).filter(s => typeof s === 'number');
  if (otherScores.length === 0) return 0.5; // no data yet

  const avgOther = otherScores.reduce((a, b) => a + b, 0) / otherScores.length;

  // High quality across the board = good position
  if (avgOther > 0.75) return 1.0;

  // High absurdity + low everything else = camp/anti-establishment (also good!)
  if (absurdityScore > 0.7 && avgOther < 0.4) return 1.0;

  // The death zone: mediocre middle
  if (avgOther >= 0.4 && avgOther <= 0.6) return 0.2;

  // Leaning toward one extreme
  if (avgOther > 0.6) return 0.7;
  if (avgOther < 0.4 && absurdityScore > 0.5) return 0.6;

  return 0.3;
}

/**
 * Classify the absurdity archetype
 */
function classifyArchetype(features) {
  const { nameAbsurdity, antiMarketing, campAesthetic, irony, underdog, narrativeDepth, metaCommentary } = features;

  if (campAesthetic > 0.7) return 'camp_absurdist';
  if (metaCommentary > 0.3 && irony > 0.5) return 'meta_satirist';
  if (underdog > 0.7) return 'underdog';
  if (irony > 0.6 && antiMarketing > 0.6) return 'ironic_minimalist';
  if (narrativeDepth > 0.7) return 'lore_builder';
  return 'standard';
}

/**
 * Main scoring function
 */
export async function scoreAbsurdity(input) {
  try {
    const {
      name = '', symbol = '', description = '',
      website, whitepaper, team, roadmap,
      socialContent = '', telegram, discord,
      visualLoFi = 0.5, // from visual module if available
      otherModuleScores = {} // from orchestrator for bimodal
    } = input;

    if (!name && !symbol) return { score: 0.5, features: {} };

    const nameAbsurdity = scoreNameAbsurdity(name || symbol);
    const antiMarketing = scoreAntiMarketing({
      website, whitepaper, team, roadmap, description
    });
    const irony = scoreIronyCues(name, description);
    const campAesthetic = scoreCampAesthetic(nameAbsurdity, irony, visualLoFi);
    const underdog = scoreUnderdogNarrative(name, description);
    const narrativeDepth = scoreNarrativeDepth({
      description, socialContent, telegram: !!telegram, discord: !!discord
    });
    const metaCommentary = scoreMetaCommentary(name, description);
    const bimodalPosition = scoreBimodalPosition(
      nameAbsurdity + campAesthetic,
      otherModuleScores
    );

    const archetype = classifyArchetype({
      nameAbsurdity, antiMarketing, campAesthetic, irony, underdog, narrativeDepth, metaCommentary
    });

    const features = {
      nameAbsurdity,
      antiMarketing,
      irony,
      campAesthetic,
      underdog,
      narrativeDepth,
      metaCommentary,
      bimodalPosition,
      archetype,
      semanticCategories: countSemanticCategories(name)
    };

    const score = Math.max(0, Math.min(1.0,
      nameAbsurdity * WEIGHTS.nameAbsurdity +
      antiMarketing * WEIGHTS.antiMarketing +
      campAesthetic * WEIGHTS.campAesthetic +
      narrativeDepth * WEIGHTS.narrativeDepth +
      bimodalPosition * WEIGHTS.bimodalPosition +
      irony * WEIGHTS.irony +
      underdog * WEIGHTS.underdog +
      metaCommentary * WEIGHTS.metaCommentary
    ));

    return { score, features };
  } catch (err) {
    console.error('[absurdity] Error:', err.message);
    return { score: 0.5, features: { error: err.message } };
  }
}

export default scoreAbsurdity;
