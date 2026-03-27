import { describe, expect, it, vi, beforeEach } from "vitest";
import Fastify from "fastify";

import { registerAdminPlugin, type AdminOptions } from "../src/admin/plugin.js";
import { escapeHtml } from "../src/admin/layout.js";

// ── Mock Prisma ──────────────────────────────────────────────────────────────

function mockPrisma(overrides: Record<string, unknown> = {}) {
  const company = { id: "comp_1", slug: "acme", name: "Acme Corp" };
  const defaultFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
    if (where.slug === "acme" || where.slug === "default") return company;
    return null;
  });

  return {
    company: {
      findUnique: overrides.companyFindUnique ?? defaultFindUnique
    },
    sourceItem: {
      count: vi.fn(async () => 3),
      findMany: vi.fn(async () => [
        {
          id: "si_1",
          source: "claap",
          title: "Test Item",
          occurredAt: new Date("2026-01-01"),
          processedAt: null,
          notionPageId: null,
          screeningResultJson: { decision: "retain" },
          metadataJson: {}
        }
      ]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "si_1") {
          return {
            id: "si_1",
            companyId: "comp_1",
            source: "claap",
            title: "Test Item",
            summary: "A test summary",
            sourceUrl: "https://example.com",
            occurredAt: new Date("2026-01-01"),
            processedAt: null,
            metadataJson: { key: "value" },
            rawPayloadJson: { raw: "data" },
            screeningResultJson: { decision: "retain" },
            evidenceReferences: []
          };
        }
        return null;
      })
    },
    opportunity: {
      count: vi.fn(async () => 2),
      findMany: vi.fn(async () => [
        {
          id: "opp_1",
          title: "Test Opportunity",
          status: "To review",
          readiness: "Opportunity only",
          ownerProfile: "baptiste",
          supportingEvidenceCount: 3,
          notionPageId: null,
          updatedAt: new Date("2026-01-15")
        }
      ]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "opp_1") {
          return {
            id: "opp_1",
            companyId: "comp_1",
            title: "Test Opportunity",
            status: "To review",
            readiness: "Opportunity only",
            ownerProfile: "baptiste",
            angle: "Test angle",
            whyNow: "Test why now",
            whatItIsAbout: "Test about",
            whatItIsNotAbout: "Test not about",
            suggestedFormat: "post",
            supportingEvidenceCount: 3,
            enrichmentLogJson: [],
            notionPageId: null,
            evidence: [],
            linkedEvidence: [],
            drafts: [],
            ownerUser: { id: "u_1", displayName: "Baptiste" },
            primaryEvidence: null
          };
        }
        return null;
      })
    },
    draft: {
      count: vi.fn(async () => 5),
      findMany: vi.fn(async () => [
        {
          id: "d_1",
          proposedTitle: "Test Draft",
          profileId: "baptiste",
          confidenceScore: 0.85,
          language: "fr",
          createdAt: new Date("2026-01-01"),
          opportunity: { id: "opp_1", title: "Test Opportunity" }
        }
      ]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "d_1") {
          return {
            id: "d_1",
            companyId: "comp_1",
            proposedTitle: "Test Draft",
            profileId: "baptiste",
            hook: "Test hook",
            summary: "Test summary",
            whatItIsAbout: "About this",
            whatItIsNotAbout: "Not about that",
            visualIdea: "A chart",
            firstDraftText: "Full draft text content here",
            confidenceScore: 0.85,
            language: "fr",
            createdAt: new Date("2026-01-01"),
            opportunity: { id: "opp_1", title: "Test Opportunity", status: "To review" },
            evidence: []
          };
        }
        return null;
      })
    },
    syncRun: {
      count: vi.fn(async () => 10),
      findMany: vi.fn(async () => [
        {
          id: "run_1",
          runType: "ingest:run",
          source: "claap",
          status: "completed",
          startedAt: new Date("2026-01-01T10:00:00Z"),
          finishedAt: new Date("2026-01-01T10:05:00Z"),
          countersJson: { fetched: 10, processed: 8 },
          notes: null
        }
      ]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "run_1") {
          return {
            id: "run_1",
            companyId: "comp_1",
            runType: "ingest:run",
            source: "claap",
            status: "completed",
            startedAt: new Date("2026-01-01T10:00:00Z"),
            finishedAt: new Date("2026-01-01T10:05:00Z"),
            countersJson: { fetched: 10 },
            warningsJson: [],
            llmStatsJson: null,
            tokenTotalsJson: null,
            notes: null,
            notionPageId: null,
            notionPageFingerprint: "fp",
            createdAt: new Date("2026-01-01"),
            costEntries: [
              {
                id: "ce_1",
                step: "screening",
                model: "gpt-4",
                mode: "provider",
                promptTokens: 100,
                completionTokens: 50,
                estimatedCostUsd: 0.0045,
                runId: "run_1",
                createdAt: new Date("2026-01-01T10:01:00Z")
              }
            ]
          };
        }
        return null;
      })
    },
    user: {
      count: vi.fn(async () => 4),
      findMany: vi.fn(async () => [
        {
          id: "u_1",
          displayName: "Baptiste",
          type: "editor",
          language: "fr",
          createdAt: new Date("2025-06-01")
        }
      ]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "u_1") {
          return {
            id: "u_1",
            companyId: "comp_1",
            displayName: "Baptiste",
            type: "human",
            language: "fr",
            baseProfile: {
              toneSummary: "Warm and direct",
              preferredStructure: "Hook then proof",
              typicalPhrases: ["Let me be clear", "Here is the thing"],
              avoidRules: ["No jargon"],
              contentTerritories: ["SaaS growth"],
              weakFitTerritories: ["Crypto"],
              sampleExcerpts: ["Example excerpt one"]
            },
            createdAt: new Date("2025-06-01"),
            updatedAt: new Date("2025-06-15"),
            _count: { ownedOpportunities: 3 }
          };
        }
        return null;
      })
    },
    editorialConfig: {
      findMany: vi.fn(async () => [
        { id: "ec_1", version: 1, createdAt: new Date("2026-01-01") }
      ]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "ec_1") {
          return {
            id: "ec_1",
            companyId: "comp_1",
            version: 1,
            layer1CompanyLens: {
              doctrineMarkdown: "Test doctrine",
              sensitivityMarkdown: "Test sensitivity"
            },
            layer2ContentPhilosophy: { defaults: ["Specific", "Evidence-backed"] },
            layer3LinkedInCraft: { defaults: ["Max 250 words"] },
            createdAt: new Date("2026-01-01")
          };
        }
        return null;
      })
    },
    sourceConfig: {
      findMany: vi.fn(async () => [
        { id: "sc_1", source: "claap", enabled: true, configJson: { workspace: "test" }, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-15") },
        { id: "sc_2", source: "linear", enabled: false, configJson: { team: "eng" }, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-10") }
      ])
    },
    marketQuery: {
      findMany: vi.fn(async () => [
        { id: "mq_1", query: "AI hiring trends", enabled: true, priority: 1, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-15") },
        { id: "mq_2", query: "Competitor product launches", enabled: false, priority: 2, createdAt: new Date("2026-01-02"), updatedAt: new Date("2026-01-12") }
      ]),
      count: vi.fn(async () => 2)
    }
  } as any;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: AdminOptions = {
  user: "admin",
  password: "secret",
  allowRemote: false,
  defaultCompanySlug: "default"
};

function basicAuth(user: string, password: string): string {
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

function buildServer(opts: Partial<AdminOptions> = {}, prismaOverrides: Record<string, unknown> = {}) {
  const server = Fastify({ logger: false });
  const prisma = mockPrisma(prismaOverrides);
  registerAdminPlugin(server, prisma, { ...DEFAULT_OPTIONS, ...opts });
  return server;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("admin auth", () => {
  it("returns 401 with WWW-Authenticate header when no credentials provided", async () => {
    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="Fresh Admin"');
    expect(res.body).toBe("Unauthorized");
  });

  it("returns 401 when wrong credentials provided", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "wrong") }
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with valid Basic Auth credentials", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("handles passwords containing colons", async () => {
    const server = buildServer({ password: "se:cr:et" });
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "se:cr:et") }
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("admin disabled", () => {
  it("throws at boot when ADMIN_USER is missing", () => {
    expect(() => {
      const server = Fastify({ logger: false });
      registerAdminPlugin(server, mockPrisma(), { ...DEFAULT_OPTIONS, user: "" });
    }).toThrow("ADMIN_USER and ADMIN_PASSWORD must be set");
  });

  it("throws at boot when ADMIN_PASSWORD is missing", () => {
    expect(() => {
      const server = Fastify({ logger: false });
      registerAdminPlugin(server, mockPrisma(), { ...DEFAULT_OPTIONS, password: "" });
    }).toThrow("ADMIN_USER and ADMIN_PASSWORD must be set");
  });
});

describe("transport security", () => {
  it("returns 403 for non-localhost requests when ADMIN_ALLOW_REMOTE is not set", async () => {
    const server = buildServer({ allowRemote: false });
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") },
      remoteAddress: "192.168.1.10"
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("localhost-only");
  });

  it("allows non-localhost requests when ADMIN_ALLOW_REMOTE=true", async () => {
    const server = buildServer({ allowRemote: true });
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") },
      remoteAddress: "192.168.1.10"
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows localhost (127.0.0.1) requests by default", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") },
      remoteAddress: "127.0.0.1"
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("response hardening", () => {
  it("includes Cache-Control: no-store on all /admin responses", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("includes X-Robots-Tag: noindex on all /admin responses", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.headers["x-robots-tag"]).toBe("noindex");
  });
});

describe("company scoping", () => {
  it("uses default company when ?company is absent", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Acme Corp");
  });

  it("uses ?company=slug when provided", async () => {
    const customFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
      if (where.slug === "custom") return { id: "comp_2", slug: "custom", name: "Custom Co" };
      if (where.slug === "default") return { id: "comp_1", slug: "default", name: "Acme Corp" };
      return null;
    });
    const server = buildServer({}, { companyFindUnique: customFindUnique });
    const res = await server.inject({
      method: "GET",
      url: "/admin?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Custom Co");
  });

  it("returns 404 page for unknown company slug", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin?company=nonexistent",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Company not found");
  });

  it("shows company name in nav bar", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.body).toContain("Acme Corp");
  });
});

