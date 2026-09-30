import { test, expect, type Page, type TestInfo } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, type UserFixture } from './fixtures';

/**
 * The Today view at phone width (#4238).
 *
 * A design review of the hosted demo at 375px found the Queue-layout board unreadable:
 * the six-track row grid's minimum widths summed past the viewport, so every task name
 * collapsed to nothing (three rows under one phase were indistinguishable), the CP /
 * milestone / risk badges spilled over the status text, and the page scrolled sideways.
 * The mobile "Add task" button also rendered in the read-only demo, where every create
 * is refused.
 *
 * Geometry is asserted, not pixels: the repo keeps no screenshot baselines (a macOS
 * baseline would never match the Linux CI image), so each width attaches its screenshot
 * to the report for review and the assertions pin the properties the review was about —
 * no horizontal overflow, a visible name on every row, no badge painted over the status.
 */

const PROJECT_ID = 'e2e-today-mobile-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Migration Tooling',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    effective_methodology: 'HYBRID',
  },
];

function unifiedUser(): UserFixture {
  return {
    id: 'e2e-user',
    username: 'e2euser',
    display_name: 'E2E User',
    initials: 'EU',
    email: 'e2e@example.com',
    default_landing: 'my_work',
    landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
    hidden_views: [],
    role_context: 'unified',
  };
}

const OVERVIEW = {
  schedule_health: 'on_track' as const,
  spi: 1.0,
  tasks_late_count: 0,
  critical_task_count: 2,
  total_tasks: 7,
  complete_tasks: 1,
  next_milestone: { id: 'm1', name: 'Cutover complete', date: '2026-11-01', percent_complete: 0 },
};

const alice = [{ resource_id: 'r-1', resource_name: 'Alice Moreno', units: 1 }];

/**
 * Three rows under ONE phase is the review's case: with the name track squeezed to zero
 * only the phase chip showed, so they were indistinguishable. Every badge the row can
 * carry is present, plus an unassigned, unestimated row.
 */
const TASKS = [
  {
    id: 'ph',
    name: 'Cutover',
    status: 'NOT_STARTED',
    wbs_path: '3',
    is_summary: true,
    is_phase: true,
  },
  {
    id: 'c1',
    name: 'Freeze writes on the legacy cluster',
    status: 'NOT_STARTED',
    wbs_path: '3.1',
    parent_id: 'ph',
    duration: 2,
    is_critical: true,
    linked_risks_count: 2,
    assignments: alice,
  },
  {
    id: 'c2',
    name: 'Run the final delta sync',
    status: 'IN_PROGRESS',
    percent_complete: 40,
    wbs_path: '3.2',
    parent_id: 'ph',
    duration: 3,
    is_critical: true,
    assignments: alice,
  },
  {
    id: 'c3',
    name: 'Cutover sign-off',
    status: 'NOT_STARTED',
    wbs_path: '3.3',
    parent_id: 'ph',
    duration: 0,
    is_milestone: true,
    assignments: alice,
  },
  {
    id: 'c4',
    name: 'Write the rollback runbook for the storage tier',
    status: 'NOT_STARTED',
    wbs_path: '3.4',
    parent_id: 'ph',
    duration: 0,
  },
  {
    id: 'c5',
    name: 'Decommission the legacy read replicas',
    status: 'IN_PROGRESS',
    percent_complete: 10,
    wbs_path: '3.5',
    parent_id: 'ph',
    duration: 5,
    linked_risks_count: 1,
    assignments: alice,
  },
];

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function paginated(results: unknown[]) {
  return { count: results.length, next: null, previous: null, results };
}

async function setup(page: Page, opts: { demoReadOnly?: boolean; tasks?: unknown[] } = {}) {
  // The Today view's board honors the persisted toolbar layout; the review's device had
  // the Queue layout selected.
  await page.addInitScript(() => {
    localStorage.setItem('trueppm.board.toolbarPrefs.v1', JSON.stringify({ layout: 'queue' }));
  });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    user: unifiedUser(),
    overview: OVERVIEW,
    tasks: opts.tasks ?? TASKS,
    demoReadOnly: opts.demoReadOnly ?? false,
  });
  // The reads the page makes beyond the shared fixture, each with its real shape
  // (mirrors today-view.spec.ts) so nothing leans on the catch-all.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill(
      json({
        sprints: [],
        rolling_avg_points: null,
        rolling_stdev_points: null,
        forecast_range_low: null,
        forecast_range_high: null,
        rolling_avg_tasks: null,
        rolling_stdev_tasks: null,
        team_velocity_per_day: null,
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/forecast/`, (route) =>
    route.fulfill(
      json({
        velocity: {
          sprints: [],
          rolling_avg_points: null,
          rolling_stdev_points: null,
          forecast_range_low: null,
          forecast_range_high: null,
          rolling_avg_tasks: null,
          rolling_stdev_tasks: null,
          team_velocity_per_day: null,
        },
        remaining_committed_points: 0,
        sprints_to_complete_low: null,
        sprints_to_complete_high: null,
        milestones: [],
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/fields/`, (route) => route.fulfill(json([])));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/labels/`, (route) =>
    route.fulfill(json(paginated([]))),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/visit/`, (route) =>
    route.fulfill(json({ ok: true })),
  );
  await page.route('**/api/v1/me/timer/', (route) => route.fulfill(json({ active: false })));
  await page.route('**/api/v1/programs/', (route) => route.fulfill(json(paginated([]))));
}

