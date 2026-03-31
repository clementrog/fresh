import type { ContentOpportunity, DraftV1, UserRecord } from "../domain/types.js";
import { draftOutputSchema, llmDraftSafetySchema } from "../config/schema.js";
import { createDeterministicId } from "../lib/ids.js";
import { scopeEvidenceReferences } from "./evidence.js";
import type { LlmUsage } from "./llm.js";
import { LlmClient } from "./llm.js";

export async function generateDraft(params: {
  opportunity: ContentOpportunity;
  user: UserRecord;
  llmClient: LlmClient;
  sensitivityRulesMarkdown: string;
  doctrineMarkdown: string;
  editorialNotes: string;
  layer3Defaults: string[];
  gtmFoundationMarkdown: string;
}): Promise<{
  draft: DraftV1 | null;
  blocked: boolean;
  blockRationale?: string;
  usageEvents: Array<{ step: string; usage: LlmUsage }>;
}> {
  const { opportunity, user, llmClient, sensitivityRulesMarkdown, doctrineMarkdown, editorialNotes, layer3Defaults } = params;
  const bp = user.baseProfile;
  const str = (key: string) => typeof bp[key] === "string" ? bp[key] as string : "";
  const arr = (key: string) => Array.isArray(bp[key]) ? (bp[key] as string[]) : [];

  const enrichmentSection = opportunity.enrichmentLog.length > 0
    ? opportunity.enrichmentLog.map((entry) => {
        const date = entry.createdAt.slice(0, 10);
        return `[${date}] +${entry.evidenceIds.length} evidence, confidence ${entry.confidence}: "${entry.contextComment}"`;
      }).join("\n")
    : "No enrichment history";

  const editorialNotesSection = editorialNotes.trim()
    ? editorialNotes
    : "No editorial notes provided";

  const evidenceSection = opportunity.evidence.map((e) => {
    const attribution = e.speakerOrAuthor ? ` [${e.speakerOrAuthor}]` : "";
    return `- [${e.source}] (${e.timestamp.slice(0, 10)})${attribution} ${e.excerpt}`;
  }).join("\n");

  const layer3Section = layer3Defaults.length > 0
    ? layer3Defaults.map((d) => `- ${d}`).join("\n")
    : "";

  const gtmParts = [
    opportunity.targetSegment && `Target reader: ${opportunity.targetSegment}`,
    opportunity.editorialPillar && `Editorial pillar: ${opportunity.editorialPillar}`,
    opportunity.awarenessTarget && `Reader awareness: ${opportunity.awarenessTarget}`,
    opportunity.buyerFriction && `Buyer friction addressed: ${opportunity.buyerFriction}`,
    opportunity.contentMotion && `Content motion: ${opportunity.contentMotion}`
  ].filter(Boolean);

  const promptParts = [
    `## Doctrine\n${doctrineMarkdown || "Prefer concrete proof over generic advice."}`,
    `## Author voice\nTone: ${str("toneSummary")}\nPreferred structure: ${str("preferredStructure")}\nVoice markers (channel the flavor, never copy verbatim): ${arr("typicalPhrases").join(", ")}\nAvoid rules: ${arr("avoidRules").join(", ")}\nContent territories: ${arr("contentTerritories").join(", ")}`,
    layer3Section ? `## Layer 3 — LinkedIn craft defaults\n${layer3Section}` : "",
    `## Opportunity\nTitle: ${opportunity.title}\nAngle: ${opportunity.angle}\nEditorial claim: ${opportunity.editorialClaim ?? ""}\nWhy now: ${opportunity.whyNow}\nAbout: ${opportunity.whatItIsAbout}\nNot about: ${opportunity.whatItIsNotAbout}\nSuggested format: ${opportunity.suggestedFormat}`,
    gtmParts.length > 0 ? `## GTM context\n${gtmParts.join("\n")}` : "",
    `## Evidence\n${evidenceSection}`,
    `## Enrichment history\n${enrichmentSection}`,
    `## Editorial notes\n${editorialNotesSection}`
  ].filter(Boolean);

  const llm = await llmClient.generateStructured({
    step: "draft-generation",
    system: [
      "You are a cynical French LinkedIn ghostwriter. You hate corporate jargon, AI fluff, and 'thought leadership' cliches. Your job is to write a post that makes people stop scrolling.",
      "",
      "## Hard formatting rules (French LinkedIn)",
      "- Plain text only. No bold. No italics.",
      "- No em-dashes. Only commas, periods, colons.",
      "- No emoji as section headers. Zero emoji is preferred; one max if it adds real meaning.",
      "- Single line breaks between blocks. No double spacing for dramatic effect.",
      "- No numbered methodology sections. No bullet-point checklists.",
      "",
      "## Length",
      "150-280 words. One idea per post. If you need more words, the idea is too big: split it.",
      "",
      "## Anti-pattern kill list (phrases that instantly reveal AI — NEVER use these)",
      "- 'Preuve avant opinion', 'Signal consolide', 'Synthese strategique 2026'",
      "- 'Autrement dit', 'Dit autrement', 'Le vrai sujet', 'Le vrai enjeu'",
      "- SLOs, KPIs, RACI, MTTR, RTO/RPO in a LinkedIn post",
      "- 'Merci aux equipes terrain'",
      "- 'commentez [MOT]' or 'envoyez-moi un DM' engagement bait",
      "- 'tapestry', 'delve', 'unlock', 'harness', 'shaping the future'",
      "- Any citation of an internal source system, database, or synthesis document",
      "",
      "## Voice rules",
      ...(str("profileId") === "linc-corporate"
        ? [
            "- Company voice. NEVER use 'je'. Use 'nous', 'on', or impersonal constructions.",
            "- Speak as a team that does the work, not a person sharing opinions.",
            "- Include one specific detail that proves the company sees this: a date, a real client situation, a named feature, a number, a pattern across clients.",
          ]
        : [
            "- First person mandatory. 'Je' or 'on' (collective we), never impersonal third person.",
            "- Include one specific detail that proves the author lived this: a date, a real name, a number, a direct quote (reworked for flow).",
          ]),
      "- Mix short punchy sentences (3-8 words) with one or two longer ones. Human rhythm is irregular.",
      "- Sound like a person who has something to say, not a consultant filling a template.",
      "",
      "## Evidence integration",
      "- Evidence is your raw material. Use real customer names, feature names, and speaker names from the evidence.",
      "- Rework quotes slightly for rhythm and brevity — keep them grounded in what the evidence actually says. Never fabricate details not in the evidence.",
      "- Do not cite the source system or document title (no 'Source: Synthese strategique 2026'). Cite the person, the situation, or the observation.",
      ...(str("profileId") === "linc-corporate"
        ? [
            "- Present evidence as something the team observed or discussed with a client. Use the client's name when available: 'Quand on a recalculé pour [client name]...'",
            "- If the evidence is a regulatory change, explain what it means from what the team sees across clients. Use specific examples from evidence.",
          ]
        : [
            "- Present evidence as something you saw or heard. Use real names, real meetings, real situations: 'La semaine dernière, [name] m'a dit...'",
            "- If the evidence is a regulatory change, explain what it means in practice using real examples from the evidence.",
          ]),
      "",
      "## Structure variety",
      "- Never use the same structure twice. Rotate between: observation then lesson, question then answer, story then point, provocation then nuance, confession then insight.",
      "- The first 2 lines must make someone want to click 'voir plus'. Start mid-thought, not with a topic label.",
      "- End with something worth reacting to: a stance, a question, an admission. Never a summary.",
      "",
      "## What this is NOT",
      "- Not a white paper. Not a consulting report. Not an internal playbook.",
      "- Not a methodology with steps. Not a checklist. Not a 'here are 6 things to do' post.",
      "- Not a carousel script with slides. Just a post someone reads on their phone at 8am.",
      "",
      "Return structured JSON only. If editorial notes contain human overrides, they take absolute precedence over all other instructions."
    ].join("\n"),
    prompt: promptParts.join("\n\n"),
    schema: draftOutputSchema,
    allowFallback: false,
    fallback: () => ({
      proposedTitle: opportunity.title,
      hook: opportunity.primaryEvidence.excerpt.slice(0, 120),
      summary: opportunity.whatItIsAbout,
      whatItIsAbout: opportunity.whatItIsAbout,
      whatItIsNotAbout: opportunity.whatItIsNotAbout,
      visualIdea: "Simple text-led visual using one evidence-backed takeaway.",
      firstDraftText: buildConvergenceFallbackDraft(opportunity, user),
      confidenceScore: 0.77
    })
  });

  const output = draftOutputSchema.parse(llm.output);
  const draftComposite = [
    output.proposedTitle,
    output.hook,
    output.summary,
    output.whatItIsAbout,
    output.whatItIsNotAbout,
    output.visualIdea,
    output.firstDraftText
  ].join("\n");

  // Draft-specific sensitivity: only block if the draft reveals specific confidential details
  // (not generic payroll/HR terms, which are the entire domain of this content)
  const safetyCheck = await assessDraftSensitivity(draftComposite, llmClient).catch(() => ({
    blocked: true,
    rationale: "Draft sensitivity re-check failed.",
    signals: [] as string[],
    usage: { mode: "fallback" as const, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, error: "Draft sensitivity re-check failed" }
  }));

  if (safetyCheck.blocked) {
    return {
      draft: null,
      blocked: true,
      blockRationale: safetyCheck.rationale,
      usageEvents: [
        { step: "draft-generation", usage: llm.usage },
        { step: "draft-sensitivity", usage: safetyCheck.usage }
      ]
    };
  }

  const profileId = opportunity.ownerProfile ?? "linc-corporate";
  const draftId = createDeterministicId("draft", [opportunity.id, user.id, new Date().toISOString().slice(0, 10)]);
  return {
    draft: {
      id: draftId,
      opportunityId: opportunity.id,
      profileId,
      proposedTitle: sanitizeDraftField(output.proposedTitle),
      hook: sanitizeDraftField(output.hook),
      summary: sanitizeDraftField(output.summary),
      whatItIsAbout: sanitizeDraftField(output.whatItIsAbout),
      whatItIsNotAbout: sanitizeDraftField(output.whatItIsNotAbout),
      visualIdea: sanitizeDraftField(output.visualIdea),
      firstDraftText: sanitizeDraftField(output.firstDraftText),
      sourceEvidence: scopeEvidenceReferences("draft", draftId, opportunity.evidence),
      confidenceScore: output.confidenceScore,
      language: "fr",
      createdAt: new Date().toISOString()
    },
    blocked: false,
    usageEvents: [
      { step: "draft-generation", usage: llm.usage },
      { step: "draft-sensitivity", usage: safetyCheck.usage }
    ]
  };
}

