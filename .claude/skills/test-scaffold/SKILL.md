---
name: test-scaffold
model: sonnet
description: >
  Scaffold the three-layer test pattern (pytest API, vitest web units, Playwright E2E)
  when implementing a new feature for which test coverage does not already exist.
  Generates fixtures, mocks, and golden-path + edge-case assertions matching TruePPM
  conventions. Use after a feature's code is in place and before opening the MR —
  every TruePPM MR must ship with tests in the same commit as the code.
---

# Test Scaffold Skill

You are scaffolding tests for a TruePPM feature. **Tests and code ship in the same commit** — never as a follow-up. The CI gate requires coverage at all three layers; an MR without scaffolded tests for new behavior is incomplete.

## When to invoke

- New API endpoint, viewset, serializer, or model method → API + web tests required
- New UI component, hook, or page → web units + Playwright E2E required
- New scheduling-engine feature → scheduler pytest required
- Bug fix → at minimum a regression test that fails on the broken code

## Three-layer matrix

| Layer | Tool | Location | Required when |
|-------|------|----------|---------------|
| API | pytest + pytest-django | `packages/api/<app>/tests/test_*.py` | Any new endpoint, model method, permission, or serializer |
| Web units | vitest | `packages/web/src/**/*.test.ts` | Any new hook, utility, store, or pure component logic |
| E2E | Playwright | `packages/web/e2e/<area>.spec.ts` | Every new user-visible flow or API-backed component |
| Scheduler | pytest | `packages/scheduler/tests/test_*.py` | Any new algorithm or scheduling-engine feature |

## Conventions

### pytest (API)
- Use `pytest-django` fixtures: `db`, `client`, `user_factory`, `project_factory`
- One test class per endpoint or model method; one method per scenario
- Always exercise: golden path, unauthenticated, wrong role, cross-project access, missing required field
- Permission tests use the 5-role matrix (Owner / Admin / Scheduler / Member / Viewer)
- **Fixture grep before writing** — search the project for existing model factories before defining new ones; do not infer model field names from intuition

### vitest (web)
- Co-locate test files: `useColumnWidths.ts` → `useColumnWidths.test.ts`
- Mock TanStack Query with `QueryClientProvider` wrapper or a typed mock
- Mock Zustand stores via store factory pattern (do not mutate global store)
- For API client mocks: `vi.mock('@/api/client', () => ({ ... }))` — keep mock shape parity with actual exports (verify by importing the module before mocking)

### Playwright (E2E)
- Specs live in `packages/web/e2e/<feature>.spec.ts`
- Use the shared MSW fixture (`packages/web/e2e/fixtures/`) for API mocks — do not stub responses inline
- Test golden path + one error/empty state minimum
- **Run locally before push**: `cd packages/web && npx playwright test e2e/<spec>.spec.ts` — type-check passes do not catch role/locator mistakes
- Locator preference: `getByRole` first, `getByLabel` second, `getByTestId` last resort

### Edge cases to always include
- Empty state (no data)
- Error state (network failure / 500)
- Permission boundary (wrong role)
- Concurrent modification (where relevant — sync conflicts)
- Reduced-motion (for animated UI)

## Mock-drift pitfalls

Stale mocks silently pass `tsc` — they break only at runtime. When scaffolding:
- For every imported module the test mocks: confirm the mocked exports match the actual module's current exports
- For every fixture using model factory kwargs: grep the model definition first
- For every assertion on UI copy: grep the component for the actual current string

## Watch the guard fail first

A test written after the fix, that has only ever been seen to pass, proves nothing about
whether it can detect the defect. It may be asserting something unrelated, its fixture may
never reach the failing branch, or its data generator may filter out every input that would
trip it.

**For any test whose purpose is to prevent a specific defect from recurring, run it against
the pre-fix code and confirm it fails.** Stash the source change (not the test), run, and
record the before/after in the MR. If reverting is impractical, construct the failing input
directly and assert the test catches it.

This is not ceremony. In a single 0.4 fix batch it caught:
- an invariant test that **passed against a provably broken engine**, because it reused an
  adversarial data generator whose examples were ~92% rejected by validation before ever
  reaching the code under test
- a scanner whose own pattern was mis-anchored and matched nothing
- a CI gate whose regex could not express the rule it claimed to enforce, which had been
  reporting green across six separate remediation sweeps

State the before/after counts explicitly. "Fails against `origin/main` with N findings,
passes here with 0" is the claim; "added a regression test" is not.

## Scaffolding for a defect class, not a defect

When the test exists because a bug was found, scaffold for the **class**:

- **Enumerate the set, assert over all of it.** If the bug was one route, one authenticator,
  one serializer, or one engine pass, parametrize over every member — ideally derived from
  the live registry (the settings list, the router's children, `__all__`) rather than a
  hand-copied list, so a member added later is covered automatically and a member added
  without a fixture fails loudly.
- **Assert the relationship, not just the value.** Where two code paths must agree —
  two engines, two authenticators, a deterministic pass and its probabilistic sibling, a
  declared schema and an actual response — the durable test asserts the *invariant between
  them*. A 0.4 blocker survived ~99% line coverage because every test checked each path in
  isolation and none checked that they agreed.
- **Guard against vacuous passes.** A parametrized or scanning test that matches zero cases
  passes silently. Assert a non-zero denominator.

## Output

For each scaffolded test file, produce:
1. The full file content (ready to write)
2. A line listing the test scenarios covered
3. Any missing fixtures the user needs to add (with proposed location)

Do not declare "tests done" unless the scaffolded tests **run locally** against the new code. Type-check and run the affected test file before reporting completion.
