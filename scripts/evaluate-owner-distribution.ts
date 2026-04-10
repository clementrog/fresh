/**
 * Owner-distribution evaluation — measures how the opportunity routing
 * actually distributes across owners, source families, and narrative pillars.
 *
 * This script replaces the one-off `_tmp-profile-source-crosstab.ts` used
 * for the owner-imbalance investigation. It is safe to re-run on demand and
 * emits both a human-readable markdown report and a machine-readable JSON
 * snapshot to `tmp/owner-distribution-<date>.{md,json}`.
 *
 * What it measures:
 *  1. Owner × source-family cross-tab
 *  2. notion-alone share per owner
 *  3. first-party-linked share per owner
 *  4. Normalized narrative pillar counts (collapsing accent drift)
 *  5. Shadow routing re-run — replays the deterministic routing gate
 *     against stored screeningResultJson and reports what WOULD change
 *     if a sync ran today (no writes).
 *
 * Usage:
 *   pnpm exec tsx scripts/evaluate-owner-distribution.ts                # full report
 *   pnpm exec tsx scripts/evaluate-owner-distribution.ts --shadow-only  # just re-routing
 */
import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeNarrativePillar } from "../src/lib/text.js";
import { getSourceFamily, type SourceFamily } from "../src/domain/source-family.js";
import {
  adjustOwnerRouting,
  findFirstPartyCorroboration,
  FIRST_PARTY_REQUIRED_OWNERS
} from "../src/services/routing.js";
import type { NormalizedSourceItem, ScreeningResult } from "../src/domain/types.js";

const prisma = new PrismaClient();

const args = new Set(process.argv.slice(2));
const shadowOnly = args.has("--shadow-only");

interface OpportunityRow {
  id: string;
  title: string;
  ownerProfile: string | null;
  narrativePillar: string | null;
  createdAt: Date;
  primarySource: string | null;
  primarySourceKind: SourceFamily | null;
  primarySourceItemExternalId: string | null;
  primaryNotionKind: string | null;
  primarySourceMetadata: Record<string, unknown>;
  allSources: string[];
  allSourceFamilies: SourceFamily[];
  notionAlone: boolean;
  hasFirstPartyEvidence: boolean;
}

function coerceSourceFamilyFromRow(row: {
  source: string;
  metadata: Record<string, unknown>;
}): SourceFamily {
  // Use getSourceFamily via a lightweight NormalizedSourceItem reconstruction.
  const fake: NormalizedSourceItem = {
    source: row.source as NormalizedSourceItem["source"],
    sourceItemId: "",
    externalId: "",
    sourceFingerprint: "",
    sourceUrl: "",
    title: "",
    text: "",
    summary: "",
    occurredAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    metadata: row.metadata,
    rawPayload: {}
  };
  return getSourceFamily(fake);
}

