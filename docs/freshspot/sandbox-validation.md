# Fresh Sales — Sandbox Validation Checklist

## Before first sync

1. `pnpm sales:check-config` — verifies env vars and DB schema
2. `pnpm sales:preflight` — validates HubSpot connectivity end-to-end
3. Fix any FAIL items before proceeding

## Preflight checks

| Check | What it validates | Common failures |
|-------|-------------------|-----------------|
| auth | Token validity, deals read scope | Expired PAT, wrong portal |
| portal | Pipeline API accessible | Missing crm.objects.deals scope |
| doctrine | SalesDoctrine row exists and is valid | Run doctrine setup first |
| pipeline | Configured pipeline ID exists in HubSpot | Copy-paste error in doctrine |
| object_reads:deals | Can search deals in pipeline | Scope or pipeline filter issue |
| object_reads:contacts | Can read a contact by ID | Missing crm.objects.contacts scope |
| object_reads:companies | Can read a company by ID | Missing crm.objects.companies scope |
| object_reads:engagements | Can read an engagement by ID | Missing engagement object scopes |
| assoc:deal→contacts | Deal-to-contact association path works | CRM customization removed standard associations |
| assoc:deal→companies | Deal-to-company association path works | Same |
| assoc:deal→emails | Deal-to-email association path works | Same |
| assoc:deal→notes | Deal-to-note association path works | Same |
| assoc:deal→calls | Deal-to-call association path works | Same |
| assoc:deal→meetings | Deal-to-meeting association path works | Same |

## Readiness flags

- **ok** — no hard failures. Safe to attempt sync.
- **verified** — every capability was actually exercised against real data. If false, some checks reported "unverified" due to missing sample data (e.g., empty pipeline). Create a test deal and re-run preflight.

## After preflight passes

Run `pnpm sales:sync` to execute the first sync.
Monitor warnings in output — they indicate per-record issues that don't block the sync.

## Troubleshooting

| Error class | Meaning | Fix |
|-------------|---------|-----|
| auth_invalid | Token expired or revoked | Regenerate HubSpot Private App token |
| auth_insufficient | Token valid but missing scopes | Add required CRM scopes to Private App |
| pipeline_not_found | Pipeline ID doesn't exist in HubSpot | Check `hubspotPipelineId` in SalesDoctrine |
| pipeline_inaccessible | Token can't access the pipeline | Check Private App scopes |
| doctrine_missing | No SalesDoctrine row | Create one via doctrine setup |
| doctrine_invalid | Doctrine config is malformed | Fix `hubspotPipelineId` and other required fields |
| association_unsupported | CRM association path not available | Check HubSpot CRM customizations |
| rate_limited | Too many API calls | Wait 60s and retry; reduce concurrent processes |
| transient | HubSpot temporarily down | Retry in a few minutes |
