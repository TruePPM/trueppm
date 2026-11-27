/**
 * Schedule fetch-shape guards.
 *
 * 1. Page-fetch burst (#3124, guarding the cap landed in #2277). The page-number
 *    walk reads page 1, derives the full page set from `count`, and fetches the
 *    remainder concurrently. That remainder was once a single unbounded
 *    `Promise.all` — ~25 simultaneous XHRs at the 5 000-row ceiling — and is now
 *    paced through `mapWithConcurrency`. Since #3381 only the `/dependencies/`
 *    read takes this walk, so that is the endpoint the guard watches.
 *
 * 2. Keyset task walk (#3381). `/tasks/` is read with `?pagination=keyset`,
 *    following the cursor in each `next` link one request at a time, and the
 *    schedule renders only once the last page has landed.
 *
 * The unit guards in `useScheduleTasks.test.ts` assert the same shapes against a
 * mocked `apiClient`, which proves the helpers pace their calls but cannot see
 * what the browser does with them. This spec watches real requests leave a real
 * page, so a regression the unit tests do not reach — a second unbounded fetch
 * alongside these, a swapped-out helper, a raised cap — still fails.
 *
 * These are BEHAVIORAL guards, not benchmarks: they assert request-shape
 * invariants, never a duration. Wall-clock numbers on shared CI runners are
 * noise, which is why `perf:load` is explicitly a relative-regression harness.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-burst-0000-0000-0000-000000003124';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

/** Mirrors SCHEDULE_PAGE_SIZE in useScheduleTasks.ts. */
const PAGE_SIZE = 200;
/**
 * The design ceiling the burst guard is sized against. The fixture advertises it
 * as `count` while serving no rows: the walk derives its page set from `count`,
 * so this exercises the real 25-request walk without materializing 5 000 rows.
 */
const TOTAL_DEPENDENCIES = 5000;
const TOTAL_PAGES = Math.ceil(TOTAL_DEPENDENCIES / PAGE_SIZE); // 25
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
      tasks: [makeTask(1, 1)],
    });

    let inFlight = 0;
    let peak = 0;
    const requestedPages: number[] = [];

    // Registered AFTER setupApiMocks so it wins — Playwright matches the most
    // recently registered route first.
    await page.route('**/api/v1/dependencies/**', async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith('/dependencies/')) {
        await route.fallback();
        return;
      }
      // Other surfaces on the page read /dependencies/ too; only the schedule
      // walk asks for SCHEDULE_PAGE_SIZE, so only its requests are measured.
      if (url.searchParams.get('page_size') !== String(PAGE_SIZE)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
        });
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
          count: TOTAL_DEPENDENCIES,
          next: null,
          previous: null,
          results: [],
        }),
      });
    });

    await page.goto(BASE_URL);

    // A rendered row proves the view actually rendered — without this the
    // request assertions below could pass on a page that crashed after fetching.
    await expect(page.getByText('Task p1 r1')).toBeVisible();

    // Every page is still fetched: the cap paces the walk, it does not truncate it.
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

test.describe('Schedule keyset task walk (#3381)', () => {
  test('follows the cursor serially and renders every page', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: [],
    });

    // cursor ('' = first request) -> [page number, cursor of the next page].
    const walk: Record<string, [number, string | null]> = {
      '': [1, 'c1'],
      c1: [2, 'c2'],
      c2: [3, null],
    };
    const requests: { pagination: string | null; cursor: string | null; page: string | null }[] =
      [];
    let inFlight = 0;
    let peak = 0;

    await page.route('**/api/v1/tasks/**', async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith('/tasks/')) {
        await route.fallback();
        return;
      }
      const cursor = url.searchParams.get('cursor');
      requests.push({
        pagination: url.searchParams.get('pagination'),
        cursor,
        page: url.searchParams.get('page'),
      });
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));
      inFlight--;

      const [pageNo, nextCursor] = walk[cursor ?? ''] ?? [0, null];
      const next = nextCursor
        ? `${url.origin}/api/v1/tasks/?pagination=keyset&project=${FIXTURE_PROJECT_ID}&cursor=${nextCursor}`
        : null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          next,
          previous: null,
          results: pageNo ? [makeTask(pageNo, 1), makeTask(pageNo, 2)] : [],
        }),
      });
    });

    await page.goto(BASE_URL);

    // The last page's rows render — the walk reached the end of the cursor chain.
    await expect(page.getByText('Task p3 r2')).toBeVisible();
    await expect(page.getByText('Task p1 r1')).toBeVisible();

    expect(requests.map((r) => r.cursor)).toEqual([null, 'c1', 'c2']);
    expect(requests.every((r) => r.pagination === 'keyset' && r.page === null)).toBe(true);
    // Serial by construction: each request needs the previous page's cursor.
    expect(peak).toBe(1);
  });
});
