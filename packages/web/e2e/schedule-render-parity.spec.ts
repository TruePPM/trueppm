/**
 * Schedule render parity (#248) + Milestone toolbar (#340).
 *
 * Covers user-visible acceptance criteria:
 * - WBS column renders task wbs paths
 * - Owner column renders avatars
 * - Toolbar toggle buttons (4 of them) render with aria-pressed
 * - Summary chip shows task count + critical count + CPM ✓
 * - "+ Milestone" button is visible peer to "+ Task"
 * - Clicking "+ Milestone" inserts a row + fires the pulse overlay
 * - Reduced-motion suppresses the pulse overlay
 *
 * The ⌘M shortcut is exercised at the unit layer (useScheduleKeyboard tests)
 * because Playwright's keyboard.press('Meta+M') has cross-OS quirks.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-render-00000000-0000-0000-0000-000000000248';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Render Parity Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'rp1', wbs_path: '1', name: 'Foundation',
    early_start: '2026-04-05', early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5, percent_complete: 0, is_critical: true,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED',
    assignments: [{ resource_id: 'r1', resource_name: 'Alice', units: 1 }],
    assignees: [],
    total_float: 0, predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'rp2', wbs_path: '2', name: 'Framing',
    early_start: '2026-04-12', early_finish: '2026-04-16',
    planned_start: '2026-04-12',
    duration: 5, percent_complete: 0, is_critical: true,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [],
    total_float: 0, predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

test.describe('Schedule render parity — toolbar + columns (#248)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('WBS column renders task wbs paths', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    // The WBS aria-label is on each row's wbs cell.
    await expect(page.getByLabel('WBS 1')).toBeVisible();
    await expect(page.getByLabel('WBS 2')).toBeVisible();
  });

  test('Owner column renders avatars for assigned tasks', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByLabel(/Owner: Alice/i)).toBeVisible();
    await expect(page.getByLabel('Owner: none')).toBeVisible(); // task rp2
  });

  test('Display menu exposes the four filters as checkboxes (aria-checked)', async ({ page }) => {
    // #1741: the four filters moved from inline toolbar toggles into the Display
    // popover as menuitemcheckbox rows.
    await page.goto(BASE_URL);
    await page.getByRole('button', { name: 'Display' }).click();
    const menu = page.getByRole('menu', { name: 'Display options' });
    for (const name of ['CP only', 'Focus chain', 'Critical path', 'Milestones']) {
      const item = menu.getByRole('menuitemcheckbox', { name });
      await expect(item).toBeVisible();
      await expect(item).toHaveAttribute('aria-checked', 'false');
    }
  });

  test('Toggling Critical path filters non-critical tasks out (summaries stay)', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(page.getByText('Framing')).toBeVisible();
    // Both fixture tasks are critical, so toggling on should leave them visible.
    await page.getByRole('button', { name: 'Display' }).click();
    const criticalItem = page
      .getByRole('menu', { name: 'Display options' })
      .getByRole('menuitemcheckbox', { name: 'Critical path' });
    await criticalItem.click();
    await expect(criticalItem).toHaveAttribute('aria-checked', 'true');
    // Close the popover; the trigger now advertises one active filter.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Display, 1 active filter' })).toBeVisible();
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(page.getByText('Framing')).toBeVisible();
  });

  test('Summary chip shows task count and critical count', async ({ page }) => {
    await page.goto(BASE_URL);
    // Chip label includes counts and CPM healthy state.
    await expect(
      page.getByLabel(/Project status: 2 tasks, 2 critical, CPM healthy/),
    ).toBeVisible();
  });
});

test.describe('Schedule milestone toolbar — +Milestone (#340)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
    // Stub the create task POST so the e2e doesn't hit a real backend.
    await page.route('**/api/v1/tasks/', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'rp-new-milestone',
            name: '',
            project: FIXTURE_PROJECT_ID,
            wbs_path: '3',
            duration: 0,
            status: 'NOT_STARTED',
            percent_complete: 0,
            is_milestone: true,
          }),
        });
      }
      return route.continue();
    });
  });

  test('+ Milestone button is visible as peer to + Task', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByTestId('add-milestone-button')).toBeVisible();
    await expect(page.getByTestId('add-milestone-button')).toContainText('Milestone');
  });

  test('+ Milestone button has the Cmd+M accessible label', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(
      page.getByRole('button', { name: 'Add new milestone (Cmd+M)' }),
    ).toBeVisible();
  });

  test('clicking + Milestone opens the milestone-create dialog (no eager POST)', async ({ page }) => {
    // Updated for the milestone-add dialog (issue #240 follow-up). The
    // button now opens TaskFormModal in milestone mode so the user can pick
    // name + date + parent up front; no /tasks/ POST fires until the user
    // submits the form. Submit-payload shape is covered by
    // schedule-milestone-add.spec.ts.
    await page.goto(BASE_URL);
    let postCount = 0;
    await page.route('**/api/v1/tasks/', (route) => {
      if (route.request().method() === 'POST') {
        postCount += 1;
      }
      route.continue();
    });
    await page.getByTestId('add-milestone-button').click();
    await expect(page.getByRole('dialog', { name: 'New milestone' })).toBeVisible();
    expect(postCount).toBe(0);
  });
});
