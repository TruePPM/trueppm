/**
 * Blocked-task roll-up panel (ADR-0124) on the project overview — the PM's
 * read-only impediment triage list (the #1134 web half).
 *
 * Golden path: the panel lists flagged-blocked tasks with type + age + assignee
 * + soft link, and never a reason. Empty path: a reassuring "no blockers" state.
 */
import { test, expect, type Page } from './fixtures/coverage';
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
    // Private impediment note (ADR-0124): present in the mock payload so the
    // "never rendered" assertion below can actually fail if the panel ever
    // leaks it. The distinctive "permit office" phrase appears nowhere else in
    // the fixture, so the toHaveCount(0) check is load-bearing.
    reason: 'Waiting on the permit office to countersign the variance',
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
    // A project that has blocked tasks necessarily has tasks — set total_tasks
    // so the Overview renders its dashboard (incl. the Blocked roll-up) rather
    // than the zero-task first-run handoff (#2048), which replaces the body.
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: PROJECT_ID,
      overview: { total_tasks: 5 },
    });
  });

  test('lists blocked tasks with type, age, assignee, and soft link — no reason', async ({ page }) => {
    await stubBlocked(page, 1, BLOCKED_ROWS);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const panel = page.getByRole('region', { name: 'Blocked' });
    await expect(panel).toBeVisible({ timeout: 5_000 });
    // The title now opens the task drawer (#2159) — a link, not inert text.
    const titleLink = panel.getByRole('link', { name: 'Pour foundation' });
    await expect(titleLink).toBeVisible();
    await expect(titleLink).toHaveAttribute('href', `/projects/${PROJECT_ID}/tasks/t1`);
    await expect(panel.getByText('External vendor')).toBeVisible();
    await expect(panel.getByText('6d blocked')).toBeVisible();
    await expect(panel.getByText('priya')).toBeVisible();
    // Soft "waiting on" reference (issue 1156) — framed as informational, not a
    // CPM edge; its short-id now deep-links to the blocking task (#2159).
    await expect(panel.getByText(/waiting on/i)).toBeVisible();
    await expect(panel.getByRole('link', { name: 'T-9' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/tasks/t9`,
    );
    // The private reason IS in the mock payload (see BLOCKED_ROWS.reason) but
    // must never reach the DOM — the roll-up is a privacy-preserving triage
    // list. If the panel ever renders the reason field, "permit office" would
    // appear and this assertion fails.
    await expect(panel.getByText(/permit office/i)).toHaveCount(0);
  });

  test('shows a reassuring empty state when nothing is blocked', async ({ page }) => {
    await stubBlocked(page, 0, []);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const panel = page.getByRole('region', { name: 'Blocked' });
    await expect(panel.getByText(/No blocked tasks/)).toBeVisible({ timeout: 5_000 });
  });
});
