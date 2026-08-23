/**
 * Schedule outline row chrome — the containment statement (#3025) and the
 * structural-nudge lane (#3026).
 *
 * Why these need a browser.
 *
 * **#3025** shipped with both strings present and switching correctly on fold
 * state — as a `title` and an `aria-label`. Every unit assertion on the
 * attribute passed, which is exactly why nobody noticed the row never *drew*
 * the count. The assertion that would have caught it is "a user can read this
 * without hovering", and the honest form of that is `toBeVisible()` on rendered
 * text in a real layout: a jsdom test cannot tell a zero-width truncated span
 * from a legible one.
 *
 * **#3026(a)** is a *coupling* defect, not a rendering one: indent and outdent
 * lived inside the WBS cell, so a Display ▸ Columns preference that has nothing
 * to do with restructuring deleted both controls from every row. Proving the
 * coupling is gone means driving the actual menu the user drives, and the
 * persisted-column path only exists end to end.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-rowchrome-0000-0000-0000-000000003025';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Row Chrome Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function taskRow(over: Record<string, unknown>) {
  return {
    early_start: '2026-04-06',
    early_finish: '2026-04-17',
    planned_start: '2026-04-06',
    duration: 10,
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
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    ...over,
  };
}

/**
 * One phase with two children, plus a flat sibling.
 *
 *   1     Mobilization   ← the phase whose count is under test (2 children)
 *   1.1   Survey
 *   1.2   Permits
 *   2     Closeout       ← a leaf, which must state nothing
 */
const TASKS = [
  taskRow({ id: 'mob', wbs_path: '1', name: 'Mobilization', is_summary: true }),
  taskRow({ id: 'survey', wbs_path: '1.1', name: 'Survey', parent_id: 'mob' }),
  taskRow({ id: 'permits', wbs_path: '1.2', name: 'Permits', parent_id: 'mob' }),
  taskRow({ id: 'closeout', wbs_path: '2', name: 'Closeout' }),
];

/**
 * The Schedule reads baselines on mount and the catch-all would answer a *list*
 * envelope for it. Mocked explicitly per the project's catch-all rule — leaning
 * on the net for a shape it does not have is how a page crashes into the root
 * error boundary and surfaces as an unrelated flake.
 */
async function mockBaselines(page: Page) {
  await page.route('**/api/v1/projects/*/baselines/', (route) =>
    route.fulfill({ json: { count: 0, next: null, previous: null, results: [] } }),
  );
}

function outlineRow(page: Page, name: string) {
  return page.getByRole('row').filter({ hasText: name }).first();
}

