import { llmSignalSchema } from "../config/schema.js";
import type { EditorialSignal, EvidenceReference, NormalizedSourceItem, SignalType } from "../domain/types.js";
import { createDeterministicId, hashParts } from "../lib/ids.js";
import { LlmClient } from "./llm.js";

export async function extractSignalFromItem(
  item: NormalizedSourceItem,
  evidence: EvidenceReference[],
  llmClient: LlmClient,
  doctrine?: string
): Promise<{ signal: EditorialSignal; usage: import("./llm.js").LlmUsage }> {
  const marketInsightSignal = buildMarketInsightSignal(item, evidence);
  if (marketInsightSignal) {
    return marketInsightSignal;
  }

  const llm = await llmClient.generateStructured({
    step: "signal-extraction",
    system: "Extract one editorial signal from the provided evidence-backed internal source. Return structured JSON only.",
    prompt: `Doctrine: ${doctrine ?? "Prefer concrete proof over generic advice."}\nTitle: ${item.title}\nSummary: ${item.summary}\nText: ${item.text.slice(0, 4000)}\nEvidence IDs: ${evidence.map((entry) => entry.id).join(", ")}`,
    schema: llmSignalSchema,
    allowFallback: true,
    fallback: () => heuristicSignal(item, evidence)
  });
  const parsed = llm.output;
  const sourceFingerprint = hashParts([item.source, ...[item.externalId], ...evidence.map((entry) => entry.excerptHash), parsed.type]);
  return {
    signal: {
      id: createDeterministicId("signal", [sourceFingerprint]),
      sourceFingerprint,
      title: parsed.title,
      summary: parsed.summary,
      type: parsed.type,
      freshness: parsed.freshness,
      confidence: parsed.confidence,
      probableOwnerProfile: parsed.probableOwnerProfile,
      suggestedAngle: parsed.suggestedAngle,
      status: parsed.status,
      evidence,
      sourceItemIds: [item.externalId],
      sensitivity: {
        blocked: false,
        categories: [],
        rationale: "Not assessed yet",
        stageOneMatchedRules: [],
        stageTwoScore: 0
      },
      notionPageFingerprint: sourceFingerprint
    },
    usage: llm.usage
  };
}

function buildMarketInsightSignal(item: NormalizedSourceItem, evidence: EvidenceReference[]) {
  if (item.metadata.notionKind !== "market-insight") {
    return null;
  }

  const theme = String(item.metadata.theme ?? "Market insight");
  const sourceType = String(item.metadata.sourceTypeLabel ?? "");
  const probableOwnerProfile = item.metadata.profileHint as EditorialSignal["probableOwnerProfile"] | undefined;
  const type = inferMarketInsightType(`${item.title}\n${item.summary}\n${item.text}`);
  const freshness = evidence[0]?.freshnessScore ?? 0.6;
  const confidence = sourceType ? 0.86 : 0.8;
  const suggestedAngle = [
    `Partir du theme "${theme}" et montrer ce qu'il revele dans les criteres de decision actuels.`,
    sourceType ? `Ancrer le point de vue sur une source de type ${sourceType.toLowerCase()}.` : ""
  ]
    .filter(Boolean)
    .join(" ");
  const sourceFingerprint = hashParts(["notion-market-insight", item.externalId, theme, type]);

  return {
    signal: {
      id: createDeterministicId("signal", [sourceFingerprint]),
      sourceFingerprint,
      title: item.title,
      summary: item.summary,
      type,
      freshness,
      confidence,
      probableOwnerProfile,
      suggestedAngle,
      status: "New" as const,
      evidence,
      sourceItemIds: [item.externalId],
      sensitivity: {
        blocked: false,
        categories: [],
        rationale: "Not assessed yet",
        stageOneMatchedRules: [],
        stageTwoScore: 0
      },
      notionPageFingerprint: sourceFingerprint
    },
    usage: {
      mode: "provider" as const,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: 0,
      skipped: true
    }
  };
}

function heuristicSignal(item: NormalizedSourceItem, evidence: EvidenceReference[]) {
  const lower = `${item.title}\n${item.summary}\n${item.text}`.toLowerCase();
  const type: SignalType = lower.includes("why") || lower.includes("because")
    ? "decision-rationale"
    : lower.includes("not working") || lower.includes("blocked") || lower.includes("friction")
      ? "friction"
      : lower.includes("quote") || lower.includes("\"")
        ? "quote"
        : lower.includes("market")
          ? "market-pattern"
          : "product-insight";
  const confidence = evidence.length >= 2 ? 0.82 : 0.68;
  return {
    title: item.title.slice(0, 100),
    summary: item.summary.slice(0, 200),
    type,
    freshness: evidence[0]?.freshnessScore ?? 0.5,
    confidence,
    suggestedAngle: suggestAngle(type),
    status: "New" as const,
    evidenceIds: evidence.map((entry) => entry.id)
  };
}

function suggestAngle(type: SignalType) {
  switch (type) {
    case "friction":
      return "Use the friction as proof of a concrete market problem and how the team reasons about fixing it.";
    case "market-pattern":
      return "Turn the pattern into an evidence-backed point of view on what is changing in the market.";
    case "quote":
      return "Anchor the post around a sharp line of real language and explain why it matters.";
    default:
      return "Extract the underlying lesson and connect it to a specific Linc perspective.";
  }
}

function inferMarketInsightType(text: string): SignalType {
  const lower = text.toLowerCase();
  if (/\b(objection|proof|adoption|buyer)\b/.test(lower)) {
    return "market-pattern";
  }
  if (/\b(feedback|usage|product|ux)\b/.test(lower)) {
    return "product-insight";
  }
  if (/\b(case law|regulation|reglement|dsn|pay transparency)\b/.test(lower)) {
    return "process-lesson";
  }
  return "market-pattern";
}
