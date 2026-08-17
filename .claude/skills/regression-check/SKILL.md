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

5. **E2E spec drift** (web changes only): "For these changed UI files `<list>`,
   grep `packages/web/e2e/` for assertions referencing the affected component
   names, menu items, section titles, ARIA labels, keyboard bindings, or
   strict-mode text. Report every assertion that asserts a state the source
   no longer holds (e.g., `'Insert below'` after the menu item was removed,
   `'five sections'` after a section was added, `press(' ')` opening the
   drawer after Space rebinds to Mark complete). E2E specs live in a separate
   tree from the source and are the #1 source of post-push `web:e2e`
   failures — co-located vitest assertions are easy to spot, Playwright
   ones are not."

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

### E2E Spec Drift (web changes only)
- [ ] For every changed component, grep `packages/web/e2e/` for the component's
  test-id, accessible name, aria-label, or visible text used in spec assertions
- [ ] For menu / section additions or removals, search `packages/web/e2e/` for
  literal counts ("five sections") or sibling section / menu-item names that
  will no longer match after the change
- [ ] For keyboard rebinds, grep `packages/web/e2e/` for `press(...)` and
  `keyboard.press(...)` patterns referencing the old key
- [ ] For copy / placeholder / label changes, grep `packages/web/e2e/` for the
  old string
- [ ] Run the affected spec locally:
  `cd packages/web && npx playwright test e2e/<spec>.spec.ts`

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

## The recurrence check — run this on every branch that fixes a defect

A fix that lands only where the bug was found is half a fix. The other half is the
mechanism that finds the *next* instance. Ten independent findings in the 0.4 pre-release
audit — including all three release blockers — were one finding wearing ten costumes: **a
defect class was fixed at its known instances, and the guard that would catch the next
instance was never written, or was written narrower than the class it names.**

For any branch that fixes a bug, ask these three in order:

1. **Does this defect have siblings?** A fix applied to one member of a set almost never
   belongs to only that member. Enumerate the set structurally, then check every member:
   - one implementation of an interface fixed → check every other implementation
     (authenticators, serializers, permission classes, engine passes, consumers)
   - one call site fixed → grep the shape of the call, not the name of the function
   - one route/page/component fixed → enumerate the sibling routes/pages/components
   - one deployment path fixed → check the other rendering paths of the same config

   Report the sweep's denominator: "checked N members of the set, M were affected." A fix
   with no stated denominator has not had this check.

2. **What guard should have caught this, and why didn't it?** There are three answers, and
   they need different fixes:
   - **No guard exists** → the fix is incomplete without one.
   - **A guard exists but is narrower than the class it names** — it samples a couple of
     instances where the rule is universal, or checks one tier of a multi-tier surface.
     Widen it to the class.
   - **A guard exists and is structurally incapable of matching the defect** — its pattern
     cannot express the thing it claims to check, so it has been reporting green while
     blind. **This is the most dangerous case and the hardest to see**, because the gate's
     own output is evidence *for* the code. Read the guard's implementation against its
     stated rule; do not infer coverage from a passing run.

3. **Has this class been fixed before?** Search the tracker for the *class*, not the symptom.
   If prior issues fixed the same class elsewhere, that is proof the point-fix approach has
   already failed, and a guard is mandatory rather than optional. Cite the prior issues.

**When no reliable guard is possible, say so with reasoning** — that is a legitimate and
useful outcome. A semantic judgement (is this a primary data surface? is this error path
user-visible?) often cannot be mechanized, and an over-broad rule that misfires gets
disabled, taking the real protection with it. In that case gate the part that *is*
mechanizable — frequently the population size, as a ratchet — so the trend is at least
observed.

## Tests that encode the defect

A green suite is not evidence of correct behavior when a test asserts the bug. Three
instances appeared in a single 0.4 fix batch: a spec pinning the exact enum value the API
rejects; a test asserting an optimistic-update wipe was correct; and a hardening test
asserting the **inverse** of the true invariant, documented as a contract, which passed only
because its fixture happened to land on the boundary where both readings agree.

So when a fix makes an existing test fail, **do not adjust the test to match the new
behavior until you have established which one was right.** A failing test after a fix is a
question, not a chore. Check specifically for:

- an assertion pinning a literal that the production code path rejects
- a test whose fixture sits exactly on a boundary, so opposite invariants both pass
- a docstring or comment asserting a contract that the code does not implement
- a "regression test" for a prior issue whose fixture cannot reach the regressed path
  (verify the fixture actually exercises the condition, not just the function)

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