async function loadOpportunities(): Promise<OpportunityRow[]> {
  const opps = await prisma.opportunity.findMany({
    select: {
      id: true,
      title: true,
      ownerProfile: true,
      narrativePillar: true,
      createdAt: true,
      primaryEvidence: {
        select: {
          source: true,
          sourceItem: {
            select: {
              source: true,
              externalId: true,
              metadataJson: true
            }
          }
        }
      },
      evidence: {
        select: {
          source: true,
          sourceItem: {
            select: { source: true, metadataJson: true }
          }
        }
      },
      linkedEvidence: {
        select: {
          evidence: {
            select: {
              source: true,
              sourceItem: {
                select: { source: true, metadataJson: true }
              }
            }
          }
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });

  const rows: OpportunityRow[] = [];
  for (const opp of opps) {
    const primary = opp.primaryEvidence?.sourceItem ?? null;
    const primaryMetadata =
      primary?.metadataJson && typeof primary.metadataJson === "object"
        ? (primary.metadataJson as Record<string, unknown>)
        : {};
    const primarySourceKind = primary
      ? coerceSourceFamilyFromRow({ source: primary.source, metadata: primaryMetadata })
      : null;

    // Collect all evidence sources + their families
    const allSources: string[] = [];
    const allSourceFamilies = new Set<SourceFamily>();
    const pushEvidence = (row: {
      source: string;
      sourceItem: { source: string; metadataJson: unknown } | null;
    }) => {
      if (!row.sourceItem) return;
      allSources.push(row.sourceItem.source);
      const meta =
        row.sourceItem.metadataJson && typeof row.sourceItem.metadataJson === "object"
          ? (row.sourceItem.metadataJson as Record<string, unknown>)
          : {};
      allSourceFamilies.add(
        coerceSourceFamilyFromRow({ source: row.sourceItem.source, metadata: meta })
      );
    };
    for (const e of opp.evidence) pushEvidence(e);
    for (const link of opp.linkedEvidence) {
      if (link.evidence) pushEvidence(link.evidence);
    }

    const dedupedSources = Array.from(new Set(allSources));
    const familiesList = Array.from(allSourceFamilies);
    const notionAlone =
      dedupedSources.length === 1 && dedupedSources[0] === "notion";
    const hasFirstPartyEvidence =
      familiesList.includes("first-party-work") ||
      familiesList.includes("field-proof");

    rows.push({
      id: opp.id,
      title: opp.title,
      ownerProfile: opp.ownerProfile,
      narrativePillar: opp.narrativePillar,
      createdAt: opp.createdAt,
      primarySource: primary?.source ?? null,
      primarySourceKind,
      primarySourceItemExternalId: primary?.externalId ?? null,
      primaryNotionKind:
        typeof primaryMetadata?.notionKind === "string"
          ? (primaryMetadata.notionKind as string)
          : null,
      primarySourceMetadata: primaryMetadata,
      allSources: dedupedSources,
      allSourceFamilies: familiesList,
      notionAlone,
      hasFirstPartyEvidence
    });
  }
  return rows;
}

function formatCrossTab(rows: OpportunityRow[]): {
  markdown: string;
  json: Record<string, Record<string, number>>;
} {
  const families: SourceFamily[] = [
    "first-party-work",
    "field-proof",
    "synthesized-market",
    "other"
  ];
  const owners = new Set<string>();
  const matrix: Record<string, Record<SourceFamily | "TOTAL", number>> = {};
  for (const row of rows) {
    const owner = row.ownerProfile ?? "(null)";
    owners.add(owner);
    if (!matrix[owner])
      matrix[owner] = {
        "first-party-work": 0,
        "field-proof": 0,
        "synthesized-market": 0,
        other: 0,
        TOTAL: 0
      };
    const fam = row.primarySourceKind ?? "other";
    matrix[owner][fam]++;
    matrix[owner].TOTAL++;
  }
  const sortedOwners = [...owners].sort((a, b) => (matrix[b]?.TOTAL ?? 0) - (matrix[a]?.TOTAL ?? 0));

  const header = `| Owner | ${families.join(" | ")} | TOTAL |`;
  const divider = `| --- | ${families.map(() => "---").join(" | ")} | --- |`;
  const lines = [header, divider];
  for (const owner of sortedOwners) {
    const cells = families.map((f) => String(matrix[owner][f]));
    lines.push(`| ${owner} | ${cells.join(" | ")} | ${matrix[owner].TOTAL} |`);
  }

  // JSON-friendly version
  const jsonView: Record<string, Record<string, number>> = {};
  for (const owner of sortedOwners) {
    jsonView[owner] = { ...matrix[owner] };
  }
  return { markdown: lines.join("\n"), json: jsonView };
}

function computeNotionAloneShare(rows: OpportunityRow[]): {
  markdown: string;
  json: Record<string, { total: number; notionAlone: number; share: number }>;
} {
  const byOwner = new Map<string, { total: number; notionAlone: number }>();
  for (const row of rows) {
    const owner = row.ownerProfile ?? "(null)";
    if (!byOwner.has(owner)) byOwner.set(owner, { total: 0, notionAlone: 0 });
    const stats = byOwner.get(owner)!;
    stats.total++;
    if (row.notionAlone) stats.notionAlone++;
  }
  const sorted = [...byOwner.entries()].sort((a, b) => b[1].total - a[1].total);
  const lines = ["| Owner | Total | Notion-alone | Share |", "| --- | --- | --- | --- |"];
  const json: Record<string, { total: number; notionAlone: number; share: number }> = {};
  for (const [owner, stats] of sorted) {
    const share = stats.total === 0 ? 0 : stats.notionAlone / stats.total;
    lines.push(
      `| ${owner} | ${stats.total} | ${stats.notionAlone} | ${(share * 100).toFixed(0)}% |`
    );
    json[owner] = { total: stats.total, notionAlone: stats.notionAlone, share };
  }
  return { markdown: lines.join("\n"), json };
}

function computeFirstPartyLinkedShare(rows: OpportunityRow[]): {
  markdown: string;
  json: Record<string, { total: number; firstPartyLinked: number; share: number }>;
} {
  const byOwner = new Map<string, { total: number; firstPartyLinked: number }>();
  for (const row of rows) {
    const owner = row.ownerProfile ?? "(null)";
    if (!byOwner.has(owner)) byOwner.set(owner, { total: 0, firstPartyLinked: 0 });
    const stats = byOwner.get(owner)!;
    stats.total++;
    if (row.hasFirstPartyEvidence) stats.firstPartyLinked++;
  }
  const sorted = [...byOwner.entries()].sort((a, b) => b[1].total - a[1].total);
  const lines = [
    "| Owner | Total | First-party-linked | Share |",
    "| --- | --- | --- | --- |"
  ];
  const json: Record<string, { total: number; firstPartyLinked: number; share: number }> = {};
  for (const [owner, stats] of sorted) {
    const share = stats.total === 0 ? 0 : stats.firstPartyLinked / stats.total;
    lines.push(
      `| ${owner} | ${stats.total} | ${stats.firstPartyLinked} | ${(share * 100).toFixed(0)}% |`
    );
    json[owner] = { total: stats.total, firstPartyLinked: stats.firstPartyLinked, share };
  }
  return { markdown: lines.join("\n"), json };
}

function computeNormalizedPillarCounts(rows: OpportunityRow[]): {
  markdown: string;
  json: Array<{ canonical: string; raw: string[]; count: number; owners: Record<string, number> }>;
} {
  const canonical = new Map<
    string,
    { raw: Set<string>; count: number; owners: Record<string, number> }
  >();
  for (const row of rows) {
    const normalized = normalizeNarrativePillar(row.narrativePillar);
    const key = normalized ?? "(none)";
    if (!canonical.has(key))
      canonical.set(key, { raw: new Set(), count: 0, owners: {} });
    const entry = canonical.get(key)!;
    if (row.narrativePillar) entry.raw.add(row.narrativePillar);
    entry.count++;
    const owner = row.ownerProfile ?? "(null)";
    entry.owners[owner] = (entry.owners[owner] ?? 0) + 1;
  }
  const sorted = [...canonical.entries()].sort((a, b) => b[1].count - a[1].count);
  const lines = [
    "| Canonical pillar | Count | Owner breakdown | Raw variants |",
    "| --- | --- | --- | --- |"
  ];
  const json: Array<{
    canonical: string;
    raw: string[];
    count: number;
    owners: Record<string, number>;
  }> = [];
  for (const [key, entry] of sorted) {
    const ownerStr = Object.entries(entry.owners)
      .sort((a, b) => b[1] - a[1])
      .map(([o, n]) => `${o}:${n}`)
      .join(", ");
    const rawVariants = [...entry.raw].slice(0, 3).join(" / ");
    lines.push(`| ${key} | ${entry.count} | ${ownerStr} | ${rawVariants || "—"} |`);
    json.push({
      canonical: key,
      count: entry.count,
      owners: entry.owners,
      raw: [...entry.raw]
    });
  }
  return { markdown: lines.join("\n"), json };
}

interface ShadowReroutingResult {
  changed: Array<{
    opportunityId: string;
    title: string;
    originalOwner: string | null;
    llmOwnerSuggestion: string | null;
    wouldRouteTo: string | undefined;
    outcome: string;
    reason: string;
  }>;
  kept: number;
  total: number;
}

async function shadowRerouting(): Promise<ShadowReroutingResult> {
  // Load recent source items with screeningResultJson populated — used as the
  // pool of "what the pipeline saw" for each retained decision.
  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const items = await prisma.sourceItem.findMany({
    where: {
      occurredAt: { gte: cutoff },
      screeningResultJson: { not: Prisma.DbNull } as never
    },
    select: {
      id: true,
      externalId: true,
      source: true,
      title: true,
      summary: true,
      text: true,
      metadataJson: true,
      occurredAt: true,
      ingestedAt: true,
      screeningResultJson: true
    }
  });

  if (items.length === 0) {
    return { changed: [], kept: 0, total: 0 };
  }

  // Build NormalizedSourceItem + ScreeningResult pairs
  const normalized: Array<{
    item: NormalizedSourceItem;
    screening: ScreeningResult;
    dbId: string;
  }> = [];
  for (const it of items) {
    const metadata =
      it.metadataJson && typeof it.metadataJson === "object"
        ? (it.metadataJson as Record<string, unknown>)
        : {};
    const srRaw = it.screeningResultJson as Record<string, unknown> | null;
    if (!srRaw || srRaw.decision !== "retain") continue;
    const screening: ScreeningResult = {
      decision: srRaw.decision as "retain",
      rationale: String(srRaw.rationale ?? ""),
      ownerSuggestion: typeof srRaw.ownerSuggestion === "string" ? srRaw.ownerSuggestion : undefined,
      llmOwnerSuggestion:
        typeof srRaw.llmOwnerSuggestion === "string"
          ? (srRaw.llmOwnerSuggestion as string)
          : typeof srRaw.ownerSuggestion === "string"
            ? (srRaw.ownerSuggestion as string)
            : undefined,
      createOrEnrich: (srRaw.createOrEnrich as ScreeningResult["createOrEnrich"]) ?? "unknown",
      relevanceScore: Number(srRaw.relevanceScore ?? 0),
      sensitivityFlag: Boolean(srRaw.sensitivityFlag),
      sensitivityCategories: Array.isArray(srRaw.sensitivityCategories)
        ? (srRaw.sensitivityCategories as string[])
        : [],
      hasStructuralSignificance: Boolean(srRaw.hasStructuralSignificance) || undefined,
      needsFirstPartyCorroboration: Boolean(srRaw.needsFirstPartyCorroboration) || undefined,
      literalReading: typeof srRaw.literalReading === "string" ? srRaw.literalReading : undefined,
      structuralReading:
        typeof srRaw.structuralReading === "string" ? srRaw.structuralReading : undefined
    };
    const item: NormalizedSourceItem = {
      source: it.source as NormalizedSourceItem["source"],
      sourceItemId: it.id,
      externalId: it.externalId,
      sourceFingerprint: "",
      sourceUrl: "",
      title: it.title,
      summary: it.summary,
      text: it.text,
      occurredAt: it.occurredAt.toISOString(),
      ingestedAt: it.ingestedAt.toISOString(),
      metadata,
      rawPayload: {}
    };
    normalized.push({ item, screening, dbId: it.id });
  }

  const candidatePool = normalized.map((n) => n.item);

  // Map source item externalId → opportunity (for reporting)
  const opps = await prisma.opportunity.findMany({
    select: {
      id: true,
      title: true,
      ownerProfile: true,
      evidence: {
        select: { sourceItem: { select: { externalId: true } } }
      }
    }
  });
  const oppByExternalId = new Map<string, { id: string; title: string; ownerProfile: string | null }>();
  for (const opp of opps) {
    for (const e of opp.evidence) {
      if (e.sourceItem) oppByExternalId.set(e.sourceItem.externalId, opp);
    }
  }

  const changed: ShadowReroutingResult["changed"] = [];
  let kept = 0;
  for (const { item, screening } of normalized) {
    const corroborating = findFirstPartyCorroboration({
      item,
      candidateItems: candidatePool
    });
    const adjustment = adjustOwnerRouting({
      item,
      screening,
      corroboratingItems: corroborating
    });
    if (adjustment.outcome === "kept") {
      kept++;
      continue;
    }
    const opp = oppByExternalId.get(item.externalId);
    changed.push({
      opportunityId: opp?.id ?? "(unknown)",
      title: opp?.title ?? item.title,
      originalOwner: opp?.ownerProfile ?? null,
      llmOwnerSuggestion: screening.llmOwnerSuggestion ?? null,
      wouldRouteTo: adjustment.finalOwnerSuggestion,
      outcome: adjustment.outcome,
      reason: adjustment.reason
    });
  }

  return { changed, kept, total: normalized.length };
}

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(import.meta.dirname, "..", "tmp");
  mkdirSync(outDir, { recursive: true });

  const sections: string[] = [];
  sections.push(`# Owner-distribution evaluation — ${date}`);
  sections.push("");
  sections.push(
    "Measures how opportunity routing distributes across owners, source families, and narrative pillars. Replaces the one-off `_tmp-profile-source-crosstab.ts`."
  );
  sections.push("");

  const rows = shadowOnly ? [] : await loadOpportunities();
  const json: Record<string, unknown> = { generatedAt: new Date().toISOString(), date };

  if (!shadowOnly) {
    sections.push(`## 1. Owner × source family (primary evidence)`);
    sections.push("");
    sections.push(`Total opportunities: **${rows.length}**`);
    sections.push("");
    const crossTab = formatCrossTab(rows);
    sections.push(crossTab.markdown);
    sections.push("");
    json.ownerBySourceFamily = crossTab.json;

    sections.push(`## 2. Notion-alone share per owner`);
    sections.push("");
    sections.push(
      "Opportunities whose total evidence list contains ONLY `notion` source items. High shares here mean the owner is over-reliant on synthesized market notes."
    );
    sections.push("");
    const notionShare = computeNotionAloneShare(rows);
    sections.push(notionShare.markdown);
    sections.push("");
    json.notionAloneShare = notionShare.json;

    sections.push(`## 3. First-party-linked share per owner`);
    sections.push("");
    sections.push(
      "Opportunities with at least one `first-party-work` or `field-proof` evidence reference. This is the signal that the routing gate would honor for founder/product/corporate voices."
    );
    sections.push("");
    const firstParty = computeFirstPartyLinkedShare(rows);
    sections.push(firstParty.markdown);
    sections.push("");
    json.firstPartyLinkedShare = firstParty.json;

    sections.push(`## 4. Normalized narrative pillars`);
    sections.push("");
    sections.push(
      "Canonical form collapses accent drift and separator inconsistency. The `raw variants` column shows the original strings that now share one key."
    );
    sections.push("");
    const pillars = computeNormalizedPillarCounts(rows);
    sections.push(pillars.markdown);
    sections.push("");
    json.normalizedPillars = pillars.json;
  }

  sections.push(`## 5. Shadow routing re-run`);
  sections.push("");
  sections.push(
    "Replays the deterministic routing gate against the stored `screeningResultJson` for retained items from the last 45 days. This shows which items WOULD change owner if a sync ran today — no writes are performed."
  );
  sections.push("");
  const shadow = await shadowRerouting();
  if (shadow.total === 0) {
    sections.push(
      "No retained screening results found in the last 45 days — the shadow run cannot report on pre-gate baselines until the new pipeline has run against production data."
    );
  } else {
    sections.push(
      `- Retained source items inspected: **${shadow.total}**`
    );
    sections.push(`- Unchanged by the gate: **${shadow.kept}**`);
    sections.push(`- Would change: **${shadow.changed.length}**`);
    sections.push("");
    if (shadow.changed.length > 0) {
      sections.push("| # | Opportunity | LLM owner | Gate → | Outcome | Reason |");
      sections.push("| --- | --- | --- | --- | --- | --- |");
      shadow.changed.slice(0, 60).forEach((c, i) => {
        const shortTitle =
          c.title.length > 60 ? c.title.slice(0, 57) + "…" : c.title;
        sections.push(
          `| ${i + 1} | ${shortTitle} | ${c.llmOwnerSuggestion ?? "(unset)"} | ${c.wouldRouteTo ?? "(cleared)"} | ${c.outcome} | ${c.reason.slice(0, 80)} |`
        );
      });
      if (shadow.changed.length > 60) {
        sections.push(`| … | (${shadow.changed.length - 60} more in JSON) | | | | |`);
      }
    }
  }
  sections.push("");
  json.shadowRerouting = shadow;

  // Acceptance notes
  sections.push(`## Acceptance signals`);
  sections.push("");
  sections.push(
    `- First-party-required owners (${[...FIRST_PARTY_REQUIRED_OWNERS].join(", ")}) should see notion-alone share trending DOWN over successive runs as the routing gate filters synthesized-market-only signals away from them.`
  );
  sections.push(
    "- Thomas should keep (or gain) share of concrete payroll/compliance consequence items that carry first-party evidence."
  );
  sections.push(
    "- Baptiste should rise on items where `hasStructuralSignificance=true` AND first-party corroboration exists."
  );

  const mdPath = join(outDir, `owner-distribution-${date}.md`);
  const jsonPath = join(outDir, `owner-distribution-${date}.json`);
  writeFileSync(mdPath, sections.join("\n"));
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
}

main().finally(() => prisma.$disconnect());
