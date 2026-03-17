# Convergence Plan — Vision-Strict Refactor of Current Repo

## Status

This document is now the **live convergence roadmap**, not a draft.

It has been updated based on:

- the product contract in [`/Users/clement/projects/fresh/docs/vision_doc.md`](/Users/clement/projects/fresh/docs/vision_doc.md)
- the review challenges in [`/Users/clement/projects/fresh/docs/convergence_feedback.md`](/Users/clement/projects/fresh/docs/convergence_feedback.md)
- the implemented foundation slice now present in the repository

This document must remain aligned with the codebase state.
If implementation deviates, this file must be updated immediately.

## Decision

We are **not rebuilding from scratch**.

We are converging the current repository through a sequence of hard refactors.

Plain language:

- keep the infrastructure that is already expensive and correct
- stop defending product layers that conflict with the vision
- replace the workflow shape inside the existing repo

## Non-Negotiable Contract

The product contract is [`/Users/clement/projects/fresh/docs/vision_doc.md`](/Users/clement/projects/fresh/docs/vision_doc.md).

The critical rules are:

- `Content Opportunity` is the central product object
- the users are the creators themselves, not a content-ops middleware layer
- V1 has exactly `3` agents:
  - `Ingestion Agent`
  - `Intelligence Agent`
  - `Draft Agent`
- Postgres is the source of truth
- Notion is a cockpit, not the brain
- multi-tenancy is structurally present from V1
- drafts are generated on demand only
- Slack ingestion is out of scope for V1
- digest is not a core workflow mechanism
- `Signal Feed` is not a core user-facing object
- `ThemeCluster` is not a business object
- editorial judgment must come from runtime config, not hardcoded heuristics

## Reality Check After Review

The review in [`/Users/clement/projects/fresh/docs/convergence_feedback.md`](/Users/clement/projects/fresh/docs/convergence_feedback.md) changed the plan in important ways.

### What is now explicitly acknowledged

- Multi-tenancy is a first-class migration requirement, not a later enhancement.
- `Signal`, `SignalSourceItem`, `OpportunitySignal`, and `ThemeCluster` are not being “demoted”; they are target deletions.
- The current-to-target schema migration is a major workstream, not a side detail.
- Market research is a net-new feature and has its own dedicated phase.
- The LLM layer must support multiple providers.
- The draft trigger requires HTTP infrastructure, not just another CLI command.
- The phrase “keep plumbing” was too soft; large parts of the app and repositories will be rewritten.

### What is still true despite the review

- The repo is still worth keeping.
- Rebuilding would still waste working integration and persistence foundations.
- The right move is still a ruthless convergence refactor, not incremental feature drift.

## Current Code Status

## Implemented foundation slice

This part is already done and approved:

- New command surface scaffolded in:
  - [`/Users/clement/projects/fresh/package.json`](/Users/clement/projects/fresh/package.json)
  - [`/Users/clement/projects/fresh/src/cli.ts`](/Users/clement/projects/fresh/src/cli.ts)
- New commands added:
  - `ingest:run`
  - `intelligence:run`
  - `draft:generate`
  - `server:start`
- First HTTP draft trigger added in [`/Users/clement/projects/fresh/src/server.ts`](/Users/clement/projects/fresh/src/server.ts):
  - `POST /v1/companies/:companyId/opportunities/:opportunityId/draft`
- First convergence foundation migration added in:
  - [`/Users/clement/projects/fresh/prisma/schema.prisma`](/Users/clement/projects/fresh/prisma/schema.prisma)
  - [`/Users/clement/projects/fresh/prisma/migrations/20260313090000_convergence_foundation/migration.sql`](/Users/clement/projects/fresh/prisma/migrations/20260313090000_convergence_foundation/migration.sql)
- Additive-only schema support now exists for:
  - `Company`
  - `User`
  - `EditorialConfig`
  - `SourceConfig`
  - `MarketQuery`
  - `companyId` on existing major tables
  - `processedAt` on `SourceItem`
