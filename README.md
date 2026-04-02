# Linc Editorial Signal Engine

Single scheduled TypeScript worker for ingesting internal signals, extracting editorial opportunities, and managing the editorial workflow.

## Commands

- `pnpm sync:daily`
- `pnpm digest:send`
- `pnpm profile:weekly-recompute`
- `pnpm cleanup:retention`
- `pnpm backfill`

## Runtime model

- One worker service
- PostgreSQL for private memory and source of truth
- Slack as notification layer
- Containerized scheduled runtime preferred

## Inputs

- `config/sources/*.json`
- `editorial/doctrine.md`
- `editorial/profiles/*.md`
- `editorial/market-findings/*.md`
- `editorial/sensitivity-rules.md`
