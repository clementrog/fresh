import { describe, expect, it } from "vitest";

import { computeRawTextExpiry } from "../src/services/retention.js";

describe("retention", () => {
  it("disables raw text retention when source storage is disabled", () => {
    const result = computeRawTextExpiry(
      {
        source: "notion",
        enabled: true,
        storeRawText: false,
        retentionDays: 30,
        rateLimit: {
          requestsPerMinute: 10,
          maxRetries: 1,
          initialDelayMs: 1000
        },
        pageAllowlist: [],
        databaseAllowlist: [],
        excludedDatabaseNames: []
      },
      new Date("2026-03-10T00:00:00.000Z")
    );

    expect(result).toBeNull();
  });
});
