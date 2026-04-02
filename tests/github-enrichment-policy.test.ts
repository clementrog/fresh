import { describe, expect, it, vi } from "vitest";
import {
  evaluateGitHubEnrichmentPolicy,
  getSourceCreationMode
} from "../src/services/intelligence.js";
import { deriveProvenanceType } from "../src/services/evidence-pack.js";
import type { NormalizedSourceItem } from "../src/domain/types.js";
import type { LlmClient, LlmStructuredResponse } from "../src/services/llm.js";
import type { GitHubEnrichmentClassification } from "../src/config/schema.js";

function makeGitHubItem(overrides: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem {
  return {
    source: "github",
    sourceItemId: "linc-fr/app#42",
    externalId: "github:linc-fr/app#42",
    sourceFingerprint: "fp-gh-1",
    sourceUrl: "https://github.com/linc-fr/app/pull/42",
    title: "Add convention HCR full support",
    text: "This PR adds full support for the HCR convention, including all edge cases for multi-establishment companies.",
    summary: "Add convention HCR full support",
    occurredAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    metadata: {
      itemType: "merged-pr",
      repoName: "app",
      orgSlug: "linc-fr",
      labels: ["feature", "convention"],
      authorLogin: "dev-user",
      reviewerLogins: ["reviewer-1"],
      mergedAt: new Date().toISOString(),
      additions: 450,
      deletions: 30,
      linkedIssueNumbers: [10, 11],
      linkedLinearDisplayIds: ["LIN-123"],
      storeRawText: false
    },
    rawPayload: {},
    ...overrides
  };
}

function makeMockLlmClient(classification: GitHubEnrichmentClassification): LlmClient {
  return {
    generateStructured: vi.fn().mockResolvedValue({
      output: classification,
      usage: { mode: "provider", promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001 }
    } as LlmStructuredResponse<GitHubEnrichmentClassification>)
  } as unknown as LlmClient;
}

describe("evaluateGitHubEnrichmentPolicy", () => {
  it("classifies a shipped-feature item", async () => {
    const item = makeGitHubItem();
    const classification: GitHubEnrichmentClassification = {
      classification: "shipped-feature",
      rationale: "Major user-facing capability shipped",
      customerVisibility: "shipped",
      sensitivityLevel: "safe",
      evidenceStrength: 0.9
    };
    const llm = makeMockLlmClient(classification);

    const { results } = await evaluateGitHubEnrichmentPolicy({
      items: [item],
      llmClient: llm,
      doctrineMarkdown: "test doctrine",
      sensitivityMarkdown: "test sensitivity"
    });

    expect(results.get(item.externalId)).toEqual(classification);
  });

  it("classifies an internal-only item", async () => {
    const item = makeGitHubItem({ title: "Bump eslint to v9" });
    const classification: GitHubEnrichmentClassification = {
      classification: "internal-only",
      rationale: "Dependency bump, no editorial value",
      customerVisibility: "internal-only",
      sensitivityLevel: "safe",
      evidenceStrength: 0
    };
    const llm = makeMockLlmClient(classification);

    const { results } = await evaluateGitHubEnrichmentPolicy({
      items: [item],
      llmClient: llm,
      doctrineMarkdown: "test",
      sensitivityMarkdown: "test"
    });

    expect(results.get(item.externalId)?.classification).toBe("internal-only");
  });

  it("falls back to manual-review when LLM fails", async () => {
    const item = makeGitHubItem();
    const llm = {
      generateStructured: vi.fn().mockRejectedValue(new Error("LLM unavailable"))
    } as unknown as LlmClient;

    const { results } = await evaluateGitHubEnrichmentPolicy({
      items: [item],
      llmClient: llm,
      doctrineMarkdown: "test",
      sensitivityMarkdown: "test"
    });

    expect(results.get(item.externalId)?.classification).toBe("manual-review");
  });
});

describe("getSourceCreationMode for github", () => {
  it("returns enrich-only for shipped-feature (GitHub is proof-only)", () => {
    const item = makeGitHubItem({
      metadata: { ...makeGitHubItem().metadata, githubEnrichmentClassification: "shipped-feature" }
    });
    expect(getSourceCreationMode(item)).toBe("enrich-only");
  });

  it("returns enrich-only for customer-fix", () => {
    const item = makeGitHubItem({
      metadata: { ...makeGitHubItem().metadata, githubEnrichmentClassification: "customer-fix" }
    });
    expect(getSourceCreationMode(item)).toBe("enrich-only");
  });

  it("returns enrich-only for proof-point", () => {
    const item = makeGitHubItem({
      metadata: { ...makeGitHubItem().metadata, githubEnrichmentClassification: "proof-point" }
    });
    expect(getSourceCreationMode(item)).toBe("enrich-only");
  });

  it("returns enrich-only when no classification", () => {
    const item = makeGitHubItem();
    expect(getSourceCreationMode(item)).toBe("enrich-only");
  });
});

describe("deriveProvenanceType for github", () => {
  it("returns github:shipped-feature", () => {
    const item = makeGitHubItem({
      metadata: { ...makeGitHubItem().metadata, githubEnrichmentClassification: "shipped-feature" }
    });
    expect(deriveProvenanceType(item)).toBe("github:shipped-feature");
  });

  it("returns github:proof-point", () => {
    const item = makeGitHubItem({
      metadata: { ...makeGitHubItem().metadata, githubEnrichmentClassification: "proof-point" }
    });
    expect(deriveProvenanceType(item)).toBe("github:proof-point");
  });

  it("returns github:customer-fix", () => {
    const item = makeGitHubItem({
      metadata: { ...makeGitHubItem().metadata, githubEnrichmentClassification: "customer-fix" }
    });
    expect(deriveProvenanceType(item)).toBe("github:customer-fix");
  });

  it("returns github when no classification", () => {
    const item = makeGitHubItem();
    expect(deriveProvenanceType(item)).toBe("github");
  });
});
