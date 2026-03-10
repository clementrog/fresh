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
      SLACK_BOT_TOKEN: "",
      SLACK_EDITORIAL_OPERATOR_ID: "",
      OPENAI_API_KEY: "",
      CLAAP_API_KEY: "",
      LINEAR_API_KEY: "",
      DEFAULT_TIMEZONE: "Europe/Paris",
      LLM_MODEL: "test",
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
});
