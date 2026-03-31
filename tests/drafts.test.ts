import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateDraft, assessDraftSensitivity } from "../src/services/drafts.js";
import { LlmClient } from "../src/services/llm.js";
import type { ContentOpportunity, UserRecord } from "../src/domain/types.js";

function makeTestOpportunity(overrides: Partial<ContentOpportunity> = {}): ContentOpportunity {
  return {
    id: "opp_test",
    sourceFingerprint: "opp-fp-test",
    title: "Test opportunity",
    ownerProfile: "quentin",
    ownerUserId: "user_1",
    companyId: "company_1",
    narrativePillar: "terrain commercial",
    angle: "Explain the angle.",
    whyNow: "Fresh evidence",
    whatItIsAbout: "Adoption patterns",
    whatItIsNotAbout: "Generic advice",
    evidence: [
      {
        id: "e1",
        source: "notion",
        sourceItemId: "si1",
        sourceUrl: "https://example.com",
        timestamp: new Date().toISOString(),
        excerpt: "Teams adopted faster when given concrete examples.",
        excerptHash: "hash1",
        freshnessScore: 0.9
      }
    ],
    primaryEvidence: {
      id: "e1",
      source: "notion",
      sourceItemId: "si1",
      sourceUrl: "https://example.com",
      timestamp: new Date().toISOString(),
      excerpt: "Teams adopted faster when given concrete examples.",
      excerptHash: "hash1",
      freshnessScore: 0.9
    },
    supportingEvidenceCount: 0,
    evidenceFreshness: 0.9,
    evidenceExcerpts: ["Teams adopted faster when given concrete examples."],
    routingStatus: "Routed",
    readiness: "Draft candidate",
    status: "Ready for V1",
    suggestedFormat: "Narrative lesson post",
    v1History: [],
    enrichmentLog: [],
    notionPageFingerprint: "opp-fp-test",
    ...overrides
  };
}

function makeTestUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user_1",
    companyId: "company_1",
    displayName: "Quentin",
    type: "human",
    language: "fr",
    baseProfile: {
      toneSummary: "Direct et terrain.",
      preferredStructure: "Lead with objection, explain the lesson.",
      typicalPhrases: ["Ce qui bloque vraiment", "En pratique"],
      avoidRules: ["No jargon"],
      contentTerritories: ["terrain commercial"]
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function makeLlmClient(draftResponse: Record<string, unknown>, safetyResponse: Record<string, unknown>) {
  let callIndex = 0;
  return new LlmClient({
    DATABASE_URL: "",
    NOTION_TOKEN: "",
    NOTION_PARENT_PAGE_ID: "",
    OPENAI_API_KEY: "test-key",
    CLAAP_API_KEY: "",
    LINEAR_API_KEY: "",
    DEFAULT_TIMEZONE: "Europe/Paris",
    LLM_MODEL: "test",
    LLM_TIMEOUT_MS: 100,
    LOG_LEVEL: "info"
  }, undefined, async () =>
    ({
      ok: true,
      json: async () => {
        callIndex += 1;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify(callIndex === 1 ? draftResponse : safetyResponse)
              }
            }
          ]
        };
      }
    }) as Response
  );
}

const safeDraftOutput = {
  proposedTitle: "Titre du post",
  hook: "Accroche percutante",
  summary: "Résumé",
  whatItIsAbout: "À propos",
  whatItIsNotAbout: "Pas à propos",
  visualIdea: "Visuel simple",
  firstDraftText: "Le texte du post. Un vrai brouillon qui fait plus de cinquante caracteres pour passer la validation.",
  confidenceScore: 0.85
};

const clearSafety = {
  blocked: false,
  categories: [],
  rationale: "Content is safe",
  stageTwoScore: 0.1
};

const blockedSafety = {
  blocked: true,
  categories: ["internal-only"],
  rationale: "Contains internal data",
  stageTwoScore: 0.95
};

