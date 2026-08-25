/**
 * Grid ↔ Timeline: two surfaces over ONE row model (#2960, was #1221).
 *
 * The claim under test is the one #2960 exists to make true: **the timeline
 * renders the same rows as the grid**, with Dur / Start / Finish / % / Owner
 * swapped for the bar track. Before #2960 the Timeline did not render the
 * outline at all, so this spec asserted the exact opposite — that the task list
 * disappeared — and every piece of row chrome the outline grew afterwards (fold
 * carets, depth guides, phase bands, the mode gutter, the ⋮⋮ grip, the insert
 * points) existed on one surface only.
 *
 * So the assertions here are about *sameness*: the same row ids, in the same
 * order, at the same depth, folded the same, with only the column set differing.
 * A future change that reintroduces a Timeline-specific row list fails here.
 *
 * No `setupTaskStore` here on purpose: nothing in this spec writes. Fold state
 * lives in `useWbsStore` (client-side), and the surface switch is a store write
 * with no request behind it — so the stateless list mock cannot erase anything.
 * The specs that DO assert DOM state after a write use it (#2752).
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { resolveOutlineLeftReserve } from '../src/features/schedule/scheduleConstants';

const PROJECT_ID = 'e2e-vm-00000000-0000-0000-0000-000000002960';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Alpha Platform Upgrade',
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

/** A phase with two children plus a root sibling, so depth and fold are observable. */
const TASKS = [
  { ...baseRow, id: 'ph', wbs_path: '1', name: 'Discovery & Design', is_summary: true, parent_id: null },
  { ...baseRow, id: 'c1', wbs_path: '1.1', name: 'Wireframes', is_summary: false, parent_id: 'ph' },
  { ...baseRow, id: 'c2', wbs_path: '1.2', name: 'Design review', is_summary: false, parent_id: 'ph' },
  { ...baseRow, id: 'r2', wbs_path: '2', name: 'Backend implementation', is_summary: false, parent_id: null },
];

const layout = (page: Page) => page.getByRole('radiogroup', { name: 'Schedule layout' });
const outline = (page: Page) => page.getByRole('treegrid', { name: 'Task list' });

/** Row id + depth + fold state, in render order — the whole shared row model. */
async function rowModel(page: Page) {
  return page.locator('[data-row-id]').evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute('data-row-id'),
      level: el.getAttribute('aria-level'),
      expanded: el.getAttribute('aria-expanded'),
    })),
  );
}

async function goto(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
  await page.goto(BASE_URL);
  await expect(outline(page)).toBeVisible({ timeout: 10_000 });
}

