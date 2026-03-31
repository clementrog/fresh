import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runIntelligencePipeline, decideCreateOrEnrich } from "../src/services/intelligence.js";
import type { NormalizedSourceItem, ContentOpportunity, EvidenceReference, ScreeningResult, UserRecord } from "../src/domain/types.js";

const _originalGateMode = process.env.ANGLE_QUALITY_GATE;
const _originalDepthMode = process.env.EXTRACTION_DEPTH_MODE;
beforeAll(() => { process.env.ANGLE_QUALITY_GATE = "v1"; });
afterAll(() => {
  if (_originalGateMode !== undefined) process.env.ANGLE_QUALITY_GATE = _originalGateMode;
  else delete process.env.ANGLE_QUALITY_GATE;
  if (_originalDepthMode !== undefined) process.env.EXTRACTION_DEPTH_MODE = _originalDepthMode;
  else delete process.env.EXTRACTION_DEPTH_MODE;
});
beforeEach(() => { delete process.env.EXTRACTION_DEPTH_MODE; });

// ---------- fixtures ----------

function makeItem(overrides: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem {
  return {
    source: "market-research",
    sourceItemId: "market-query:mq-1:set:hash-1",
    externalId: "market-research:mq-1:hash-1",
    sourceFingerprint: "market-research-fp-1",
    sourceUrl: "https://example.com",
    title: "Market proof that buyers now expect concrete onboarding evidence",
    summary: "Repeated market research shows buyers dismiss generic onboarding claims.",
    text: "Repeated market research shows buyers dismiss generic onboarding claims and respond to specific, repeated proof from real implementation outcomes.",
    occurredAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    metadata: { kind: "market_research_summary", marketQueryId: "mq-1" },
    rawPayload: {},
    ...overrides
  };
}

function makeScreeningOutput(...externalIds: string[]) {
  return {
    output: {
      items: externalIds.map(id => ({
        sourceItemId: id,
        decision: "retain" as const,
        rationale: "relevant",
        createOrEnrich: "create" as const,
        relevanceScore: 0.8,
        sensitivityFlag: false,
        sensitivityCategories: []
      }))
    },
    usage: { mode: "provider" as const, promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 },
    mode: "provider" as const
  };
}

function makeDecisionOutput(overrides: Record<string, unknown> = {}) {
  return {
    output: {
      action: "create" as const,
      rationale: "new opportunity",
      title: "Created opportunity",
      territory: "sales",
      angle: "Repeated customer proof is more persuasive than generic product positioning.",
      whyNow: "Fresh supporting evidence shows this buying pattern is recurring right now.",
      whatItIsAbout: "A reusable lesson about concrete proof.",
      whatItIsNotAbout: "not about that",
      suggestedFormat: "Narrative lesson post",
      confidence: 0.85,
      ...overrides
    },
    usage: { mode: "provider" as const, promptTokens: 200, completionTokens: 100, estimatedCostUsd: 0.002 },
    mode: "provider" as const
  };
}

const usersWithAliases: UserRecord[] = [
  {
    id: "user-baptiste", companyId: "co-1", displayName: "baptiste",
    type: "human", language: "fr",
    baseProfile: { role: "Founder", speakerAliases: ["Baptiste Fradin", "Baptiste"], contentTerritories: [] },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  },
  {
    id: "user-virginie", companyId: "co-1", displayName: "virginie",
    type: "human", language: "fr",
    baseProfile: { role: "Product lead", speakerAliases: ["Virginie Bastien", "Virginie"], contentTerritories: [] },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }
];

function basePipelineParams() {
  return {
    companyId: "company-1",
    doctrineMarkdown: "test doctrine",
    sensitivityMarkdown: "test sensitivity",
    userDescriptions: "- baptiste (human, fr): territories=[]",
    users: usersWithAliases,
    layer2Defaults: [],
    layer3Defaults: [],
    gtmFoundationMarkdown: "",
    extractionProfilesMarkdown: "",
    recentOpportunities: [] as ContentOpportunity[]
  };
}

// Fixed inputs for deterministic prompt comparison via decideCreateOrEnrich
const fixedItem = makeItem();
const fixedEvidence: EvidenceReference[] = [{
  id: "ev-1", source: "market-research", sourceItemId: "si-1",
  sourceUrl: "https://example.com", timestamp: "2026-03-30T00:00:00Z",
  excerpt: "Buyers dismiss generic onboarding claims and respond to specific repeated proof.",
  excerptHash: "h1", freshnessScore: 0.9
}];
const fixedScreening: ScreeningResult = {
  decision: "retain", rationale: "relevant", createOrEnrich: "create",
  relevanceScore: 0.8, sensitivityFlag: false, sensitivityCategories: []
};

// ---------- 1. Unchanged-path guarantee ----------

describe("unchanged-path guarantee (deterministic fixture)", () => {
  // Two-tier proof:
  // Tier A — direct decideCreateOrEnrich: omitted extraction params produce identical
  //   system+prompt as explicit undefined. Proves the conditional spreads are no-ops.
  // Tier B — full pipeline: baseline captured from a pipeline run with disabled mode.
  //   All other inactive paths compared to this. Proves the activation site is a no-op.

  // --- Tier A: direct prompt builder ---

  let directBaseline: { system: string; prompt: string };

  async function captureDirectPrompts(overrides: { extractionDepthBlock?: string; speakerLine?: string } = {}) {
    const llm = { generateStructured: vi.fn().mockResolvedValueOnce(makeDecisionOutput()) } as any;
    await decideCreateOrEnrich({
      item: fixedItem, evidence: fixedEvidence, screening: fixedScreening,
      candidates: [], creationMode: "create-capable", curated: true, topCandidateScore: 0,
      llmClient: llm, doctrineMarkdown: "test doctrine",
      userDescriptions: "- baptiste (human, fr): territories=[]", gtmFoundationMarkdown: "",
      ...overrides
    });
    return { system: llm.generateStructured.mock.calls[0][0].system, prompt: llm.generateStructured.mock.calls[0][0].prompt };
  }

  beforeAll(async () => { directBaseline = await captureDirectPrompts(); });

  it("omitted extraction params → system+prompt identical to baseline", async () => {
    const result = await captureDirectPrompts();
    expect(result.system).toBe(directBaseline.system);
    expect(result.prompt).toBe(directBaseline.prompt);
  });

  it("explicit undefined extraction params → system+prompt identical to baseline", async () => {
    const result = await captureDirectPrompts({ extractionDepthBlock: undefined, speakerLine: undefined });
    expect(result.system).toBe(directBaseline.system);
    expect(result.prompt).toBe(directBaseline.prompt);
  });

  // --- Tier B: full pipeline, same item across all inactive modes ---

  let pipelineBaseline: { system: string; prompt: string };

  async function capturePipelinePrompts(item: NormalizedSourceItem, mode: string, profilesMarkdown: string) {
    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput(item.externalId))
        .mockResolvedValueOnce(makeDecisionOutput())
    } as any;
    process.env.EXTRACTION_DEPTH_MODE = mode;
    await runIntelligencePipeline({
      items: [item], llmClient: llm, ...basePipelineParams(),
      extractionProfilesMarkdown: profilesMarkdown
    });
    return { system: llm.generateStructured.mock.calls[1][0].system, prompt: llm.generateStructured.mock.calls[1][0].prompt };
  }

  beforeAll(async () => {
    process.env.EXTRACTION_DEPTH_MODE = "disabled";
    pipelineBaseline = await capturePipelinePrompts(fixedItem, "disabled", "");
  });

  it("observe mode → system+prompt identical to pipeline baseline", async () => {
    const result = await capturePipelinePrompts(fixedItem, "observe", "## full profiles");
    expect(result.system).toBe(pipelineBaseline.system);
    expect(result.prompt).toBe(pipelineBaseline.prompt);
  });

  it("disabled mode → system+prompt identical to pipeline baseline", async () => {
    const result = await capturePipelinePrompts(fixedItem, "disabled", "## full profiles");
    expect(result.system).toBe(pipelineBaseline.system);
    expect(result.prompt).toBe(pipelineBaseline.prompt);
  });

  it("enabled + unresolved context → system+prompt identical to pipeline baseline", async () => {
    // fixedItem has no speakerName → unresolved → no injection
    const result = await capturePipelinePrompts(fixedItem, "enabled", "## full profiles");
    expect(result.system).toBe(pipelineBaseline.system);
    expect(result.prompt).toBe(pipelineBaseline.prompt);
  });

  it("enabled + empty profiles markdown → system identical to pipeline baseline", async () => {
    // speakerName resolves but profiles empty → isDepthActive=false
    const itemWithSpeaker = makeItem({ speakerName: "Virginie Bastien" });
    const result = await capturePipelinePrompts(itemWithSpeaker, "enabled", "");
    expect(result.system).toBe(pipelineBaseline.system);
    // prompt may differ in item content (different speakerName on item), but no injected Speaker: line
    expect(result.prompt).not.toContain("\nSpeaker:");
  });

  it("observe mode with resolved context → system identical to pipeline baseline", async () => {
    // speakerName resolves, profiles non-empty, but mode=observe → no injection
    const itemWithSpeaker = makeItem({ speakerName: "Virginie Bastien" });
    const result = await capturePipelinePrompts(itemWithSpeaker, "observe", "## full profiles");
    expect(result.system).toBe(pipelineBaseline.system);
    expect(result.prompt).not.toContain("\nSpeaker:");
  });
});