describe("generateDraft", () => {
  it("happy path — returns draft with correct fields", async () => {
    const llm = makeLlmClient(safeDraftOutput, clearSafety);
    const result = await generateDraft({
      opportunity: makeTestOpportunity(),
      user: makeTestUser(),
      llmClient: llm,
      sensitivityRulesMarkdown: "",
      doctrineMarkdown: "Test doctrine.",
      editorialNotes: "Make it punchy.",
      layer3Defaults: ["Use short paragraphs"],
      gtmFoundationMarkdown: ""
    });

    expect(result.blocked).toBe(false);
    expect(result.draft).not.toBeNull();
    expect(result.draft!.opportunityId).toBe("opp_test");
    expect(result.draft!.language).toBe("fr");
    expect(result.draft!.proposedTitle).toBeTruthy();
    expect(result.draft!.firstDraftText).toBeTruthy();
    expect(result.usageEvents).toHaveLength(2);
  });

  it("includes editorial notes section in prompt when provided", async () => {
    let capturedPrompt = "";
    let callIndex = 0;
    const llm = new LlmClient({
      DATABASE_URL: "",
      NOTION_TOKEN: "",
      NOTION_PARENT_PAGE_ID: "",
      OPENAI_API_KEY: "test-key",
      CLAAP_API_KEY: "",
      LINEAR_API_KEY: "",
      DEFAULT_TIMEZONE: "Europe/Paris",
      LLM_MODEL: "test",
      LLM_TIMEOUT_MS: 100,
      LOG_LEVEL: "info"
    }, undefined, async (_url, options) => {
      const body = JSON.parse((options as any).body);
      if (callIndex === 0) {
        capturedPrompt = body.messages?.[1]?.content ?? body.messages?.[0]?.content ?? "";
      }
      callIndex += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(callIndex === 1 ? safeDraftOutput : clearSafety)
              }
            }
          ]
        })
      } as Response;
    });

    await generateDraft({
      opportunity: makeTestOpportunity(),
      user: makeTestUser(),
      llmClient: llm,
      sensitivityRulesMarkdown: "",
      doctrineMarkdown: "Doctrine text.",
      editorialNotes: "Focus on the adoption angle specifically.",
      layer3Defaults: [],
      gtmFoundationMarkdown: ""
    });

    expect(capturedPrompt).toContain("Focus on the adoption angle specifically");
    expect(capturedPrompt).toContain("## Editorial notes");
  });

  it("uses 'No editorial notes provided' when notes are empty", async () => {
    let capturedPrompt = "";
    let callIndex = 0;
    const llm = new LlmClient({
      DATABASE_URL: "",
      NOTION_TOKEN: "",
      NOTION_PARENT_PAGE_ID: "",
      OPENAI_API_KEY: "test-key",
      CLAAP_API_KEY: "",
      LINEAR_API_KEY: "",
      DEFAULT_TIMEZONE: "Europe/Paris",
      LLM_MODEL: "test",
      LLM_TIMEOUT_MS: 100,
      LOG_LEVEL: "info"
    }, undefined, async (_url, options) => {
      const body = JSON.parse((options as any).body);
      if (callIndex === 0) {
        capturedPrompt = body.messages?.[1]?.content ?? body.messages?.[0]?.content ?? "";
      }
      callIndex += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(callIndex === 1 ? safeDraftOutput : clearSafety)
              }
            }
          ]
        })
      } as Response;
    });

    await generateDraft({
      opportunity: makeTestOpportunity(),
      user: makeTestUser(),
      llmClient: llm,
      sensitivityRulesMarkdown: "",
      doctrineMarkdown: "Doctrine text.",
      editorialNotes: "",
      layer3Defaults: [],
      gtmFoundationMarkdown: ""
    });

    expect(capturedPrompt).toContain("No editorial notes provided");
  });

  it("includes enrichment history in prompt when present", async () => {
    let capturedPrompt = "";
    let callIndex = 0;
    const llm = new LlmClient({
      DATABASE_URL: "",
      NOTION_TOKEN: "",
      NOTION_PARENT_PAGE_ID: "",
      OPENAI_API_KEY: "test-key",
      CLAAP_API_KEY: "",
      LINEAR_API_KEY: "",
      DEFAULT_TIMEZONE: "Europe/Paris",
      LLM_MODEL: "test",
      LLM_TIMEOUT_MS: 100,
      LOG_LEVEL: "info"
    }, undefined, async (_url, options) => {
      const body = JSON.parse((options as any).body);
      if (callIndex === 0) {
        capturedPrompt = body.messages?.[1]?.content ?? body.messages?.[0]?.content ?? "";
      }
      callIndex += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(callIndex === 1 ? safeDraftOutput : clearSafety)
              }
            }
          ]
        })
      } as Response;
    });

    await generateDraft({
      opportunity: makeTestOpportunity({
        enrichmentLog: [
          {
            createdAt: "2026-03-10T00:00:00Z",
            rawSourceItemId: "si_2",
            evidenceIds: ["e2", "e3"],
            contextComment: "Added corroborating data from Linear",
            confidence: 0.8,
            reason: "Direct overlap"
          }
        ]
      }),
      user: makeTestUser(),
      llmClient: llm,
      sensitivityRulesMarkdown: "",
      doctrineMarkdown: "",
      editorialNotes: "",
      layer3Defaults: [],
      gtmFoundationMarkdown: ""
    });

    expect(capturedPrompt).toContain("Added corroborating data from Linear");
    expect(capturedPrompt).toContain("+2 evidence");
  });

  it("returns blocked result with usage events on sensitivity block", async () => {
    const llm = makeLlmClient(safeDraftOutput, blockedSafety);

    const result = await generateDraft({
      opportunity: makeTestOpportunity(),
      user: makeTestUser(),
      llmClient: llm,
      sensitivityRulesMarkdown: "",
      doctrineMarkdown: "",
      editorialNotes: "",
      layer3Defaults: [],
      gtmFoundationMarkdown: ""
    });

    expect(result.blocked).toBe(true);
    expect(result.draft).toBeNull();
    expect(result.blockRationale).toBeTruthy();
    expect(result.usageEvents).toHaveLength(2);
    expect(result.usageEvents[0].step).toBe("draft-generation");
    expect(result.usageEvents[1].step).toBe("draft-sensitivity");
  });

  it("includes user profile fields in prompt", async () => {
    let capturedPrompt = "";
    let callIndex = 0;
    const llm = new LlmClient({
      DATABASE_URL: "",
      NOTION_TOKEN: "",
      NOTION_PARENT_PAGE_ID: "",
      OPENAI_API_KEY: "test-key",
      CLAAP_API_KEY: "",
      LINEAR_API_KEY: "",
      DEFAULT_TIMEZONE: "Europe/Paris",
      LLM_MODEL: "test",
      LLM_TIMEOUT_MS: 100,
      LOG_LEVEL: "info"
    }, undefined, async (_url, options) => {
      const body = JSON.parse((options as any).body);
      if (callIndex === 0) {
        capturedPrompt = body.messages?.[1]?.content ?? body.messages?.[0]?.content ?? "";
      }
      callIndex += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(callIndex === 1 ? safeDraftOutput : clearSafety)
              }
            }
          ]
        })
      } as Response;
    });

    await generateDraft({
      opportunity: makeTestOpportunity(),
      user: makeTestUser({
        baseProfile: {
          toneSummary: "Punchy and provocative",
          preferredStructure: "Hook then proof",
          typicalPhrases: ["La vérité terrain"],
          avoidRules: ["Never use buzzwords"],
          contentTerritories: ["tech adoption"]
        }
      }),
      llmClient: llm,
      sensitivityRulesMarkdown: "",
      doctrineMarkdown: "",
      editorialNotes: "",
      layer3Defaults: [],
      gtmFoundationMarkdown: ""
    });

    expect(capturedPrompt).toContain("Punchy and provocative");
    expect(capturedPrompt).toContain("La vérité terrain");
  });
});

