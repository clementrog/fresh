/**
 * Validate GPT-5.4 nano quality on all nano-routed steps.
 *
 * Sends representative inputs with production-equivalent prompts to gpt-5.4-nano,
 * checks schema compliance, output plausibility, and latency.
 *
 * Usage: OPENAI_API_KEY=sk-... tsx scripts/validate-nano-quality.ts
 */

import { z } from "zod";
import {
  linearEnrichmentPolicySchema,
  githubEnrichmentPolicySchema,
  sensitivityOutputSchema,
  claapPublishabilityReviewSchema,
} from "../src/config/schema.js";
import { LlmClient } from "../src/services/llm.js";
import type { AppEnv } from "../src/config/env.js";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

const env: AppEnv = {
  DATABASE_URL: "",
  NOTION_TOKEN: "",
  NOTION_PARENT_PAGE_ID: "",
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY: "",
  TAVILY_API_KEY: "",
  CLAAP_API_KEY: "",
  LINEAR_API_KEY: "",
  DEFAULT_TIMEZONE: "Europe/Paris",
  DEFAULT_COMPANY_SLUG: "default",
  DEFAULT_COMPANY_NAME: "Default Company",
  INTELLIGENCE_LLM_PROVIDER: "openai" as const,
  INTELLIGENCE_LLM_MODEL: "gpt-5.4",
  DRAFT_LLM_PROVIDER: "openai" as const,
  DRAFT_LLM_MODEL: "gpt-5.4",
  LLM_MODEL: "gpt-5.4-mini",
  NANO_LLM_PROVIDER: "openai" as const,
  NANO_LLM_MODEL: "gpt-5.4-nano",
  LLM_TIMEOUT_MS: 30_000,
  HTTP_PORT: 3000,
  LOG_LEVEL: "info",
} as AppEnv;

const client = new LlmClient(env);

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

interface TestCase {
  step: string;
  label: string;
  system: string;
  prompt: string;
  schema: z.ZodSchema<unknown>;
  expect: (output: unknown) => string | null; // null = pass, string = failure reason
}