describe("GET /admin", () => {
  it("returns 200 with HTML content-type", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("contains entity counts in response body", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.body).toContain("Source Items");
    expect(res.body).toContain("Opportunities");
    expect(res.body).toContain("Drafts");
  });

  it("contains disposition breakdown counts", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.body).toContain("Screened Out");
    expect(res.body).toContain("Blocked");
    expect(res.body).toContain("Orphaned");
    expect(res.body).toContain("Unsynced");
  });
});

describe("GET /admin/source-items", () => {
  it("returns 200 with HTML table", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<table>");
    expect(res.body).toContain("Test Item");
  });

  it("respects ?source= filter", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items?source=claap",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
  });

  it("respects ?disposition=screened-out filter", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items?disposition=screened-out",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
  });

  it("respects ?q= search param", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items?q=test",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /admin/source-items/:id", () => {
  it("returns 200 with item detail", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items/si_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Test Item");
    expect(res.body).toContain("A test summary");
  });

  it("returns 404 for unknown id", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items/si_unknown",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
  });

  it("displays screeningResultJson as formatted JSON", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items/si_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.body).toContain("retain");
  });

  it("displays metadataJson as formatted JSON", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items/si_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    // metadataJson is { key: "value" }
    expect(res.body).toContain("key");
  });
});

