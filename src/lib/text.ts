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
