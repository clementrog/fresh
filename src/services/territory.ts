import type { EditorialSignal, TerritoryAssignment } from "../domain/types.js";
import { territoryOutputSchema } from "../config/schema.js";
import { LlmClient } from "./llm.js";

const TERRITORY_RULES = [
  { profileId: "baptiste", territory: "vision / mobilisation", keywords: ["vision", "belief", "mobilise", "movement", "change", "vision", "mobilisation", "élan", "transformation", "priorité", "priorite", "marché", "market"] },
  { profileId: "thomas", territory: "expertise métier / fiabilité", keywords: ["expertise", "reliable", "process", "quality", "trust", "fiabilité", "métier", "processus", "qualité", "dsn", "urssaf", "cotisation", "cotisations", "bulletin", "bulletins", "paie", "plafond", "plafonds", "taux", "régularisation", "regularisation"] },
  { profileId: "virginie", territory: "produit / feedback", keywords: ["product", "feedback", "ux", "feature", "iteration", "produit", "retour", "usage", "fonctionnalité", "interface", "rassurer", "parcours", "impactés", "impactes"] },
  { profileId: "quentin", territory: "terrain commercial / adoption", keywords: ["sales", "adoption", "deal", "objection", "buyer", "commercial", "adoption", "objection", "terrain", "acheteur", "preuve", "prospect", "demo"] },
  { profileId: "linc-corporate", territory: "corporate proof / amplification", keywords: ["company", "team", "proof", "launch", "case study", "preuve", "équipe", "linc", "cas client"] }
] as const;

export async function resolveTerritory(
  signal: EditorialSignal,
  llmClient: LlmClient
): Promise<{ assignment: TerritoryAssignment; usage: import("./llm.js").LlmUsage }> {
  if (signal.probableOwnerProfile) {
    const direct = directAssignment(signal.probableOwnerProfile, signal);
    if (direct) {
      return {
        assignment: direct,
        usage: {
          mode: "provider",
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0,
          skipped: true
        }
      };
    }
  }

  const llm = await llmClient.generateStructured({
    step: "territory-assignment",
    system: "Assign the signal to the most legitimate editorial territory or mark it as needs routing. Return structured JSON only.",
    prompt: `Signal title: ${signal.title}\nSummary: ${signal.summary}\nAngle: ${signal.suggestedAngle}`,
    schema: territoryOutputSchema,
    allowFallback: true,
    fallback: () => heuristicTerritory(signal)
  });

  return {
    assignment: llm.output,
    usage: llm.usage
  };
}

function directAssignment(profileId: NonNullable<EditorialSignal["probableOwnerProfile"]>, signal: EditorialSignal) {
  const rule = TERRITORY_RULES.find((entry) => entry.profileId === profileId);
  if (!rule) {
    return null;
  }

  return {
    profileId,
    territory: rule.territory,
    confidence: Math.max(0.82, signal.confidence),
    needsRouting: false,
    rationale: `Matched directly from the source-specific profile hint for ${rule.territory}.`
  } satisfies TerritoryAssignment;
}

function heuristicTerritory(signal: EditorialSignal) {
  const text = `${signal.title}\n${signal.summary}\n${signal.suggestedAngle}`.toLowerCase();
  const match = TERRITORY_RULES.find((rule) => rule.keywords.some((keyword) => text.includes(keyword)));
  if (!match) {
    return {
      territory: "Needs routing",
      confidence: 0.4,
      needsRouting: true,
      rationale: "No strong territory match found in the current evidence."
    };
  }

  return {
    profileId: match.profileId,
    territory: match.territory,
    confidence: 0.8,
    needsRouting: false,
    rationale: `Matched on keywords associated with ${match.territory}.`
  };
}
