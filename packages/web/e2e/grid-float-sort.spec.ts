/**
 * Sortable Total float / Free float on the Table/Grid (#3344).
 *
 * The Schedule outline gets the same two columns and deliberately does NOT sort:
 * its row order IS the work breakdown structure, and a column that reorders it
 * destroys the containment it exists to show (web rule 321). So "rank the plan by
 * slack" — the job the issue is actually about — lands here, on the flat table
 * that already sorts and already owns the CSV export.
 *
 * Two things only a browser settles. The order a header click produces, and the
 * `lg` breakpoint: the header and BOTH row components carry the same
 * `hidden lg:*`, and if they ever disagree the body sits one column out of step
 * with its own heading, which no type check can see.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-flt-00000000-0000-0000-0000-000000003344';
const GRID_URL = `/projects/${PROJECT_ID}/grid`;

function task(
  id: string,
  wbs: string,
  name: string,
  totalFloat: number | null,
  freeFloat: number | null,
) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-04-07',
    early_finish: '2026-04-14',
    planned_start: '2026-04-07',
    duration: 7,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignments: [],
    total_float: totalFloat,
    free_float: freeFloat,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    labels: [],
  };
}

// `Snagging` has NO computed float — CPM has not reached it. It is the row the
// null ordering is about, and it is seeded in the middle so a sort has to move it.
// `Cladding` is the row the PAIR is about: the most total float of the four and
// the least free float, so sorting the two columns must not give the same order.
const TASKS = [
  task('t1', '1', 'Foundation pour', 0, 0),
  task('t2', '2', 'Cladding order', 9, 1),
  task('t3', '3', 'Snagging', null, null),
  task('t4', '4', 'Permit renewal', -3, -3),
];

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
    // Pin Flat mode so the assertions do not depend on the methodology default —
    // and because Outline mode deliberately does not carry these two columns
    // (ADR-0053's precedent: a mode may choose its own column set).
    localStorage.setItem(
      'trueppm.grid.mode.e2e-flt-00000000-0000-0000-0000-000000003344.v1',
      'flat',
    );
  });

  // Catch-all FIRST so an unmocked endpoint cannot 401 and tear the app down
  // mid-render (#2366). The specific routes below win.
  await setupCatchAll(page);

  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  const page1 = (results: unknown[]) => ({
    count: results.length,
    next: null,
    previous: null,
    results,
  });

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill(
      json(
        page1([
          {
            id: PROJECT_ID,
            name: 'Float Sort Project',
            description: '',
            start_date: '2026-04-01',
            calendar: 'default',
          },
        ]),
      ),
    ),
  );
  // The project detail MUST be mocked with its real OBJECT shape — the catch-all
  // serves a list envelope, and a 404 here unmounts the page as ProjectNotFound.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill(
      json({
        id: PROJECT_ID,
        name: 'Float Sort Project',
        methodology: 'WATERFALL',
        effective_methodology: 'WATERFALL',
        agile_features: false,
        start_date: '2026-04-01',
      }),
    ),
  );
  await page.route('**/api/v1/project-resources/**', (route) => route.fulfill(json(page1([]))));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/labels/`, (route) =>
    route.fulfill(json(page1([]))),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill(
      json({
        task_count: TASKS.length,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    ),
  );
  await page.route('**/api/v1/projects/*/sprints/', (route) => route.fulfill(json(page1([]))));
  await page.route('**/api/v1/tasks/**', (route) => route.fulfill(json(page1(TASKS))));
  await page.route('**/api/v1/dependencies/**', (route) => route.fulfill(json(page1([]))));
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill(
      route.request().url().includes('self=true')
        ? json([{ id: 'mem-self', role: 300, role_label: 'Project Manager' }])
        : json(page1([{ id: 'mem-self', role: 300, role_label: 'Project Manager' }])),
    ),
  );
}

/** Row names in render order — the only thing a sort assertion should read. */
async function rowNames(page: Page): Promise<string[]> {
  return page
    .getByRole('row')
    .filter({ hasNot: page.getByRole('columnheader') })
    .locator('[role="gridcell"]')
    .filter({ hasText: /Foundation pour|Cladding order|Snagging|Permit renewal/ })
    .allInnerTexts();
}

async function goto(page: Page) {
  await setup(page);
  await page.goto(GRID_URL);
  // Gate on a ROW, not on the toolbar: the chrome paints before the task read
  // resolves, and every assertion below reads a cell.
  await expect(page.getByText('Cladding order')).toBeVisible({ timeout: 10_000 });
}