describe("GET /admin/opportunities", () => {
  it("returns 200 with HTML table", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/opportunities",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<table>");
    expect(res.body).toContain("Test Opportunity");
  });

  it("respects ?status= filter", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/opportunities?status=Rejected",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /admin/opportunities/:id", () => {
  it("returns 200 with opportunity detail", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/opportunities/opp_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Test Opportunity");
    expect(res.body).toContain("Test angle");
  });

  it("returns 404 for unknown id", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/opportunities/opp_unknown",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
  });

  it("displays evidence table", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/opportunities/opp_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.body).toContain("Evidence");
  });

  it("displays enrichment log", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/opportunities/opp_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.body).toContain("Enrichment Log");
  });
});

describe("GET /admin/reviews/claap", () => {
  it("returns 200 with Claap review items", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/reviews/claap",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});

describe("GET /admin/reviews/linear", () => {
  it("returns 200 with Linear review items", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/reviews/linear",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});

describe("GET /admin/runs", () => {
  it("returns 200 with runs table", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/runs",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("ingest:run");
  });

  it("respects ?runType= filter", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/runs?runType=ingest:run",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /admin/users", () => {
  it("returns 200 with users table", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Baptiste");
  });
});

describe("XSS prevention", () => {
  it("escapes HTML in source item titles", async () => {
    const xssPrisma = mockPrisma();
    xssPrisma.sourceItem.findMany = vi.fn(async () => [
      {
        id: "si_xss",
        source: "claap",
        title: '<script>alert("xss")</script>',
        occurredAt: new Date(),
        processedAt: null,
        notionPageId: null,
        screeningResultJson: null,
        metadataJson: {}
      }
    ]);
    const server = Fastify({ logger: false });
    registerAdminPlugin(server, xssPrisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.body).not.toContain('<script>alert("xss")</script>');
    expect(res.body).toContain("&lt;script&gt;");
  });
});

describe("escapeHtml", () => {
  it("escapes < > & \" '", () => {
    expect(escapeHtml('<b>"test" & \'it\'</b>')).toBe(
      "&lt;b&gt;&quot;test&quot; &amp; &#39;it&#39;&lt;/b&gt;"
    );
  });

  it("handles null/undefined gracefully", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("passes through safe strings unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

// ── Helpers for scope/company tests ──────────────────────────────────────────

function buildCompanyServer() {
  const customFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
    if (where.slug === "custom") return { id: "comp_2", slug: "custom", name: "Custom Co" };
    if (where.slug === "default") return { id: "comp_1", slug: "default", name: "Acme Corp" };
    return null;
  });
  return buildServer({}, { companyFindUnique: customFindUnique });
}

function buildCompanyServerWithPagination() {
  const customFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
    if (where.slug === "custom") return { id: "comp_2", slug: "custom", name: "Custom Co" };
    if (where.slug === "default") return { id: "comp_1", slug: "default", name: "Acme Corp" };
    return null;
  });
  const server = Fastify({ logger: false });
  const prisma = mockPrisma({ companyFindUnique: customFindUnique });
  // Make count return > 50 to trigger pagination
  prisma.sourceItem.count = vi.fn(async () => 120);
  registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);
  return server;
}

function extractHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const re = /href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    hrefs.push(m[1].replace(/&amp;/g, "&"));
  }
  return hrefs;
}

function extractNavHrefs(html: string): string[] {
  const navMatch = html.match(/<nav>([\s\S]*?)<\/nav>/);
  if (!navMatch) return [];
  return extractHrefs(navMatch[1]);
}

// ── Safeguard A: Scope/filter continuity ─────────────────────────────────────

describe("scope continuity", () => {
  it("A1: all nav links carry company=custom when non-default company is active", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const navHrefs = extractNavHrefs(res.body);
    expect(navHrefs.length).toBeGreaterThan(0);
    for (const href of navHrefs) {
      expect(href).toContain("company=custom");
    }
  });

  it("A2a: source-items row→detail links carry company=custom", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const hrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/source-items/si_"));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toContain("company=custom");
    }
  });

  it("A2b: opportunities row→detail links carry company=custom", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/opportunities?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const hrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/opportunities/opp_"));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toContain("company=custom");
    }
  });

  it("A3: pagination links carry company=custom", async () => {
    const server = buildCompanyServerWithPagination();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const paginationMatch = res.body.match(/<div class="pagination">([\s\S]*?)<\/div>/);
    expect(paginationMatch).not.toBeNull();
    const paginationHrefs = extractHrefs(paginationMatch![1]);
    expect(paginationHrefs.length).toBeGreaterThan(0);
    for (const href of paginationHrefs) {
      expect(href).toContain("company=custom");
    }
  });

  it("A4: filter form includes hidden company input", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<input type="hidden" name="company" value="custom">');
  });

  it("A5: dashboard disposition links carry company=custom", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const dispositionHrefs = extractHrefs(res.body).filter(
      (h) => h.includes("disposition=")
    );
    expect(dispositionHrefs.length).toBe(4);
    for (const href of dispositionHrefs) {
      expect(href).toContain("company=custom");
    }
  });

  it("A6: default company omits company param from all links", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const hrefs = extractHrefs(res.body);
    for (const href of hrefs) {
      expect(href).not.toContain("company=");
    }
  });

  it("A7: detail page nav links carry company=custom on cross-page drilldown", async () => {
    // Custom company must share id with mock source item (comp_1)
    const customFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
      if (where.slug === "custom") return { id: "comp_1", slug: "custom", name: "Custom Co" };
      if (where.slug === "default") return { id: "comp_1", slug: "default", name: "Acme Corp" };
      return null;
    });
    const server = buildServer({}, { companyFindUnique: customFindUnique });
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items/si_1?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const navHrefs = extractNavHrefs(res.body);
    expect(navHrefs.length).toBeGreaterThan(0);
    for (const href of navHrefs) {
      expect(href).toContain("company=custom");
    }
  });
});

