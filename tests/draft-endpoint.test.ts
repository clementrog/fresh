import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

import { registerDraftRoute } from "../src/server.js";
import { NotFoundError, ForbiddenError, UnprocessableError } from "../src/lib/errors.js";
import type { EditorialSignalEngineApp } from "../src/app.js";

function buildServer(runImpl: (...args: unknown[]) => unknown) {
  const app = { run: runImpl } as unknown as EditorialSignalEngineApp;
  const server = Fastify({ logger: false });
  registerDraftRoute(server, app);
  return server;
}

describe("draft endpoint", () => {
  it("returns 404 when opportunity not found", async () => {
    const server = buildServer(() => {
      throw new NotFoundError("Opportunity opp_123 not found");
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/companies/acme/opportunities/opp_123/draft"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toContain("not found");
  });

  it("returns 403 when company ownership mismatch", async () => {
    const server = buildServer(() => {
      throw new ForbiddenError("Opportunity does not belong to company");
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/companies/acme/opportunities/opp_123/draft"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("does not belong");
  });

  it("returns 422 when insufficient inputs", async () => {
    const server = buildServer(() => {
      throw new UnprocessableError("No editorial config");
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/companies/acme/opportunities/opp_123/draft"
    });

    expect(response.statusCode).toBe(422);
  });

  it("returns 200 on success with correct response shape", async () => {
    const server = buildServer(() => ({ id: "draft_abc" }));

    const response = await server.inject({
      method: "POST",
      url: "/v1/companies/acme/opportunities/opp_123/draft"
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.opportunityId).toBe("opp_123");
    expect(body.draftId).toBe("draft_abc");
  });

  it("returns 500 for unexpected errors without leaking internals", async () => {
    const server = buildServer(() => {
      throw new Error("Database connection lost at 10.0.0.5:5432");
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/companies/acme/opportunities/opp_123/draft"
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.message).toBe("Internal server error");
    expect(body.message).not.toContain("10.0.0.5");
  });
});

describe("anti-regression: syncDaily cannot create drafts (runtime)", () => {
  it("syncDaily completes without calling persistDraftGraph, creating drafts, or promoting opportunities", async () => {
    const persistDraftGraph = vi.fn();
    const createDraft = vi.fn();
    const updateSyncRunCalls: unknown[] = [];

    const repositories = {
      // convergence foundation (ensureConvergenceFoundation gracefully skips missing methods)
      getCompanyBySlug: vi.fn(async () => ({
        id: "company_1",
        slug: "default",
        name: "Default",
        defaultTimezone: "Europe/Paris"
      })),
      // sync:daily lifecycle
      createSyncRun: vi.fn(async () => ({})),
      updateSyncRun: vi.fn(async (run: unknown) => {
        updateSyncRunCalls.push(run);
      }),
      addCostEntries: vi.fn(async () => ({})),
      updateSyncRunNotionSync: vi.fn(async () => ({})),
      // connector support
      getCursor: vi.fn(async () => null),
      setCursor: vi.fn(async () => ({})),
      // profile loading (called by loadStaticInputs for each file-based profile)
      upsertProfileBase: vi.fn(async () => ({})),
      // signal/opportunity persistence (non-dryRun path)
      upsertThemeCluster: vi.fn(async () => ({})),
      persistSignalGraph: vi.fn(async () => ({})),
      updateSignalNotionSync: vi.fn(async () => ({})),
      findSourceItemByFingerprint: vi.fn(async () => null),
      upsertSourceItem: vi.fn(async () => ({})),
      listAllOpportunityFingerprints: vi.fn(async () => []),
      persistOpportunityGraph: vi.fn(async () => ({})),
      persistFullOpportunityGraph: vi.fn(async () => ({})),
      updateOpportunityNotionSync: vi.fn(async () => ({})),
      updateSourceItemNotionSync: vi.fn(async () => ({})),
      // profile refresh (called by refreshProfiles — only reached if old auto-draft code existed)
      upsertProfileLearnedLayer: vi.fn(async () => ({})),
      updateProfileBaseNotionSync: vi.fn(async () => ({})),
      countDraftsForProfileToday: vi.fn(async () => 0),
      // draft-related spies — MUST NOT be called
      persistDraftGraph,
      createDraft
    } as any;

    const notion = {
      syncRun: vi.fn(async () => null),
      syncSignal: vi.fn(async () => null),
      syncOpportunity: vi.fn(async () => null),
      syncProfile: vi.fn(async () => null),
      syncUser: vi.fn(async () => null),
      syncMarketFinding: vi.fn(async () => null),
      isEnabled: vi.fn(() => false)
    } as any;

    // LLM client that returns valid structured JSON for every call,
    // preventing fallback threshold aborts.
    const { LlmClient } = await import("../src/services/llm.js");
    const llmClient = new LlmClient(
      {
        DATABASE_URL: "",
        NOTION_TOKEN: "",
        NOTION_PARENT_PAGE_ID: "",
        SLACK_BOT_TOKEN: "",
        SLACK_EDITORIAL_OPERATOR_ID: "",
        OPENAI_API_KEY: "test-key",
        CLAAP_API_KEY: "",
        LINEAR_API_KEY: "",
        DEFAULT_TIMEZONE: "Europe/Paris",
        LLM_MODEL: "test",
        LLM_TIMEOUT_MS: 100,
        LOG_LEVEL: "info"
      },
      undefined,
      async (_url, options) => {
        const body = JSON.parse((options as any).body);
        const systemMsg: string = body.messages?.[0]?.content ?? "";
        // Return appropriate structured JSON depending on the LLM step
        let content: string;
        if (systemMsg.includes("sensitivity") || systemMsg.includes("Classify sensitive")) {
          content = JSON.stringify({
            blocked: false,
            categories: [],
            rationale: "Content is safe",
            stageTwoScore: 0.1
          });
        } else if (systemMsg.includes("territory") || systemMsg.includes("owner")) {
          content = JSON.stringify({
            profileId: "quentin",
            territory: "general",
            confidence: 0.8,
            needsRouting: false,
            rationale: "Assigned to quentin"
          });
        } else {
          // Signal extraction / generic
          content = JSON.stringify({
            title: "Test signal",
            summary: "Summary",
            type: "product-insight",
            freshness: 0.8,
            confidence: 0.8,
            suggestedAngle: "Test angle",
            status: "New",
            evidenceIds: ["evidence-1"]
          });
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content } }]
          })
        } as Response;
      }
    );

    const { EditorialSignalEngineApp } = await import("../src/app.js");
    const app = new EditorialSignalEngineApp(
      {
        DATABASE_URL: "",
        NOTION_TOKEN: "",
        NOTION_PARENT_PAGE_ID: "",
        SLACK_BOT_TOKEN: "",
        SLACK_EDITORIAL_OPERATOR_ID: "",
        OPENAI_API_KEY: "test-key",
        CLAAP_API_KEY: "",
        LINEAR_API_KEY: "",
        DEFAULT_TIMEZONE: "Europe/Paris",
        LLM_MODEL: "test",
        LLM_TIMEOUT_MS: 100,
        LOG_LEVEL: "info"
      },
      { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      {
        repositories,
        notion,
        llmClient,
        slack: {
          resolveDigestChannelId: vi.fn(),
          sendDigest: vi.fn(),
          findRecentDigestByKey: vi.fn(),
          sendOperationalAlert: vi.fn(),
          notifySelection: vi.fn()
        } as any
      }
    );

    await app.run("sync:daily", { companySlug: "default" });

    // 1. persistDraftGraph must never be called
    expect(persistDraftGraph).not.toHaveBeenCalled();

    // 2. createDraft must never be called
    expect(createDraft).not.toHaveBeenCalled();

    // 3. run.counters.draftsCreated must be 0
    expect(updateSyncRunCalls.length).toBeGreaterThan(0);
    const finalRun = updateSyncRunCalls.at(-1) as any;
    expect(finalRun.counters.draftsCreated).toBe(0);

    // 4. No opportunity should have been promoted to "V1 generated"
    //    (status/readiness). Since syncDaily no longer touches draft paths,
    //    opportunities created in-run stay at their initial status.
    //    We verify by checking that no syncOpportunity call received a
    //    V1-generated status or a draft object.
    for (const call of (notion.syncOpportunity as ReturnType<typeof vi.fn>).mock.calls) {
      const opportunity = call[0];
      const draft = call[1];
      expect(opportunity.readiness).not.toBe("V1 generated");
      expect(opportunity.status).not.toBe("V1 generated");
      expect(draft?.firstDraftText).toBeUndefined();
    }
  });
});

describe("anti-regression: draft creation only through explicit trigger", () => {
  it("generateDraft is called exactly once in app.ts, inside generateDraftOnDemand", async () => {
    const fs = await import("fs");
    const appSource = fs.readFileSync(new URL("../src/app.ts", import.meta.url), "utf-8");

    const lines = appSource.split("\n");

    // generateDraft( calls (excluding import line and method name references)
    const generateDraftCallLines = lines.filter((line) =>
      line.includes("generateDraft(") &&
      !line.includes("import") &&
      !line.includes("generateDraftOnDemand")
    );
    expect(generateDraftCallLines.length).toBe(1);

    // persistDraftGraph calls (excluding import line)
    const persistLines = lines.filter((line) =>
      line.includes("persistDraftGraph") &&
      !line.includes("import")
    );
    expect(persistLines.length).toBe(1);
  });

  it("draft:generate is the only command that routes to generateDraftOnDemand", async () => {
    const fs = await import("fs");
    const appSource = fs.readFileSync(new URL("../src/app.ts", import.meta.url), "utf-8");

    // Find all references to generateDraftOnDemand in the switch/case
    const routeMatches = appSource.match(/this\.generateDraftOnDemand/g);
    expect(routeMatches).toBeTruthy();
    expect(routeMatches!.length).toBe(1);

    // Verify it's routed from draft:generate
    expect(appSource).toContain('"draft:generate"');
    const switchBlock = appSource.match(/case "draft:generate"[\s\S]*?generateDraftOnDemand/);
    expect(switchBlock).toBeTruthy();
  });
});
