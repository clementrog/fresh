import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runExtraction,
  fanOutFacts,
  filterFacts,
  isLowValueSource,
  coerceGuards,
  scoreCapability,
  activityExtractionSchema,
  MAX_EXTRACTION_ATTEMPTS,
  type ExtractionResult,
  type ActivityExtractionOutput,
} from "../src/sales/services/extraction.js";
import { mergeExtractionResults } from "../src/sales/app.js";
import type { PrecisionGuards } from "../src/sales/domain/types.js";
import { ConcurrentRunError } from "../src/sales/db/sales-repositories.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface MockActivity {
  id: string;
  companyId: string;
  hubspotEngagementId: string;
  type: string;
  body: string | null;
  timestamp: Date;
  dealId: string | null;
  contactId: string | null;
  extractedAt: Date | null;
  rawTextExpiresAt: Date | null;
  rawTextCleaned: boolean;
  extractionAttempts: number;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeActivity(overrides: Partial<MockActivity> = {}): MockActivity {
  return {
    id: "act-1",
    companyId: "comp-1",
    hubspotEngagementId: "hs-eng-1",
    type: "NOTE",
    body: "A".repeat(200), // well above MIN_BODY_LENGTH (50)
    timestamp: new Date("2026-03-01"),
    dealId: "deal-1",
    contactId: "contact-1",
    extractedAt: null,
    rawTextExpiresAt: null,
    rawTextCleaned: false,
    extractionAttempts: 0,
    createdAt: new Date("2026-02-15"),
    ...overrides,
  };
}

function makeFullLlmOutput(): ActivityExtractionOutput {
  return {
    painPoints: ["slow onboarding", "data migration pain"],
    blockers: ["infosec review pending"],
    nextStep: "Schedule demo with VP Eng",
    urgency: "high",
    competitorMentions: ["Acme Corp"],
    budgetMentioned: true,
    budgetDetails: "$50k earmarked for Q2",
    timelineMentioned: true,
    timelineDetails: "Must go live by June",
    championIdentified: "Jane Smith",
    decisionMakerMentioned: "CTO Bob",
    sentiment: "positive",
    requestedCapabilities: ["SSO integration", "audit log export"],
    complianceConcerns: ["SOC2 required"],
  };
}

function makeEmptyLlmOutput(): ActivityExtractionOutput {
  return {
    painPoints: [],
    blockers: [],
    nextStep: null,
    urgency: null,
    competitorMentions: [],
    budgetMentioned: false,
    budgetDetails: null,
    timelineMentioned: false,
    timelineDetails: null,
    championIdentified: null,
    decisionMakerMentioned: null,
    sentiment: "neutral",
    requestedCapabilities: [],
    complianceConcerns: [],
  };
}

function makeLlmUsage() {
  return {
    mode: "provider" as const,
    promptTokens: 500,
    completionTokens: 100,
    estimatedCostUsd: 0.002,
  };
}

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function makeTxMock() {
  return {
    salesActivity: { update: vi.fn().mockResolvedValue({}) },
    salesExtractedFact: { upsert: vi.fn().mockResolvedValue({}) },
    costLedgerEntry: { create: vi.fn().mockResolvedValue({}) },
  };
}

function makeRepos(txMock = makeTxMock()) {
  return {
    acquireRunLease: vi.fn().mockResolvedValue({ id: "run-1", status: "running" }),
    renewLease: vi.fn().mockResolvedValue(true),
    listUnextractedActivities: vi.fn().mockResolvedValue([]),
    listDealsForStageCheck: vi.fn().mockResolvedValue(new Map()),
    listCompanyNamesForDeals: vi.fn().mockResolvedValue(new Map()),
    getLatestDoctrine: vi.fn().mockResolvedValue(null),
    transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(txMock)),
    deleteFactsForActivity: vi.fn().mockResolvedValue({ count: 0 }),
    markActivityExtracted: vi.fn().mockResolvedValue({}),
    incrementExtractionAttempts: vi.fn().mockResolvedValue(1),
    finalizeSyncRun: vi.fn().mockResolvedValue({}),
    resetExtractions: vi.fn().mockResolvedValue({}),
  };
}

