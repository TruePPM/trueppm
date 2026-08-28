/**
 * The Schedule toolbar fits, at every width (#3076).
 *
 * The defect this replaces was not "cramped": the bar's natural width is
 * ~1,862px, available width is `window − rail − padding` (752px at 1024,
 * 1,648px at 1920), and the parent is `overflow-hidden` — so controls past the
 * right edge were painted nowhere and reachable by **nothing**. Not a pointer,
 * not a scroll (there is none), not a Tab.
 *
 * A browser is the only instrument that can check this. `offsetWidth` is 0 for
 * everything in jsdom, so `toolbarLadder.test.ts` pins the *decision logic* and
 * this pins the *measurement* — rule 300's "when a gate is structurally blind
 * to a property, the unit test asserts the mechanism and a browser asserts the
 * value".
 *
 * Note what `toBeVisible()` cannot do here: a clipped control inside an
 * `overflow-hidden` parent still has a box and still passes it (the #2974
 * lesson). The load-bearing assertion is therefore geometric — every control's
 * right edge inside the bar's right edge — plus `scrollWidth <= clientWidth`.
 *
 * No `setupTaskStore`: nothing here writes, so the stateless list mock cannot
 * erase anything (#2752).
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import {
  MAX_LADDER_STEP,
  pinsFromDisplayOptions,
} from '../src/features/schedule/toolbar/toolbarLadder';
import { DEFAULT_DISPLAY_OPTIONS } from '../src/hooks/useScheduleDisplayOptions';

const PROJECT_ID = 'e2e-tb-00000000-0000-0000-0000-000000003076';
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
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const TASKS = [
  { ...baseRow, id: 'ph', wbs_path: '1', name: 'Assess', is_summary: true, parent_id: null },
  { ...baseRow, id: 'c1', wbs_path: '1.1', name: 'Inventory legacy schemas', is_summary: false, parent_id: 'ph' },
  { ...baseRow, id: 'c2', wbs_path: '1.2', name: 'Profile data quality', is_summary: false, parent_id: 'ph', is_critical: true },
  { ...baseRow, id: 'r2', wbs_path: '2', name: 'Migration tooling', is_summary: false, parent_id: null },
];

/**
 * How many pins a planner who has never opened the Display menu is asking for.
 *
 * Derived, not a literal: this is a product default that moves — #3115 took it
 * from 4 to 3 by shipping `+ Milestone` unpinned — and a hard-coded denominator
 * turns every such move into a spec failure that says nothing about the ladder.
 * What is asserted is the sentence's *shape*: the "N of M" partial-honour branch
 * rather than "All M ... fit". That distinction is the feature.
 */
const DEFAULT_PIN_COUNT = Object.values(pinsFromDisplayOptions(DEFAULT_DISPLAY_OPTIONS)).filter(
  Boolean,
).length;

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Schedule toolbar' });
const outline = (page: Page) => page.getByRole('treegrid', { name: 'Item list' });

async function goto(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
  await page.goto(BASE_URL);
  await expect(outline(page)).toBeVisible({ timeout: 10_000 });
}

/**
 * Does the bar's content fit its box, and is every child inside it?
 *
 * Both halves are needed. `scrollWidth <= clientWidth` is the bar's own view of
 * itself; the per-child right-edge check is what catches a child that overflows
 * while the container reports a stale or rounded width.
 */
async function fitReport(page: Page) {
  return toolbar(page).evaluate((bar) => {
    const barRight = bar.getBoundingClientRect().right;
    const overflowing: string[] = [];
    for (const child of Array.from(bar.children)) {
      const r = child.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // 1px of tolerance for sub-pixel layout rounding.
      if (r.right > barRight + 1) {
        overflowing.push(
          (child.textContent ?? '').trim().slice(0, 40) ||
            child.getAttribute('aria-label') ||
            child.tagName,
        );
      }
    }
    return {
      scrollWidth: bar.scrollWidth,
      clientWidth: bar.clientWidth,
      overflowing,
      step: Number(bar.getAttribute('data-fit-step')),
    };
  });
}

const WIDTHS = [1920, 1440, 1280, 1024] as const;