const cases: TestCase[] = [
  // ---- 1. linear-enrichment-policy: obvious ignore (internal refactor) ----
  {
    step: "linear-enrichment-policy",
    label: "Linear — internal refactor → ignore",
    system: `You are an editorial policy evaluator for a content pipeline. Classify Linear issues for enrichment eligibility.

Classification rules:
- editorial-lead: Shipped feature with standalone editorial potential (convention support, module launch, major product announcement). Must have enough substance for a 500+ word article.
- enrich-worthy: Customer-visible shipped capability, too narrow for standalone article.
- ignore: Internal noise — refactors, tech debt, CI/CD, dependency bumps, test improvements.
- manual-review-needed: Ambiguous, roadmap-sensitive, pre-shipping, or promise-like.

customerVisibility: shipped | in-progress | internal-only | ambiguous
sensitivityLevel: safe | roadmap-sensitive | pre-shipping | promise-like

When unsure, choose manual-review-needed. Return JSON matching the schema.`,
    prompt: `## Linear item to classify
Title: Refactor auth middleware to use new session store
Summary: Migrate auth from cookie-based to token-based sessions (internal)
Text: This ticket covers the migration of our internal auth middleware. No user-facing changes. Cleanup of legacy session handling code.
Item type: issue
State: completed
Team: Platform
Priority: low
Labels: tech-debt, internal`,
    schema: linearEnrichmentPolicySchema,
    expect: (o: unknown) => {
      const out = o as z.infer<typeof linearEnrichmentPolicySchema>;
      if (out.classification !== "ignore") return `expected "ignore", got "${out.classification}"`;
      if (out.customerVisibility !== "internal-only") return `expected visibility "internal-only", got "${out.customerVisibility}"`;
      return null;
    },
  },

  // ---- 2. linear-enrichment-policy: editorial-lead (shipped feature) ----
  {
    step: "linear-enrichment-policy",
    label: "Linear — shipped product launch → editorial-lead",
    system: `You are an editorial policy evaluator for a content pipeline. Classify Linear issues for enrichment eligibility.

Classification rules:
- editorial-lead: Shipped feature with standalone editorial potential (convention support, module launch, major product announcement). Must have enough substance for a 500+ word article.
- enrich-worthy: Customer-visible shipped capability, too narrow for standalone article.
- ignore: Internal noise — refactors, tech debt, CI/CD, dependency bumps, test improvements.
- manual-review-needed: Ambiguous, roadmap-sensitive, pre-shipping, or promise-like.

customerVisibility: shipped | in-progress | internal-only | ambiguous
sensitivityLevel: safe | roadmap-sensitive | pre-shipping | promise-like

When unsure, choose manual-review-needed. Return JSON matching the schema.`,
    prompt: `## Linear item to classify
Title: 🎉 Nouveauté produit: Convention HCR entièrement supportée
Summary: Full support for HCR collective agreement — all salary structures, bonuses, and specific calculation rules now handled automatically
Text: La convention HCR (Hôtels, Cafés, Restaurants) est désormais entièrement supportée dans Linc. Cela inclut: les grilles de salaires spécifiques par niveau et échelon, les primes conventionnelles (prime de 13ème mois, prime d'ancienneté), les majorations heures supplémentaires selon les règles HCR, et la gestion automatique des avantages en nature repas. Plus de 2000 cabinets gèrent des clients HCR — cette mise à jour élimine le paramétrage manuel.
Item type: project-update
State: completed
Team: Product
Priority: urgent
Labels: shipped, convention, 2026-Q1
Project: Convention Support
Completed at: 2026-03-15`,
    schema: linearEnrichmentPolicySchema,
    expect: (o: unknown) => {
      const out = o as z.infer<typeof linearEnrichmentPolicySchema>;
      if (out.classification !== "editorial-lead") return `expected "editorial-lead", got "${out.classification}"`;
      if (out.customerVisibility !== "shipped") return `expected visibility "shipped", got "${out.customerVisibility}"`;
      if (out.sensitivityLevel !== "safe") return `expected sensitivity "safe", got "${out.sensitivityLevel}"`;
      return null;
    },
  },

  // ---- 3. github-enrichment-policy: internal-only (dep bump) ----
  {
    step: "github-enrichment-policy",
    label: "GitHub — dependency bump → internal-only",
    system: `You are an editorial policy evaluator. Classify GitHub items (PRs, issues, releases) for enrichment eligibility.

Classification rules:
- shipped-feature: Major user-facing capability shipped to production, standalone editorial potential.
- customer-fix: Merged PR resolving a customer-facing problem, too narrow for standalone article.
- proof-point: Concrete evidence a feature works. Not editorial alone, good supporting evidence.
- internal-only: Refactors, CI/CD, dependency bumps, code cleanup. No editorial value.
- manual-review: Ambiguous or pre-release items needing human judgment.

customerVisibility: shipped | in-progress | internal-only | ambiguous
sensitivityLevel: safe | roadmap-sensitive | pre-shipping

When unsure, choose manual-review. Return JSON matching the schema.`,
    prompt: `## GitHub item to classify
Title: chore: bump eslint from 8.57 to 9.0
Summary: Upgrade ESLint to v9 with new flat config
Text: Routine dependency upgrade. Migrates .eslintrc to flat config format. No functional changes.
Item type: pull_request
Repo: linc-backend
Labels: dependencies, chore
Author: dependabot
Additions: 45
Deletions: 38`,
    schema: githubEnrichmentPolicySchema,
    expect: (o: unknown) => {
      const out = o as z.infer<typeof githubEnrichmentPolicySchema>;
      if (out.classification !== "internal-only") return `expected "internal-only", got "${out.classification}"`;
      return null;
    },
  },

  // ---- 4. sensitivity-classification: client-identifiable content ----
  {
    step: "sensitivity-classification",
    label: "Sensitivity — client name in text → blocked",
    system: `Classify sensitive internal editorial source content into high-level risk categories. Return structured JSON only.

Categories: client-identifiable, payroll-sensitive, roadmap-sensitive, internal-only, recruiting-sensitive, financial-sensitive.

Block if content contains identifiable client information, specific salary figures, or other sensitive data that should not be published.`,
    prompt: `Title: Cabinet Dupont migration success story
Summary: How Cabinet Dupont SARL migrated 450 employees to our platform
Text: Cabinet Dupont SARL, based in Lyon, successfully migrated their 450 employees from Silae to Linc in just 3 weeks. Their lead accountant Marie Lefebvre said "the transition was seamless." They now process payroll for 12 client companies including Boulangerie Martin and SCI Les Tilleuls.`,
    schema: sensitivityOutputSchema,
    expect: (o: unknown) => {
      const out = o as z.infer<typeof sensitivityOutputSchema>;
      if (!out.blocked) return `expected blocked=true, got false (client names present)`;
      if (!out.categories.includes("client-identifiable")) return `expected "client-identifiable" in categories, got ${JSON.stringify(out.categories)}`;
      return null;
    },
  },

  // ---- 5. sensitivity-classification: safe generic content ----
  {
    step: "sensitivity-classification",
    label: "Sensitivity — generic payroll advice → safe",
    system: `Classify sensitive internal editorial source content into high-level risk categories. Return structured JSON only.

Categories: client-identifiable, payroll-sensitive, roadmap-sensitive, internal-only, recruiting-sensitive, financial-sensitive.

Block if content contains identifiable client information, specific salary figures, or other sensitive data that should not be published.
Do NOT block generic industry commentary, regulatory analysis, or best practices.`,
    prompt: `Title: Les 5 erreurs DSN les plus fréquentes
Summary: Common DSN filing mistakes made by payroll operators
Text: La DSN est un exercice de précision. Voici les 5 erreurs les plus courantes que nous observons chez les gestionnaires de paie: 1) Oublier les régularisations de cotisations, 2) Mauvais code type de contrat, 3) Dates d'embauche incorrectes, 4) Absence de bloc changement, 5) Mauvaise ventilation des heures supplémentaires.`,
    schema: sensitivityOutputSchema,
    expect: (o: unknown) => {
      const out = o as z.infer<typeof sensitivityOutputSchema>;
      if (out.blocked) return `expected blocked=false (generic content), got true. Rationale: ${out.rationale}`;
      return null;
    },
  },

  // ---- 6. draft-sensitivity: safe LinkedIn post ----
  {
    step: "draft-sensitivity",
    label: "Draft safety — generic LinkedIn post → not blocked",
    system: `You are reviewing a LinkedIn post draft for publication safety.
This content is about HR/payroll topics — generic payroll, salary, compliance terms are EXPECTED and NOT sensitive.
Only block if the draft reveals: specific CLIENT company names (companies using the product), specific individual salary figures, unreleased product features with dates, or verbatim confidential internal documents.
Do NOT block for: the author's own company (Linc), well-known market actors and competitors (e.g. Silae, ADP, Cegid, Sage, PayFit), general industry observations, regulatory commentary, operational best practices, or domain expertise sharing.
Return JSON matching the schema.`,
    prompt: `Draft to review:

On a recalculé pour un site de 220 salariés: les nouvelles règles de DSN réduisent le travail administratif de 40%.

Pourquoi? Parce que la compliance n'est pas un détail — c'est la base. Quand ça marche, personne ne le remarque. Quand ça casse, c'est une catastrophe.

On a vu ça sur 150+ implementations. Les mêmes problèmes reviennent: calculs complexes, formats en mutation, validation multi-étapes.

Le point: la DSN correcte, c'est comme l'électricité. Invisible jusqu'à ce qu'elle manque.`,
    schema: sensitivityOutputSchema,
    expect: (o: unknown) => {
      const out = o as z.infer<typeof sensitivityOutputSchema>;
      if (out.blocked) return `expected blocked=false, got true. Rationale: ${out.rationale}`;
      return null;
    },
  },

  // ---- 7. draft-sensitivity: should block (client name leak) ----
  {
    step: "draft-sensitivity",
    label: "Draft safety — client name leak → blocked",
    system: `You are reviewing a LinkedIn post draft for publication safety.
This content is about HR/payroll topics — generic payroll, salary, compliance terms are EXPECTED and NOT sensitive.
Only block if the draft reveals: specific CLIENT company names (companies using the product), specific individual salary figures, unreleased product features with dates, or verbatim confidential internal documents.
Do NOT block for: the author's own company (Linc), well-known market actors and competitors (e.g. Silae, ADP, Cegid, Sage, PayFit), general industry observations, regulatory commentary, operational best practices, or domain expertise sharing.
Return JSON matching the schema.`,
    prompt: `Draft to review:

Notre client Cabinet Moreau & Associés vient de migrer 800 bulletins de paie sur Linc. Leur responsable RH, Sophie Durand, touche 4 200 € nets par mois et gère aussi les fiches de paie de SCI Les Acacias et Boulangerie Petit Jean.

La migration a pris 2 semaines. Résultat: -60% de temps de traitement.`,
    schema: sensitivityOutputSchema,
    expect: (o: unknown) => {
      const out = o as z.infer<typeof sensitivityOutputSchema>;
      if (!out.blocked) return `expected blocked=true (client name + salary leak), got false`;
      return null;
    },
  },

  // ---- 8. claap-publishability: safe customer feedback ----
  {
    step: "claap-publishability-reclassification",
    label: "Publishability — positive customer quote → safe",
    system: `You are a brand safety reviewer for a LinkedIn content pipeline. Assess publishability risk.

publishabilityRisk:
- "safe": Can be published without brand risk.
- "reframeable": Useful substance but current framing would damage the brand. Provide reframingSuggestion.
- "harmful": Would damage the brand even if reframed (distrust, complaints about reliability, negative competitive comparison).

Calibration:
- "your compliance automation saved us 40 hours/month" → safe
- "we had doubts about accuracy but after testing it works" → reframeable
- "they don't trust the accuracy" or "DSN is the huge blocking point" → harmful

When in doubt, choose harmful. Provide rationale.`,
    prompt: `Content to review:

Le retour client est unanime: depuis qu'on utilise l'automatisation DSN, on a gagné en moyenne 35 heures par mois sur le traitement des déclarations. Les erreurs de saisie ont été divisées par 4. L'équipe peut maintenant se concentrer sur le conseil client plutôt que sur la conformité technique.`,
    schema: claapPublishabilityReviewSchema,
    expect: (o: unknown) => {
      const out = o as z.infer<typeof claapPublishabilityReviewSchema>;
      if (out.publishabilityRisk !== "safe") return `expected "safe", got "${out.publishabilityRisk}"`;
      return null;
    },
  },

  // ---- 9. claap-publishability: harmful (distrust) ----
  {
    step: "claap-publishability-reclassification",
    label: "Publishability — distrust in product → harmful",
    system: `You are a brand safety reviewer for a LinkedIn content pipeline. Assess publishability risk.

publishabilityRisk:
- "safe": Can be published without brand risk.
- "reframeable": Useful substance but current framing would damage the brand. Provide reframingSuggestion.
- "harmful": Would damage the brand even if reframed (distrust, complaints about reliability, negative competitive comparison).

Calibration:
- "your compliance automation saved us 40 hours/month" → safe
- "we had doubts about accuracy but after testing it works" → reframeable
- "they don't trust the accuracy" or "DSN is the huge blocking point" → harmful

When in doubt, choose harmful. Provide rationale.`,
    prompt: `Content to review:

Franchement on ne fait plus confiance au moteur de calcul. On a trouvé 3 erreurs de cotisation sur le dernier mois. La DSN c'est le gros point de blocage — on vérifie tout manuellement maintenant. Si ça continue on retourne sur Silae.`,
    schema: claapPublishabilityReviewSchema,
    expect: (o: unknown) => {
      const out = o as z.infer<typeof claapPublishabilityReviewSchema>;
      if (out.publishabilityRisk !== "harmful") return `expected "harmful", got "${out.publishabilityRisk}"`;
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface Result {
  label: string;
  step: string;
  pass: boolean;
  reason: string | null;
  output: unknown;
  latencyMs: number;
  tokens: { prompt: number; completion: number };
  costUsd: number;
}

async function runCase(tc: TestCase): Promise<Result> {
  const t0 = Date.now();
  try {
    const res = await client.generateStructured({
      step: tc.step,
      system: tc.system,
      prompt: tc.prompt,
      schema: tc.schema,
      allowFallback: false,
      fallback: () => ({}),
    });

    const latencyMs = Date.now() - t0;
    const reason = tc.expect(res.output);

    return {
      label: tc.label,
      step: tc.step,
      pass: reason === null,
      reason,
      output: res.output,
      latencyMs,
      tokens: { prompt: res.usage.promptTokens, completion: res.usage.completionTokens },
      costUsd: res.usage.estimatedCostUsd,
    };
  } catch (err) {
    return {
      label: tc.label,
      step: tc.step,
      pass: false,
      reason: `API error: ${err instanceof Error ? err.message : String(err)}`,
      output: null,
      latencyMs: Date.now() - t0,
      tokens: { prompt: 0, completion: 0 },
      costUsd: 0,
    };
  }
}

async function main() {
  console.log(`\n  Nano quality validation — model: gpt-5.4-nano\n`);
  console.log(`  Running ${cases.length} test cases...\n`);

  const results: Result[] = [];
  for (const tc of cases) {
    const r = await runCase(tc);
    const icon = r.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} ${r.label}  (${r.latencyMs}ms, ${r.tokens.prompt}+${r.tokens.completion} tok, $${r.costUsd.toFixed(6)})`);
    if (!r.pass) {
      console.log(`    → ${r.reason}`);
      if (r.output) console.log(`    → output: ${JSON.stringify(r.output)}`);
    }
    results.push(r);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const totalLatency = results.reduce((s, r) => s + r.latencyMs, 0);
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const avgLatency = Math.round(totalLatency / results.length);

  console.log(`\n  ─────────────────────────────────────────`);
  console.log(`  ${passed}/${results.length} passed, ${failed} failed`);
  console.log(`  avg latency: ${avgLatency}ms | total cost: $${totalCost.toFixed(6)}`);

  if (failed > 0) {
    console.log(`\n  \x1b[31m⚠  Nano quality insufficient for ${failed} case(s). Review before production.\x1b[0m\n`);
    process.exit(1);
  } else {
    console.log(`\n  \x1b[32m✓  All nano cases passed. Model is suitable for production routing.\x1b[0m\n`);
  }
}

main();
