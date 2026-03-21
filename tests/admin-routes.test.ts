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
    draft: { count: vi.fn(async () => 5) },
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
      ])
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
      ])
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
});
