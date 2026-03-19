import type {
  ClaimPosture,
  ContentOpportunity,
  DraftReadinessAssessment,
  EvidenceReference,
  NormalizedSourceItem,
  ProductBackingState,
  ReadinessTier
} from "../domain/types.js";
import { buildIntelligenceEvidence } from "./intelligence.js";
import { dedupeEvidenceReferences, evidenceSignature } from "./evidence.js";

// --- Stop words ---

const STOP_WORDS = new Set([
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

// --- Source policy ---

interface SourcePolicyEntry {
  canBeOrigin: boolean;
  canBeSupport: boolean;
  minJaccardForSupport: number;
  priority: number;
}

function getSourcePolicy(item: NormalizedSourceItem): SourcePolicyEntry {
  const notionKind = typeof item.metadata?.notionKind === "string"
    ? item.metadata.notionKind : undefined;

  switch (item.source) {
    case "market-research":
    case "market-findings":
      return { canBeOrigin: true, canBeSupport: true, minJaccardForSupport: 0.10, priority: 1 };
    case "notion":
      if (notionKind === "market-insight" || notionKind === "claap-signal") {
        return { canBeOrigin: true, canBeSupport: true, minJaccardForSupport: 0.10, priority: 1 };
      }
      if (notionKind === "internal-proof") {
        return { canBeOrigin: false, canBeSupport: true, minJaccardForSupport: 0.10, priority: 1 };
      }
      return { canBeOrigin: false, canBeSupport: true, minJaccardForSupport: 0.15, priority: 2 };
    case "claap": {
      const signalKind = typeof item.metadata?.signalKind === "string"
        ? item.metadata.signalKind : undefined;
      if (signalKind === "claap-signal") {
        return { canBeOrigin: true, canBeSupport: true, minJaccardForSupport: 0.10, priority: 1 };
      }
      return { canBeOrigin: false, canBeSupport: true, minJaccardForSupport: 0.15, priority: 3 };
    }
    case "linear":
      return { canBeOrigin: false, canBeSupport: true, minJaccardForSupport: 0.20, priority: 4 };
    default:
      return { canBeOrigin: false, canBeSupport: true, minJaccardForSupport: 0.20, priority: 5 };
  }
}

// --- Provenance ---

export function deriveProvenanceType(item: NormalizedSourceItem): string {
  const notionKind = typeof item.metadata?.notionKind === "string"
    ? item.metadata.notionKind : undefined;

  switch (item.source) {
    case "market-research":
      return "market-research";
    case "market-findings":
      return "market-findings";
    case "notion":
      if (notionKind === "market-insight") return "notion:market-insight";
      if (notionKind === "claap-signal") return "notion:claap-signal";
      if (notionKind === "internal-proof") return "notion:internal-proof";
      return "notion";
    case "claap": {
      const signalKind = typeof item.metadata?.signalKind === "string"
        ? item.metadata.signalKind : undefined;
      return signalKind === "claap-signal" ? "claap:signal" : "claap";
    }
    case "linear":
      return "linear";
    default:
      return item.source;
  }
}

// --- Tokenization ---

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9àâäéèêëïîôùûüÿçœæ\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function removeStopWords(tokens: string[]): string[] {
  return tokens.filter((t) => !STOP_WORDS.has(t) && t.length > 2);
}

function extractBigrams(tokens: string[]): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function hasMeaningfulOverlap(oppTokens: string[], itemTokens: string[]): boolean {
  const oppClean = removeStopWords(oppTokens);
  const itemClean = removeStopWords(itemTokens);

  // Check bigram overlap (2-word sequence match)
  const oppBigrams = extractBigrams(oppClean);
  const itemBigrams = extractBigrams(itemClean);
  for (const bigram of oppBigrams) {
    if (itemBigrams.has(bigram)) return true;
  }

  // Check specific token overlap — at least 1 non-generic word shared
  const oppSet = new Set(oppClean);
  for (const token of itemClean) {
    if (oppSet.has(token)) return true;
  }

  return false;
}

// --- Supporting evidence search ---

export interface SupportingEvidenceResult {
  evidence: EvidenceReference[];
  sources: Array<{
    externalId: string;
    source: string;
    relevanceScore: number;
    reason: string;
  }>;
}

export function findSupportingEvidence(
  opportunity: ContentOpportunity,
  candidateItems: NormalizedSourceItem[],
  companyId: string,
  opts: { maxSupporting?: number } = {}
): SupportingEvidenceResult {
  const maxSupporting = opts.maxSupporting ?? 3;

  // Build opportunity token set
  const oppText = `${opportunity.title} ${opportunity.angle} ${opportunity.whatItIsAbout} ${opportunity.whyNow}`;
  const oppTokens = tokenize(oppText);
  const oppCleanTokens = removeStopWords(oppTokens);
  const oppTokenSet = new Set(oppCleanTokens);

  // Existing evidence signatures for dedup
  const existingSignatures = new Set(opportunity.evidence.map(evidenceSignature));

  // Score each candidate
  const scored: Array<{
    item: NormalizedSourceItem;
    score: number;
    policy: SourcePolicyEntry;
    reason: string;
  }> = [];

  for (const item of candidateItems) {
    const policy = getSourcePolicy(item);
    if (!policy.canBeSupport) continue;

    const itemText = `${item.title} ${item.summary} ${item.text.slice(0, 500)}`;
    const itemTokens = tokenize(itemText);

    // Require meaningful overlap — not just generic word sharing
    if (!hasMeaningfulOverlap(oppTokens, itemTokens)) continue;

    const itemCleanTokens = removeStopWords(itemTokens);
    const itemTokenSet = new Set(itemCleanTokens);
    const score = jaccardSimilarity(oppTokenSet, itemTokenSet);

    if (score < policy.minJaccardForSupport) continue;

    scored.push({
      item,
      score,
      policy,
      reason: `${item.source} item with ${(score * 100).toFixed(0)}% topic overlap`
    });
  }

  // Rank: higher score first, within equal scores prefer curated (lower priority number)
  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
    return a.policy.priority - b.policy.priority;
  });

  // Take top N
  const selected = scored.slice(0, maxSupporting);

  // Build evidence and dedupe
  const evidence: EvidenceReference[] = [];
  const sources: SupportingEvidenceResult["sources"] = [];

  for (const { item, score, reason } of selected) {
    const itemEvidence = buildIntelligenceEvidence(item, companyId, 1);
    const deduped = itemEvidence.filter(
      (e) => !existingSignatures.has(evidenceSignature(e))
    );
    if (deduped.length === 0) continue;

    evidence.push(...deduped);
    for (const e of deduped) {
      existingSignatures.add(evidenceSignature(e));
    }
    sources.push({
      externalId: item.externalId,
      source: item.source,
      relevanceScore: score,
      reason
    });
  }

  return { evidence, sources };
}