- Company/config/bootstrap seeding exists in [`/Users/clement/projects/fresh/src/services/convergence.ts`](/Users/clement/projects/fresh/src/services/convergence.ts)
- `ingest:run` is isolated and stores raw source items only
- `intelligence:run` is split out and now processes stored source items via `processedAt`
- `draft:generate` is explicit and requires `--opportunity-id`
- multi-provider LLM scaffolding exists in [`/Users/clement/projects/fresh/src/services/llm.ts`](/Users/clement/projects/fresh/src/services/llm.ts)

## Where we are now

The repository is now past the foundation-only stage.

What is complete:

- Phase 1 foundation migration
- Phase 5 Intelligence Agent rewrite
- company-scoped IDs and uniqueness on `SourceItem`, `Opportunity`, and `SourceCursor`
- standalone evidence writes for the new intelligence path
- append-only enrichment logging

What is still transitional:

- Status values still use old enum (`"To review"`, `"Selected"`, etc.). Target enum migration is the next slice.
- Opportunity has nullable signal-era columns (`narrativePillar`, `routingStatus`, `readiness`, `v1HistoryJson`) pending removal.
- `ProfileId` type constraint and `PROFILE_IDS` constant still exist. Removal requires type-contract reshaping.
- FK-owned `EvidenceReference.opportunityId` data still exists. Reads merge both FK-owned and junction-linked evidence.
- `selection:scan` still uses Notion polling for inbound editorial owner sync. HTTP-based selection is the target UX.

What happens immediately:

- Dogfood the product end to end on real company data
- validate the operator workflow in Notion
- validate the three active runtime paths:
  - `ingest:run`
  - `intelligence:run`
  - `draft:generate`
- validate the bounded market research path:
  - `market-research:run`
- collect friction before starting another schema cleanup slice

What happens after dogfooding:

- Status model migration (old → new status enum)
- Opportunity column cleanup (`narrativePillar`, `routingStatus`, `readiness`, `v1HistoryJson` removal)
- Evidence FK→junction data backfill
- `ProfileId` type cleanup

## Remaining transitional state after Phase 9

Multi-tenancy is structurally complete for the core pipeline (`ingest:run`, `intelligence:run`, `draft:generate`, `market-research:run`). Remaining gap: `selection:scan` is still globally scoped — it creates an unscoped run, queries the Notion "Content Opportunities" database globally, and updates rows by `notionPageId` without company filtering. Notion database bindings are keyed by `(parentPageId, name)` rather than company. This path can cross company boundaries in multi-company deployments. Scoping `selection:scan` by company is deferred to the next slice.

Other remaining gaps: status values not yet migrated to target enum, Opportunity has nullable signal-era columns pending removal.

- Anthropic structured output currently uses a pragmatic raw-JSON prompt path, not a final native tool-based integration

## Minor known follow-ups from the approved review

These are acknowledged but not blockers for the current slice:

1. [`/Users/clement/projects/fresh/src/server.ts`](/Users/clement/projects/fresh/src/server.ts)
   - `request.log.error(...)` is weak because Fastify is started with `logger: false`
2. [`/Users/clement/projects/fresh/package.json`](/Users/clement/projects/fresh/package.json)
   - `@anthropic-ai/sdk` is currently unused because provider calls still go through raw `fetch`
3. [`/Users/clement/projects/fresh/src/services/llm.ts`](/Users/clement/projects/fresh/src/services/llm.ts)
   - Anthropic structured output is still fragile and must be tightened when Intelligence Agent becomes the main path

## Rewrite Scope

## Keep mostly as-is