// ---------- 2. Enabled-mode injection ----------

describe("enabled mode injection", () => {
  it("injects extraction depth block and speaker line when active", async () => {
    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput())
    } as any;
    process.env.EXTRACTION_DEPTH_MODE = "enabled";
    const result = await runIntelligencePipeline({
      items: [makeItem({ speakerName: "Virginie Bastien" })],
      llmClient: llm, ...basePipelineParams(),
      extractionProfilesMarkdown: "## profiles table here"
    });
    const call = llm.generateStructured.mock.calls[1][0];
    expect(call.system).toContain("## Extraction depth by speaker role");
    expect(call.system).toContain("## profiles table here");
    expect(call.system).toContain("Active speaker context: Virginie Bastien (Product lead, resolved via identity).");
    expect(call.prompt).toContain("Speaker: Virginie Bastien");
    expect(result.speakerContextEvents[0].promptModified).toBe(true);
  });
});

// ---------- 3. Telemetry: exact event counts ----------

describe("speaker context telemetry — exact counts", () => {
  it("emits exactly one event per create/enrich loop item (publishability-blocked + normal)", async () => {
    const blocked = makeItem({
      sourceItemId: "blocked-1", externalId: "market-research:blocked-1",
      sourceFingerprint: "blocked-fp-1",
      metadata: { kind: "market_research_summary", marketQueryId: "mq-1", publishabilityRisk: "harmful" }
    });
    const normal = makeItem();
    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:blocked-1", "market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput())
    } as any;
    process.env.EXTRACTION_DEPTH_MODE = "observe";
    const result = await runIntelligencePipeline({
      items: [blocked, normal], llmClient: llm, ...basePipelineParams()
    });
    // Both items entered the loop, both must have events
    expect(result.speakerContextEvents).toHaveLength(2);
    expect(result.speakerContextEvents[0].sourceItemId).toBe("market-research:blocked-1");
    expect(result.speakerContextEvents[1].sourceItemId).toBe("market-research:mq-1:hash-1");
    // Neither should have prompt modified in observe mode
    expect(result.speakerContextEvents.every(e => !e.promptModified)).toBe(true);
  });

  it("emits event for enrich-only item with no candidates (early exit)", async () => {
    const enrichOnlyItem = makeItem({
      source: "hubspot", sourceItemId: "hs-1", externalId: "hubspot:hs-1",
      sourceFingerprint: "hs-fp-1"
    });
    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("hubspot:hs-1"))
    } as any;
    process.env.EXTRACTION_DEPTH_MODE = "observe";
    const result = await runIntelligencePipeline({
      items: [enrichOnlyItem], llmClient: llm, ...basePipelineParams()
    });
    // hubspot is enrich-only, no candidates → early exit, but event must still emit
    expect(result.speakerContextEvents).toHaveLength(1);
    expect(result.speakerContextEvents[0].sourceItemId).toBe("hubspot:hs-1");
  });

  it("records identity resolution in telemetry", async () => {
    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput())
    } as any;
    process.env.EXTRACTION_DEPTH_MODE = "observe";
    const result = await runIntelligencePipeline({
      items: [makeItem({ speakerName: "Baptiste Fradin" })],
      llmClient: llm, ...basePipelineParams()
    });
    const evt = result.speakerContextEvents[0];
    expect(evt.resolved).toEqual({ profileId: "baptiste", role: "Founder", source: "identity" });
    expect(evt.speakerName).toBe("Baptiste Fradin");
    expect(evt.promptModified).toBe(false);
  });

  it("records unresolved context for item with no speaker info", async () => {
    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput())
    } as any;
    process.env.EXTRACTION_DEPTH_MODE = "observe";
    const result = await runIntelligencePipeline({
      items: [makeItem({ speakerName: undefined })],
      llmClient: llm, ...basePipelineParams()
    });
    expect(result.speakerContextEvents[0].resolved).toBeUndefined();
    expect(result.speakerContextEvents[0].promptModified).toBe(false);
  });
});

