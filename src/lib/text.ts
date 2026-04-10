// --- Stop words (French + English + domain-generic) ---

export const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "its", "this", "that", "are",
  "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
  "did", "will", "would", "could", "should", "may", "might", "can", "shall",
  "not", "no", "nor", "so", "if", "then", "than", "too", "very", "just",
  "about", "above", "after", "again", "all", "also", "am", "any", "as",
  "because", "before", "between", "both", "each", "few", "here", "how",
  "into", "more", "most", "other", "out", "over", "own", "same", "some",
  "such", "them", "there", "these", "they", "through", "under", "up",
  "what", "when", "where", "which", "while", "who", "whom", "why",
  "de", "la", "le", "les", "un", "une", "des", "du", "et", "en", "est",
  "que", "qui", "dans", "pour", "sur", "par", "avec", "ce", "se", "ne",
  "pas", "son", "sa", "ses", "nous", "vous", "ils", "elle", "elles",
  // Domain-generic words that cause false matches
  "content", "post", "team", "company", "business", "work", "new", "way",
  "make", "use", "get", "like", "one", "time", "now", "well", "good",
  "need", "want", "know", "take", "see", "come", "think", "look", "go",
  "day", "people", "thing", "part", "first", "last", "long", "great",
  "help", "still", "even", "back", "much", "many", "only", "right", "old"
]);

// Short domain-specific tokens that must survive stopword + length filters.
// All entries are lowercase; matching is case-insensitive by construction
// since tokenization lowercases before checking.
export const DOMAIN_ALLOWLIST = new Set([
  "dsn", "hcr", "ccn", "dpae", "dads", "ij", "rh", "gp", "due"
]);

// --- Accent normalization ---

export function normalizeAccents(text: string): string {
  return text
    .replace(/œ/g, "oe").replace(/Œ/g, "OE")
    .replace(/æ/g, "ae").replace(/Æ/g, "AE")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// --- Narrative pillar canonicalization ---

/**
 * Canonicalize a narrative pillar string so equivalent variants collapse to
 * one key. Used at write-time so reporting and grouping are not split by
 * accent drift, stray whitespace, or separator inconsistency.
 *
 * Transform:
 *  - strip accents, lowercase
 *  - drop punctuation except `/` and `-` (compound pillars like
 *    "expertise metier / fiabilite")
 *  - normalize `/` to `" / "` and hyphens to `"-"`
 *  - collapse runs of whitespace
 *  - trim
 *
 * Returns `undefined` for null, undefined, or empty-after-normalization
 * inputs so callers can drop the field entirely if the input was empty.
 *
 * Examples:
 *   "Expertise métier / fiabilité" → "expertise metier / fiabilite"
 *   "expertise metier/fiabilite"    → "expertise metier / fiabilite"
 *   "  EXPERTISE  MÉTIER "          → "expertise metier"
 */
export function normalizeNarrativePillar(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return undefined;
  const stripped = normalizeAccents(value)
    .toLowerCase()
    // Keep ASCII letters, digits, whitespace, slash, and hyphen.
    .replace(/[^a-z0-9\s/\-]/g, " ")
    // Normalize `/` so it's always surrounded by single spaces.
    .replace(/\s*\/\s*/g, " / ")
    // Collapse whitespace and trim.
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length === 0) return undefined;
  return stripped;
}

// --- Tokenization ---

/**
 * V1 tokenizer: naive split on whitespace, lowercase only.
 * Preserved for DEDUP_SCORING_VERSION=v1 rollback.
 */