/** Open Display ▸ Columns and toggle a column by its checkbox name. */
async function toggleColumn(page: Page, column: string) {
  await page
    .getByRole('toolbar', { name: 'Schedule toolbar' })
    .getByRole('button', { name: 'Display' })
    .click();
  const menu = page.getByRole('menu', { name: 'Display options' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitemcheckbox', { name: column, exact: true }).click();
  await page.keyboard.press('Escape');
}

test.describe('Schedule outline row chrome (#3025, #3026)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
    await mockBaselines(page);
    await page.goto(BASE_URL);
    await expect(page.getByRole('treegrid', { name: 'Task list' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('a phase draws its child count at rest — no hover, no tooltip dwell (#3025)', async ({
    page,
  }) => {
    // `toBeVisible`, not `toHaveText`: the defect was that the string existed in
    // an attribute and was never painted, and a `min-w-0` truncation to zero
    // width would reproduce it in a different costume. Neither survives this.
    const phase = outlineRow(page, 'Mobilization');
    await expect(phase.getByText('2 inside')).toBeVisible();
    // And it is there before anything touches the row.
    const box = await phase.getByText('2 inside').boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
  });

  test('the count switches to "N hidden" when the caret folds (#3025)', async ({ page }) => {
    const phase = outlineRow(page, 'Mobilization');
    await phase.getByRole('button', { name: /^Collapse Mobilization/ }).click();
    await expect(phase.getByText('2 hidden')).toBeVisible();
    await expect(phase.getByText('2 inside')).toHaveCount(0);
    // The children really did fold — the statement is describing the plan, not
    // narrating a state nobody applied.
    await expect(outlineRow(page, 'Survey')).toHaveCount(0);
  });

  test('a leaf row states nothing — "0 inside" is true of every task (#3025)', async ({
    page,
  }) => {
    await expect(outlineRow(page, 'Closeout').getByTestId('containment-count')).toHaveCount(0);
  });

  test('indent and outdent survive hiding the WBS column (#3026)', async ({ page }) => {
    // THE defect: the pair lived inside the WBS cell, so this toggle deleted
    // both controls from every row and left right-click as the only pointer
    // route — reinstating the discoverability problem the design placed them
    // there to solve, for a column choice unrelated to restructuring.
    const row = outlineRow(page, 'Survey');
    await expect(row.getByRole('button', { name: /^Indent Survey/ })).toBeVisible();

    await toggleColumn(page, 'WBS');

    await expect(row.getByRole('gridcell', { name: /^WBS/ })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /^Indent Survey/ })).toBeVisible();
    await expect(row.getByRole('button', { name: /^Outdent Survey/ })).toBeVisible();
  });

  test('the pair sits left of the WBS number, never rightward toward delete (#3026)', async ({
    page,
  }) => {
    // A structural nudge and a destructive act must not be neighbours (#2956),
    // so "free it from the WBS column" must not be solved by relocating it.
    const row = outlineRow(page, 'Survey');
    const indent = await row.getByRole('button', { name: /^Indent Survey/ }).boundingBox();
    const wbs = await row.getByRole('gridcell', { name: /^WBS/ }).boundingBox();
    expect(indent).not.toBeNull();
    expect(wbs).not.toBeNull();
    expect((indent?.x ?? 0) + (indent?.width ?? 0)).toBeLessThanOrEqual((wbs?.x ?? 0) + 1);
  });

  test('the nudges hold their space at rest, so the row does not shift on hover (#3026)', async ({
    page,
  }) => {
    // `opacity-[0.32]` with only `opacity` transitioning is what reserves the
    // box. A regression to `opacity-0 group-hover:opacity-100` is invisible in a
    // screenshot and moves every chip to the right of it when the pointer
    // crosses the row — which is why the geometry is compared, not the class.
    const row = outlineRow(page, 'Survey');
    const indent = row.getByRole('button', { name: /^Indent Survey/ });
    const before = await indent.boundingBox();
    expect(before?.width ?? 0).toBeGreaterThan(0);

    await row.hover();
    // Asserted on the wrapper, and via the ROW's hover: a reveal scoped to the
    // 34px lane would need the pointer already on the control, which is the
    // discoverability problem restated. `row.hover()` aims at the row's centre.
    await expect(row.getByTestId('row-structure-nudges-ink')).toHaveCSS('opacity', '1');
    const after = await indent.boundingBox();
    expect(after?.x).toBeCloseTo(before?.x ?? -1, 0);
    expect(after?.width).toBeCloseTo(before?.width ?? -1, 0);
  });

  test('the count is still legible on the Timeline\u2019s narrow outline (#3025)', async ({
    page,
  }) => {
    // The chip is `shrink-0` beside a `shrink truncate` name inside a fixed-width
    // `overflow-hidden` cell, so the name is what degrades — but the Timeline
    // outline is ~268px of columns and now gives 34px of that to the nudge lane.
    // `toBeVisible` on the narrow surface is the assertion rule 316(c) asks for;
    // a chip clipped to zero width would still pass `toHaveText`.
    await page
      .getByRole('radiogroup', { name: 'Schedule layout' })
      .getByRole('radio', { name: 'Timeline' })
      .click();
    await expect(page.getByRole('columnheader')).toHaveCount(2);
    const chip = outlineRow(page, 'Mobilization').getByText('2 inside');
    await expect(chip).toBeVisible();
    const box = await chip.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
  });

  test('a fine pointer reserves the nudge lane too — the first lane a mouse pays for (#3026)', async ({
    page,
  }) => {
    // `resolveGripReserve(false)` is 0, so before #3026 the fine-pointer outline
    // reserved nothing at all and `resolveOutlineLeftReserve(false, true)` was a
    // constant zero. The nudges are in flow and always drawn, so the desktop
    // outline is now 34px wider — asserted here because the coarse spec's
    // equivalent cannot see a regression that only zeroes the fine branch.
    const header = page.getByRole('row', { name: 'Task list columns' });
    const headerWbs = await header.getByRole('columnheader', { name: /Work breakdown/ }).boundingBox();
    const outlineBox = await page.getByRole('treegrid', { name: 'Task list' }).boundingBox();
    expect(headerWbs).not.toBeNull();
    expect(outlineBox).not.toBeNull();
    // The WBS column starts a full lane in from the panel's left edge.
    expect((headerWbs?.x ?? 0) - (outlineBox?.x ?? 0)).toBeCloseTo(34, 0);

    // …and the rows agree with the header, which is the thing the shared reserve
    // exists to guarantee.
    const rowWbs = await outlineRow(page, 'Survey')
      .getByRole('gridcell', { name: /^WBS/ })
      .boundingBox();
    expect(rowWbs?.x).toBeCloseTo(headerWbs?.x ?? -1, 0);
  });

  test('the resting pair is drawn at 32%, not hidden outright (#3026)', async ({ page }) => {
    // No test pinned this before — which is how a tidy-up to `opacity-0` would
    // have landed green.
    // Read the element the class is ON. `getComputedStyle` does not multiply an
    // ancestor's opacity through, so asserting on the button reports `1`
    // unconditionally — it would pass on a regression to `opacity-0` too.
    const ink = outlineRow(page, 'Survey').getByTestId('row-structure-nudges-ink');
    await expect(ink).toBeVisible();
    const opacity = await ink.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeCloseTo(0.32, 2);
  });
});
