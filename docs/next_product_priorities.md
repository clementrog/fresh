# Next Product Priorities

This document captures the next recommended product slices after the evidence-pack enrichment work.

Plain language:

- the last slice improved how Fresh packages proof around opportunities
- the next slices should improve the quality of proof available, make gaps clearer to operators, and upgrade existing opportunity inventory without redesigning the architecture

These are reference priorities, not a schema-redesign plan.

## Priority 1 — Real Internal Proof Ingestion

### Status note

Implemented and validated on a live example.

What was shipped:

- a new `notion:internal-proof` ingestion path for curated Notion proof pages
- explicit support-only policy for internal proof
- evidence-pack compatibility so internal proof can attach to existing opportunities
- regression protection so owner-based candidate routing does not misdirect enrich-only proof

What was validated:

- internal proof rows are ingested as structured `SourceItem` records
- proof text now includes the actual `Evidence Summary`, not just claim/category metadata
- a live migration-risk proof item was attached to the correct existing migration objection opportunity
- irrelevant attachment caused by owner-boost ranking was fixed and covered by tests

Current conclusion:

- Priority 1 is complete enough to move to Priority 2
- remaining follow-up is operational scale-up of proof inventory, not a blocker on the core slice

### Goal

Give Fresh better real internal material to attach when an opportunity needs supporting proof.

### Why this matters

The evidence-pack step now knows how to attach support material, but it can only attach what already exists in the system.
In live data, the main proof of value is currently anti-noise behavior:

- Fresh does not attach irrelevant Linear tickets
- Fresh exposes provenance clearly

The next product win is stronger:

- Fresh finds relevant internal proof when it actually exists

### Scope

- ingest a small curated set of real internal proof sources
- prioritize:
  - Claap sales-call signals
  - curated Notion proof pages
  - security, product, implementation, and operations proof pages that help support a claim
- classify each source clearly as either:
  - can create opportunities
  - can support only
  - enrich-only / never create

### Non-goals

- no retrieval platform redesign
- no broad connector expansion just for volume
- no reopening Linear as an idea-creation source

### Test plan

- Unit tests
  - source classification rules map each source type correctly
  - enrich-only sources cannot create new opportunities
  - support-only sources can attach evidence but cannot originate ideas
- Integration tests
  - relevant Claap or Notion proof attaches to a matching opportunity
  - unrelated internal proof is rejected
  - provenance remains intact after support evidence is added
- Manual product test
  - seed `3-5` real proof items on one known topic
  - create or rerun a matching opportunity
  - verify that the right proof attaches and unrelated proof does not

### Acceptance bar

- at least one live opportunity gets relevant internal proof attached
- no regressions in source creation policy
- no irrelevant Linear or raw operational noise is attached as support

## Priority 2 — Operator-Facing "What’s Missing"

### Goal

Turn draft-readiness into an operator action guide.

### Why this matters

`Too early` is clearer, but still incomplete on its own.
Operators should understand what is missing without interpreting raw evidence themselves.

### Scope

- surface readiness reasons in the operator workflow
- keep reasons short, explicit, and actionable
- examples:
  - missing supporting internal proof
  - missing stronger regulatory excerpt
  - missing concrete facts to draft from

### Non-goals

- no new workflow engine
- no draft-generation redesign

### Test plan

- Unit tests
  - each readiness failure state produces the expected missing reason
  - multiple missing reasons are returned in a stable order
- Integration tests
  - readiness status and missing reasons are persisted or synced to the operator surface
  - ready opportunities do not show false missing reasons
- Manual product test
  - review `5` mixed-quality opportunities
  - confirm a non-technical operator can understand what to do next from the surfaced fields alone

### Acceptance bar

- every non-ready opportunity shows at least one specific missing reason
- operators can distinguish:
  - promising but under-backed
  - ready enough to draft

## Priority 3 — One-Time Backfill of Existing Top Opportunities

### Goal

Upgrade the best existing opportunities using the same bounded evidence-pack logic.

### Why this matters

New opportunities benefit from the evidence-pack step.
Older high-value opportunities should not remain weaker just because they were created earlier.

### Scope

- run a one-time bounded backfill on recent or high-value opportunities
- reuse the same provenance and support-evidence rules already implemented for new opportunities
- preserve the original primary evidence and origin trace

### Non-goals

- no separate enrichment system
- no unbounded historical reprocessing

### Test plan

- Unit tests
  - backfill skips opportunities that already have equivalent evidence
  - backfill preserves original primary provenance
- Integration tests
  - backfill adds evidence where appropriate
  - rerunning backfill does not duplicate evidence
- Manual product test
  - pick `5` existing opportunities
  - run the backfill
  - verify provenance remains correct, useful support is added when available, and duplicates are not created

### Acceptance bar

- a meaningful subset of existing top opportunities gains better evidence packs
- rerunning the backfill is safe and idempotent

## Priority 4 — Tighten Evidence Quality Rules

### Goal

Improve precision before scaling proof volume.

### Why this matters

As more support material is ingested, the matching rules need to remain trustworthy.
The system should stay conservative: better to miss weak proof than to attach misleading proof.

### Scope

- review false positives and false negatives from live runs
- tune thresholds and overlap rules only where evidence supports it
- preserve the bounded deterministic shape of the current enrichment logic

### Non-goals

- no giant semantic retrieval system
- no broad architecture rewrite

### Test plan

- Unit tests
  - known false-positive examples are rejected
  - known false-negative examples are accepted after a rule improvement
- Regression tests
  - anti-junk protections continue to pass
  - Linear remains support-only, never create
- Manual product test
  - review a labeled set of good-match and bad-match examples and compare actual results to expected results

### Acceptance bar

- no regression in anti-noise behavior
- higher confidence that attached proof is genuinely useful to drafting

## Recommended Execution Order

1. Priority 1 — Real Internal Proof Ingestion
2. Priority 2 — Operator-Facing "What’s Missing"
3. Priority 3 — One-Time Backfill of Existing Top Opportunities
4. Priority 4 — Tighten Evidence Quality Rules

Reason:

- first improve the raw proof available
- then make evidence gaps understandable to operators
- then upgrade existing inventory
- then tune quality rules based on real usage