- connector read infrastructure in:
  - [`/Users/clement/projects/fresh/src/connectors/base.ts`](/Users/clement/projects/fresh/src/connectors/base.ts)
  - [`/Users/clement/projects/fresh/src/connectors/notion.ts`](/Users/clement/projects/fresh/src/connectors/notion.ts)
  - [`/Users/clement/projects/fresh/src/connectors/linear.ts`](/Users/clement/projects/fresh/src/connectors/linear.ts)
  - [`/Users/clement/projects/fresh/src/connectors/claap.ts`](/Users/clement/projects/fresh/src/connectors/claap.ts)
- retention support in [`/Users/clement/projects/fresh/src/services/retention.ts`](/Users/clement/projects/fresh/src/services/retention.ts)
- observability base in [`/Users/clement/projects/fresh/src/services/observability.ts`](/Users/clement/projects/fresh/src/services/observability.ts)
- CLI/runtime entry shape in [`/Users/clement/projects/fresh/src/cli.ts`](/Users/clement/projects/fresh/src/cli.ts)

## Significantly rewritten

- [`/Users/clement/projects/fresh/prisma/schema.prisma`](/Users/clement/projects/fresh/prisma/schema.prisma)
- [`/Users/clement/projects/fresh/src/db/repositories.ts`](/Users/clement/projects/fresh/src/db/repositories.ts)
- [`/Users/clement/projects/fresh/src/app.ts`](/Users/clement/projects/fresh/src/app.ts)
- [`/Users/clement/projects/fresh/src/services/notion.ts`](/Users/clement/projects/fresh/src/services/notion.ts)
- [`/Users/clement/projects/fresh/src/services/evidence.ts`](/Users/clement/projects/fresh/src/services/evidence.ts)
- [`/Users/clement/projects/fresh/src/services/drafts.ts`](/Users/clement/projects/fresh/src/services/drafts.ts)
- [`/Users/clement/projects/fresh/src/services/llm.ts`](/Users/clement/projects/fresh/src/services/llm.ts)
- [`/Users/clement/projects/fresh/src/config/loaders.ts`](/Users/clement/projects/fresh/src/config/loaders.ts)
- [`/Users/clement/projects/fresh/src/domain/types.ts`](/Users/clement/projects/fresh/src/domain/types.ts)

## Deleted in Phase 9

- `src/services/signal-extractor.ts`
- `src/services/territory.ts`
- `src/services/dedupe.ts`
- `src/services/profiles.ts`
- `src/services/slack.ts`
- `src/connectors/slack.ts`

## Still pending deletion

- [`/Users/clement/projects/fresh/src/connectors/market-findings.ts`](/Users/clement/projects/fresh/src/connectors/market-findings.ts) after manual findings are folded into the raw source item model

## Target Runtime Shape

The target runtime shape remains exactly `3` agents.

### Agent 1 — Ingestion Agent

Responsibilities:

- load active source configs for one company
- fetch new items
- normalize them into raw source items
- deduplicate by source identity and fingerprint
- store sync metrics
- no LLM calls

Current status:

- partially implemented via `ingest:run`

### Agent 2 — Intelligence Agent

Responsibilities:

- load new raw source items
- load one editorial config version
- run cheap filter / score
- decide:
  - create opportunity
  - enrich opportunity
  - skip
- attach evidence
- suggest owner
- sync opportunities to Notion

Current status:

- implemented for the new `intelligence:run` path
- reads company editorial config and users from DB
- creates or enriches opportunities directly from stored source items
- `sync:daily` removed in Phase 9 — `intelligence:run` is the sole intelligence path

### Agent 3 — Draft Agent

Responsibilities:

- generate one draft only on explicit request
- load the opportunity, profile, evidence, Layer 3 craft config, and editorial notes

Current status:

- command exists
- HTTP trigger exists
- backed by convergence-era `generateDraft()` with DB-backed editorial config

## Data Model Convergence

## New canonical tables

- `companies`
- `users`
- `source_configs`
- `raw_source_items`
- `content_opportunities`
- `evidences`
- `opportunity_evidence`
- `draft_v1s`
- `editorial_config`
- `market_queries`
- `sync_runs`

