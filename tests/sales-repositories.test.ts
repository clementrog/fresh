import { describe, expect, it } from "vitest";
import {
  salesDealDbId,
  salesContactDbId,
  salesHubspotCompanyDbId,
  salesActivityDbId,
  salesSignalDbId,
  salesExtractedFactDbId,
  salesRecommendationDbId,
  salesDoctrineDbId
} from "../src/sales/db/sales-repositories.js";

describe("sales deterministic ID helpers", () => {
  it("salesDealDbId is deterministic", () => {
    const a = salesDealDbId("c1", "hs-deal-1");
    const b = salesDealDbId("c1", "hs-deal-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^sd_/);
  });

  it("salesDealDbId differs for different inputs", () => {
    const a = salesDealDbId("c1", "hs-deal-1");
    const b = salesDealDbId("c1", "hs-deal-2");
    expect(a).not.toBe(b);
  });

  it("salesContactDbId is deterministic", () => {
    const a = salesContactDbId("c1", "hs-contact-1");
    const b = salesContactDbId("c1", "hs-contact-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^sc_/);
  });

  it("salesHubspotCompanyDbId is deterministic", () => {
    const a = salesHubspotCompanyDbId("c1", "hs-co-1");
    const b = salesHubspotCompanyDbId("c1", "hs-co-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^shc_/);
  });

  it("salesActivityDbId is deterministic", () => {
    const a = salesActivityDbId("c1", "hs-eng-1");
    const b = salesActivityDbId("c1", "hs-eng-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^sa_/);
  });

  it("salesSignalDbId is deterministic", () => {
    const a = salesSignalDbId("c1", ["feature_shipped", "sso", "2026-w12"]);
    const b = salesSignalDbId("c1", ["feature_shipped", "sso", "2026-w12"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^ss_/);
  });

  it("salesExtractedFactDbId is deterministic", () => {
    const a = salesExtractedFactDbId("c1", ["act-1", "objection_mentioned", "abc123"]);
    const b = salesExtractedFactDbId("c1", ["act-1", "objection_mentioned", "abc123"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^sef_/);
  });

  it("salesRecommendationDbId is deterministic", () => {
    const a = salesRecommendationDbId("c1", "deal-1", "signal-1");
    const b = salesRecommendationDbId("c1", "deal-1", "signal-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^sr_/);
  });

  it("salesDoctrineDbId is deterministic", () => {
    const a = salesDoctrineDbId("c1", 1);
    const b = salesDoctrineDbId("c1", 1);
    expect(a).toBe(b);
    expect(a).toMatch(/^sdoc_/);
  });
});