describe("draft evidence company scoping", () => {
  it("createDraft writes companyId on both draft row and evidence rows", async () => {
    const draftCreateCalls: unknown[] = [];
    const evidenceCreateCalls: unknown[] = [];
    const fakeTx = {
      draft: {
        create: vi.fn(async (args: unknown) => {
          draftCreateCalls.push(args);
        })
      },
      evidenceReference: {
        createMany: vi.fn(async (args: unknown) => {
          evidenceCreateCalls.push(args);
        })
      }
    };

    const { RepositoryBundle } = await import("../src/db/repositories.js");
    const repos = new RepositoryBundle(null as any);

    const draft = {
      id: "draft_scoped",
      opportunityId: "opp_1",
      profileId: "quentin" as const,
      proposedTitle: "Title",
      hook: "Hook",
      summary: "Summary",
      whatItIsAbout: "About",
      whatItIsNotAbout: "Not about",
      visualIdea: "Visual",
      firstDraftText: "Text",
      sourceEvidence: [
        {
          id: "ev_1",
          source: "notion" as const,
          sourceItemId: "si_1",
          sourceUrl: "https://example.com",
          timestamp: new Date().toISOString(),
          excerpt: "Evidence excerpt",
          excerptHash: "hash1",
          freshnessScore: 0.9
        }
      ],
      confidenceScore: 0.85,
      language: "fr",
      createdAt: new Date().toISOString()
    };

    await repos.createDraft(draft, fakeTx as any, "company_abc");

    // Draft row should have companyId
    expect(draftCreateCalls).toHaveLength(1);
    const draftData = (draftCreateCalls[0] as any).data;
    expect(draftData.companyId).toBe("company_abc");

    // Evidence rows should also have companyId
    expect(evidenceCreateCalls).toHaveLength(1);
    const evidenceData = (evidenceCreateCalls[0] as any).data;
    expect(evidenceData).toHaveLength(1);
    expect(evidenceData[0].companyId).toBe("company_abc");
  });

  it("createDraft without companyId writes null on both draft and evidence rows", async () => {
    const draftCreateCalls: unknown[] = [];
    const evidenceCreateCalls: unknown[] = [];
    const fakeTx = {
      draft: {
        create: vi.fn(async (args: unknown) => {
          draftCreateCalls.push(args);
        })
      },
      evidenceReference: {
        createMany: vi.fn(async (args: unknown) => {
          evidenceCreateCalls.push(args);
        })
      }
    };

    const { RepositoryBundle } = await import("../src/db/repositories.js");
    const repos = new RepositoryBundle(null as any);

    const draft = {
      id: "draft_unscoped",
      opportunityId: "opp_2",
      profileId: "quentin" as const,
      proposedTitle: "Title",
      hook: "Hook",
      summary: "Summary",
      whatItIsAbout: "About",
      whatItIsNotAbout: "Not about",
      visualIdea: "Visual",
      firstDraftText: "Text",
      sourceEvidence: [
        {
          id: "ev_2",
          source: "notion" as const,
          sourceItemId: "si_2",
          sourceUrl: "https://example.com",
          timestamp: new Date().toISOString(),
          excerpt: "Evidence excerpt",
          excerptHash: "hash2",
          freshnessScore: 0.8
        }
      ],
      confidenceScore: 0.8,
      language: "fr",
      createdAt: new Date().toISOString()
    };

    await repos.createDraft(draft, fakeTx as any);

    const draftData = (draftCreateCalls[0] as any).data;
    expect(draftData.companyId).toBeNull();

    const evidenceData = (evidenceCreateCalls[0] as any).data;
    expect(evidenceData[0].companyId).toBeNull();
  });
});