// ── Filter context across drilldowns ─────────────────────────────────────────

describe("filter context drilldowns", () => {
  it("source-items row links include returnTo with current filters", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items?source=claap&company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const detailHrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/source-items/si_"));
    expect(detailHrefs.length).toBeGreaterThan(0);
    for (const href of detailHrefs) {
      expect(href).toContain("returnTo=");
      // The returnTo should encode the source=claap filter
      const returnTo = decodeURIComponent(href.split("returnTo=")[1]);
      expect(returnTo).toContain("source=claap");
      expect(returnTo).toContain("company=custom");
    }
  });

  it("opportunities row links include returnTo with current filters", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/opportunities?status=Rejected&company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const detailHrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/opportunities/opp_"));
    expect(detailHrefs.length).toBeGreaterThan(0);
    for (const href of detailHrefs) {
      expect(href).toContain("returnTo=");
      const returnTo = decodeURIComponent(href.split("returnTo=")[1]);
      expect(returnTo).toContain("status=Rejected");
    }
  });

  it("source-item detail renders back link when returnTo is present", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items/si_1?returnTo=/admin/source-items?source=claap",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Back to list");
    expect(res.body).toContain("/admin/source-items?source=claap");
  });

  it("source-item detail omits back link when returnTo is absent", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items/si_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("Back to list");
  });

  it("opportunity detail renders back link when returnTo is present", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/opportunities/opp_1?returnTo=/admin/opportunities?status=Rejected",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Back to list");
    expect(res.body).toContain("/admin/opportunities?status=Rejected");
  });

  it("review page row links include returnTo pointing back to review page", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/reviews/claap",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const detailHrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/source-items/si_"));
    expect(detailHrefs.length).toBeGreaterThan(0);
    for (const href of detailHrefs) {
      expect(href).toContain("returnTo=");
      const returnTo = decodeURIComponent(href.split("returnTo=")[1]);
      expect(returnTo).toContain("/admin/reviews/claap");
    }
  });

  it("returnTo is not leaked into pagination URLs", async () => {
    const server = buildCompanyServerWithPagination();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const paginationMatch = res.body.match(/<div class="pagination">([\s\S]*?)<\/div>/);
    expect(paginationMatch).not.toBeNull();
    const paginationHrefs = extractHrefs(paginationMatch![1]);
    for (const href of paginationHrefs) {
      expect(href).not.toContain("returnTo");
    }
  });

  it("rejects returnTo that does not start with /admin", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-items/si_1?returnTo=https://evil.com",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("Back to list");
    expect(res.body).not.toContain("evil.com");
  });

  it("source-item detail threads returnTo into opportunity cross-links", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    // Return a source item with evidence referencing an opportunity
    prisma.sourceItem.findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
      if (where.id === "si_1") {
        return {
          id: "si_1",
          companyId: "comp_1",
          source: "claap",
          title: "Test Item",
          summary: "A test summary",
          sourceUrl: "https://example.com",
          occurredAt: new Date("2026-01-01"),
          processedAt: null,
          metadataJson: {},
          rawPayloadJson: {},
          screeningResultJson: { decision: "retain" },
          evidenceReferences: [
            {
              opportunity: { id: "opp_1", title: "Related Opp" },
              primaryForOpportunities: [],
              opportunityLinks: [],
              excerpt: "some excerpt",
              speakerOrAuthor: "someone",
              freshnessScore: 0.8
            }
          ]
        };
      }
      return null;
    });
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const returnTo = "/admin/source-items?disposition=orphaned";
    const res = await server.inject({
      method: "GET",
      url: `/admin/source-items/si_1?returnTo=${encodeURIComponent(returnTo)}`,
      headers: { authorization: basicAuth("admin", "secret") }
    });

    expect(res.statusCode).toBe(200);
    // The opportunity cross-link should carry the returnTo
    const oppHrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/opportunities/opp_1"));
    expect(oppHrefs.length).toBeGreaterThan(0);
    for (const href of oppHrefs) {
      expect(href).toContain("returnTo=");
      const rt = decodeURIComponent(href.split("returnTo=")[1]);
      expect(rt).toContain("/admin/source-items");
      expect(rt).toContain("disposition=orphaned");
    }
  });

  it("opportunity detail renders back link from cross-page returnTo", async () => {
    const server = buildServer();
    const returnTo = "/admin/source-items?disposition=orphaned";
    const res = await server.inject({
      method: "GET",
      url: `/admin/opportunities/opp_1?returnTo=${encodeURIComponent(returnTo)}`,
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Back to list");
    expect(res.body).toContain("/admin/source-items?disposition=orphaned");
  });
});