## Current-to-target mapping

### `SourceItem` -> `raw_source_items`

- add `companyId`
- keep retention fields like `rawTextExpiresAt` and `cleanupEligible`
- add explicit `type`
  - future schema convergence, not delivered in Phase 8
- keep `processedAt`

### `Opportunity` -> `content_opportunities`

- drop:
  - `routingStatus`
  - `readiness`
  - `narrativePillar`
  - `v1HistoryJson`
- add:
  - `hookSuggestion1`
  - `hookSuggestion2`
  - `formatRationale`
  - `ownerUserId`
  - `ownerSuggestionUserId`
  - `enrichmentLog`
  - `draftRequestedAt`

### `Draft` -> `draft_v1s`

- keep core draft fields
- replace numeric-only confidence with `confidenceNote` text

### `EvidenceReference` -> `evidences` + `opportunity_evidence`

- evidence becomes standalone
- evidence belongs to a company and a raw source item
- linking to opportunities moves to a junction table with `relevanceNote`
- Phase 5 introduces standalone evidence + `OpportunityEvidence` junction table for the new intelligence pipeline
- The old pipeline continues using FK-owned evidence (`EvidenceReference.opportunityId`)
- Full migration of reads and removal of old FK model happens in Phase 6
- Reads (`mapOpportunityRow`) merge both sources: FK-owned evidence + junction-linked evidence, deduped by semantic signature (`sourceItemId:excerptHash`)

### `ProfileBase` + `ProfileLearnedLayer` -> `users`

- `baseProfile` stored as JSON
- no learned layer in V1

### `SyncRun` -> `sync_runs`

- add `companyId`
- move key counters and token totals toward explicit top-level fields where the vision requires them

## Tables removed in Phase 9

- `Signal`
- `SignalSourceItem`
- `OpportunitySignal`
- `ThemeCluster`
- `ProfileLearnedLayer`
- `DigestDispatch`
- `ProfileBase`

## Migration strategy

1. Add additive multi-tenant and config foundations first.
2. Seed one default company and backfill existing rows.
3. Backfill `users` from current profile data.
4. Backfill `source_configs` from current JSON config files.
5. Backfill `editorial_config` from current markdown/config content.
6. Backfill standalone `evidences` from current evidence rows using `sourceItemId` ownership only.
7. Create `opportunity_evidence` links from current opportunity evidence associations.
8. Backfill new opportunity fields with deterministic defaults.
9. Switch reads to target schema.
10. Switch writes to target schema.
11. Remove old schema only after production verification.

## Workflow and Status Migration

## Target status model

- `new`
- `to_review`
- `picked`
- `draft_requested`
- `draft_ready`
- `v2_in_progress`
- `published`
- `parked`
- `rejected`
- `archived`

## Fields to remove

- `readiness`
- `routingStatus`

## Status migration mapping

- `To review` -> `to_review`
- `Needs routing` -> `new`
- `To enrich` -> `to_review`
- `Ready for V1` -> `to_review`
- `Selected` -> `picked`
- `V1 generated` -> `draft_ready`
- `Waiting approval` -> `v2_in_progress`
- `V2 in progress` -> `v2_in_progress`
- `Rejected` -> `rejected`
- `Archived` -> `archived`

## TTL rule

- opportunities in `new` or `to_review` for more than 14 days move automatically to `parked`
- `parked` opportunities remain enrichable
- fresh evidence can reactivate them to `new`

## Intelligence Agent Target Design

## Step 1 — Filter / score

Approach:

- deterministic prefilter first:
  - source enabled
  - freshness window
  - source type allowlist
  - unchanged skip
- then bounded batched LLM screening with Anthropic Sonnet-class

Output:

- `skip`
- `retain`
- short rationale
- rough owner suggestion when obvious
- rough create-vs-enrich hint when obvious