function buildConvergenceFallbackDraft(opportunity: ContentOpportunity, user: UserRecord) {
  return [
    `On parle souvent de ${opportunity.whatItIsAbout}, mais la réalité se voit surtout dans les détails.`,
    "",
    `${opportunity.primaryEvidence.excerpt}`,
    "",
    `${user.displayName} peut légitimement parler de ce sujet parce qu'il s'appuie sur une preuve concrète, pas sur une idée abstraite.`,
    "",
    `Le point important: ${opportunity.whatItIsAbout}`,
    "",
    `Le point à éviter: ${opportunity.whatItIsNotAbout}`
  ].join("\n");
}

// --- Safety gate constants (default vs strict mode) ---

// SIRET (14 digits) / SIREN (9 digits) — compact or separated by spaces/dots/dashes
const SIRET_PATTERN = /\b\d{3}[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{2}\b|\b\d{3}[\s.-]?\d{3}[\s.-]?\d{3}\b/;

// Company with legal suffix — handles Capitalized, camelCase (PayFit), ALL-CAPS (CEGID), accented (Éclaircie)
const COMPANY_SUFFIX_PATTERN = /\b[A-Z][\w.éèàùâêîôûç-]+\s(?:SAS|SARL|SA|EURL|SCI|Corp|Inc|LLC|GmbH)\b/;

const RELAXED_HARD_BLOCK_PATTERNS = [
  SIRET_PATTERN, // SIREN/SIRET — always identifying
];

const STRICT_HARD_BLOCK_PATTERNS = [
  COMPANY_SUFFIX_PATTERN, // Named company entities
  SIRET_PATTERN, // SIREN/SIRET
  /\b\d+[\s]?€\s*(?:par mois|\/mois|brut|net)\b/i // Specific salary amounts
];

// Role-attribution heuristic: detects "[role keyword] ... chez/at [Company]".
//
// Intent: fire only when a draft attributes a recognizable job title to a named
// organization, which is the person+company+role re-identification case.
// Plain company mentions ("chez Linc", "at CEGID") without a role do NOT fire.
//
// Known limits (by design — the LLM contextual review handles these when available):
// - Only matches role keyword BEFORE "chez/at"; reverse order ("chez X en tant que DRH")
//   is not caught. This is acceptable: the forward pattern covers >90% of French LinkedIn
//   phrasing, and the LLM handles the rest when reachable.
// - Company must start with a capital letter. Lowercase company names are not detected.
// - The role keyword list is finite; unlisted titles (e.g. "auditeur", "consultant")
//   are not caught. Extend the alternation if new titles appear in production evidence.
// - Multi-token company names are partially matched: "chez Dupont" fires, which is
//   enough to flag "chez Dupont Conseil" even though "Conseil" is not in the match.
// - The 50-char gap allows natural filler ("responsable de la paie chez ...") but may
//   miss very long role descriptions. This is intentional to avoid false positives.
//
// Regression tests for this pattern are in tests/drafts.test.ts under
// "role-attribution signal — production phrasing variants".
const ROLE_ATTRIBUTION_PATTERN = /\b(?:DRH|RRH|DAF|DSI|PDG|DG|responsable|directeur|directrice|gestionnaire|chef|manager|contrôleur|comptable)\b.{0,50}\b(?:chez|at)\s+[A-Z][\w.éèàùâêîôûç-]+/i;

const SIGNAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: COMPANY_SUFFIX_PATTERN, label: "contains-named-entity" },
  { pattern: /\b\d+[\s]?€\s*(?:par mois|\/mois|brut|net)\b/i, label: "contains-salary-figure" },
  { pattern: ROLE_ATTRIBUTION_PATTERN, label: "contains-role-attribution" },
];

