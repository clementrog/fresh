#!/usr/bin/env bash
# verify-merge-readiness.sh — Pre-merge proof workflow for admin UI changes
#
# Runs the full verification suite that CI would run if we had it.
# Execute from the repo root:  bash tests/verify-merge-readiness.sh
#
# Requirements:
#   - DATABASE_URL pointing at a reachable Postgres
#   - Node/pnpm installed
#
# Exit codes:
#   0  All checks passed, proof artifact refreshed
#   1  A check failed — see output for details

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
RESET="\033[0m"

pass() { echo -e "${GREEN}PASS${RESET} $1"; }
fail() { echo -e "${RED}FAIL${RESET} $1"; exit 1; }
step() { echo -e "\n${BOLD}── $1${RESET}"; }

# ── 1. Unit tests ──────────────────────────────────────────────────────────

step "Unit tests (pnpm test)"
pnpm test || fail "pnpm test"
pass "pnpm test"

# ── 2. Type check ─────────────────────────────────────────────────────────

step "Type check (pnpm run typecheck)"
pnpm run typecheck || fail "pnpm run typecheck"
pass "pnpm run typecheck"

# ── 3. Shuffled execution ─────────────────────────────────────────────────

step "Shuffled execution (proves no order-dependent flakes)"
pnpm exec vitest run --sequence.shuffle --exclude='**/*.integration.test.ts' || fail "shuffled execution"
pass "shuffled execution"

# ── 4. Focused single-case isolation (unit) ───────────────────────────────
# Spot-check that --testNamePattern actually narrows to 1 case.
# NOTE: pnpm test -- --testNamePattern does NOT forward the flag.
#       Always use: pnpm exec vitest run --testNamePattern "..."

step "Focused unit-test isolation spot-checks"

check_focused() {
  local pattern="$1"
  local output
  output=$(pnpm exec vitest run --testNamePattern "$pattern" --exclude='**/*.integration.test.ts' 2>&1)
  local passed
  passed=$(echo "$output" | grep -Eo '[0-9]+ passed' | head -1 | cut -d' ' -f1)
  if [[ "$passed" != "1" ]]; then
    echo "$output"
    fail "Expected 1 passed for pattern '$pattern', got '${passed:-0}'"
  fi
  pass "  '$pattern' → 1 passed"
}

check_focused "listEditorialConfigs passes companyId"
check_focused "drafts filter renders dynamic profileId options from query"
check_focused "run detail with 0 cost entries shows"

# ── 5. DB-backed integration tests ────────────────────────────────────────

step "Integration tests (pnpm test:integration)"
pnpm test:integration || fail "pnpm test:integration"
pass "pnpm test:integration — proof artifact refreshed at tests/integration-proof.txt"

# ── 6. Focused integration-case isolation ─────────────────────────────────
# pnpm test:integration is a bash -c wrapper that does NOT forward CLI args.
# Focused runs must invoke vitest directly.

step "Focused integration-case isolation spot-checks"

check_focused_integration() {
  local pattern="$1"
  local output
  output=$(INTEGRATION=1 pnpm exec vitest run --testNamePattern "$pattern" tests/admin-expansion.integration.test.ts 2>&1)
  local passed
  passed=$(echo "$output" | grep -Eo '[0-9]+ passed' | head -1 | cut -d' ' -f1)
  if [[ "$passed" != "1" ]]; then
    echo "$output"
    fail "Expected 1 passed for integration pattern '$pattern', got '${passed:-0}'"
  fi
  pass "  '$pattern' → 1 passed"
}

check_focused_integration "getDraft returns draft with included opportunity and evidence"
check_focused_integration "listSourceConfigs returns both enabled and disabled"
check_focused_integration "getRun returns run with costEntries ordered by createdAt"

# ── 7. Notion pull-edits round-trip smoke test ──────────────────────────────
# Runs the pull-edits command in dry-run mode against the configured Notion
# workspace. Verifies the command can reach Notion, query the database, and
# report discovered re-evaluation requests without writing anything.
# Requires NOTION_TOKEN and NOTION_PARENT_PAGE_ID in .env.

step "Notion pull-edits dry-run smoke test"
if [[ -n "${NOTION_TOKEN:-}" && -n "${NOTION_PARENT_PAGE_ID:-}" ]]; then
  output=$(pnpm opportunity:pull-notion-edits -- --dry-run 2>&1) || fail "pull-notion-edits dry-run"
  echo "$output" | tail -5
  pass "pull-notion-edits dry-run completed — Notion connectivity verified"
else
  echo "  NOTION_TOKEN or NOTION_PARENT_PAGE_ID not set, skipping Notion smoke test"
  pass "skipped (no Notion credentials)"
fi

# ── Done ───────────────────────────────────────────────────────────────────

step "All checks passed"
echo "Proof artifact: tests/integration-proof.txt"
echo "Ready to merge."