// --- Helper: create LlmClient that captures all calls ---

const TEST_LLM_CONFIG = {
  DATABASE_URL: "",
  NOTION_TOKEN: "",
  NOTION_PARENT_PAGE_ID: "",
  OPENAI_API_KEY: "test-key",
  CLAAP_API_KEY: "",
  LINEAR_API_KEY: "",
  DEFAULT_TIMEZONE: "Europe/Paris",
  LLM_MODEL: "test",
  LLM_TIMEOUT_MS: 100,
  LOG_LEVEL: "info"
};

function makeCapturingLlmClient(responses: Record<string, unknown>[]) {
  const captured: Array<{ system: string; prompt: string }> = [];
  let callIndex = 0;
  const llm = new LlmClient(TEST_LLM_CONFIG, undefined, async (_url, options) => {
    const body = JSON.parse((options as any).body);
    captured.push({
      system: body.messages?.[0]?.content ?? "",
      prompt: body.messages?.[1]?.content ?? body.messages?.[0]?.content ?? ""
    });
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex += 1;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(response) } }]
      })
    } as Response;
  });
  return { llm, captured };
}

/** LlmClient whose fetch always fails — triggers the fallback path */
function makeFailingLlmClient() {
  const captured: Array<{ system: string; prompt: string }> = [];
  const llm = new LlmClient(TEST_LLM_CONFIG, undefined, async (_url, options) => {
    const body = JSON.parse((options as any).body);
    captured.push({
      system: body.messages?.[0]?.content ?? "",
      prompt: body.messages?.[1]?.content ?? body.messages?.[0]?.content ?? ""
    });
    return { ok: false, status: 503, json: async () => ({}) } as Response;
  });
  return { llm, captured };
}

