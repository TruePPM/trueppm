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

function rows(children = 13) {
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
    // A defective row inside a FOLDED phase: the footer counts it, so the filter must list it.
    {
      ...base,
      id: 'past2',
      wbs_path: '1.2',
      name: 'Past defect',
      is_summary: false,
      parent_id: 'past',
      status: 'IN_PROGRESS',
      early_start: iso(-40),
      early_finish: iso(-35),
      planned_start: null,
    },
  ];
  for (let i = 1; i <= children; i += 1) {
    out.push({
      ...base,
      // One blocked row, which is the only per-row warning v2 keeps.
      is_blocked: i === 3,
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

async function open(page: Page, children = 13) {
  await page.addInitScript(() => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
  });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: PROJECTS,
    projectId: PROJECT_ID,
    tasks: rows(children),
  });
  await setupTaskStore(page, { tasks: rows(children) });
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
    const box = await page.getByTestId('task-list-panel').boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(448);
    // Exactly the five default columns: ID (WBS), task, owner, finish, total float.
    const headers = page.getByRole('columnheader');
    await expect(headers).toHaveCount(5);
    for (const name of [
      'Work breakdown structure',
      'Item',
      'Owner',
      'Finish date',
      'Total float',
    ]) {
      await expect(page.getByRole('columnheader', { name, exact: true })).toBeVisible();
    }
    for (const name of ['Duration', 'Start date', 'Progress', 'Free float']) {
      await expect(page.getByRole('columnheader', { name, exact: true })).toHaveCount(0);
    }
  });

  test('opens with today in the left fifth of the chart', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    // Work item 5 starts today.
    const bar = page.locator('[role="option"][data-task-id="k5"]');
    await expect(bar).toBeAttached({ timeout: 15_000 });
    const scroll = page.getByTestId('schedule-canvas-scroll');
    // The engine frames the window after layout settles, so poll for the settled frame.
    await expect
      .poll(
        async () => {
          const b = await bar.boundingBox();
          const c = await scroll.boundingBox();
          if (!b || !c) return false;
          const x = (b.x - c.x) / c.width;
          return x > 0.1 && x <= 0.21;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test('the footer does not cover the append-task row at the end of the list', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 520 });
    await open(page);
    const append = page.getByTestId('schedule-append-task-footer');
    await expect(append).toBeAttached({ timeout: 15_000 });
    const clearance = async () => {
      // Scroll the outline to its very end, where the append row meets the footer.
      await page.getByTestId('task-list-panel').evaluate((panel) => {
        for (const el of panel.querySelectorAll<HTMLElement>('*')) {
          if (el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto') {
            el.scrollTop = el.scrollHeight;
          }
        }
      });
      const a = await append.boundingBox();
      const f = await page.getByTestId('schedule-grid-footer').boundingBox();
      return a && f ? f.y + 1 - (a.y + a.height) : -999;
    };
    // The append row must end at or above the footer's top edge.
    await expect.poll(clearance, { timeout: 10_000 }).toBeGreaterThanOrEqual(0);
    // Playwright's actionability check fails this click if the footer sits on top.
    await append.getByRole('button').click({ timeout: 5_000 });
  });

  test('a task hidden by the 10-child cap is revealed when jumped to', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
    });
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: rows() });
    await setupTaskStore(page, { tasks: rows() });
    await page.goto(`${BASE_URL}?task=k12`);
    await expect(page.getByText('Work item 12', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Work item 11', { exact: true })).toHaveCount(0);
  });

  test('no-committed-start rolls up into one footer count with a filter; no per-row chip', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const filter = page.getByTestId('schedule-no-start-filter');
    await expect(filter).toContainText('3 no committed start', { timeout: 15_000 });
    await expect(page.getByText('no committed start', { exact: false })).toHaveCount(1);
    await filter.click();
    await expect(page.getByText('Work item 2', { exact: true })).toBeVisible();
    // The defect inside the folded past phase is listed too, under its phase.
    await expect(page.getByText('Past defect', { exact: true })).toBeVisible();
    await expect(page.getByText('Past child', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Work item 3', { exact: true })).toHaveCount(0);
    await filter.click();
    await expect(page.getByText('Work item 3', { exact: true })).toBeVisible();
  });

  test('a blocked row wears a Blocked pill, and only that row (#5106)', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('row-blocked-k3')).toHaveText('Blocked', { timeout: 10_000 });
    await expect(page.locator('[data-testid^="row-blocked-"]')).toHaveCount(1);
  });

  test('a 300-task project opens with at most 3 chrome rows above the grid (#5106)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 296);
    const grid = page.getByRole('treegrid', { name: 'Item list' });
    await expect(grid).toBeVisible({ timeout: 10_000 });
    const chrome = await page.getByTestId('schedule-toolbar-v2').evaluate(
      (bar, gridTop) => {
        const column = bar.parentElement!;
        return Array.from(column.children)
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.height > 2 && r.width > 2 && r.bottom <= gridTop + 1;
          })
          .map(
            (el) =>
              `${el.tagName}.${el.getAttribute('data-testid') ?? ''}.${(el.textContent ?? '').slice(0, 40)}`,
          );
      },
      (await grid.boundingBox())!.y,
    );
    expect(chrome.length).toBeGreaterThanOrEqual(1);
    expect(chrome.length, chrome.join(' | ')).toBeLessThanOrEqual(3);
  });
});
