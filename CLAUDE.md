# CLAUDE.md — Fresh Editorial Signal Engine

## Commands

- `pnpm test` — run unit tests only (integration tests are excluded); safe to run without a database
- `pnpm test:integration` — apply pending migrations then run all `*.integration.test.ts` against real Postgres; requires `DATABASE_URL`; auto-captures proof to `tests/integration-proof.txt`
- `pnpm run typecheck` — TypeScript type checking
- `pnpm run build` — production build

## Test Architecture

### Unit tests (`tests/*.test.ts`)

Run everywhere, no database required. Use mocks or in-memory WHERE-clause matchers.

### Integration tests (`tests/*.integration.test.ts`)

Require a live PostgreSQL database. All integration test files MUST use the unified skip gate:

1. Probe `DATABASE_URL` with `SELECT 1` at module level
2. When `INTEGRATION=1` is set and DB is unreachable, **fail hard** (never silently skip)
3. When `INTEGRATION` is not set, silently skip via `describe.skipIf`

This ensures `pnpm test` never fails without Postgres, while `pnpm test:integration` gives an unambiguous pass/fail.

### Proof artifact (`tests/integration-proof.txt`)

`pnpm test:integration` pipes verbose output (no ANSI color) to this file via `tee` with `pipefail`. Commit alongside code changes as merge evidence.

## Merge Checklist

### Changes to admin query or disposition logic

Any change touching these files MUST have `pnpm test:integration` run in a DB-backed environment before merge:

- `src/admin/queries.ts`
- `src/admin/pages/source-items.ts`
- `tests/admin-dispositions.integration.test.ts`

Evidence: commit updated `tests/integration-proof.txt` showing all tests passed.

### Changes to DB schema or FK constraints

Any change to `prisma/schema.prisma` affecting SourceItem, EvidenceReference, Opportunity, or OpportunityEvidence MUST also pass `pnpm test:integration`.

### Adding new integration tests

New `*.integration.test.ts` files MUST:

1. Use the unified skip-gate pattern (copy from `admin-dispositions.integration.test.ts` lines 8–40)
2. Create their own Company and all FK-required parent records (self-sufficient fixtures)
3. Use UUID-suffixed IDs to avoid collisions across parallel or repeated runs
4. Clean up all seeded data in `afterAll` (FK deletion order, wrapped in try/catch)
5. Call `prisma.$disconnect()` in `afterAll`

## Pre-merge verification (no-CI workflow)

Run the checked-in verification script from the repo root:

```bash
bash tests/verify-merge-readiness.sh
```

This runs, in order: `pnpm test`, `pnpm run typecheck`, shuffled execution (`pnpm exec vitest run --sequence.shuffle`), focused single-case unit isolation spot-checks, `pnpm test:integration` (refreshes proof artifact), and focused single-case integration isolation spot-checks.

**Key command gotchas:**
- `pnpm test -- --testNamePattern` does NOT forward the flag to vitest. Always use `pnpm exec vitest run --testNamePattern "..."` for focused runs.
- `pnpm test:integration` is a `bash -c` wrapper that does NOT forward CLI args. Focused integration runs must use `INTEGRATION=1 pnpm exec vitest run --testNamePattern "..." tests/<file>.integration.test.ts`.
- For shuffled execution, use `pnpm exec vitest run --sequence.shuffle` (not `pnpm test -- --shuffle`).

## Future Improvements

- **CI enforcement**: add a pre-merge job that runs `pnpm run test:integration` in a DB-backed environment so proof capture is automatic rather than operator-driven
