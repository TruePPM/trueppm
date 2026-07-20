import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

/**
 * Calendar empty / create flow (#2161).
 *
 * With no tasks, the calendar must render the shared warm empty state — a
 * heading plus a role-gated create CTA — never a bare "No tasks yet" line that
 * is indistinguishable from a still-loading or failed fetch. The CTA opens the
 * unified task-create modal.
 */

const PROJECT_ID = 'e2e-cal-00000000-0000-0000-0000-000000000014';
const CALENDAR_URL = `/projects/${PROJECT_ID}/calendar?calAnchor=2026-03-01`;

test.describe('Calendar empty state', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: PROJECT_ID,
      projects: [{ id: PROJECT_ID, name: 'Empty Calendar Project', start_date: '2026-03-01' }],
      tasks: [], // no tasks → empty state
    });
    await page.goto(CALENDAR_URL);
    await expect(page.getByRole('group', { name: 'Calendar view mode' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('renders the warm empty state with a create CTA and opens the task modal', async ({
    page,
  }) => {
    await expect(page.getByRole('heading', { name: 'No tasks yet' })).toBeVisible();
    const cta = page.getByRole('button', { name: '+ Add task' });
    await expect(cta).toBeVisible();

    await cta.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create task' })).toBeVisible();
  });
});
