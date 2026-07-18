/**
 * Mobile board — Queue auto-default + FAB wiring E2E (issue 605).
 *
 * Below `md:` (< 768px) the desktop phase-grid is unusable, so a phone with no
 * explicit layout preference auto-defaults to the Queue layout, and the mobile
 * FAB (previously a dead, disabled button) opens the create modal targeting the
 * group in view: BACKLOG under Queue, else the snapped-to status column. An
 * explicit rail / drawer choice is preserved across the breakpoint — the board
 * never silently flips a user who picked their layout on purpose.
 *
 * Runs at a phone viewport (375×812) to trip the board's `isMobile` matchMedia
 * gate (`max-width: 767px`). Every endpoint the board page reads is mocked with
 * its real shape (per the repo's catch-all-mock caveat) and interactions are
 * gated on a "page rendered" signal before the FAB is touched.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-mfab-0000-0000-0000-000000000020';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;
const PREFS_KEY = 'trueppm.board.toolbarPrefs.v1';

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Mobile FAB Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

// A couple of leaf cards across the status axis so both the Queue list and the
// snap-board columns have content to render.
const FIXTURE_TASKS = [
  {
    id: 'mf1', wbs_path: '1', name: 'Draft the plan',
    early_start: '2026-01-05', early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'mf2', wbs_path: '2', name: 'Wire the endpoint',
    early_start: '2026-01-19', early_finish: '2026-01-30',
    planned_start: '2026-01-19',
    duration: 10, percent_complete: 40, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 2 },
  });
}

/** Seed an explicit layout preference before the app boots (issue 605). */
async function seedLayoutPref(
  page: import('@playwright/test').Page,
  layout: 'rail' | 'drawer' | 'queue',
) {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify({ layout: value, backlogDensity: 'comfortable' }));
    },
    { key: PREFS_KEY, value: layout },
  );
}

test.describe('Board mobile — Queue auto-default + FAB (issue 605)', () => {
  test.beforeEach(async ({ page }) => {
    // Phone viewport — trips the board's `isMobile` matchMedia gate.
    await page.setViewportSize({ width: 375, height: 812 });
  });

  test('a phone with no layout preference auto-defaults to the Queue layout', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    // Queue is mounted; the desktop snap board / phase grid are not.
    await expect(page.getByTestId('queue-layout')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('mobile-board-scroller')).toHaveCount(0);
  });

  test('the FAB opens the create modal and a created task lands in the visible group (BACKLOG on Queue)', async ({
    page,
  }) => {
    await setup(page);

    // Capture the create POST so we can assert the task is created into the
    // visible group's status rather than relying on a stateful list refetch.
    let createdStatus: string | undefined;
    await page.route(`**/api/v1/tasks/`, async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { status?: string; name?: string };
        createdStatus = body.status;
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'mf-new', wbs_path: '3', name: body.name ?? 'New task',
            duration: 1, percent_complete: 0, status: body.status ?? 'BACKLOG',
            parent_id: null, is_summary: false, is_milestone: false,
            assignees: [], predecessor_count: 0, is_blocked: false,
            linked_risks_count: 0, linked_risks_max_severity: null, total_float: null,
          }),
        });
      }
      return route.continue();
    });

    await page.goto(`${BASE_URL}/board`);

    // Gate on the Queue having rendered before touching the FAB.
    await expect(page.getByTestId('queue-layout')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Add task', exact: true }).click();

    // Queue is a flat, backlog-first list — the modal opens preset to BACKLOG.
    const dialog = page.getByRole('dialog', { name: /Add to backlog/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Status')).toHaveValue('BACKLOG');

    // Create the task and assert it lands in BACKLOG (the visible group).
    await dialog.getByLabel('Task name *').fill('Mobile capture');
    await dialog.getByRole('button', { name: 'Create task' }).click();

    await expect(dialog).toBeHidden({ timeout: 10_000 });
    expect(createdStatus).toBe('BACKLOG');
  });

  test('an explicit rail preference is preserved on mobile and the FAB targets the visible status column', async ({
    page,
  }) => {
    await seedLayoutPref(page, 'rail');
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    // Explicit rail is honored — the snap board renders, Queue is not mounted.
    await expect(page.getByTestId('mobile-board-scroller')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('queue-layout')).toHaveCount(0);

    // The first column (To Do / NOT_STARTED) is in view on load, so the FAB
    // opens the modal preset to that status.
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Status')).toHaveValue('NOT_STARTED');
  });

  test('an explicit drawer preference is preserved on mobile (not flipped to Queue)', async ({
    page,
  }) => {
    await seedLayoutPref(page, 'drawer');
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    // Drawer is not Queue, so on a phone the snap board still renders and Queue
    // is never mounted — the explicit choice survives the breakpoint.
    await expect(page.getByTestId('mobile-board-scroller')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('queue-layout')).toHaveCount(0);
  });
});
