# Convergence Plan — Ruthless Feedback

## Purpose

This document challenges `/docs/convergence_plan.md` against the vision in `/docs/vision_doc.md` and the actual codebase state.
Every issue listed is concrete, references specific files or code, and explains the gap.
The convergence plan must be revised to address every item before it becomes a roadmap.

---

## CRITICAL: Structural gaps the plan ignores entirely

### 1. Multi-tenancy is absent from the plan

The vision mandates multi-tenancy from V1:
- Section 13.1: `companies` table
- Every table carries `companyId`
- `editorial_config` versioned per company

The current codebase is **fully single-tenant**:
- No `companies` table in `prisma/schema.prisma`
- No `companyId` on any model
- Profiles are global constants in `src/domain/types.ts` line 1-7: `PROFILE_IDS = ["baptiste", "thomas", "virginie", "quentin", "linc-corporate"]`
- Territory rules in `src/services/territory.ts` hardcode company-specific profile-to-keyword mappings

The convergence plan never mentions multi-tenancy.

**Required action**: Add `companies` table. Add `companyId` FK to `source_configs`, `raw_source_items`, `content_opportunities`, `evidences`, `draft_v1s`, `editorial_config`, `market_queries`, `sync_runs`, `users`. Scope all queries by companyId. This affects every repository method in `src/db/repositories.ts` (30+ methods).

### 2. Signal elimination is understated — the pipeline must be restructured

The plan says "demote Signal" and "stop centering on signals". This is too soft.

The vision has **no Signal concept at all**. The target pipeline is:

```
SourceItem → cheap filter/score → create/enrich Opportunity → (on demand) Draft
```

The current pipeline is:

```
SourceItem → sensitivity LLM → signal extraction LLM → dedupe → theme cluster → territory LLM → Opportunity → draft LLM
```

This is not a "demotion". This is a complete pipeline rebuild. Specifically:

- `src/services/signal-extractor.ts` (entire file) must be replaced by the Intelligence Agent's filter/score logic
- `src/services/territory.ts` (entire file) must be replaced by owner suggestion logic inside the Intelligence Agent
- `src/services/dedupe.ts` (entire file) must be replaced by bounded overlap checking against active opportunities
- The `Signal` model, `SignalSourceItem` junction, `OpportunitySignal` junction must be dropped from the schema
- The `EditorialSignal` type in `src/domain/types.ts` lines 193-211 is eliminated
- The `ThemeCluster` type in `src/domain/types.ts` lines 213-219 is eliminated
- The `TerritoryAssignment` type in `src/domain/types.ts` lines 221-227 is eliminated

The plan lists files that "need redesign" but does not state that Signal as a domain concept disappears entirely.

**Required action**: State explicitly that Signal, SignalSourceItem, OpportunitySignal, and ThemeCluster are dropped from the schema. State that signal-extractor.ts, territory.ts, and dedupe.ts are deleted (not refactored). State that the Intelligence Agent replaces all three with a new two-step pipeline (filter/score then create/enrich).

### 3. The data model migration is glossed over

The vision (sections 13.1-13.11) defines a precise data model. The convergence plan says "converge to the domain model described in the vision" but never specifies the concrete schema changes.

Here is the actual gap between current schema and vision:

| Vision table | Current equivalent | Gap |
|---|---|---|
| `companies` | Does not exist | Must create |
| `users` (with baseProfile JSON, type human/corporate) | `ProfileBase` + `ProfileLearnedLayer` | Completely different model. Vision uses JSON blob for voice, current uses normalized fields + learned layer |
| `source_configs` | JSON files in `config/sources/` | Must move to DB |
| `raw_source_items` | `SourceItem` | Close but missing `companyId`, `fingerprint` field exists but named differently, `type` field missing |
| `content_opportunities` | `Opportunity` | Missing: `enrichmentLog`, `hookSuggestion1`, `hookSuggestion2`, `formatRationale`, `ownerSuggestionUserId`, `draftRequestedAt`. Has extra: `routingStatus`, `readiness`, `narrativePillar`, `v1HistoryJson`, `supportingEvidenceCount`, `evidenceFreshness` |
| `evidences` | `EvidenceReference` | Vision: standalone table with own identity. Current: tied to signal/opportunity/draft via nullable FKs. Fundamentally different ownership model |
| `opportunity_evidence` | Does not exist | Vision has a junction table with `relevanceNote`. Current couples evidence directly to owner via nullable FK |
| `draft_v1s` | `Draft` | Close but missing `confidenceNote` as text (has `confidenceScore` as float), missing body as separate field |
| `editorial_config` | Markdown files in `editorial/` | Must create DB table with versioned JSON for 3 layers |
| `market_queries` | Does not exist | Must create |
| `sync_runs` | `SyncRun` | Missing: `companyId`, `itemsFetched/Created/Updated` (has `countersJson`), `tokenInput/Output`, `estimatedCost` as top-level fields |

