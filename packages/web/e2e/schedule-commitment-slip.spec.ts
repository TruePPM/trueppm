/**
 * Commitment-slip gate on the Gantt reschedule commit (ADR-1485 D1).
 *
 * A caller who cannot accept scope changes moves committed sprint work past the
 * sprint end. The server does not apply the write: it answers 409
 * `commitment_slip_requires_acceptance` and records a PENDING scope change. The
 * client must say the edit is waiting on a decision, not show an error.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-slip00-0000-0000-0000-000000002563';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Slip Project',
    description: '',
    start_date: '2026-03-02',
    status_date: '2026-03-02',
    calendar: 'default',
  },
];

const TASKS = [
  {
    id: 'slip-task-1',
    wbs_path: '1',
    name: 'Committed work',
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    planned_start: '2026-04-06',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    assignments: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    notes: '',
  },
];

test.describe('Commitment slip on reschedule (ADR-1485 D1)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('a non-admin move past the sprint end waits for a sprint decision', async ({ page }) => {
    let patched = false;
    await page.route('**/api/v1/tasks/slip-task-1/', async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      patched = true;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'commitment_slip_requires_acceptance',
          detail: 'This change moves committed work past the end of the active sprint.',
          structure_role: 'work',
          scope_change_id: '7d1f2c3a-0000-4000-8000-000000002563',
          batch_id: '7d1f2c3a-0000-4000-8000-000000000001',
          sprint_id: '7d1f2c3a-0000-4000-8000-000000000002',
          sprint_name: 'Sprint 4',
          proposed_start: '2026-04-13',
          proposed_finish: '2026-04-17',
        }),
      });
    });

    await page.goto(BASE_URL);
    const bar = page.getByRole('option', { name: /Committed work/ });
    await expect(bar).toBeVisible();
    await bar.focus();
    await page.keyboard.press('r');
    await expect(page.getByTestId('preview-overlay')).toBeVisible();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    await expect.poll(() => patched).toBe(true);
    await expect(page.getByText('Waiting for a Sprint 4 decision')).toBeVisible();
    await expect(page.getByText("Couldn't save the change.")).toHaveCount(0);
  });

  test('an authority holder is asked for a reason and the retry carries it', async ({ page }) => {
    const bodies: Record<string, unknown>[] = [];
    await page.route('**/api/v1/tasks/slip-task-1/', async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      bodies.push(body);
      if (!body.slip_reason) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            slip_reason: ['Moving committed work past the sprint end needs a reason.'],
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...TASKS[0], ...body }),
      });
    });

    await page.goto(BASE_URL);
    const bar = page.getByRole('option', { name: /Committed work/ });
    await expect(bar).toBeVisible();
    await bar.focus();
    await page.keyboard.press('r');
    await expect(page.getByTestId('preview-overlay')).toBeVisible();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Move past the sprint end?' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Reason').fill('Vendor slipped');
    await dialog.getByRole('button', { name: 'Move it' }).click();

    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1].slip_reason).toBe('Vendor slipped');
    await expect(dialog).toBeHidden();
  });
});
