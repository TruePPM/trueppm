import { test, expect, type Page } from './fixtures/coverage';
import { expectNoA11yViolations, setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

/**
 * Shell v2 Board page (#4797), behind `?ff=shell_v2`. Phase lanes, five toolbar
 * controls, four equal columns above the fold. Card moves go through the same
 * PATCH the v1 board sends, so the write is asserted on the wire; the list mock
 * is `setupTaskStore` so the post-move DOM is the refetch's, not the optimistic patch's.
 */

const PID = 'e2e-board2-00000000-0000-0000-0000-000000004797';
const BASE = `/projects/${PID}`;
const PROJECTS = [
  {
    id: PID,
    name: 'Board v2 Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const shape = {
  early_start: '2026-04-05',
  early_finish: '2026-04-10',
  duration: 5,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const PHASE = {
  ...shape,
  id: 'phase-1',
  wbs_path: '1',
  name: 'Discovery',
  early_finish: '2026-04-30',
  duration: 25,
  is_summary: true,
  parent_id: null,
  status: 'IN_PROGRESS',
};
const card = (n: number, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  ...shape,
  id: `c${n}`,
  wbs_path: `1.${n}`,
  name,
  parent_id: 'phase-1',
  status,
  ...extra,
});
const TASKS = [
  PHASE,
  card(1, 'Write brief', 'NOT_STARTED', { is_critical: true }),
  card(2, 'Interview users', 'IN_PROGRESS'),
  card(3, 'Draft report', 'REVIEW', { total_float: 2 }),
  card(4, 'Kickoff', 'COMPLETE'),
];

async function open(page: Page, tasks: object[] = TASKS, theme?: 'dark') {
  if (theme) await page.addInitScript((t) => localStorage.setItem('trueppm.theme', t), theme);
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: PROJECTS,
    projectId: PID,
    tasks,
    statusSummary: { task_count: tasks.length },
  });
  await page.route('**/api/v1/programs/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  const store = await setupTaskStore(page, { tasks });
  await page.goto(`${BASE}/board?ff=shell_v2`);
  await expect(page.getByTestId('board2')).toBeVisible({ timeout: 15_000 });
  return store;
}

test.describe('shell v2 board', () => {
  test.describe('desktop 1440', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('four columns fit without horizontal scroll and the first card starts above the fold', async ({
      page,
    }) => {
      await open(page);
      for (const label of ['NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'COMPLETE']) {
        await expect(page.getByTestId('board2-colhead-' + label)).toBeVisible();
      }
      const scrolls = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="board2"]')!;
        let n: Element | null = el;
        while (n) {
          if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== 'visible')
            return true;
          n = n.parentElement;
        }
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(scrolls).toBe(false);
      const top = (await page.locator('[data-board2-card]').first().boundingBox())?.y ?? Infinity;
      expect(top).toBeLessThanOrEqual(279);
      const toolbar = page.getByRole('toolbar', { name: 'Board controls' });
      await expect(toolbar.getByRole('button')).toHaveCount(5);
      await expect(
        page.getByTestId('board2-lane').getByRole('button', { name: /Discovery/ }),
      ).toContainText('▲ 1 critical');
    });

    test('moves a card with the keyboard and the write survives the refetch', async ({ page }) => {
      const store = await open(page);
      const c = page.locator('[data-board2-card="c1"]');
      await c.focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Space');
      await expect.poll(() => store.patches.length).toBeGreaterThan(0);
      expect(store.patches[0]).toMatchObject({ status: 'IN_PROGRESS' });
      await expect(
        page.getByRole('list', { name: 'In Progress in Discovery' }).getByText('Write brief'),
      ).toBeVisible();
    });

    test('the empty backlog pane is open, quiet, and names the actions that fill it', async ({
      page,
    }) => {
      await open(page);
      const pane = page.getByTestId('board2-backlog-empty');
      await expect(pane.getByRole('button', { name: 'Add to backlog' })).toBeVisible();
      await expect(pane.getByRole('link', { name: 'Import tasks' })).toBeVisible();
    });

    test('offline: the board says it is showing a saved copy', async ({ page }) => {
      await open(page);
      await page.context().setOffline(true);
      await expect(page.getByText(/Board is showing your .* copy/)).toBeVisible();
      await expect(page.getByText(/Moves you make now are queued/)).toBeVisible();
      await page.context().setOffline(false);
    });

    for (const theme of [undefined, 'dark'] as const) {
      test(`axe is clean (${theme ?? 'light'})`, async ({ page }, testInfo) => {
        await open(page, TASKS, theme);
        await expectNoA11yViolations(page, testInfo);
      });
    }
  });

  test.describe('desktop 1024', () => {
    test.use({ viewport: { width: 1024, height: 768 } });
    test('four columns still fit with no horizontal scroll', async ({ page }) => {
      await open(page);
      await expect(page.getByTestId('board2-colhead-COMPLETE')).toBeVisible();
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(over).toBe(false);
    });
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test('status pills are a 44px tablist showing one column at a time', async ({ page }) => {
      await open(page);
      const tabs = page.getByRole('tablist', { name: 'Status' }).getByRole('tab');
      await expect(tabs).toHaveCount(4);
      expect((await tabs.first().boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      await expect(page.getByText('Write brief')).toBeVisible();
      await tabs.nth(1).click();
      await expect(page.getByText('Interview users')).toBeVisible();
      await expect(page.getByText('Write brief')).toHaveCount(0);
    });
  });
});