test.describe('Table/Grid — sortable float columns (#3344)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('renders both columns with a value per row and an em dash for a pre-CPM row', async ({
    page,
  }) => {
    await goto(page);
    const cladding = page.getByRole('row').filter({ hasText: 'Cladding order' });
    await expect(cladding.getByRole('gridcell', { name: 'Total float: 9 working days' })).toHaveText(
      '9d',
    );
    await expect(cladding.getByRole('gridcell', { name: 'Free float: 1 working day' })).toHaveText(
      '1d',
    );
    const snagging = page.getByRole('row').filter({ hasText: 'Snagging' });
    await expect(
      snagging.getByRole('gridcell', { name: 'Total float: not computed yet' }),
    ).toHaveText('—');
  });

  test('sorts by total float, tightest first, with the unanswered row last', async ({ page }) => {
    await goto(page);
    await page.getByRole('button', { name: 'Sort by total float' }).click();
    await expect(page.getByRole('columnheader', { name: 'Total float' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(await rowNames(page)).toEqual([
      'Permit renewal',
      'Foundation pour',
      'Cladding order',
      'Snagging',
    ]);
  });

  test('keeps the unanswered row last when the sort is reversed', async ({ page }) => {
    // The assertion the shared `dir === asc ? cmp : -cmp` would fail: negating a
    // null comparison floats the rows CPM has not reached to the top of a
    // descending sort, which reads as "these have the most slack".
    await goto(page);
    const header = page.getByRole('button', { name: 'Sort by total float' });
    await header.click();
    await header.click();
    await expect(page.getByRole('columnheader', { name: 'Total float' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(await rowNames(page)).toEqual([
      'Cladding order',
      'Foundation pour',
      'Permit renewal',
      'Snagging',
    ]);
  });

  test('sorts by free float independently of total float', async ({ page }) => {
    // Cladding has the MOST total float and the LEAST free float. If the two
    // columns produced the same order, one of them would not be being read.
    await goto(page);
    await page.getByRole('button', { name: 'Sort by free float' }).click();
    expect(await rowNames(page)).toEqual([
      'Permit renewal',
      'Foundation pour',
      'Cladding order',
      'Snagging',
    ]);
  });

  test('the header and every body row agree that the pair is present', async ({ page }) => {
    // The `hidden lg:*` breakpoint is carried in THREE places — the header cell
    // and both row components — and nothing type-checks that they match. A body
    // that renders a column its heading does not (or the reverse) puts every cell
    // to its right under the wrong label, which reads as wrong DATA rather than
    // as a layout bug, and it appears only at one breakpoint.
    //
    // The assertion is presence-and-count, not x-alignment, and that is a
    // deliberate limit rather than a weaker test. This table's header and body do
    // not share a track model at all: the body row spaces its cells with `gap-2`
    // and the header does not, so EVERY column is already a few pixels out — WBS
    // by 14, Start by 48, Dur by 32, measured at 1440. That is a pre-existing
    // finding about the whole table (filed separately, web rule 366(d): a
    // pre-existing overflow is a finding, not a baseline), and asserting
    // alignment here would fail on it rather than on anything this pair does.
    await goto(page);
    await expect(page.getByRole('columnheader', { name: 'Total float' })).toHaveCount(1);
    await expect(page.getByRole('columnheader', { name: 'Free float' })).toHaveCount(1);
    await expect(page.getByRole('gridcell', { name: /^Total float/ })).toHaveCount(TASKS.length);
    await expect(page.getByRole('gridcell', { name: /^Free float/ })).toHaveCount(TASKS.length);
    // Order: within a row, Total float precedes Free float and both follow Dur.
    const labels = await page
      .getByRole('row')
      .filter({ hasText: 'Cladding order' })
      .locator('[role="gridcell"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
    const iTotal = labels.findIndex((l) => l.startsWith('Total float'));
    const iFree = labels.findIndex((l) => l.startsWith('Free float'));
    expect(iTotal).toBeGreaterThan(-1);
    expect(iFree).toBe(iTotal + 1);
  });
});

test.describe('Table/Grid — float columns below the lg breakpoint (#3344)', () => {
  test.use({ viewport: { width: 1024, height: 800 } });

  test('drops both columns rather than squeezing the Name track', async ({ page }) => {
    // 1024 is `lg`'s own edge; at 1023 the pair is out. The two columns add 128px
    // to a header whose only flexible track is the Name, so keeping them at `md`
    // would trade the column a reader scans by for two they consult.
    await page.setViewportSize({ width: 1023, height: 800 });
    await goto(page);
    await expect(page.getByRole('columnheader', { name: /Total float/ })).toHaveCount(0);
    await expect(page.getByRole('gridcell', { name: /^Total float/ })).toHaveCount(0);
    // The rest of the table is unaffected — this is a column choice, not a
    // different surface (web rule 321).
    await expect(page.getByText('Cladding order')).toBeVisible();
  });
});
