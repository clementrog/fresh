# Fresh Sales High-Level Roadmap

## Executive summary

Fresh Sales can be built as a sibling product inside the existing Fresh repo without destabilizing Fresh Content. The repo provides real infrastructure leverage — LLM client, evidence pipeline, admin UI shell, connector pattern, observability, and shared data models — saving roughly 2-3 weeks of foundation work. But the product-specific logic (matching, recommendations, doctrine, drafts) must be built new. Attempting to bend Content abstractions to fit Sales is the single biggest risk.

The roadmap has 7 phases. Phases 0-1 establish boundaries and the data model. Phase 2 connects HubSpot and gets signals flowing. Phase 3 builds the matching engine — the core of the product. Phase 4 makes it usable with a recommendation feed. Phase 5 adds draft generation (important but secondary to recommendation quality). Phase 6 adds operational visibility. Everything else waits.

The critical path is: HubSpot sync → signal generation → deal-signal matching → recommendation feed. Draft generation is deliberately not on the critical path because a recommendation that correctly tells you "follow up with Acme about SSO" is valuable even without a generated draft.

v1 runs on polling (cron every 15-30 min), not webhooks. v1 is white-glove onboarded, not self-serve. v1 never auto-sends.

---

## Reuse strategy

### Direct reuse (import and use as-is)
- **`LlmClient`** (`services/llm.ts`) — Multi-provider structured output, Zod validation, cost tracking, fallback. The most valuable single piece.
- **Evidence core** (`services/evidence.ts`) — `buildEvidenceReferences()`, `dedupeEvidenceReferences()`, `computeFreshnessScore()`, `selectPrimaryEvidence()`. Used for Sales proof handling.
- **`lib/*`** — Deterministic IDs, hashing, logger, error classes. Product-agnostic utilities.
- **Admin UI shell** — `layout.ts`, `components.ts` (table, badge, pagination, filter bar, stat cards), `plugin.ts` (auth, access control). Immediately usable for Sales pages.
- **Observability** (`services/observability.ts`) — Run tracking, cost ledger entries, spike warnings.
- **DB infrastructure** — `db/client.ts` (Prisma singleton), `connectors/base.ts` (rate limiting), `services/retention.ts`.
- **Shared Prisma models** — `Company`, `User`, `SourceItem`, `SourceCursor`, `SyncRun`, `CostLedgerEntry`.

### Pattern reuse (same shape, new content)
- **`SourceConnector` interface** — Contract works for HubSpot connector. Implementation is entirely new.
- **Draft generation flow** — Shape of gather-context → build-prompt → call-LLM → validate → safety-check → store. Every line inside is new.
- **Admin page structure** — Route handler → query data → render HTML with shared components. New pages, same skeleton.
- **`RepositoryBundle`** — Pattern of typed Prisma wrapper with deterministic IDs. Extend or create `SalesRepositoryBundle`.
- **`prefilterSourceItems()`** — Age/length signal filtering. Directly reusable.

### Net new (no existing code covers these)
- HubSpot connector (deal/contact/company/activity sync, associations, rate limiting)
- CRM data models (Deal, Contact, CrmCompany, Activity, ExtractedFact)
- Structured extraction from CRM activity text (7 fact categories via LLM)
- Sales signal type system (5 types, generation from different sources)
- Deal-signal matching engine with explainability
- Recommendation model and lifecycle
- Scoring, ranking, and suppression rules
- Sales doctrine schema and evaluation
- Sales draft prompts and output schema
- Recommendation feed UI
- User action tracking and analytics

### Where reuse is dangerous
- **Intelligence pipeline** — Looks structurally similar but screening criteria, decision logic, and output objects are entirely different. Do not parameterize `screenSourceItems()` for both products.
- **`Opportunity` model** — Deeply content-specific. Do not add nullable fields to make it serve as a recommendation.
- **`EditorialConfig`** — Three editorial layers have no Sales equivalent. Build a separate `SalesDoctrine` model.
- **Draft generation prompts** — The French LinkedIn ghostwriter prompt has nothing in common with a sales email prompt beyond both calling `LlmClient`.
- **Notion sync** — Content syncs to Notion; Sales syncs with HubSpot. Zero overlap.

---

## Phase 0 — Repo prep and shared substrate boundaries

