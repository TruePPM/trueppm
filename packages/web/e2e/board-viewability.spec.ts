/**
 * Board viewability overhaul E2E (epic #1457, ADR-0191).
 *
 * Covers the three keystone behaviours of the first-class board:
 *   - #1459 column collapse-to-stub: a column folds to a narrow stub, a
 *     "N columns collapsed" banner appears with bulk expand, and a breaching
 *     folded column surfaces a tappable WIP popover.
 *   - #1460 phase-lane focus mode: focusing a lane hides the others, shows a
 *     focus banner, and is shareable/restorable via the ?focus= URL param.
 *
 * The fixed-width sticky grid (#1458) is structural CSS not assertable as a
 * discrete user action; its geometry helper is unit-tested in
 * src/features/board/boardGrid.test.ts.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-bv-00000000-0000-0000-0000-000000000020';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Viewability Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

// Two summary phases so focus mode has something to hide. Six IN_PROGRESS leaf
// tasks push that column over its default WIP limit (5) so the collapsed-stub
// breach popover has something to show.
const leaf = (
  id: string,
  parent: string,
  wbs: string,
  status: string,
  name: string,
) => ({
  id,
  wbs_path: wbs,
  name,
  early_start: '2026-01-05',
  early_finish: '2026-01-16',
  planned_start: '2026-01-05',
  duration: 10,
  percent_complete: 20,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  parent_id: parent,
  status,
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
});

const FIXTURE_TASKS = [
  {
    id: 'b1', wbs_path: '1', name: 'Alpha Phase',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 40, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  leaf('a1', 'b1', '1.1', 'IN_PROGRESS', 'Alpha Build 1'),
  leaf('a2', 'b1', '1.2', 'IN_PROGRESS', 'Alpha Build 2'),
  leaf('a3', 'b1', '1.3', 'IN_PROGRESS', 'Alpha Build 3'),
  leaf('a4', 'b1', '1.4', 'IN_PROGRESS', 'Alpha Build 4'),
  leaf('a5', 'b1', '1.5', 'IN_PROGRESS', 'Alpha Build 5'),
  leaf('a6', 'b1', '1.6', 'IN_PROGRESS', 'Alpha Build 6'),
  {
    id: 'c1', wbs_path: '2', name: 'Beta Phase',
    early_start: '2026-02-01', early_finish: '2026-03-14',
    duration: 30, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  leaf('c2', 'c1', '2.1', 'NOT_STARTED', 'Beta Spec'),
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 7 },
  });
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_TASKS,
      }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

test.describe('Board viewability — column collapse (#1459)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 10_000 });
  });

  test('collapsing a column folds it to a stub and shows the banner', async ({ page }) => {
    await expect(page.getByTestId('column-stub-IN_PROGRESS')).toHaveCount(0);

    await page.getByRole('button', { name: 'Collapse In Progress column' }).click();

    await expect(page.getByTestId('column-stub-IN_PROGRESS')).toBeVisible();
    const banner = page.getByTestId('collapsed-columns-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('1 column collapsed');
  });

  test('"Expand all" restores every collapsed column', async ({ page }) => {
    await page.getByRole('button', { name: 'Collapse In Progress column' }).click();
    await page.getByRole('button', { name: 'Collapse Review column' }).click();
    await expect(page.getByTestId('collapsed-columns-banner')).toContainText('2 columns collapsed');

    await page.getByTestId('expand-all-columns').click();

    await expect(page.getByTestId('collapsed-columns-banner')).toHaveCount(0);
    await expect(page.getByTestId('column-stub-IN_PROGRESS')).toHaveCount(0);
  });

  test('a folded over-WIP column surfaces a breach popover', async ({ page }) => {
    // 6 IN_PROGRESS tasks > default WIP limit 5 → over.
    await page.getByRole('button', { name: 'Collapse In Progress column' }).click();

    const trigger = page.getByTestId('collapsed-wip-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText('1 over WIP');

    await trigger.click();
    const popover = page.getByTestId('collapsed-wip-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('In Progress');
    await expect(popover).toContainText('6/5');
  });
});

test.describe('Board viewability — phase-lane focus (#1460)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Beta Phase')).toBeVisible({ timeout: 10_000 });
  });

  test('focusing a lane hides the others and shows the focus banner', async ({ page }) => {
    await page.getByTestId('focus-lane-b1').click();

    const banner = page.getByTestId('focus-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Alpha Phase');
    // The Alpha lane stays; the Beta lane is hidden while Alpha is focused.
    // Scope to the swimlane group so the banner's copy doesn't collide.
    await expect(page.getByRole('group', { name: 'Alpha Phase swimlane' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Beta Phase swimlane' })).toHaveCount(0);
  });

  test('exiting focus restores all lanes', async ({ page }) => {
    await page.getByTestId('focus-lane-b1').click();
    await expect(page.getByTestId('focus-banner')).toBeVisible();

    await page.getByTestId('exit-focus').click();

    await expect(page.getByTestId('focus-banner')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Beta Phase swimlane' })).toBeVisible();
  });

  test('?focus= deep link opens the board already focused', async ({ page }) => {
    await page.goto(`${BASE_URL}/board?focus=c1`);
    await expect(page.getByRole('group', { name: 'Beta Phase swimlane' })).toBeVisible({
      timeout: 10_000,
    });

    await expect(page.getByTestId('focus-banner')).toContainText('Beta Phase');
    await expect(page.getByRole('group', { name: 'Alpha Phase swimlane' })).toHaveCount(0);
  });
});
