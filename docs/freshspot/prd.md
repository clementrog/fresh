# Fresh Sales — Definitive PRD v1.2 (LLM Build Spec)

## 0. Purpose

This document is the definitive product spec for **Fresh Sales v1.2**.

It is written for **LLM implementation agents** that will:

* read this spec
* inspect the existing **Fresh Content** codebase
* reuse shared infrastructure where appropriate
* build the first working version of Fresh Sales

This document is optimized for:

* planning
* implementation
* scope control
* testability

This document is **not** optimized for sales, fundraising, or strategy communication.

---

## 1. Product definition

### 1.1 One-line definition

Fresh Sales tells reps and founder-sellers **which open deals deserve follow-up now, why now, and what proof to use** — based on real company signals, not CRM reminders.

### 1.2 Product type

Fresh Sales is a **signal-driven follow-up recommendation system** for sales teams using HubSpot.

### 1.3 Core job

Fresh Sales must solve these jobs in order:

1. detect which deals deserve attention now
2. explain why now
3. propose the best follow-up angle
4. attach supporting proof
5. optionally generate a draft message

### 1.4 Core principle

**Decision first, generation second.**

The system is valuable if it finds the right follow-up opportunities.
Draft generation is secondary.

### 1.5 What it is not

Fresh Sales is not:

* a sales sequencing tool
* a CRM replacement
* a generic AI assistant for HubSpot
* an autonomous outreach tool
* a workflow builder
* a dashboard for broad pipeline analytics
* a top-of-funnel lead scoring tool

---

## 2. Users and customer model

### 2.1 Primary user

Primary user:

* founder-seller or AE
* B2B SaaS company
* company size: 15–80 people
* manages 30–100 open deals
* uses HubSpot
* has limited or no dedicated RevOps support
* follow-up timing is currently based on memory, reminders, and ad hoc CRM hygiene

### 2.2 Buyer

Typical buyer:

* founder / CEO
* Head of Sales
* GTM lead
* revenue leader

In early customers, buyer and user may be the same person.

### 2.3 GTM model for v1

v1 is **high-price, white-glove, manually onboarded**.

Assumptions for v1:

* onboarding is done manually by Fresh team
* source setup is manual
* doctrine setup is manual
* rep style setup is manual
* signal quality can be curated manually
* some customer-specific configuration is acceptable

Do **not** optimize v1 for self-serve onboarding.

---

## 3. Product promise

Fresh Sales should help users:

* focus on a small set of follow-ups that actually matter
* avoid generic “checking in” messages
* react when a company development creates a better outreach moment
* reuse proof and company signals more effectively
* reduce missed timing opportunities

Fresh Sales should optimize for:

* specificity
* timing
* credibility
* explainability
* low noise

Fresh Sales should **not** optimize for:

* volume of recommendations
* maximum automation
* recommendation coverage at all costs

Valid system state:

* **No recommendations today**

---

## 4. Scope

## 4.1 Included in v1.2

v1.2 includes:

* HubSpot integration
* one active HubSpot pipeline per workspace by default
* five signal types only
* recommendation feed UI
* recommendation detail view
* draft-on-demand
* rep style profiles
* manual doctrine configuration
* dismiss / snooze / act tracking
* basic analytics
* white-glove onboarding support

## 4.2 Excluded from v1.2

v1.2 excludes:

* automated sending
* self-serve onboarding
* Salesforce
* Slack digests
* HubSpot sidebar app
* call transcript intelligence
* product usage signals
* third-party intent data
* manager dashboards
* broad team analytics
* multi-pipeline orchestration
* broad web monitoring
* generic company-memory UI

---

## 5. Supported signal types

Only these 5 signal types are allowed in v1.2:

1. `feature_shipped`
2. `proof_created`
3. `deal_state_change`
4. `content_published`
5. `market_event`

No other signal types are in scope.

## 5.1 Signal definitions

### `feature_shipped`

A product capability or update that may resolve a past objection or create new relevance for a deal.

Sources:

* changelog
* release notes
* product Notion pages
* Linear-derived release notes
* manual entry
* webhook/manual feed

Example:

* “SSO support shipped”

### `proof_created`

A new piece of proof that strengthens outreach.

Sources:

* case study
* testimonial
* quantified result
* customer logo / customer win
* Notion DB
* curated docs folder
* manual input

Example:

* “New fintech case study published”

