import { describe, expect, it } from "vitest";

import { maybeGenerateDraft } from "../src/services/drafts.js";
import { LlmClient } from "../src/services/llm.js";

describe("draft generation", () => {
  it("blocks drafts when post-generation sensitivity flags the content", async () => {
    let callIndex = 0;
    const llm = new LlmClient({
      DATABASE_URL: "",
      NOTION_TOKEN: "",
      NOTION_PARENT_PAGE_ID: "",
      SLACK_BOT_TOKEN: "",
      SLACK_EDITORIAL_OPERATOR_ID: "",
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
          if (callIndex === 1) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      proposedTitle: "Sujet sensible",
                      hook: "Un client a demandé la roadmap",
                      summary: "Résumé",
                      whatItIsAbout: "À propos",
                      whatItIsNotAbout: "Pas à propos",
                      visualIdea: "Visuel simple",
                      firstDraftText: "Le client a demandé la roadmap et la rémunération.",
                      confidenceScore: 0.8
                    })
                  }
                }
              ]
            };
          }

          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    blocked: true,
                    categories: ["client-identifiable", "roadmap-sensitive", "payroll-sensitive"],
                    rationale: "Sensitive content found",
                    stageTwoScore: 0.95
                  })
                }
              }
            ]
          };
        }
      }) as Response
    );

    const result = await maybeGenerateDraft({
      opportunity: {
        id: "opp_1",
        sourceFingerprint: "opp-fp-1",
        title: "Client objection",
        ownerProfile: "quentin",
        narrativePillar: "terrain commercial / adoption",
        angle: "Explain the objection.",
        whyNow: "Fresh",
        whatItIsAbout: "Client proof requirements",
        whatItIsNotAbout: "Generic sales advice",
        relatedSignalIds: ["signal_1"],
        evidence: [
          {
            id: "opportunity-e1",
            source: "slack",
            sourceItemId: "1",
            sourceUrl: "https://example.com",
            timestamp: new Date().toISOString(),
            excerpt: "A client asked for roadmap proof and salary data.",
            excerptHash: "hash",
            freshnessScore: 0.9
          },
          {
            id: "opportunity-e2",
            source: "linear",
            sourceItemId: "2",
            sourceUrl: "https://example.com/2",
            timestamp: new Date().toISOString(),
            excerpt: "The same concern showed up in the account review.",
            excerptHash: "hash-2",
            freshnessScore: 0.7
          }
        ],
        primaryEvidence: {
          id: "opportunity-e1",
          source: "slack",
          sourceItemId: "1",
          sourceUrl: "https://example.com",
          timestamp: new Date().toISOString(),
          excerpt: "A client asked for roadmap proof and salary data.",
          excerptHash: "hash",
          freshnessScore: 0.9
        },
        supportingEvidenceCount: 1,
        evidenceFreshness: 0.9,
        evidenceExcerpts: ["A client asked for roadmap proof and salary data."],
        routingStatus: "Routed",
        readiness: "Draft candidate",
        status: "Ready for V1",
        suggestedFormat: "Narrative lesson post",
        v1History: [],
        enrichmentLog: [],
        notionPageFingerprint: "opp-fp-1"
      },
      profile: {
        profileId: "quentin",
        toneSummary: "Direct and field-based.",
        preferredStructure: "Lead with objection, explain the lesson.",
        recurringPhrases: ["Ce qui bloque vraiment"],
        avoidRules: [],
        contentTerritories: ["terrain commercial / adoption"],
        weakFitTerritories: [],
        sampleExcerpts: [],
        baseSource: "seed",
        learnedExcerptCount: 0,
        notionPageFingerprint: "profile-fp-1"
      },
      llmClient: llm,
      clusterConflict: false,
      sensitivityRulesMarkdown: "## client-identifiable\n- client\n## payroll-sensitive\n- salary\n## roadmap-sensitive\n- roadmap"
    });

    expect(result.draft).toBeNull();
    expect(result.usageEvents).toHaveLength(2);
  });
});
