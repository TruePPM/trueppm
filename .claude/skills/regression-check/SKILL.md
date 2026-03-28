---
name: regression-check
model: sonnet
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

## Checklist

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

## How to Run

```bash
# Backend
cd packages/api && pytest --tb=short -q

# Scheduler
cd packages/scheduler && pytest --tb=short -q

# Frontend
cd packages/web && npx vitest run

# Mobile
cd packages/mobile && npx jest --passWithNoTests
```

Check the output for:
1. Any test that was passing before and is now failing
2. Any test marked `xfail` that is now unexpectedly passing (may indicate a changed contract)
3. Deprecation warnings that indicate a stale mock

## Output Format

State the verdict: **PASS**, **FAIL**, or **NEEDS REVIEW**.

For each regression found:
```
### [BREAKING|HIGH|MEDIUM] Regression Title
**Area**: API contract / Permissions / Model / Mock / Scheduler / WebSocket
**What broke**: Description of the behavior change
**Affected tests**: list of test names or files
**Fix**: What needs to change to restore compatibility or explicitly version the change
```

If all checks pass: confirm the test suite ran clean and list any areas not covered
by existing tests that warrant a manual smoke test.