/** Navigate and wait for the page-rendered signal: the strip AND a real queue row. */
async function openToday(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/today`);
  await expect(page.getByTestId('schedule-pulse')).toBeVisible();
  await expect(page.getByTestId('queue-row-c1')).toBeVisible();
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

for (const width of [375, 430]) {
  test.describe(`Today view at ${width}px (#4238)`, () => {
    test.use({ viewport: { width, height: 844 } });

    test('the page never scrolls sideways', async ({ page }, testInfo) => {
      await setup(page);
      await openToday(page);
      await attachScreenshot(page, testInfo, `today-${width}`);

      const { scrollWidth, clientWidth, bodyScrollWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      expect(bodyScrollWidth).toBeLessThanOrEqual(clientWidth);

      // A row that overflowed would be clipped by the queue's own scroller rather than
      // the page, so the page check alone would pass. Each row must fit its list too.
      const layout = page.getByTestId('queue-layout');
      const fits = await layout.evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(fits).toBe(true);
    });

    test('every row shows its own name, and no badge paints over the status', async ({ page }) => {
      await setup(page);
      await openToday(page);

      for (const task of TASKS.filter((t) => t.id !== 'ph')) {
        const row = page.getByTestId(`queue-row-${task.id}`);
        await row.scrollIntoViewIfNeeded();
        const name = row.getByText(task.name, { exact: true });
        await expect(name).toBeVisible();
        const nameBox = await name.boundingBox();
        // The review's failure was a name track of ~0px. Half the row is a
        // generous floor; at 375px the name gets ~290px.
        const rowBox = await row.boundingBox();
        expect(nameBox && rowBox && nameBox.width >= Math.min(120, rowBox.width / 2)).toBe(true);

        // Badges live in the name cluster, status in the meta line: the cluster's box
        // must not intersect the status text ("CPdo" in the review).
        const cluster = row.getByTestId('queue-row-name');
        const meta = row.getByTestId('queue-row-meta');
        const clusterBox = await cluster.boundingBox();
        const status = meta.getByText(/^(To do|In progress|Review|Done|Backlog)$/);
        if ((await status.count()) > 0) {
          const statusBox = await status.first().boundingBox();
          expect(clusterBox && statusBox && overlaps(clusterBox, statusBox)).toBe(false);
        }
      }

      // Unassigned and unestimated reads as a fact, not as a loading skeleton.
      const unowned = page.getByTestId('queue-row-c4');
      await expect(unowned.getByTestId('queue-row-unassigned')).toHaveText('Unassigned');
      await expect(unowned.getByTestId('queue-row-no-duration')).toBeVisible();
    });

    test('the last row scrolls clear of the Add task button', async ({ page }) => {
      // Enough rows that the list is taller than the phone, so the last one really
      // does end under the FAB unless the scroller reserves room for it.
      const filler = Array.from({ length: 24 }, (_, i) => ({
        id: `f${i}`,
        name: `Filler task ${i + 1}`,
        status: 'NOT_STARTED',
        wbs_path: `3.${i + 10}`,
        parent_id: 'ph',
        duration: 1,
        assignments: alice,
      }));
      await setup(page, { tasks: [...TASKS, ...filler] });
      await openToday(page);
      const fab = page.getByRole('button', { name: 'Add task' });
      await expect(fab).toBeVisible();

      const layout = page.getByTestId('queue-layout');
      await layout.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      // The scroller's LAST content (its final group section — trailing groups can be
      // empty, so this is not always a row) must end above the FAB once scrolled down.
      const lastContent = layout.locator(':scope > section').last();
      const rowBox = await lastContent.boundingBox();
      const fabBox = await fab.boundingBox();
      expect(rowBox && fabBox && rowBox.y + rowBox.height <= fabBox.y).toBe(true);
    });

    test('the location label is a readable leaf or visually absent — never a fragment', async ({
      page,
    }) => {
      await setup(page);
      await openToday(page);
      const nav = page.getByRole('navigation', { name: 'Location' });
      const leaf = nav.locator('[aria-current="page"]');
      // Announced at every width, drawn or not.
      await expect(leaf).toHaveText('Today');
      // Measured at 430px before #4238 the bar gave this nav 47px: "M ›" plus a lone
      // ellipsis. Below md it is the leaf alone...
      await expect(nav).not.toContainText('›');
      // ...and it is either drawn in full-enough width to read, or sr-only (the
      // leftover width cannot hold it). A sliver of a few px is the failure.
      const state = await leaf.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          visuallyHidden: cs.position === 'absolute' && el.getBoundingClientRect().width <= 1,
          width: el.getBoundingClientRect().width,
        };
      });
      if (!state.visuallyHidden) expect(state.width).toBeGreaterThanOrEqual(30);
    });
  });
}

test.describe('Today view in the read-only demo (#4238)', () => {
  test.use({ viewport: { width: 375, height: 844 } });

  test('offers no Add task button — create is withheld up front, not refused after', async ({
    page,
  }, testInfo) => {
    await setup(page, { demoReadOnly: true });
    await openToday(page);
    await attachScreenshot(page, testInfo, 'today-375-demo');
    await expect(page.getByRole('button', { name: 'Add task' })).toHaveCount(0);
    await expect(page.getByTestId('mobile-compose-bar')).toHaveCount(0);
  });
});
