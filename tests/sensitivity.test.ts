import { describe, expect, it } from "vitest";

import { LlmClient } from "../src/services/llm.js";
import { assessSensitivity, parseSensitivityRules } from "../src/services/sensitivity.js";

const markdown = `
## client-identifiable
- acme corp, globex

## payroll-sensitive
- salary, payroll

## roadmap-sensitive
- roadmap, unreleased
`;

describe("sensitivity rules", () => {
  it("parses markdown into category rules", () => {
    const parsed = parseSensitivityRules(markdown);
    expect(parsed.rules).toHaveLength(3);
  });

  it("blocks items when stage one terms match", async () => {
    const llm = new LlmClient({
      DATABASE_URL: "",
      NOTION_TOKEN: "",
      NOTION_PARENT_PAGE_ID: "",
      OPENAI_API_KEY: "",
      CLAAP_API_KEY: "",
      LINEAR_API_KEY: "",
      DEFAULT_TIMEZONE: "Europe/Paris",
      LLM_MODEL: "test",
      LLM_TIMEOUT_MS: 100,
      LOG_LEVEL: "info"
    });

    const result = await assessSensitivity(
      {
        title: "Payroll note",
        summary: "Updated payroll ranges",
        text: "This note contains salary changes."
      },
      markdown,
      llm
    );

    expect(result.assessment.blocked).toBe(true);
    expect(result.assessment.categories).toContain("payroll-sensitive");
  });

  it("does not flag claap signals as recruiting-sensitive just because of the hook field name", async () => {
    const llm = new LlmClient({
      DATABASE_URL: "",
      NOTION_TOKEN: "",
      NOTION_PARENT_PAGE_ID: "",
      OPENAI_API_KEY: "",
      CLAAP_API_KEY: "",
      LINEAR_API_KEY: "",
      DEFAULT_TIMEZONE: "Europe/Paris",
      LLM_MODEL: "test",
      LLM_TIMEOUT_MS: 100,
      LOG_LEVEL: "info"
    });

    const result = await assessSensitivity(
      {
        title: "Régularisations DSN : déclôturer des mois de bulletins est un risque majeur",
        summary: "Une régularisation rétroactive peut casser une chaîne de bulletins déjà clôturés.",
        text: [
          "Le vrai sujet n'est pas la régularisation. C'est tout ce qu'elle casse derrière.",
          "C'est un angle métier fort pour expliquer les risques de la paie rétroactive.",
          "Dès qu'on touche au bulletin passé, tout le reste saute."
        ].join("\n"),
        metadata: {
          notionKind: "claap-signal"
        }
      },
      markdown,
      llm
    );

    expect(result.assessment.blocked).toBe(false);
    expect(result.assessment.categories).toEqual([]);
    expect(result.usage.skipped).toBe(true);
  });
});