function makeLlmClient(output: ActivityExtractionOutput = makeFullLlmOutput(), usage = makeLlmUsage()) {
  return {
    generateStructured: vi.fn().mockResolvedValue({ output, usage, mode: "provider" }),
  };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

function baseParams(repos: ReturnType<typeof makeRepos>, llmClient: ReturnType<typeof makeLlmClient>) {
  return {
    companyId: "comp-1",
    repos: repos as any,
    llmClient: llmClient as any,
    logger: mockLogger,
    runId: "run-test-1",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sales extraction service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Happy path
  // -----------------------------------------------------------------------
  describe("happy path", () => {
    it("creates facts from realistic LLM response and calls transaction", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmOutput = makeFullLlmOutput();
      const llmClient = makeLlmClient(llmOutput);
      const activity = makeActivity();

      repos.listUnextractedActivities.mockResolvedValue([activity]);

      const result = await runExtraction(baseParams(repos, llmClient));

      // LLM was called
      expect(llmClient.generateStructured).toHaveBeenCalledTimes(1);
      expect(llmClient.generateStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "sales-extraction",
          schema: activityExtractionSchema,
          allowFallback: false,
        })
      );

      // Transaction was called for the fact-write path
      expect(repos.transaction).toHaveBeenCalled();

      // deleteFactsForActivity was called inside the transaction
      expect(repos.deleteFactsForActivity).toHaveBeenCalledWith(activity.id, txMock);

      // Facts were upserted: count all the expected facts from the full output
      const expectedFacts = fanOutFacts("comp-1", activity.id, activity.dealId!, llmOutput, activity.body!);
      expect(txMock.salesExtractedFact.upsert).toHaveBeenCalledTimes(expectedFacts.length);
      expect(expectedFacts.length).toBeGreaterThan(0);

      // Activity marked extracted inside the transaction
      expect(txMock.salesActivity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: activity.id },
          data: expect.objectContaining({ extractedAt: expect.any(Date) }),
        })
      );

      // Cost ledger recorded
      expect(txMock.costLedgerEntry.create).toHaveBeenCalledTimes(1);

      // Result counters
      expect(result.activitiesProcessed).toBe(1);
      expect(result.factsCreated).toBe(expectedFacts.length);
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.retryableErrors).toBe(0);
      expect(result.rateLimited).toBe(false);

      // Finalize was called
      expect(repos.finalizeSyncRun).toHaveBeenCalledWith(
        "run-test-1",
        "completed",
        expect.objectContaining({ activitiesProcessed: 1, factsCreated: expectedFacts.length }),
        expect.any(Array)
      );
    });
  });

  // -----------------------------------------------------------------------
  // 2. Fan-out mapping
  // -----------------------------------------------------------------------
  describe("fanOutFacts", () => {
    it("maps all field types from a full extraction output", () => {
      const output = makeFullLlmOutput();
      const facts = fanOutFacts("comp-1", "act-1", "deal-1", output, "source text here");

      // painPoints → 2 facts
      const painFacts = facts.filter((f) => f.label.startsWith("pain:"));
      expect(painFacts).toHaveLength(2);
      expect(painFacts[0].category).toBe("objection_mentioned");
      expect(painFacts[0].confidence).toBe(0.8);

      // blockers → 1 fact
      const blockerFacts = facts.filter((f) => f.label.startsWith("blocker:"));
      expect(blockerFacts).toHaveLength(1);
      expect(blockerFacts[0].category).toBe("objection_mentioned");

      // nextStep → 1 fact
      const nextStepFacts = facts.filter((f) => f.label === "next_step");
      expect(nextStepFacts).toHaveLength(1);
      expect(nextStepFacts[0].category).toBe("urgency_timing");
      expect(nextStepFacts[0].extractedValue).toBe("Schedule demo with VP Eng");

      // urgency → 1 fact (high != "none")
      const urgencyFacts = facts.filter((f) => f.label === "urgency_level");
      expect(urgencyFacts).toHaveLength(1);
      expect(urgencyFacts[0].extractedValue).toBe("high");

      // competitorMentions → 1 fact
      const compFacts = facts.filter((f) => f.category === "competitor_reference");
      expect(compFacts).toHaveLength(1);
      expect(compFacts[0].extractedValue).toBe("Acme Corp");
      expect(compFacts[0].confidence).toBe(0.9);

      // budgetMentioned → 1 fact
      const budgetFacts = facts.filter((f) => f.category === "budget_sensitivity");
      expect(budgetFacts).toHaveLength(1);
      expect(budgetFacts[0].extractedValue).toBe("$50k earmarked for Q2");

      // timelineMentioned → 1 fact
      const tlFacts = facts.filter((f) => f.label === "timeline");
      expect(tlFacts).toHaveLength(1);
      expect(tlFacts[0].extractedValue).toBe("Must go live by June");

      // champion → 1 fact
      const champFacts = facts.filter((f) => f.label === "champion");
      expect(champFacts).toHaveLength(1);
      expect(champFacts[0].category).toBe("persona_stakeholder");

      // decision maker → 1 fact
      const dmFacts = facts.filter((f) => f.label === "decision_maker");
      expect(dmFacts).toHaveLength(1);

      // requestedCapabilities → 2 facts
      const rcFacts = facts.filter((f) => f.category === "requested_capability");
      expect(rcFacts).toHaveLength(2);

      // complianceConcerns → 1 fact
      const ccFacts = facts.filter((f) => f.category === "compliance_security");
      expect(ccFacts).toHaveLength(1);

      // sentiment → 1 fact (positive != "neutral")
      const sentFacts = facts.filter((f) => f.category === "sentiment");
      expect(sentFacts).toHaveLength(1);
      expect(sentFacts[0].extractedValue).toBe("positive");
      expect(sentFacts[0].confidence).toBe(0.9);

      // Total: 2+1+1+1+1+1+1+1+1+2+1+1 = 14
      expect(facts).toHaveLength(14);
    });

    it("returns empty array for empty extraction output", () => {
      const output = makeEmptyLlmOutput();
      const facts = fanOutFacts("comp-1", "act-1", "deal-1", output, "source text");
      expect(facts).toHaveLength(0);
    });

    it("skips urgency=none and sentiment=neutral", () => {
      const output: ActivityExtractionOutput = {
        ...makeEmptyLlmOutput(),
        urgency: "none",
        sentiment: "neutral",
      };
      const facts = fanOutFacts("comp-1", "act-1", "deal-1", output, "source text");
      expect(facts).toHaveLength(0);
    });

    it("skips empty-string items in arrays", () => {
      const output: ActivityExtractionOutput = {
        ...makeEmptyLlmOutput(),
        painPoints: ["real pain", "", "  "],
        competitorMentions: ["", "RealComp"],
      };
      const facts = fanOutFacts("comp-1", "act-1", "deal-1", output, "source text");
      const painFacts = facts.filter((f) => f.label.startsWith("pain:"));
      expect(painFacts).toHaveLength(1);
      const compFacts = facts.filter((f) => f.category === "competitor_reference");
      expect(compFacts).toHaveLength(1);
    });

    it("truncates sourceText to 500 chars", () => {
      const longSource = "X".repeat(1000);
      const output: ActivityExtractionOutput = {
        ...makeEmptyLlmOutput(),
        painPoints: ["something"],
      };
      const facts = fanOutFacts("comp-1", "act-1", "deal-1", output, longSource);
      expect(facts[0].sourceText).toHaveLength(500);
    });

    it("truncates sourceText without leaving a broken emoji surrogate", () => {
      const boundarySource = `${"X".repeat(499)}🌍tail`;
      const output: ActivityExtractionOutput = {
        ...makeEmptyLlmOutput(),
        painPoints: ["something"],
      };
      const facts = fanOutFacts("comp-1", "act-1", "deal-1", output, boundarySource);
      expect(Array.from(facts[0].sourceText)).toHaveLength(499);
      expect(facts[0].sourceText).not.toMatch(/[\uD800-\uDFFF]/);
    });

    it("uses budgetDetails value when present, falls back to 'true'", () => {
      const withDetails: ActivityExtractionOutput = {
        ...makeEmptyLlmOutput(),
        budgetMentioned: true,
        budgetDetails: "$100k",
      };
      const withoutDetails: ActivityExtractionOutput = {
        ...makeEmptyLlmOutput(),
        budgetMentioned: true,
        budgetDetails: null,
      };
      const factsA = fanOutFacts("comp-1", "act-1", "deal-1", withDetails, "src");
      const factsB = fanOutFacts("comp-1", "act-1", "deal-1", withoutDetails, "src");
      expect(factsA[0].extractedValue).toBe("$100k");
      expect(factsB[0].extractedValue).toBe("true");
    });

    it("generates deterministic IDs for the same inputs", () => {
      const output: ActivityExtractionOutput = {
        ...makeEmptyLlmOutput(),
        painPoints: ["slow onboarding"],
      };
      const factsA = fanOutFacts("comp-1", "act-1", "deal-1", output, "src");
      const factsB = fanOutFacts("comp-1", "act-1", "deal-1", output, "src");
      expect(factsA[0].id).toBe(factsB[0].id);
      expect(factsA[0].id).toMatch(/^sef_/);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Structural skips
  // -----------------------------------------------------------------------
  describe("structural skips", () => {
    it("no dealId → marked extracted with 0 facts", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity({ dealId: null });

      repos.listUnextractedActivities.mockResolvedValue([activity]);

      const result = await runExtraction(baseParams(repos, llmClient));

      expect(llmClient.generateStructured).not.toHaveBeenCalled();
      expect(txMock.salesActivity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: activity.id },
          data: expect.objectContaining({ extractedAt: expect.any(Date) }),
        })
      );
      expect(result.activitiesSkipped).toBe(1);
      expect(result.factsCreated).toBe(0);
      expect(result.activitiesProcessed).toBe(0);
    });

    it("short body → marked extracted with 0 facts", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity({ body: "short" }); // 5 chars < 50

      repos.listUnextractedActivities.mockResolvedValue([activity]);

      const result = await runExtraction(baseParams(repos, llmClient));

      expect(llmClient.generateStructured).not.toHaveBeenCalled();
      expect(txMock.salesActivity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: activity.id },
          data: expect.objectContaining({ extractedAt: expect.any(Date) }),
        })
      );
      expect(result.activitiesSkipped).toBe(1);
      expect(result.factsCreated).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Retryable LLM failure (timeout)
  // -----------------------------------------------------------------------
  describe("retryable LLM failure", () => {
    it("timeout → NOT marked extracted, incrementExtractionAttempts called, retryableErrors incremented", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity();

      repos.listUnextractedActivities.mockResolvedValue([activity]);
      llmClient.generateStructured.mockRejectedValue(new Error("Request timed out"));
      repos.incrementExtractionAttempts.mockResolvedValue(1);

      const result = await runExtraction(baseParams(repos, llmClient));

      // NOT marked extracted — the transaction for marking should not have been called
      // with the fact-write pattern (upsert). The only tx calls should be from error handling.
      expect(repos.incrementExtractionAttempts).toHaveBeenCalledWith(activity.id);
      expect(result.retryableErrors).toBe(1);
      expect(result.activitiesProcessed).toBe(0);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("Retryable error")])
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5. Rate limit
  // -----------------------------------------------------------------------
  describe("rate limit", () => {
    it("429 → batch stops early, rateLimited flag set", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activities = [
        makeActivity({ id: "act-1" }),
        makeActivity({ id: "act-2" }),
      ];

      repos.listUnextractedActivities.mockResolvedValue(activities);
      llmClient.generateStructured.mockRejectedValue(new Error("429 Too Many Requests"));
      repos.incrementExtractionAttempts.mockResolvedValue(1);

      const result = await runExtraction(baseParams(repos, llmClient));

      expect(result.rateLimited).toBe(true);
      // Only the first activity should have been attempted — batch stops on rate limit
      expect(llmClient.generateStructured).toHaveBeenCalledTimes(1);
      expect(repos.incrementExtractionAttempts).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Zod parse failure → retryable
  // -----------------------------------------------------------------------
  describe("Zod parse failure", () => {
    it("parse error → retryable, not marked extracted", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity();

      repos.listUnextractedActivities.mockResolvedValue([activity]);
      llmClient.generateStructured.mockRejectedValue(new Error("Zod parse error: invalid input"));
      repos.incrementExtractionAttempts.mockResolvedValue(1);

      const result = await runExtraction(baseParams(repos, llmClient));

      expect(repos.incrementExtractionAttempts).toHaveBeenCalledWith(activity.id);
      expect(result.retryableErrors).toBe(1);
      expect(result.activitiesProcessed).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Valid empty extraction → marked extracted, 0 facts (terminalSkips)
  // -----------------------------------------------------------------------
  describe("valid empty extraction", () => {
    it("all-empty LLM output → marked extracted, 0 facts, terminalSkips incremented", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const emptyOutput = makeEmptyLlmOutput();
      const llmClient = makeLlmClient(emptyOutput);
      const activity = makeActivity();

      repos.listUnextractedActivities.mockResolvedValue([activity]);

      const result = await runExtraction(baseParams(repos, llmClient));

      expect(result.activitiesProcessed).toBe(1);
      expect(result.factsCreated).toBe(0);
      expect(result.terminalSkips).toBe(1);

      // Marked as extracted inside the transaction
      expect(txMock.salesActivity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: activity.id },
          data: expect.objectContaining({ extractedAt: expect.any(Date) }),
        })
      );

      // No fact upserts
      expect(txMock.salesExtractedFact.upsert).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 8. Pre-attempt guard (extractionAttempts >= MAX)
  // -----------------------------------------------------------------------
  describe("pre-attempt guard", () => {
    it("activity with extractionAttempts=3 → marked extracted immediately, NO LLM call, exhaustedItems incremented", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity({ extractionAttempts: 3 });

      repos.listUnextractedActivities.mockResolvedValue([activity]);

      const result = await runExtraction(baseParams(repos, llmClient));

      expect(llmClient.generateStructured).not.toHaveBeenCalled();
      expect(result.exhaustedItems).toBe(1);
      expect(result.activitiesProcessed).toBe(0);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("reached retry limit")])
      );

      // Marked extracted via transaction
      expect(txMock.salesActivity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: activity.id },
          data: expect.objectContaining({ extractedAt: expect.any(Date) }),
        })
      );
    });
  });

  // -----------------------------------------------------------------------
  // 9. Post-failure escalation (increment returns 3 → immediately exhausted)
  // -----------------------------------------------------------------------
  describe("post-failure escalation", () => {
    it("LLM fails → increment returns 3 → immediately marked extracted + warning with error", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity({ extractionAttempts: 2 });

      repos.listUnextractedActivities.mockResolvedValue([activity]);
      llmClient.generateStructured.mockRejectedValue(new Error("Request timed out"));
      repos.incrementExtractionAttempts.mockResolvedValue(3); // reaches limit

      const result = await runExtraction(baseParams(repos, llmClient));

      // The activity should be marked extracted via the escalation path
      expect(txMock.salesActivity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: activity.id },
          data: expect.objectContaining({ extractedAt: expect.any(Date) }),
        })
      );
      expect(result.exhaustedItems).toBe(1);
      expect(result.retryableErrors).toBe(0); // escalated, not retryable
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("exhausted after 3 attempts")])
      );
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("timed out")])
      );
    });
  });

  // -----------------------------------------------------------------------
  // 10. Below limit (increment returns 2 → NOT marked extracted)
  // -----------------------------------------------------------------------
  describe("below limit", () => {
    it("LLM fails → increment returns 2 → NOT marked extracted", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity({ extractionAttempts: 1 });

      repos.listUnextractedActivities.mockResolvedValue([activity]);
      llmClient.generateStructured.mockRejectedValue(new Error("Request timed out"));
      repos.incrementExtractionAttempts.mockResolvedValue(2);

      const result = await runExtraction(baseParams(repos, llmClient));

      // NOT marked extracted — no transaction call for marking
      // The only transaction call might be from other activities, but for this one
      // it should not mark extracted
      expect(result.retryableErrors).toBe(1);
      expect(result.exhaustedItems).toBe(0);
      expect(result.activitiesProcessed).toBe(0);

      // tx.salesActivity.update should NOT have been called (no exhaustion, no skip)
      expect(txMock.salesActivity.update).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 11. Partial failure: increment returns 3 but terminalization tx throws
  // -----------------------------------------------------------------------
  describe("partial failure (increment succeeds, terminalization fails)", () => {
    it("increment returns 3 but terminalization tx throws → caught by inner handler, item left at attempts=3 extractedAt=null; next run: pre-guard fires", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity({ extractionAttempts: 2 });

      repos.listUnextractedActivities.mockResolvedValue([activity]);
      llmClient.generateStructured.mockRejectedValue(new Error("Connection timed out"));
      repos.incrementExtractionAttempts.mockResolvedValue(3);

      // The transaction for marking exhausted throws — but this is inside the
      // inner try/catch (lines 319-347 in extraction.ts), so the error is caught
      // and treated as "increment failed" rather than propagating out.
      repos.transaction.mockRejectedValue(new Error("DB connection lost during terminalization"));

      const result = await runExtraction(baseParams(repos, llmClient));

      // increment was called
      expect(repos.incrementExtractionAttempts).toHaveBeenCalledWith(activity.id);

      // The transaction failure was caught by the inner handler — treated as retryable
      expect(result.retryableErrors).toBe(1);
      expect(result.exhaustedItems).toBe(0);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("increment failed")])
      );

      // Activity was NOT marked extracted (transaction failed)
      // In production: item sits at extractionAttempts=3, extractedAt=null

      // Simulate next run: the activity now has extractionAttempts=3 and extractedAt=null
      // The pre-attempt guard should fire and clean up
      const txMock2 = makeTxMock();
      const repos2 = makeRepos(txMock2);
      const llmClient2 = makeLlmClient();
      const activityNextRun = makeActivity({ extractionAttempts: 3 });

      repos2.listUnextractedActivities.mockResolvedValue([activityNextRun]);

      const result2 = await runExtraction(baseParams(repos2, llmClient2));

      expect(llmClient2.generateStructured).not.toHaveBeenCalled();
      expect(result2.exhaustedItems).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 12. Partial failure: increment itself fails
  // -----------------------------------------------------------------------
  describe("partial failure (increment fails)", () => {
    it("increment throws → no budget corruption, treated as retryable", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity();

      repos.listUnextractedActivities.mockResolvedValue([activity]);
      llmClient.generateStructured.mockRejectedValue(new Error("Request timed out"));
      repos.incrementExtractionAttempts.mockRejectedValue(new Error("DB write failed"));

      const result = await runExtraction(baseParams(repos, llmClient));

      expect(result.retryableErrors).toBe(1);
      expect(result.exhaustedItems).toBe(0);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("increment failed")])
      );

      // Activity NOT marked extracted
      expect(txMock.salesActivity.update).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 13. Concurrent cleanup race: body is null
  // -----------------------------------------------------------------------
  describe("concurrent cleanup race", () => {
    it("activity.body is null at processing time → skipped without marking", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity({ body: null });

      repos.listUnextractedActivities.mockResolvedValue([activity]);

      const result = await runExtraction(baseParams(repos, llmClient));

      expect(llmClient.generateStructured).not.toHaveBeenCalled();
      // NOT marked extracted — null body means skip silently
      expect(txMock.salesActivity.update).not.toHaveBeenCalled();
      expect(result.activitiesSkipped).toBe(0);
      expect(result.activitiesProcessed).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 14. Atomicity / crash simulation: fact-write throws in tx
  // -----------------------------------------------------------------------
  describe("atomicity / crash simulation", () => {
    it("fact-write throws in tx → activity is retried, not marked extracted", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity();

      repos.listUnextractedActivities.mockResolvedValue([activity]);

      // Make the transaction execute the callback but have upsert throw
      txMock.salesExtractedFact.upsert.mockRejectedValue(new Error("Disk full — write failed"));

      // The transaction mock should propagate the error (simulating rollback)
      repos.transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        try {
          return await fn(txMock);
        } catch (err) {
          // In a real DB, the entire transaction would be rolled back.
          // The key assertion: the error propagates out.
          throw err;
        }
      });

      repos.incrementExtractionAttempts.mockResolvedValue(1);

      const result = await runExtraction(baseParams(repos, llmClient));

      // The activity.update for marking extracted is inside the same transaction,
      // so in a real DB it would be rolled back. Since our mock executes sequentially,
      // the upsert fail happens before the update (facts are inserted before marking).
      // Verify: deleteFactsForActivity was called (it's the first op in the tx)
      expect(repos.deleteFactsForActivity).toHaveBeenCalledWith(activity.id, txMock);
      expect(repos.incrementExtractionAttempts).toHaveBeenCalledWith(activity.id);
      expect(txMock.salesActivity.update).not.toHaveBeenCalled();
      expect(result.activitiesProcessed).toBe(0);
      expect(result.retryableErrors).toBe(1);
      expect(result.errors).toContain("Retryable write error on act-1: Disk full — write failed");
    });
  });

  // -----------------------------------------------------------------------
  // 15. Lease — blocked
  // -----------------------------------------------------------------------
  describe("lease — blocked", () => {
    it("acquireRunLease throws ConcurrentRunError → runExtraction throws", async () => {
      const repos = makeRepos();
      const llmClient = makeLlmClient();

      repos.acquireRunLease.mockRejectedValue(
        new ConcurrentRunError("run-other-1", "sales:extract")
      );

      await expect(runExtraction(baseParams(repos, llmClient))).rejects.toThrow(
        "Another sales:extract run is already in progress"
      );

      // No activities should have been fetched
      expect(repos.listUnextractedActivities).not.toHaveBeenCalled();
      expect(llmClient.generateStructured).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 16. Lease — lost at pre-write checkpoint
  // -----------------------------------------------------------------------
  describe("lease — lost at pre-write", () => {
    it("renewLease returns false at second call → LLM result discarded, run stops", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity();

      repos.listUnextractedActivities.mockResolvedValue([activity]);

      // renewLease: true at pre-LLM (call 1), false at pre-write (call 2)
      repos.renewLease
        .mockResolvedValueOnce(true)   // pre-LLM checkpoint
        .mockResolvedValueOnce(false); // pre-write checkpoint

      const result = await runExtraction(baseParams(repos, llmClient));

      // LLM was called (lease was valid at pre-LLM)
      expect(llmClient.generateStructured).toHaveBeenCalledTimes(1);

      // But the result was discarded — no transaction for fact writes
      expect(repos.deleteFactsForActivity).not.toHaveBeenCalled();
      expect(txMock.salesExtractedFact.upsert).not.toHaveBeenCalled();

      // No facts created, no activities processed
      expect(result.activitiesProcessed).toBe(0);
      expect(result.factsCreated).toBe(0);

      // finalizeSyncRun should NOT be called (lease was lost)
      expect(repos.finalizeSyncRun).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 17. Lease — renewal failure throws
  // -----------------------------------------------------------------------
  describe("lease — renewal failure throws", () => {
    it("renewLease throws → run stops (renewLeaseOrAbort returns false)", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity();

      repos.listUnextractedActivities.mockResolvedValue([activity]);

      // renewLease throws on first call (pre-LLM checkpoint)
      repos.renewLease.mockRejectedValue(new Error("DB connection dropped"));

      const result = await runExtraction(baseParams(repos, llmClient));

      // LLM should NOT have been called (lease lost at pre-LLM)
      expect(llmClient.generateStructured).not.toHaveBeenCalled();
      expect(result.activitiesProcessed).toBe(0);

      // finalizeSyncRun should NOT be called (lease was lost)
      expect(repos.finalizeSyncRun).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Extra: Zod schema validates correctly
  // -----------------------------------------------------------------------
  describe("activityExtractionSchema", () => {
    it("parses a valid full output", () => {
      const result = activityExtractionSchema.safeParse(makeFullLlmOutput());
      expect(result.success).toBe(true);
    });

    it("rejects invalid urgency value", () => {
      const result = activityExtractionSchema.safeParse({
        ...makeFullLlmOutput(),
        urgency: "critical", // not in enum
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing required fields", () => {
      const result = activityExtractionSchema.safeParse({
        painPoints: [],
        // missing everything else
      });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Precision guards: isLowValueSource
  // -----------------------------------------------------------------------
  describe("isLowValueSource", () => {
    it("returns true when body starts with low-value pattern", () => {
      expect(isLowValueSource("Ordre du jour\n1. Point sur le dossier", ["Ordre du jour"])).toBe(true);
    });

    it("returns true for onboarding template pattern", () => {
      expect(isLowValueSource("Le paramétrage du compte est terminé pour...", ["Le paramétrage du compte"])).toBe(true);
    });

    it("returns false when pattern is not in first 100 chars", () => {
      const body = "A".repeat(120) + "Ordre du jour";
      expect(isLowValueSource(body, ["Ordre du jour"])).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isLowValueSource("ORDRE DU JOUR\n...", ["Ordre du jour"])).toBe(true);
    });

    it("returns false with empty patterns", () => {
      expect(isLowValueSource("Ordre du jour", [])).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Precision guards: filterFacts
  // -----------------------------------------------------------------------
  describe("filterFacts", () => {
    const guards: PrecisionGuards = {
      internalPeople: ["Quentin Franck", "Guillaume Chastant", "Baptiste Le Bihan"],
      internalDomains: ["@linc.fr"],
      selfBrands: ["Linc"],
      lowValueSourcePatterns: [],
      schedulingNoisePatterns: ["appel manqué", "reschedule", "reporter", "décaler", "annulé"],
    };

    function makeFact(overrides: Partial<{ category: string; label: string; extractedValue: string }>) {
      return {
        id: "fact-1",
        companyId: "comp-1",
        activityId: "act-1",
        dealId: "deal-1",
        category: overrides.category ?? "objection_mentioned",
        label: overrides.label ?? "pain:test",
        extractedValue: overrides.extractedValue ?? "test",
        confidence: 0.8,
        sourceText: "some text",
      };
    }

    it("filters out internal people from persona_stakeholder", () => {
      const facts = [makeFact({ category: "persona_stakeholder", label: "champion", extractedValue: "Quentin Franck" })];
      const { kept, dropped } = filterFacts(facts, guards, []);
      expect(kept).toHaveLength(0);
      expect(dropped).toHaveLength(1);
    });

    it("is case-insensitive for internal people", () => {
      const facts = [makeFact({ category: "persona_stakeholder", label: "champion", extractedValue: "QUENTIN FRANCK" })];
      const { kept, dropped } = filterFacts(facts, guards, []);
      expect(kept).toHaveLength(0);
      expect(dropped).toHaveLength(1);
    });

    it("filters out internal domain emails from persona_stakeholder", () => {
      const facts = [makeFact({ category: "persona_stakeholder", label: "decision_maker", extractedValue: "someone@linc.fr" })];
      const { kept, dropped } = filterFacts(facts, guards, []);
      expect(kept).toHaveLength(0);
      expect(dropped).toHaveLength(1);
    });

    it("passes through legitimate champions", () => {
      const facts = [makeFact({ category: "persona_stakeholder", label: "champion", extractedValue: "Marie Dupont" })];
      const { kept } = filterFacts(facts, guards, []);
      expect(kept).toHaveLength(1);
    });

    it("filters out self-brand from competitor_reference", () => {
      const facts = [makeFact({ category: "competitor_reference", label: "linc", extractedValue: "Linc" })];
      const { kept, dropped } = filterFacts(facts, guards, []);
      expect(kept).toHaveLength(0);
      expect(dropped).toHaveLength(1);
    });

    it("filters out account-brand from competitor_reference", () => {
      const facts = [makeFact({ category: "competitor_reference", label: "smartpaie", extractedValue: "SMARTPAIE" })];
      const { kept, dropped } = filterFacts(facts, guards, ["SmartPaie"]);
      expect(kept).toHaveLength(0);
      expect(dropped).toHaveLength(1);
    });

    it("passes through real competitors", () => {
      const facts = [makeFact({ category: "competitor_reference", label: "silae", extractedValue: "Silae" })];
      const { kept } = filterFacts(facts, guards, ["SmartPaie"]);
      expect(kept).toHaveLength(1);
    });

    it("drops scheduling-noise blockers", () => {
      const facts = [makeFact({ category: "objection_mentioned", label: "blocker:appel-manque", extractedValue: "appel manqué et report" })];
      const { kept, dropped } = filterFacts(facts, guards, []);
      expect(kept).toHaveLength(0);
      expect(dropped).toHaveLength(1);
    });

    it("passes through legitimate blockers", () => {
      const facts = [makeFact({ category: "objection_mentioned", label: "blocker:infosec-review", extractedValue: "infosec review pending" })];
      const { kept } = filterFacts(facts, guards, []);
      expect(kept).toHaveLength(1);
    });

    it("does not filter non-stakeholder/non-competitor categories", () => {
      const facts = [makeFact({ category: "urgency_timing", label: "next_step", extractedValue: "Quentin Franck" })];
      const { kept } = filterFacts(facts, guards, []);
      expect(kept).toHaveLength(1);
    });

    it("handles empty guards gracefully", () => {
      const emptyGuards: PrecisionGuards = {
        internalPeople: [],
        internalDomains: [],
        selfBrands: [],
        lowValueSourcePatterns: [],
        schedulingNoisePatterns: [],
      };
      const facts = [makeFact({ category: "persona_stakeholder", label: "champion", extractedValue: "Quentin Franck" })];
      const { kept } = filterFacts(facts, emptyGuards, []);
      expect(kept).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Integration: low-value source skip in runExtraction
  // -----------------------------------------------------------------------
  describe("low-value source skip in runExtraction", () => {
    it("skips extraction for low-value source body", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();

      // Set up doctrine with lowValueSourcePatterns
      repos.getLatestDoctrine.mockResolvedValue({
        doctrineJson: {
          precisionGuards: {
            internalPeople: [],
            internalDomains: [],
            selfBrands: [],
            lowValueSourcePatterns: ["Ordre du jour"],
            schedulingNoisePatterns: [],
          },
        },
      });

      repos.listUnextractedActivities.mockResolvedValue([
        makeActivity({ body: "Ordre du jour\n1. Point dossier\n2. Formation" }),
      ]);

      const result = await runExtraction(baseParams(repos, llmClient));

      // LLM should NOT be called for low-value source
      expect(llmClient.generateStructured).not.toHaveBeenCalled();
      expect(result.activitiesSkipped).toBe(1);
      expect(result.factsCreated).toBe(0);
      expect(repos.deleteFactsForActivity).toHaveBeenCalledWith("act-1", txMock);
    });

    it("clears stale facts when activity is skipped by stage scope", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();

      repos.getLatestDoctrine.mockResolvedValue({
        doctrineJson: {
          stageLabels: {
            "stage-new": "New",
            "stage-training": "Training",
          },
          intelligenceStages: ["New"],
          precisionGuards: {
            internalPeople: [],
            internalDomains: [],
            selfBrands: [],
            lowValueSourcePatterns: [],
            schedulingNoisePatterns: [],
          },
        },
      });

      repos.listUnextractedActivities.mockResolvedValue([
        makeActivity({ id: "act-stage", dealId: "deal-1", body: "A".repeat(200) }),
      ]);
      repos.listDealsForStageCheck.mockResolvedValue(new Map([["deal-1", "stage-training"]]));

      const result = await runExtraction(baseParams(repos, llmClient));

      expect(llmClient.generateStructured).not.toHaveBeenCalled();
      expect(result.stageSkipped).toBe(1);
      expect(repos.deleteFactsForActivity).toHaveBeenCalledWith("act-stage", txMock);
    });
  });

  // -----------------------------------------------------------------------
  // coerceGuards — runtime safety for partial / malformed doctrine config
  // -----------------------------------------------------------------------
  describe("coerceGuards", () => {
    it("returns EMPTY_GUARDS for null/undefined input", () => {
      expect(coerceGuards(null)).toEqual({
        internalPeople: [],
        internalDomains: [],
        selfBrands: [],
        lowValueSourcePatterns: [],
        schedulingNoisePatterns: [],
      });
      expect(coerceGuards(undefined)).toEqual(coerceGuards(null));
    });

    it("returns EMPTY_GUARDS for non-object input", () => {
      expect(coerceGuards("string")).toEqual(coerceGuards(null));
      expect(coerceGuards(42)).toEqual(coerceGuards(null));
      expect(coerceGuards(true)).toEqual(coerceGuards(null));
    });

    it("fills missing fields with empty arrays", () => {
      const result = coerceGuards({ internalPeople: ["Alice"] });
      expect(result.internalPeople).toEqual(["Alice"]);
      expect(result.internalDomains).toEqual([]);
      expect(result.selfBrands).toEqual([]);
      expect(result.lowValueSourcePatterns).toEqual([]);
      expect(result.schedulingNoisePatterns).toEqual([]);
    });

    it("filters out non-string elements from arrays", () => {
      const result = coerceGuards({
        internalPeople: ["Alice", 123, null, "Bob", undefined],
        selfBrands: [true, "Linc"],
      });
      expect(result.internalPeople).toEqual(["Alice", "Bob"]);
      expect(result.selfBrands).toEqual(["Linc"]);
    });

    it("coerces non-array field values to empty arrays", () => {
      const result = coerceGuards({
        internalPeople: "not-an-array",
        internalDomains: 42,
        selfBrands: { nested: true },
      });
      expect(result.internalPeople).toEqual([]);
      expect(result.internalDomains).toEqual([]);
      expect(result.selfBrands).toEqual([]);
    });

    it("passes through a fully valid config unchanged", () => {
      const valid: PrecisionGuards = {
        internalPeople: ["Alice"],
        internalDomains: ["@acme.com"],
        selfBrands: ["Acme"],
        lowValueSourcePatterns: ["Ordre du jour"],
        schedulingNoisePatterns: ["reschedule"],
      };
      expect(coerceGuards(valid)).toEqual(valid);
    });
  });

  // -----------------------------------------------------------------------
  // Partial guard config in runExtraction — must not crash
  // -----------------------------------------------------------------------
  describe("partial guard config does not crash extraction", () => {
    it("handles doctrine with only some guard fields", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient(makeEmptyLlmOutput());

      // Doctrine has a partial precisionGuards — missing several fields
      repos.getLatestDoctrine.mockResolvedValue({
        doctrineJson: {
          precisionGuards: { internalPeople: ["Quentin Franck"] },
          // no selfBrands, no schedulingNoisePatterns, etc.
        },
      });

      repos.listUnextractedActivities.mockResolvedValue([
        makeActivity({ body: "A".repeat(200) }),
      ]);

      // Should not throw — coerceGuards fills defaults
      const result = await runExtraction(baseParams(repos, llmClient));
      expect(result.activitiesProcessed).toBe(1);
    });

    it("handles doctrine with precisionGuards set to a non-object value", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient(makeEmptyLlmOutput());

      repos.getLatestDoctrine.mockResolvedValue({
        doctrineJson: {
          precisionGuards: "garbage",
        },
      });

      repos.listUnextractedActivities.mockResolvedValue([
        makeActivity({ body: "A".repeat(200) }),
      ]);

      const result = await runExtraction(baseParams(repos, llmClient));
      expect(result.activitiesProcessed).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // CLI batch-size validation (via runSalesCommand)
  // -----------------------------------------------------------------------
  describe("CLI batch-size validation", () => {
    // We test runSalesCommand directly to verify argument parsing
    let originalArgv: string[];
    beforeEach(() => { originalArgv = process.argv; });
    afterEach(() => { process.argv = originalArgv; });

    async function runCli(args: string[]) {
      process.argv = ["node", "cli.ts", "sales:extract", ...args];

      // Lazy import to avoid circular issues
      const { runSalesCommand } = await import("../src/sales/cli.js");
      const exitCode = { value: 0 };
      const mockApp = {
        runExtract: vi.fn().mockResolvedValue({
          activitiesProcessed: 0, activitiesSkipped: 0, factsCreated: 0,
          retryableErrors: 0, exhaustedItems: 0, stageSkipped: 0, terminalSkips: 0,
          errors: [], warnings: [], costUsd: 0, rateLimited: false,
          capabilityStats: { totalFacts: 0, activitiesWithCapabilities: 0, activitiesProcessed: 0, meanPerActivity: 0, maxPerActivity: 0 },
        }),
      } as any;
      const mockPrisma = {
        company: { findUnique: vi.fn().mockResolvedValue({ id: "c1", name: "Test", slug: "default" }) },
      } as any;
      const mockEnv = {} as any;
      const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

      await runSalesCommand({
        command: "sales:extract",
        app: mockApp,
        prisma: mockPrisma,
        env: mockEnv,
        logger: mockLogger,
        exit: (code: number) => { exitCode.value = code; },
      });

      return { exitCode: exitCode.value, app: mockApp, logger: mockLogger };
    }

    it("rejects --batch-size with non-numeric value", async () => {
      const { exitCode, app } = await runCli(["--batch-size", "abc"]);
      expect(exitCode).toBe(1);
      expect(app.runExtract).not.toHaveBeenCalled();
    });

    it("rejects --batch-size 0", async () => {
      const { exitCode, app } = await runCli(["--batch-size", "0"]);
      expect(exitCode).toBe(1);
      expect(app.runExtract).not.toHaveBeenCalled();
    });

    it("rejects --batch-size above 1000", async () => {
      const { exitCode, app } = await runCli(["--batch-size", "1001"]);
      expect(exitCode).toBe(1);
      expect(app.runExtract).not.toHaveBeenCalled();
    });

    it("rejects --batch-size without a value", async () => {
      const { exitCode, app } = await runCli(["--batch-size"]);
      expect(exitCode).toBe(1);
      expect(app.runExtract).not.toHaveBeenCalled();
    });

    it("rejects --batch-size with a float like 1.5", async () => {
      const { exitCode, app } = await runCli(["--batch-size", "1.5"]);
      expect(exitCode).toBe(1);
      expect(app.runExtract).not.toHaveBeenCalled();
    });

    it("rejects --batch-size with trailing garbage like 100abc", async () => {
      const { exitCode, app } = await runCli(["--batch-size", "100abc"]);
      expect(exitCode).toBe(1);
      expect(app.runExtract).not.toHaveBeenCalled();
    });

    it("accepts --batch-size 100", async () => {
      const { exitCode, app } = await runCli(["--batch-size", "100"]);
      expect(exitCode).toBe(0);
      expect(app.runExtract).toHaveBeenCalledWith("c1", expect.objectContaining({ batchSize: 100 }));
    });

    it("--drain passes drain flag and no explicit batchSize", async () => {
      const { exitCode, app } = await runCli(["--drain"]);
      expect(exitCode).toBe(0);
      expect(app.runExtract).toHaveBeenCalledWith("c1", expect.objectContaining({ drain: true }));
      // batchSize should be undefined (drain loop sets its own default)
      const callOpts = app.runExtract.mock.calls[0][1];
      expect(callOpts.batchSize).toBeUndefined();
    });

    it("--activity-ids passes activityIds array to runExtract", async () => {
      const { exitCode, app } = await runCli(["--activity-ids", "act-1,act-2,act-3"]);
      expect(exitCode).toBe(0);
      expect(app.runExtract).toHaveBeenCalledWith("c1", expect.objectContaining({
        activityIds: ["act-1", "act-2", "act-3"],
      }));
    });

    it("rejects --activity-ids without a value", async () => {
      const { exitCode, app } = await runCli(["--activity-ids"]);
      expect(exitCode).toBe(1);
      expect(app.runExtract).not.toHaveBeenCalled();
    });

    it("rejects --activity-ids with more than 50 IDs", async () => {
      const ids = Array.from({ length: 51 }, (_, i) => `act-${i}`).join(",");
      const { exitCode, app } = await runCli(["--activity-ids", ids]);
      expect(exitCode).toBe(1);
      expect(app.runExtract).not.toHaveBeenCalled();
    });

    it("rejects --activity-ids combined with --reprocess", async () => {
      const { exitCode, app } = await runCli(["--activity-ids", "act-1", "--reprocess"]);
      expect(exitCode).toBe(1);
      expect(app.runExtract).not.toHaveBeenCalled();
    });

    it("rejects --activity-ids combined with --drain", async () => {
      const { exitCode, app } = await runCli(["--activity-ids", "act-1", "--drain"]);
      expect(exitCode).toBe(1);
      expect(app.runExtract).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// scoreCapability — behavior-based ranking
// ---------------------------------------------------------------------------

describe("scoreCapability", () => {
  it("scores every 3-5 word capability higher than every single-word generic", () => {
    const specific = ["HMRC RTI filing", "absence tracking with calendar sync", "SSO via SAML 2.0"];
    const generic = ["reporting", "payroll", "analytics"];
    for (const s of specific) {
      for (const g of generic) {
        expect(scoreCapability(s), `${s} should score higher than ${g}`).toBeGreaterThan(scoreCapability(g));
      }
    }
  });

  it("scores 3-5 word phrases at top tier (2)", () => {
    expect(scoreCapability("HMRC RTI filing")).toBe(2);
    expect(scoreCapability("absence tracking with calendar sync")).toBe(2);
  });

  it("scores single words at zero", () => {
    expect(scoreCapability("reporting")).toBe(0);
    expect(scoreCapability("payroll")).toBe(0);
  });

  it("penalizes verbose capabilities (6+ words)", () => {
    expect(scoreCapability("comprehensive integrated payroll management and processing solution")).toBe(1);
  });

  it("sorting by score desc then input order keeps most specific first", () => {
    const capabilities = [
      "reporting",                                   // 0, order 0
      "HMRC RTI filing",                             // 2, order 1
      "mobile app",                                  // 1, order 2
      "absence tracking with calendar sync",         // 2, order 3
      "analytics",                                   // 0, order 4
      "SSO via SAML 2.0",                            // 2, order 5
      "comprehensive payroll mgmt solution for enterprises", // 1, order 6
      "audit log export",                            // 1, order 7
    ];

    const sorted = capabilities
      .map((c, i) => ({ value: c, score: scoreCapability(c), order: i }))
      .sort((a, b) => b.score - a.score || a.order - b.order);

    const top3 = sorted.slice(0, 3);
    // All top-3 are score-2 items, in original order
    expect(top3.map((c) => c.value)).toEqual([
      "HMRC RTI filing",
      "absence tracking with calendar sync",
      "SSO via SAML 2.0",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Targeted extraction path (activityIds)
// ---------------------------------------------------------------------------

describe("targeted extraction (activityIds)", () => {
  function makeTxMockLocal() {
    return {
      salesExtractedFact: { upsert: vi.fn().mockResolvedValue({}) },
      salesActivity: { update: vi.fn().mockResolvedValue({}) },
      costLedgerEntry: { create: vi.fn().mockResolvedValue({}) },
    };
  }

  function makeReposLocal(txMock: ReturnType<typeof makeTxMockLocal>) {
    return {
      acquireRunLease: vi.fn().mockResolvedValue(undefined),
      renewLease: vi.fn().mockResolvedValue(true),
      finalizeSyncRun: vi.fn().mockResolvedValue(undefined),
      listUnextractedActivities: vi.fn().mockResolvedValue([]),
      listActivitiesByIdScoped: vi.fn().mockResolvedValue([]),
      getLatestDoctrine: vi.fn().mockResolvedValue(null),
      listDealsForStageCheck: vi.fn().mockResolvedValue(new Map()),
      listCompanyNamesForDeals: vi.fn().mockResolvedValue(new Map()),
      deleteFactsForActivity: vi.fn().mockResolvedValue(undefined),
      incrementExtractionAttempts: vi.fn().mockResolvedValue(1),
      transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<void>) => fn(txMock)),
    } as any;
  }

  function makeLlmClientLocal() {
    return {
      generateStructured: vi.fn().mockResolvedValue({
        output: {
          painPoints: [], blockers: [], nextStep: null, urgency: null,
          competitorMentions: [], budgetMentioned: false, budgetDetails: null,
          timelineMentioned: false, timelineDetails: null, championIdentified: null,
          decisionMakerMentioned: null, sentiment: "neutral" as const,
          requestedCapabilities: ["SSO integration"], complianceConcerns: [],
        },
        usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
      }),
    } as any;
  }

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

  it("processes only requested activityIds when provided", async () => {
    const txMock = makeTxMockLocal();
    const repos = makeReposLocal(txMock);
    const llmClient = makeLlmClientLocal();

    const targetActivity = makeActivity({ id: "canary-1", dealId: "deal-1" });
    repos.listActivitiesByIdScoped.mockResolvedValue([targetActivity]);

    const result = await runExtraction({
      companyId: "comp-1", repos, llmClient, logger,
      activityIds: ["canary-1"],
    });

    expect(repos.listActivitiesByIdScoped).toHaveBeenCalledWith("comp-1", ["canary-1"]);
    expect(repos.listUnextractedActivities).not.toHaveBeenCalled();
    expect(result.activitiesProcessed).toBe(1);
  });

  it("targeted fetch excludes activities from other tenants", async () => {
    const txMock = makeTxMockLocal();
    const repos = makeReposLocal(txMock);
    const llmClient = makeLlmClientLocal();

    // listActivitiesByIdScoped returns empty — the ID exists but under a different companyId
    repos.listActivitiesByIdScoped.mockResolvedValue([]);

    const result = await runExtraction({
      companyId: "comp-1", repos, llmClient, logger,
      activityIds: ["cross-tenant-act-1"],
    });

    expect(repos.listActivitiesByIdScoped).toHaveBeenCalledWith("comp-1", ["cross-tenant-act-1"]);
    expect(result.activitiesProcessed).toBe(0);
  });

  it("targeted mode still skips activities with short body", async () => {
    const txMock = makeTxMockLocal();
    const repos = makeReposLocal(txMock);
    const llmClient = makeLlmClientLocal();

    const shortBodyActivity = makeActivity({ id: "canary-1", body: "too short", dealId: "deal-1" });
    repos.listActivitiesByIdScoped.mockResolvedValue([shortBodyActivity]);

    const result = await runExtraction({
      companyId: "comp-1", repos, llmClient, logger,
      activityIds: ["canary-1"],
    });

    expect(result.activitiesSkipped).toBe(1);
    expect(result.activitiesProcessed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mergeExtractionResults
// ---------------------------------------------------------------------------

describe("mergeExtractionResults", () => {
  function emptyResult(): ExtractionResult {
    return {
      activitiesProcessed: 0, activitiesSkipped: 0, stageSkipped: 0,
      factsCreated: 0, retryableErrors: 0, terminalSkips: 0, exhaustedItems: 0,
      errors: [], warnings: [], costUsd: 0, rateLimited: false,
      capabilityStats: { totalFacts: 0, activitiesWithCapabilities: 0, activitiesProcessed: 0, meanPerActivity: 0, maxPerActivity: 0 },
    };
  }

  it("sums numeric fields and concatenates arrays", () => {
    const target = emptyResult();
    const source: ExtractionResult = {
      activitiesProcessed: 5, activitiesSkipped: 3, stageSkipped: 2,
      factsCreated: 10, retryableErrors: 1, terminalSkips: 1, exhaustedItems: 0,
      errors: ["err1"], warnings: ["warn1"], costUsd: 0.01, rateLimited: false,
      capabilityStats: { totalFacts: 0, activitiesWithCapabilities: 0, activitiesProcessed: 0, meanPerActivity: 0, maxPerActivity: 0 },
    };
    mergeExtractionResults(target, source);
    expect(target.activitiesProcessed).toBe(5);
    expect(target.activitiesSkipped).toBe(3);
    expect(target.stageSkipped).toBe(2);
    expect(target.factsCreated).toBe(10);
    expect(target.retryableErrors).toBe(1);
    expect(target.errors).toEqual(["err1"]);
    expect(target.warnings).toEqual(["warn1"]);
    expect(target.costUsd).toBeCloseTo(0.01);
  });

  it("propagates rateLimited from source", () => {
    const target = emptyResult();
    const source = { ...emptyResult(), rateLimited: true };
    mergeExtractionResults(target, source);
    expect(target.rateLimited).toBe(true);
  });

  it("accumulates across multiple merges", () => {
    const target = emptyResult();
    mergeExtractionResults(target, { ...emptyResult(), activitiesProcessed: 3, factsCreated: 6 });
    mergeExtractionResults(target, { ...emptyResult(), activitiesProcessed: 2, factsCreated: 4 });
    expect(target.activitiesProcessed).toBe(5);
    expect(target.factsCreated).toBe(10);
  });

  it("merges capabilityStats: sums totals, takes max, recomputes mean over all processed", () => {
    const target = emptyResult();
    // 5 activities processed, 2 had capabilities, 4 total facts → mean = 4/5 = 0.8
    target.capabilityStats = { totalFacts: 4, activitiesWithCapabilities: 2, activitiesProcessed: 5, meanPerActivity: 0.8, maxPerActivity: 3 };
    const source: ExtractionResult = {
      ...emptyResult(),
      // 3 activities processed, 3 had capabilities, 6 total facts → mean = 6/3 = 2
      capabilityStats: { totalFacts: 6, activitiesWithCapabilities: 3, activitiesProcessed: 3, meanPerActivity: 2, maxPerActivity: 5 },
    };
    mergeExtractionResults(target, source);
    expect(target.capabilityStats.totalFacts).toBe(10);
    expect(target.capabilityStats.activitiesWithCapabilities).toBe(5);
    expect(target.capabilityStats.activitiesProcessed).toBe(8);
    expect(target.capabilityStats.maxPerActivity).toBe(5);
    expect(target.capabilityStats.meanPerActivity).toBeCloseTo(1.25); // 10/8
  });

  it("handles merge when target capabilityStats is empty", () => {
    const target = emptyResult();
    const source: ExtractionResult = {
      ...emptyResult(),
      capabilityStats: { totalFacts: 3, activitiesWithCapabilities: 1, activitiesProcessed: 2, meanPerActivity: 1.5, maxPerActivity: 3 },
    };
    mergeExtractionResults(target, source);
    expect(target.capabilityStats.totalFacts).toBe(3);
    expect(target.capabilityStats.activitiesProcessed).toBe(2);
    expect(target.capabilityStats.meanPerActivity).toBeCloseTo(1.5); // 3/2
  });

  it("meanPerActivity includes zero-capability activities in denominator", () => {
    const target = emptyResult();
    // 10 activities processed, only 3 had capabilities, 6 total facts
    target.capabilityStats = { totalFacts: 6, activitiesWithCapabilities: 3, activitiesProcessed: 10, meanPerActivity: 0.6, maxPerActivity: 4 };
    const source = emptyResult();
    // 5 more activities processed, 0 had capabilities
    source.capabilityStats = { totalFacts: 0, activitiesWithCapabilities: 0, activitiesProcessed: 5, meanPerActivity: 0, maxPerActivity: 0 };
    mergeExtractionResults(target, source);
    expect(target.capabilityStats.activitiesProcessed).toBe(15);
    expect(target.capabilityStats.totalFacts).toBe(6);
    expect(target.capabilityStats.meanPerActivity).toBeCloseTo(0.4); // 6/15 — recall dilution is visible
  });

  it("emptyResult includes zeroed capabilityStats", () => {
    const result = emptyResult();
    expect(result.capabilityStats).toEqual({
      totalFacts: 0, activitiesWithCapabilities: 0, activitiesProcessed: 0, meanPerActivity: 0, maxPerActivity: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Drain loop (SalesApp.runExtract with drain: true)
// ---------------------------------------------------------------------------

describe("SalesApp drain loop", () => {
  // We test the drain loop by mocking runExtraction at the module level.
  // SalesApp.runExtract calls runExtraction in a loop when drain=true.

  let mockRunExtraction: ReturnType<typeof vi.fn>;
  let SalesApp: typeof import("../src/sales/app.js").SalesApp;

  function emptyResult(): ExtractionResult {
    return {
      activitiesProcessed: 0, activitiesSkipped: 0, stageSkipped: 0,
      factsCreated: 0, retryableErrors: 0, terminalSkips: 0, exhaustedItems: 0,
      errors: [], warnings: [], costUsd: 0, rateLimited: false,
      capabilityStats: { totalFacts: 0, activitiesWithCapabilities: 0, activitiesProcessed: 0, meanPerActivity: 0, maxPerActivity: 0 },
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    mockRunExtraction = vi.fn();

    // Mock the extraction module
    vi.doMock("../src/sales/services/extraction.js", () => ({
      runExtraction: mockRunExtraction,
    }));

    // Re-import SalesApp so it picks up the mocked runExtraction
    const appModule = await import("../src/sales/app.js");
    SalesApp = appModule.SalesApp;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildApp() {
    const mockPrisma = {} as any;
    const env = {
      LOG_LEVEL: "silent",
      SALES_LLM_PROVIDER: "openai",
      SALES_LLM_MODEL: "gpt-4.1-mini",
    } as any;
    return new SalesApp(mockPrisma, env);
  }

  it("drains until empty (queue_empty)", async () => {
    mockRunExtraction
      .mockResolvedValueOnce({ ...emptyResult(), activitiesProcessed: 3, factsCreated: 6 })
      .mockResolvedValueOnce({ ...emptyResult(), activitiesProcessed: 2, factsCreated: 4 })
      .mockResolvedValueOnce(emptyResult()); // nothing handled

    const result = await buildApp().runExtract("comp-1", { drain: true });
    expect(result.stopReason).toBe("queue_empty");
    expect(result.iterations).toBe(3);
    expect(result.activitiesProcessed).toBe(5);
    expect(result.factsCreated).toBe(10);
  });

  it("stops on backlog-reduction stall after 2 consecutive zero-drain iterations", async () => {
    // First iteration: processes items (progress)
    mockRunExtraction
      .mockResolvedValueOnce({ ...emptyResult(), activitiesProcessed: 3, factsCreated: 6 })
      // Next two: only retryable errors (no items drained)
      .mockResolvedValueOnce({ ...emptyResult(), retryableErrors: 2 })
      .mockResolvedValueOnce({ ...emptyResult(), retryableErrors: 2 });

    const result = await buildApp().runExtract("comp-1", { drain: true });
    expect(result.stopReason).toBe("stalled");
    expect(result.iterations).toBe(3);
    expect(result.activitiesProcessed).toBe(3);
    expect(result.retryableErrors).toBe(4);
  });

  it("counts skips as progress (backlog reduction)", async () => {
    // Iteration 1: only skips (still drains items from the queue)
    mockRunExtraction
      .mockResolvedValueOnce({ ...emptyResult(), activitiesSkipped: 50 })
      // Iteration 2: only skips
      .mockResolvedValueOnce({ ...emptyResult(), activitiesSkipped: 20 })
      // Iteration 3: empty
      .mockResolvedValueOnce(emptyResult());

    const result = await buildApp().runExtract("comp-1", { drain: true });
    expect(result.stopReason).toBe("queue_empty");
    expect(result.iterations).toBe(3);
    // Skips should NOT trigger the stall safeguard
    expect(result.activitiesSkipped).toBe(70);
  });

  it("stops after rate limit backoff + second rate limit", async () => {
    vi.useFakeTimers();

    mockRunExtraction
      .mockResolvedValueOnce({ ...emptyResult(), activitiesProcessed: 5, rateLimited: true })
      // After backoff, rate-limited again
      .mockResolvedValueOnce({ ...emptyResult(), rateLimited: true });

    const promise = buildApp().runExtract("comp-1", { drain: true });
    // Advance past the 60s rate-limit backoff
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;

    expect(result.stopReason).toBe("rate_limited");
    expect(result.rateLimited).toBe(true);
    expect(result.activitiesProcessed).toBe(5);

    vi.useRealTimers();
  });

  it("respects iteration cap", async () => {
    // Always return some progress so it never stops early
    mockRunExtraction.mockResolvedValue({ ...emptyResult(), activitiesProcessed: 1, factsCreated: 1 });

    const result = await buildApp().runExtract("comp-1", { drain: true });
    expect(result.stopReason).toBe("iteration_cap");
    expect(result.iterations).toBe(20);
    expect(result.activitiesProcessed).toBe(20);
  });

  it("exhaustedItems count as backlog reduction", async () => {
    // Two iterations that only exhaust items (still progress — items leave the queue)
    mockRunExtraction
      .mockResolvedValueOnce({ ...emptyResult(), exhaustedItems: 5 })
      .mockResolvedValueOnce(emptyResult()); // empty

    const result = await buildApp().runExtract("comp-1", { drain: true });
    expect(result.stopReason).toBe("queue_empty");
    expect(result.exhaustedItems).toBe(5);
  });

  it("queue_empty on last iteration is NOT rewritten to iteration_cap", async () => {
    // 19 iterations with progress, then 20th returns empty
    let callCount = 0;
    mockRunExtraction.mockImplementation(() => {
      callCount++;
      if (callCount < 20) {
        return Promise.resolve({ ...emptyResult(), activitiesProcessed: 1, factsCreated: 1 });
      }
      return Promise.resolve(emptyResult()); // empty on iteration 20
    });

    const result = await buildApp().runExtract("comp-1", { drain: true });
    expect(result.iterations).toBe(20);
    expect(result.stopReason).toBe("queue_empty");
  });

  it("zero-drain rate-limited iterations report rate_limited, not stalled", async () => {
    // Both iterations: rate-limited with 0 items drained.
    // Must report rate_limited, not stalled — the stall counter must not
    // fire before the rate-limit logic gets a chance to classify the stop.
    vi.useFakeTimers();

    mockRunExtraction
      .mockResolvedValueOnce({ ...emptyResult(), rateLimited: true })
      .mockResolvedValueOnce({ ...emptyResult(), rateLimited: true });

    const promise = buildApp().runExtract("comp-1", { drain: true });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;

    expect(result.stopReason).toBe("rate_limited");
    expect(result.rateLimited).toBe(true);
    expect(result.activitiesProcessed).toBe(0);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Drain + extraction integration: starvation prevention
// ---------------------------------------------------------------------------

describe("drain starvation prevention (behavior-level)", () => {
  // Proves that the extraction query ordering (extractionAttempts ASC)
  // means older unattempted items are reached even when newer retryable
  // items exist. Uses real runExtraction with mocked repos/llm.

  it("processes unattempted items before retryable ones in a single batch", async () => {
    // Set up two activities: one retryable (attempts=1, newer), one fresh (attempts=0, older)
    const retryableActivity = makeActivity({
      id: "act-retryable",
      extractionAttempts: 1,
      timestamp: new Date("2026-03-20"), // newer
    });
    const freshActivity = makeActivity({
      id: "act-fresh",
      extractionAttempts: 0,
      timestamp: new Date("2026-03-10"), // older
    });

    const txMock = makeTxMock();
    const repos = makeRepos(txMock);
    // Return retryable first (as it would be without the fix — timestamp DESC)
    // but the real query orders by extractionAttempts ASC so fresh comes first.
    // We simulate the correct ordering here to verify the processing behavior.
    repos.listUnextractedActivities.mockResolvedValue([freshActivity, retryableActivity]);
    repos.listDealsForStageCheck.mockResolvedValue(new Map([["deal-1", "stage-new"]]));
    repos.listCompanyNamesForDeals.mockResolvedValue(new Map());
    repos.getLatestDoctrine.mockResolvedValue({
      doctrineJson: {
        stageLabels: { "stage-new": "New" },
        intelligenceStages: ["New"],
      },
    });

    const llmClient = makeLlmClient(makeFullLlmOutput());

    const result = await runExtraction({
      companyId: "comp-1",
      repos: repos as any,
      llmClient: llmClient as any,
      logger: mockLogger,
      runId: "run-starvation-test",
    });

    // Both activities should be processed — the fresh one first
    expect(result.activitiesProcessed).toBe(2);
    expect(llmClient.generateStructured).toHaveBeenCalledTimes(2);

    // Verify the first LLM call was for the fresh (unattempted) activity
    const firstCallPrompt = llmClient.generateStructured.mock.calls[0][0].prompt;
    expect(firstCallPrompt).toContain(freshActivity.body!.slice(0, 50));

    // Verify the second LLM call was for the retryable activity
    const secondCallPrompt = llmClient.generateStructured.mock.calls[1][0].prompt;
    expect(secondCallPrompt).toContain(retryableActivity.body!.slice(0, 50));
  });
});

// ---------------------------------------------------------------------------
// SalesApp.runExtract — targeted mode guards
// ---------------------------------------------------------------------------

describe("SalesApp.runExtract targeted mode", () => {
  let mockRunExtraction: ReturnType<typeof vi.fn>;
  let SalesApp: typeof import("../src/sales/app.js").SalesApp;

  function emptyResult(): ExtractionResult {
    return {
      activitiesProcessed: 0, activitiesSkipped: 0, stageSkipped: 0,
      factsCreated: 0, retryableErrors: 0, terminalSkips: 0, exhaustedItems: 0,
      errors: [], warnings: [], costUsd: 0, rateLimited: false,
      capabilityStats: { totalFacts: 0, activitiesWithCapabilities: 0, activitiesProcessed: 0, meanPerActivity: 0, maxPerActivity: 0 },
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    mockRunExtraction = vi.fn().mockResolvedValue(emptyResult());

    vi.doMock("../src/sales/services/extraction.js", () => ({
      runExtraction: mockRunExtraction,
    }));

    const appModule = await import("../src/sales/app.js");
    SalesApp = appModule.SalesApp;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildApp() {
    const mockPrisma = {} as any;
    const env = {
      LOG_LEVEL: "silent",
      SALES_LLM_PROVIDER: "openai",
      SALES_LLM_MODEL: "gpt-4.1-mini",
    } as any;
    return new SalesApp(mockPrisma, env);
  }

  it("passes activityIds to runExtraction", async () => {
    await buildApp().runExtract("comp-1", { activityIds: ["act-1", "act-2"] });

    expect(mockRunExtraction).toHaveBeenCalledTimes(1);
    expect(mockRunExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "comp-1", activityIds: ["act-1", "act-2"] })
    );
  });

  it("targeted mode does not enter drain loop", async () => {
    await buildApp().runExtract("comp-1", { activityIds: ["act-1"] });

    // Should be called exactly once (no loop)
    expect(mockRunExtraction).toHaveBeenCalledTimes(1);
  });

  it("rejects activityIds combined with reprocess", async () => {
    await expect(
      buildApp().runExtract("comp-1", { activityIds: ["act-1"], reprocess: true })
    ).rejects.toThrow("--activity-ids cannot be combined with --reprocess or --drain");

    expect(mockRunExtraction).not.toHaveBeenCalled();
  });

  it("rejects activityIds combined with drain", async () => {
    await expect(
      buildApp().runExtract("comp-1", { activityIds: ["act-1"], drain: true })
    ).rejects.toThrow("--activity-ids cannot be combined with --reprocess or --drain");

    expect(mockRunExtraction).not.toHaveBeenCalled();
  });
});