Important rule:

- standalone sensitivity as a separate pipeline stage disappears
- unsafe content becomes one filter/score outcome, not a first-class product object

## Step 2 — Create / enrich

Approach:

- load the 40 most recent active opportunities for the same company
- narrow candidate overlaps deterministically using:
  - owner suggestion
  - lexical overlap on title / angle / topic
  - same source thread or same external object when available
- for top 5 overlap candidates, run Sonnet comparison to decide:
  - create new
  - enrich existing
  - skip
- under-deduplicate by default if uncertain

## Enrichment log schema

Each `enrichmentLog` entry contains:

- `createdAt`
- `rawSourceItemId`
- `evidenceIds`
- `contextComment`
- `suggestedAngleUpdate` nullable
- `suggestedWhyNowUpdate` nullable
- `ownerSuggestionUpdate` nullable
- `confidence`
- `reason`

Core rule:

- stable visible fields are not overwritten automatically after creation
- enrichment appends history and optional suggestions only

## Editorial Config Convergence

The source of truth becomes DB-backed `editorial_config`, versioned per company.

It contains:

- Layer 1: company editorial lens
- Layer 2: content philosophy
- Layer 3: LinkedIn craft knowledge
- thresholds and caps
- source policy
- safety policy
- owner suggestion rules
- allowed themes / territories
- sensitivity categories if made company-configurable

## Hardcoded things that must become data

- profile IDs currently in [`/Users/clement/projects/fresh/src/domain/types.ts`](/Users/clement/projects/fresh/src/domain/types.ts)
- territory mappings currently in [`/Users/clement/projects/fresh/src/services/territory.ts`](/Users/clement/projects/fresh/src/services/territory.ts)
- company-specific heuristics in [`/Users/clement/projects/fresh/src/connectors/notion.ts`](/Users/clement/projects/fresh/src/connectors/notion.ts)
- source config JSON in [`/Users/clement/projects/fresh/config/sources`](/Users/clement/projects/fresh/config/sources)

## Source Scope

## V1 sources kept

- Notion
- Claap
- Linear
- manual market findings
- market research runs

## V1 sources removed

- Slack ingestion
- LinkedIn scraping
- automatic ingestion of existing LinkedIn posts/drafts

## Market research

This is a dedicated feature phase, not cleanup.

Search API:

- Tavily

V1 behavior:

- `market_queries` table per company
- externally scheduled market research runs executed twice per week via `market-research:run`
- 5 to 10 search results max per query
- summarize results through Layer 1
- inject the results as normal stored source items with `source = market-research` and `metadata.kind = market_research_summary`

## Notion Responsibilities

## Keep separate

- [`/Users/clement/projects/fresh/src/connectors/notion.ts`](/Users/clement/projects/fresh/src/connectors/notion.ts)
  - ingestion read path
- [`/Users/clement/projects/fresh/src/services/notion.ts`](/Users/clement/projects/fresh/src/services/notion.ts)
  - cockpit write path

## Target Notion cockpit

Main human-facing databases:

- `Content Opportunities`
- `Profiles`
- `Sync Runs`

`Signal Feed` is removed from the main cockpit contract.

Ownership rules:

- system-owned structured fields are system-written
- `status` and `editorialNotes` remain human-owned
- human edits are never overwritten

## LLM Provider Plan

## Intelligence Agent

- Anthropic Sonnet-class for filter/score and create/enrich reasoning

## Draft Agent

- provider/model chosen per company or per request
- initial supported providers:
  - Anthropic
  - OpenAI

## Current implementation status

- provider abstraction scaffolded
- OpenAI and Anthropic raw API paths exist
- Anthropic structured output still needs hardening before it becomes the main intelligence path

## Tests

## Delete with removed features

- signal extraction tests
- territory tests
- dedupe tests
- Slack digest tests
- Slack ingestion tests
- learned profile layer tests