// --- Claim posture classification ---

export const PRODUCT_CAPABILITY_SIGNALS = [
  // FR verbs
  "permettre", "afficher", "automatiser", "calculer", "configurer", "simuler",
  "vérifier", "déclencher", "intégrer", "synchroniser", "générer",
  // FR nouns
  "fonctionnalité", "module", "interface", "tableau de bord", "outil",
  "paramétrage", "moteur", "workflow", "produit",
  // EN
  "feature", "dashboard", "enables", "automates", "calculates", "workflow", "ux"
];

export const CUSTOMER_PAIN_SIGNALS = [
  // FR
  "difficulté", "risque", "problème", "objection", "frustration", "complexité",
  "friction", "erreur", "piège", "nuire", "crainte", "inquiétude",
  // EN
  "challenge", "pain", "frustration", "friction", "risk", "difficulty"
];

export const REGULATORY_MARKET_SIGNALS = [
  // FR
  "loi", "réforme", "réglementation", "conformité", "obligation", "décret",
  "code du travail", "loi de finances", "dsn", "marché", "tendance",
  "concurrence", "étude", "benchmark", "enquête",
  // EN
  "regulation", "compliance", "market", "trend", "reform"
];

const LETTER_RE = /[a-zàâäéèêëïîôùûüÿçœæ]/;

// Signals where a specific preceding word makes the match a verb form, not a noun.
// Key: signal word, Value: prefixes that indicate verb usage (must end with space).
const SIGNAL_VERB_PREFIXES: Record<string, string[]> = {
  "produit": ["se "]  // "se produit" = occurs/happens, not "product"
};

function textContainsSignal(text: string, signals: string[]): boolean {
  const lower = text.toLowerCase();
  for (const signal of signals) {
    const sig = signal.toLowerCase();
    if (sig.includes(" ")) {
      // Multi-word: substring match is specific enough
      if (lower.includes(sig)) return true;
    } else {
      // Single-word: require word-start boundary to avoid "ux" matching "aux"
      const verbPrefixes = SIGNAL_VERB_PREFIXES[sig];
      let pos = 0;
      while (pos < lower.length) {
        const idx = lower.indexOf(sig, pos);
        if (idx === -1) break;
        const charBefore = idx > 0 ? lower[idx - 1] : "";
        if (!charBefore || !LETTER_RE.test(charBefore)) {
          // Skip known verb-form prefixes (e.g., "se produit" but not "analyse produit")
          if (verbPrefixes) {
            const prefixRegion = lower.slice(Math.max(0, idx - 10), idx);
            if (verbPrefixes.some(p => {
              if (!prefixRegion.endsWith(p)) return false;
              // "se " must itself be a standalone word — check char before it
              const prefixStart = prefixRegion.length - p.length;
              const charBeforePrefix = prefixStart > 0 ? prefixRegion[prefixStart - 1] : "";
              return !charBeforePrefix || !LETTER_RE.test(charBeforePrefix);
            })) {
              pos = idx + 1;
              continue;
            }
          }
          return true;
        }
        pos = idx + 1;
      }
    }
  }
  return false;
}