export function tokenizeV1(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * V2 tokenizer: accent-aware, strips punctuation, preserves French characters.
 * Normalizes diacritics so "régularisations" → "regularisations".
 */
export function tokenizeV2(text: string): string[] {
  return normalizeAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// --- Stopword removal ---

export function removeStopWords(tokens: string[]): string[] {
  return tokens.filter((t) =>
    DOMAIN_ALLOWLIST.has(t) || (!STOP_WORDS.has(t) && t.length > 2)
  );
}

// --- Similarity ---

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- Bigrams ---

export function extractBigrams(tokens: string[]): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}

// --- Angle sharpness assessment ---

export interface AngleSharpnessResult {
  isSharp: boolean;
  checks: {
    notGenericSubject: boolean;
    notQuestionOnly: boolean;
    hasStake: boolean;
    notTopicLabel: boolean;
    notTitleDuplicate: boolean;
  };
  failedChecks: string[];
}

const GENERIC_SUBJECT_STARTERS = [
  "the importance of", "the role of", "the impact of", "the benefits of",
  "an overview of", "a look at", "the state of", "trends in",
  "exploring ", "understanding ",
  // French equivalents
  "l'importance de", "le role de", "le rôle de", "les tendances",
  "un apercu", "un aperçu", "comprendre ", "decouvrir ", "découvrir "
];

const QUESTION_STARTERS = ["how ", "what ", "why ", "when ", "where ", "who "];

// Tension/contrast markers — checked on raw string, NOT tokenized (STOP_WORDS strips many of these)
// French stems use \w* suffix to match conjugations (risque→risquent, bloqu→bloquent, etc.)
const TENSION_MARKER_REGEX = /\b(despite|because|yet|even though|fail\w*|risk\w*|miss\w*|wrong|block\w*|break\w*|cost\w*|force\w*|trap\w*|hide|reveal\w*|prove\w*|shift\w*|instead|actually|unlike|although|however|whereas|contradict\w*|paradox\w*|assume\w*|myth|misconception|surprising|overlooked|underestimate\w*|mais|malgre|malgré|pourtant|contrairement|risqu\w*|echec|échec|bloqu\w*|cout|coût|piege|piège|cach\w*|prouv\w*)\b/i;
// "but" needs word-boundary care to avoid matching inside words like "contribution"
const BUT_REGEX = /\bbut\b/i;
const CONTRACTION_REGEX = /n't\b/i;

// Consequence language — alternative pass path for angles without explicit contrast
// Stems (eliminat, enabl, etc.) use \w* suffix to match conjugations (eliminates, enabling, etc.)
const CONSEQUENCE_REGEX = /\b(eliminat\w*|enabl\w*|reduc\w*|sav\w*|prevent\w*|replac\w*|demonstrates?)\b|for the first time|finally\b|can now\b|gives?\s+.+\s+proof/i;

// Domain terms for Path C specificity check
const DOMAIN_TERMS = /\b(dsn|hcr|ccn|dpae|paie|payroll|cabinet|cabinets|bulletin|fiche|solde|regularisation|régularisation|migration|conformit|compliance|onboarding)\b/i;

export function assessAngleSharpness(angle: string, title: string): AngleSharpnessResult {
  const failedChecks: string[] = [];
  const normalized = normalizeAccents(angle).toLowerCase().trim();

  // 1. notGenericSubject
  const notGenericSubject = !GENERIC_SUBJECT_STARTERS.some(
    (starter) => normalizeAccents(starter).toLowerCase() === starter
      ? normalized.startsWith(starter)
      : normalized.startsWith(normalizeAccents(starter).toLowerCase())
  );
  if (!notGenericSubject) failedChecks.push("generic subject framing");

  // 2. notQuestionOnly
  const startsWithQuestion = QUESTION_STARTERS.some((q) => normalized.startsWith(q));
  const endsWithQuestion = normalized.endsWith("?");
  const notQuestionOnly = !(startsWithQuestion && endsWithQuestion);
  if (!notQuestionOnly) failedChecks.push("question without a claim");

  // 3. hasStake — three alternative pass paths
  const rawLower = angle.toLowerCase();
  const pathA = TENSION_MARKER_REGEX.test(rawLower) || BUT_REGEX.test(rawLower) || CONTRACTION_REGEX.test(rawLower);
  const pathB = CONSEQUENCE_REGEX.test(rawLower);
  const angleTokens = removeStopWords(tokenizeV2(angle));
  const pathC = angleTokens.length >= 8 && (/\d+/.test(angle) || DOMAIN_TERMS.test(rawLower));
  const hasStake = pathA || pathB || pathC;
  if (!hasStake) failedChecks.push("no stake — no tension, consequence, or position marker");

  // 4. notTopicLabel — short + no stake = label
  const notTopicLabel = !(angleTokens.length <= 5 && !hasStake);
  if (!notTopicLabel) failedChecks.push("topic label — too short with no tension");

  // 5. notTitleDuplicate
  const titleTokens = removeStopWords(tokenizeV2(title));
  const angleSet = new Set(angleTokens);
  const titleSet = new Set(titleTokens);
  const similarity = jaccardSimilarity(angleSet, titleSet);
  const notTitleDuplicate = similarity <= 0.8;
  if (!notTitleDuplicate) failedChecks.push("angle duplicates source title");

  const isSharp = notGenericSubject && notQuestionOnly && hasStake && notTopicLabel && notTitleDuplicate;

  return {
    isSharp,
    checks: { notGenericSubject, notQuestionOnly, hasStake, notTopicLabel, notTitleDuplicate },
    failedChecks
  };
}

// --- Overlap detection ---

export function hasMeaningfulOverlap(oppTokens: string[], itemTokens: string[]): boolean {
  const oppClean = removeStopWords(oppTokens);
  const itemClean = removeStopWords(itemTokens);

  const oppBigrams = extractBigrams(oppClean);
  const itemBigrams = extractBigrams(itemClean);
  for (const bigram of oppBigrams) {
    if (itemBigrams.has(bigram)) return true;
  }

  const oppSet = new Set(oppClean);
  for (const token of itemClean) {
    if (oppSet.has(token)) return true;
  }

  return false;
}