## Rewrite

- opportunity tests become create/enrich tests
- notion service tests become cockpit-opportunity tests
- orchestration tests become:
  - ingestion agent tests
  - intelligence agent tests
  - draft HTTP trigger tests
- evidence tests become standalone evidence + opportunity_evidence tests

## Add

- multi-tenant repository scoping tests
- schema migration/backfill tests
- enrichment log append-only tests
- overlap detection tests
- status migration tests
- TTL auto-park tests
- market research connector tests
- provider abstraction tests for Anthropic and OpenAI
- draft endpoint tests
- company-config loading tests

## Acceptance scenarios

- one company cannot read or write another company’s items
- new raw source items create or enrich opportunities correctly
- enrichment never overwrites human edits
- opportunities auto-park after 14 days of inactivity
- draft generation works only through explicit trigger
- market research creates bounded source items from Tavily results
- unchanged Tavily result sets are skipped without updating the stored source item, so `processedAt` is not reset for unchanged research
- Notion cockpit stays aligned to the opportunity model only

## Delivery Sequence

## Phase 1 — Foundation migration

Status:

- implemented

Delivered:

- additive multi-tenant schema foundation
- default company seeding
- DB-backed source config and editorial config bootstrap
- `processedAt` queue foundation
- multi-provider LLM scaffold
- explicit command surface
- HTTP draft trigger scaffold

## Phase 2 — Freeze old scope

Status:

- absorbed into Phase 9

Required outcomes (delivered in Phase 9):

- Slack ingestion fully removed (connector, service, types, config, env vars, npm dependency)
- digest command and path fully removed
- no Slack-centric workflow code remains

## Phase 3 — Ingestion Agent stabilization

Status:

- partially implemented

Required outcomes:

- `ingest:run` becomes the canonical ingestion path
- all scheduled ingestion uses it
- no hidden LLM work remains in the ingestion path
- all source items are company-scoped

## Phase 4 — Editorial config backbone

Status:

- partially implemented

Required outcomes:

- stop reading judgment rules from scattered markdown/config at runtime
- read canonical editorial behavior from DB-backed `editorial_config`

## Phase 5 — Intelligence Agent rewrite

Status:

- implemented

Delivered:

- New `intelligence:run` pipeline: `SourceItem → Evidence → Filter/Score (batched LLM) → Create/Enrich (overlap detection) → Opportunity`
- New service: `src/services/intelligence.ts` with `prefilterSourceItems`, `screenSourceItems`, `narrowCandidateOpportunities`, `decideCreateOrEnrich`, `buildNewOpportunity`, `buildEnrichmentUpdate`, `runIntelligencePipeline`
- Standalone evidence model: `EvidenceReference` rows with `companyId` + `sourceItemId`, no `opportunityId`, linked via `OpportunityEvidence` junction table
- Owner identity via `User.id` (`ownerUserId`), not `displayName` — `ownerProfile` preserved for backward compat only
- Append-only enrichment: visible fields never overwritten, `enrichmentLogJson` carries suggestions only
- Runtime config from DB: `loadIntelligenceInputs(companyId)` reads `EditorialConfig` and `User` records
- Company-scoped IDs: `SourceItem.id` and `Opportunity.id` remapped to `createDeterministicId("si"|"opportunity", [companyId, ...])`
- Company-scoped unique constraints on `SourceItem`, `Opportunity`, `SourceCursor`
- `companyId` NOT NULL on `SourceItem` and `Opportunity` (backfilled from seeded company)
- `sync:daily` patched for companyId propagation (cursor, source items, signals, opportunities)
- Zod schemas: `screeningBatchSchema`, `createEnrichDecisionSchema`
- New repository methods: `listUsers`, `listRecentActiveOpportunities`, `createOpportunityOnly`, `persistStandaloneEvidence`, `enrichOpportunity`, `saveScreeningResults`, `validatePrimaryEvidenceOwnership`

