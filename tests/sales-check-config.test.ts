import { describe, expect, it, vi } from "vitest";

import { SalesApp } from "../src/sales/app.js";
import { runSalesCommand } from "../src/sales/cli.js";
import type { AppEnv } from "../src/config/env.js";
import type { StatusResult } from "../src/sales/app.js";

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

// ---------------------------------------------------------------------------
// SalesApp.runStatus — doctrine wiring and fallback
// ---------------------------------------------------------------------------

describe("SalesApp.runStatus", () => {
  function buildStatusPrisma(opts: {
    doctrine?: { doctrineJson: Record<string, unknown> } | null;
    doctrineThrows?: boolean;
    counters?: Partial<Record<"activities" | "processedActivities" | "deals" | "facts" | "signals", number>>;
  }) {
    const activityCounts = [
      opts.counters?.activities ?? 100,
      opts.counters?.processedActivities ?? 40,
    ];
    let activityIdx = 0;

    const getLatestDoctrine = opts.doctrineThrows
      ? vi.fn().mockRejectedValue(new Error("DB down"))
      : vi.fn().mockResolvedValue(opts.doctrine ?? null);

    return {
      prisma: {
        salesActivity: {
          count: vi.fn().mockImplementation(() => Promise.resolve(activityCounts[activityIdx++] ?? 0)),
        },
        salesDeal: {
          count: vi.fn().mockResolvedValue(opts.counters?.deals ?? 10),
        },
        salesExtractedFact: {
          count: vi.fn().mockResolvedValue(opts.counters?.facts ?? 50),
        },
        salesSignal: {
          count: vi.fn().mockResolvedValue(opts.counters?.signals ?? 8),
        },
        salesDoctrine: {
          findFirst: getLatestDoctrine,
        },
      } as any,
      getLatestDoctrine,
    };
  }

  it("scopes status to intelligence stages when doctrine has stageLabels", async () => {
    const { prisma } = buildStatusPrisma({
      doctrine: {
        doctrineJson: {
          stageLabels: { "s1": "New", "s2": "Opportunity Validated", "s3": "Trial" },
          intelligenceStages: ["New", "Opportunity Validated"],
        },
      },
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runStatus("c1");

    expect(result.totalActivities).toBe(100);
    expect(result.processedActivities).toBe(40);
    expect(result.processingRate).toBe(40);

    // Verify fact count was called with stage-scoped filter
    const factWhere = prisma.salesExtractedFact.count.mock.calls[0][0].where;
    expect(factWhere.deal.stage.in).toEqual(expect.arrayContaining(["s1", "s2"]));
    expect(factWhere.deal.stage.in).not.toContain("s3");

    // Verify signal count was also scoped
    const signalWhere = prisma.salesSignal.count.mock.calls[0][0].where;
    expect(signalWhere.deal.stage.in).toEqual(expect.arrayContaining(["s1", "s2"]));
  });

  it("falls back to unscoped status when doctrine load fails", async () => {
    const { prisma } = buildStatusPrisma({ doctrineThrows: true });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runStatus("c1");

    // Should still return results, just unscoped
    expect(result.totalActivities).toBe(100);
    expect(result.processingRate).toBe(40);

    // Fact query should NOT have deal.stage filter
    const factWhere = prisma.salesExtractedFact.count.mock.calls[0][0].where;
    expect(factWhere.deal).toBeUndefined();
  });

  it("falls back to unscoped status when no doctrine exists", async () => {
    const { prisma } = buildStatusPrisma({ doctrine: null });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runStatus("c1");

    const factWhere = prisma.salesExtractedFact.count.mock.calls[0][0].where;
    expect(factWhere.deal).toBeUndefined();
  });

  it("falls back to unscoped when doctrine has no stageLabels", async () => {
    const { prisma } = buildStatusPrisma({
      doctrine: {
        doctrineJson: {
          // No stageLabels at all
          stalenessThresholdDays: 21,
        },
      },
    });
    const app = new SalesApp(prisma, buildEnv());
    const result = await app.runStatus("c1");

    const factWhere = prisma.salesExtractedFact.count.mock.calls[0][0].where;
    expect(factWhere.deal).toBeUndefined();
  });

  it("uses default intelligenceStages when doctrine omits them", async () => {
    const { prisma } = buildStatusPrisma({
      doctrine: {
        doctrineJson: {
          stageLabels: { "s1": "New", "s2": "Opportunity Validated", "s3": "Lost" },
          // intelligenceStages omitted — defaults to ["New", "Opportunity Validated"]
        },
      },
    });
    const app = new SalesApp(prisma, buildEnv());
    await app.runStatus("c1");

    const dealWhere = prisma.salesDeal.count.mock.calls[0][0].where;
    expect(dealWhere.stage.in).toEqual(expect.arrayContaining(["s1", "s2"]));
    expect(dealWhere.stage.in).not.toContain("s3");
  });
});

// ---------------------------------------------------------------------------
// sales:status CLI — operator-visible output
// ---------------------------------------------------------------------------

describe("sales:status CLI output", () => {
  it("emits all operator-visible metrics via logger.info", async () => {
    const statusResult: StatusResult = {
      totalActivities: 632,
      processedActivities: 31,
      unprocessedActivities: 601,
      processingRate: 4.9,
      totalDeals: 25,
      totalFacts: 151,
      totalSignals: 20,
    };

    const mockApp = { runStatus: vi.fn().mockResolvedValue(statusResult) } as any;
    const mockPrisma = {
      company: { findUnique: vi.fn().mockResolvedValue({ id: "c1", name: "Test Co", slug: "default" }) },
    } as any;
    const logged: Record<string, unknown>[] = [];
    const mockLogger = {
      info: vi.fn().mockImplementation((obj: unknown) => { if (typeof obj === "object") logged.push(obj as any); }),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any;

    await runSalesCommand({
      command: "sales:status",
      app: mockApp,
      prisma: mockPrisma,
      env: {} as any,
      logger: mockLogger,
      exit: () => {},
    });

    expect(mockApp.runStatus).toHaveBeenCalledWith("c1");

    // Find the status log call (the one with "activities" key)
    const statusLog = logged.find((o) => "activities" in o);
    expect(statusLog).toBeDefined();
    expect(statusLog!.activities).toBe("31/632 processed (4.9%)");
    expect(statusLog!.unprocessed).toBe(601);
    expect(statusLog!.deals).toBe(25);
    expect(statusLog!.facts).toBe(151);
    expect(statusLog!.signals).toBe(20);
  });
});
