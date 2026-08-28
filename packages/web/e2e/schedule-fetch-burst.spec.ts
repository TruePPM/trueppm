/**
 * Schedule page-fetch burst guard (#3124, guarding the cap landed in #2277).
 *
 * `useScheduleTasks` reads page 1 of `/tasks/`, derives the full page set from
 * `count`, and fetches the remainder concurrently. That remainder was once a
 * single unbounded `Promise.all` — ~25 simultaneous XHRs for a project at the
 * 5 000-task ceiling — and is now paced through `mapWithConcurrency`.
 *
 * The unit guard in `useScheduleTasks.test.ts` asserts the same cap against a
 * mocked `apiClient`, which proves the helper paces its calls but cannot see
 * what the browser does with them. This spec watches real requests leave a real
 * page, so a regression that reintroduces the burst somewhere the unit test does
 * not reach — a second unbounded fetch alongside this one, a swapped-out helper,
 * a raised cap — still fails.
 *
 * It is a BEHAVIORAL guard, not a benchmark: it asserts a request-shape
 * invariant, never a duration. Wall-clock numbers on shared CI runners are
 * noise, which is why `perf:load` is explicitly a relative-regression harness.
 *
 * The fixture advertises `count` at the design ceiling while serving only a
 * couple of rows per page. The hook derives its page set from `count`, not from
 * the rows returned, so this exercises the real 25-request walk without
 * materializing 5 000 rows in a browser.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-burst-0000-0000-0000-000000003124';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

/** Mirrors SCHEDULE_PAGE_SIZE in useScheduleTasks.ts. */
const PAGE_SIZE = 200;
/** MC_TASK_CAP — the documented design ceiling this guard is sized against. */
const TOTAL_TASKS = 5000;
const TOTAL_PAGES = Math.ceil(TOTAL_TASKS / PAGE_SIZE); // 25
/** Mirrors SCHEDULE_FETCH_CONCURRENCY in useScheduleTasks.ts. */
const CONCURRENCY_CAP = 4;

/**
 * Long enough that requests dispatched in the same tick are provably in flight
 * together — without a delay every response resolves before the next request is
 * issued and the observed peak would read 1 whatever the cap was.
 */
const RESPONSE_DELAY_MS = 40;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Burst Guard Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function makeTask(page: number, row: number) {
  return {
    id: `p${page}-r${row}`,
    wbs_path: `${page}.${row}`,
    name: `Task p${page} r${row}`,
    early_start: '2026-04-01',
    early_finish: '2026-04-05',
    planned_start: '2026-04-01',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  };
}

test.describe('Schedule page-fetch burst (#3124)', () => {
  test('paces the remaining-page fetch instead of dispatching it as one burst', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: [],
    });

    let inFlight = 0;
    let peak = 0;
    const requestedPages: number[] = [];

    // Registered AFTER setupApiMocks so it wins — Playwright matches the most
    // recently registered route first.
    await page.route('**/api/v1/tasks/**', async (route) => {
      const url = new URL(route.request().url());
      // Only the schedule's list read, not any /tasks/<id>/... subpath.
      if (!url.pathname.endsWith('/tasks/')) {
        await route.fallback();
        return;
      }

      const pageParam = Number(url.searchParams.get('page') ?? 1);
      requestedPages.push(pageParam);
      inFlight++;
      peak = Math.max(peak, inFlight);

      await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));
      inFlight--;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: TOTAL_TASKS,
          next: null,
          previous: null,
          results: [makeTask(pageParam, 1), makeTask(pageParam, 2)],
        }),
      });
    });

    await page.goto(BASE_URL);

    // A row from page 1 proves the view actually rendered — without this the
    // request assertions below could pass on a page that crashed after fetching.
    await expect(page.getByText('Task p1 r1')).toBeVisible();

    // Every page is still fetched: the cap paces the walk, it does not truncate
    // it. Asserted at the request layer because a canvas Gantt virtualizes its
    // rows, so "row 50 is in the DOM" would be a claim about the viewport.
    await expect
      .poll(() => requestedPages.length, {
        message: `expected all ${TOTAL_PAGES} pages to be requested`,
      })
      .toBe(TOTAL_PAGES);

    const sorted = [...requestedPages].sort((a, b) => a - b);
    expect(sorted[0]).toBe(1);
    expect(sorted[sorted.length - 1]).toBe(TOTAL_PAGES);
    expect(new Set(requestedPages).size).toBe(TOTAL_PAGES);

    // The guard itself. Before #2277 this read 24.
    expect(peak).toBeLessThanOrEqual(CONCURRENCY_CAP);
  });
});