// ---------- 4. External speaker regression ----------

describe("external speaker regression", () => {
  it("named external speaker with product keywords stays unresolved at pipeline level", async () => {
    // Simulates a prospect named "Sophie Lemaire" on a Claap call where content
    // keywords triggered profileHint: "virginie". Must NOT resolve as Product lead.
    const item = makeItem({
      speakerName: "Sophie Lemaire",
      metadata: { kind: "market_research_summary", marketQueryId: "mq-1", profileHint: "virginie" }
    });
    const llm = {
      generateStructured: vi.fn()
        .mockResolvedValueOnce(makeScreeningOutput("market-research:mq-1:hash-1"))
        .mockResolvedValueOnce(makeDecisionOutput())
    } as any;
    process.env.EXTRACTION_DEPTH_MODE = "enabled";
    const result = await runIntelligencePipeline({
      items: [item], llmClient: llm,
      ...basePipelineParams(),
      extractionProfilesMarkdown: "## full profiles markdown"
    });
    // Must be unresolved — external speaker, even with product-keyword hint
    const evt = result.speakerContextEvents[0];
    expect(evt.resolved).toBeUndefined();
    expect(evt.promptModified).toBe(false);
    expect(evt.speakerName).toBe("Sophie Lemaire");
    expect(evt.profileHint).toBe("virginie");
    // Prompts must be unchanged (no injection for external speaker)
    const call = llm.generateStructured.mock.calls[1][0];
    expect(call.system).not.toContain("Extraction depth");
    expect(call.prompt).not.toContain("Speaker:");
  });
});
