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

- `sync:daily` still runs the old signal-centric path internally
- the Notion cockpit still exposes old machine-oriented surfaces
- draft generation is on-demand, but draft hardening and editorial override handling are not finished
- full repo-wide multi-tenancy is not complete until the signal-era models are removed in Phase 9

What happens next:

- Phase 6: rewrite the Notion cockpit around opportunities, profiles, and runs

## Transitional truths

These are still transitional and must not be confused with the target architecture:

- `intelligence:run` uses the new filter/score → create/enrich pipeline, but `sync:daily` still uses the old signal-centric path internally
- `Signal`, `ThemeCluster`, `SignalSourceItem`, and `OpportunitySignal` still exist in schema and code — they are used exclusively by `sync:daily` and are Phase 9 deletion targets
- Signal-centric service files (`signal-extractor.ts`, `territory.ts`, `dedupe.ts`, `sensitivity.ts`) are NOT deleted because `sync:daily` and `drafts.ts` still import them — deletion deferred to Phase 9
- Slack ingestion and digest are still present in code, even if they are no longer part of the target
- the Notion cockpit shows 3 required databases (Content Opportunities, Profiles, Sync Runs); Signal Feed and Market Findings are legacy (never auto-created, synced only if already present)
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

## To delete, not preserve

- [`/Users/clement/projects/fresh/src/services/signal-extractor.ts`](/Users/clement/projects/fresh/src/services/signal-extractor.ts)
- [`/Users/clement/projects/fresh/src/services/territory.ts`](/Users/clement/projects/fresh/src/services/territory.ts)
- [`/Users/clement/projects/fresh/src/services/dedupe.ts`](/Users/clement/projects/fresh/src/services/dedupe.ts)
- [`/Users/clement/projects/fresh/src/services/sensitivity.ts`](/Users/clement/projects/fresh/src/services/sensitivity.ts)
- [`/Users/clement/projects/fresh/src/services/profiles.ts`](/Users/clement/projects/fresh/src/services/profiles.ts)
- [`/Users/clement/projects/fresh/src/services/slack.ts`](/Users/clement/projects/fresh/src/services/slack.ts)
- [`/Users/clement/projects/fresh/src/connectors/slack.ts`](/Users/clement/projects/fresh/src/connectors/slack.ts)
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
- still coexists with the deprecated signal-centric `sync:daily` path

### Agent 3 — Draft Agent

Responsibilities:

- generate one draft only on explicit request
- load the opportunity, profile, evidence, Layer 3 craft config, and editorial notes

Current status:

- command exists
- HTTP trigger exists
- still backed by the old draft model and old opportunity model

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

## Tables to remove after cutover

- `Signal`
- `SignalSourceItem`
- `OpportunitySignal`
- `ThemeCluster`
- `ProfileLearnedLayer`
- `DigestDispatch`

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
- bi-weekly scheduled research runs
- 5 to 10 search results max per query
- summarize results through Layer 1
- inject the results as `raw_source_items` with `type = market_research_summary`

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
- market research creates bounded raw source items from Tavily results
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

- not implemented

Required outcomes:

- disable Slack ingestion from active runtime
- remove digest from the core path
- stop spending engineering effort on old Slack-centric workflow code

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

- Signal-centric service files (`signal-extractor.ts`, `territory.ts`, `dedupe.ts`, `sensitivity.ts`) NOT deleted — `sync:daily` and `drafts.ts` still import them. Deletion deferred to Phase 9.
- `Signal.sourceFingerprint @unique` and `ThemeCluster.key @id` remain globally scoped — Phase 9 deletion targets. `sync:daily` must NOT be run for multiple companies until Phase 9.
- `SyncRun.companyId` is written by `intelligence:run` and `sync:daily` only. Other commands (`ingest:run`, `draft:generate`, `digest:send`, etc.) remain unscoped until explicitly patched in later phases.
- `SourceItem.id` and `Opportunity.id` were remapped to company-scoped values — hard cutover. Old IDs in external scripts, bookmarks, or API calls are invalidated. `DigestDispatch.opportunityIdsJson` was explicitly migrated. No alias table is provided.

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

- partially implemented

Required outcomes:

- keep draft generation out of scheduled processing
- make HTTP-triggered draft generation observable and production-safe
- integrate editorial notes as first-class human overrides

## Phase 8 — Market research

Status:

- not implemented

Required outcomes:

- Tavily integration
- `market_queries` usage
- bi-weekly search runs

## Phase 9 — Final cleanup

Status:

- not implemented

Required outcomes:

- remove obsolete tables
- remove obsolete commands
- remove obsolete services and tests

## Next Agent Mandate

The next implementation agent should work on **Phase 7** (Draft Agent hardening):

### Title

Harden draft generation: on-demand only, quality guardrails, enrichment-aware.

### What the next agent must do

1. Ensure draft generation remains on-demand only (no background auto-generation).
2. Add quality guardrails and enrichment-awareness to the draft pipeline.
3. Keep the rest of the repo buildable and tested while doing this.

### What the next agent must not do

- do not start market research implementation yet (Phase 8)
- do not delete signal-centric services yet (still needed by `sync:daily` until Phase 9)
- do not migrate status values (deferred)

### Acceptance bar for the next agent

- Draft generation works on-demand with quality improvements
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

- the repo is still salvageable
- the product shape is still the problem
- the current intelligence slice is landed
- Phase 6 (Notion cockpit rewrite) is complete; the next slice is Phase 7 (Draft Agent hardening)