Constraints:

- Signal-centric service files deleted in Phase 9. `sensitivity.ts` kept for convergence-era draft safety.
- `Signal`, `ThemeCluster`, `SignalSourceItem`, `OpportunitySignal` models dropped in Phase 9.
- `SourceItem.id` and `Opportunity.id` were remapped to company-scoped values — hard cutover. Old IDs in external scripts, bookmarks, or API calls are invalidated. No alias table is provided.

## Phase 6 — Notion cockpit rewrite

Status:

- implemented

Required outcomes:

- rewrite cockpit around opportunities, profiles, and runs
- remove Signal Feed from the main user product surface
- protect human-owned fields (Status, Editorial notes, Editorial owner) from system overwrite
- sync User records (not ProfileBase snapshots) to the Profiles database

Not included in Phase 6:

- status value migration (old → new status enum) — requires coordinated DB + code change
- hookSuggestion1/2, formatRationale, draftRequestedAt — requires schema migration first
- ownerSuggestionUserId — requires schema migration first

## Phase 7 — Draft Agent hardening

Status:

- implemented

Delivered:

- auto-draft block removed from `syncDaily` — daily sync no longer creates drafts
- `generateDraftOnDemand` rewritten to use convergence-era DB-backed inputs (`loadIntelligenceInputs`)
- company scoping: `run.companyId` set, ownership check enforced (`ForbiddenError`)
- editorial notes integrated as first-class human overrides (read from Notion at trigger boundary)
- new `generateDraft()` function in `drafts.ts` (legacy `maybeGenerateDraft` removed in Phase 9)
- enrichment-aware prompt: `opportunity.enrichmentLog` formatted into draft prompt
- Layer 3 LinkedIn craft defaults from `EditorialConfig` included in prompt
- custom error classes (`NotFoundError`, `ForbiddenError`, `UnprocessableError`) with HTTP status mapping
- HTTP endpoint hardened: 200 (not 202), proper error codes (404/403/422/500), logging enabled, testable route extraction
- anti-regression tests prove `syncDaily` cannot create drafts and draft creation only through explicit trigger

Required outcomes:

- keep draft generation out of scheduled processing
- make HTTP-triggered draft generation observable and production-safe
- integrate editorial notes as first-class human overrides

## Phase 8 — Market research

Status:

- implemented

Delivered:

- separate `market-research:run` command, intended for external twice-weekly scheduling per company
- Tavily-backed market research service in `src/services/market-research.ts`
- dedicated runtime config in `config/market-research.json`, kept outside the generic `config/sources` connector path
- company-scoped `market_queries` read path
- bounded result normalization, stable result-set hashing, and skip-on-unchanged behavior before summary generation
- research summaries stored as normal source items with `source = "market-research"` and `metadata.kind = "market_research_summary"`
- intelligence-model structured summary step `market-research-summary`
- regression coverage for connector isolation, unchanged-result skipping, retry behavior, and grounded citations

Constraints:

- `SourceItem.type` remains deferred; Phase 8 uses `metadata.kind = "market_research_summary"` instead
- no in-process scheduler was added; execution is still command-driven and must be triggered externally
- manual `market-findings` support remains in place and is not yet folded away
- Phase 8 does not remove any signal-era compatibility code

## Phase 9 — Final signal-era cleanup

Status:

- implemented

Delivered:

