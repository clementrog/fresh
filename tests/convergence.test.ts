import { describe, expect, it, vi, beforeEach } from "vitest";
import { hashParts } from "../src/lib/ids.js";

vi.mock("../src/config/loaders.js", () => ({
  loadDoctrineMarkdown: vi.fn(),
  loadSensitivityMarkdown: vi.fn(),
  loadProfileBases: vi.fn().mockResolvedValue([]),
  loadConnectorConfigs: vi.fn().mockResolvedValue([])
}));

import { ensureConvergenceFoundation, normalizeLayer3Defaults } from "../src/services/convergence.js";
import { loadDoctrineMarkdown, loadSensitivityMarkdown } from "../src/config/loaders.js";

const DOCTRINE_V1 = "# Fresh Editorial Doctrine v1\nOriginal doctrine content.";
const SENSITIVITY_V1 = "# Sensitivity Rules v1";
const DOCTRINE_V2 = "# Fresh Editorial Doctrine v2\nUpdated doctrine content with new sections.";
const SENSITIVITY_V2 = "# Sensitivity Rules v2\nNew sensitivity categories.";

function makeEnv(overrides: Record<string, unknown> = {}) {
  return { DEFAULT_COMPANY_SLUG: "test", DEFAULT_COMPANY_NAME: "Test Company", DEFAULT_TIMEZONE: "Europe/Paris", ...overrides } as any;
}