// ── Safeguard B: Data-contract rendering ─────────────────────────────────────

describe("data-contract rendering", () => {
  it("B1+B2: Linear review renders flat metadata fields and rejects nested-object path", async () => {
    const linearMetadata = {
      linearEnrichmentClassification: "enrich-worthy",
      linearEnrichmentRationale: "Strong customer signal with shipped feature",
      linearCustomerVisibility: "shipped",
      linearSensitivityLevel: "safe",
      linearEvidenceStrength: 0.85,
      linearReviewNote: "Clear external-facing improvement"
    };

    const customFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
      if (where.slug === "default") return { id: "comp_1", slug: "default", name: "Acme Corp" };
      return null;
    });

    const server = Fastify({ logger: false });
    const prisma = mockPrisma({ companyFindUnique: customFindUnique });
    prisma.sourceItem.findMany = vi.fn(async () => [
      {
        id: "si_linear_1",
        source: "linear",
        title: "Linear Test Item",
        occurredAt: new Date("2026-01-01"),
        processedAt: new Date("2026-01-02"),
        metadataJson: linearMetadata
      }
    ]);
    prisma.sourceItem.count = vi.fn(async () => 1);
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/reviews/linear",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("enrich-worthy");
    expect(res.body).toContain("shipped");
    expect(res.body).toContain("safe");
    // B2: "unknown" must NOT appear — proves nested-object code path is dead
    expect(res.body).not.toContain("unknown");
  });

  it("B3: editorial-lead renders with purple badge, distinct from enrich-worthy and manual-review", async () => {
    const customFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
      if (where.slug === "default") return { id: "comp_1", slug: "default", name: "Acme Corp" };
      return null;
    });

    const server = Fastify({ logger: false });
    const prisma = mockPrisma({ companyFindUnique: customFindUnique });
    prisma.sourceItem.findMany = vi.fn(async () => [
      {
        id: "si_linear_lead",
        source: "linear",
        title: "HCR convention fully supported",
        occurredAt: new Date("2026-03-23"),
        processedAt: new Date("2026-03-23"),
        metadataJson: {
          linearEnrichmentClassification: "editorial-lead",
          linearCustomerVisibility: "shipped",
          linearSensitivityLevel: "safe",
          linearEvidenceStrength: 0.91
        }
      }
    ]);
    prisma.sourceItem.count = vi.fn(async () => 1);
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/reviews/linear",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("editorial-lead");
    expect(res.body).toContain("badge-purple");
    expect(res.body).toContain("shipped");
    // The classification badge in the table row must be purple, not orange
    expect(res.body).toContain('<span class="badge badge-purple">editorial-lead</span>');
  });
});

// ── Route tests: editorial configs ──────────────────────────────────────────

describe("GET /admin/editorial-configs", () => {
  it("returns 200 with HTML table", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<table>");
    expect(res.body).toContain("v1");
  });
});

describe("GET /admin/editorial-configs/:id", () => {
  it("returns 200 for known id", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs/ec_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Editorial Config v1");
  });

  it("returns 404 for unknown id", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs/ec_unknown",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /admin/users/:id", () => {
  it("returns 200 for known id", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/users/u_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Baptiste");
  });

  it("returns 404 for unknown id", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/users/u_unknown",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Scope continuity: expansion ─────────────────────────────────────────────

describe("scope continuity — expansion", () => {
  it("A8: editorial-configs list links carry company=custom", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const hrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/editorial-configs/ec_"));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toContain("company=custom");
    }
  });

  it("A9: users list row→detail links carry company=custom", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/users?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const hrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/users/u_"));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toContain("company=custom");
    }
  });
});

// ── Data-contract rendering: expansion ──────────────────────────────────────

describe("data-contract rendering — expansion", () => {
  it("editorial config detail contains doctrine markdown text (not JSON wrapper)", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs/ec_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Test doctrine");
    // Should not contain the JSON key wrapper
    expect(res.body).not.toContain('"doctrineMarkdown"');
  });

  it("editorial config detail renders content philosophy list items", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs/ec_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Specific");
    expect(res.body).toContain("Evidence-backed");
    expect(res.body).toContain("<li>");
  });

  it("user detail contains toneSummary text", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/users/u_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Warm and direct");
  });

  it("user detail renders typicalPhrases as list items", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/users/u_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Let me be clear");
    expect(res.body).toContain("Here is the thing");
    expect(res.body).toContain("<li>");
  });
});

