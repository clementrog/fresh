import { describe, expect, it, vi } from "vitest";
import {
  classifyHubSpotError,
  translateSalesError,
  runPreflight,
  RateLimiter,
  type HubSpotApiPort,
  type PreflightResult,
  type PreflightHubSpotClient,
} from "../src/sales/connectors/hubspot.js";
import { runSalesCommand, type SalesCommandOpts } from "../src/sales/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHubSpotError(code: number, message = "HubSpot error"): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

function makeStatusCodeError(statusCode: number, message = "HubSpot error"): Error {
  const err = new Error(message);
  (err as any).statusCode = statusCode;
  return err;
}

function buildMockApi(overrides?: Partial<HubSpotApiPort>): HubSpotApiPort {
  return {
    searchDeals: vi.fn<any>().mockResolvedValue({ total: 0, results: [] }),
    getContactById: vi.fn<any>().mockResolvedValue({ id: "c1", properties: {} }),
    getCompanyById: vi.fn<any>().mockResolvedValue({ id: "co1", properties: {} }),
    getAssociations: vi.fn<any>().mockResolvedValue([]),
    getEngagementById: vi.fn<any>().mockResolvedValue({ id: "e1", properties: {} }),
    ...overrides,
  };
}

function buildMockClient(overrides?: {
  getAll?: any;
  getById?: any;
}): PreflightHubSpotClient {
  return {
    crm: {
      pipelines: {
        pipelinesApi: {
          getAll: overrides?.getAll ?? vi.fn().mockResolvedValue({
            results: [{ id: "pipeline-1", label: "Sales Pipeline" }],
          }),
          getById: overrides?.getById ?? vi.fn().mockResolvedValue({
            id: "pipeline-1",
            label: "Sales Pipeline",
            stages: [{ id: "s1", label: "Negotiation" }],
          }),
        },
      },
    },
  };
}

function buildMockDoctrineRepos(doctrine?: Record<string, unknown> | null) {
  return {
    getLatestDoctrine: vi.fn().mockResolvedValue(
      doctrine === null
        ? null
        : {
            doctrineJson: {
              hubspotPipelineId: "pipeline-1",
              stalenessThresholdDays: 21,
              ...doctrine,
            },
          }
    ),
  };
}

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

/** Build a mock API that returns a sample deal with associations for full preflight pass */
function buildFullyPopulatedMockApi(): HubSpotApiPort {
  return {
    searchDeals: vi.fn<any>().mockResolvedValue({
      total: 1,
      results: [{ id: "deal-1", properties: { hs_object_id: "deal-1" } }],
    }),
    getContactById: vi.fn<any>().mockResolvedValue({ id: "c1", properties: { email: "a@b.com" } }),
    getCompanyById: vi.fn<any>().mockResolvedValue({ id: "co1", properties: { name: "Acme" } }),
    getAssociations: vi.fn<any>().mockResolvedValue([{ toObjectId: "1" }]),
    getEngagementById: vi.fn<any>().mockResolvedValue({ id: "e1", properties: { hs_timestamp: "2026-01-01" } }),
  };
}

// ---------------------------------------------------------------------------
// classifyHubSpotError
// ---------------------------------------------------------------------------

