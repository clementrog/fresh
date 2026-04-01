import { describe, expect, it, vi } from "vitest";

import { generateDraft } from "../src/services/drafts.js";
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

  it("includes GTM Foundation section when provided", async () => {
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
      opportunity: makeTestOpportunity({ targetSegment: "cabinet-owner" }),
      user: makeTestUser(),
      llmClient: llm,
      sensitivityRulesMarkdown: "",
      doctrineMarkdown: "",
      editorialNotes: "",
      layer3Defaults: [],
      gtmFoundationMarkdown: "## Target segments\ncabinet-owner, production-manager\n## Core market frictions\nMigration fear, calculation opacity"
    });

    expect(capturedPrompt).toContain("## GTM Foundation");
    expect(capturedPrompt).toContain("Migration fear");
    expect(capturedPrompt).toContain("cabinet-owner");
    // GTM Foundation should appear before Opportunity
    const gtmIdx = capturedPrompt.indexOf("## GTM Foundation");
    const oppIdx = capturedPrompt.indexOf("## Opportunity");
    expect(gtmIdx).toBeLessThan(oppIdx);
  });

  it("omits GTM Foundation section when empty", async () => {
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
      doctrineMarkdown: "",
      editorialNotes: "",
      layer3Defaults: [],
      gtmFoundationMarkdown: ""
    });

    expect(capturedPrompt).not.toContain("## GTM Foundation");
  });

  it("conflict case: corporate profile sees Layer 3 first-person rule alongside system invariant", async () => {
    let capturedSystem = "";
    let capturedUser = "";
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
        capturedSystem = body.messages?.[0]?.content ?? "";
        capturedUser = body.messages?.[1]?.content ?? "";
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
      opportunity: makeTestOpportunity({ ownerProfile: "linc-corporate" }),
      user: makeTestUser({ baseProfile: { profileId: "linc-corporate", toneSummary: "Corporate", preferredStructure: "Team voice", typicalPhrases: [], avoidRules: [], contentTerritories: [] } }),
      llmClient: llm,
      sensitivityRulesMarkdown: "",
      doctrineMarkdown: "",
      editorialNotes: "",
      layer3Defaults: ["First person mandatory.", "End with a question."],
      gtmFoundationMarkdown: ""
    });

    // System prompt must carry the corporate voice invariant
    expect(capturedSystem).toContain("NEVER use 'je'");
    // Layer 3 section in user prompt contains the conflicting rule
    expect(capturedUser).toContain("First person mandatory.");
    expect(capturedUser).toContain("End with a question.");
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
