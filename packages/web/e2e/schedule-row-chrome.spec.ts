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
    await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({
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
    // outline is ~268px of columns and now gives 52px of that to the nudge lane.
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

  test('a fine pointer reserves BOTH lanes — the grip\'s and the nudges\' (#3026, #3078)', async ({
    page,
  }) => {
    // Before #3026 the fine-pointer outline reserved nothing at all and
    // `resolveOutlineLeftReserve(false, true)` was a constant zero. The nudges
    // are in flow and always drawn, so the desktop outline gained a lane —
    // three 16px controls and two 2px gaps, 52px since the ◆ milestone toggle
    // joined the cluster (#3257) — asserted here because the coarse spec's
    // equivalent cannot see a regression that only zeroes the fine branch.
    //
    // #3078 added the grip's own 14px to it. Until then the grip drew inside
    // this same 52px, on top of the ⇤, because `resolveGripReserve(false)` was
    // 0 — so the total was 52 and the row still lined up with the header while
    // one control sat on another. The number is now 66, and the test below
    // pins the property the number is only a proxy for.
    const header = page.getByRole('row', { name: 'Item list columns' });
    const headerWbs = await header.getByRole('columnheader', { name: /Work breakdown/ }).boundingBox();
    const outlineBox = await page.getByRole('treegrid', { name: 'Item list' }).boundingBox();
    expect(headerWbs).not.toBeNull();
    expect(outlineBox).not.toBeNull();
    // The WBS column starts both lanes in from the panel's left edge: 14 + 52.
    expect((headerWbs?.x ?? 0) - (outlineBox?.x ?? 0)).toBeCloseTo(66, 0);

    // …and the rows agree with the header, which is the thing the shared reserve
    // exists to guarantee.
    const rowWbs = await outlineRow(page, 'Survey')
      .getByRole('gridcell', { name: /^WBS/ })
      .boundingBox();
    expect(rowWbs?.x).toBeCloseTo(headerWbs?.x ?? -1, 0);
  });

  test('the drag grip never covers the \u21e4 outdent, on the SELECTED row (#3078)', async ({
    page,
  }) => {
    // The defect this file exists to keep out, asserted the only way it can be
    // seen: by hit-testing, in a browser, on a row that is actually selected.
    //
    // Why every other layer was blind to it. The grip is `absolute left-0
    // z-10`, so it takes no space and shifts nothing — the header and the rows
    // agreed on every width while the grip lay on top of the \u21e4. jsdom computes
    // no layout, so a vitest render sees two elements that both "exist". And a
    // bounding-box assertion in this file would have passed too, because the
    // \u21e4's own box was always the right size; it was simply underneath
    // something. `elementFromPoint` is the question the user is asking.
    //
    // On the SELECTED row specifically, because that is the state the report
    // was made from and the one a `hover()`-based test would miss the point of:
    // both the grip and the nudges reveal on `group-hover` AND
    // `group-focus-within`, so clicking a row to work on it pins the collision
    // in place for as long as the row stays selected. A transient hover overlap
    // would be a blemish; this made the control unusable on the row the user
    // had chosen.
    const row = outlineRow(page, 'Survey');
    await row.getByRole('gridcell', { name: /Survey/ }).first().click();

    const outdent = row.getByRole('button', { name: /^Outdent Survey/ });
    await expect(outdent).toBeVisible();

    // Sampled ACROSS the button's width, not at its corners. The failure mode
    // is one control lying over another horizontally — the grip covered the
    // left 14px of a 16px button and left a 2px seam on the right — so a single
    // centre probe is exactly the sample that can land in the seam and report
    // success. A corner probe is the opposite mistake: `rounded-control` clips
    // hit-testing to the radius, so a 2px corner inset tests the border radius
    // rather than the stacking, and it fails on correct code (it did, here,
    // before this was reshaped).
    //
    // `elementFromPoint` returns the topmost node, so `contains` accepts a hit
    // on the button's own glyph child while rejecting anything above it.
    const FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];
    const verdict = await outdent.evaluate((el, fractions) => {
      const r = el.getBoundingClientRect();
      return fractions.map((f) => {
        const hit = document.elementFromPoint(r.left + r.width * f, r.top + r.height / 2);
        return {
          atWidthFraction: f,
          ownedByOutdent: hit != null && el.contains(hit),
          coveredBy: hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        };
      });
    }, FRACTIONS);

    // Asserted on the array rather than as a count, so a failure prints WHICH
    // part of the button is buried and under what. Before the fix the first
    // four probes reported `row-reorder-grip`, and only the 0.9 sample — the
    // 2px seam past the grip's right edge — belonged to the button.
    expect(verdict.map((v) => v.coveredBy)).not.toContain('row-reorder-grip');
    expect(verdict.filter((v) => !v.ownedByOutdent)).toEqual([]);

    // …and the grip is still there, at full strength, in its own lane — the
    // collision is resolved by giving it room, not by hiding it on the row
    // where the user is most likely to want to drag.
    const grip = row.locator('[data-testid="row-reorder-grip"]');
    await expect(grip).toBeVisible();
    const [gripBox, outdentBox] = await Promise.all([grip.boundingBox(), outdent.boundingBox()]);
    expect(gripBox?.x ?? 0).toBeLessThan(outdentBox?.x ?? 0);
    expect((gripBox?.x ?? 0) + (gripBox?.width ?? 0)).toBeLessThanOrEqual((outdentBox?.x ?? 0) + 0.5);
  });

  test('the insert `+` draws NO tap box on a fine pointer, and stays a 16px mark (#3029)', async ({
    page,
  }) => {
    // The counterweight to the coarse fix, asserted in the ONLY layer that can
    // see it. jsdom renders no pseudo-element geometry — which is exactly how
    // `before:-inset-3.5` was believed to measure 44 when it measured 42 — so a
    // vitest `not.toContain('before:absolute')` cannot distinguish "no box"
    // from "a box that is drawn anyway".
    //
    // Here the disc is hover-revealed, so a 44px `z-10` box around it would be
    // an UNSEEN target lying over the row's name cell, which takes inline
    // rename and F2: a planner clicking to rename would sometimes insert a row
    // instead. That is worse than a small visible target, so the fine-pointer
    // disc deliberately keeps its own 16px box (option (a) of #3029). If this
    // test ever fails, that decision is back open — do not just update it.
    const row = outlineRow(page, 'Survey');
    await row.hover();
    const insert = row.getByRole('button', { name: /Insert an item below Survey/ });
    await expect(insert).toBeVisible();

    const geom = await insert.evaluate((el) => {
      const before = window.getComputedStyle(el, '::before');
      return {
        content: before.content,
        width: before.width,
        height: before.height,
        discWidth: el.getBoundingClientRect().width,
        discHeight: el.getBoundingClientRect().height,
      };
    });
    // No generated content at all: the `before:` classes are coarse-only, so
    // the pseudo-element never boxes on a mouse.
    expect(geom.content, 'fine-pointer ::before content').toBe('none');
    expect(geom.discWidth, 'disc width').toBeCloseTo(16, 0);
    expect(geom.discHeight, 'disc height').toBeCloseTo(16, 0);
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
