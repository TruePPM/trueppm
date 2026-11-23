/**
 * Shell v2 Schedule toolbar, legend and forecast strip (#4796), behind `shell_v2`.
 *
 * The ladder is MEASURED (rule 343), so the only honest assertions are
 * Playwright's: every child's right edge inside the bar's, at each of the four
 * widths the issue names, and the concessions monotonic as the bar narrows.
 * `toBeVisible()` alone is not the assertion — a clipped child of an
 * `overflow-hidden` parent still has a box (#2974).
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

const PROJECT_ID = 'e2e-v2-00000000-0000-0000-0000-000000004796';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Atlas Platform Launch',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const baseRow = {
  early_start: '2026-04-05',
  early_finish: '2026-04-16',
  planned_start: '2026-04-05',
  duration: 10,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  total_float: 12,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const TASKS = [
  { ...baseRow, id: 'ph', wbs_path: '1', name: 'Assess', is_summary: true, parent_id: null },
  {
    ...baseRow,
    id: 'c1',
    wbs_path: '1.1',
    name: 'Inventory legacy schemas',
    is_summary: false,
    parent_id: 'ph',
    total_float: 2,
  },
  {
    ...baseRow,
    id: 'c2',
    wbs_path: '1.2',
    name: 'Profile data quality',
    is_summary: false,
    parent_id: 'ph',
    is_critical: true,
    total_float: 0,
  },
  {
    ...baseRow,
    id: 'r2',
    wbs_path: '2',
    name: 'Migration tooling',
    is_summary: false,
    parent_id: null,
  },
];

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Schedule toolbar' });
const outline = (page: Page) => page.getByRole('treegrid', { name: 'Item list' });

async function goto(page: Page, { v2 = true }: { v2?: boolean } = {}) {
  await page.addInitScript((on: boolean) => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: on }));
  }, v2);
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
  // Registered last so it wins over the default list mock: the reads echo writes.
  await setupTaskStore(page, { tasks: TASKS });
  await page.goto(BASE_URL);
}

/** Children whose right edge escapes the bar, or -1 until the v2 bar has fitted. */
async function clipped(page: Page): Promise<string[] | null> {
  const bar = page.getByTestId('schedule-toolbar-v2');
  if ((await bar.count()) === 0) return null;
  return bar.evaluate((el) => {
    if (el.getAttribute('data-fit-step') === null || el.children.length === 0) return null;
    const right = el.getBoundingClientRect().right;
    return Array.from(el.children)
      .filter((c) => {
        const r = c.getBoundingClientRect();
        return !(r.width === 0 && r.height === 0) && r.right > right + 1;
      })
      .map((c) => (c.textContent ?? '').trim().slice(0, 30) || c.tagName);
  });
}

const step = async (page: Page) =>
  Number(await page.getByTestId('schedule-toolbar-v2').getAttribute('data-fit-step'));

test.describe('shell v2 Schedule toolbar (#4796)', () => {
  test('golden path at 1440: primary controls, persistent legend, no forecast strip', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page);
    await expect(outline(page)).toBeVisible({ timeout: 10_000 });
    const bar = toolbar(page);
    await expect(bar).toHaveAttribute('data-testid', 'schedule-toolbar-v2');
    await expect(bar.getByRole('button', { name: 'Filter' })).toBeVisible();
    await expect(bar.getByRole('button', { name: /Add task/ })).toBeVisible();
    await expect(
      bar.getByRole('button', { name: /^More schedule actions, \d+ items?$/ }),
    ).toBeVisible();

    const legend = page.getByRole('list', { name: 'Schedule legend' });
    await expect(legend).toBeVisible();
    for (const word of ['Critical', 'Near-critical', 'Today']) {
      await expect(legend.getByText(word, { exact: true })).toBeVisible();
    }
    // v1's "Legend" show/hide toggle does not exist: the legend never folds.
    await expect(page.getByRole('button', { name: /^Legend/ })).toHaveCount(0);
    // The docked Monte Carlo strip is gone; the header's P80 stamp is the forecast.
    await expect(page.getByTestId('mc-details-btn')).toHaveCount(0);

    await expect.poll(() => clipped(page)).toEqual([]);
  });

  test('ladder is measured and monotonic across 1440 / 1024 / 768 / 390', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page);
    await expect(toolbar(page)).toBeVisible({ timeout: 10_000 });
    let previous = -1;
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => clipped(page), { message: `nothing clips at ${width}` }).toEqual([]);
      const s = await step(page);
      expect(s, `ladder only concedes as the bar narrows (${width})`).toBeGreaterThanOrEqual(
        previous,
      );
      previous = s;
      // Primary controls never fold.
      await expect(toolbar(page).getByRole('button', { name: 'Filter' })).toBeVisible();
      await expect(toolbar(page).getByRole('button', { name: /Add task/ })).toBeVisible();
      // A demoted command appears in exactly one place: the overflow, counted in its name.
      const inBar = await toolbar(page).getByRole('button', { name: 'Critical only' }).count();
      const trigger = toolbar(page).getByRole('button', { name: /^More schedule actions/ });
      await trigger.click();
      const inMenu = await page.getByRole('menuitemcheckbox', { name: 'Critical only' }).count();
      expect(inBar + inMenu, `Critical only is in one place at ${width}`).toBe(1);
      const name = (await trigger.getAttribute('aria-label')) ?? '';
      expect(name).toBe(
        `More schedule actions, ${5 + (inMenu ? 1 : 0) + (await demotedOthers(page))} items`,
      );
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
    }
    // At 390 every concession has been spent.
    expect(previous).toBeGreaterThan(0);
  });

  test('keyboard: one tab stop, roving arrows, overflow operable', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page);
    const bar = toolbar(page);
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar.locator('[tabindex="0"]')).toHaveCount(1);
    await bar.getByRole('button', { name: 'Filter' }).focus();
    await page.keyboard.press('End');
    const trigger = bar.getByRole('button', { name: /^More schedule actions/ });
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Home');
    await expect(bar.getByRole('button', { name: 'Filter' })).toBeFocused();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`toolbar and legend are axe clean (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await goto(page);
      await expect(toolbar(page)).toBeVisible({ timeout: 10_000 });
      await toolbar(page)
        .getByRole('button', { name: /^More schedule actions/ })
        .click();
      await expect(page.getByRole('menu')).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .include('[data-testid="schedule-toolbar-v2"]')
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }

  test('flag off: v1 toolbar unchanged, no v2 surface', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, { v2: false });
    await expect(toolbar(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('schedule-toolbar-v2')).toHaveCount(0);
    await expect(page.getByTestId('schedule-legend-v2')).toHaveCount(0);
  });
});

/** Today and Baseline demoted alongside Critical only (Baseline absent: no baseline). */
async function demotedOthers(page: Page): Promise<number> {
  return page.getByRole('menuitem', { name: 'Today', exact: true }).count();
}