// ── Empty-state rendering ───────────────────────────────────────────────────

describe("empty-state rendering", () => {
  it("editorial-configs with 0 rows shows No items found", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.editorialConfig.findMany = vi.fn(async () => []);
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No items found");
  });

  it("editorial-config detail with empty layer1 renders without crash", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.editorialConfig.findUnique = vi.fn(async () => ({
      id: "ec_empty",
      companyId: "comp_1",
      version: 1,
      layer1CompanyLens: {},
      layer2ContentPhilosophy: null,
      layer3LinkedInCraft: null,
      createdAt: new Date("2026-01-01")
    }));
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs/ec_empty",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("user detail with empty baseProfile renders without crash", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.user.findUnique = vi.fn(async () => ({
      id: "u_empty",
      companyId: "comp_1",
      displayName: "Empty User",
      type: "editor",
      language: "en",
      baseProfile: {},
      createdAt: new Date("2025-06-01"),
      updatedAt: new Date("2025-06-15"),
      _count: { ownedOpportunities: 0 }
    }));
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/users/u_empty",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("user detail with typicalPhrases: null renders empty list", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.user.findUnique = vi.fn(async () => ({
      id: "u_nullphrases",
      companyId: "comp_1",
      displayName: "Null Phrases User",
      type: "editor",
      language: "en",
      baseProfile: { toneSummary: "Calm", typicalPhrases: null },
      createdAt: new Date("2025-06-01"),
      updatedAt: new Date("2025-06-15"),
      _count: { ownedOpportunities: 0 }
    }));
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/users/u_nullphrases",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    // bulletList(null) should render the empty-state dash
    expect(res.body).toContain("Typical Phrases");
  });
});

// ── Shape-drift detection ───────────────────────────────────────────────────

describe("shape-drift detection", () => {
  it("editorial config detail with unknown key in layer1 shows collapsible viewer", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.editorialConfig.findUnique = vi.fn(async () => ({
      id: "ec_drift",
      companyId: "comp_1",
      version: 1,
      layer1CompanyLens: {
        doctrineMarkdown: "Test doctrine",
        sensitivityMarkdown: "Test sensitivity",
        unexpectedField: "surprise"
      },
      layer2ContentPhilosophy: { defaults: ["Be specific"] },
      layer3LinkedInCraft: { defaults: ["Max 250 words"] },
      createdAt: new Date("2026-01-01")
    }));
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs/ec_drift",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<details>");
    expect(res.body).toContain("Additional Layer 1 fields");
    expect(res.body).toContain("unexpectedField");
  });

  it("user detail with unknownField in baseProfile shows collapsible viewer", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.user.findUnique = vi.fn(async () => ({
      id: "u_drift",
      companyId: "comp_1",
      displayName: "Drift User",
      type: "editor",
      language: "en",
      baseProfile: {
        toneSummary: "Calm",
        unknownField: "extra data"
      },
      createdAt: new Date("2025-06-01"),
      updatedAt: new Date("2025-06-15"),
      _count: { ownedOpportunities: 1 }
    }));
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/users/u_drift",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<details>");
    expect(res.body).toContain("Additional profile fields");
    expect(res.body).toContain("unknownField");
  });
});

// ── Wrong-company guard ─────────────────────────────────────────────────────

describe("wrong-company guard", () => {
  it("GET /admin/editorial-configs/:id where config.companyId differs returns 404", async () => {
    const customFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
      if (where.slug === "other") return { id: "comp_other", slug: "other", name: "Other Co" };
      if (where.slug === "default") return { id: "comp_other", slug: "default", name: "Other Co" };
      return null;
    });
    const server = Fastify({ logger: false });
    const prisma = mockPrisma({ companyFindUnique: customFindUnique });
    // Config has companyId "comp_1" but resolved company is "comp_other"
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs/ec_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("not found");
  });

  it("GET /admin/users/:id where user.companyId differs returns 404", async () => {
    const customFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
      if (where.slug === "other") return { id: "comp_other", slug: "other", name: "Other Co" };
      if (where.slug === "default") return { id: "comp_other", slug: "default", name: "Other Co" };
      return null;
    });
    const server = Fastify({ logger: false });
    const prisma = mockPrisma({ companyFindUnique: customFindUnique });
    // User has companyId "comp_1" but resolved company is "comp_other"
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/users/u_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("not found");
  });
});

// ── Drilldown: returnTo ─────────────────────────────────────────────────────

describe("drilldown returnTo", () => {
  it("editorial config list→detail carries returnTo", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/editorial-configs",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const detailHrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/editorial-configs/ec_"));
    expect(detailHrefs.length).toBeGreaterThan(0);
    for (const href of detailHrefs) {
      expect(href).toContain("returnTo=");
    }
  });

  it("users list→detail carries returnTo", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const detailHrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/users/u_"));
    expect(detailHrefs.length).toBeGreaterThan(0);
    for (const href of detailHrefs) {
      expect(href).toContain("returnTo=");
    }
  });
});

// ── Route tests: source configs ─────────────────────────────────────────

describe("GET /admin/source-configs", () => {
  it("returns 200 with HTML table", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-configs",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<table>");
    expect(res.body).toContain("claap");
    expect(res.body).toContain("linear");
  });
});

