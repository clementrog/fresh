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

describe("anti-regression: signal-era commands are removed (Phase 9)", () => {
  it("sync:daily is no longer a valid RunType", async () => {
    const { EditorialSignalEngineApp } = await import("../src/app.js");
    const app = new EditorialSignalEngineApp(
      { DATABASE_URL: "fake" } as any,
      { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      {
        repositories: {
          getCompanyBySlug: vi.fn(async () => null)
        } as any,
      }
    );
    await expect(app.run("sync:daily" as any)).rejects.toThrow("Unsupported command");
  });

  it("digest:send is no longer a valid RunType", async () => {
    const { EditorialSignalEngineApp } = await import("../src/app.js");
    const app = new EditorialSignalEngineApp(
      { DATABASE_URL: "fake" } as any,
      { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      {
        repositories: {
          getCompanyBySlug: vi.fn(async () => null)
        } as any,
      }
    );
    await expect(app.run("digest:send" as any)).rejects.toThrow("Unsupported command");
  });

  it("profile:weekly-recompute is no longer a valid RunType", async () => {
    const { EditorialSignalEngineApp } = await import("../src/app.js");
    const app = new EditorialSignalEngineApp(
      { DATABASE_URL: "fake" } as any,
      { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      {
        repositories: {
          getCompanyBySlug: vi.fn(async () => null)
        } as any,
      }
    );
    await expect(app.run("profile:weekly-recompute" as any)).rejects.toThrow("Unsupported command");
  });
});

describe("anti-regression: draft creation only through explicit trigger", () => {
  it("generateDraft is called only in explicit draft trigger methods", async () => {
    const fs = await import("fs");
    const appSource = fs.readFileSync(new URL("../src/app.ts", import.meta.url), "utf-8");

    const lines = appSource.split("\n");

    // generateDraft( calls (excluding import line and method name references)
    const generateDraftCallLines = lines.filter((line) =>
      line.includes("generateDraft(") &&
      !line.includes("import") &&
      !line.includes("generateDraftOnDemand") &&
      !line.includes("generateDraftsForReady")
    );
    expect(generateDraftCallLines.length).toBe(2);

    // persistDraftGraph calls (excluding import line)
    const persistLines = lines.filter((line) =>
      line.includes("persistDraftGraph") &&
      !line.includes("import")
    );
    expect(persistLines.length).toBe(2);
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
