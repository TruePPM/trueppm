/**
 * Task drawer "Blocker" section (ADR-0124) — the human "I'm stuck" flag.
 *
 * Golden path: open a task drawer, flag the task blocked with a reason + type,
 * and assert the PATCH carries blocked_reason + blocker_type. The flag-of-record
 * is the reason, so "Flag blocked" stays disabled until a reason is typed.
 *
 * Schedule + drawer render via the shared fixtures; the task PATCH is stubbed and
 * its body captured.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-blocker-00000000-0000-0000-0000-000000001135';
const TASK_ID = 'blk1';

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Blocker Project', description: '', start_date: '2026-04-01', calendar: 'default' },
];

const FIXTURE_TASKS = [
  {
    id: TASK_ID,
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    // Not flagged: no human blocker yet.
    blocked_reason: '',
    blocker_type: '',
    blocked_age_seconds: null,
    blocked_since: null,
    blocked_by: null,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

async function openBlockerSection(page: Page): Promise<Locator> {
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  const grid = page.getByRole('grid', { name: 'Task list' });
  await grid.getByText('Foundation', { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /Foundation/ }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  // Blocker lives on the Details tab (default). It is a non-first section, so it
  // starts collapsed — expand via its header button.
  const header = drawer.getByRole('button', { name: 'Blocker' });
  await expect(header).toBeVisible();
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  const section = drawer.getByRole('region', { name: 'Blocker' });
  await expect(section).toBeVisible();
  return section;
}

test.describe('Task blocker section (ADR-0124)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID, tasks: FIXTURE_TASKS });
  });

  test('flags a task blocked with a reason + type', async ({ page }) => {
    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/tasks/${TASK_ID}/`, (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: TASK_ID,
            name: 'Foundation',
            project: PROJECT_ID,
            wbs_path: '1',
            duration: 5,
            status: 'NOT_STARTED',
            percent_complete: 0,
          }),
        });
      }
      return route.fallback();
    });

    const section = await openBlockerSection(page);

    // Not blocked yet.
    await expect(section.getByText('Not blocked')).toBeVisible();
    await section.getByRole('button', { name: /flag as blocked/i }).click();

    // Reason is the flag of record — the button is disabled until it's filled.
    const flagBtn = section.getByRole('button', { name: 'Flag blocked' });
    await expect(flagBtn).toBeDisabled();
    await section.getByLabel('Reason').fill('Waiting on the permit office');
    await section.getByLabel(/Type/).selectOption('vendor');
    await expect(flagBtn).toBeEnabled();
    await flagBtn.click();

    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody).toMatchObject({
      blocked_reason: 'Waiting on the permit office',
      blocker_type: 'vendor',
    });
  });
});
