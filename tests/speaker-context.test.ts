import { describe, expect, it } from "vitest";
import { resolveSpeakerContext, buildExtractionDepthBlock } from "../src/lib/speaker-context.js";
import type { ResolvedSpeakerContext } from "../src/lib/speaker-context.js";
import type { NormalizedSourceItem, UserRecord } from "../src/domain/types.js";

function makeItem(overrides: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem {
  return {
    source: "claap",
    sourceItemId: "claap-1",
    externalId: "claap:claap-1",
    sourceFingerprint: "fp-1",
    sourceUrl: "https://claap.io/1",
    title: "Test item",
    text: "Some text content",
    summary: "Test summary",
    occurredAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    metadata: {},
    rawPayload: {},
    ...overrides
  };
}

function makeUser(displayName: string, role: string, speakerAliases: string[]): UserRecord {
  return {
    id: `user-${displayName}`,
    companyId: "co-1",
    displayName,
    type: displayName === "linc-corporate" ? "corporate" : "human",
    language: "fr",
    baseProfile: { role, speakerAliases, contentTerritories: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

const users: UserRecord[] = [
  makeUser("baptiste", "Founder", ["Baptiste Fradin", "Baptiste"]),
  makeUser("virginie", "Product lead", ["Virginie Bastien", "Virginie"]),
  makeUser("thomas", "Operator", ["Thomas Music", "Thomas"]),
  makeUser("quentin", "Commercial lead", ["Quentin Lallemand", "Quentin"]),
  makeUser("linc-corporate", "Company voice", [])
];

describe("resolveSpeakerContext", () => {
  // --- Identity resolution ---

  it("resolves by explicit identity when speakerName matches alias", () => {
    const item = makeItem({ speakerName: "Baptiste Fradin" });
    const ctx = resolveSpeakerContext({ item, users });
    expect(ctx).toEqual({
      profileId: "baptiste",
      role: "Founder",
      speakerName: "Baptiste Fradin",
      source: "identity"
    });
  });

  it("identity match is case-insensitive", () => {
    const item = makeItem({ speakerName: "virginie bastien" });
    const ctx = resolveSpeakerContext({ item, users });
    expect(ctx?.profileId).toBe("virginie");
    expect(ctx?.source).toBe("identity");
  });

  it("identity beats content keywords — profileHint is ignored when alias matches", () => {
    const item = makeItem({
      speakerName: "Baptiste Fradin",
      metadata: { profileHint: "virginie" }
    });
    const ctx = resolveSpeakerContext({ item, users });
    expect(ctx).toEqual({
      profileId: "baptiste",
      role: "Founder",
      speakerName: "Baptiste Fradin",
      source: "identity"
    });
  });

  // --- Named external speaker stays unresolved ---

  it("named speaker that fails alias match returns undefined (not content-hint)", () => {
    const item = makeItem({
      speakerName: "Jean Martin",
      metadata: { profileHint: "thomas" }
    });
    // Jean Martin is not in any alias list — even with a profileHint, must stay unresolved
    // to avoid labeling an external voice as an internal role.
    expect(resolveSpeakerContext({ item, users })).toBeUndefined();
  });

  it("external speaker with product keywords stays unresolved", () => {
    // A prospect named Sophie on a Claap call where content has product keywords
    const item = makeItem({
      speakerName: "Sophie Lemaire",
      metadata: { profileHint: "virginie" }
    });
    expect(resolveSpeakerContext({ item, users })).toBeUndefined();
  });

  // --- Content-hint fallback (no explicit speaker identity) ---

  it("content-hint activates only when speakerName is absent", () => {
    const item = makeItem({
      speakerName: undefined,
      authorName: "Quentin",
      metadata: { profileHint: "quentin" }
    });
    const ctx = resolveSpeakerContext({ item, users });
    expect(ctx?.profileId).toBe("quentin");
    expect(ctx?.speakerName).toBe("Quentin");
    expect(ctx?.source).toBe("content-hint");
  });

  // --- Unresolved paths ---

  it("returns undefined when no speakerName and no profileHint", () => {
    const item = makeItem({ speakerName: undefined, metadata: {} });
    expect(resolveSpeakerContext({ item, users })).toBeUndefined();
  });

  it("returns undefined when speakerName is empty string", () => {
    const item = makeItem({ speakerName: "", metadata: {} });
    expect(resolveSpeakerContext({ item, users })).toBeUndefined();
  });

  // --- Complete-or-nothing ---

  it("returns undefined when alias matches but role is empty (convergence not run)", () => {
    const usersNoRole = [makeUser("baptiste", "", ["Baptiste Fradin"])];
    const item = makeItem({ speakerName: "Baptiste Fradin" });
    expect(resolveSpeakerContext({ item, users: usersNoRole })).toBeUndefined();
  });

  it("does NOT fall through to content-hint when alias matches but role is missing", () => {
    const usersNoRole = [
      makeUser("baptiste", "", ["Baptiste Fradin"]),
      makeUser("virginie", "Product lead", ["Virginie Bastien"])
    ];
    const item = makeItem({
      speakerName: "Baptiste Fradin",
      metadata: { profileHint: "virginie" }
    });
    // Identity matched baptiste but role is empty → undefined, does NOT try virginie hint
    expect(resolveSpeakerContext({ item, users: usersNoRole })).toBeUndefined();
  });

  it("returns undefined on content-hint path when both speakerName and authorName are empty", () => {
    const item = makeItem({
      speakerName: "",
      authorName: undefined,
      metadata: { profileHint: "virginie" }
    });
    expect(resolveSpeakerContext({ item, users })).toBeUndefined();
  });

  it("returns undefined when profileHint is not a valid ProfileId and no speaker", () => {
    const item = makeItem({
      speakerName: undefined,
      authorName: "Unknown",
      metadata: { profileHint: "not-a-profile" }
    });
    expect(resolveSpeakerContext({ item, users })).toBeUndefined();
  });
});

describe("buildExtractionDepthBlock", () => {
  it("produces a system prompt block with role and source", () => {
    const ctx: ResolvedSpeakerContext = {
      profileId: "virginie",
      role: "Product lead",
      speakerName: "Virginie",
      source: "identity"
    };
    const block = buildExtractionDepthBlock(ctx, "## profiles table here");
    expect(block).toContain("## Extraction depth by speaker role");
    expect(block).toContain("## profiles table here");
    expect(block).toContain("Active speaker context: Virginie (Product lead, resolved via identity).");
    expect(block).toContain("Speaker role shapes what to extract");
  });
});