### `deal_state_change`

A deal condition in HubSpot that may justify review or follow-up.

Sources:

* HubSpot deal / contact / activity changes

Examples:

* no activity for 21 days
* stage regressed
* stakeholder added
* contact silent

### `content_published`

A company content asset that may give a timely follow-up angle.

Sources:

* Fresh Content outputs
* blog posts
* founder posts
* manual input

Example:

* “Founder published post on compliance workflows”

### `market_event`

A manually curated external event relevant to sales timing.

Sources:

* manual entry only in v1.2

Examples:

* competitor raised prices
* regulatory change relevant to target segment
* customer segment event manually entered by operator

## 5.2 Signal confidence priority

Highest confidence:

1. `feature_shipped`
2. `proof_created`
3. `deal_state_change`

Medium confidence:
4. `content_published`

Lowest confidence:
5. `market_event`

## 5.3 Market event constraint

For v1.2:

* `market_event` is **manual-only**
* no RSS ingestion
* no broad monitoring
* no auto-discovery

Reason:

* noise risk is too high for v1

## 5.4 Out-of-scope signals

The following are explicitly out of scope:

* call transcript analysis
* third-party intent signals
* product usage / activation signals
* email open/click tracking
* social media monitoring of prospects
* broad market scraping
* “semantic signal discovery” without typed source grounding

---

## 6. Data sources

## 6.1 Required HubSpot data

### Deals

Required fields:

* name
* stage
* amount
* close date
* owner
* pipeline
* last activity date
* create date
* selected customer-specific custom properties

### Contacts

Required fields:

* name
* email
* title
* company
* lifecycle stage
* last activity

### Companies

Required fields:

* name
* domain
* industry
* size

### Activities

Required:

* emails
* notes
* calls
* meetings
* metadata
* body text where needed for structured extraction

### Associations

Required:

* deal-contact associations
* deal-company associations
* owner associations as needed

## 6.2 Non-HubSpot sources

### Product / changelog sources

* Notion
* changelog pages
* release notes
* manual entry
* webhooks/manual source feed

### Proof sources

* Notion database
* curated docs folder
* manual input
* selected Fresh Content evidence if shared

### Content sources

* Fresh Content outputs
* blog content
* founder posts
* manual input

### Market event sources

* manual input only

---

## 7. Processing model

## 7.1 Core architecture principle

Fresh Sales must **not** depend on a single 24-hour batch job.

Instead it must support:

* persistent stored state
* incremental ingestion
* event-aware recommendation generation
* periodic sweep as fallback
* a ranked recommendation feed

## 7.2 Conceptual model

Fresh Sales has two layers:

### Persistent layer

Stores:

* normalized signals
* deals
* contacts
* companies
* extracted structured context
* doctrine
* rep style profiles
* evidence/proof
* recommendations
* user actions
* suppression state

### Runtime layer

Does:

* candidate matching
* scoring
* filtering
* ranking
* draft generation on demand

## 7.3 Trigger model

Recommendations may be generated when:

* a new signal arrives
* a deal state changes
* a periodic sweep runs
* a user opens the feed
* a user requests a draft

Use event-driven or incremental processing where possible.

Daily output is a UI delivery pattern, not the system architecture.

---

## 8. Signal-to-deal matching

## 8.1 Goal

For each signal, determine which open deals may justify follow-up.

## 8.2 Matching inputs

Matching may use:

* deal properties
* contact properties
* company properties
* explicit manual tags
* stage
* inactivity / staleness
* structured facts extracted from activity text
* doctrine rules

## 8.3 Structured extraction from HubSpot text

v1.2 allows only limited structured extraction from notes / activity text.

Allowed extraction categories:

1. objection mentioned
2. requested capability / feature request
3. competitor reference
4. urgency / timing signal
5. budget sensitivity
6. persona / stakeholder type
7. compliance / security requirement

No broader conversational understanding is in scope.

Do not try to derive full account narratives from raw CRM text in v1.2.

## 8.4 Matching rule

Matching must be:

* explainable
* sparse
* conservative

The system should prefer missing weak opportunities over surfacing weak recommendations.

## 8.5 Explainability requirement

Every recommendation must show:

* which signal triggered it
* which deal fact / extracted fact / manual tag matched
* why the match matters now

Minimum explainability format:

* “Surfaced because [signal] matched [specific deal context].”

