/**
 * Blocked-task roll-up panel (ADR-0124) on the project overview — the PM's
 * read-only impediment triage list (the #1134 web half).
 *
 * Golden path: the panel lists flagged-blocked tasks with type + age + assignee
 * + soft link, and never a reason. Empty path: a reassuring "no blockers" state.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-blkrollup-0000-0000-0000-000000001134';

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Rollup Project', description: '', start_date: '2026-04-01', calendar: 'default' },
];

const BLOCKED_ROWS = [
  {
    task_id: 't1',
    task_short_id: 'T-1',
    title: 'Pour foundation',
    assignee: { id: 'u1', username: 'priya' },
    blocker_type: 'vendor',
    blocked_since: '2026-06-08T00:00:00Z',
    blocked_age_seconds: 6 * 86400,
    blocked_by: { id: 'u2', username: 'alex' },
    blocking_task: { id: 't9', short_id: 'T-9', title: 'Permit approval' },
  },
];

async function stubBlocked(page: Page, count: number, blocked: unknown[]) {
  await page.route(`**/api/v1/projects/${PROJECT_ID}/blocked/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project_id: PROJECT_ID, count, blocked }),
    }),
  );
}

test.describe('Blocked roll-up panel (ADR-0124)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
  });

  test('lists blocked tasks with type, age, assignee, and soft link — no reason', async ({ page }) => {
    await stubBlocked(page, 1, BLOCKED_ROWS);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const panel = page.getByRole('region', { name: 'Blocked' });
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await expect(panel.getByText('Pour foundation')).toBeVisible();
    await expect(panel.getByText('External vendor')).toBeVisible();
    await expect(panel.getByText('6d blocked')).toBeVisible();
    await expect(panel.getByText('priya')).toBeVisible();
    // Soft "waiting on" link (issue 1156) — framed as informational, not a CPM edge.
    await expect(panel.getByText('waiting on T-9')).toBeVisible();
    // The private reason text is never in the roll-up payload or DOM.
    await expect(panel.getByText(/permit office/i)).toHaveCount(0);
  });

  test('shows a reassuring empty state when nothing is blocked', async ({ page }) => {
    await stubBlocked(page, 0, []);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const panel = page.getByRole('region', { name: 'Blocked' });
    await expect(panel.getByText(/No blocked tasks/)).toBeVisible({ timeout: 5_000 });
  });
});
