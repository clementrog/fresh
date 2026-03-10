import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MarketFindingsConnector } from "../src/connectors/market-findings.js";

let tempDir = "";

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("market findings connector", () => {
  it("skips unchanged files when cursor is reused", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "market-findings-"));
    const filePath = path.join(tempDir, "finding.md");
    await fs.writeFile(
      filePath,
      `---
id: finding-1
finding: Proof matters
updatedAt: 2026-03-10T09:00:00.000Z
---
Proof matters more than promises.
`
    );

    const connector = new MarketFindingsConnector();
    const config = {
      source: "market-findings" as const,
      enabled: true,
      storeRawText: true,
      retentionDays: 30,
      rateLimit: {
        requestsPerMinute: 5,
        maxRetries: 1,
        initialDelayMs: 10
      },
      directory: tempDir
    };

    const first = await connector.fetchSince(null, config, {
      dryRun: false,
      now: new Date("2026-03-10T10:00:00.000Z")
    });
    expect(first).toHaveLength(1);

    const second = await connector.fetchSince(first[0]!.cursor, config, {
      dryRun: false,
      now: new Date("2026-03-10T10:00:00.000Z")
    });
    expect(second).toHaveLength(0);
  });
});