**Objective:** Make it safe to add Sales code without touching or breaking Content code.

**Why now:** Without clean boundaries, Sales code will import Content-specific types and create coupling that's painful to undo later.

**What happens:**
1. Add `"hubspot"` to `SOURCE_KINDS` in `domain/types.ts`. One-line change, but do it first so the type system accepts HubSpot source items.
2. Add `HUBSPOT_ACCESS_TOKEN` (and later `HUBSPOT_PORTAL_ID`) to `AppEnv` in `config/env.ts`.
3. Create `src/sales/` directory structure: `domain/`, `services/`, `connectors/`, `admin/pages/`. Sales-specific code lives here. Shared code stays in `src/lib/`, `src/services/evidence.ts`, `src/services/llm.ts`, `src/services/observability.ts`, `src/db/`, `src/admin/layout.ts`, `src/admin/components.ts`.
4. Create `src/sales/app.ts` as a separate Sales orchestrator (do not add Sales commands to `EditorialSignalEngineApp`).
5. Create `src/sales/cli.ts` as a Sales CLI entry point.
6. Extend `admin/plugin.ts` to register Sales admin routes under `/admin/sales/` alongside Content routes under `/admin/`.

**Reused:** Shared infrastructure stays in place, imported by both products.
**Adapted:** `AppEnv` extended. `SOURCE_KINDS` widened. Admin plugin registers both product route sets.
**Built new:** `src/sales/` directory skeleton. Sales app + CLI entry points.
**Not tackled:** No schema changes yet. No HubSpot code. No Sales domain types.

**Output:** A repo where you can start adding Sales code without modifying any Content file beyond `env.ts` and `types.ts`.

**Risks / supervision needed:**
- Decide: should Sales be a separate `pnpm` script namespace (e.g., `pnpm sales:sync`, `pnpm sales:match`) or share the existing CLI? **Recommendation: separate.** Keeps the products cleanly separable.
- Decide: same database or separate? **Recommendation: same database, shared Prisma schema.** Products share `Company`, `User`, `SourceItem`. Separate databases would force data duplication.

---

## Phase 1 — Sales domain foundation

**Objective:** Define the Sales data model, domain types, and repository layer. After this phase, the database schema is ready for data to flow in.

**Why now:** Everything downstream (connectors, matching, recommendations, UI) depends on having the right models and types in place. Getting the schema right early avoids expensive rework.

**What happens:**

### 1a. Sales domain types (`src/sales/domain/types.ts`)
- `SalesSignalType`: `"feature_shipped" | "proof_created" | "deal_state_change" | "content_published" | "market_event"`
- `SalesSignal`: signal with typed metadata (signal type, source, date, confidence tier, description)
- `Recommendation`: per PRD section 11 — deal reference, signal reference, why_now, recommended_angle, recommended_next_step_type, supporting_proof, matched_context, confidence, priority_rank, status
- `RecommendationStatus`: `"new" | "viewed" | "drafted" | "dismissed" | "snoozed" | "acted" | "archived"`
- `DismissReason`: `"already_handled" | "not_relevant" | "bad_timing" | "weak_proof" | "wrong_angle"`
- `SalesDraft`: channel_type, subject (optional), body, recommendation reference
- `SalesDoctrine`: positioning rules, follow-up rules, proof hierarchy, persona guidance, exclusion rules, value thresholds, cooling-off rules
- `RepStyleProfile`: tone, length_preference, directness, language, opening_style, closing_style, signature
- `ExtractedFact`: the 7 allowed extraction categories from CRM text

### 1b. Prisma schema additions
New models (all scoped to `companyId`):
- `Deal` — name, stage, amount, closeDate, owner, pipeline, lastActivityDate, createDate, customPropertiesJson, hubspotId
- `Contact` — name, email, title, company, lifecycleStage, lastActivity, hubspotId
- `CrmCompany` — name, domain, industry, size, hubspotId
- `Activity` — type (email/note/call/meeting), body, timestamp, dealId, contactId, hubspotId
- `DealContact` — junction table
- `DealCompany` — junction table
- `SalesSignal` — signalType, title, description, sourceItemId (optional FK to shared SourceItem), dealId (optional), metadata, confidence, createdAt
- `ExtractedFact` — activityId, dealId, category (one of 7), label, confidence, sourceText snippet
- `Recommendation` — all fields per PRD section 11, with FKs to Deal, SalesSignal, Company, User
- `RecommendationEvidence` — junction table (recommendationId + evidenceId), not polymorphic
- `RecommendationAction` — recommendationId, action type, reason (for dismiss), timestamp
- `SalesDraft` — recommendationId, channelType, subject, body, profileId, confidence, createdAt
- `SalesDoctrine` — companyId, version, rulesJson, createdAt

