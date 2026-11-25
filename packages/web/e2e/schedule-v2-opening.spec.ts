/**
 * Shell v2 Schedule opening state (#5106), behind `shell_v2`: the 448px grid, today's
 * phase open and the others folded, children capped at ten with "N more", the per-row
 * "no committed start" chips rolled up into one footer count with a filter.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

const PROJECT_ID = 'e2e-v2-00000000-0000-0000-0000-000000005106';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const base = {
  duration: 5,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  assignees: [],
  total_float: 5,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Opening Project',
    description: '',
    start_date: iso(-60),
    calendar: 'default',
  },
];

function rows() {
  const out: Record<string, unknown>[] = [
    {
      ...base,
      id: 'past',
      wbs_path: '1',
      name: 'Past phase',
      is_summary: true,
      parent_id: null,
      status: 'COMPLETE',
      early_start: iso(-60),
      early_finish: iso(-30),
      planned_start: iso(-60),
    },
    {
      ...base,
      id: 'past1',
      wbs_path: '1.1',
      name: 'Past child',
      is_summary: false,
      parent_id: 'past',
      status: 'COMPLETE',
      early_start: iso(-60),
      early_finish: iso(-30),
      planned_start: iso(-60),
    },
    {
      ...base,
      id: 'now',
      wbs_path: '2',
      name: 'Current phase',
      is_summary: true,
      parent_id: null,
      status: 'IN_PROGRESS',
      early_start: iso(-10),
      early_finish: iso(60),
      planned_start: iso(-10),
    },
  ];
  for (let i = 1; i <= 13; i += 1) {
    out.push({
      ...base,
      id: `k${i}`,
      wbs_path: `2.${i}`,
      name: `Work item ${i}`,
      is_summary: false,
      parent_id: 'now',
      // Two in-progress rows with no committed start: the defect the footer counts.
      status: i <= 2 ? 'IN_PROGRESS' : 'NOT_STARTED',
      early_start: iso(-5 + i),
      early_finish: iso(-2 + i),
      planned_start: i <= 2 ? null : iso(-5 + i),
    });
  }
  return out;
}

async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
  });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: rows() });
  await setupTaskStore(page, { tasks: rows() });
  await page.goto(BASE_URL);
}

test.describe('shell v2 Schedule opening state (#5106)', () => {
  test('today phase open, past phase folded, children capped at 10 with N more', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await expect(page.getByText('Work item 1', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Past child')).toHaveCount(0);
    await expect(page.getByText('Work item 10', { exact: true })).toBeVisible();
    await expect(page.getByText('Work item 11', { exact: true })).toHaveCount(0);
    const more = page.getByRole('button', { name: /Show 3 more under Current phase/ });
    await expect(more).toBeVisible();
    await more.click();
    await expect(page.getByText('Work item 13', { exact: true })).toBeVisible();
  });

  test('the grid opens at 448px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await expect(page.getByTestId('schedule-grid-footer')).toBeVisible({ timeout: 15_000 });
    const box = await page.getByTestId('schedule-grid-footer').boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(448);
  });

  test('no-committed-start rolls up into one footer count with a filter; no per-row chip', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const filter = page.getByTestId('schedule-no-start-filter');
    await expect(filter).toContainText('2 no committed start', { timeout: 15_000 });
    await expect(page.getByText('no committed start', { exact: false })).toHaveCount(1);
    await filter.click();
    await expect(page.getByText('Work item 2', { exact: true })).toBeVisible();
    await expect(page.getByText('Work item 3', { exact: true })).toHaveCount(0);
    await filter.click();
    await expect(page.getByText('Work item 3', { exact: true })).toBeVisible();
  });
});