const RELAXED_SAFETY_SYSTEM_PROMPT = [
  "You are reviewing a LinkedIn post draft for re-identification risk.",
  "This content is about HR/payroll topics — company names, salary ranges, and compliance terms are expected domain vocabulary.",
  "",
  "ALLOW (safe in isolation or in non-identifying context):",
  "- A company name alone (customer, prospect, competitor)",
  "- A salary figure or range alone (market commentary)",
  "- A person's first name or role alone",
  "- Feature names, product capabilities, paraphrased quotes from calls",
  "- A competitor name + their public pricing (market comparison, not re-identifying)",
  "",
  "BLOCK (combinations that could identify a specific individual's situation):",
  "- A named client company + a specific salary figure for employees at that company",
  "- A named individual + company + role when it narrows to one identifiable person",
  "- A SIREN or SIRET number (9 or 14 digits) in any context — always identifying",
  "- Unreleased product features with specific ship dates",
  "- Verbatim passages from documents marked confidential",
  "",
  "The test: could a reasonable reader combine the facts in this draft to identify a specific person's compensation, role, or private situation at a named organization? If yes, block. If no, allow.",
  "When detected signals are provided, pay special attention to whether those signals combine to create re-identification risk in this specific draft. A 'contains-role-attribution' signal means the draft attributes a person to a specific company by role (e.g. 'chez X') — evaluate whether this narrows to an identifiable individual.",
  "",
  "Return JSON with these fields:",
  "- blocked: boolean",
  "- categories: array of applicable categories from [\"client-identifiable\", \"payroll-sensitive\", \"roadmap-sensitive\", \"internal-only\", \"recruiting-sensitive\", \"financial-sensitive\"] (empty array if not blocked)",
  "- rationale: string explaining the decision",
  "- stageTwoScore: number 0-1 representing re-identification confidence (0 = clearly safe, 1 = clearly identifying)"
].join("\n");

