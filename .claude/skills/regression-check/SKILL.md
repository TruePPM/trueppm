---
name: regression-check
model: opus
description: >
  Regression audit for TruePPM before opening an MR on any branch that changes source
  code. Verifies that existing behavior is not broken: no stale mocks, no permission
  regressions, no broken test suites. Run before /mr on any branch touching models,
  serializers, views, API clients, hooks, or components.
---

# Regression Check Skill

You are verifying that a TruePPM branch does not introduce regressions before merge.

## Scope

This check applies to any branch that modifies:
- Django models, migrations, or managers
- DRF serializers or viewsets
- Celery tasks
- Django Channels consumers
- React components, hooks, or stores
- React Native screens or sync logic
- The `trueppm-scheduler` engine

It does NOT apply to: docs-only, test-only, CI config, or dependency-bump branches.

## Execution pattern — orchestrate, do not scan

This skill is an **orchestrator**, not a wide-scan tool. Doing the entire audit inline in
main context burns Opus tokens on grep output and pollutes the rest of the session. Use
this decomposition:

### Tier 1 — Deterministic checks (no LLM)

Run these as `Bash` calls; they are pure pattern matching:

| Check | Command | Cost |
|-------|---------|------|
| Test suite still compiles | `cd packages/api && pytest --co -q` | free |
| Frontend type-check | `cd packages/web && npx tsc --noEmit` | free |
| Migration completeness | `cd packages/api && python manage.py makemigrations --check --dry-run` | free |
| OpenAPI schema not drifted | `bash scripts/export-openapi.sh --check` | free |
| Affected test files run | `pytest <path>` for each changed test file | free |

If any tier-1 check fails, stop here and report. Do not delegate.

### Tier 2 — Scoped pattern audits (Sonnet sub-agents, parallel)

For the changes that survive tier 1, spawn parallel Sonnet sub-agents — one per
audit dimension, each scoped to the changed files only. Use the `Agent` tool with
`model: "sonnet"` in a single message:

1. **Stale mocks**: "For these changed exports `<list>`, find every test file that
   imports/mocks them. Verify the mock surface matches the current export shape. Report
   only mismatches."

2. **Permission regressions**: delegate to the `rbac-check` skill / sub-agent rather
   than re-implementing. Pass the changed viewsets/serializers as scope.

3. **Fixture drift**: "For these changed Django models `<list>`, grep test fixtures
   and factories for kwarg references. Report any kwarg that is not a current model
   field."

4. **Contract regressions**: "For these changed serializers/endpoints `<list>`,
   compare with the version on `main` (`git show main:<file>`). Report removed
   fields, type changes, removed required fields."

Each sub-agent returns a structured finding list. Aggregate in main context.

### Tier 3 — Reasoning (main context, only when needed)

Use main-context reasoning **only** for:
- Cross-cutting questions that span multiple sub-agent findings ("does the same change
  also need a migration?")
- Judgment calls about whether a change is intentional vs accidental
- Producing the final verdict

Do not run grep loops in main context for items tier 1 or tier 2 already covered.

## Manual checklist (for cases where the orchestrator is over-engineered)

For a small change (< 5 files), the tier-2 spawn overhead is not worth it. Run this
checklist inline:

### API Contract Regressions
- [ ] No existing endpoint has had a field removed (breaking change for clients)
- [ ] No existing endpoint has changed a field type (e.g., int → string)
- [ ] No existing required field has been made optional without a migration default
- [ ] No URL path has changed without a redirect or version bump
- [ ] `server_version` semantics are unchanged (still monotonically increasing)

### Permission Regressions
- [ ] No endpoint that previously required auth has been made public
- [ ] No endpoint that was role-gated has had its permission class weakened
- [ ] Project membership checks still apply on all object-level endpoints
- [ ] Cross-project data isolation is intact

### Model / Migration Safety
- [ ] No column removed without a prior deprecation cycle
- [ ] No NOT NULL column added without a `default=` in the migration
- [ ] No index removed that existing queries depend on (check `wbs_path` GiST, FK indexes)
- [ ] Migration is reversible (`./manage.py migrate app 0001` works after applying)
- [ ] `server_version` auto-increment is not broken by the model change

### Stale Mocks
- [ ] If a module's exported API changed (new function, renamed arg, removed export),
  every test file that mocks that module has been updated
- [ ] Frontend mocks of API responses match the current serializer output
- [ ] Celery task signatures in tests match the actual task signatures

### Scheduler Engine
- [ ] CPM output (early_start, early_finish, late_start, late_finish, total_float,
  is_critical) is unchanged for existing test fixtures
- [ ] Monte Carlo distribution shape is unchanged for seeded inputs
- [ ] `CyclicDependencyError` still raised on cycles (not silently ignored)

### WebSocket / Real-time
- [ ] Event type strings are unchanged (clients subscribed to old event types still work)
- [ ] Channel group naming convention is unchanged (`project_{pk}`)
- [ ] Consumer auth logic is not weakened

## Output format

State the verdict: **PASS**, **FAIL**, or **NEEDS REVIEW**.

For each regression found:

```
### [BREAKING|HIGH|MEDIUM] Regression Title
**Area**: API contract / Permissions / Model / Mock / Scheduler / WebSocket
**What broke**: Description of the behavior change
**Affected tests**: list of test names or files
**Fix**: What needs to change to restore compatibility or explicitly version the change
```

If all checks pass: confirm the test suite ran clean, name the tier-2 sub-agents that
were spawned, and list any areas not covered by existing tests that warrant a manual
smoke test.

## Future hardening

Tier 1 deterministic checks are the only zero-cost layer. As the codebase grows, more
tier-2 patterns should migrate to deterministic scripts in `scripts/`. Tracked work:

- `scripts/check-stale-mocks.sh` — AST-walk test files, compare mocked exports to actual
  module exports. Tracked separately.
- `scripts/check-fixture-drift.sh` — parse Django models, grep factory kwargs in tests,
  flag mismatches. Tracked separately.

When these scripts exist, they replace the corresponding tier-2 sub-agent and become
pre-commit hooks. The skill's tier-2 falls back to "for any deterministic-script
target that does not yet exist, spawn a Sonnet sub-agent."