Tables to drop entirely: `Signal`, `SignalSourceItem`, `OpportunitySignal`, `ThemeCluster`, `ProfileLearnedLayer`, `DigestDispatch`.

**Required action**: The convergence plan must include an explicit schema migration spec, table by table. This is the highest-risk part of the refactor and cannot be left vague.

### 4. Market research does not exist — it is a new feature, not a cleanup

The vision (sections 7, 16) requires:
- Bi-weekly market research runs via a configured search API
- 5-10 results per query
- Summaries filtered through Layer 1
- Output as `raw_source_items` of type `market_research_summary`
- A `market_queries` table to configure queries per company

The current codebase has **zero web search capability**:
- No search API integration (Tavily, Perplexity, Google, SerpAPI — none)
- The `market-findings` connector in `src/connectors/market-findings.ts` only reads local markdown files from `editorial/market-findings/`
- There is no `market_queries` model in the schema

The convergence plan says "market research implementation to be specified explicitly" (line 381) but categorizes this under "Source scope cleanup" (Phase 6). This is not cleanup. This is a significant new feature requiring:
- Choosing and integrating a search API
- Building a new connector
- Creating the `market_queries` table
- Building the summarization pipeline
- Scheduling bi-weekly runs

**Required action**: Create a dedicated phase for market research implementation. Specify the search API choice. Estimate the scope honestly — this is likely 3-5 days of work, not a cleanup task.

### 5. LLM provider change is unaddressed

Current system: OpenAI via `src/services/llm.ts` using `gpt-4.1-mini`. The `LlmClient` class makes a raw `fetch` call to `https://api.openai.com/v1/chat/completions` (line 54). Cost estimation uses hardcoded OpenAI pricing (lines 148-151).

Vision (section 17):
- Intelligence Agent: "modèle Sonnet-class" (Anthropic Claude)
- Draft Agent: "le meilleur modèle choisi par l'utilisateur"

This means:
- The LLM client must support multiple providers (OpenAI and Anthropic at minimum)
- Different agents use different models
- The model choice must be configurable per agent, per company

The convergence plan never mentions the LLM provider.

**Required action**: Specify whether V1 switches to Anthropic, stays on OpenAI, or supports both. Update `src/services/llm.ts` accordingly. This affects token cost estimation (different pricing), structured output format (Anthropic uses tool_use, not json_schema), and timeout handling.

### 6. No HTTP server — but the vision requires one

The vision (section 12) says:
- "La V1 doit prévoir un petit endpoint ou action dédiée qui déclenche rapidement la génération"
- Polling Notion for draft_requested status is a "compromis, pas la cible idéale"

The current system is **CLI-only**: `src/cli.ts` is 23 lines that parse a command and call `app.run()`. There is no HTTP server, no Express, no Fastify, nothing.

The convergence plan says "explicit trigger path defined" (Phase 7) but does not acknowledge that this requires adding an HTTP framework to the project.

**Required action**: Specify the HTTP framework (e.g., Fastify). Define the endpoint surface (at minimum `POST /draft/:opportunityId`). This is infrastructure work, not a trivial task.

---

## MAJOR: Issues the plan acknowledges but handles incorrectly

### 7. "Keep plumbing, cut product" is misleading

The plan's core principle (line 23-28) sounds clean but is inaccurate. The "plumbing" is tightly coupled to the current product model:

- `src/db/repositories.ts` (971 lines, 30+ methods): Every query references the current schema. When Signal is dropped, `replaceSignalRelations()`, `listSignalsForClustering()`, `upsertSignal()`, `updateSignalNotionSync()`, `persistSignalGraph()` are all deleted. When evidence model changes, `replaceOpportunityRelations()` must be rewritten. When companyId is added, every query gains a WHERE clause.
- `src/services/notion.ts` (largest service): `syncSignal()` is deleted. `syncOpportunity()` must be rewritten (new fields, new ownership rules). The database schema setup must change.
- `src/services/evidence.ts`: `scopeEvidenceReferences()` currently scopes by signal/opportunity/draft — the scoping model changes entirely when evidence becomes standalone with a junction table.

Realistic assessment: repositories.ts will be ~60% rewritten. notion.ts will be ~50% rewritten. evidence.ts will be ~40% rewritten. These are not "kept plumbing" — they are rewritten plumbing wearing the same file names.

**Required action**: Be honest about the rewrite scope. Categorize files into: (a) truly kept as-is, (b) significantly modified, (c) deleted. The plan should quantify this.

Truly kept as-is:
- `src/connectors/base.ts` (rate limiting, retries)
- `src/connectors/notion.ts` (ingestion reads — not the service writes)
- `src/connectors/linear.ts`
- `src/connectors/claap.ts`
- `src/services/llm.ts` (core wrapper, pending provider changes)
- `src/services/observability.ts` (run tracking)
- `src/services/retention.ts`
- `src/cli.ts`

Significantly modified:
- `src/db/repositories.ts` (~60% rewrite)
- `src/services/notion.ts` (~50% rewrite)
- `src/services/evidence.ts` (~40% rewrite)
- `src/services/drafts.ts` (trigger change, editorial notes integration)
- `src/services/opportunities.ts` (complete logic rewrite — filter/score + create/enrich replaces signal-based creation)
- `src/app.ts` (complete orchestration rewrite — 3 agents replace monolithic syncDaily)
- `src/domain/types.ts` (new types, many deleted types)
- `src/config/loaders.ts` (editorial config from DB instead of files)
- `prisma/schema.prisma` (major migration)

Deleted:
- `src/services/signal-extractor.ts`
- `src/services/territory.ts`
- `src/services/dedupe.ts`
- `src/services/sensitivity.ts` (absorbed into Intelligence Agent filter step)
- `src/services/profiles.ts` (learned layer removed in V1)
- `src/services/slack.ts` (digest system cut)
- `src/connectors/slack.ts` (Slack ingestion out of scope)
- `src/connectors/market-findings.ts` (replaced by market research connector with search API)

### 8. The phasing does not deliver incremental value

The 7 phases proposed:
1. Contract freeze (no code)
2. Runtime shape refactor (3 agents)
3. Opportunity-centric redesign
4. Runtime editorial config
5. Notion cockpit simplification
6. Source scope cleanup
7. On-demand drafting

Problems:
- Phase 2 (split into 3 agents) cannot work before Phase 3 (opportunity-centric logic), because the agents need the new pipeline logic to exist
- Phase 5 (Notion cockpit) depends on Phase 3 (new opportunity fields) and Phase 4 (editorial config)
- Phase 6 (source scope) is independent and could be done first
- Phase 7 (on-demand drafting) is trivial if Phase 2 already splits the Draft Agent out

Better sequencing for incremental value:

1. **Schema migration** — new tables, drop deprecated tables, add companyId. This is the foundation everything else depends on.
2. **Source scope freeze** — disable Slack connector, freeze digest system, delete slack.ts/profiles.ts. Reduces surface area before refactoring.
3. **Ingestion Agent** — extract the fetch/normalize/store loop from syncDaily into its own command. This is the easiest agent to isolate because it has no LLM and already works cleanly.
4. **Intelligence Agent** — replace signal-extractor + territory + dedupe with two-step filter/score + create/enrich. This is the hardest phase and the core product change.
5. **Editorial config in DB** — move 3 layers to editorial_config table, load at runtime.
6. **Notion cockpit** — rewrite notion.ts sync to match new opportunity fields and ownership rules.
7. **Draft Agent with HTTP trigger** — extract draft generation, add endpoint.
8. **Market research** — new feature: search API integration, market_queries table, bi-weekly scheduling.

### 9. Status workflow mismatch is never addressed

Current `ContentStatus` in `src/domain/types.ts` lines 54-66:
```
To review, Needs routing, To enrich, Ready for V1, V1 generated,
Selected, V2 in progress, Waiting approval, Rejected, Archived
```

