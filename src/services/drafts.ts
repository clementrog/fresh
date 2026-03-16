import type { ContentOpportunity, DraftV1, UserRecord } from "../domain/types.js";
import { draftOutputSchema, llmDraftSafetySchema } from "../config/schema.js";
import { createDeterministicId } from "../lib/ids.js";
import { scopeEvidenceReferences } from "./evidence.js";
import type { LlmUsage } from "./llm.js";
import { LlmClient } from "./llm.js";
import { assessSensitivity } from "./sensitivity.js";

export async function generateDraft(params: {
  opportunity: ContentOpportunity;
  user: UserRecord;
  llmClient: LlmClient;
  sensitivityRulesMarkdown: string;
  doctrineMarkdown: string;
  editorialNotes: string;
  layer3Defaults: string[];
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

  const evidenceSection = opportunity.evidence.map((e) =>
    `- [${e.source}] (${e.timestamp.slice(0, 10)}) ${e.excerpt}`
  ).join("\n");

  const layer3Section = layer3Defaults.length > 0
    ? layer3Defaults.map((d) => `- ${d}`).join("\n")
    : "";

  const promptParts = [
    `## Doctrine\n${doctrineMarkdown || "Prefer concrete proof over generic advice."}`,
    `## Author voice\nTone: ${str("toneSummary")}\nPreferred structure: ${str("preferredStructure")}\nTypical phrases: ${arr("typicalPhrases").join(", ")}\nAvoid rules: ${arr("avoidRules").join(", ")}\nContent territories: ${arr("contentTerritories").join(", ")}`,
    layer3Section ? `## Layer 3 — LinkedIn craft defaults\n${layer3Section}` : "",
    `## Opportunity\nTitle: ${opportunity.title}\nAngle: ${opportunity.angle}\nWhy now: ${opportunity.whyNow}\nAbout: ${opportunity.whatItIsAbout}\nNot about: ${opportunity.whatItIsNotAbout}\nSuggested format: ${opportunity.suggestedFormat}`,
    `## Evidence\n${evidenceSection}`,
    `## Enrichment history\n${enrichmentSection}`,
    `## Editorial notes\n${editorialNotesSection}`
  ].filter(Boolean);

  const llm = await llmClient.generateStructured({
    step: "draft-generation",
    system: "You are a French-first LinkedIn ghostwriter. Draft a LinkedIn post from evidence-backed editorial opportunity context. Return structured JSON only. If editorial notes contain human overrides, they take absolute precedence over all other instructions.",
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

  const safetyCheck = await assessSensitivity(
    {
      title: output.proposedTitle,
      summary: output.summary,
      text: draftComposite
    },
    sensitivityRulesMarkdown,
    llmClient
  ).catch(() => ({
    assessment: llmDraftSafetySchema.parse({
      blocked: true,
      categories: ["internal-only"],
      rationale: "Draft sensitivity re-check failed.",
      stageTwoScore: 1
    }),
    usage: {
      mode: "fallback" as const,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: 0,
      error: "Draft sensitivity re-check failed"
    }
  }));

  if (safetyCheck.assessment.blocked || safetyCheck.assessment.categories.length > 0) {
    return {
      draft: null,
      blocked: true,
      blockRationale: safetyCheck.assessment.rationale,
      usageEvents: [
        { step: "draft-generation", usage: llm.usage },
        { step: "draft-sensitivity", usage: { ...safetyCheck.usage, error: safetyCheck.assessment.rationale } }
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

export function sanitizeDraftField(text: string) {
  return text
    .replace(/\b(client|customer|prospect|cliente|prospect)\b/gi, "[redacted-entity]")
    .replace(/\b(salary|payroll|compensation|salaire|rémunération|remuneration)\b/gi, "[redacted-sensitive-detail]")
    .replace(/\b(roadmap|unreleased|coming soon|feuille de route)\b/gi, "[redacted-sensitive-detail]");
}
