/**
 * Board "Find & Fit" E2E (#323 search + #379 zoom, ADR-0145).
 *
 * Search: typing dims non-matches, shows a count chip, mirrors to ?q=, and clears.
 * Zoom: the stepper changes the level and persists across a reload.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-findfit-0000-0000-0000-000000000010';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  { id: FIXTURE_PROJECT_ID, name: 'Find & Fit Project', description: '', start_date: '2026-01-01', calendar: 'default' },
];

const FIXTURE_TASKS = [
  {
    id: 'b1', wbs_path: '1', name: 'Alpha Phase', early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 50, is_critical: false, is_milestone: false, is_summary: true,
    parent_id: null, status: 'IN_PROGRESS', assignees: [], total_float: null, predecessor_count: 0,
    is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'b2', wbs_path: '1.1', name: 'Design', early_start: '2026-01-05', early_finish: '2026-01-16',
    planned_start: '2026-01-05', duration: 10, percent_complete: 100, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'b1', status: 'COMPLETE', assignees: [],
    total_float: null, predecessor_count: 0, is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'b3', wbs_path: '1.2', name: 'Build the foundation', early_start: '2026-01-19', early_finish: '2026-01-30',
    planned_start: '2026-01-19', duration: 10, percent_complete: 40, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'b1', status: 'IN_PROGRESS', assignees: [],
    total_float: null, predecessor_count: 0, is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

interface SlimTask {
  id: string;
  name: string;
  status: string;
  short_id: string;
}

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 2 },
  });

  // Card search endpoint (#323) — registered AFTER setupApiMocks so it wins (last
  // route registered is matched first) over that helper's generic
  // **/api/v1/tasks/** list route, which would otherwise return a paginated
  // {count,results} object where the search hook expects a slim array. The plain
  // /tasks/ list is still served by setupApiMocks (this glob requires "search/").
  await page.route('**/api/v1/tasks/search/**', (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase();
    const matches: SlimTask[] = FIXTURE_TASKS.filter(
      (t) => !t.is_summary && t.name.toLowerCase().includes(q),
    ).map((t) => ({ id: t.id, name: t.name, status: t.status, short_id: t.wbs_path }));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(matches),
    });
  });
}

test.describe('Board Find & Fit', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Build the foundation')).toBeVisible({ timeout: 10_000 });
  });

  test('search dims non-matches, shows a count, mirrors to ?q=, and clears (#323)', async ({ page }) => {
    // `/` focuses the search box from the board surface.
    await page.keyboard.press('/');
    const search = page.getByRole('searchbox', { name: 'Search cards' });
    await expect(search).toBeFocused();

    await search.fill('foundation');

    // Count chip reflects the single match, and the query is in the URL.
    await expect(page.getByText('1 match')).toBeVisible();
    await expect(page).toHaveURL(/[?&]q=foundation/);

    // The match stays lit; at least one non-match is dimmed.
    await expect(page.getByText('Build the foundation')).toBeVisible();
    await expect(page.locator('.opacity-40').first()).toBeVisible();

    // Clearing restores the board and drops ?q=.
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByText('1 match')).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]q=/);
  });

  test('zoom steps the level and persists across reload (#379)', async ({ page }) => {
    const group = page.getByRole('group', { name: 'Board zoom' });
    await expect(group.getByText('Normal')).toBeVisible();

    await group.getByRole('button', { name: 'Zoom in' }).click();
    await expect(group.getByText('Large')).toBeVisible();

    await page.reload();
    await expect(page.getByText('Build the foundation')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('group', { name: 'Board zoom' }).getByText('Large')).toBeVisible();
  });
});