Example:

* “Surfaced because SSO shipped and this deal is tagged ‘SSO blocker’ from a September note.”

---

## 9. Doctrine layer

## 9.1 Purpose

Doctrine is the customer’s explicit set of sales rules and preferences that shape matching, ranking, and framing.

## 9.2 Doctrine types

Doctrine may include:

* positioning rules
* follow-up rules
* proof hierarchy
* persona guidance
* exclusion rules
* value thresholds
* cooling-off rules
* framing rules

## 9.3 Examples

Examples:

* lead with time-to-value, not feature lists
* never send generic “checking in” messages
* customer quotes outrank blog posts
* for CFOs, lead with ROI
* never surface do-not-contact deals
* ignore deals below €5K
* do not re-engage lost deals within 60 days
* do not mention competitors by name

## 9.4 Doctrine setup

v1.2 doctrine is configured manually during onboarding.

Accepted setup methods:

* structured form
* guided interview
* manual Fresh operator entry
* Notion-like document interpreted manually

Doctrine must be:

* explicit
* editable
* inspectable

Automatic doctrine inference is out of scope.

---

## 10. Rep style profile

## 10.1 Purpose

Rep style profiles affect wording and tone of generated drafts.

They do not override doctrine or proof hierarchy.

## 10.2 Profile fields

Allowed fields:

* tone
* length preference
* directness
* language
* opening style
* closing style
* signature conventions

## 10.3 Setup

Setup is manual during onboarding.

Inputs may include:

* 3–5 example emails
* manually chosen preferences
* combined approach

---

## 11. Recommendation object

Each surfaced recommendation must conform to this object shape.

```yaml
recommendation_id:
workspace_id:
user_id:

deal_id:
deal_name:
deal_stage:
deal_owner:
deal_amount:
days_since_activity:

signal_id:
signal:
signal_type:
signal_date:

why_now:
recommended_angle:
recommended_next_step_type:

supporting_proof:
  - proof_type:
    label:
    source:
    reference:

matched_context:
  - context_type:
    label:
    source:
    reference:

confidence:
priority_rank:
status:
draft_available:
created_at:
updated_at:
```

## 11.1 Required field definitions

### `recommended_next_step_type`

Allowed values:

* `email_follow_up`
* `linkedin_message`
* `send_proof_asset`
* `reactivation_call`

Do **not** include `wait` in v1.2.

If the right action is effectively “wait,” do not surface a recommendation.

### `confidence`

Allowed values:

* `high`
* `medium`
* `low`

v1.2 feed should primarily surface:

* `high`
* `medium`

`low` should generally be suppressed.

### `status`

Allowed values:

* `new`
* `viewed`
* `drafted`
* `dismissed`
* `snoozed`
* `acted`
* `archived`

---

## 12. Ranking and scoring

## 12.1 Ranking dimensions

Rank recommendations using a weighted combination of:

1. signal-to-deal relevance
2. signal freshness
3. proof quality
4. deal value
5. deal staleness
6. doctrine fit
7. suppression / anti-spam state

## 12.2 Ranking philosophy

Rules:

* strong proof beats generic relevance
* recent direct signals beat old weak signals
* high-value stale deals matter, but should not dominate everything
* dead deals should not flood the top of the list
* clearer explainability should beat clever but weak matches

## 12.3 Confidence guidance

### High confidence

Use when:

* signal directly matches a known objection, request, or tag
* proof exists
* signal is recent
* doctrine supports the framing

### Medium confidence

Use when:

* signal plausibly matches context
* some proof exists or can be inferred
* relevance is useful but not direct

### Low confidence

Use when:

* match is weak
* proof is poor
* relationship between signal and deal is indirect

Default behavior:

* suppress most low-confidence recs

---

## 13. Anti-noise and suppression rules

These rules are mandatory in v1.2.

## 13.1 Suppression rules

* max 1 surfaced recommendation per deal per 7 days by default
* max 10 surfaced recommendations per user per day by default
* suppress recommendations for deals recently dismissed
* suppress recommendations for deals with imminent scheduled meetings
* suppress weak recommendations when stronger ones exist
* suppress near-duplicate recommendations caused by signal churn
* suppress low-confidence recs by default

## 13.2 Dismiss feedback

Dismiss should capture a reason when possible.

Allowed reasons:

* already handled
* not relevant
* bad timing
* weak proof
* wrong angle