// --- 5a. Prompt content assertions ---

describe("draft prompt — evidence attribution and editorial claim", () => {
  it("includes speakerOrAuthor in evidence section", async () => {
    const { llm, captured } = makeCapturingLlmClient([safeDraftOutput, clearSafety]);

    await generateDraft({
      opportunity: makeTestOpportunity({
        evidence: [
          {
            id: "e1",
            source: "claap",
            sourceItemId: "si1",
            sourceUrl: "https://example.com",
            timestamp: "2026-03-20T00:00:00Z",
            excerpt: "DSN errors cost us 2h every cycle.",
            excerptHash: "hash1",
            speakerOrAuthor: "Marie Lefèvre",
            freshnessScore: 0.9
          }
        ]
      }),
      user: makeTestUser(),
      llmClient: llm,
      sensitivityRulesMarkdown: "",
      doctrineMarkdown: "",
      editorialNotes: "",
      layer3Defaults: [],
      gtmFoundationMarkdown: ""
    });

    expect(captured[0].prompt).toContain("Marie Lefèvre");
    expect(captured[0].prompt).toContain("[claap]");
  });

  it("includes editorialClaim in opportunity section", async () => {
    const { llm, captured } = makeCapturingLlmClient([safeDraftOutput, clearSafety]);

    await generateDraft({
      opportunity: makeTestOpportunity({
        editorialClaim: "DSN errors cost 2h per cycle and cabinets assume it's normal"
      }),
      user: makeTestUser(),
      llmClient: llm,
      sensitivityRulesMarkdown: "",
      doctrineMarkdown: "",
      editorialNotes: "",
      layer3Defaults: [],
      gtmFoundationMarkdown: ""
    });

    expect(captured[0].prompt).toContain("Editorial claim:");
    expect(captured[0].prompt).toContain("DSN errors cost 2h per cycle and cabinets assume it's normal");
  });
});

// --- 5b–5e. Safety gate: re-identification boundary ---

