# Linc Editorial Signal Engine

Single scheduled TypeScript worker for ingesting internal signals, extracting editorial opportunities, and synchronizing the editorial workflow into Notion.

## Commands

- `pnpm setup:notion`
- `pnpm sync:daily`
- `pnpm digest:send`
- `pnpm selection:scan`
- `pnpm profile:weekly-recompute`
- `pnpm cleanup:retention`
- `pnpm backfill`

## Runtime model

- One worker service
- PostgreSQL for private memory
- Notion as editorial control center
- Slack as notification layer
- Containerized scheduled runtime preferred

## Inputs

- `config/sources/*.json`
- `editorial/doctrine.md`
- `editorial/profiles/*.md`
- `editorial/market-findings/*.md`
- `editorial/sensitivity-rules.md`