describe("classifyHubSpotError", () => {
  it("maps code 401 to auth_invalid", () => {
    expect(classifyHubSpotError(makeHubSpotError(401))).toBe("auth_invalid");
  });

  it("maps code 403 to auth_insufficient", () => {
    expect(classifyHubSpotError(makeHubSpotError(403))).toBe("auth_insufficient");
  });

  it("maps code 404 to not_found (context-neutral)", () => {
    expect(classifyHubSpotError(makeHubSpotError(404))).toBe("not_found");
  });

  it("maps code 400 to association_unsupported", () => {
    expect(classifyHubSpotError(makeHubSpotError(400))).toBe("association_unsupported");
  });

  it("maps code 429 to rate_limited", () => {
    expect(classifyHubSpotError(makeHubSpotError(429))).toBe("rate_limited");
  });

  it("maps code 500 to transient", () => {
    expect(classifyHubSpotError(makeHubSpotError(500))).toBe("transient");
  });

  it("maps code 502 to transient", () => {
    expect(classifyHubSpotError(makeHubSpotError(502))).toBe("transient");
  });

  it("maps code 503 to transient", () => {
    expect(classifyHubSpotError(makeHubSpotError(503))).toBe("transient");
  });

  it("maps ECONNREFUSED to transient", () => {
    expect(classifyHubSpotError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe("transient");
  });

  it("maps ETIMEDOUT to transient", () => {
    expect(classifyHubSpotError(new Error("connect ETIMEDOUT"))).toBe("transient");
  });

  it("maps non-Error to unknown", () => {
    expect(classifyHubSpotError("some string")).toBe("unknown");
    expect(classifyHubSpotError(42)).toBe("unknown");
    expect(classifyHubSpotError(null)).toBe("unknown");
  });

  it("maps generic Error without code to unknown", () => {
    expect(classifyHubSpotError(new Error("something broke"))).toBe("unknown");
  });

  it("extracts status from plain thrown objects (non-Error)", () => {
    expect(classifyHubSpotError({ code: 429 })).toBe("rate_limited");
    expect(classifyHubSpotError({ statusCode: 401 })).toBe("auth_invalid");
    expect(classifyHubSpotError({ code: 404 })).toBe("not_found");
    expect(classifyHubSpotError({ code: "ECONNREFUSED" })).toBe("unknown"); // string code, not numeric
  });
});

// ---------------------------------------------------------------------------
// RateLimiter retry-path
// ---------------------------------------------------------------------------

describe("RateLimiter", () => {
  it("retries on .code = 429 and succeeds", async () => {
    const limiter = new RateLimiter(99999, 3, 1); // 1ms delay for fast tests
    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      if (calls < 3) throw makeHubSpotError(429);
      return "ok";
    });

    const result = await limiter.execute(op);
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("retries on .statusCode = 429 and succeeds", async () => {
    const limiter = new RateLimiter(99999, 3, 1);
    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      if (calls < 2) throw makeStatusCodeError(429);
      return "ok";
    });

    const result = await limiter.execute(op);
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries on 429", async () => {
    const limiter = new RateLimiter(99999, 2, 1);
    const op = vi.fn(async () => {
      throw makeHubSpotError(429, "Too many requests");
    });

    await expect(limiter.execute(op)).rejects.toThrow("Too many requests");
    expect(op).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does NOT retry on non-429 errors", async () => {
    const limiter = new RateLimiter(99999, 3, 1);
    const op = vi.fn(async () => {
      throw makeHubSpotError(500, "Server error");
    });

    await expect(limiter.execute(op)).rejects.toThrow("Server error");
    expect(op).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// translateSalesError
// ---------------------------------------------------------------------------

describe("translateSalesError", () => {
  it("translates 401 to authentication message", () => {
    const result = translateSalesError(makeHubSpotError(401));
    expect(result.message).toContain("authentication failed");
    expect(result.message).toContain("HUBSPOT_ACCESS_TOKEN");
    expect(result.exitCode).toBe(1);
  });

  it("translates 403 to permissions message", () => {
    const result = translateSalesError(makeHubSpotError(403));
    expect(result.message).toContain("permissions");
    expect(result.message).toContain("scopes");
    expect(result.exitCode).toBe(1);
  });

  it("translates 429 to rate limit message", () => {
    const result = translateSalesError(makeHubSpotError(429));
    expect(result.message).toContain("rate limit");
    expect(result.message).toContain("60 seconds");
    expect(result.exitCode).toBe(1);
  });

  it("translates 500 to transient message", () => {
    const result = translateSalesError(makeHubSpotError(500));
    expect(result.message).toContain("temporarily unreachable");
    expect(result.exitCode).toBe(1);
  });

  it("translates doctrine missing error", () => {
    const result = translateSalesError(new Error("No SalesDoctrine found for company xyz"));
    expect(result.message).toContain("No SalesDoctrine");
    expect(result.exitCode).toBe(1);
  });

  it("translates doctrine validation error preserving details", () => {
    const result = translateSalesError(new Error("SalesDoctrine validation failed: hubspotPipelineId: required"));
    expect(result.message).toContain("invalid");
    expect(result.message).toContain("hubspotPipelineId");
    expect(result.exitCode).toBe(1);
  });

  it("translates ECONNREFUSED to transient message", () => {
    const result = translateSalesError(new Error("connect ECONNREFUSED"));
    expect(result.message).toContain("temporarily unreachable");
    expect(result.exitCode).toBe(1);
  });

  it("translates missing HUBSPOT_ACCESS_TOKEN to actionable message", () => {
    const result = translateSalesError(new Error("HUBSPOT_ACCESS_TOKEN is not configured"));
    expect(result.message).toContain("HUBSPOT_ACCESS_TOKEN");
    expect(result.message).toContain("Set it");
    expect(result.message).not.toContain("Unexpected error");
    expect(result.exitCode).toBe(1);
  });

  it("translates 404 to generic not-found (not pipeline-specific)", () => {
    const result = translateSalesError(makeHubSpotError(404, "Contact not found"));
    expect(result.message).toContain("not found");
    expect(result.message).not.toContain("pipeline");
    expect(result.exitCode).toBe(1);
  });

  it("falls back for unknown errors with original message", () => {
    const result = translateSalesError(new Error("something completely new"));
    expect(result.message).toContain("something completely new");
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runPreflight
// ---------------------------------------------------------------------------

describe("runPreflight", () => {
  it("passes all checks when fully populated data exists", async () => {
    const api = buildFullyPopulatedMockApi();
    const client = buildMockClient();
    const repos = buildMockDoctrineRepos();

    const result = await runPreflight({ api, client, repos, companyId: "co-1", logger: mockLogger });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
    expect(result.checks.length).toBe(14);
    expect(result.summary).toBe("14 passed");
  });

  // --- Prerequisite suppression ---

  it("auth 401 suppresses all remote dependents; doctrine still runs", async () => {
    const api = buildMockApi({
      searchDeals: vi.fn<any>().mockRejectedValue(makeHubSpotError(401)),
    });
    const client = buildMockClient();
    const repos = buildMockDoctrineRepos();

    const result = await runPreflight({ api, client, repos, companyId: "co-1", logger: mockLogger });

    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);

    const auth = result.checks.find((c) => c.name === "auth")!;
    expect(auth.status).toBe("fail");
    expect(auth.errorClass).toBe("auth_invalid");

    const doctrine = result.checks.find((c) => c.name === "doctrine")!;
    expect(doctrine.status).toBe("pass");

    // All remote-dependent checks should be skip
    const skipped = result.checks.filter((c) => c.status === "skip");
    expect(skipped.length).toBe(12); // portal + pipeline + 4 object_reads + 6 associations

    // Only 1 API call made (searchDeals for auth)
    expect(api.searchDeals).toHaveBeenCalledTimes(1);
    expect(api.getContactById).not.toHaveBeenCalled();
    expect(api.getAssociations).not.toHaveBeenCalled();

    expect(result.summary).toContain("1 passed");
    expect(result.summary).toContain("1 failed");
    expect(result.summary).toContain("12 skipped");
  });

  it("auth failure with verbose SDK error extracts concise HubSpot message", async () => {
    // Simulate the real HubSpot SDK error shape: full HTTP response in .message
    const sdkError = new Error(
      'HTTP-Code: 403\nMessage: An error occurred.\n' +
      'Body: {"status":"error","message":"This app hasn\'t been granted all required scopes to make this call.","correlationId":"abc-123","errors":[]}\n' +
      'Headers: {"x-hubspot-correlation-id":"abc-123","set-cookie":"__cf_bm=longvalue; path=/; HttpOnly"}'
    );
    (sdkError as any).code = 403;

    const api = buildMockApi({
      searchDeals: vi.fn<any>().mockRejectedValue(sdkError),
    });

    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    const auth = result.checks.find((c) => c.name === "auth")!;
    expect(auth.status).toBe("fail");
    // Should contain the concise HubSpot message, not the raw dump
    expect(auth.message).toContain("hasn't been granted all required scopes");
    // Should NOT contain headers or cookies
    expect(auth.message).not.toContain("set-cookie");
    expect(auth.message).not.toContain("Headers:");
    expect(auth.message.length).toBeLessThan(200);
  });

  it("auth 403 gives auth_insufficient with same gating", async () => {
    const api = buildMockApi({
      searchDeals: vi.fn<any>().mockRejectedValue(makeHubSpotError(403)),
    });

    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    expect(result.ok).toBe(false);
    const auth = result.checks.find((c) => c.name === "auth")!;
    expect(auth.errorClass).toBe("auth_insufficient");
    expect(result.checks.filter((c) => c.status === "skip").length).toBe(12);
  });

  it("portal failure suppresses pipeline + probes", async () => {
    const api = buildMockApi();
    const client = buildMockClient({
      getAll: vi.fn().mockRejectedValue(makeHubSpotError(500)),
    });
    const repos = buildMockDoctrineRepos();

    const result = await runPreflight({ api, client, repos, companyId: "co-1", logger: mockLogger });

    expect(result.ok).toBe(false);
    const portal = result.checks.find((c) => c.name === "portal")!;
    expect(portal.status).toBe("fail");

    const doctrine = result.checks.find((c) => c.name === "doctrine")!;
    expect(doctrine.status).toBe("pass"); // local, still runs

    const skipped = result.checks.filter((c) => c.status === "skip");
    expect(skipped.length).toBe(11); // pipeline + 4 object_reads + 6 associations

    expect(result.summary).toContain("2 passed");
    expect(result.summary).toContain("1 failed");
    expect(result.summary).toContain("11 skipped");
  });

  it("doctrine failure suppresses pipeline + all probes", async () => {
    const api = buildMockApi();
    const client = buildMockClient();
    const repos = buildMockDoctrineRepos(null);

    const result = await runPreflight({ api, client, repos, companyId: "co-1", logger: mockLogger });

    expect(result.ok).toBe(false);
    const doctrine = result.checks.find((c) => c.name === "doctrine")!;
    expect(doctrine.status).toBe("fail");
    expect(doctrine.errorClass).toBe("doctrine_missing");

    const skipped = result.checks.filter((c) => c.status === "skip");
    expect(skipped.length).toBe(11);

    expect(result.summary).toContain("2 passed");
    expect(result.summary).toContain("1 failed");
    expect(result.summary).toContain("11 skipped");
  });

  it("pipeline failure suppresses object_reads + associations", async () => {
    const api = buildMockApi();
    const client = buildMockClient({
      getById: vi.fn().mockRejectedValue(makeHubSpotError(404)),
    });
    const repos = buildMockDoctrineRepos();

    const result = await runPreflight({ api, client, repos, companyId: "co-1", logger: mockLogger });

    expect(result.ok).toBe(false);
    const pipeline = result.checks.find((c) => c.name === "pipeline")!;
    expect(pipeline.status).toBe("fail");
    expect(pipeline.errorClass).toBe("pipeline_not_found");

    const skipped = result.checks.filter((c) => c.status === "skip");
    expect(skipped.length).toBe(10); // 4 object_reads + 6 associations

    expect(result.summary).toContain("3 passed");
    expect(result.summary).toContain("1 failed");
    expect(result.summary).toContain("10 skipped");
  });

  // --- Doctrine/pipeline detail ---

  it("doctrine invalid gives doctrine_invalid", async () => {
    const repos = buildMockDoctrineRepos({ hubspotPipelineId: "" });

    const result = await runPreflight({ api: buildMockApi(), client: buildMockClient(), repos, companyId: "co-1", logger: mockLogger });

    const doctrine = result.checks.find((c) => c.name === "doctrine")!;
    expect(doctrine.status).toBe("fail");
    expect(doctrine.errorClass).toBe("doctrine_invalid");
  });

  it("pipeline 403 gives pipeline_inaccessible", async () => {
    const client = buildMockClient({
      getById: vi.fn().mockRejectedValue(makeHubSpotError(403)),
    });

    const result = await runPreflight({ api: buildMockApi(), client, repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    const pipeline = result.checks.find((c) => c.name === "pipeline")!;
    expect(pipeline.status).toBe("fail");
    expect(pipeline.errorClass).toBe("pipeline_inaccessible");
  });

  // --- Partial readiness (unverified) ---

  it("empty pipeline: deals passes but dependent sub-checks warn as unverified", async () => {
    // searchDeals returns 0 results for the pipeline-filtered search
    const api = buildMockApi({
      searchDeals: vi.fn<any>().mockResolvedValue({ total: 0, results: [] }),
    });
    const client = buildMockClient();
    const repos = buildMockDoctrineRepos();

    const result = await runPreflight({ api, client, repos, companyId: "co-1", logger: mockLogger });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);

    const dealsCheck = result.checks.find((c) => c.name === "object_reads:deals")!;
    expect(dealsCheck.status).toBe("pass");

    // Sub-checks that need a sample deal should be warn
    for (const name of ["object_reads:contacts", "object_reads:companies", "object_reads:engagements"]) {
      const check = result.checks.find((c) => c.name === name)!;
      expect(check.status).toBe("warn");
      expect(check.message).toContain("unverified");
    }

    // All 6 assoc checks should be warn
    const assocChecks = result.checks.filter((c) => c.name.startsWith("assoc:"));
    expect(assocChecks.length).toBe(6);
    for (const c of assocChecks) {
      expect(c.status).toBe("warn");
      expect(c.message).toContain("unverified");
    }

    expect(result.summary).toContain("5 passed");
    expect(result.summary).toContain("9 unverified");
  });

  it("deal exists but no contact associations warns contacts as unverified", async () => {
    const baseApi = buildFullyPopulatedMockApi();
    const api = {
      ...baseApi,
      getAssociations: vi.fn<any>().mockImplementation(async (...args: unknown[]) => {
        const toType = args[2] as string;
        if (toType === "contacts") return [];
        return [{ toObjectId: "1" }];
      }),
    };

    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    const contactCheck = result.checks.find((c) => c.name === "object_reads:contacts")!;
    expect(contactCheck.status).toBe("warn");
    expect(contactCheck.message).toContain("unverified");
  });

  it("deal exists but no engagement associations warns engagements as unverified", async () => {
    const api = {
      ...buildFullyPopulatedMockApi(),
      getAssociations: vi.fn<any>().mockImplementation(async (...args: unknown[]) => {
        const toType = args[2] as string;
        if (["emails", "notes", "calls", "meetings"].includes(toType)) return [];
        return [{ toObjectId: "1" }];
      }),
    };

    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    const engCheck = result.checks.find((c) => c.name === "object_reads:engagements")!;
    expect(engCheck.status).toBe("warn");
    expect(engCheck.message).toContain("unverified");
  });

  // --- Error classification within probes ---

  it("association 400 gives association_unsupported on specific sub-check", async () => {
    const api = {
      ...buildFullyPopulatedMockApi(),
      getAssociations: vi.fn<any>().mockImplementation(async (...args: unknown[]) => {
        const toType = args[2] as string;
        if (toType === "emails") throw makeHubSpotError(400, "Association not supported");
        return [{ toObjectId: "1" }];
      }),
    };

    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    const emailAssoc = result.checks.find((c) => c.name === "assoc:deal→emails")!;
    expect(emailAssoc.status).toBe("fail");
    expect(emailAssoc.errorClass).toBe("association_unsupported");
  });

  // --- 404 classification is contextual ---

  it("pipeline 404 is classified as pipeline_not_found", async () => {
    const client = buildMockClient({
      getById: vi.fn().mockRejectedValue(makeHubSpotError(404, "Pipeline not found")),
    });

    const result = await runPreflight({ api: buildMockApi(), client, repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    const pipeline = result.checks.find((c) => c.name === "pipeline")!;
    expect(pipeline.status).toBe("fail");
    expect(pipeline.errorClass).toBe("pipeline_not_found");
  });

  it("contact 404 is classified as not_found, not pipeline_not_found", async () => {
    const api = {
      ...buildFullyPopulatedMockApi(),
      getContactById: vi.fn<any>().mockRejectedValue(makeHubSpotError(404, "Contact not found")),
    };

    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    const contactCheck = result.checks.find((c) => c.name === "object_reads:contacts")!;
    expect(contactCheck.status).toBe("fail");
    expect(contactCheck.errorClass).toBe("not_found");
    expect(contactCheck.errorClass).not.toBe("pipeline_not_found");
  });

  it("company 404 is classified as not_found, not pipeline_not_found", async () => {
    const api = {
      ...buildFullyPopulatedMockApi(),
      getCompanyById: vi.fn<any>().mockRejectedValue(makeHubSpotError(404, "Company not found")),
    };

    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    const companyCheck = result.checks.find((c) => c.name === "object_reads:companies")!;
    expect(companyCheck.status).toBe("fail");
    expect(companyCheck.errorClass).toBe("not_found");
  });

  it("engagement 404 is classified as not_found, not pipeline_not_found", async () => {
    const api = {
      ...buildFullyPopulatedMockApi(),
      getEngagementById: vi.fn<any>().mockRejectedValue(makeHubSpotError(404, "Engagement not found")),
    };

    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    const engCheck = result.checks.find((c) => c.name === "object_reads:engagements")!;
    expect(engCheck.status).toBe("fail");
    expect(engCheck.errorClass).toBe("not_found");
  });

  // --- Summary contract ---

  it("ok is true iff zero checks have fail status", async () => {
    const api = buildMockApi({
      searchDeals: vi.fn<any>().mockResolvedValue({ total: 0, results: [] }),
    });

    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    expect(result.ok).toBe(true);
    expect(result.checks.some((c) => c.status === "fail")).toBe(false);
  });

  it("verified is true iff all checks are pass", async () => {
    const api = buildFullyPopulatedMockApi();
    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    expect(result.verified).toBe(true);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("verified is false when any check is warn or skip", async () => {
    const api = buildMockApi({ searchDeals: vi.fn<any>().mockResolvedValue({ total: 0, results: [] }) });
    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    expect(result.verified).toBe(false);
    expect(result.checks.some((c) => c.status === "warn")).toBe(true);
  });

  it("summary omits zero-count segments", async () => {
    const api = buildFullyPopulatedMockApi();
    const result = await runPreflight({ api, client: buildMockClient(), repos: buildMockDoctrineRepos(), companyId: "co-1", logger: mockLogger });

    expect(result.summary).toBe("14 passed");
    expect(result.summary).not.toContain("failed");
    expect(result.summary).not.toContain("skipped");
  });

  // --- Non-mutating contract ---

  it("structural: repos only exposes getLatestDoctrine", async () => {
    const repos = { getLatestDoctrine: vi.fn().mockResolvedValue({ doctrineJson: { hubspotPipelineId: "p-1" } }) };
    // TypeScript ensures no other methods can be called — this test proves the mock shape
    expect(Object.keys(repos)).toEqual(["getLatestDoctrine"]);

    const result = await runPreflight({
      api: buildFullyPopulatedMockApi(),
      client: buildMockClient(),
      repos,
      companyId: "co-1",
      logger: mockLogger,
    });

    expect(result.ok).toBe(true);
    expect(repos.getLatestDoctrine).toHaveBeenCalledTimes(1);
  });

  it("non-mutating after auth failure: only getLatestDoctrine called", async () => {
    const repos = buildMockDoctrineRepos();
    const api = buildMockApi({ searchDeals: vi.fn<any>().mockRejectedValue(makeHubSpotError(401)) });

    await runPreflight({ api, client: buildMockClient(), repos, companyId: "co-1", logger: mockLogger });

    expect(repos.getLatestDoctrine).toHaveBeenCalledTimes(1);
    // No other methods exist on the repos mock to have been called
    expect(Object.keys(repos)).toEqual(["getLatestDoctrine"]);
  });

  it("non-mutating after full pass: only getLatestDoctrine called", async () => {
    const repos = buildMockDoctrineRepos();
    const api = buildFullyPopulatedMockApi();

    await runPreflight({ api, client: buildMockClient(), repos, companyId: "co-1", logger: mockLogger });

    expect(repos.getLatestDoctrine).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Command-entrypoint verification
// ---------------------------------------------------------------------------

describe("runSalesCommand", () => {
  function buildBaseOpts(overrides?: Partial<SalesCommandOpts>): SalesCommandOpts {
    return {
      command: "sales:preflight",
      app: {} as any,
      prisma: {
        company: {
          findUnique: vi.fn().mockResolvedValue({ id: "co-1", name: "Test Co", slug: "default" }),
        },
        $disconnect: vi.fn(),
      } as any,
      env: { DEFAULT_COMPANY_SLUG: "default" } as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      exit: vi.fn(),
      ...overrides,
    };
  }

  // Path A: preflight structured result

  it("preflight failure renders checks and exits 1 (no translator)", async () => {
    const failedResult: PreflightResult = {
      ok: false,
      verified: false,
      checks: [
        { name: "auth", status: "fail", message: "Authentication failed", errorClass: "auth_invalid", durationMs: 100 },
        ...Array.from({ length: 12 }, (_, i) => ({
          name: `skip-${i}`,
          status: "skip" as const,
          message: "skipped — auth check failed",
          durationMs: 0,
        })),
        { name: "doctrine", status: "pass", message: "ok", durationMs: 1 },
      ],
      summary: "1 passed, 1 failed, 12 skipped",
    };

    const opts = buildBaseOpts({
      command: "sales:preflight",
      app: { runPreflight: vi.fn().mockResolvedValue(failedResult) } as any,
    });

    await runSalesCommand(opts);

    expect(opts.logger.error).toHaveBeenCalledWith(expect.stringContaining("Preflight FAILED"));
    expect(opts.exit).toHaveBeenCalledWith(1);
  });

  it("preflight partial readiness prints PASSED with caveats, does NOT exit 1", async () => {
    const partialResult: PreflightResult = {
      ok: true,
      verified: false,
      checks: [
        ...Array.from({ length: 5 }, (_, i) => ({
          name: `pass-${i}`,
          status: "pass" as const,
          message: "ok",
          durationMs: 1,
        })),
        ...Array.from({ length: 9 }, (_, i) => ({
          name: `warn-${i}`,
          status: "warn" as const,
          message: "unverified",
          durationMs: 0,
        })),
      ],
      summary: "5 passed, 9 unverified",
    };

    const opts = buildBaseOpts({
      command: "sales:preflight",
      app: { runPreflight: vi.fn().mockResolvedValue(partialResult) } as any,
    });

    await runSalesCommand(opts);

    expect(opts.logger.info).toHaveBeenCalledWith(expect.stringContaining("PASSED with caveats"));
    expect(opts.exit).not.toHaveBeenCalled();
  });

  it("preflight full pass prints all capabilities verified", async () => {
    const fullResult: PreflightResult = {
      ok: true,
      verified: true,
      checks: Array.from({ length: 14 }, (_, i) => ({
        name: `check-${i}`,
        status: "pass" as const,
        message: "ok",
        durationMs: 1,
      })),
      summary: "14 passed",
    };

    const opts = buildBaseOpts({
      command: "sales:preflight",
      app: { runPreflight: vi.fn().mockResolvedValue(fullResult) } as any,
    });

    await runSalesCommand(opts);

    expect(opts.logger.info).toHaveBeenCalledWith(expect.stringContaining("all capabilities verified"));
    expect(opts.exit).not.toHaveBeenCalled();
  });

  // Path B: sync translated exception

  it("sync auth 401 translates to authentication message and exits 1", async () => {
    const opts = buildBaseOpts({
      command: "sales:sync",
      app: { runSync: vi.fn().mockRejectedValue(makeHubSpotError(401)) } as any,
    });

    await runSalesCommand(opts);

    expect(opts.logger.error).toHaveBeenCalledWith(expect.stringContaining("authentication failed"));
    expect(opts.exit).toHaveBeenCalledWith(1);
  });

  it("sync ECONNREFUSED translates to transient message and exits 1", async () => {
    const opts = buildBaseOpts({
      command: "sales:sync",
      app: { runSync: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")) } as any,
    });

    await runSalesCommand(opts);

    expect(opts.logger.error).toHaveBeenCalledWith(expect.stringContaining("temporarily unreachable"));
    expect(opts.exit).toHaveBeenCalledWith(1);
  });

  it("sync missing HUBSPOT_ACCESS_TOKEN translates to actionable message", async () => {
    const opts = buildBaseOpts({
      command: "sales:sync",
      app: { runSync: vi.fn().mockRejectedValue(new Error("HUBSPOT_ACCESS_TOKEN is not configured")) } as any,
    });

    await runSalesCommand(opts);

    expect(opts.logger.error).toHaveBeenCalledWith(expect.stringContaining("HUBSPOT_ACCESS_TOKEN"));
    expect(opts.logger.error).toHaveBeenCalledWith(expect.stringContaining("Set it"));
    // Must NOT be the generic "Unexpected error" fallback
    const errorCalls = (opts.logger.error as any).mock.calls.map((c: any) => c[0]);
    const translatedMsg = errorCalls.find((m: any) => typeof m === "string" && m.includes("HUBSPOT_ACCESS_TOKEN"));
    expect(translatedMsg).not.toContain("Unexpected error");
    expect(opts.exit).toHaveBeenCalledWith(1);
  });

  // Path C: unexpected fatal

  it("preflight unexpected throw propagates to caller", async () => {
    const opts = buildBaseOpts({
      command: "sales:preflight",
      app: { runPreflight: vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined")) } as any,
    });

    await expect(runSalesCommand(opts)).rejects.toThrow(TypeError);
    expect(opts.exit).not.toHaveBeenCalled();
  });
});
