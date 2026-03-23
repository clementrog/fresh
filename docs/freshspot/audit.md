⏺ The reuse audit is complete. It covers all 12 sections you requested with concrete file-level references throughout. Key findings:

  - ~20% direct code reuse (LlmClient, evidence layer, admin shell, observability, connectors/base, lib utilities)
  - ~20% pattern reuse (connector interface, draft generation flow, repository pattern, admin page structure)
  - ~60% net new (HubSpot connector, deal/contact models, structured CRM extraction, deal-signal matching, scoring/ranking, suppression rules, recommendation model, sales draft prompts, analytics)

  The biggest risks are the intelligence pipeline and draft generation — they look structurally similar but every line of content inside them is editorial-specific and must be rewritten for Sales.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Ready to code?

 Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Fresh Sales Reuse Audit

 Executive summary

 Fresh Content is a strong but not free substrate for Fresh Sales. The two products share genuine architectural DNA: signal ingestion, normalization, evidence storage, doctrine-driven filtering,
 profile-aware draft generation, and an admin/review UI shell. Roughly 40-50% of the codebase carries reusable patterns, but only ~20% is reusable code without meaningful modification.

 Real leverage:
 - The SourceConnector interface, NormalizedSourceItem type, and cursor-based ingestion loop are directly reusable for non-HubSpot signal sources (Notion changelogs, proof databases, manual market events).
 - The EvidenceReference model and evidence-building/dedup/freshness pipeline generalize well to sales proof.
 - The LlmClient with structured output, Zod validation, cost tracking, and fallback handling is product-agnostic.
 - The admin UI shell (layout, components, pagination, badges, tables, filter bars) is directly reusable.
 - The RepositoryBundle pattern and deterministic ID system are product-agnostic.
 - The SyncRun/CostLedgerEntry observability layer works as-is.

 Where reuse will disappoint:
 - The Opportunity model is deeply content-specific (angle, whatItIsAbout/NotAbout, suggestedFormat, narrativePillar, readiness tiers). The Sales Recommendation object has a fundamentally different shape.
 - The intelligence pipeline (screenSourceItems, decideCreateOrEnrich) is tightly coupled to editorial screening logic. Sales needs deal-signal matching, not "is this a content opportunity?" screening.
 - Draft generation prompts are hardcoded for French LinkedIn ghostwriting. The entire system prompt, safety checks, and output schema must be rebuilt for sales emails/LinkedIn DMs.
 - The EditorialConfig three-layer doctrine model (Company Lens / Content Philosophy / LinkedIn Craft) is editorial-specific. Sales doctrine has different concerns (positioning rules, proof hierarchy,
 cooling-off rules, exclusion rules).
 - There is no concept of "deal", "contact", "company" (CRM sense), "activity", "staleness", "suppression", or "recommendation status" in the current codebase.
 - The Notion-centric sync (syncing opportunities to Notion databases, reading selections from Notion) is irrelevant for Sales.

 Bottom line: Build Fresh Sales as a sibling product in the same repo, sharing infrastructure utilities and the connector/evidence/LLM layers, but with its own domain types, matching engine, recommendation
 model, doctrine schema, draft prompts, and UI pages. Do not attempt to make the current Opportunity model serve both products.

 ---
 Repo map

 Directory structure

 fresh/
   src/
     admin/          # Server-rendered HTML admin UI
       pages/        # 10 route handlers (dashboard, source-items, opportunities, drafts, runs, reviews, users, configs, queries)
       plugin.ts     # Fastify plugin registration, auth, access control
       queries.ts    # AdminQueries class (filters, pagination, disposition logic)
       layout.ts     # HTML master template + CSS
       components.ts # Reusable HTML generators (table, badge, pagination, filter forms)
     config/         # Configuration loading + validation
       env.ts        # AppEnv interface
       loaders.ts    # Load connector configs, doctrine markdown, profiles from files
       schema.ts     # Zod schemas for LLM outputs, configs
     connectors/     # Source connector implementations
       base.ts       # BaseConnector abstract class (rate limiting, backoff)
       index.ts      # createConnectorRegistry() factory
       notion.ts     # Notion connector (databases, pages, market insights, proofs)
       claap.ts      # Claap connector (call recordings + LLM signal extraction)
       linear.ts     # Linear connector (issues, project updates)
       market-findings.ts  # Markdown file connector
     db/
       client.ts     # Prisma singleton
       repositories.ts  # RepositoryBundle class (CRUD, upsert, cursor tracking)
     domain/
       types.ts      # All TypeScript interfaces and union types
     lib/
       ids.ts        # Deterministic UUID generation, hashing
       logger.ts     # Pino logger
       errors.ts     # NotFoundError, ForbiddenError, UnprocessableError
       profile-hints.ts  # User profile matching helpers
     services/
       intelligence.ts   # Screening, create/enrich decisions, Linear classification
       evidence.ts       # Evidence building, dedup, freshness scoring, selection
       evidence-pack.ts  # Supporting evidence search (Jaccard), readiness assessment, provenance
       drafts.ts         # Draft generation (French LinkedIn ghostwriter prompt chain)
       llm.ts            # LlmClient (Anthropic + OpenAI, structured output, cost tracking)
       sensitivity.ts    # Two-stage sensitivity assessment (regex + LLM)
       notion.ts         # NotionService (sync opportunities/reviews to Notion DBs)
       market-research.ts # Tavily web search + LLM summarization
       convergence.ts    # Foundation setup (company, users, configs bootstrap)
       retention.ts      # Raw text expiry computation
       observability.ts  # SyncRun creation, cost entries, spike warnings
     app.ts          # EditorialSignalEngineApp orchestrator class
     cli.ts          # CLI entry point (flag parsing, command dispatch)
     server.ts       # Fastify HTTP server (admin plugin + draft API endpoint)
   prisma/
     schema.prisma   # 14 models (see data model section)
     migrations/     # 6 migration folders
   editorial/
     doctrine.md     # Linc editorial compass
     sensitivity-rules.md  # 6 sensitivity categories
     profiles/       # 5 user voice profiles (baptiste, thomas, virginie, quentin, linc-corporate)
   config/
     sources/        # Connector config JSON files
   tests/            # Unit + integration tests
   docs/             # Documentation

 Where things live

 ┌──────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────┐
 │           Concern            │                                           Location                                           │
 ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────┤
 │ Ingestion                    │ src/connectors/*.ts + app.ts:ingestRun()                                                     │
 ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────┤
 │ Normalization / event typing │ NormalizedSourceItem in domain/types.ts + each connector's normalize()                       │
 ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────┤
 │ Doctrine / rules             │ editorial/doctrine.md + config/loaders.ts:loadDoctrineMarkdown() + injected into LLM prompts │
 ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────┤
 │ Evidence / proof storage     │ services/evidence.ts + services/evidence-pack.ts + EvidenceReference model                   │
 ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────┤
 │ User / style profiles        │ editorial/profiles/*.md + services/convergence.ts + User.baseProfile JSON                    │
 ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────┤
 │ Queues / feeds / UI          │ src/admin/pages/*.ts + admin/queries.ts                                                      │
 ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────┤
 │ Draft generation             │ services/drafts.ts + services/llm.ts                                                         │
 ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────┤
 │ Background jobs / workflows  │ CLI-driven via app.ts:run() — no persistent queue or scheduler                               │
 ├──────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────┤
 │ Persistence models           │ prisma/schema.prisma (14 models)                                                             │
 └──────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────┘

 ---
 Reuse inventory

 ┌───────────────────────────────────────────────┬──────────────────────────────────────┬───────────┬─────────┬────────────────────────────────────────────────────────┬──────────────────────────────────┐
 │                Fresh component                │           Current purpose            │ Reuse for │ Reuse   │                          Why                           │    What would need to change     │
 │                                               │                                      │   Sales?  │  level  │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ SourceConnector interface                     │ Defines connector contract:          │           │         │                                                        │ Add "hubspot" to SourceKind      │
 │ (domain/types.ts:420-427)                     │ fetchSince, normalize, backfill,     │ Yes       │ High    │ Generic ingestion contract works for any source type   │ union                            │
 │                                               │ cleanup                              │           │         │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ BaseConnector (connectors/base.ts)            │ Rate limiting, healthcheck, backoff  │ Yes       │ High    │ Product-agnostic infrastructure                        │ Nothing                          │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ NormalizedSourceItem                          │                                      │           │         │ Shape works for non-CRM signals; CRM signals need      │ May need a SalesSignal extension │
 │ (domain/types.ts:124-141)                     │ Common normalized signal shape       │ Partial   │ Medium  │ richer structure (deal context, contact, structured    │  or separate typed signal        │
 │                                               │                                      │           │         │ facts)                                                 │ alongside                        │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ createConnectorRegistry()                     │                                      │           │         │ Pattern is reusable, but Sales needs different         │ Add HubSpot connector, retain    │
 │ (connectors/index.ts)                         │ Factory for source connectors        │ Partial   │ Medium  │ connector set                                          │ Notion connector for             │
 │                                               │                                      │           │         │                                                        │ proof/changelog sources          │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │                                               │                                      │           │         │ Reusable for feature_shipped and proof_created signal  │ Need new Notion DB configs for   │
 │ NotionConnector (connectors/notion.ts)        │ Fetches from Notion databases/pages  │ Partial   │ Medium  │ sources from Notion                                    │ product changelog and proof      │
 │                                               │                                      │           │         │                                                        │ databases                        │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ ClaapConnector (connectors/claap.ts)          │ Call recording signal extraction     │ No        │ —       │ Not in Sales v1.2 scope (call transcript intelligence  │ —                                │
 │                                               │                                      │           │         │ excluded)                                              │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ LinearConnector (connectors/linear.ts)        │ Linear issue/update ingestion        │ No        │ —       │ Not a Sales signal source                              │ —                                │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ MarketFindingsConnector                       │ Markdown file ingestion              │ Partial   │ Low     │ Could serve market_event manual entry if               │ Likely replaced by form-based    │
 │ (connectors/market-findings.ts)               │                                      │           │         │ Markdown-based                                         │ entry in Sales                   │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ EvidenceReference type + model                │ Extracted text excerpts with         │           │         │                                                        │ May need additional fields       │
 │ (domain/types.ts:143-153,                     │ freshness scoring                    │ Yes       │ High    │ Evidence/proof concept is central to both products     │ (proof_type, label) for Sales    │
 │ prisma/schema.prisma:60-85)                   │                                      │           │         │                                                        │ proof hierarchy                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ buildEvidenceReferences()                     │ Split source text into excerpts,     │ Yes       │ High    │ Same pattern needed for sales proof extraction         │ Minor: may want configurable     │
 │ (services/evidence.ts)                        │ hash, score freshness                │           │         │                                                        │ excerpt count/length             │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ dedupeEvidenceReferences()                    │ Remove duplicate excerpts            │ Yes       │ High    │ Same need in Sales                                     │ Nothing                          │
 │ (services/evidence.ts)                        │                                      │           │         │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ computeFreshnessScore()                       │ Time-decay score (1.0 today → 0.0 at │ Yes       │ High    │ Signal freshness is a Sales ranking dimension too      │ May want configurable decay      │
 │ (services/evidence.ts)                        │  30 days)                            │           │         │                                                        │ window                           │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ selectPrimaryEvidence()                       │ Pick strongest evidence piece        │ Yes       │ High    │ Same pattern for recommendation proof selection        │ Nothing                          │
 │ (services/evidence.ts)                        │                                      │           │         │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ findSupportingEvidence()                      │ Jaccard similarity matching between  │           │         │ Pattern is reusable but matching logic must change for │ Needs deal-aware matching        │
 │ (services/evidence-pack.ts)                   │ opportunity and candidate items      │ Partial   │ Medium  │  deal-signal matching                                  │ instead of content-aware         │
 │                                               │                                      │           │         │                                                        │ matching                         │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │                                               │ Multi-provider structured LLM output │           │         │                                                        │                                  │
 │ LlmClient (services/llm.ts)                   │  with Zod validation, cost tracking, │ Yes       │ High    │ Completely product-agnostic                            │ Nothing                          │
 │                                               │  fallback                            │           │         │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │                                               │                                      │           │         │ Only the shape is reusable (gather context → build     │ Complete rewrite of prompt,      │
 │ generateDraft() (services/drafts.ts)          │ LinkedIn post generation via French  │ Partial   │ Low     │ prompt → validate output → safety check). The actual   │ output schema, and safety checks │
 │                                               │ ghostwriter prompt                   │           │         │ prompt, schema, output fields, and safety rules are    │  for sales emails/LinkedIn DMs   │
 │                                               │                                      │           │         │ 100% content-specific                                  │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ assessDraftSensitivity()                      │ Two-stage draft safety check         │ Partial   │ Medium  │ Pattern of regex hardblock + LLM check is reusable     │ Different patterns and LLM       │
 │ (services/drafts.ts:190-232)                  │                                      │           │         │                                                        │ prompt for sales context         │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ screenSourceItems()                           │ LLM-based batch relevance screening  │ Partial   │ Low     │ Pattern of batch LLM screening reusable, but screening │ Must be replaced with            │
 │ (services/intelligence.ts:55-100+)            │                                      │           │         │  criteria are entirely editorial                       │ deal-signal matching logic       │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ prefilterSourceItems()                        │ Age + length filters                 │ Yes       │ High    │ Same need for signal freshness filtering               │ Minor: configurable window       │
 │ (services/intelligence.ts:28-51)              │                                      │           │         │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ EditorialConfig model                         │ 3-layer editorial config (Company    │           │         │                                                        │ Sales needs its own doctrine     │
 │ (prisma/schema.prisma:246-258)                │ Lens / Content Philosophy / LinkedIn │ No        │ —       │ Layers are editorial-specific                          │ schema                           │
 │                                               │  Craft)                              │           │         │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ Opportunity model                             │ Content opportunity (title, angle,   │           │         │                                                        │ Sales needs a Recommendation     │
 │ (prisma/schema.prisma:99-136)                 │ whyNow, whatItIsAbout/NotAbout,      │ No        │ —       │ Shape is deeply content-specific                       │ model with different fields      │
 │                                               │ suggestedFormat)                     │           │         │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │                                               │                                      │           │         │ Model exists but fields are content-specific (hook,    │ Sales draft model needs          │
 │ Draft model (prisma/schema.prisma:153-172)    │ LinkedIn post draft                  │ Partial   │ Low     │ visualIdea, whatItIsAbout)                             │ different fields (subject, body, │
 │                                               │                                      │           │         │                                                        │  channel type)                   │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ Company model (prisma/schema.prisma:209-228)  │ Multi-tenant root                    │ Yes       │ High    │ Same isolation model needed                            │ Add Sales-specific relations     │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │                                               │                                      │           │         │                                                        │ baseProfile JSON needs           │
 │ User model (prisma/schema.prisma:230-244)     │ Team member with base profile        │ Partial   │ High    │ Model works for Sales reps                             │ sales-specific fields (rep       │
 │                                               │                                      │           │         │                                                        │ style, not content territories)  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ SourceItem model (prisma/schema.prisma:23-58) │ Ingested raw signal                  │ Yes       │ High    │ Same storage pattern for normalized signals            │ May need additional indexes for  │
 │                                               │                                      │           │         │                                                        │ Sales queries                    │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ SyncRun + CostLedgerEntry                     │ Run tracking and LLM cost audit      │ Yes       │ High    │ Product-agnostic observability                         │ Add Sales run types              │
 │ (prisma/schema.prisma:174-207)                │                                      │           │         │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ SourceCursor model                            │ Cursor tracking per source per       │ Yes       │ High    │ Same need for HubSpot sync cursor                      │ Nothing                          │
 │ (prisma/schema.prisma:10-21)                  │ company                              │           │         │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ RepositoryBundle (db/repositories.ts)         │ Data access layer wrapping Prisma    │ Partial   │ High    │ Pattern is great; many methods are content-specific    │ Add Sales-specific repository    │
 │                                               │                                      │           │         │                                                        │ methods                          │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ createDeterministicId() (lib/ids.ts)          │ UUID generation from composite keys  │ Yes       │ High    │ Same dedup need                                        │ Nothing                          │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ hashParts() / hashText() (lib/ids.ts)         │ Content fingerprinting               │ Yes       │ High    │ Same dedup need                                        │ Nothing                          │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ Admin layout + components (admin/layout.ts,   │ HTML template, table, badge,         │ Yes       │ High    │ Product-agnostic UI primitives                         │ Minor: branding ("Fresh Sales"   │
 │ admin/components.ts)                          │ pagination, filter bar, stat cards   │           │         │                                                        │ vs "Fresh Admin"), nav links     │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ Admin plugin (admin/plugin.ts)                │ Fastify route registration, auth,    │ Yes       │ High    │ Same auth/access pattern                               │ Add Sales routes alongside       │
 │                                               │ access control                       │           │         │                                                        │ Content routes                   │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ Admin pages (admin/pages/*.ts)                │ Content-specific list/detail views   │ Partial   │ Medium  │ Pattern is reusable, actual page content is not        │ New pages for recommendations,   │
 │                                               │                                      │           │         │                                                        │ deals, analytics                 │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ NotionService (services/notion.ts)            │ Sync to Notion databases             │ No        │ —       │ Sales doesn't sync to Notion; it syncs with HubSpot    │ —                                │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ parseSensitivityRules()                       │ Markdown → structured sensitivity    │ Partial   │ Medium  │ Pattern reusable; rules are content-specific           │ Different rules for sales        │
 │ (services/sensitivity.ts)                     │ rules                                │           │         │                                                        │ context                          │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ observability.ts (services/observability.ts)  │ createRun, finalizeRun,              │ Yes       │ High    │ Product-agnostic                                       │ Nothing                          │
 │                                               │ createCostEntry, buildSpikeWarnings  │           │         │                                                        │                                  │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ loadEnv() / AppEnv (config/env.ts)            │ Environment variable loading         │ Partial   │ High    │ Same pattern; needs additional env vars                │ Add HUBSPOT_API_KEY,             │
 │                                               │                                      │           │         │                                                        │ Sales-specific configs           │
 ├───────────────────────────────────────────────┼──────────────────────────────────────┼───────────┼─────────┼────────────────────────────────────────────────────────┼──────────────────────────────────┤
 │ Zod schemas (config/schema.ts)                │ LLM output validation                │ Partial   │ Low     │ Schemas are content-specific; pattern of Zod           │ New schemas for Sales LLM        │
 │                                               │                                      │           │         │ validation is reusable                                 │ outputs                          │
 └───────────────────────────────────────────────┴──────────────────────────────────────┴───────────┴─────────┴────────────────────────────────────────────────────────┴──────────────────────────────────┘

 ---
 Direct duplication candidates

 These can be copied with minimal or no change:

 1. LlmClient (services/llm.ts) — Multi-provider structured output with cost tracking. Completely product-agnostic. Zero changes needed.
 2. lib/ids.ts — Deterministic ID generation and hashing. Zero changes needed.
 3. lib/errors.ts — Custom error classes (NotFoundError, ForbiddenError, UnprocessableError). Zero changes.
 4. lib/logger.ts — Pino logger. Zero changes.
 5. services/observability.ts — SyncRun/CostLedgerEntry management. Zero changes.
 6. services/retention.ts — Raw text expiry computation. Zero changes.
 7. admin/layout.ts + admin/components.ts — HTML template, table, badge, pagination, filter bar, stat cards. Only change: branding and nav links.
 8. admin/plugin.ts — Fastify plugin with auth, access control. Only change: register Sales routes.
 9. connectors/base.ts — BaseConnector with rate limiting. Zero changes.
 10. db/client.ts — Prisma singleton. Zero changes.
 11. Evidence core (services/evidence.ts) — buildEvidenceReferences(), dedupeEvidenceReferences(), computeFreshnessScore(), selectPrimaryEvidence(), scopeEvidenceReferences(). All reusable with minimal
 changes.
 12. prefilterSourceItems() (services/intelligence.ts:28-51) — Age/length filter. Zero changes.
 13. SyncRun, CostLedgerEntry, SourceCursor, Company, SourceItem Prisma models — all reusable.

 ---
 Adaptation candidates

 1. SourceConnector interface + createConnectorRegistry()

 - Reusable: The interface contract (fetchSince, normalize, backfill, cleanup) and the registry factory pattern.
 - Sales-specific change: Add "hubspot" to SourceKind union. Create HubSpotConnector implementing the interface. Retain NotionConnector for proof/changelog sources. Drop Claap/Linear.
 - Difficulty: Simple (type extension + new connector implementation).

 2. NormalizedSourceItem type

 - Reusable: Base fields (source, externalId, title, text, summary, occurredAt, metadata).
 - Sales-specific change: HubSpot signals carry richer typed metadata (deal properties, contact info, structured extraction results). Either use the metadata JSON bag for this or create a typed
 SalesSignalMetadata extension.
 - Difficulty: Simple (metadata convention, no structural change to the base type).

 3. NotionConnector (connectors/notion.ts)

 - Reusable: API client, pagination, block content extraction.
 - Sales-specific change: Different database configurations for product changelogs (feature_shipped) and proof databases (proof_created). Different normalization logic for these new Notion content types.
 - Difficulty: Moderate (new Notion DB schemas and normalization paths, but existing API patterns reuse well).

 4. findSupportingEvidence() (services/evidence-pack.ts)

 - Reusable: Jaccard similarity scoring, source policy pattern, dedup, top-N selection.
 - Sales-specific change: Matching signals to deals instead of matching sources to opportunities. Needs deal context (extracted objections, tags, industry, stage) as matching input instead of content
 title/angle.
 - Difficulty: Moderate (same algorithm shape, different matching dimensions).

 5. User model + profile loading

 - Reusable: Model structure, baseProfile JSON column, profile-from-markdown loading.
 - Sales-specific change: Sales rep profiles have different fields (tone, length preference, directness, language, opening/closing style, signature). Not content territories or typical LinkedIn phrases.
 - Difficulty: Simple (different JSON shape in baseProfile, different markdown frontmatter).

 6. EditorialConfig → Sales Doctrine Config

 - Reusable: Versioned config model pattern with JSON layers.
 - Sales-specific change: Replace 3 editorial layers with sales-specific doctrine: positioning rules, follow-up rules, proof hierarchy, persona guidance, exclusion rules, value thresholds, cooling-off rules.
  Completely different schema.
 - Difficulty: Moderate (same storage pattern, entirely different content).

 7. Draft generation flow

 - Reusable: The shape: gather context → build prompt sections → call LlmClient → validate with Zod → safety check → store.
 - Sales-specific change: Entirely different system prompt (sales email/LinkedIn DM, not French LinkedIn ghostwriting). Different output schema (subject, body, channel — not hook, visualIdea,
 firstDraftText). Different safety rules. Different input context (deal, signal, proof, doctrine, rep style — not opportunity, evidence, enrichment history).
 - Difficulty: Deep (same 6-step flow, but every step's content is different).

 8. Admin pages

 - Reusable: Page structure pattern (route handler → query data → render HTML with components).
 - Sales-specific change: New pages: recommendation feed, deal view, analytics dashboard, doctrine config, signal review. Existing Content pages remain for Content.
 - Difficulty: Moderate (same patterns, new implementations).

 9. RepositoryBundle

 - Reusable: Pattern of wrapping Prisma with typed methods, transaction support, deterministic IDs.
 - Sales-specific change: Add methods for Recommendation CRUD, deal sync, suppression state, analytics queries.
 - Difficulty: Simple (extend the class or create a SalesRepositoryBundle).

 ---
 Net new requirements

 These must be built from scratch — no existing code covers them:

 1. HubSpot connector (src/connectors/hubspot.ts)

 - OAuth2 token management (or private app token)
 - Deal sync (initial + incremental via updatedAfter filter or webhook)
 - Contact sync with deal associations
 - Company sync with deal associations
 - Activity sync (emails, notes, calls, meetings) with body text
 - Pipeline and stage metadata sync
 - Association resolution (deal↔contact, deal↔company, deal↔owner)
 - Webhook receiver for real-time change detection (optional, polling fallback)
 - Rate limiting per HubSpot API limits (100 calls/10s for private apps)

 2. Deal / Contact / Company / Activity models

 - Prisma models for Deal, Contact, CrmCompany, Activity, DealContact, DealCompany
 - Fields per PRD section 6.1 (deal: name, stage, amount, closeDate, owner, pipeline, lastActivityDate, etc.)
 - Association junction tables
 - Custom property storage (JSON column for customer-specific fields)

 3. Structured extraction from CRM activity text

 - LLM-based extraction for the 7 allowed categories: objection mentioned, requested capability, competitor reference, urgency/timing signal, budget sensitivity, persona/stakeholder type, compliance/security
  requirement
 - ExtractedFact model to store extracted structured data linked to activities/deals
 - Extraction pipeline (batch or per-activity)
 - Confidence scoring per extracted fact

 4. Signal type system for Sales

 - 5 typed signals: feature_shipped, proof_created, deal_state_change, content_published, market_event
 - Signal creation from different sources:
   - deal_state_change: derived from HubSpot deal/activity changes (staleness, stage regression, stakeholder addition, contact silence)
   - feature_shipped: from Notion changelog or manual entry
   - proof_created: from Notion proof DB or manual entry
   - content_published: from Fresh Content outputs or manual entry
   - market_event: manual entry only
 - Signal confidence hierarchy per PRD section 5.2

 5. Deal-signal matching engine

 - Match signals to open deals using: deal properties, contact properties, company properties, explicit tags, stage, inactivity/staleness, extracted structured facts, doctrine rules
 - Explainability: each match must produce a human-readable reason string
 - Conservative matching: prefer missing weak opportunities over surfacing weak recommendations
 - Batch or event-driven execution

 6. Recommendation object + model

 - Full Recommendation model per PRD section 11 (recommendation_id, deal fields, signal fields, why_now, recommended_angle, recommended_next_step_type, supporting_proof, matched_context, confidence,
 priority_rank, status)
 - Status lifecycle: new → viewed → drafted → dismissed/snoozed/acted → archived
 - Priority ranking computation

 7. Scoring + ranking engine

 - Weighted scoring across 7 dimensions (PRD section 12.1): signal-to-deal relevance, signal freshness, proof quality, deal value, deal staleness, doctrine fit, suppression state
 - Configurable weights
 - Ranking output: ordered list of recommendations per user

 8. Suppression / anti-noise rules

 - Max 1 recommendation per deal per 7 days
 - Max 10 recommendations per user per day
 - Suppress recently dismissed deals
 - Suppress deals with imminent scheduled meetings
 - Suppress weak when stronger exist
 - Suppress near-duplicate recommendations
 - Suppress low-confidence by default
 - Dismiss feedback storage with reason categories

 9. Staleness scoring

 - Compute days_since_activity for each deal
 - Detect: no activity for N days, stage regression, stakeholder added, contact silent
 - These become deal_state_change signals

 10. Sales doctrine schema

 - Positioning rules, follow-up rules, proof hierarchy, persona guidance, exclusion rules, value thresholds, cooling-off rules, framing rules
 - Stored as versioned config (reuse EditorialConfig storage pattern but different schema)
 - Injected into matching, ranking, and draft generation

 11. Sales draft generation

 - Email draft and LinkedIn message draft output types
 - Prompt chain using: signal, deal context, matched context, supporting proof, doctrine, rep style profile
 - Output: subject line + body (email) or message body (LinkedIn)
 - On-demand only (not pre-generated)

 12. Recommendation feed UI

 - Ranked card list with: deal name, owner, stage, days inactive, signal + date, why-now, recommended angle, confidence badge, actions (view details, draft, dismiss, snooze)
 - Detail view: fuller signal context, supporting proof, matched deal context, short deal history, recommendation rationale, draft action
 - Feed filters (by confidence, signal type, deal owner)

 13. User action tracking + analytics

 - Track: surfaced, opened, detail viewed, drafted, exported, dismissed (with reason), snoozed, acted
 - Funnel metrics per PRD section 18.1
 - Leading indicators per PRD section 18.2
 - Storage for analytics events

 14. HubSpot write-back (optional, conservative)

 - Create task in HubSpot
 - Save draft to HubSpot
 - Log note when user acts on recommendation
 - Never auto-write on recommendation generation

 ---
 Hidden coupling / risks

 1. Content-centric naming baked into core abstractions

 - ContentOpportunity, ContentReadiness, ContentStatus, CONTENT_READINESS, CONTENT_STATUS — these types are used throughout the intelligence pipeline. They cannot serve double duty for Sales.
 - EditorialSignalEngineApp — the main app class name. If sharing a single entry point, this naming creates confusion.
 - editorialOwner, narrativePillar, suggestedFormat — opportunity-specific fields with no Sales analog.

 2. Assumption that output object = content idea

 - The entire intelligence pipeline (screenSourceItems → decideCreateOrEnrich → create Opportunity) assumes the goal is to produce a content idea with an angle and framing. Sales needs to produce a
 deal-linked follow-up recommendation. These are structurally different decisions.

 3. Doctrine schema too editorial-specific

 - The 3-layer model (Company Lens / Content Philosophy / LinkedIn Craft) doesn't map to sales doctrine (positioning rules, proof hierarchy, cooling-off rules). Layer 2 "Content Philosophy" and Layer 3
 "LinkedIn Craft" have no Sales equivalent.
 - Doctrine markdown is injected directly into LLM prompts as free text. Sales doctrine needs more structured evaluation (value thresholds as numbers, cooling-off periods as days, exclusion lists as deal
 IDs).

 4. Evidence model tied to content generation

 - EvidenceReference links to Opportunity and Draft — both content-specific models. Sales evidence needs to link to Recommendation and SalesDraft.
 - OpportunityEvidence junction table is content-specific.
 - evidence-pack.ts source policy is hardcoded for content sources (market-research canBeOrigin, notion canBeOrigin if market-insight, linear evidence-only). Sales has a completely different source
 hierarchy.

 5. Workflow states tied to content review/approval

 - CONTENT_STATUS includes "To review", "Needs routing", "Ready for V1", "Selected", "Waiting approval" — a content editorial workflow. Sales recommendation lifecycle is different: new → viewed → drafted →
 dismissed/snoozed/acted → archived.

 6. Prompts tightly coupled to LinkedIn/content use case

 - drafts.ts system prompt: "You are a cynical French LinkedIn ghostwriter." Hard formatting rules specify "150-280 words", "No emoji as section headers", "French LinkedIn" conventions.
 - intelligence.ts screening prompt: "You are an editorial intelligence agent. Your job is to screen source items for content opportunity potential."
 - These cannot be parameterized; they must be replaced for Sales.

 7. Batch assumptions vs event-driven recommendations

 - Current pipeline is CLI-driven batch: ingest:run → intelligence:run → draft:generate. No event-driven processing.
 - Sales PRD requires "event-aware recommendation generation" (section 7.1): recommendations may be generated when a new signal arrives, a deal state changes, a periodic sweep runs, or a user opens the feed.
 - The current architecture supports periodic sweep (just run the CLI), but not event-driven triggers. Adding webhook-triggered processing requires architectural changes (persistent server with webhook
 endpoints, or a lightweight queue).

 8. Notion as primary external sync target

 - Fresh Content syncs opportunities, reviews, and run metadata to Notion databases. This is deeply woven into the intelligence pipeline (syncToNotion calls after opportunity creation).
 - Sales has no Notion sync requirement. HubSpot is the external system.
 - Risk: if extracting shared infrastructure, Notion-specific code must be cleanly separated from pipeline orchestration.

 9. Single-company assumption in practice

 - While the schema supports multi-tenancy (companyId on all models), the runtime assumes a single default company via DEFAULT_COMPANY_SLUG. Sales with multiple customers needs proper multi-tenant routing.

 10. Hardcoded profile IDs

 - PROFILE_IDS = ["baptiste", "thomas", "virginie", "quentin", "linc-corporate"] — hardcoded for one customer. Sales profiles must be dynamic per customer.

 ---
 Data model implications

 Entities that generalize well

 - Company — Multi-tenant root. Works as-is. Add Sales-specific relations.
 - User — Works for reps. baseProfile JSON needs different fields but the column is flexible.
 - SourceItem — Normalized signal storage. Works for all non-CRM signal types. HubSpot-derived signals can also be stored here.
 - SourceCursor — Cursor tracking. Works for HubSpot sync.
 - EvidenceReference — Proof excerpts. Generalizes well if we add a product discriminator or accept that evidence links to product-specific parent objects.
 - SyncRun + CostLedgerEntry — Observability. Product-agnostic.

 Entities too content-specific

 - Opportunity — Angle, whatItIsAbout/NotAbout, suggestedFormat, narrativePillar, readiness tiers, enrichmentLog, v1History. Cannot serve as Sales Recommendation.
 - Draft — hook, visualIdea, whatItIsAbout/NotAbout. Sales draft needs subject, body, channelType.
 - EditorialConfig — Layer 2 (Content Philosophy) and Layer 3 (LinkedIn Craft) are meaningless for Sales.
 - OpportunityEvidence — Junction for content opportunities only.
 - NotionDatabaseBinding — Irrelevant for Sales.
 - MarketQuery — Content-specific Tavily research queries. Not needed for Sales.

 Shared signal/evidence storage: practical?

 Yes, with care. SourceItem can store signals for both products. An feature_shipped signal ingested from Notion is useful for both Content (as a content opportunity source) and Sales (as a deal follow-up
 trigger). The key is:
 - Shared SourceItem storage (same table, same connector)
 - Product-specific downstream objects (Opportunity for Content, Recommendation for Sales)
 - Product-specific EvidenceReference scoping (evidence linked to Content opportunity vs Sales recommendation)

 Where recommendation objects should diverge

 The Recommendation model for Sales should be a new Prisma model with fields per PRD section 11, including:
 - Deal reference fields (dealId, dealName, dealStage, dealOwner, dealAmount, daysSinceActivity)
 - Signal reference (signalId, signalType, signalDate)
 - Matching output (whyNow, recommendedAngle, recommendedNextStepType)
 - Proof references (supportingProof, matchedContext)
 - Ranking (confidence, priorityRank)
 - Lifecycle (status with Sales-specific states)
 - User action tracking

 This shares no fields with Opportunity beyond basic metadata (id, companyId, createdAt, updatedAt).

 ---
 Runtime / job model implications

 Current model

 - CLI-driven batch processing — No persistent scheduler, no message queue, no event loop.
 - Commands: ingest:run, intelligence:run, draft:generate, etc. — each is a one-shot CLI invocation.
 - HTTP server (server.ts) — Only serves admin UI + one draft API endpoint. Not designed for webhook reception or real-time processing.

 What supports Sales well

 - Periodic sweep — Running ingest:run → matching:run on a cron schedule works for the "periodic sweep as fallback" requirement.
 - On-demand draft — The existing POST /v1/.../draft pattern works for "draft-on-demand".
 - CLI flexibility — Easy to add new Sales commands (sales:sync-hubspot, sales:match, sales:generate-recommendations).

 What assumes daily content batch

 - intelligenceRun() processes "pending" items in a single pass with no incremental awareness.
 - No webhook receiver — Cannot react to HubSpot changes in real-time.
 - No queue — Cannot process signals incrementally as they arrive.

 What would need to change for event-aware recommendations

 1. Add webhook endpoint — Fastify route to receive HubSpot webhooks for deal/contact/activity changes. This is the highest-leverage change for "event-aware" processing.
 2. Incremental matching — When a new signal arrives or a deal changes, run matching for just that signal/deal, not the entire pipeline.
 3. Feed-time computation — When a user opens the feed, re-rank existing recommendations against current suppression state and any new signals. This is a query-time operation, not a batch operation.
 4. Keep periodic sweep — As fallback for webhook gaps and for computing staleness-based signals (which are inherently time-driven).

 The CLI-driven model can work for v1 by running HubSpot sync + matching on a frequent cron (every 15-30 minutes). Webhook-driven processing is a stretch goal.

 ---
 UI reuse implications

 Feed/review screens: reusable pattern, not reusable content

 - admin/pages/source-items.ts — Pattern of filterable, paginated list with disposition categories. Good template for the recommendation feed page.
 - admin/pages/opportunities.ts — Pattern of detail view with related data (evidence, enrichment history). Good template for recommendation detail view.
 - admin/pages/reviews.ts — Pattern of review queue with status tracking. Good template for signal review.

 Admin/config screens: highly reusable

 - admin/pages/editorial-configs.ts — Pattern for doctrine versioned config editing. Reuse for Sales doctrine admin.
 - admin/pages/source-configs.ts — Pattern for source connector configuration. Reuse for HubSpot config.
 - admin/pages/users.ts — Pattern for user/profile management. Reuse for rep style profile management.
 - admin/pages/runs.ts — Run history with counters and cost tracking. Fully reusable.
 - admin/pages/dashboard.ts — Stat cards and summary metrics. Pattern reusable for Sales analytics dashboard.

 Detail/drawer/panel patterns: reusable

 - admin/components.ts — table(), pagination(), badge(), backLink(), withCompany(), buildDetailUrl() — all product-agnostic.
 - admin/layout.ts — Master template with nav, styling. Reusable with nav changes.

 Too content-specific

 - admin/pages/drafts.ts — Draft gallery with hook, visualIdea, LinkedIn-specific fields. Cannot reuse for sales drafts.
 - admin/pages/market-queries.ts — Tavily query management. Not relevant for Sales.
 - admin/pages/reviews.ts — Claap publishability and Linear enrichment review queues. Content-specific.

 ---
 Recommended build plan

 Phase 0: Codebase prep (before any Sales code)

 1. Extract shared infrastructure into a src/shared/ directory (or keep in-place but ensure clean import boundaries):
   - lib/* (ids, logger, errors)
   - services/llm.ts
   - services/evidence.ts (core evidence functions)
   - services/observability.ts
   - services/retention.ts
   - connectors/base.ts
   - admin/layout.ts, admin/components.ts, admin/plugin.ts
   - db/client.ts
   - config/env.ts (extend AppEnv)
 2. Widen SourceKind to include "hubspot". This is a one-line change.
 3. Add product discriminator concept if sharing SourceItem table (or use metadata convention).
 4. Rename or namespace the main app class if both products will share an entry point. Or: keep separate entry points (src/content-app.ts + src/sales-app.ts).

 Phase 1: Highest-leverage reuse (foundation)

 1. Sales domain types — Define SalesSignalType, Recommendation, SalesDraft, SalesDoctrine, RepStyleProfile, DealRecord, ContactRecord, etc. in src/sales/domain/types.ts.
 2. Prisma schema additions — Add Deal, Contact, CrmCompany, Activity, ExtractedFact, Recommendation, SalesDraft, RecommendationAction, SalesDoctrine models.
 3. Sales repository — Extend RepositoryBundle or create SalesRepositoryBundle with deal/recommendation CRUD.
 4. Reuse evidence layer — Import buildEvidenceReferences, dedupeEvidenceReferences, computeFreshnessScore, selectPrimaryEvidence directly.
 5. Reuse LlmClient — Import as-is.
 6. Reuse observability — Import as-is, add Sales-specific run types.

 Phase 2: Sales-specific core

 1. HubSpot connector — Implement SourceConnector<HubSpotSourceConfig> for deal/contact/company/activity sync.
 2. Signal generation — Detect deal_state_change signals from HubSpot data (staleness, stage regression, stakeholder addition).
 3. Non-CRM signal ingestion — Reuse Notion connector for feature_shipped and proof_created from Notion databases.
 4. Manual signal entry — API endpoint for market_event and other manual signals.
 5. Structured extraction — LLM pipeline to extract 7 fact categories from CRM activity text.
 6. Sales doctrine — Storage, loading, and injection into matching/ranking/draft prompts.
 7. Deal-signal matching engine — Match signals to deals using deal properties + extracted facts + doctrine.
 8. Scoring + ranking — Weighted scoring across 7 dimensions.
 9. Suppression rules — Implement all anti-noise rules from PRD section 13.

 Phase 3: UI + workflow

 1. Recommendation feed page — Ranked cards with actions. Reuse layout/components from admin shell.
 2. Recommendation detail view — Signal context, proof, deal context, rationale, draft action.
 3. Sales draft generation — New prompt chain for email/LinkedIn drafts. Reuse LlmClient + safety check pattern.
 4. User action tracking — Dismiss (with reason), snooze, view, draft, act.
 5. Sales admin pages — Doctrine config, rep profiles, HubSpot config, signal review, analytics dashboard.
 6. Rep-facing feed vs operator admin — Separate routes/auth for reps (feed) vs operators (admin).

 Phase 4: Polish + optional write-back

 1. HubSpot write-back — Create task, save draft, log note (conservative, opt-in).
 2. Analytics — Funnel metrics, leading indicators per PRD section 18.
 3. Webhook support — HubSpot webhook receiver for real-time deal changes.
 4. Feed-time re-ranking — Re-rank recommendations on feed open against current suppression state.
 5. Content↔Sales signal sharing — Wire shared SourceItem storage so content_published signals from Fresh Content feed into Sales.

 ---
 Refactor recommendations before building

 1. Extract SourceKind into an extensible pattern

 Current: const SOURCE_KINDS = ["notion", "claap", "linear", "market-findings", "market-research"] as const — closed union.
 Problem: Adding "hubspot" requires modifying this shared constant, which affects Content's type narrowing.
 Fix: Split into CONTENT_SOURCE_KINDS and SALES_SOURCE_KINDS with a shared union, or make SourceKind a branded string type with product-specific narrowing.
 Impact: Small (one file), high leverage.

 2. Decouple evidence from Opportunity/Draft FKs

 Current: EvidenceReference has opportunityId and draftId FKs directly on the model.
 Problem: Sales evidence needs to link to Recommendation and SalesDraft, not Opportunity and Draft. Adding more nullable FKs is messy.
 Fix: Use a polymorphic association pattern (e.g., parentType + parentId columns) or product-specific junction tables (like OpportunityEvidence already exists — add RecommendationEvidence).
 Impact: Moderate schema change, but prevents FK proliferation.

 3. Make PROFILE_IDS dynamic

 Current: Hardcoded array of 5 profile names.
 Problem: Sales profiles are per-customer, not hardcoded.
 Fix: Remove the const assertion; load profile IDs from database or config. Use string type for profile references.
 Impact: Small code change, but touches type narrowing in several places.

 4. Separate admin routes by product

 Current: All admin pages registered in a single registerAdminPlugin().
 Fix: Split into registerContentAdminRoutes() and registerSalesAdminRoutes(), both using the shared layout/auth.
 Impact: Clean separation without duplication.

 5. Extract pipeline orchestration from EditorialSignalEngineApp

 Current: app.ts is a 600+ line monolith that mixes infrastructure (run tracking, convergence) with content-specific logic (intelligence pipeline, Notion sync, opportunity creation).
 Fix: Extract content-specific pipeline steps into src/content/pipeline.ts. Create src/sales/pipeline.ts for Sales. Keep shared infrastructure in the app class or a base class.
 Impact: Moderate refactor, but critical for preventing the Sales pipeline from becoming entangled with Content pipeline.

 ---
 Final verdict

 Is Fresh Content actually a strong substrate for Fresh Sales?

 Yes, conditionally. It provides genuine infrastructure leverage — roughly 3-4 weeks of foundation work that doesn't need to be rebuilt. The connector pattern, evidence layer, LLM client, observability,
 admin shell, and data access patterns are real assets.

 Which parts are the real leverage?

 1. LlmClient — The most valuable single piece. Multi-provider, structured output, cost tracking, fallback handling. Would take 2-3 days to build from scratch.
 2. Evidence layer (evidence.ts) — Building, dedup, freshness scoring, selection. Core to Sales proof handling. 1-2 days to rebuild.
 3. Admin UI shell — Layout, components, auth. Immediately usable for Sales admin and recommendation feed. 2-3 days to rebuild.
 4. Connector pattern — SourceConnector interface + BaseConnector with rate limiting. Clean contract for the HubSpot connector. 1 day to rebuild.
 5. Observability — Run tracking + cost ledger. Important for production operation. 1 day to rebuild.
 6. Shared Prisma schema — Company, User, SourceItem, SourceCursor, SyncRun, CostLedgerEntry models. Working multi-tenant foundation.

 Which parts are likely to disappoint if we assume reuse too optimistically?

 1. Intelligence pipeline — Looks structurally similar (screen → decide → create) but the screening logic, decision criteria, and output objects are entirely different. Attempting to parameterize
 screenSourceItems() for both Content and Sales would create a tangled mess.
 2. Draft generation — Same shape, completely different content. The French LinkedIn ghostwriter prompt is not "almost" a sales email prompt — it's a fundamentally different writing task.
 3. Doctrine model — The 3-layer editorial config cannot serve sales doctrine. They share the concept of "company rules that shape output" but nothing else.
 4. Opportunity model as recommendation — Any attempt to reuse Opportunity for Recommendation would require so many nullable fields and conditionals that it would be worse than building a clean model.
 5. Notion sync — Deeply woven into Content's pipeline. Sales has no Notion sync; it has HubSpot sync. Zero reuse.

 ---
 Appendix: file/module references

 Shared infrastructure (direct reuse):
 - src/services/llm.ts — LlmClient
 - src/services/evidence.ts — Evidence building, dedup, freshness, selection
 - src/services/observability.ts — Run tracking, cost entries
 - src/services/retention.ts — Raw text expiry
 - src/lib/ids.ts — Deterministic IDs, hashing
 - src/lib/logger.ts — Pino logger
 - src/lib/errors.ts — Custom error classes
 - src/db/client.ts — Prisma singleton
 - src/connectors/base.ts — BaseConnector (rate limiting)
 - src/admin/layout.ts — HTML template + CSS
 - src/admin/components.ts — Table, badge, pagination, filter
 - src/admin/plugin.ts — Auth, access control, route registration

 Adaptation candidates:
 - src/domain/types.ts — Extend SourceKind, add Sales types alongside
 - src/connectors/index.ts — Extend registry with HubSpot connector
 - src/connectors/notion.ts — Adapt for product changelog / proof sources
 - src/services/evidence-pack.ts — Rewrite matching logic for deal-signal matching
 - src/services/drafts.ts — Rewrite prompt and schema for sales emails
 - src/services/intelligence.ts:28-51 — Reuse prefilterSourceItems() directly
 - src/db/repositories.ts — Extend with Sales methods
 - src/config/env.ts — Add HUBSPOT_API_KEY and Sales env vars
 - src/admin/pages/*.ts — Use as templates for Sales pages

 Content-specific (no reuse):
 - src/services/intelligence.ts (beyond prefilter) — Editorial screening logic
 - src/services/sensitivity.ts — Content sensitivity rules
 - src/services/notion.ts — Notion database sync
 - src/services/market-research.ts — Tavily research
 - src/services/convergence.ts — Content-specific bootstrap
 - src/connectors/claap.ts — Not in Sales scope
 - src/connectors/linear.ts — Not in Sales scope
 - src/connectors/market-findings.ts — Likely replaced by form entry
 - src/app.ts — Content orchestration (reuse pattern, not code)
 - editorial/* — Content-specific doctrine and profiles

 Prisma models (reuse status):
 - Reuse: Company, User, SourceItem, SourceCursor, SyncRun, CostLedgerEntry
 - No reuse: Opportunity, Draft, EditorialConfig, OpportunityEvidence, NotionDatabaseBinding, MarketQuery
 - Needs companion: EvidenceReference (add RecommendationEvidence junction or polymorphic link)