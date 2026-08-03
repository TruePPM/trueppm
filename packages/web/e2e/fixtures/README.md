# Playwright shared fixtures

`setupAuth` + `setupApiMocks` + `setupCatchAll` wrap the boilerplate that
every e2e spec used to inline. They exist for two reasons:

1. **Kill `ECONNREFUSED 127.0.0.1:8000` log noise.** Without a catch-all,
   any unmocked endpoint falls through Vite's dev-mode proxy to the API
   container that isn't running during e2e, flooding traces with proxy
   errors. After this fixture, an unmocked endpoint returns a typed `404`
   with a one-line console warning naming the URL — failures are visible
   instead of hidden.

2. **Halve per-spec boilerplate.** A typical spec used ~150 lines of
   `page.route(...)` setup; with the fixture that drops to ~10 lines plus
   any test-specific overrides.

## Usage

```ts
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

test.describe('My feature', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);                 // 1. catch-all FIRST
    await setupApiMocks(page, {                // 2. specifics AFTER (override the catch-all)
      projects: [{ id: 'my-project-id', name: 'My Project' }],
      projectId: 'my-project-id',
      tasks: [/* ... */],
      boardConfig: { columns: [/* ... */] },
    });
    await page.goto('/projects/my-project-id/board');
  });

  test('does the thing', async ({ page }) => {
    // Test-specific routes register LAST and win for those URLs.
    await page.route('**/api/v1/projects/my-project-id/special/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    // ... assertions
  });
});
```

## Route order

Playwright matches `page.route(...)` registrations in **reverse registration
order** — the last `page.route` call wins for a matching URL. To make the
catch-all work as a fallback for *unmocked* endpoints, register it FIRST so
that more-specific handlers (registered later) override it for matched URLs.

The recommended order inside any `beforeEach` or shared setup is:

1. `setupAuth(page)` — injects auth state.
2. `setupCatchAll(page)` — registers the broadest glob (`**/api/v1/**`) as a
   404 fallback. Lowest priority.
3. `setupApiMocks(page, opts)` — registers more-specific handlers for common
   auxiliaries. Wins over the catch-all.
4. (inside test bodies) `page.route(...)` — wins over `setupApiMocks` for the
   specific URLs the test needs.

## What's mocked by default

`setupApiMocks(page, opts)` covers these endpoints with sensible 200-empty or
typed defaults; pass `opts` to override for test-specific data:

- `GET /api/v1/edition/` → `{ edition: 'community' }`
- `GET /api/v1/auth/me/` → `DEFAULT_USER`
- `GET /api/v1/calendars/` → empty paginated list
- `GET /api/v1/projects/` → `opts.projects` or `[DEFAULT_PROJECT]`
- `GET /api/v1/projects/*/presence/` → `[]`
- `GET /api/v1/projects/*/attention/` → `{ items: [] }`
- `GET /api/v1/projects/*/my-tasks/` → `{ tasks: [] }`
- `GET /api/v1/projects/*/workshop/current/` → `404 No active workshop session.`
- `GET /api/v1/projects/*/resource-allocation/**` → empty resources
- `GET /api/v1/monte-carlo/**` → empty runs
- `GET /api/v1/projects/{id}/overview/` → `opts.overview` merged with empty defaults
- `GET /api/v1/projects/{id}/status-summary/` → `opts.statusSummary` merged with empty defaults
- `GET /api/v1/projects/{id}/members/` → `opts.members` or `[{ id: 'mem-admin', role: 300 }]`
- `GET /api/v1/projects/{id}/risks/**` → `opts.risks` or empty
- `GET /api/v1/projects/{id}/board-config/` → `opts.boardConfig` or canonical 5-column set; `PUT` echoes the body
- `GET /api/v1/projects/{id}/board-views/` → `opts.boardViews` or `[]`; `POST` echoes a created view
- `GET /api/v1/tasks/**` → `opts.tasks` or empty (other methods fall through to test-specific routes)
- `GET /api/v1/dependencies/**` → `opts.dependencies` or empty

## Asserting on the DOM *after* a write — use `setupTaskStore`

Every route above is **stateless**: it re-serves the same fixture on every request.
That is correct for a spec that only reads, and a silent race for a spec that
writes, because `useUpdateTask` patches the cache optimistically in `onMutate` and
then **invalidates `['tasks', projectId]` in `onSuccess`**. The refetch the app's own
success handler fires re-serves the *original* `opts.tasks`, so the committed value
lives for the few tens of milliseconds between the optimistic render and the refetch
landing. Under CI worker contention Playwright's poll misses that window; the spec
then fails nondeterministically and only on a loaded runner (#2752).

Raising the assertion timeout does not help — after the refetch the value is gone
permanently, so a 5 s and a 60 s `toBeVisible` fail identically.

**Rule: if a spec asserts DOM state after a write, the read endpoint it refetches
must echo that write.** For tasks, that is `setupTaskStore` — a live row array the
PATCH handler mutates and the list/detail GETs serve:

```ts
const store = await setupTaskStore(page, { tasks: FIXTURE_TASKS });
// ... commit an edit ...
await expect.poll(() => store.patches.length).toBeGreaterThan(0);  // request-side contract
await expect(page.getByText('the committed name')).toBeVisible();  // stable end state
```

Register it **after** `setupApiMocks` and omit `opts.tasks` — the store owns every
`/tasks/` read, and leaving the stateless default registered too puts two sources of
truth for one list a route-precedence change apart. Requests the store does not own
(`POST`, `DELETE`, nested paths like `/tasks/{id}/notes/`) `route.fallback()` to the
handlers below it, so existing mocks are untouched.

Pass `applyPatch` whenever a write field is **write-only** on the serializer and
reads back under another name — `owners` (write) → `assignments` (read). The default
shallow merge would otherwise put a field on the row that the real API never returns,
and the spec would be asserting against a shape the server cannot produce.

## Adding a new auxiliary endpoint

If a new endpoint is needed by 3+ specs, add it to `setupApiMocks` rather
than copy-pasting the route. Two-step add:

1. Add the option to `ApiMockOptions` (or use sensible defaults if no
   override is needed).
2. Add the `page.route(...)` registration inside `setupApiMocks`. Watch the
   ordering: project-scoped wildcards before project-id-specific routes.

## Migrating an existing spec

1. Replace the spec's `setup(page)` helper body with the fixture calls.
2. Move test-specific routes (POST handlers, custom filters) into the test
   body (so they register after `setupApiMocks` and win).
3. Run the spec locally: `npx playwright test e2e/<spec>.spec.ts`. Expect a
   reduction of ~50 lines and zero `ECONNREFUSED` lines in the trace.

## Out of scope (not handled by this fixture)

- **WebSocket proxy errors.** Vite's WS proxy still produces `ws proxy
  error` lines because Playwright's `page.route` does not intercept
  WebSocket upgrades. Use `page.routeWebSocket(...)` (Playwright 1.48+) per
  spec when needed.
- **Real backend integration.** A separate `web:integration` CI job that
  runs against a real Django container is tracked in #156.