export function classifyClaimPosture(opportunity: ContentOpportunity): ClaimPosture {
  const text = `${opportunity.title} ${opportunity.angle} ${opportunity.whatItIsAbout}`;

  const hasProduct = textContainsSignal(text, PRODUCT_CAPABILITY_SIGNALS);
  const hasPain = textContainsSignal(text, CUSTOMER_PAIN_SIGNALS);
  const hasRegulatory = textContainsSignal(text, REGULATORY_MARKET_SIGNALS);

  // Priority-based classification
  if (hasProduct && (hasPain || hasRegulatory)) return "mixed";
  if (hasProduct) return "product-claim";
  if (hasPain) return "customer-pain";
  if (hasRegulatory) return "insight-only";
  // No signals → safe default
  return "insight-only";
}

// --- Product backing check ---

const LIVE_SIGNALS = [
  "en production", "déployé", "lancé", "certifié", "shipped", "deployed",
  "live", "released", "livré", "disponible", "opérationnel"
];

const IN_PROGRESS_SIGNALS = [
  "en cours", "prévu", "en développement", "planned", "building",
  "en construction", "roadmap", "à venir", "en test", "bientôt"
];

export function classifyProductBacking(
  opportunity: ContentOpportunity,
  allEvidence: EvidenceReference[],
  sourceItems: NormalizedSourceItem[]
): ProductBackingState {
  const sourceItemMap = new Map<string, NormalizedSourceItem>();
  for (const item of sourceItems) {
    sourceItemMap.set(item.sourceItemId, item);
  }

  let hasLive = false;
  let hasInProgress = false;

  for (const evidence of allEvidence) {
    // Layer 1: Evidence source type
    if (evidence.source === "linear") {
      hasInProgress = true;
      continue;
    }
    if (evidence.source === "market-research" || evidence.source === "market-findings") {
      continue; // Never product backing
    }
    if (evidence.source === "claap") {
      continue; // Not product backing by itself
    }

    // Layer 2: Source item metadata (for notion evidence)
    if (evidence.source === "notion") {
      const sourceItem = sourceItemMap.get(evidence.sourceItemId);
      if (!sourceItem) continue; // Conservative: not found → not backing
      const notionKind = typeof sourceItem.metadata?.notionKind === "string"
        ? sourceItem.metadata.notionKind : undefined;
      if (notionKind !== "internal-proof") continue;

      // Layer 3: Live vs in-progress
      const proofText = `${sourceItem.text} ${sourceItem.summary}`;
      const isLive = textContainsSignal(proofText, LIVE_SIGNALS);
      const isInProgress = textContainsSignal(proofText, IN_PROGRESS_SIGNALS);

      if (isLive) {
        hasLive = true;
      } else if (isInProgress) {
        hasInProgress = true;
      }
      // else: internal-proof but no clear signal → unbacked (do not credit)
    }
  }

  if (hasLive) return "backed-live";
  if (hasInProgress) return "backed-in-progress";
  return "unbacked";
}

// --- Draft readiness ---

const GENERIC_ANGLE_STARTERS = [
  "about", "regarding", "general", "overview", "introduction", "misc", "various"
];