### 1c. Sales repository (`src/sales/db/repositories.ts`)
Extend or create a `SalesRepositoryBundle` wrapping Prisma with typed methods for:
- Deal/Contact/Company/Activity upsert (idempotent by hubspotId)
- Signal creation and querying
- Recommendation CRUD and status transitions
- Suppression state queries
- ExtractedFact storage and lookup
- Doctrine versioning

**Reused:** `Company`, `User`, `SourceItem`, `SourceCursor`, `SyncRun`, `CostLedgerEntry` models. `EvidenceReference` model (linked via `RecommendationEvidence` junction). Deterministic ID generation.
**Adapted:** Prisma schema extended. `RepositoryBundle` pattern followed for Sales.
**Built new:** All Sales-specific models, types, and repository methods.
**Not tackled:** No connectors, no matching logic, no UI. Pure data layer.

**Output:** `prisma migrate dev` succeeds. Sales types compile. Repository methods exist with basic CRUD. Can write a test that creates a Deal, a Signal, and a Recommendation in the database.

**Risks / supervision needed:**
- Review the Recommendation model fields carefully against PRD section 11 before migrating. Schema changes later are costly.
- Decide: should `SalesSignal` always point to a `SourceItem`, or can some signals (like `deal_state_change` derived from staleness) exist without one? **Recommendation: make `sourceItemId` nullable.** Derived signals don't have a source item.
- Decide: should `EvidenceReference` get new nullable FKs for Sales, or should Sales use only junction tables? **Recommendation: junction tables only (`RecommendationEvidence`).** Avoids polluting the existing model.

---

## Phase 2 — Signal ingestion and CRM sync

**Objective:** Get HubSpot data into the database and start generating typed signals. After this phase, the system has deals, contacts, activities, extracted facts, and signals ready for matching.

**Why now:** You can't match signals to deals without deals and signals. This is the first phase that produces data.

### 2a. HubSpot connector (`src/sales/connectors/hubspot.ts`)
- Implements the `SourceConnector` interface pattern from `connectors/base.ts` (rate limiting, healthcheck), but may also have its own sync methods beyond the standard `fetchSince/normalize` contract, since HubSpot sync is multi-object (deals + contacts + companies + activities), not single-stream.
- Private app token auth (not OAuth in v1 — white-glove setup).
- Deal sync: fetch open deals from one pipeline, store/update in `Deal` table.
- Contact sync: fetch contacts associated with synced deals.
- Company sync: fetch companies associated with synced deals.
- Activity sync: fetch emails, notes, calls, meetings for synced deals. Store body text.
- Association resolution: build `DealContact` and `DealCompany` links.
- Incremental sync via `updatedAfter` filter + `SourceCursor`.
- Rate limiting: respect HubSpot's 100 calls/10 seconds for private apps. Use `BaseConnector` rate limiter.

### 2b. Staleness and deal-state-change signal generation
- After each HubSpot sync, scan deals for state changes:
  - No activity for N days (configurable, default 21) → `deal_state_change` signal
  - Stage regression detected → `deal_state_change` signal
  - New stakeholder added (new `DealContact` since last sync) → `deal_state_change` signal
  - Contact gone silent (no emails/notes from contact in N days) → `deal_state_change` signal
- Store as `SalesSignal` records.
- Dedup: don't re-create the same staleness signal if one already exists for this deal within the last 7 days.

### 2c. Non-CRM signal ingestion
- `feature_shipped`: Use Notion connector (adapted) to fetch from a product changelog Notion database. Normalize to `SalesSignal` with type `feature_shipped`. Also support manual entry via API endpoint.
- `proof_created`: Use Notion connector to fetch from a proof/case-study Notion database. Normalize to `SalesSignal`. Also support manual entry.
- `content_published`: Accept from Fresh Content outputs (query shared `SourceItem` table for recent Content opportunities) or manual entry.
- `market_event`: Manual entry only. Simple API endpoint: POST signal with type, title, description.

