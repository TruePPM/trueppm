/**
 * Board tech-debt filter — ADR-0135, #1076.
 *
 * Verifies the tech-debt visibility golden path:
 *   - A tech-debt task shows the "Tech Debt" badge on its board card face.
 *   - The "Tech debt" toolbar pill renders, default-off.
 *   - Toggling on narrows the board to tech-debt tasks only.
 *   - The "Filter: Tech debt" chip + "Show all →" affordance appears.
 *   - "Show all →" clears the lens and restores every task.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-board-techdebt-0000-0000-0000-000000000001';
const ROUTE = `/projects/${FIXTURE_PROJECT_ID}/board`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Tech Debt Filter Test',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

// One summary phase with two leaf tasks: a tech-debt item and a plain task.
const FIXTURE_TASKS = [
  {
    id: 'td-0',
    wbs_path: '1',
    name: 'Implementation Phase',
    early_start: '2026-01-05',
    early_finish: '2026-02-14',
    duration: 30,
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
  },
  {
    id: 'td-1',
    wbs_path: '1.1',
    name: 'Pay Down Auth Module',
    type: 'tech_debt',
    early_start: '2026-01-05',
    early_finish: '2026-01-16',
    duration: 10,
    percent_complete: 20,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'td-0',
    status: 'IN_PROGRESS',
    assignments: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'td-2',
    wbs_path: '1.2',
    name: 'Build Login Screen',
    type: 'story',
    early_start: '2026-01-19',
    early_finish: '2026-01-30',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'td-0',
    status: 'NOT_STARTED',
    assignments: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
  });
}

function debtPill(page: import('@playwright/test').Page) {
  return page
    .getByRole('toolbar', { name: 'Board toolbar' })
    .getByRole('button', { name: 'Tech-debt only', exact: true });
}

test.describe('Board tech-debt filter (#1076)', () => {
  test('badge renders and the pill narrows the board to tech-debt tasks', async ({ page }) => {
    await setup(page);
    await page.goto(ROUTE);

    // Both leaf tasks visible by default; the debt card carries its badge.
    await expect(page.getByText('Pay Down Auth Module')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Build Login Screen')).toBeVisible();
    await expect(page.getByText('Tech Debt', { exact: true })).toBeVisible();

    const pill = debtPill(page);
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('aria-pressed', 'false');

    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');

    // The plain story disappears; the debt task remains.
    await expect(page.getByText('Pay Down Auth Module')).toBeVisible();
    await expect(page.getByText('Build Login Screen')).not.toBeVisible();

    // The inescapable "Filter: Tech debt · Show all →" chip is rendered.
    await expect(page.getByText('Filter: Tech debt')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show all →' })).toBeVisible();
  });

  test('"Show all →" clears the lens and restores every task', async ({ page }) => {
    await setup(page);
    await page.goto(ROUTE);

    const pill = debtPill(page);
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await pill.click();
    await expect(page.getByText('Build Login Screen')).not.toBeVisible();

    await page.getByRole('button', { name: 'Show all →' }).click();
    await expect(page.getByText('Build Login Screen')).toBeVisible();
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
  });
});
