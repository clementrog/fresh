import { describe, expect, it, vi } from "vitest";

import { SalesApp } from "../src/sales/app.js";
import type { AppEnv } from "../src/config/env.js";

function buildEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    DATABASE_URL: "postgresql://localhost/test",
    HUBSPOT_ACCESS_TOKEN: "pat-test-123",
    HUBSPOT_PORTAL_ID: "12345",
    SALES_LLM_PROVIDER: "anthropic",
    SALES_LLM_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_API_KEY: "sk-ant-test",
    OPENAI_API_KEY: "",
    ...overrides
  } as AppEnv;
}

function buildPrisma(options: {
  dbReachable?: boolean;
  schemaPresent?: boolean;
} = {}) {
  const { dbReachable = true, schemaPresent = true } = options;
  return {
    $queryRaw: vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings[0];
      if (sql.includes("SELECT 1 FROM")) {
        if (!schemaPresent) throw new Error('relation "SalesDeal" does not exist');
        return Promise.resolve([{ "?column?": 1 }]);
      }
      if (sql.includes("SELECT 1")) {
        if (!dbReachable) throw new Error("connection refused");
        return Promise.resolve([{ "?column?": 1 }]);
      }
      return Promise.resolve([]);
    })
  } as any;
}

describe("SalesApp.checkConfig", () => {
  it("passes when all config is present and DB/schema are ok", async () => {
    const app = new SalesApp(buildPrisma(), buildEnv());
    const result = await app.checkConfig();

    expect(result.ok).toBe(true);
    expect(result.details.database).toBe("ok");
    expect(result.details.schema).toBe("ok");
    expect(result.details.hubspot).toContain("token present");
    expect(result.details.llm).toContain("anthropic");
    expect(result.details.llm).toContain("key present");
  });

  it("fails when database is unreachable", async () => {
    const app = new SalesApp(
      buildPrisma({ dbReachable: false }),
      buildEnv()
    );
    const result = await app.checkConfig();

    expect(result.ok).toBe(false);
    expect(result.details.database).toBe("unreachable");
    // Stops early — no further checks
    expect(result.details.schema).toBeUndefined();
    expect(result.details.hubspot).toBeUndefined();
  });

  it("fails when Sales tables are missing (migration not applied)", async () => {
    const app = new SalesApp(
      buildPrisma({ schemaPresent: false }),
      buildEnv()
    );
    const result = await app.checkConfig();

    expect(result.ok).toBe(false);
    expect(result.details.database).toBe("ok");
    expect(result.details.schema).toContain("Sales tables missing");
    // Stops early — no further checks
    expect(result.details.hubspot).toBeUndefined();
  });

  it("fails when HUBSPOT_ACCESS_TOKEN is empty", async () => {
    const app = new SalesApp(
      buildPrisma(),
      buildEnv({ HUBSPOT_ACCESS_TOKEN: "" })
    );
    const result = await app.checkConfig();

    expect(result.ok).toBe(false);
    expect(result.details.database).toBe("ok");
    expect(result.details.schema).toBe("ok");
    expect(result.details.hubspot).toContain("not set");
  });

  it("fails when HUBSPOT_ACCESS_TOKEN is undefined", async () => {
    const app = new SalesApp(
      buildPrisma(),
      buildEnv({ HUBSPOT_ACCESS_TOKEN: undefined })
    );
    const result = await app.checkConfig();

    expect(result.ok).toBe(false);
    expect(result.details.hubspot).toContain("not set");
  });

  it("fails when anthropic key is missing for anthropic provider", async () => {
    const app = new SalesApp(
      buildPrisma(),
      buildEnv({ SALES_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "" })
    );
    const result = await app.checkConfig();

    expect(result.ok).toBe(false);
    expect(result.details.llm).toContain("anthropic");
    expect(result.details.llm).toContain("API key not set");
  });

  it("fails when openai key is missing for openai provider", async () => {
    const app = new SalesApp(
      buildPrisma(),
      buildEnv({ SALES_LLM_PROVIDER: "openai", OPENAI_API_KEY: "" })
    );
    const result = await app.checkConfig();

    expect(result.ok).toBe(false);
    expect(result.details.llm).toContain("openai");
    expect(result.details.llm).toContain("API key not set");
  });

  it("passes with openai provider when openai key is set", async () => {
    const app = new SalesApp(
      buildPrisma(),
      buildEnv({ SALES_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" })
    );
    const result = await app.checkConfig();

    expect(result.ok).toBe(true);
    expect(result.details.llm).toContain("openai");
    expect(result.details.llm).toContain("key present");
  });

  it("defaults to anthropic provider when SALES_LLM_PROVIDER is unset", async () => {
    const app = new SalesApp(
      buildPrisma(),
      buildEnv({ SALES_LLM_PROVIDER: undefined })
    );
    const result = await app.checkConfig();

    expect(result.ok).toBe(true);
    expect(result.details.llm).toContain("anthropic");
  });

  it("does not call external APIs — bogus tokens pass", async () => {
    const app = new SalesApp(
      buildPrisma(),
      buildEnv({
        HUBSPOT_ACCESS_TOKEN: "completely-fake-token",
        ANTHROPIC_API_KEY: "also-fake"
      })
    );
    const result = await app.checkConfig();

    expect(result.ok).toBe(true);
    expect(result.details.hubspot).toContain("not validated");
  });

  it("checks are sequential — database failure prevents all subsequent checks", async () => {
    const prisma = buildPrisma({ dbReachable: false });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.checkConfig();

    expect(Object.keys(result.details)).toEqual(["database"]);
  });

  it("checks are sequential — schema failure prevents config checks", async () => {
    const prisma = buildPrisma({ schemaPresent: false });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.checkConfig();

    expect(Object.keys(result.details)).toEqual(["database", "schema"]);
  });
});