test.describe('Grid ↔ Timeline — one row model, two surfaces (#2960)', () => {
  test.beforeEach(({ page }) => goto(page));

  test('defaults to Grid with the full column set', async ({ page }) => {
    await expect(layout(page).getByRole('radio', { name: 'Grid' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(outline(page)).toBeVisible();
    await expect(page.getByRole('columnheader')).toHaveCount(8);
  });

  test('Timeline keeps the outline and swaps the data columns for the bar track', async ({
    page,
  }) => {
    const before = await rowModel(page);
    expect(before.map((r) => r.id)).toEqual(['ph', 'c1', 'c2', 'r2']);

    await layout(page).getByRole('radio', { name: 'Timeline' }).click();
    await expect(layout(page).getByRole('radio', { name: 'Timeline' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // The outline is STILL THERE — this is the inversion of the #1221 spec.
    await expect(outline(page)).toBeVisible();
    // …with the same rows, in the same order, at the same depth, folded the same.
    expect(await rowModel(page)).toEqual(before);

    // Only the columns moved: WBS + Item remain, the six data columns are gone.
    await expect(page.getByRole('columnheader')).toHaveCount(2);
    await expect(page.getByRole('columnheader', { name: 'Work breakdown structure' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Item' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Start date' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Finish date' })).toHaveCount(0);
    // Links is a Grid column (#3023): on the Timeline the edges are drawn, so a
    // cell restating them is the same fact twice in the narrower surface.
    await expect(page.getByRole('columnheader', { name: 'Dependency links' })).toHaveCount(0);

    // And the bar track still occupies the rest of the surface.
    await expect(page.getByTestId('schedule-canvas-scroll')).toBeVisible();
  });

  test('the outline narrows but does not move off the left edge', async ({ page }) => {
    // The legend and the unscheduled gutter are anchored to the panel's width;
    // before #2960 that width was hard-coded to 0 in Timeline because there was
    // no panel. A box at x<0 would pass toBeVisible and be unreachable (web
    // rule 319(a)), so assert the geometry rather than visibility alone.
    const gridBox = await outline(page).boundingBox();
    await layout(page).getByRole('radio', { name: 'Timeline' }).click();
    await expect(page.getByRole('columnheader')).toHaveCount(2);
    const timelineBox = await outline(page).boundingBox();

    expect(gridBox).not.toBeNull();
    expect(timelineBox).not.toBeNull();
    expect(timelineBox!.x).toBeGreaterThanOrEqual(0);
    expect(timelineBox!.x).toBeCloseTo(gridBox!.x, 0);
    expect(timelineBox!.width).toBeLessThan(gridBox!.width);
  });

  test('fold state is shared, not re-derived — collapsing on Timeline survives the switch back', async ({
    page,
  }) => {
    await layout(page).getByRole('radio', { name: 'Timeline' }).click();
    await expect(page.getByRole('columnheader')).toHaveCount(2);

    // The phase's own fold caret — the same control the Grid has, because it is
    // the same markup.
    const phaseRow = page.locator('[data-row-id="ph"]');
    await expect(phaseRow).toHaveAttribute('aria-expanded', 'true');
    await phaseRow.getByRole('button', { name: /Collapse Discovery & Design/ }).click();
    await expect(phaseRow).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-row-id="c1"]')).toHaveCount(0);

    await layout(page).getByRole('radio', { name: 'Grid' }).click();
    await expect(page.getByRole('columnheader')).toHaveCount(8);
    // Still collapsed: one fold state, not one per surface.
    await expect(page.locator('[data-row-id="ph"]')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-row-id="c1"]')).toHaveCount(0);
  });

  test('the Timeline choice persists', async ({ page }) => {
    // The reload round-trip is exercised by the scheduleStore unit test; doing
    // it here races the post-reload fetch against the auth re-seed and trips the
    // session-expired modal (CLAUDE.md). Verify the persisted value directly.
    await layout(page).getByRole('radio', { name: 'Timeline' }).click();
    await expect(page.getByRole('columnheader')).toHaveCount(2);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('schedule.viewMode')))
      .toBe('timeline');
  });
});

test.describe('Grid ↔ Timeline — a viewer gets absence on BOTH surfaces (#2960, web rule 302)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
    // Two overrides, because a viewer is two facts since #3034. The
    // project-level "is there an authoring mode at all" gate is the server's
    // `can_author` (ADR-0773 §(d)) — NOT the role ordinal, which is what let a
    // Scheduler through. The role still decides the per-row verdict, so both are
    // set. Registered AFTER `setupApiMocks`, since Playwright matches the most
    // recent registration first.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ...PROJECTS[0], can_author: false }),
          })
        : route.continue(),
    );
    // ROLE_VIEWER is **1**, not 100 — 100 is MEMBER, which can edit tasks
    // (ADR-0072). `useCurrentUserRole` reads row 0 of the array.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'mem-viewer', role: 1, role_label: 'Viewer', user_id: 'e2e-user' },
        ]),
      }),
    );
    await page.goto(BASE_URL);
    await expect(page.getByRole('treegrid', { name: 'Task list' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('reads the plan on the Timeline with no authoring apparatus offered', async ({ page }) => {
    await layout(page).getByRole('radio', { name: 'Timeline' }).click();
    await expect(page.getByRole('columnheader')).toHaveCount(2);

    // The rows are all there — absence must remove what AUTHORS the plan, never
    // what READS it.
    expect((await rowModel(page)).map((r) => r.id)).toEqual(['ph', 'c1', 'c2', 'r2']);

    // …and nothing that mutates it is on offer, disabled or otherwise.
    await expect(page.getByRole('button', { name: /^Add item/ })).toHaveCount(0);
    await expect(page.getByTestId('row-reorder-grip')).toHaveCount(0);

    // A right-click over the bar track offers the browser's own menu rather than
    // ours: a viewer must not be shown the shape of an action they cannot take.
    const canvas = page.getByTestId('schedule-canvas-scroll');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 200, box!.y + 28 + 14, { button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

test.describe('Grid ↔ Timeline — a coarse pointer on the Timeline (#2960/#2997)', () => {
  // The left-edge lanes are subtracted from no column, so on the Timeline's
  // ~268px outline they are a large fraction of the name column. The failure
  // mode if the panel's box and its rows disagree about them has no visual
  // symptom — the row content simply overruns the box it is drawn in.
  test.use({ hasTouch: true, isMobile: false, viewport: { width: 1400, height: 900 } });

  test('the outline reserves BOTH left-edge lanes in its own box', async ({ page }) => {
    await goto(page);
    await layout(page).getByRole('radio', { name: 'Timeline' }).click();
    await expect(page.getByRole('columnheader')).toHaveCount(2);

    // The grip is present (this reader can author) and the outline is wider than
    // the fine-pointer 268px by exactly the lanes it reserves — read from the
    // shared resolver rather than restated, so #3026 adding a second lane is a
    // one-line change here instead of a mystery arithmetic failure.
    await expect(page.getByTestId('row-reorder-grip').first()).toBeVisible();
    const box = await outline(page).boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.width)).toBe(268 + resolveOutlineLeftReserve(true, true));

    // …and the rows still fit inside it, which is the thing the shared reserve
    // exists to guarantee.
    const rowBox = await page.locator('[data-row-id="ph"]').boundingBox();
    expect(rowBox).not.toBeNull();
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  });
});

test.describe('Grid ↔ Timeline — an empty project (#2960)', () => {
  test('switching to Timeline leaves the blank-project surface intact', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: [] });
    await page.goto(BASE_URL);
    await expect(page.getByRole('treegrid', { name: 'Task list' })).toBeVisible({
      timeout: 10_000,
    });

    // A blank project opens with a live draft row in the outline (#2733) and the
    // fill options to its right. That arrangement is the Grid's already; the
    // Timeline inherits it verbatim rather than dropping half of it.
    await expect(page.getByRole('columnheader')).toHaveCount(8);
    await layout(page).getByRole('radio', { name: 'Timeline' }).click();
    await expect(page.getByRole('columnheader')).toHaveCount(2);
    await expect(page.getByRole('treegrid', { name: 'Task list' })).toBeVisible();
    await expect(page.locator('[data-row-id]')).toHaveCount(0);
  });
});
