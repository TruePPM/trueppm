/**
 * E2E for the Board BACKLOG drawer (epic #361 child C, issue #383, Claude Design).
 *
 * Asserts the surface-level acceptance criteria for the drawer layout:
 *   - Drawer renders only when the toolbar layout switcher is set to Drawer
 *   - Header reflects count + stalled count + drag hint
 *   - Open/closed state persists across reload
 *   - Rail (BacklogBand) is suppressed while drawer is active
 *
 * Drag-and-drop is exercised in BoardView unit tests; this spec asserts the
 * configurational claims about which surface renders.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-bd-00000000-0000-0000-0000-000000000383';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Backlog Drawer Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function commonTaskShape() {
  return {
    early_start: '2026-04-05',
    early_finish: '2026-04-10',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  };
}

const SUMMARY_TASK = {
  id: 'phase-1',
  wbs_path: '1',
  name: 'Discovery',
  early_start: '2026-04-05',
  early_finish: '2026-04-30',
  duration: 25,
  percent_complete: 30,
  is_critical: false,
  is_milestone: false,
  is_summary: true,
  parent_id: null,
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const COMMITTED_TASK = {
  id: 'committed-1',
  wbs_path: '1.1',
  name: 'Stakeholder interviews',
  parent_id: 'phase-1',
  status: 'IN_PROGRESS',
  ...commonTaskShape(),
};

const BACKLOG_FRESH = {
  id: 'backlog-fresh',
  wbs_path: '1.2',
  name: 'Tone-of-voice study',
  parent_id: 'phase-1',
  status: 'BACKLOG',
  ...commonTaskShape(),
  // 1 day old — not stalled (under the 14-day drawer threshold).
  status_changed_at: new Date(Date.now() - 1 * 86_400_000).toISOString(),
};

const BACKLOG_STALE = {
  id: 'backlog-stale',
  wbs_path: '1.3',
  name: 'Audit existing UX flows',
  parent_id: 'phase-1',
  status: 'BACKLOG',
  ...commonTaskShape(),
  // 21 days old — stalled (over the 14-day threshold).
  status_changed_at: new Date(Date.now() - 21 * 86_400_000).toISOString(),
};

async function setup(page: import('@playwright/test').Page, tasks: object[]) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks,
    statusSummary: { task_count: tasks.length },
  });
  await page.route('**/api/v1/tasks/**', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    });
  });
}

test.describe('Board BACKLOG drawer (epic #361 child C, issue #383)', () => {
  test('switching layout to Drawer renders the drawer and hides the rail', async ({ page }) => {
    await setup(page, [SUMMARY_TASK, COMMITTED_TASK, BACKLOG_FRESH]);
    await page.goto(`${BASE_URL}/board`);

    // Default layout is Rail — drawer must not exist yet.
    await expect(page.getByTestId('backlog-band')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('backlog-drawer')).toHaveCount(0);

    await page
      .getByRole('toolbar', { name: 'Board toolbar' })
      .getByRole('button', { name: 'Drawer', exact: true })
      .click();

    await expect(page.getByTestId('backlog-drawer')).toBeVisible();
    // Rail no longer mounted while drawer is active.
    await expect(page.getByTestId('backlog-band')).toHaveCount(0);
    await expect(page.getByTestId('backlog-drawer').getByText('Tone-of-voice study')).toBeVisible();
  });

  test('header reflects count + stalled count + drag hint', async ({ page }) => {
    await setup(page, [SUMMARY_TASK, COMMITTED_TASK, BACKLOG_FRESH, BACKLOG_STALE]);
    await page.goto(`${BASE_URL}/board`);

    await page
      .getByRole('toolbar', { name: 'Board toolbar' })
      .getByRole('button', { name: 'Drawer', exact: true })
      .click();

    const drawer = page.getByTestId('backlog-drawer');
    await expect(drawer.getByText('2 ideas')).toBeVisible();
    await expect(drawer.getByText('1 stalled')).toBeVisible();
    await expect(drawer.getByText(/Drag a card down to defer/i)).toBeVisible();
  });

  test('open/closed state persists across reload', async ({ page }) => {
    await setup(page, [SUMMARY_TASK, COMMITTED_TASK, BACKLOG_FRESH]);
    await page.goto(`${BASE_URL}/board`);

    await page
      .getByRole('toolbar', { name: 'Board toolbar' })
      .getByRole('button', { name: 'Drawer', exact: true })
      .click();

    const drawer = page.getByTestId('backlog-drawer');
    // Default is open; collapse it.
    const toggle = drawer.getByRole('button', { expanded: true });
    await toggle.click();
    await expect(drawer.getByRole('button', { expanded: false })).toBeVisible();

    await page.reload();

    // After reload: layout pref keeps drawer active and the collapsed state
    // is restored from `trueppm.board.backlogDrawer.open`.
    await expect(page.getByTestId('backlog-drawer')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId('backlog-drawer').getByRole('button', { expanded: false }),
    ).toBeVisible();
  });
});