export function assessDraftReadiness(
  opportunity: ContentOpportunity,
  allEvidence: EvidenceReference[],
  opts?: { sourceItems?: NormalizedSourceItem[] }
): DraftReadinessAssessment {
  const missingElements: string[] = [];

  // 1. Has clear originating source
  const hasOriginatingSource = Boolean(
    opportunity.primaryEvidence?.sourceUrl
    && opportunity.primaryEvidence.sourceUrl.length > 0
    && !opportunity.primaryEvidence.sourceUrl.startsWith("placeholder")
  );
  if (!hasOriginatingSource) {
    missingElements.push("No clear originating source URL");
  }

  // 2. Has supporting evidence beyond primary
  const hasSupportingEvidence = allEvidence.length > 1;
  if (!hasSupportingEvidence) {
    missingElements.push("No supporting evidence beyond the originating source");
  }

  // 3. Has concrete angle
  const angleTokens = removeStopWords(tokenize(opportunity.angle));
  const startsGeneric = GENERIC_ANGLE_STARTERS.some(
    (starter) => opportunity.angle.toLowerCase().trim().startsWith(starter)
  );
  const hasConcreteAngle = angleTokens.length >= 3 && !startsGeneric;
  if (!hasConcreteAngle) {
    missingElements.push("Angle is too generic or vague");
  }

  // 4. Has draftable material — at least 2 evidence items with substantive excerpts
  const substantiveExcerpts = allEvidence.filter(
    (e) => e.excerpt && e.excerpt.trim().length > 30
  );
  const hasDraftableMaterial = substantiveExcerpts.length >= 2;
  if (!hasDraftableMaterial) {
    missingElements.push("Not enough concrete material to draft from");
  }

  const status = missingElements.length === 0 ? "ready" : "needs-more-proof";

  // Claim-awareness
  const claimPosture = classifyClaimPosture(opportunity);
  const productBacking = classifyProductBacking(opportunity, allEvidence, opts?.sourceItems ?? []);

  const checks = {
    hasOriginatingSource, hasSupportingEvidence, hasConcreteAngle, hasDraftableMaterial,
    claimPosture, productBacking
  };
  const readinessTier = computeReadinessTier(checks);
  const operatorGuidance = generateOperatorGuidance(checks);

  return {
    status,
    hasOriginatingSource,
    hasSupportingEvidence,
    hasConcreteAngle,
    hasDraftableMaterial,
    missingElements,
    readinessTier,
    operatorGuidance,
    claimPosture,
    productBacking
  };
}

// --- Readiness tier ---

export function computeReadinessTier(checks: {
  hasOriginatingSource: boolean;
  hasSupportingEvidence: boolean;
  hasConcreteAngle: boolean;
  hasDraftableMaterial: boolean;
  claimPosture?: ClaimPosture;
  productBacking?: ProductBackingState;
}): ReadinessTier {
  const { hasOriginatingSource, hasSupportingEvidence, hasConcreteAngle, hasDraftableMaterial } = checks;

  if (hasOriginatingSource && hasSupportingEvidence && hasConcreteAngle && hasDraftableMaterial) {
    // Claim-aware downgrade: product-claim or mixed with unbacked/in-progress → promising
    const posture = checks.claimPosture;
    const backing = checks.productBacking;
    if (posture && backing) {
      if ((posture === "product-claim" || posture === "mixed") &&
          (backing === "unbacked" || backing === "backed-in-progress")) {
        return "promising";
      }
    }
    return "ready";
  }

  // Promising: has the fundamentals (origin + material) but missing support or angle sharpness
  if (hasOriginatingSource && hasDraftableMaterial) {
    return "promising";
  }

  return "needs-more-proof";
}

// --- Operator guidance ---

export function generateOperatorGuidance(checks: {
  hasOriginatingSource: boolean;
  hasSupportingEvidence: boolean;
  hasConcreteAngle: boolean;
  hasDraftableMaterial: boolean;
  claimPosture?: ClaimPosture;
  productBacking?: ProductBackingState;
}): string[] {
  const guidance: string[] = [];

  if (!checks.hasOriginatingSource) {
    guidance.push("Source link is missing — add the URL so the draft can reference the real source");
  }
  if (!checks.hasSupportingEvidence) {
    guidance.push("Only one source backs this — find a second one (customer call, internal proof, or market data) to strengthen the draft");
  }
  if (!checks.hasConcreteAngle) {
    guidance.push("Angle is too vague to draft well — edit it to include a specific claim or contrast");
  }
  if (!checks.hasDraftableMaterial) {
    guidance.push("Not enough concrete material — add evidence with specific facts, quotes, or numbers to give the draft substance");
  }

  // Claim-aware guidance
  const posture = checks.claimPosture;
  const backing = checks.productBacking;
  if (posture && backing) {
    if (posture === "product-claim" && backing === "unbacked") {
      guidance.push("This reads like a product capability claim, but the attached evidence only supports customer pain or market context — need internal proof that this is already live in Linc");
    } else if (posture === "product-claim" && backing === "backed-in-progress") {
      guidance.push("This implies a shipped capability, but the evidence only shows work-in-progress — consider reframing as 'coming soon' or wait for launch proof");
    } else if (posture === "mixed" && backing === "unbacked") {
      guidance.push("This mixes product claims with market insights — narrow to the part backed by product proof, or reframe as customer pain / market insight");
    } else if (posture === "mixed" && backing === "backed-in-progress") {
      guidance.push("This mixes shipped capability and in-progress work — narrow the claim to what is actually live before drafting");
    }
  }

  return guidance;
}
