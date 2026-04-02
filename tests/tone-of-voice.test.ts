import { describe, expect, it } from "vitest";

import { classifyToneSection, normalizeToneText, parseToneBodySections } from "../src/lib/tone.js";
import { resolveProfileId } from "../src/services/convergence.js";

describe("classifyToneSection", () => {
  // French avoid headings
  it.each([
    ["Anti-modèles explicites", "avoid"],
    ["Il ne dit jamais", "avoid"],
    ["Ce qu'il ne faut pas faire", "avoid"],
    ["Règles", "avoid"],
    ["À éviter", "avoid"]
  ] as const)('classifies "%s" as %s', (heading, expected) => {
    expect(classifyToneSection(heading)).toBe(expected);
  });

  // French structure headings
  it.each([
    ["Comment il structure sa pensée", "preferredPatterns"],
    ["Lexique", "preferredPatterns"],
    ["Adaptation par format", "preferredPatterns"],
    ["Conversion oral > écrit", "preferredPatterns"]
  ] as const)('classifies "%s" as %s', (heading, expected) => {
    expect(classifyToneSection(heading)).toBe(expected);
  });

  // French voice headings
  it.each([
    ["Qui est Quentin sur la page", "voiceSummary"],
    ["Ce qui définit cette voix", "voiceSummary"]
  ] as const)('classifies "%s" as %s', (heading, expected) => {
    expect(classifyToneSection(heading)).toBe(expected);
  });

  // English headings (backward compat)
  it.each([
    ["Voice summary", "voiceSummary"],
    ["Preferred patterns", "preferredPatterns"],
    ["Avoid", "avoid"]
  ] as const)('classifies English heading "%s" as %s', (heading, expected) => {
    expect(classifyToneSection(heading)).toBe(expected);
  });

  it("returns null for unrecognized headings", () => {
    expect(classifyToneSection("Introduction")).toBeNull();
    expect(classifyToneSection("Random heading")).toBeNull();
  });

  it("returns null for empty heading", () => {
    expect(classifyToneSection("")).toBeNull();
  });
});

describe("normalizeToneText", () => {
  it("collapses 3+ newlines to double newline", () => {
    expect(normalizeToneText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims whitespace from each line", () => {
    expect(normalizeToneText("  hello  \n  world  ")).toBe("hello\nworld");
  });

  it("collapses multiple spaces to one", () => {
    expect(normalizeToneText("a   b   c")).toBe("a b c");
  });

  it("strips leading bullet markers", () => {
    expect(normalizeToneText("- item one\n• item two\n* item three")).toBe(
      "item one\nitem two\nitem three"
    );
  });

  it("is idempotent", () => {
    const input = "  - hello   world  \n\n\n\n  • test  ";
    const once = normalizeToneText(input);
    const twice = normalizeToneText(once);
    expect(twice).toBe(once);
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeToneText("\n\n  hello  \n\n")).toBe("hello");
  });
});

describe("parseToneBodySections", () => {
  it("populates all three fields from classified sections", () => {
    const sections = new Map([
      ["qui est quentin sur la page", "Direct, conversational, technical"],
      ["comment il structure sa pensée", "Hook > Insight > Takeaway"],
      ["anti-modèles explicites", "No jargon\nNo clickbait"]
    ]);
    const result = parseToneBodySections(sections);
    expect(result.voiceSummary).toBe("Direct, conversational, technical");
    expect(result.preferredPatterns).toBe("Hook > Insight > Takeaway");
    expect(result.avoid).toBe("No jargon\nNo clickbait");
  });

  it("concatenates multiple headings in the same bucket with double newline", () => {
    const sections = new Map([
      ["anti-modèles explicites", "No jargon"],
      ["il ne dit jamais", "Never say 'leverage'"],
      ["ce qu'il ne faut pas faire", "No clickbait"]
    ]);
    const result = parseToneBodySections(sections);
    expect(result.avoid).toBe("No jargon\n\nNever say 'leverage'\n\nNo clickbait");
  });

  it("returns empty strings for missing buckets", () => {
    const sections = new Map([
      ["qui est quentin sur la page", "Some voice info"]
    ]);
    const result = parseToneBodySections(sections);
    expect(result.voiceSummary).toBe("Some voice info");
    expect(result.preferredPatterns).toBe("");
    expect(result.avoid).toBe("");
  });

  it("returns all empty for an empty map", () => {
    const result = parseToneBodySections(new Map());
    expect(result.voiceSummary).toBe("");
    expect(result.preferredPatterns).toBe("");
    expect(result.avoid).toBe("");
  });

  it("drops content before first heading (empty-string key)", () => {
    const sections = new Map([
      ["", "Preamble text that should be ignored"],
      ["qui est quentin sur la page", "Actual voice content"]
    ]);
    const result = parseToneBodySections(sections);
    expect(result.voiceSummary).toBe("Actual voice content");
  });

  it("appends content from repeated headings rather than overwriting", () => {
    // Map semantics: if readPageBodySections appends to existing key,
    // the Map will have accumulated text in a single entry
    const sections = new Map([
      ["règles", "Rule 1\nRule 2\n\nRule 3 (appended from second occurrence)"]
    ]);
    const result = parseToneBodySections(sections);
    expect(result.avoid).toContain("Rule 1");
    expect(result.avoid).toContain("Rule 3");
  });

  it("normalizes output text", () => {
    const sections = new Map([
      ["qui est quentin sur la page", "  - bullet one  \n\n\n\n  • bullet two  "]
    ]);
    const result = parseToneBodySections(sections);
    expect(result.voiceSummary).toBe("bullet one\n\nbullet two");
  });
});

describe("resolveProfileId", () => {
  it('resolves "Baptiste Le Bihan" to "baptiste"', () => {
    expect(resolveProfileId("Baptiste Le Bihan")).toBe("baptiste");
  });

  it('resolves "New Quentin" to "quentin"', () => {
    expect(resolveProfileId("New Quentin")).toBe("quentin");
  });

  it('resolves "Virginie" to "virginie"', () => {
    expect(resolveProfileId("Virginie")).toBe("virginie");
  });

  it('resolves "linc-corporate" to "linc-corporate"', () => {
    expect(resolveProfileId("linc-corporate")).toBe("linc-corporate");
  });

  it("returns undefined for unrecognized names", () => {
    expect(resolveProfileId("Unknown Person")).toBeUndefined();
  });

  it("returns undefined for ambiguous names (multiple profile matches)", () => {
    expect(resolveProfileId("Baptiste Thomas")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveProfileId("")).toBeUndefined();
  });
});