Current `ContentReadiness` in `src/domain/types.ts` lines 46-52:
```
Opportunity only, Draft candidate, V1 generated
```

Vision (section 14):
```
new, to_review, picked, draft_requested, draft_ready,
v2_in_progress, published, parked, rejected, archived
```

Vision also says: "Suppression de readiness — On ne garde pas de champ readiness séparé. Trop de recouvrement avec status."

Gaps:
- `readiness` field must be dropped (the plan never mentions this)
- `Needs routing` and `To enrich` statuses do not exist in the vision
- `parked` status is new (auto-parking after 14-day TTL)
- `published` status is new
- `draft_requested` / `draft_ready` replace the current V1 generation flow
- The `routingStatus` field on Opportunity must also be dropped (redundant with vision's simplified status)

**Required action**: Specify the exact status migration. Map old statuses to new. Define the 14-day TTL auto-parking job.

### 10. Enrichment is a new pattern — not a rename

The vision (section 11) describes enrichment as:
- append-only `enrichmentLog` JSON field on opportunities
- Each entry: new evidence, suggested angle update, suggested whyNow update, context comment
- Main fields (title, angle, whatItsAbout, whyNow) remain stable after creation
- User sees: initial opportunity + enrichment history + evolution suggestions

The current system has **no enrichment concept**. Today:
- `maybeCreateOpportunity()` in `src/services/opportunities.ts` either creates a new opportunity or returns null
- There is no "enrich existing opportunity" path
- `v1HistoryJson` on Opportunity tracks draft iterations, not evidence enrichment

The convergence plan mentions "append-only enrichment history" (Phase 3) but does not specify the implementation. This is a significant new behavior that requires:
- Adding `enrichmentLog` JSON field to opportunities
- Building the Intelligence Agent's "enrich existing" decision path
- Loading bounded set of active opportunities (vision says 30-40) for overlap checking
- Defining the enrichment entry schema

**Required action**: Specify the enrichmentLog schema. Specify how overlap detection works (embedding similarity? LLM comparison? title/angle text matching?). Specify the bounded loading strategy.

---

## MODERATE: Issues that need explicit decisions

### 11. Hardcoded company-specific constants must become data

These are hardcoded in source code and must move to configuration or database:

- `PROFILE_IDS` in `src/domain/types.ts` line 1-7 — hardcoded to 5 specific people
- `TERRITORY_RULES` in `src/services/territory.ts` — hardcoded keyword-to-profile mappings
- `SENSITIVITY_CATEGORIES` in `src/domain/types.ts` lines 11-18 — may need to be company-configurable
- Notion `excludedDatabaseNames` in `config/sources/notion.json` — references system database names

In a multi-tenant system, these must come from the company's configuration or from the `users` / `editorial_config` tables.

### 12. Evidence ownership model change is high-risk

Current `EvidenceReference` in `prisma/schema.prisma`:
- Has nullable `signalId`, `opportunityId`, `draftId`
- Constraint: only one can be non-null
- Used everywhere: signal creation, opportunity creation, draft creation, repair jobs

Vision `evidences` + `opportunity_evidence`:
- `evidences` is standalone (tied to `rawSourceItemId` only)
- `opportunity_evidence` is a junction table with `relevanceNote`
- Evidence exists independently; opportunities reference it

This changes how evidence is:
- Created (standalone, not scoped to an owner)
- Linked (junction table insert, not FK assignment)
- Queried (join through junction table)
- Deduplicated (by rawSourceItemId + excerpt, not by owner scope)

Every service that touches evidence must change: `evidence.ts`, `opportunities.ts`, `drafts.ts`, `notion.ts`, `repositories.ts`.

### 13. The Notion connector has dual roles that must be separated

`src/connectors/notion.ts` — ingestion source (reads Notion databases for raw content)
`src/services/notion.ts` — cockpit sync (writes opportunities, signals, profiles to Notion)

These are two completely different concerns. The convergence plan lumps them together. During refactoring:
- The connector (ingestion) is kept and mostly unchanged
- The service (cockpit sync) is heavily rewritten

They should be discussed separately in the plan.

### 14. Test strategy is absent

16 test files exist in `tests/`:
- `app.digest.test.ts`, `app.repair.test.ts` — test current app.ts orchestration
- `opportunities.test.ts` — tests current signal-based opportunity creation
- `dedupe.test.ts` — tests current signal deduplication
- `sensitivity.test.ts` — tests current per-item sensitivity
- `drafts.test.ts` — tests current draft generation
- `notion.service.test.ts` — tests current Notion sync including Signal Feed

Most of these will break during the refactor. The plan should specify:
- Which tests are deleted with their features (dedupe, sensitivity, signal extraction)
- Which tests are rewritten (opportunities, drafts, notion sync)
- What new tests are needed (Intelligence Agent filter/score, enrichment, market research)
- Whether tests should be updated phase by phase or rewritten at the end

### 15. Cost model changes significantly

Current cost model:
- 4 LLM calls per source item in the daily pipeline (sensitivity, signal extraction, territory, draft)
- OpenAI gpt-4.1-mini pricing

Vision cost model:
- Ingestion: 0 LLM calls
- Intelligence step 1 (filter/score): cheap, batched aggressively
- Intelligence step 2 (create/enrich): only for retained items
- Draft: on demand only, best model

The current system processes every source item through sensitivity + signal extraction LLM calls. The vision says the filter step should be "cheap" and "batched aggressively". This implies either:
- A non-LLM heuristic filter (keyword matching, freshness threshold)
- A single batched LLM call for many items at once
- A cheaper model for initial filtering

The plan should specify which approach to take.

---

## MINOR: Cleanups the plan should acknowledge

### 16. The `repair:opportunity-evidence` command becomes unnecessary

This repair job (529-647 lines in `app.ts`) exists because evidence is currently derived from signals, and signal-to-opportunity evidence linking can break. When signals are eliminated and evidence becomes standalone with a junction table, the repair scenario disappears.

The plan should explicitly state this command is deleted.

### 17. The `selection:scan` command needs rethinking

Currently polls Notion for opportunities marked as "Selected" and notifies Slack. With Slack digest removed, the notification target changes. With the new status workflow, "Selected" becomes "picked". This command may need to become a general Notion-to-Postgres status sync.

### 18. The `backfill` command should be preserved

Backfill runs the ingestion pipeline for a historical date. This is useful regardless of architecture and should survive the refactor. The plan should explicitly list it as kept.

### 19. Profile fast-path heuristics are company-specific code

`src/connectors/notion.ts` contains `inferProfileHint()` which maps keywords to profile IDs:
- "dsn", "paie", "urssaf" -> "thomas"
- "produit", "ux", "feature" -> "virginie"
- "commercial", "deal", "prospect" -> "quentin"

These are Linc-specific heuristics embedded in a connector. In a multi-tenant system, this logic must come from the company's editorial config (Layer 1).

### 20. The `cleanupEligible` and `rawTextExpiresAt` fields on SourceItem are useful and should survive

The retention system (`src/services/retention.ts`) with configurable `retentionDays` per source is good infrastructure. The convergence plan should explicitly preserve it.

---

## Summary of required changes to the convergence plan

Before the convergence plan becomes a roadmap, it must:

1. Add multi-tenancy as a structural requirement (companies table, companyId scoping)
2. State explicitly that Signal, ThemeCluster, SignalSourceItem, OpportunitySignal are dropped, not demoted
3. Include a concrete schema migration spec: table-by-table current-to-target mapping
4. Create a dedicated phase for market research (search API, market_queries table, scheduling)
5. Address LLM provider choice (OpenAI vs Anthropic vs multi-provider)
6. Specify HTTP server addition for draft trigger endpoint
7. Replace "keep plumbing" with honest file-by-file categorization (kept / modified / deleted)
8. Resequence phases for incremental value delivery
9. Specify status workflow migration (old statuses to new, drop readiness field)
10. Define enrichment pattern concretely (enrichmentLog schema, overlap detection mechanism)
11. Plan for hardcoded constants to become data (profiles, territories, sensitivity categories)
12. Specify evidence model migration (nullable FKs to standalone + junction)
13. Separate Notion connector (ingestion) from Notion service (cockpit) in the plan
14. Include a test strategy
15. Define the Intelligence Agent's filter step approach (heuristic vs batched LLM vs cheap model)