This feedback must be stored, even if adaptive learning remains simple in v1.2.

---

## 14. User experience

## 14.1 Primary UI

Primary UI = **recommendation feed**

The recommendation feed is:

* ranked
* scannable
* low-noise
* useful in under 60 seconds

## 14.2 Feed card fields

Each card should show:

* deal name
* owner
* stage
* days inactive
* triggering signal + date
* short why-now explanation
* recommended angle
* confidence badge
* primary actions

## 14.3 Feed actions

Card actions:

* View details
* Draft follow-up
* Dismiss
* Snooze

Optional later if simple:

* Create task
* Push to HubSpot

## 14.4 Detail view

Detail view should show:

* fuller signal context
* supporting proof
* matched deal context
* short deal history summary
* recommendation rationale
* draft action

Do not build a full CRM replacement view.

## 14.5 UX rules

Mandatory UX rules:

* scan-first
* no noise
* always explain
* minimal clicks
* fewer stronger recs > many weak recs
* valid state: no recommendations

---

## 15. Draft generation

## 15.1 Trigger

Draft generation happens only when user clicks:

* Draft follow-up

Do not pre-generate all drafts.

## 15.2 Inputs to draft generation

Use:

* signal
* deal context
* matched context
* supporting proof
* doctrine
* rep style profile

## 15.3 Output formats

Allowed outputs:

* email draft
* LinkedIn message draft

Default:

* email draft

## 15.4 Draft constraints

Drafts must:

* be grounded in surfaced signal and proof
* reflect rep style
* respect doctrine
* avoid generic check-in phrasing
* never auto-send

---

## 16. HubSpot integration behavior

## 16.1 Scope

Default v1.2 scope:

* one active pipeline per workspace
* open deals only
* closed-won and closed-lost excluded by default

## 16.2 Sync model

Required behavior:

* initial sync of relevant open deals and associated objects
* incremental sync after that
* webhook if feasible
* polling fallback acceptable

## 16.3 Freshness target

HubSpot changes and new signals should be eligible for recommendation processing within the same working day, preferably much faster.

## 16.4 Write-back policy

Write-back is optional and conservative.

Allowed write-backs:

* create task
* save draft
* log note when user acts on recommendation

Default:

* do not write a note just because a recommendation was generated

Avoid CRM clutter.

---

## 17. Shared substrate with Fresh Content

## 17.1 Reuse principle

Implementation agent should inspect Fresh Content codebase and reuse shared infrastructure where the product pattern is genuinely shared.

## 17.2 High-reuse components

Reuse at high level:

* signal ingestion pattern
* normalization / event typing pattern
* doctrine engine pattern
* evidence storage pattern

## 17.3 Medium-reuse components

Reuse/adapt:

* user style profile pattern
* queue/feed UI pattern
* draft generation flow
* matching pipeline shape

## 17.4 New Sales-specific components

Build new:

* HubSpot connector
* deal-signal matching logic
* CRM structured extraction
* staleness scoring
* suppression rules
* HubSpot write-back logic
* recommendation analytics

## 17.5 Shared store guidance

Preferred direction:

* shared normalized signal/evidence substrate across Fresh products
* product-specific recommendation/workflow objects remain separate

Do not duplicate signals if shared storage is practical.

---

## 18. Success metrics

## 18.1 Funnel metrics

Track separately:

* recommendations surfaced
* recommendations opened
* detail views
* drafts generated
* drafts exported / copied / saved
* confirmed manual actions
* dismissals
* snoozes

Do not collapse into one “acted on” metric.

## 18.2 Leading indicators

Track in first 30 days:

* average recs surfaced per user per week
* % opened
* % detail viewed
* % drafted
* % dismissed
* median time from surfaced to user action
* share of recs marked high confidence
* share of dismissals marked “not relevant”

## 18.3 Lagging indicators

Track in 60–90 days:

* deals reactivated after recommendation
* pipeline influenced
* reduction in follow-up delay on stale deals
* user-reported usefulness
* repeat usage of feed

## 18.4 Failure signal

Important failure signal:

* users perceive feed as noisy, repetitive, or generic
* high share of dismissals marked “not relevant”

This matters more than low raw action rate alone.

---

## 19. Onboarding

## 19.1 Onboarding model

Onboarding is white-glove and manual for early customers.

## 19.2 Required onboarding steps

