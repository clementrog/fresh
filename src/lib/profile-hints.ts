import type { ProfileId } from "../domain/types.js";

export function inferClaapSignalProfileHint(params: {
  signalType: string;
  theme: string;
  title: string;
  summary: string;
  hookCandidate: string;
  whyItMatters: string;
  excerpts: string[];
  speakerContext?: string;
}): ProfileId | undefined {
  const haystack = [
    params.signalType,
    params.theme,
    params.title,
    params.summary,
    params.hookCandidate,
    params.whyItMatters,
    params.speakerContext ?? "",
    ...params.excerpts
  ]
    .join("\n")
    .toLowerCase();

  if (/\b(dsn|urssaf|cotisation|cotisations|bulletin|bulletins|paie|plafond|plafonds|taux|régularisation|regularisation)\b/.test(haystack)) {
    return "thomas";
  }

  if (/\b(ux|interface|produit|product|feedback|rassurer|impactés|impactes|parcours)\b/.test(haystack)) {
    return "virginie";
  }

  if (/\b(objection|preuve|adoption|commercial|prospect|buyer|terrain)\b/.test(haystack)) {
    return "quentin";
  }

  if (/\b(market|marché|vision|priorité|priorite|transformation|rh 2026|stratégie|strategie)\b/.test(haystack)) {
    return "baptiste";
  }

  return undefined;
}