### 2d. Structured extraction from CRM activity text
- For each synced activity with body text, run LLM extraction (using `LlmClient`) to identify the 7 allowed fact categories.
- Store results as `ExtractedFact` records linked to the activity and the deal.
- Batch processing: extract on sync, not per-request.
- Confidence threshold: only store facts above a minimum confidence (e.g., 0.6).
- This is the most LLM-intensive step. Track costs via `CostLedgerEntry`.

### 2e. Sales CLI commands
- `pnpm sales:sync` — Run HubSpot sync + staleness signal generation + non-CRM signal ingestion
- `pnpm sales:extract` — Run structured extraction on unprocessed activities
- Both wrapped in `SyncRun` for observability.

**Reused:** `BaseConnector` (rate limiting), `LlmClient` (structured extraction), `SourceItem` (for non-CRM signals), `SourceCursor`, `SyncRun`/`CostLedgerEntry`, `prefilterSourceItems()`, `buildEvidenceReferences()`.
**Adapted:** Notion connector config for new database types. `AppEnv` for HubSpot credentials.
**Built new:** HubSpot connector, staleness detection, signal generation, structured extraction pipeline, manual signal entry endpoint.
**Not tackled:** No matching. No recommendations. No UI. Just data in, signals out.

**Output:** Run `pnpm sales:sync` and see deals, contacts, activities, extracted facts, and signals in the database. Run `pnpm sales:extract` and see extracted facts. Operator can verify data quality via SQL or a simple admin page.

**Risks / supervision needed:**
- HubSpot API rate limits are strict. Test against a real HubSpot portal early. Don't mock-develop in isolation for too long.
- Structured extraction quality is the biggest quality risk in the entire product. Test the extraction prompt against real CRM notes from a pilot customer before building matching on top of it. Bad extraction → bad matching → noisy recommendations.
- Decide: how aggressive should staleness detection be? A 21-day default may produce too many signals for active pipelines. Make it configurable per customer and start conservative.

---

## Phase 3 — Matching and recommendation engine

**Objective:** Given signals and deals, produce ranked, explainable, suppressed recommendations. This is the core product logic — where Fresh Sales is either useful or noisy.

**Why now:** Signals and deals exist from Phase 2. Matching is the product's core value proposition. Without good matching, draft generation and UI don't matter.

### 3a. Sales doctrine storage and loading
- `SalesDoctrine` model stores versioned JSON rules per company.
- Doctrine loaded at match time from database.
- Doctrine categories: positioning rules, follow-up rules, proof hierarchy, persona guidance, exclusion rules (deal IDs, stages, value thresholds), cooling-off rules (days since last recommendation per deal), framing rules.
- Operator-editable via admin page (Phase 4) or manual DB entry initially.
- Injected into matching, ranking, and later draft generation.

