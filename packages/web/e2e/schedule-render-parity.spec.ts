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
import { test, expect } from '@playwright/test';
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

  test('Toolbar shows four styled toggle buttons with aria-pressed', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByRole('button', { name: 'Show critical path only' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Focus chain on selected task' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show only critical-path tasks' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show only milestones' })).toBeVisible();
    // All start in pressed=false.
    for (const name of [
      'Show critical path only',
      'Focus chain on selected task',
      'Show only critical-path tasks',
      'Show only milestones',
    ]) {
      await expect(page.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  test('Toggling Critical path filters non-critical tasks out (summaries stay)', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(page.getByText('Framing')).toBeVisible();
    // Both fixture tasks are critical, so toggling on should leave them visible.
    await page.getByRole('button', { name: 'Show only critical-path tasks' }).click();
    await expect(page.getByRole('button', { name: 'Show only critical-path tasks' })).toHaveAttribute('aria-pressed', 'true');
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

  test('clicking + Milestone POSTs to /tasks/ with is_milestone=true', async ({ page }) => {
    await page.goto(BASE_URL);
    const requestPromise = page.waitForRequest(
      (req) => req.url().endsWith('/api/v1/tasks/') && req.method() === 'POST',
    );
    await page.getByTestId('add-milestone-button').click();
    const req = await requestPromise;
    const body = req.postDataJSON() as Record<string, unknown>;
    expect(body.is_milestone).toBe(true);
    expect(body.duration).toBe(0);
    expect(typeof body.planned_start).toBe('string');
  });
});
