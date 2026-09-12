/**
 * Outline row popovers on the Timeline's narrow outline column (#3664).
 *
 * The sweep on #3663 fixed one hand-rolled `absolute`-anchored panel (the
 * session-trail popover). It also found the same class sitting six more times,
 * all inside `TaskListPanel`'s `overflow-x-hidden overflow-y-auto` virtualized
 * scroll wrapper: `NameAutocomplete`, `OwnerAutocomplete`, `TokenAutocomplete`,
 * `SprintPrompt`, `MilestoneDatePopover`, and the guardrail-notice wrapper in
 * `TaskListRow.tsx`. On the Timeline surface the outline is only ~268px wide
 * (Grid's is ~600px, which is why nobody hit this in a Grid-mode screenshot) —
 * a 220-280px panel anchored `left-0` inside that column has nowhere to grow
 * without spilling past the wrapper's clipping edge.
 *
 * These surfaces had NO E2E coverage before this spec (`grep -rln autocomplete
 * packages/web/e2e/` returned three unrelated specs) — reproducing the clip is
 * part of the work, not a given.
 *
 * Two assertion styles, both required because neither alone proves escape:
 *  - DOM containment: the open panel must NOT be a descendant of the outline's
 *    scroll wrapper. This is the property `useAnchoredPopover` establishes by
 *    portaling to `document.body` — a z-index bump could never produce it, only
 *    leaving the subtree can — and it is true regardless of viewport size,
 *    since `getBoundingClientRect()` reports an element's own geometry whether
 *    or not an ancestor's `overflow-x-hidden` is painting over part of it.
 *  - The four viewport bounds (top/bottom/left/right), read off `boundingBox()`
 *    against `page.viewportSize()` — the same shape #3663's own E2E assertion
 *    used. The viewport is deliberately narrow (matching that precedent): wide
 *    enough for the Schedule's desktop layout, narrow enough that a panel which
 *    escapes the ~268px outline without being clamped also escapes the window,
 *    which is what makes the assertion able to fail at all.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-popover-0000000-0000-0000-0000-000000003664';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Popover Bounds Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const baseRow = {
  early_start: '2026-04-05',
  early_finish: '2026-04-09',
  planned_start: '2026-04-05',
  duration: 5,
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
};

const TASKS = [
  { ...baseRow, id: 'phase', wbs_path: '1', name: 'Foundation Phase', is_summary: true },
  {
    ...baseRow,
    id: 'ms1',
    wbs_path: '1.1',
    name: 'Foundation sign-off',
    parent_id: 'phase',
    is_milestone: true,
    duration: 0,
    early_finish: '2026-04-05',
  },
  { ...baseRow, id: 'named', wbs_path: '1.2', name: 'Wireframes', parent_id: 'phase' },
  { ...baseRow, id: 'draft', wbs_path: '1.3', name: 'Draft row', parent_id: 'phase' },
];

const outline = (page: Page) => page.getByRole('treegrid', { name: 'Item list' });
const layout = (page: Page) => page.getByRole('radiogroup', { name: 'Schedule layout' });

/**
 * Switch to the Timeline surface (WBS + Task only, ~268px total — see
 * `scheduleSurface.ts`). The Schedule mounts in Author with the Grid layout by
 * default, so this is a deliberate act, not the starting state.
 */