describe("assessDraftSensitivity — re-identification boundary", () => {
  // Stage 1: SIREN/SIRET always hard-blocks
  it("SIREN (9 digits, separated) hard-blocks before stage 2", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("Le numéro SIREN 123 456 789 est enregistré.", llm);
    expect(result.blocked).toBe(true);
    expect(result.rationale).toMatch(/identifiable data/);
    expect(captured).toHaveLength(0);
  });

  it("SIRET (14 digits, separated) hard-blocks before stage 2", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("SIRET 123 456 789 00015 de l'établissement.", llm);
    expect(result.blocked).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it("SIRET (14 digits, compact) hard-blocks before stage 2", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("Immatriculée sous le numéro 12345678900015.", llm);
    expect(result.blocked).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it("SIREN (9 digits, compact) hard-blocks before stage 2", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("Le SIREN 123456789 figure au registre.", llm);
    expect(result.blocked).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it("SIRET + company also hard-blocks at stage 1", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("Cabinet Dupont SARL, SIRET 123 456 789 00015", llm);
    expect(result.blocked).toBe(true);
    expect(captured).toHaveLength(0);
  });

  // Company-name pattern coverage: camelCase, ALL-CAPS, accented
  it("camelCase company (PayFit SAS) triggers named-entity signal", async () => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("PayFit SAS a lancé une nouvelle offre.", llm);
    expect(result.signals).toContain("contains-named-entity");
  });

  it("ALL-CAPS company (CEGID SA) triggers named-entity signal", async () => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("CEGID SA reste un acteur majeur du marché.", llm);
    expect(result.signals).toContain("contains-named-entity");
  });

  // Stage 1 pass-through: single factors reach stage 2
  it("company name alone passes to stage 2 and is allowed", async () => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("On a travaillé avec Cabinet Dupont SARL sur ce sujet.", llm);
    expect(result.blocked).toBe(false);
  });

  it("salary figure alone passes to stage 2 and is allowed", async () => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("Le marché est autour de 3 200€ brut/mois pour ce profil.", llm);
    expect(result.blocked).toBe(false);
  });

  it("first name alone passes to stage 2 and is allowed", async () => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("Marie m'a dit la semaine dernière que le process était cassé.", llm);
    expect(result.blocked).toBe(false);
  });

  // Stage 2 contextual: ambiguous combinations
  it("client company + salary: stage 2 blocks → overall blocked", async () => {
    const { llm } = makeCapturingLlmClient([{
      blocked: true,
      categories: ["client-identifiable"],
      rationale: "Named client company combined with employee salary figure.",
      stageTwoScore: 0.9
    }]);
    const result = await assessDraftSensitivity("Cabinet Dupont SARL paie ses gestionnaires 3 200€ brut/mois.", llm);
    expect(result.blocked).toBe(true);
    expect(result.rationale).toContain("salary");
  });

  it("stage-2 blocked: true with empty categories still blocks", async () => {
    const { llm } = makeCapturingLlmClient([{
      blocked: true,
      categories: [],
      rationale: "Draft reveals confidential internal process details.",
      stageTwoScore: 0.75
    }]);
    const result = await assessDraftSensitivity("Un post qui décrit un process interne sensible.", llm);
    expect(result.blocked).toBe(true);
    expect(result.rationale).toContain("confidential");
  });

  it("stage-2 blocked: true with categories also blocks", async () => {
    const { llm } = makeCapturingLlmClient([{
      blocked: true,
      categories: ["internal-only"],
      rationale: "Contains internal-only content.",
      stageTwoScore: 0.9
    }]);
    const result = await assessDraftSensitivity("Un post avec du contenu interne.", llm);
    expect(result.blocked).toBe(true);
  });

  it("stage-2 blocked: false with categories present does NOT block", async () => {
    const { llm } = makeCapturingLlmClient([{
      blocked: false,
      categories: ["payroll-sensitive"],
      rationale: "Payroll terms are expected domain vocabulary, not sensitive here.",
      stageTwoScore: 0.2
    }]);
    const result = await assessDraftSensitivity("On parle de paie et de bulletins.", llm);
    expect(result.blocked).toBe(false);
  });

  it("competitor + pricing: stage 2 allows → overall allowed (false-block regression)", async () => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("Silae SA facture environ 25€/mois par bulletin, ce qui cadre le marché.", llm);
    expect(result.blocked).toBe(false);
  });

  // Signal annotations reach stage 2
  it("annotates named entity + salary signals in stage-2 prompt", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    await assessDraftSensitivity("Cabinet Dupont SARL propose 3 200€ brut/mois.", llm);
    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toContain("contains-named-entity");
    expect(captured[0].prompt).toContain("contains-salary-figure");
  });

  // --- Role-attribution signal — production phrasing variants ---
  //
  // These tests pin the ROLE_ATTRIBUTION_PATTERN contract. The heuristic detects
  // "[role keyword] ... chez/at [Company]" (forward order only, case-insensitive,
  // up to 50-char gap). See the pattern comment in drafts.ts for known limits.
  //
  // SHOULD FIRE: person + role + company patterns
  it.each([
    ["DRH chez multi-token org", "Jean-Marc, DRH chez Dupont Conseil, nous a dit que..."],
    ["responsable paie chez Company", "Marie, responsable paie chez Linc, nous a expliqué que..."],
    ["gestionnaire chez Company", "La gestionnaire chez Cabinet Martin gère 300 bulletins."],
    ["directeur de la production chez Company", "Le directeur de la production de paie chez Silae nous a confirmé."],
    ["Responsable (capitalized) chez Company", "Responsable RH chez Cegid Comptabilité depuis 2024."],
    ["PDG chez Company", "Le PDG chez Synergie Paie a annoncé un changement de cap."],
    ["comptable chez Company", "Une comptable chez Fiducial nous a raconté son quotidien."],
    ["manager at Company (English)", "The payroll manager at ADP France explained the migration."],
    ["chef de projet chez Company", "Le chef de projet chez Lucca a présenté leur approche."],
  ])("%s → fires", async (_label, sentence) => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity(sentence, llm);
    expect(result.signals).toContain("contains-role-attribution");
  });

  // SHOULD NOT FIRE: plain company mentions without a role keyword
  it.each([
    ["plain chez + own company", "On fait ça chez Linc depuis trois mois."],
    ["plain chez + multi-token org", "Le process chez Dupont Conseil reste lent."],
    ["plain at + ALL-CAPS org", "We saw this pattern at CEGID last quarter."],
    ["chez in common expression", "On est comme chez Darty, on ne lâche rien."],
    ["company mention without chez", "Dupont Conseil a revu son process de paie."],
    ["first name only, no company", "Marie m'a dit que le process était cassé."],
  ])("%s → does not fire", async (_label, sentence) => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity(sentence, llm);
    expect(result.signals).not.toContain("contains-role-attribution");
  });

  // KNOWN LIMITS (documented, not bugs — the LLM contextual review handles these):
  it("known limit: reverse order 'chez X en tant que DRH' does not fire", async () => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("Il travaille chez Dupont Conseil en tant que DRH.", llm);
    expect(result.signals).not.toContain("contains-role-attribution");
  });

  it("does not annotate signals when only a first name is present", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    await assessDraftSensitivity("Marie m'a dit que le process était cassé.", llm);
    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).not.toContain("Detected signals");
  });

  it("returns detected signals in result", async () => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    // Use "Silae SA" (matches named-entity regex) + salary figure
    const result = await assessDraftSensitivity("Silae SA facture environ 25€/mois par bulletin.", llm);
    expect(result.signals).toContain("contains-named-entity");
    expect(result.signals).toContain("contains-salary-figure");
  });

  // Fail-closed: stage-2 fallback with risk signals blocks
  it("company + salary blocks on stage-2 provider timeout (fail closed)", async () => {
    const { llm } = makeFailingLlmClient();
    const result = await assessDraftSensitivity("Cabinet Dupont SARL paie ses gestionnaires 3 200€ brut/mois.", llm);
    expect(result.blocked).toBe(true);
    expect(result.rationale).toContain("fallback");
    expect(result.rationale).toContain("contains-named-entity");
    expect(result.rationale).toContain("contains-salary-figure");
  });

  it("person + role + company blocks on stage-2 fallback even without legal suffix", async () => {
    const { llm } = makeFailingLlmClient();
    const result = await assessDraftSensitivity("Jean-Marc, DRH chez Dupont Conseil, gère 450 bulletins par mois.", llm);
    expect(result.blocked).toBe(true);
    expect(result.rationale).toContain("fallback");
    expect(result.rationale).toContain("contains-role-attribution");
  });

  // Fallback regression: plain chez/at Company without person+role stays allowed
  it("'chez Linc' without role context: stage-2 fallback does NOT block", async () => {
    const { llm } = makeFailingLlmClient();
    const result = await assessDraftSensitivity("On fait ça chez Linc depuis trois mois.", llm);
    expect(result.blocked).toBe(false);
  });

  it("'chez Dupont Conseil' without role context: stage-2 fallback does NOT block", async () => {
    const { llm } = makeFailingLlmClient();
    const result = await assessDraftSensitivity("Le process chez Dupont Conseil a changé cette année.", llm);
    expect(result.blocked).toBe(false);
  });

  it("'at CEGID' without role context: stage-2 fallback does NOT block", async () => {
    const { llm } = makeFailingLlmClient();
    const result = await assessDraftSensitivity("We saw this pattern at CEGID last quarter.", llm);
    expect(result.blocked).toBe(false);
  });

  it("no signals present: stage-2 fallback does NOT block", async () => {
    const { llm } = makeFailingLlmClient();
    const result = await assessDraftSensitivity("Marie m'a dit que le process était cassé.", llm);
    expect(result.blocked).toBe(false);
  });

  // Stage-2 defense-in-depth: SIRET mentioned in LLM safety prompt
  it("relaxed-mode stage-2 prompt mentions SIREN/SIRET as always-block category", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    await assessDraftSensitivity("Un post normal sans rien de sensible.", llm);
    expect(captured).toHaveLength(1);
    expect(captured[0].system).toContain("SIREN or SIRET");
  });

  // Stage-2 prompt alignment: model is instructed to return all schema fields
  it("relaxed-mode stage-2 prompt instructs categories and stageTwoScore", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    await assessDraftSensitivity("Un post normal.", llm);
    expect(captured[0].system).toContain("categories");
    expect(captured[0].system).toContain("stageTwoScore");
    expect(captured[0].system).toContain("client-identifiable");
  });

  // End-to-end consistency: competitor + pricing passes fully
  it("competitor + pricing passes end-to-end with signals forwarded to stage 2", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("Silae SA facture environ 25€/mois par bulletin.", llm);
    // Deterministic stage did not block
    expect(result.blocked).toBe(false);
    // Stage 2 was called with signals
    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toContain("contains-named-entity");
    expect(captured[0].prompt).toContain("contains-salary-figure");
    expect(result.signals).toEqual(["contains-named-entity", "contains-salary-figure"]);
  });
});