function makeRepositories(opts: { existingEditorialConfig?: any } = {}) {
  const upsertEditorialConfig = vi.fn();
  return {
    repos: {
      ensureDefaultCompany: vi.fn().mockResolvedValue({ id: "company_test", slug: "test", name: "Test Company", defaultTimezone: "Europe/Paris", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      getLatestEditorialConfig: vi.fn().mockResolvedValue(opts.existingEditorialConfig ?? null),
      upsertEditorialConfig,
      upsertUser: vi.fn(),
      upsertSourceConfig: vi.fn(),
      listUsers: vi.fn().mockResolvedValue([])
    } as any,
    upsertEditorialConfig
  };
}

describe("doctrine refresh in ensureConvergenceFoundation", () => {
  beforeEach(() => {
    vi.mocked(loadDoctrineMarkdown).mockResolvedValue(DOCTRINE_V1);
    vi.mocked(loadSensitivityMarkdown).mockResolvedValue(SENSITIVITY_V1);
  });

  it("creates editorial config on fresh install", async () => {
    const { repos, upsertEditorialConfig } = makeRepositories();
    await ensureConvergenceFoundation(repos, makeEnv());
    expect(upsertEditorialConfig).toHaveBeenCalledTimes(1);
    const config = upsertEditorialConfig.mock.calls[0][0];
    expect(config.layer1CompanyLens.doctrineMarkdown).toBe(DOCTRINE_V1);
    expect(config.layer1CompanyLens.sensitivityMarkdown).toBe(SENSITIVITY_V1);
    expect(config.version).toBe(1);
  });

  it("does NOT upsert editorial config when doctrine is unchanged", async () => {
    const existingConfig = { id: "ec-1", companyId: "company_test", version: 1, layer1CompanyLens: { doctrineMarkdown: DOCTRINE_V1, sensitivityMarkdown: SENSITIVITY_V1 }, layer2ContentPhilosophy: { defaults: ["Specific"] }, layer3LinkedInCraft: { defaults: ["Max 250 words."] }, createdAt: new Date() };
    const { repos, upsertEditorialConfig } = makeRepositories({ existingEditorialConfig: existingConfig });
    await ensureConvergenceFoundation(repos, makeEnv());
    expect(upsertEditorialConfig).not.toHaveBeenCalled();
  });

  it("self-heals stale doctrine by upserting with new content", async () => {
    const existingConfig = { id: "ec-1", companyId: "company_test", version: 1, layer1CompanyLens: { doctrineMarkdown: "old doctrine", sensitivityMarkdown: "old sensitivity" }, layer2ContentPhilosophy: { defaults: ["Specific"] }, layer3LinkedInCraft: { defaults: ["Max 250 words."] }, createdAt: new Date() };
    const { repos, upsertEditorialConfig } = makeRepositories({ existingEditorialConfig: existingConfig });
    vi.mocked(loadDoctrineMarkdown).mockResolvedValue(DOCTRINE_V2);
    vi.mocked(loadSensitivityMarkdown).mockResolvedValue(SENSITIVITY_V2);
    await ensureConvergenceFoundation(repos, makeEnv());
    expect(upsertEditorialConfig).toHaveBeenCalledTimes(1);
    const config = upsertEditorialConfig.mock.calls[0][0];
    expect(config.layer1CompanyLens.doctrineMarkdown).toBe(DOCTRINE_V2);
    expect(config.layer1CompanyLens.sensitivityMarkdown).toBe(SENSITIVITY_V2);
    expect(config.id).toBe("ec-1");
    expect(config.version).toBe(1);
    expect(config.layer2ContentPhilosophy).toEqual({ defaults: ["Specific"] });
    expect(config.layer3LinkedInCraft).toEqual({ defaults: ["Max 250 words."] });
  });

  it("self-heals missing layer-1 fields", async () => {
    const existingConfig = { id: "ec-1", companyId: "company_test", version: 1, layer1CompanyLens: {}, layer2ContentPhilosophy: { defaults: ["Specific"] }, layer3LinkedInCraft: { defaults: ["Max 250 words."] }, createdAt: new Date() };
    const { repos, upsertEditorialConfig } = makeRepositories({ existingEditorialConfig: existingConfig });
    await ensureConvergenceFoundation(repos, makeEnv());
    expect(upsertEditorialConfig).toHaveBeenCalledTimes(1);
    const config = upsertEditorialConfig.mock.calls[0][0];
    expect(config.layer1CompanyLens.doctrineMarkdown).toBe(DOCTRINE_V1);
    expect(config.layer1CompanyLens.sensitivityMarkdown).toBe(SENSITIVITY_V1);
  });

  it("targets the latest version, not hardcoded v1", async () => {
    const existingConfig = { id: "ec-v3", companyId: "company_test", version: 3, layer1CompanyLens: { doctrineMarkdown: "old v3 doctrine", sensitivityMarkdown: "old v3 sensitivity" }, layer2ContentPhilosophy: { defaults: ["Custom"] }, layer3LinkedInCraft: { defaults: ["Custom craft."] }, createdAt: new Date() };
    const { repos, upsertEditorialConfig } = makeRepositories({ existingEditorialConfig: existingConfig });
    await ensureConvergenceFoundation(repos, makeEnv());
    expect(upsertEditorialConfig).toHaveBeenCalledTimes(1);
    const config = upsertEditorialConfig.mock.calls[0][0];
    expect(config.version).toBe(3);
    expect(config.id).toBe("ec-v3");
    expect(config.layer1CompanyLens.doctrineMarkdown).toBe(DOCTRINE_V1);
  });

  it("uses structured hash with delimiter, not raw concatenation", async () => {
    const hash1 = hashParts(["layer1", "abc", "def"]);
    const hash2 = hashParts(["layer1", "abcde", "f"]);
    expect(hash1).not.toBe(hash2);
    const hashAgain = hashParts(["layer1", "abc", "def"]);
    expect(hash1).toBe(hashAgain);
    const hashA = hashParts(["layer1", DOCTRINE_V1, SENSITIVITY_V1]);
    const hashB = hashParts(["layer1", DOCTRINE_V2, SENSITIVITY_V1]);
    expect(hashA).not.toBe(hashB);
  });
});

describe("normalizeLayer3Defaults", () => {
  it("strips conflicting rules and normalizes word count", () => {
    const legacy = [
      "Max 250 words. One idea per post.",
      "First 2 lines must create a reason to click voir plus. No descriptive openings.",
      "Write like a person, not a framework. First person mandatory.",
      "End with something worth reacting to. Not a summary.",
      "Never cite internal source systems. Transform evidence into personal observation.",
      "Vary structure across posts. Never repeat the same skeleton."
    ];
    const result = normalizeLayer3Defaults(legacy);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe("Target 200-250 words. One idea per post.");
    expect(result).toContain("First 2 lines must create a reason to click voir plus. No descriptive openings.");
    expect(result).toContain("End with something worth reacting to. Not a summary.");
    expect(result).toContain("Vary structure across posts. Never repeat the same skeleton.");
    expect(result.join(" ")).not.toMatch(/first\s+person\s+mandatory/i);
    expect(result.join(" ")).not.toMatch(/never\s+cite\s+internal\s+source/i);
  });

  it("preserves operator-custom rules", () => {
    const custom = ["Max 150 words.", "Always mention data privacy.", "First person mandatory."];
    const result = normalizeLayer3Defaults(custom);
    expect(result).toEqual(["Max 150 words.", "Always mention data privacy."]);
  });

  it("is idempotent", () => {
    const legacy = [
      "Max 250 words. One idea per post.",
      "Write like a person, not a framework. First person mandatory.",
      "End with something worth reacting to. Not a summary.",
      "Never cite internal source systems. Transform evidence into personal observation.",
      "Vary structure across posts."
    ];
    const first = normalizeLayer3Defaults(legacy);
    const second = normalizeLayer3Defaults(first);
    expect(second).toEqual(first);
  });

  it("handles empty array", () => {
    expect(normalizeLayer3Defaults([])).toEqual([]);
  });
});