// ── Route tests: market queries ─────────────────────────────────────────

describe("GET /admin/market-queries", () => {
  it("returns 200 with HTML table", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/market-queries",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<table>");
    expect(res.body).toContain("AI hiring trends");
  });

  it("respects ?enabled=yes filter", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/market-queries?enabled=yes",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});

// ── Scope continuity: Phase 2 ───────────────────────────────────────────

describe("scope continuity — phase 2", () => {
  it("A10: source-configs links carry company=custom", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/source-configs?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const navHrefs = extractNavHrefs(res.body);
    expect(navHrefs.length).toBeGreaterThan(0);
    for (const href of navHrefs) {
      expect(href).toContain("company=custom");
    }
  });

  it("A11: market-queries links carry company=custom", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/market-queries?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const navHrefs = extractNavHrefs(res.body);
    expect(navHrefs.length).toBeGreaterThan(0);
    for (const href of navHrefs) {
      expect(href).toContain("company=custom");
    }
  });
});

// ── Empty-state rendering: Phase 2 ──────────────────────────────────────

describe("empty-state rendering — phase 2", () => {
  it("source-configs with 0 rows shows No items found", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.sourceConfig.findMany = vi.fn(async () => []);
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/source-configs",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No items found");
  });

  it("market-queries with 0 rows shows No items found", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.marketQuery.findMany = vi.fn(async () => []);
    prisma.marketQuery.count = vi.fn(async () => 0);
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/market-queries",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No items found");
  });
});

// ── Filter passthrough: Phase 2 ─────────────────────────────────────────

describe("filter passthrough — phase 2", () => {
  it("market-queries filter form includes hidden company input", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/market-queries?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<input type="hidden" name="company" value="custom">');
  });
});

// ── Route tests: drafts ─────────────────────────────────────────────────────

describe("GET /admin/drafts", () => {
  it("returns 200 with HTML table", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<table>");
    expect(res.body).toContain("Test Draft");
  });
});

describe("GET /admin/drafts/:id", () => {
  it("returns 200 for known id", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts/d_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Test Draft");
  });

  it("returns 404 for unknown id", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts/d_unknown",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Route tests: run detail ─────────────────────────────────────────────────

describe("GET /admin/runs/:id", () => {
  it("returns 200 for known id", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/runs/run_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("ingest:run");
  });

  it("returns 404 for unknown id", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/runs/run_unknown",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Scope continuity: Phase 3 ───────────────────────────────────────────────

describe("scope continuity — phase 3", () => {
  it("A12: drafts list links carry company=custom", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const hrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/drafts/d_"));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toContain("company=custom");
    }
  });

  it("A13: runs list row→detail links carry company=custom", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/runs?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const hrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/runs/run_"));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toContain("company=custom");
    }
  });
});

// ── Data-contract rendering: Phase 3 ────────────────────────────────────────

describe("data-contract rendering — phase 3", () => {
  it("draft detail contains firstDraftText", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts/d_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Full draft text content here");
  });

  it("draft detail contains opportunity link", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts/d_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const oppHrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/opportunities/opp_1"));
    expect(oppHrefs.length).toBeGreaterThan(0);
  });

  it("run detail contains cost entry step and cost", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/runs/run_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("screening");
    expect(res.body).toContain("$0.0045");
  });
});

// ── Empty-state rendering: Phase 3 ──────────────────────────────────────────

describe("empty-state rendering — phase 3", () => {
  it("drafts with 0 rows shows No items found", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.draft.findMany = vi.fn(async () => []);
    prisma.draft.count = vi.fn(async () => 0);
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No items found");
  });

  it("run detail with 0 cost entries shows No cost entries", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.syncRun.findUnique = vi.fn(async () => ({
      id: "run_empty",
      companyId: "comp_1",
      runType: "ingest:run",
      source: "claap",
      status: "completed",
      startedAt: new Date("2026-01-01T10:00:00Z"),
      finishedAt: new Date("2026-01-01T10:05:00Z"),
      countersJson: {},
      warningsJson: null,
      llmStatsJson: null,
      tokenTotalsJson: null,
      notes: null,
      notionPageId: null,
      notionPageFingerprint: "fp",
      createdAt: new Date("2026-01-01"),
      costEntries: []
    }));
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/runs/run_empty",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No cost entries");
  });

  it("run detail shows warnings expanded when present", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.syncRun.findUnique = vi.fn(async () => ({
      id: "run_warn",
      companyId: "comp_1",
      runType: "opportunity:pull-notion-edits",
      source: null,
      status: "completed",
      startedAt: new Date("2026-01-01T10:00:00Z"),
      finishedAt: new Date("2026-01-01T10:05:00Z"),
      countersJson: {},
      warningsJson: ["Unresolved re-evaluation request: notionPageId=np-ghost fingerprint=fp-ghost — checkbox left checked, user edits unprotected until resolved"],
      llmStatsJson: null,
      tokenTotalsJson: null,
      notes: "Pull-edits processed 0, 1 unresolved (see warnings)",
      notionPageId: null,
      notionPageFingerprint: "fp",
      createdAt: new Date("2026-01-01"),
      costEntries: []
    }));
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/runs/run_warn",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    // Warning badge visible
    expect(res.body).toContain("1 warning");
    expect(res.body).toContain("badge-orange");
    // Warning text expanded (not behind collapsible)
    expect(res.body).toContain("np-ghost");
    expect(res.body).toContain("unprotected");
    // No collapsible wrapper
    expect(res.body).not.toContain("Show warnings");
  });

  it("run list shows no warning badge when warnings are empty", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/runs",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    // The default mock has no warningsJson, so no warning badge in table rows
    expect(res.body).not.toContain("warning</span>");
  });
});

