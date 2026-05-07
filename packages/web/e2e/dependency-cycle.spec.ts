/**
 * Server-side cycle detection on dep create (issue #356, ADR-0055).
 *
 * Drives the board's "Add task" → TaskFormModal flow with a mocked POST
 * /dependencies/ that rejects the proposed edge with the structured 400
 * cycle payload. Asserts the user sees a `role="alert"` toast carrying the
 * cycle path resolved to task names (not UUIDs), and that the dep was not
 * persisted (no successful POST captured by the mock).
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-cycle-00000000-0000-0000-0000-000000000356';
const BASE_URL = `/projects/${PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Cycle Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'phase',
    wbs_path: '1',
    name: 'Alpha Phase',
    early_start: '2026-01-05',
    early_finish: '2026-02-14',
    duration: 30,
    percent_complete: 0,
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
  },
  {
    id: 'find-suppliers',
    wbs_path: '1.1',
    name: 'Find suppliers',
    short_id: 'aa11',
    early_start: '2026-01-05',
    early_finish: '2026-01-15',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'phase',
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

test.describe('Dependency cycle detection (#356)', () => {
  let depPostAttempts = 0;

  test.beforeEach(async ({ page }) => {
    depPostAttempts = 0;

    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });

    // POST /tasks/ in create-mode flow returns the new task.
    await page.route('**/api/v1/tasks/', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'new-task',
            name: 'New cycling task',
            project: PROJECT_ID,
            wbs_path: '1.2',
            duration: 5,
            status: 'NOT_STARTED',
            percent_complete: 0,
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: FIXTURE_TASKS }),
      });
    });

    // The endpoint under test: POST /dependencies/ rejects the proposed edge
    // with the structured cycle payload that ADR-0055 specifies. GETs return
    // an empty list so the form's hydration completes cleanly.
    await page.route('**/api/v1/dependencies/**', (route) => {
      if (route.request().method() === 'POST') {
        depPostAttempts += 1;
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            detail: 'cyclic_dependency',
            cycle: [
              { id: 'find-suppliers', name: 'Find suppliers', hex_id: 'aa11' },
              { id: 'new-task', name: 'New cycling task', hex_id: 'bb22' },
              { id: 'find-suppliers', name: 'Find suppliers', hex_id: 'aa11' },
            ],
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      });
    });

    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 10_000 });
  });

  test('rejected cycle surfaces a role="alert" toast with task names', async ({ page }) => {
    await page.getByRole('button', { name: /Add task to Alpha Phase/ }).click();
    const dialog = page.getByRole('dialog', { name: /Add to Alpha Phase/ });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Task name *').fill('New cycling task');

    await dialog.getByRole('button', { name: /link predecessor/i }).click();
    await dialog.getByLabel(/search predecessor tasks/i).fill('Find');
    await dialog.getByRole('button', { name: /find suppliers/i }).click();

    await dialog.getByRole('button', { name: 'Create task' }).click();

    const alert = dialog.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('circular dependency');
    await expect(alert).toContainText('Find suppliers');
    await expect(alert).toContainText('New cycling task');
    // Names are surfaced — never bare UUIDs.
    await expect(alert).not.toContainText('find-suppliers');
    await expect(alert).not.toContainText('new-task');

    // The proposed dep is rejected — the modal stays open so the user can
    // adjust without losing their task name + predecessor selection.
    await expect(dialog).toBeVisible();

    // The single attempted POST got a 400; no further attempts persist a
    // cycle silently.
    expect(depPostAttempts).toBe(1);
  });
});