test.describe('Schedule toolbar — nothing clips at any width (#3076)', () => {
  test.beforeEach(({ page }) => goto(page));

  for (const width of WIDTHS) {
    test(`fits at ${width}px, with every control inside the bar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      // The fit loop runs in a layout effect off a ResizeObserver; wait for it
      // to settle rather than sampling mid-descent.
      await expect
        .poll(async () => (await fitReport(page)).overflowing.length, { timeout: 5_000 })
        .toBe(0);

      const report = await fitReport(page);
      expect(report.overflowing).toEqual([]);
      expect(report.scrollWidth).toBeLessThanOrEqual(report.clientWidth + 1);
      expect(report.step).toBeGreaterThanOrEqual(0);
      expect(report.step).toBeLessThanOrEqual(MAX_LADDER_STEP);
    });
  }

  test('concedes MORE as the window narrows, and gives it back as it widens', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect.poll(async () => (await fitReport(page)).overflowing.length).toBe(0);
    const wide = (await fitReport(page)).step;

    await page.setViewportSize({ width: 1024, height: 900 });
    await expect.poll(async () => (await fitReport(page)).overflowing.length).toBe(0);
    const narrow = (await fitReport(page)).step;
    expect(narrow).toBeGreaterThan(wide);

    // …and back. The hysteresis means this is a real re-widen, not a bounce.
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect.poll(async () => (await fitReport(page)).step, { timeout: 5_000 }).toBe(wide);
  });

  test('no toolbar label wraps inside the 40px bar', async ({ page }) => {
    // The visible artifact #3076 was filed for: the session trail was the one
    // child without `shrink-0`, so it absorbed the whole overflow alone and its
    // label wrapped. A wrapped label is taller than its own line-height.
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => (await fitReport(page)).overflowing.length).toBe(0);
      const tallest = await toolbar(page).evaluate((bar) => {
        let max = 0;
        for (const child of Array.from(bar.querySelectorAll('button, [role="status"], span'))) {
          const r = child.getBoundingClientRect();
          if (r.height > max) max = r.height;
        }
        return max;
      });
      expect(tallest, `a control is taller than the bar at ${width}px`).toBeLessThanOrEqual(40);
    }
  });

  test('an UNPINNED control reads "pin in Display", not "no room at this width"', async ({
    page,
  }) => {
    // The structure trio ships unpinned (#2955), so it is in the menu because
    // the user's defaults put it there — not because the bar ran out of room.
    // A heading that said otherwise would send someone resizing the window to
    // get back something only the Display menu can return.
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect.poll(async () => (await fitReport(page)).overflowing.length).toBe(0);

    await page.getByRole('button', { name: 'Project actions' }).click();
    const menu = page.getByRole('menu', { name: 'Project actions' });
    await expect(menu.getByRole('menuitem', { name: 'Add phase' })).toBeVisible();
    await expect(menu.getByText('Not in the toolbar')).toBeVisible();
    // Nothing was crowded out at 1920 with this fixture, so that heading is absent.
    await expect(menu.getByText('no room at this width')).toHaveCount(0);
  });

  test('unpinning a control moves it into ··· and the Display row says where it went', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect.poll(async () => (await fitReport(page)).overflowing.length).toBe(0);
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible();

    // Drive it through the real pin, not through a width guess: the ladder's
    // step at a given viewport depends on the rail, the project's own strings
    // and the user's pins, so a spec that asserts "Today demotes at 1024"
    // is asserting an accident of this fixture.
    await page.getByRole('button', { name: /^Display/ }).click();
    const display = page.getByRole('menu', { name: 'Display options' });
    await display.getByRole('menuitemcheckbox', { name: /^Today, in the bar/ }).click();

    // The row restates the new location — the whole point of the column.
    await expect(display.getByRole('menuitemcheckbox', { name: /^Today, in ···/ })).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Project actions' }).click();
    const menu = page.getByRole('menu', { name: 'Project actions' });
    await expect(menu.getByRole('menuitem', { name: /Scroll to today/ })).toBeVisible();
    await expect(menu.getByText('Not in the toolbar')).toBeVisible();
  });

  test('a control is never in the bar AND in the menu at the same time', async ({ page }) => {
    // One identity at a time. Duplicate accessible names are the failure mode
    // of every responsive toolbar that hides with CSS instead of unmounting.
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect.poll(async () => (await fitReport(page)).overflowing.length).toBe(0);
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Project actions' }).click();
    const menu = page.getByRole('menu', { name: 'Project actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Scroll to today/ })).toHaveCount(0);
  });

  test('a mode is never behind a click — it collapses to a chip that shows its value', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect.poll(async () => (await fitReport(page)).overflowing.length).toBe(0);

    // The chip states the mode in the bar, at the narrowest composition.
    const chip = page.getByRole('button', { name: /^Mode: Author/ });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Author');

    // And it is NOT in the project-actions menu — a mode you must open a menu
    // to read is a mode you forget you are in.
    await page.getByRole('button', { name: 'Project actions' }).click();
    const menu = page.getByRole('menu', { name: 'Project actions' });
    await expect(menu.getByRole('menuitemcheckbox', { name: /Author mode/ })).toHaveCount(0);
  });

  test('the insert sentence stays in the accessibility tree after its ink is rationed', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect.poll(async () => (await fitReport(page)).overflowing.length).toBe(0);
    // Focus a row so there is a target to describe.
    await page.locator('[data-row-id="c1"]').getByRole('gridcell').first().click();

    const statement = page.getByTestId('schedule-insert-target');
    await expect(statement).toHaveCount(1);
    // Present and readable to AT even where it is not drawn — `display:none`
    // would have taken the + Item button's own description with it.
    await expect(statement).toHaveAttribute('data-density');
    const describedBy = await page
      .getByRole('button', { name: /Add|item/i })
      .first()
      .getAttribute('aria-describedby');
    if (describedBy) {
      expect(await page.locator(`#${describedBy}`).count()).toBe(1);
    }
  });

  test('Display ▾ says where each pinned control currently is', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect.poll(async () => (await fitReport(page)).overflowing.length).toBe(0);

    await page.getByRole('button', { name: /^Display/ }).click();
    const menu = page.getByRole('menu', { name: 'Display options' });
    // `exact` matters: the locked tier-A row's sub-label reads "Always in the
    // toolbar." and collides with the section heading under a substring match.
    await expect(menu.getByText('In the toolbar', { exact: true })).toBeVisible();
    // The right-hand column is the whole feature: the only place in the product
    // that can answer "where did my button go".
    await expect(menu.getByRole('menuitemcheckbox', { name: /^Today,/ })).toBeVisible();
    // Scoped to the paragraph: the section's own note ("pinned controls stay as
    // long as they fit") is the other thing on this surface saying "pinned
    // control", and an unscoped match resolves to both.
    await expect(menu.getByRole('paragraph').filter({ hasText: /pinned control/ })).toBeVisible();
    // At 1024 the ladder cannot honour every pin, and the footer says which —
    // in words, with the two ways to fix it. A pin it overruled is stated,
    // never silently dropped and never allowed to clip the bar.
    await expect(
      menu.getByRole('paragraph').filter({
        hasText: new RegExp(`\\d+ of ${DEFAULT_PIN_COUNT} pinned controls fit at this width`),
      }),
    ).toBeVisible();
  });
});