1. connect HubSpot
2. select one primary pipeline
3. map stages and custom properties
4. connect at least one product/change source
5. connect at least one proof source
6. define doctrine
7. create rep style profile(s)
8. optionally tag high-priority deals
9. QA first recommendations with customer

## 19.3 Time to first value

Target:

* first usable recommendations same day onboarding completes
* ideally within 2 hours of source setup and initial sync

Manual operator assistance is allowed.

---

## 20. Worked example

This example is normative. Use it to understand intended behavior.

### 20.1 Input signal

Signal arrives:

* title: “v2.3 shipped with SSO support”
* signal_type: `feature_shipped`
* signal_date: 2025-11-12

### 20.2 Candidate matching

System queries open deals and finds 3 deals with possible SSO relevance.

One candidate:

* deal_name: “Acme Corp — Enterprise”
* amount: €45K
* stage: Negotiation
* days_since_activity: 23
* primary contact: CISO
* extracted CRM context: “SSO blocker” mentioned in September note

### 20.3 Doctrine applied

Doctrine says:

* for security buyers, lead with compliance proof over generic feature announcement
* never send generic follow-up
* customer proof outranks blog posts

### 20.4 Proof retrieved

Proof found:

* SOC2-related case study from similar company
* release note for SSO launch
* original objection reference from CRM note

### 20.5 Recommendation produced

Result:

* confidence: high
* recommended_next_step_type: `email_follow_up`
* why_now: “Acme previously stalled on lack of SSO. SSO shipped recently and no one has followed up.”
* recommended_angle: “Re-engage around resolved SSO blocker and support it with compliance proof from a similar customer.”

### 20.6 Draft behavior

If user clicks Draft:

* generate short direct email
* mention SSO blocker resolution
* mention proof asset
* use rep style preferences
* avoid fluff or generic check-in language

---

## 21. Open questions

These are known unresolved product questions. Build should not expand scope to answer them automatically.

1. How much structured extraction from HubSpot activity text remains safe before quality drops?

   * current answer: limited extraction only

2. How much coordination is needed if multiple reps receive related recommendations at the same account?

   * current answer: keep simple in v1

3. What is the lightest reliable way to confirm a recommendation led to real follow-up?

   * current answer: basic tracking first

4. How much coupling is acceptable in shared signal/evidence storage across Fresh products?

   * current answer: prefer shared substrate

---

## 22. Build instructions for LLM implementation agents

When planning and building:

1. keep the product narrow
2. do not expand signal types beyond the 5 defined here
3. do not add self-serve onboarding
4. do not add automated sending
5. do not add broad market monitoring
6. implement structured CRM text extraction only for the 7 allowed categories
7. optimize for explainability and low noise
8. prioritize recommendation quality over volume
9. reuse Fresh Content patterns where truly shared
10. keep product-specific recommendation logic separate from shared signal storage
11. use event-aware processing, not only nightly batch generation
12. treat the worked example as a reference behavior test

---

## 23. Acceptance criteria

Fresh Sales v1.2 is acceptable when all of the following are true:

1. HubSpot open deals can be synced for one pipeline
2. at least the 5 scoped signal types can be ingested
3. signals can be matched to deals using explicit properties, tags, and limited CRM structured extraction
4. recommendations are explainable
5. recommendations are ranked and suppressed with anti-noise rules
6. recommendation feed works
7. detail view works
8. draft-on-demand works
9. doctrine affects framing and filtering
10. rep style affects draft generation
11. user actions are tracked
12. analytics funnel is stored
13. no autonomous sending exists
14. market events remain manual-only
15. low-confidence/noisy recs are generally suppressed

---

## 24. Build priority order

Recommended implementation order:

1. shared data model adaptation from Fresh Content
2. HubSpot read integration
3. signal ingestion for `feature_shipped`, `proof_created`, `deal_state_change`
4. doctrine configuration storage
5. structured CRM text extraction (7 categories only)
6. signal-to-deal matching
7. scoring + suppression
8. recommendation feed UI
9. detail view
10. draft generation
11. user action tracking
12. analytics
13. optional conservative write-back

---

## 25. Final implementation bias

If implementation tradeoffs appear, prefer:

* explicit over magical
* inspectable over opaque
* sparse over comprehensive
* reliable over broad
* manual operator control over premature automation

That bias is correct for v1.2.