// --- 7b–7c. Strict mode ---

describe("assessDraftSensitivity — strict mode", () => {
  beforeEach(() => { process.env.DRAFT_SAFETY_STRICT = "1"; });
  afterEach(() => { delete process.env.DRAFT_SAFETY_STRICT; });

  it("company name alone hard-blocks in strict mode", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("On a travaillé avec Cabinet Dupont SARL.", llm);
    expect(result.blocked).toBe(true);
    expect(captured).toHaveLength(0); // LLM not called
  });

  it("salary alone hard-blocks in strict mode", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("Le marché est autour de 3 200€ brut/mois.", llm);
    expect(result.blocked).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it("SIRET hard-blocks in strict mode (same as default)", async () => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("SIRET 123 456 789 00015", llm);
    expect(result.blocked).toBe(true);
  });

  it("PayFit SAS hard-blocks in strict mode (camelCase)", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("PayFit SAS a lancé une offre.", llm);
    expect(result.blocked).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it("CEGID SA hard-blocks in strict mode (ALL-CAPS)", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity("CEGID SA domine le segment.", llm);
    expect(result.blocked).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it("strict mode uses old safety system prompt with schema-aligned fields", async () => {
    const { llm, captured } = makeCapturingLlmClient([clearSafety]);
    // Text that passes all strict hard-block patterns
    await assessDraftSensitivity("Un post simple sans entité ni chiffre sensible.", llm);
    expect(captured).toHaveLength(1);
    expect(captured[0].system).toContain("specific CLIENT company names");
    expect(captured[0].system).not.toContain("re-identification");
    expect(captured[0].system).toContain("categories");
    expect(captured[0].system).toContain("stageTwoScore");
  });
});

// Cross-mode consistency: same input, different outcomes
describe("assessDraftSensitivity — cross-mode consistency", () => {
  const competitorPricing = "Silae SA facture 25€/mois par bulletin.";

  it("default mode: competitor + pricing passes", async () => {
    const { llm } = makeCapturingLlmClient([clearSafety]);
    const result = await assessDraftSensitivity(competitorPricing, llm);
    expect(result.blocked).toBe(false);
  });

  it("strict mode: same input hard-blocks", async () => {
    process.env.DRAFT_SAFETY_STRICT = "1";
    try {
      const { llm, captured } = makeCapturingLlmClient([clearSafety]);
      const result = await assessDraftSensitivity(competitorPricing, llm);
      expect(result.blocked).toBe(true);
      expect(captured).toHaveLength(0); // Hard-blocked before LLM
    } finally {
      delete process.env.DRAFT_SAFETY_STRICT;
    }
  });
});