### 3b. Deal-signal matching
- For each unmatched signal, evaluate against all open deals.
- Matching dimensions:
  - Direct property match (e.g., `feature_shipped` "SSO" + deal has extracted fact "SSO blocker")
  - Tag match (manual tags on deals)
  - Industry/segment match (signal relevant to deal's company industry)
  - Staleness + value (stale high-value deals get priority)
  - Doctrine rules (e.g., "ignore deals below €5K", "don't re-engage lost deals within 60 days")
- Each match produces an **explainability string**: "Surfaced because [signal] matched [specific deal context]."
- Conservative by design: no match is better than a weak match. Minimum confidence threshold.
- Use `LlmClient` for fuzzy matching where property/tag matching is insufficient (e.g., does "SSO shipped" relate to an extracted fact "security concerns"?). But keep LLM matching as a supplement to deterministic matching, not the primary path.

### 3c. Recommendation creation
- For each valid signal-deal match, create a `Recommendation` record.
- Populate: deal fields (denormalized for feed display), signal reference, why_now, recommended_angle, recommended_next_step_type, supporting_proof (link evidence via `RecommendationEvidence`), matched_context, confidence, status="new".
- `why_now` and `recommended_angle` may be LLM-generated from the match context + doctrine.
- `recommended_next_step_type` derived from signal type and deal context (email_follow_up, linkedin_message, send_proof_asset, reactivation_call).

### 3d. Scoring and ranking
- Score each recommendation on 7 dimensions (PRD section 12.1): signal-to-deal relevance, signal freshness, proof quality, deal value, deal staleness, doctrine fit, suppression state.
- Weighted combination → `priority_rank` float.
- Weights configurable per customer via doctrine. Sensible defaults provided.
- Rank per user: recommendations ordered by priority_rank descending.

### 3e. Suppression rules
- Max 1 recommendation per deal per 7 days (configurable).
- Max 10 recommendations per user per day (configurable).
- Suppress recently dismissed deals (configurable cooldown, default 14 days).
- Suppress deals with a scheduled meeting in the next 3 days (requires activity data).
- Suppress weak recommendations when stronger ones exist for the same deal.
- Suppress near-duplicate recommendations (same signal type + same deal within window).
- Suppress low-confidence recommendations by default.
- Suppression evaluated at recommendation creation time AND at feed query time (belt and suspenders).

### 3f. Sales CLI command
- `pnpm sales:match` — Run matching + scoring + suppression on unprocessed signals. Wrapped in `SyncRun`.
- Full pipeline: `pnpm sales:sync && pnpm sales:extract && pnpm sales:match`

**Reused:** `LlmClient` (for fuzzy matching and why_now/angle generation), `buildEvidenceReferences()` / `dedupeEvidenceReferences()` / `selectPrimaryEvidence()` (for proof selection), `computeFreshnessScore()`, `SyncRun`/`CostLedgerEntry`.
**Adapted:** Evidence selection adapted for deal-signal context instead of content-opportunity context.
**Built new:** Matching engine, scoring/ranking, suppression rules, recommendation creation, doctrine loading/evaluation, `SalesSignal` → `Recommendation` pipeline.
**Not tackled:** No UI yet. No drafts. No user actions. Recommendations exist in the database only.

**Output:** Run the full pipeline and query the database to see ranked, suppressed recommendations. Each recommendation has a why_now, angle, proof, and confidence. An operator can review them via SQL.

**Risks / supervision needed:**
- **This is the phase where product quality is determined.** The matching prompt and suppression thresholds must be tuned against real customer data. Plan for at least one iteration cycle with a pilot customer.
- Matching quality depends heavily on structured extraction quality (Phase 2d). If extraction is poor, matching will be poor regardless of how good the matching logic is.
- The LLM-generated `why_now` and `recommended_angle` are critical for user trust. These must feel specific, not generic. Test against the PRD worked example (section 20) as a reference behavior test.
- Decide: should matching run for all signals against all deals (quadratic), or should signals be pre-filtered to a candidate deal set? **Recommendation: pre-filter first** (by industry, stage, tags), then LLM-evaluate the short list. Avoids cost explosion.

---

## Phase 4 — Recommendation feed and user workflow

**Objective:** Make recommendations visible and actionable through a UI. After this phase, a rep can open a feed, see recommendations, view details, dismiss, and snooze.

**Why now:** Recommendations exist in the database. The product isn't usable until someone can see and act on them.

### 4a. Recommendation feed page (`/admin/sales/feed`)
- Ranked list of recommendations for the current user (or all users for operator view).
- Each card shows: deal name, owner, stage, days inactive, triggering signal + date, short why-now, recommended angle, confidence badge, actions.
- Actions: View details, Dismiss (with reason), Snooze (7 days default).
- Filters: confidence level, signal type, deal owner.
- "No recommendations" is a valid state — show it cleanly.
- Reuse admin shell: `layout.ts`, `components.ts` (table, badge, pagination, filter bar).
- Feed query applies suppression rules at query time (re-check, not just creation-time).

### 4b. Recommendation detail view (`/admin/sales/recommendations/:id`)
- Fuller signal context (what happened, when, source).
- Supporting proof (evidence excerpts with source links).
- Matched deal context (what deal facts matched and why).
- Short deal history summary (recent activities, stage changes).
- Recommendation rationale (the full explainability chain).
- "Draft follow-up" button (wired in Phase 5).
- Reuse admin detail-section pattern from `admin/pages/opportunities.ts`.

### 4c. User action tracking
- Track: surfaced (feed loaded), viewed (detail opened), dismissed (with reason), snoozed, acted (manual confirmation).
- Store as `RecommendationAction` records.
- Status transitions: new → viewed → dismissed/snoozed/acted. Or new → viewed → drafted (in Phase 5).
- Dismiss reasons stored: already_handled, not_relevant, bad_timing, weak_proof, wrong_angle.

### 4d. Sales admin pages
- **Doctrine config** (`/admin/sales/doctrine`) — View/edit sales doctrine rules. Reuse `editorial-configs.ts` page pattern.
- **Rep profiles** (`/admin/sales/profiles`) — View/edit rep style profiles. Reuse `users.ts` page pattern.
- **HubSpot config** (`/admin/sales/config`) — View connector status, last sync, deal count. Reuse `source-configs.ts` pattern.
- **Signal review** (`/admin/sales/signals`) — List of recent signals with source, type, confidence. Operator can review signal quality.
- **Deals** (`/admin/sales/deals`) — Paginated deal list with stage, value, staleness, last activity. Operator can spot-check data quality.

### 4e. Auth model for reps vs operators
- Operators (Fresh team): access everything under `/admin/` and `/admin/sales/`.
- Reps (customer users): access `/admin/sales/feed` and `/admin/sales/recommendations/:id` only.
- v1 implementation: use the existing HTTP Basic Auth with different credentials, or a simple role check. Do not build a full auth system.

**Reused:** `admin/layout.ts`, `admin/components.ts`, `admin/plugin.ts` (auth, access control). Page structure patterns from existing admin pages.
**Adapted:** Admin plugin extended to register Sales routes. Layout nav updated to include Sales section.
**Built new:** Feed page, detail view, action tracking, admin pages for doctrine/profiles/config/signals/deals. Rep auth gating.
**Not tackled:** No draft generation yet. The "Draft follow-up" button exists but is disabled or hidden until Phase 5.

**Output:** A rep can open `/admin/sales/feed`, see ranked recommendations, click into details, dismiss with a reason, and snooze. An operator can review signals, deals, doctrine, and profiles. The product is usable for its core job (tell me which deals to follow up on and why) even without draft generation.

**Risks / supervision needed:**
- Feed performance: if a customer has 100 deals and many signals, the feed query (with suppression re-evaluation) must be fast. Profile the query early.
- The feed must feel low-noise on first use. If the first 10 recommendations include weak or irrelevant ones, trust is lost. Tune suppression thresholds with pilot data.
- "No recommendations today" must not feel like the product is broken. Design the empty state carefully.

---

## Phase 5 — Draft generation

**Objective:** When a rep clicks "Draft follow-up" on a recommendation, generate a sales email or LinkedIn message draft using the recommendation context, proof, doctrine, and rep style.

**Why now:** The core product (recommendations) works. Draft generation adds convenience but is not the primary value.

### 5a. Sales draft prompt chain (`src/sales/services/drafts.ts`)
- New file, not a modification of `services/drafts.ts` (Content's LinkedIn ghostwriter).
- Same *shape* as Content drafts: gather context → build prompt sections → call `LlmClient` → validate with Zod → safety check → store.
- System prompt: professional sales follow-up writer. Not a ghostwriter. Not a LinkedIn content creator.
- Prompt inputs: signal, deal context, matched context (extracted facts, tags), supporting proof (evidence excerpts), doctrine (positioning rules, framing rules), rep style profile.
- Output schema (Zod-validated):
  - `channelType`: `"email"` | `"linkedin_message"`
  - `subject`: string (email only)
  - `body`: string
  - `confidenceScore`: number
- Hard rules: never generic "checking in", always reference the specific signal, always ground in proof, respect doctrine framing rules, match rep style.
- Safety check: ensure no confidential CRM data leaks into the draft (adapted from Content's `assessDraftSensitivity` pattern).

### 5b. Draft-on-demand API
- `POST /v1/sales/companies/:companyId/recommendations/:recommendationId/draft`
- Returns `{ status, recommendationId, draftId, draft }`.
- Updates recommendation status to `"drafted"`.
- Stores `SalesDraft` record.

### 5c. Draft display in UI
- Recommendation detail view shows draft when available.
- Copy-to-clipboard button.
- "Regenerate" button (creates new draft, keeps old).
- No edit-in-place in v1 (rep copies to their email client).

### 5d. Rep style profiles for Sales
- Different field set from Content profiles: tone, length_preference, directness, language, opening_style, closing_style, signature_conventions.
- Loaded from `User.baseProfile` JSON (same column, different schema).
- Set up during white-glove onboarding. Optionally from 3-5 example emails provided by the rep.

**Reused:** `LlmClient` (as-is), `scopeEvidenceReferences()`, `createDeterministicId()`, `SyncRun`/`CostLedgerEntry` for cost tracking.
**Adapted:** Draft generation *flow* (shape reused, content entirely new). Safety check *pattern* (regex + LLM, but different rules). Rep profile *storage* (same column, different schema).
**Built new:** Sales draft prompt, output schema, draft API endpoint, draft UI display.
**Not tackled:** No export to HubSpot. No email sending. No template management.

**Output:** Rep clicks "Draft follow-up" on a recommendation, gets a contextual email or LinkedIn message draft within seconds. Draft references the specific signal and proof, matches rep's tone, respects doctrine. Rep copies it to their email client.

**Risks / supervision needed:**
- Draft quality is the most visible quality surface. Test against the PRD worked example (section 20.6) before shipping.
- Drafts that sound generic will erode trust in the entire product. The prompt must force specificity (mention the signal, mention the proof, mention the deal context).
- Cost: draft generation uses LLM tokens. Track cost per draft via `CostLedgerEntry`. Alert if cost spikes.

---

## Phase 6 — Analytics and operational visibility

**Objective:** Track the recommendation funnel so we can measure product value and identify quality issues.

**Why now:** The product is functional. We need to measure whether it's working.

### 6a. Analytics event storage
- `AnalyticsEvent` model or extend `RecommendationAction` to cover all funnel steps.
- Track per PRD section 18.1: surfaced, opened, detail viewed, drafted, exported/copied, dismissed (with reason), snoozed, acted (confirmed).
- Each event timestamped and linked to recommendation + user.

### 6b. Analytics dashboard (`/admin/sales/analytics`)
- Funnel breakdown: surfaced → opened → detail viewed → drafted → acted.
- Dismissal reason distribution.
- Recommendations per user per week.
- Confidence distribution of surfaced recommendations.
- Signal type distribution.
- Top deals by recommendation count (potential noise indicator).
- Reuse `dashboard.ts` stat-card pattern.

### 6c. Operational monitoring
- Run history (`/admin/sales/runs`) — reuse `runs.ts` page pattern. Shows sync, extract, match runs with counters and cost.
- Signal quality indicators: what % of signals lead to recommendations? What % of recommendations are dismissed as "not relevant"?
- Cost tracking: LLM spend per run type, per step.

**Reused:** `SyncRun`/`CostLedgerEntry` (as-is), `admin/pages/runs.ts` (pattern), dashboard stat-card pattern.
**Built new:** Analytics event tracking, analytics dashboard, sales-specific operational metrics.
**Not tackled:** No adaptive learning from dismiss feedback. No manager dashboards. No team analytics.

**Output:** Operator can see funnel metrics, identify noisy signals or weak matching, and track cost.

---

## Later, not now

These are explicitly out of scope for the initial build. They are real features but should wait until v1 is validated with real users.

| Feature | Why not now |
|---------|------------|
| **HubSpot webhooks** | Polling every 15-30 min is sufficient for v1. Webhooks add infrastructure complexity (persistent server, webhook validation, retry handling) for marginal latency improvement. |
| **HubSpot write-back** (create task, log note) | Conservative by default. Add only after users confirm they want CRM write-back. Risk of CRM clutter. |
| **Self-serve onboarding** | v1 is white-glove. Building onboarding flows before validating the product wastes effort. |
| **Content↔Sales signal sharing** | Technically straightforward (shared `SourceItem` table), but adds coupling. Wire it after both products are stable independently. |
| **Feed-time re-ranking** | Matching at sync time + suppression at query time is sufficient for v1. Real-time re-ranking adds complexity with diminishing returns. |
| **Adaptive learning from dismiss feedback** | Store the data now, learn from it later. Premature adaptation risks feedback loops. |
| **Manager dashboards / team analytics** | v1 user is founder-seller, not a sales manager. Add when the user base demands it. |
| **Multi-pipeline support** | v1 supports one pipeline per workspace. Multi-pipeline is a real need but adds significant complexity. |
| **Slack digests** | Nice-to-have notification channel. Not core product. |
| **HubSpot sidebar app** | Requires HubSpot app marketplace listing. Substantial independent effort. |

---

## Implementation guardrails

These rules apply throughout implementation:

1. **Do not bend Content abstractions to fit Sales.** If you find yourself adding nullable fields to `Opportunity`, optional parameters to `screenSourceItems()`, or "mode" switches to `generateDraft()` — stop. Create a Sales-specific version instead.

2. **Do not over-abstract too early.** Do not create a `ProductPipeline` base class, a `GenericRecommendation` interface, or a "unified signal processing framework." Build Sales concretely first. Abstract only if a third product emerges.

3. **Do not make draft generation the center of the product.** The product is valuable when it correctly identifies which deals deserve follow-up and why. Drafts are a convenience layer. If matching is bad, perfect drafts won't save it.

4. **Do not broaden signal scope beyond the 5 defined types.** No call transcript analysis, no intent signals, no product usage, no social monitoring. Scope discipline is what prevents the product from becoming a noisy generic "AI for sales" tool.

5. **Do not create noisy recommendation flows.** When in doubt, suppress. A feed with 3 strong recommendations is better than a feed with 15 mixed ones. "No recommendations today" is a valid and desirable state.

6. **Do not auto-send anything.** No email sending, no HubSpot task creation, no Slack message — unless the user explicitly clicks a button for that specific action.

7. **Do not build for multi-tenant self-serve.** v1 is one customer at a time, manually onboarded. Do not add tenant isolation, usage metering, billing, or onboarding wizards.

8. **Do not make LLM matching the primary matching path.** Use deterministic matching (property match, tag match, extracted fact match) first. Use LLM only to evaluate ambiguous candidates. This controls cost and improves explainability.

9. **Do not skip the structured extraction quality check.** Extraction quality determines matching quality determines product quality. Validate extraction against real CRM notes before building matching on top of it.

10. **Keep Content working.** Every PR should pass `pnpm test` and `pnpm run typecheck` for the whole repo. Sales additions must not break Content's intelligence pipeline, Notion sync, or admin UI.

---

## Key open decisions to supervise

These require human judgment before or during implementation:

1. **Pilot customer selection.** The first customer's HubSpot data will shape extraction prompts, matching thresholds, and suppression defaults. Choose a customer with a clean-enough pipeline (30-100 open deals, some activity history, ideally some custom properties).

2. **Structured extraction scope.** The PRD allows 7 extraction categories. Start with the 3 highest-value ones (objection mentioned, requested capability, competitor reference) and add the rest incrementally. Trying to extract all 7 at once risks quality dilution.

3. **Matching confidence threshold.** What score threshold separates "surface this" from "suppress this"? This will need tuning with real data. Start conservative (surface only high confidence), then loosen if the feed is too sparse.

4. **Staleness thresholds.** 21 days no-activity is the PRD default, but the right number varies by sales cycle length. Make it per-customer configurable from day one.

5. **Rep vs operator auth.** v1 can ship with shared HTTP Basic Auth and a role flag. But decide early whether reps should have their own credentials or share an operator account. Affects what analytics data is meaningful.

6. **Same repo vs monorepo.** The roadmap assumes same repo (shared Prisma schema, shared `lib/`). If deployment concerns arise (e.g., wanting to deploy Sales independently), this may need to change. Decide before Phase 2.

---

## Final recommendation

**Build it.** The repo provides real infrastructure leverage, the product concept is clear, and the PRD is well-scoped. The main risk is not technical — it's matching quality. The system is only as good as its ability to connect the right signal to the right deal with the right explanation.

Sequence the work so you can test matching quality early (end of Phase 3) before investing in UI polish and draft generation. If matching works against real customer data, the rest is execution. If matching doesn't work, no amount of UI or draft quality will compensate.

Start with Phase 0-1 (1-2 days of setup), move quickly through Phase 2 (HubSpot sync is the longest single piece — plan for 3-5 days including extraction), then spend the most care on Phase 3 (matching — plan for 3-5 days plus tuning). Phase 4-5 are the most predictable (UI and drafts follow known patterns). Phase 6 can overlap with pilot customer validation.

Target: a working recommendation feed against a real customer's HubSpot data within 2-3 weeks of starting implementation.