async function switchToTimeline(page: Page) {
  await layout(page).getByRole('radio', { name: 'Timeline' }).click();
  await expect(layout(page).getByRole('radio', { name: 'Timeline' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
}

async function goto(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
  await page.goto(BASE_URL);
  await expect(outline(page)).toBeVisible({ timeout: 10_000 });
}

type Role = Parameters<Page['getByRole']>[0];

/**
 * Assert the open panel identified by `role`+`name` escaped BOTH the clipping
 * ancestor's subtree and the real browser viewport. Shared by every site below
 * so the two required properties (DOM escape, viewport containment) are
 * asserted identically everywhere, rather than each test re-deriving its own
 * version.
 */
async function assertEscapedTheClip(page: Page, role: Role, name: string) {
  const panel = page.getByRole(role, { name });
  await expect(panel).toBeVisible();

  // DOM containment: everything the outline renders — every row, every cell,
  // every hand-rolled popover this issue is about — sits inside the treegrid's
  // subtree, because that subtree IS `TaskListPanel`'s `overflow-x-hidden
  // overflow-y-auto` scroll wrapper. A locator scoped to the treegrid finds
  // the panel only while it is still an in-flow descendant; once portaled to
  // `document.body` it is a sibling of the whole app, not a descendant of
  // anything the outline renders. This is exactly the vitest layer's
  // `container.contains(panel) === false` assertion, expressed as a locator
  // count rather than a DOM handle, and it fails on the pre-fix component
  // regardless of viewport size — `getBoundingClientRect()` reports an
  // element's own geometry whether or not an ancestor's `overflow-x-hidden`
  // is painting over part of it, so a bounds-only check could pass on
  // clipped-but-never-off-window geometry (see the module header).
  await expect(outline(page).getByRole(role, { name })).toHaveCount(0);

  // The four viewport bounds — box.x/y non-negative, box right/bottom edges
  // inside the window. Non-vacuous only because the fixture's viewport (below)
  // is narrow enough that escaping the ~268px outline without the hook's clamp
  // also escapes the window; see the module header.
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error('the open popover has no box to measure');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

test.describe('Outline row popovers stay inside the viewport on the Timeline (#3664)', () => {
  test.use({ viewport: { width: 900, height: 800 } });

  test.beforeEach(({ page }) => goto(page));

  // MilestoneDatePopover is NOT exercised here: `TaskStartCell` (its only call
  // site) renders behind `visible.start`, and `surfaceColumnVisibility` (#2960)
  // narrows the Timeline's column profile to `wbs` + `task` only — so the Start
  // cell, and the popover anchored to it, cannot open on the Timeline surface
  // at all today. The issue's own text flags this class of finding as static
  // ("not reproduced at runtime"); this is exactly that gap for this one site.
  // Its conversion is still correct and defensive (a future column-visibility
  // or reorder change could make it reachable there), and it keeps its own
  // portal-escape coverage at the vitest layer
  // (`MilestoneDatePopover.test.tsx` — "renders OUTSIDE the caller subtree").

  test('the name autocomplete opens fully inside the viewport', async ({ page }) => {
    await switchToTimeline(page);

    await page.getByText('Draft row').click();
    await page.keyboard.press('F2');
    const input = page.getByRole('textbox', { name: /Rename item Draft row/ });
    await expect(input).toBeVisible();
    // Matches the fixture's other task, "Wireframes" — the suggestion source.
    await input.fill('Wire');

    await assertEscapedTheClip(page, 'listbox', 'Task name suggestions');
  });

  test('golden path: picking a name suggestion commits it and closes the popover', async ({
    page,
  }) => {
    const patches: Record<string, unknown>[] = [];
    await page.route('**/api/v1/tasks/draft/', async (route) => {
      if (route.request().method() === 'PATCH') {
        patches.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...TASKS[3], name: 'Wireframes' }),
        });
        return;
      }
      await route.fallback();
    });

    await switchToTimeline(page);
    await page.getByText('Draft row').click();
    await page.keyboard.press('F2');
    const input = page.getByRole('textbox', { name: /Rename item Draft row/ });
    await input.fill('Wire');

    const panel = page.getByRole('listbox', { name: 'Task name suggestions' });
    await expect(panel).toBeVisible();
    await panel.getByRole('option', { name: 'Wireframes' }).click();

    await expect.poll(() => patches.length).toBeGreaterThan(0);
    expect(patches[0].name).toBe('Wireframes');
    await expect(panel).toHaveCount(0);
  });
});