// ── Shape-drift detection: Phase 3 ──────────────────────────────────────────

describe("shape-drift detection — phase 3", () => {
  it("draft detail with opportunity: null shows dash for opportunity", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    prisma.draft.findUnique = vi.fn(async () => ({
      id: "d_null_opp",
      companyId: "comp_1",
      proposedTitle: "Draft Without Opp",
      profileId: "baptiste",
      hook: "Hook text",
      summary: "Summary text",
      whatItIsAbout: "About",
      whatItIsNotAbout: "Not about",
      visualIdea: "Visual",
      firstDraftText: "Draft text",
      confidenceScore: 0.5,
      language: "en",
      createdAt: new Date("2026-01-01"),
      opportunity: null,
      evidence: []
    }));
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts/d_null_opp",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Opportunity: —");
  });
});

// ── Wrong-company guard: Phase 3 ────────────────────────────────────────────

describe("wrong-company guard — phase 3", () => {
  it("GET /admin/drafts/:id where draft.companyId differs returns 404", async () => {
    const customFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
      if (where.slug === "other") return { id: "comp_other", slug: "other", name: "Other Co" };
      if (where.slug === "default") return { id: "comp_other", slug: "default", name: "Other Co" };
      return null;
    });
    const server = Fastify({ logger: false });
    const prisma = mockPrisma({ companyFindUnique: customFindUnique });
    // Draft has companyId "comp_1" but resolved company is "comp_other"
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts/d_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("not found");
  });

  it("GET /admin/runs/:id where run.companyId differs returns 404", async () => {
    const customFindUnique = vi.fn(async ({ where }: { where: { slug?: string } }) => {
      if (where.slug === "other") return { id: "comp_other", slug: "other", name: "Other Co" };
      if (where.slug === "default") return { id: "comp_other", slug: "default", name: "Other Co" };
      return null;
    });
    const server = Fastify({ logger: false });
    const prisma = mockPrisma({ companyFindUnique: customFindUnique });
    // Run has companyId "comp_1" but resolved company is "comp_other"
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/runs/run_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("not found");
  });
});

// ── Drilldown returnTo: Phase 3 ─────────────────────────────────────────────

describe("drilldown returnTo — phase 3", () => {
  it("draft list→detail carries returnTo", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const detailHrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/drafts/d_"));
    expect(detailHrefs.length).toBeGreaterThan(0);
    for (const href of detailHrefs) {
      expect(href).toContain("returnTo=");
    }
  });

  it("draft detail links to parent opportunity", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts/d_1",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const oppHrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/opportunities/opp_1"));
    expect(oppHrefs.length).toBeGreaterThan(0);
  });

  it("run list→detail carries returnTo", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/runs",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    const detailHrefs = extractHrefs(res.body).filter((h) => h.includes("/admin/runs/run_"));
    expect(detailHrefs.length).toBeGreaterThan(0);
    for (const href of detailHrefs) {
      expect(href).toContain("returnTo=");
    }
  });
});

// ── Drafts filter HTML contract ───────────────────────────────────────────

describe("drafts filter HTML contract", () => {
  it("drafts filter form includes hidden company input when company=custom", async () => {
    const server = buildCompanyServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts?company=custom",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<input type="hidden" name="company" value="custom">');
  });

  it("drafts filter renders dynamic profileId options from query", async () => {
    // The default mockPrisma draft.findMany returns [{profileId:"baptiste",...}]
    // which listDraftProfileIds uses (via findMany with distinct) to populate options
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    // The select should contain an option with value="baptiste"
    expect(res.body).toContain('<option value="baptiste">baptiste</option>');
    // The "All profiles" placeholder should be present
    expect(res.body).toContain("All profiles");
  });

  it("drafts filter renders multiple dynamic profileId options", async () => {
    const server = Fastify({ logger: false });
    const prisma = mockPrisma();
    // Override findMany to return two distinct profiles
    prisma.draft.findMany = vi.fn(async () => [
      {
        id: "d_1",
        proposedTitle: "Draft 1",
        profileId: "baptiste",
        confidenceScore: 0.85,
        language: "fr",
        createdAt: new Date("2026-01-01"),
        opportunity: { id: "opp_1", title: "Opp 1" }
      },
      {
        id: "d_2",
        proposedTitle: "Draft 2",
        profileId: "linc-corporate",
        confidenceScore: 0.70,
        language: "en",
        createdAt: new Date("2026-01-02"),
        opportunity: { id: "opp_1", title: "Opp 1" }
      }
    ]);
    registerAdminPlugin(server, prisma, DEFAULT_OPTIONS);

    const res = await server.inject({
      method: "GET",
      url: "/admin/drafts",
      headers: { authorization: basicAuth("admin", "secret") }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<option value="baptiste">baptiste</option>');
    expect(res.body).toContain('<option value="linc-corporate">linc-corporate</option>');
  });
});
