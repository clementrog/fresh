import type { NormalizedSourceItem, SensitivityAssessment, SensitivityCategory } from "../domain/types.js";
import { SENSITIVITY_CATEGORIES } from "../domain/types.js";
import { sensitivityOutputSchema } from "../config/schema.js";
import { LlmClient } from "./llm.js";

interface SensitivityRuleSet {
  rules: Array<{
    name: string;
    category: SensitivityCategory;
    terms: string[];
  }>;
}

export function parseSensitivityRules(markdown: string): SensitivityRuleSet {
  const rules: SensitivityRuleSet["rules"] = [];
  let currentCategory: SensitivityCategory | null = null;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      const slug = line.slice(3).trim().toLowerCase();
      const category = SENSITIVITY_CATEGORIES.find((item) => item === slug);
      currentCategory = category ?? null;
      continue;
    }

    if (currentCategory && line.startsWith("- ")) {
      const terms = line
        .slice(2)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      rules.push({
        name: `${currentCategory}:${terms[0] ?? "rule"}`,
        category: currentCategory,
        terms
      });
    }
  }

  return { rules };
}

export async function assessSensitivity(
  item: Pick<NormalizedSourceItem, "text" | "summary" | "title"> & { metadata?: Record<string, unknown> },
  rulesMarkdown: string,
  llmClient: LlmClient
): Promise<{ assessment: SensitivityAssessment; usage: import("./llm.js").LlmUsage }> {
  const rules = parseSensitivityRules(rulesMarkdown);
  const haystack = `${item.title}\n${item.summary}\n${item.text}`.toLowerCase();
  const matchedRules = rules.rules.filter((rule) => rule.terms.some((term) => haystack.includes(term.toLowerCase())));
  const stageOneCategories = [...new Set(matchedRules.map((rule) => rule.category))];
  const notionKind = typeof item.metadata?.notionKind === "string" ? item.metadata.notionKind : "";

  const stageTwoFallback = () => {
    const heuristicCategories: SensitivityCategory[] = [];
    if (/\bclient\b|\bcustomer\b|\bprospect\b|\bclient\b|\bprospect\b/i.test(haystack)) heuristicCategories.push("client-identifiable");
    if (/\bsalary\b|\bpayroll\b|\bcompensation\b|\bsalaire\b|\brémunération\b|\bremuneration\b/i.test(haystack)) heuristicCategories.push("payroll-sensitive");
    if (/\broadmap\b|\bunreleased\b|\bcoming soon\b|\bfeuille de route\b/i.test(haystack)) heuristicCategories.push("roadmap-sensitive");
    if (/\bconfidential\b|\binternal only\b|\binterne uniquement\b/i.test(haystack)) heuristicCategories.push("internal-only");
    if (/\brecruit\b|\bhiring\b|\bcandidate\b|\brecrutement\b|\bcandidat\b/i.test(haystack)) heuristicCategories.push("recruiting-sensitive");
    if (/\brevenue\b|\bbudget\b|\bmargin\b|\bmarge\b|\bca\b/i.test(haystack)) heuristicCategories.push("financial-sensitive");
    const unique = [...new Set(heuristicCategories)];
    return {
      blocked: unique.length > 0,
      categories: unique,
      rationale: unique.length > 0 ? "Heuristic sensitive terms detected." : "No high-risk patterns detected.",
      stageTwoScore: unique.length > 0 ? 0.9 : 0.1
    };
  };

  const claapSignalStageTwoFallback = () => {
    const heuristicCategories: SensitivityCategory[] = [];
    if (/\b(client|customer|prospect)\b.{0,40}\b(sas|sarl|corp|inc|llc|nommé|nomme|named|specific)\b/i.test(haystack)) {
      heuristicCategories.push("client-identifiable");
    }
    if (/\bsalary\b|\bcompensation\b|\bbonus\b|\bequity\b|\bsalaire\b|\brémunération\b|\bremuneration\b/i.test(haystack)) {
      heuristicCategories.push("payroll-sensitive");
    }
    if (/\broadmap\b|\bunreleased\b|\bcoming soon\b|\bquick win\b|\bnot yet shipped\b|\bpas encore livré\b|\bfuture capability\b|\bprérequis technique\b/i.test(haystack)) {
      heuristicCategories.push("roadmap-sensitive");
    }
    if (/\bconfidential\b|\binternal only\b|\binterne uniquement\b|\bdiscussion interne\b/i.test(haystack)) {
      heuristicCategories.push("internal-only");
    }
    if (/\bcandidate\b|\binterview\b|\bhiring\b|\brecrutement\b|\bcandidat\b/i.test(haystack)) {
      heuristicCategories.push("recruiting-sensitive");
    }
    if (/\brevenue\b|\bbudget\b|\bmargin\b|\bmarge\b|\bca\b/i.test(haystack)) {
      heuristicCategories.push("financial-sensitive");
    }
    const unique = [...new Set(heuristicCategories)];
    return {
      blocked: unique.length > 0,
      categories: unique,
      rationale: unique.length > 0 ? "Deterministic Claap signal screening found explicit sensitive patterns." : "No explicit sensitive patterns detected in curated Claap signal.",
      stageTwoScore: unique.length > 0 ? 0.72 : 0.08
    };
  };

  // Use Claap-specific stricter heuristics for curated claap signals (both legacy Notion-ingested and native)
  const claapSignalKind = typeof item.metadata?.signalKind === "string" ? item.metadata.signalKind : undefined;
  const claapRouting = typeof item.metadata?.routingDecision === "string" ? item.metadata.routingDecision : undefined;
  const isClaapSignal = notionKind === "claap-signal"
    || claapSignalKind === "claap-signal"
    || claapRouting === "create_opportunity";
  if (isClaapSignal) {
    const stageTwo = claapSignalStageTwoFallback();
    const categories = [...new Set([...stageOneCategories, ...stageTwo.categories])];
    const blocked = matchedRules.length > 0 || stageTwo.blocked;

    return {
      assessment: {
        blocked,
        categories,
        rationale: blocked
          ? `Blocked by ${matchedRules.length > 0 ? "stage 1" : ""}${matchedRules.length > 0 && stageTwo.blocked ? " and " : ""}${stageTwo.blocked ? "stage 2" : ""}. ${stageTwo.rationale}`.trim()
          : stageTwo.rationale,
        stageOneMatchedRules: matchedRules.map((rule) => rule.name),
        stageTwoScore: stageTwo.stageTwoScore
      },
      usage: {
        mode: "provider",
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        skipped: true
      }
    };
  }

  let llm: { output: typeof sensitivityOutputSchema._type; usage: import("./llm.js").LlmUsage };
  try {
    llm = await llmClient.generateStructured({
      step: "sensitivity-classification",
      system:
        "Classify sensitive internal editorial source content into high-level risk categories. Return structured JSON only.",
      prompt: `Title: ${item.title}\nSummary: ${item.summary}\nText: ${item.text.slice(0, 2000)}`,
      schema: sensitivityOutputSchema,
      allowFallback: false,
      fallback: stageTwoFallback
    });
  } catch (error) {
    const fallbackOutput = stageTwoFallback();
    llm = {
      output: fallbackOutput.blocked
        ? fallbackOutput
        : {
            blocked: true,
            categories: ["internal-only"],
            rationale: "Sensitivity model unavailable; escalated to Sensitive review.",
            stageTwoScore: 1
          },
      usage: {
        mode: "fallback",
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        error: error instanceof Error ? error.message : "Unknown sensitivity failure"
      }
    };
  }

  const stageTwo = llm.output;
  const categories = [...new Set([...stageOneCategories, ...stageTwo.categories])];
  const blocked = matchedRules.length > 0 || stageTwo.blocked;

  return {
    assessment: {
      blocked,
      categories,
      rationale: blocked
        ? `Blocked by ${matchedRules.length > 0 ? "stage 1" : ""}${matchedRules.length > 0 && stageTwo.blocked ? " and " : ""}${stageTwo.blocked ? "stage 2" : ""}. ${stageTwo.rationale}`.trim()
        : stageTwo.rationale,
      stageOneMatchedRules: matchedRules.map((rule) => rule.name),
      stageTwoScore: stageTwo.stageTwoScore
    },
    usage: llm.usage
  };
}