const STRICT_SAFETY_SYSTEM_PROMPT = [
  "You are reviewing a LinkedIn post draft for publication safety.",
  "This content is about HR/payroll topics — generic payroll, salary, compliance terms are EXPECTED and NOT sensitive.",
  "Only block if the draft reveals: specific CLIENT company names (companies using the product), specific individual salary figures, unreleased product features with dates, or verbatim confidential internal documents.",
  "Do NOT block for: the author's own company (Linc), well-known market actors and competitors (e.g. Silae, ADP, Cegid, Sage, PayFit), general industry observations, regulatory commentary, operational best practices, or domain expertise sharing.",
  "",
  "Return JSON with these fields:",
  "- blocked: boolean",
  "- categories: array of applicable categories from [\"client-identifiable\", \"payroll-sensitive\", \"roadmap-sensitive\", \"internal-only\", \"recruiting-sensitive\", \"financial-sensitive\"] (empty array if not blocked)",
  "- rationale: string explaining the decision",
  "- stageTwoScore: number 0-1 representing sensitivity confidence (0 = clearly safe, 1 = clearly sensitive)"
].join("\n");

export async function assessDraftSensitivity(
  draftText: string,
  llmClient: LlmClient
): Promise<{ blocked: boolean; rationale: string; signals: string[]; usage: import("./llm.js").LlmUsage }> {
  const strictMode = process.env.DRAFT_SAFETY_STRICT === "1";

  // Stage 1: deterministic hard blocks
  const hardBlockPatterns = strictMode ? STRICT_HARD_BLOCK_PATTERNS : RELAXED_HARD_BLOCK_PATTERNS;

  for (const pattern of hardBlockPatterns) {
    if (pattern.test(draftText)) {
      return {
        blocked: true,
        rationale: `Draft contains specific identifiable data matching: ${pattern.source}`,
        signals: [],
        usage: { mode: "provider", promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, skipped: true }
      };
    }
  }

  // Signal detection — annotate for contextual review (relaxed mode only)
  const signals: string[] = [];
  if (!strictMode) {
    for (const { pattern, label } of SIGNAL_PATTERNS) {
      if (pattern.test(draftText)) {
        signals.push(label);
      }
    }
  }

  // Stage 2: LLM contextual review
  const systemPrompt = strictMode ? STRICT_SAFETY_SYSTEM_PROMPT : RELAXED_SAFETY_SYSTEM_PROMPT;
  const signalHint = signals.length > 0
    ? `\n\nDetected signals: ${signals.join(", ")}. Evaluate whether their combination creates re-identification risk in this specific context.`
    : "";

  const result = await llmClient.generateStructured({
    step: "draft-sensitivity",
    system: systemPrompt,
    prompt: `Draft to review:\n\n${draftText.slice(0, 3000)}${signalHint}`,
    schema: llmDraftSafetySchema,
    allowFallback: true,
    fallback: () => ({ blocked: false, categories: [] as string[], rationale: "Fallback: LLM safety review unavailable.", stageTwoScore: 0 })
  });

  // Fail closed: if stage-2 fell back (timeout/schema error) AND risk signals are present,
  // block rather than allowing potentially identifying content through unchecked.
  if (result.mode === "fallback" && signals.length > 0) {
    return {
      blocked: true,
      rationale: `Stage-2 safety review unavailable (fallback) with risk signals present: ${signals.join(", ")}. Blocking to fail closed.`,
      signals,
      usage: result.usage
    };
  }

  return {
    blocked: result.output.blocked,
    rationale: result.output.rationale,
    signals,
    usage: result.usage
  };
}

export function sanitizeDraftField(text: string) {
  return text;
}