- Deleted signal-era entry points: `sync:daily`, `digest:send`, `profile:weekly-recompute`, `backfill`, `repair:opportunity-evidence`
- Deleted signal-era services: `signal-extractor.ts`, `territory.ts`, `dedupe.ts`, `profiles.ts`, `slack.ts`
- Deleted signal-era connector: `connectors/slack.ts`
- Full Slack removal: types, config, env vars, Zod schemas, connector registry, npm dependency (`@slack/web-api`)
- Cleaned shared services: removed `maybeGenerateDraft`, `maybeCreateOpportunity`, `qualifyDraftCandidate`, `syncSignal`, `syncMarketFinding`, `syncProfile`, `LEGACY_DATABASES`
- Cleaned repositories: removed 19 signal-era methods, updated `opportunityInclude` (dropped `relatedSignals`), removed `signalIds` from `replaceOpportunityRelations`
- Cleaned domain types: removed `EditorialSignal`, `ThemeCluster`, `TerritoryAssignment`, `ProfileLearnedLayer`, `ProfileSnapshot`, `DigestDispatch`, signal-era status/type constants, Slack types
- Dropped 7 Prisma models: `Signal`, `SignalSourceItem`, `OpportunitySignal`, `ThemeCluster`, `ProfileLearnedLayer`, `DigestDispatch`, `ProfileBase`
- Dropped `EvidenceReference.signalId` column and FK
- Made Opportunity columns nullable with defaults: `narrativePillar`, `routingStatus`, `readiness`, `v1HistoryJson`
- `selection:scan` kept minimal — Slack notification removed, Notion→DB editorial owner bridge preserved
- `sensitivity.ts` kept — still used by convergence-era `generateDraft()` safety check
- Deleted 7 test files, updated 5 test files
- All tests pass, TypeScript compiles cleanly

## Next Agent Mandate

The immediate next work is **dogfooding and operator validation**, not another refactor slice.

### Immediate focus

Use the current system with real data and confirm that the product is usable end to end:

1. ingest real source items with `ingest:run`
2. create and enrich opportunities with `intelligence:run`
3. run `market-research:run` and confirm it feeds the same pipeline cleanly
4. select opportunities from Notion and confirm `selection:scan` updates Postgres as expected
5. generate drafts on demand through CLI and HTTP
6. log workflow friction before changing schema or status contracts

### Next implementation slice after dogfooding

The next implementation agent should work on **status model migration and column cleanup**:

### Title

Migrate opportunity status values to the target enum and remove signal-era nullable columns.

### What the next agent must do

1. Implement the status migration mapping (old → new enum values) as documented in the “Status migration mapping” section above.
2. Remove nullable signal-era columns from Opportunity (`narrativePillar`, `routingStatus`, `readiness`, `v1HistoryJson`) after migrating any convergence-era code that still writes to them.
3. Backfill FK-owned `EvidenceReference.opportunityId` data to `OpportunityEvidence` junction links.
4. Clean up `ProfileId` type constraint and `PROFILE_IDS` constant.
5. Keep the repo buildable and tested throughout.

### What the next agent must not do

- do not start a new feature phase
- do not reintroduce signal-era surfaces
- do not change Notion cockpit database structure

### Acceptance bar for the next agent

- Opportunity uses the target status enum exclusively
- Signal-era nullable columns are removed from the schema
- `ProfileId` hardcoded type is replaced with dynamic user identity
- the repo still passes typecheck and tests after the slice

## Anti-Regression Rules

The following must not regress during convergence:

- Postgres remains source of truth
- Notion remains a cockpit, not the brain
- opportunities remain evidence-backed
- no automatic publishing
- no silent overwrite of human edits
- no blind Notion name-based targeting
- no Slack ingestion returning through the back door as “temporary V1”
- no `Signal Feed` promoted back into the user workflow
- no `ThemeCluster` restored as a business object
- no learned profile layer restored as a V1 dependency
- no daily background draft generation

## Recommendation

Proceed with the convergence refactor on the current repo.

But from this point forward, every implementation slice must:

- say which phase it is completing
- say what obsolete code it is deleting
- keep the repo buildable
- update this document when the slice lands

Plain language:

- the repo now has a single opportunity-centric architecture
- Phase 9 (Final signal-era cleanup) is complete
- the immediate priority is to dogfood the product on real usage
- the next cleanup slice after dogfooding is status model migration and column cleanup
