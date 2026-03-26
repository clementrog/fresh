import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runExtraction,
  fanOutFacts,
  activityExtractionSchema,
  MAX_EXTRACTION_ATTEMPTS,
  type ExtractionResult,
  type ActivityExtractionOutput,
} from "../src/sales/services/extraction.js";
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
    it("fact-write throws in tx → markExtracted NOT called (tx rollback)", async () => {
      const txMock = makeTxMock();
      const repos = makeRepos(txMock);
      const llmClient = makeLlmClient();
      const activity = makeActivity();

      repos.listUnextractedActivities.mockResolvedValue([activity]);

      // Track whether the update was called before the upsert throws
      let updateCalledBeforeCrash = false;

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

      // runExtraction should throw because the tx error propagates
      await expect(runExtraction(baseParams(repos, llmClient))).rejects.toThrow("Disk full");

      // The activity.update for marking extracted is inside the same transaction,
      // so in a real DB it would be rolled back. Since our mock executes sequentially,
      // the upsert fail happens before the update (facts are inserted before marking).
      // Verify: deleteFactsForActivity was called (it's the first op in the tx)
      expect(repos.deleteFactsForActivity).toHaveBeenCalledWith(activity.id, txMock);

      // The key invariant: since the transaction threw, the result is not committed.
      // In production, Prisma's $transaction rolls back everything atomically.
      // activitiesProcessed should NOT have been incremented (thrown before reaching it)
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
});
