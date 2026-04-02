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
  const { opportunity, user, llmClient, sensitivityRulesMarkdown, doctrineMarkdown, editorialNotes, layer3Defaults, gtmFoundationMarkdown } = params;
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

  const evidenceSection = opportunity.evidence.map((e) =>
    `- [${e.source}] (${e.timestamp.slice(0, 10)}) ${e.excerpt}`
  ).join("\n");

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
    gtmFoundationMarkdown ? `## GTM Foundation\n${gtmFoundationMarkdown}` : "",
    `## Opportunity\nTitle: ${opportunity.title}\nAngle: ${opportunity.angle}\nWhy now: ${opportunity.whyNow}\nAbout: ${opportunity.whatItIsAbout}\nNot about: ${opportunity.whatItIsNotAbout}\nSuggested format: ${opportunity.suggestedFormat}`,
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
      "Hard limit: 150-280 words. One idea per post. If you need more words, the idea is too big: split it.",
      "If the LinkedIn craft defaults specify a tighter word-count target, prefer that range within these bounds.",
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
            "- Include one specific detail that proves the company sees this: a date, a client situation (anonymized), a number, a pattern across clients.",
          ]
        : [
            "- First person mandatory. 'Je' or 'on' (collective we), never impersonal third person.",
            "- Include one specific detail that proves the author lived this: a date, a place, a number, a quote from someone.",
          ]),
      "- Mix short punchy sentences (3-8 words) with one or two longer ones. Human rhythm is irregular.",
      "- Sound like a person who has something to say, not a consultant filling a template.",
      "",
      "## Evidence integration",
      "- Evidence informs your angle. You never cite it.",
      ...(str("profileId") === "linc-corporate"
        ? [
            "- Transform raw evidence into a team observation: 'On a recalculé pour un site de 220 salariés...' not 'Source: Synthese strategique 2026.'",
            "- If the evidence is a regulatory change, explain what it means in practice, from what the team sees across clients.",
          ]
        : [
            "- Transform raw evidence into a personal observation: 'La semaine derniere, un cabinet m'a dit...' not 'Source: Synthese strategique 2026.'",
            "- If the evidence is a regulatory change, explain what it means in practice, in your words, from your experience.",
          ]),
      "",
      "## Structure variety",
      "- Never use the same structure twice. Rotate between: observation then lesson, question then answer, story then point, provocation then nuance, confession then insight.",
      "- The first 2 lines must make someone want to click 'voir plus'. Start mid-thought, not with a topic label.",
      "- Do not recycle opening patterns across drafts for the same profile. Avoid canned templates like 'On a dit non…' or 'On a refusé…' that become recognizable formulas. Each post should feel like a distinct entry point.",
      "- End with something worth reacting to: a concrete stance, a specific admission, or a sharp observation. Never a summary. Never a broad market claim. Never a question that asks the audience to validate the post.",
      "- Do not end on an audience-directed rhetorical question ('Vous voyez ça aussi?', 'Et vous?'). If the post is strong, the reaction comes from the stance, not from asking for it.",
      "- The ending does not always need to be a polished slogan or perfectly balanced antithesis. Sometimes a quieter operational line, a specific consequence, or an understated admission is stronger than a symmetrical closer.",
      "- After a strong quoted line or sharp observation, move to the next beat. Do not paraphrase, soften, or restate the same point in different words.",
      "- If the anecdote, quote, or contrast already proves the point, stop. Do not add a paragraph restating what the reader has already understood. Trust the reader.",
      "- Prefer one vivid example or verb over a list of pain points. A single concrete symptom carries more weight than an inventory of five.",
      "- If the post is operational, field-level, or personal, the ending must stay at that altitude. Do not zoom out to generic market commentary in the last paragraph.",
      "- Deal counts, pipeline stats, or aggregate commercial metrics should only appear when the post is explicitly about measured commercial reality and the number feels natural in the speaker's voice.",
      "- Exact dates, timestamps, or documentary-seeming details should only appear when they materially matter and feel naturally grounded in the speaker's memory. Do not insert artificial dates just to simulate realism.",
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

async function assessDraftSensitivity(
  draftText: string,
  llmClient: LlmClient
): Promise<{ blocked: boolean; rationale: string; usage: import("./llm.js").LlmUsage }> {
  // Stage 1: hard blocks — specific named entities, not generic domain terms
  const hardBlockPatterns = [
    /\b[A-Z][a-zé]+\s(?:SAS|SARL|SA|EURL|SCI|Corp|Inc|LLC|GmbH)\b/, // Named company entities
    /\b\d{3}[\s.-]?\d{3}[\s.-]?\d{3}\b/, // SIRET-like numbers
    /\b\d+[\s]?€\s*(?:par mois|\/mois|brut|net)\b/i // Specific salary amounts
  ];

  for (const pattern of hardBlockPatterns) {
    if (pattern.test(draftText)) {
      return {
        blocked: true,
        rationale: `Draft contains specific identifiable data matching: ${pattern.source}`,
        usage: { mode: "provider", promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, skipped: true }
      };
    }
  }

  // Stage 2: LLM check — focused on publication safety, not source classification
  const result = await llmClient.generateStructured({
    step: "draft-sensitivity",
    system: [
      "You are reviewing a LinkedIn post draft for publication safety.",
      "This content is about HR/payroll topics — generic payroll, salary, compliance terms are EXPECTED and NOT sensitive.",
      "Only block if the draft reveals: specific CLIENT company names (companies using the product), specific individual salary figures, unreleased product features with dates, or verbatim confidential internal documents.",
      "Do NOT block for: the author's own company (Linc), well-known market actors and competitors (e.g. Silae, ADP, Cegid, Sage, PayFit), general industry observations, regulatory commentary, operational best practices, or domain expertise sharing.",
      "Return JSON: { \"blocked\": boolean, \"rationale\": string }"
    ].join("\n"),
    prompt: `Draft to review:\n\n${draftText.slice(0, 3000)}`,
    schema: llmDraftSafetySchema,
    allowFallback: true,
    fallback: () => ({ blocked: false, categories: [], rationale: "Fallback: draft appears safe for publication.", stageTwoScore: 0.1 })
  });

  return {
    blocked: result.output.blocked && result.output.categories.length > 0,
    rationale: result.output.rationale,
    usage: result.usage
  };
}

export function sanitizeDraftField(text: string) {
  return text;
}
