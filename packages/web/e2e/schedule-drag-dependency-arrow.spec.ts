/**
 * Drag-preview dependency-arrow repaint E2E (#1499 backfill, #1908).
 *
 * #1499 fixed `GanttEngineImpl.updateTask` to set `_barsRepaintPending = true`
 * on a geometry-changing patch (start/finish/parentId) instead of only adding
 * the row to `_dirtyRows`. `useScheduleCommit` calls `engine.updateTask` on
 * `drag-task-end` to preview a reschedule (ADR-0067 pull-to-commit) while the
 * commit popover is open and before Confirm — this is exactly the window
 * where a predecessor's dependency arrows must already reflect its new,
 * unconfirmed position, or the popover shows a moved bar with visibly stale
 * connectors.
 *
 * The engine-level regression — assert `prepareDependencyLayout` is
 * re-invoked before the next painted frame, and not the single-row
 * `_dirtyRows` path — is covered at the vitest layer in
 * `GanttEngineImpl.test.ts` ("updateTask repairs dependency arrows (#1499)").
 * That test directly asserts the mechanism the bug fix changed and is the
 * true regression net for this issue.
 *
 * A pixel-level Playwright assertion of the arrow's on-screen path was
 * investigated for this spec (region checksums, column scans of the
 * bars-layer canvas) and deliberately dropped: it does not discriminate the
 * bug. A synthetic revert of the #1499 fix (`_barsRepaintPending = true` →
 * `_dirtyRows.add(idx)`, i.e. reproducing the pre-fix code path) was
 * verified locally to still pass a checksum-based "did this region repaint"
 * assertion, because ending a drag gesture triggers other legitimate
 * full-viewport repaints (selection highlight spans the full row band, not
 * just the bar) that are unrelated to whether the dependency-arrow cache
 * itself was rebuilt. A test that passes identically on both the buggy and
 * fixed engine provides no regression protection and would be worse than no
 * test — it was not shipped. Per the codebase's own precedent (see the
 * header comments in `schedule-build-mode.spec.ts` and
 * `schedule-commit-popover.spec.ts`), canvas-pixel-level structural
 * assertions belong at the vitest layer, not here.
 *
 * What this spec DOES assert, end-to-end, with a real synthetic-pointer
 * canvas drag (the same technique as `drag-to-link.spec.ts`) — the
 * user-facing contract around the preview window that #1499's fix serves:
 *   - Dragging a predecessor with a live successor link opens the commit
 *     popover showing genuinely different old/new dates — the preview took
 *     effect before Confirm (the exact window `useScheduleCommit` docs as
 *     "the bar's visual position already matches" ahead of the PATCH).
 *   - The accessible dependency relationship ("Depends on: Foundation" on
 *     the successor) survives the drag-preview and repaint cycle — the link
 *     is never silently dropped.
 *   - Cancel reverts cleanly, leaving the relationship intact.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-arrowtrack-0000-0000-0000-000000001499';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Arrow Track Project', description: '', start_date: '2026-04-01', calendar: 'default' },
];

const FIXTURE_TASKS = [
  {
    id: 'bm1', wbs_path: '1', name: 'Foundation',
    early_start: '2026-04-05', early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'bm2', wbs_path: '2', name: 'Framing',
    early_start: '2026-04-12', early_finish: '2026-04-16',
    planned_start: '2026-04-12',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 1, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

const FIXTURE_LINKS = [{ id: 'dep1', predecessor: 'bm1', successor: 'bm2', dep_type: 'FS', lag: 0 }];

/** Read the on-screen rect of a bar from its aria-overlay gridcell (rule 67). */
async function barRect(page: import('@playwright/test').Page, namePrefix: string) {
  const cell = page.locator(
    `[role="grid"][aria-label="Schedule chart"] [role="gridcell"][aria-label^="${namePrefix},"]`,
  );
  await expect(cell).toBeVisible({ timeout: 10_000 });
  const box = await cell.boundingBox();
  if (!box) throw new Error(`no bounding box for bar "${namePrefix}"`);
  return box;
}

/**
 * Dispatch a pointer move-drag gesture on the interaction canvas, starting at
 * a bar's body (not its link-dot zone) — mirrors `dragLink` in
 * `drag-to-link.spec.ts`, the codebase's established seam for driving the
 * canvas Gantt from Playwright.
 */
async function dragBarBody(
  page: import('@playwright/test').Page,
  startX: number,
  startY: number,
  dx: number,
): Promise<void> {
  await page.evaluate(
    ({ startX, startY, dx }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-layer="interaction"]');
      if (!canvas) throw new Error('no interaction canvas');
      const opts = (clientX: number, clientY: number, buttons: number): PointerEventInit => ({
        pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
        clientX, clientY, button: 0, buttons,
      });
      // setPointerCapture throws on a synthetic (non-active) pointer; swallow so
      // the gesture continues — capture is not required for the FSM.
      const orig = canvas.setPointerCapture.bind(canvas);
      canvas.setPointerCapture = (id: number) => {
        try { orig(id); } catch { /* synthetic pointer not active in headless */ }
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts(startX, startY, 1)));
      // First move crosses the drag threshold; second lands at the target.
      const midX = startX + dx / 2;
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(midX, startY, 1)));
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(startX + dx, startY, 1)));
      canvas.dispatchEvent(new PointerEvent('pointerup', opts(startX + dx, startY, 0)));
    },
    { startX, startY, dx },
  );
}

test.describe('Schedule drag preview keeps dependency arrows intact (#1499)', () => {
  test.beforeEach(async ({ page }) => {
    // A wide viewport keeps both bars comfortably inside the visible canvas
    // at the default zoom tier — narrower viewports clip the auto-scaled
    // chart against the fixed-width task-list + legend panels, which is a
    // layout concern unrelated to what this spec is testing.
    await page.setViewportSize({ width: 1920, height: 1080 });
  });

  test('dragging a predecessor with a live successor link previews genuinely new dates and keeps the dependency accessible before Confirm', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
      dependencies: FIXTURE_LINKS,
    });

    await page.goto(BASE_URL);

    const fBox = await barRect(page, 'Foundation');

    // Sanity: the link is rendered before we touch anything.
    await expect(page.getByText(/Depends on: Foundation/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Leads to: Framing/)).toBeVisible();

    // Drag Foundation's bar body (mid-bar, well clear of the link-dot zone at
    // [barRight+8, +16]) forward in time by a generous delta — enough to
    // guarantee a date change regardless of day-snap granularity.
    const startX = fBox.x + fBox.width / 2;
    const startY = fBox.y + fBox.height / 2;
    await dragBarBody(page, startX, startY, 200);

    // The pull-to-commit popover (ADR-0067) gates the actual PATCH — it must
    // appear with the previewed (changed) dates, and the drag must NOT have
    // fired a mutation yet. changeText is "oldStart → newStart"; a genuine
    // preview has two different dates either side of the arrow.
    const popover = page.getByRole('dialog', { name: /Reschedule task/ });
    await expect(popover).toBeVisible({ timeout: 5_000 });
    const changeText = await page.locator('#schedule-commit-change').innerText();
    const [oldDate, newDate] = changeText.split('→').map((s) => s.trim());
    expect(oldDate).toBeTruthy();
    expect(newDate).toBeTruthy();
    expect(newDate).not.toBe(oldDate);

    // The dependency relationship itself survives the drag-preview repaint —
    // the link is never silently dropped by the geometry-changing patch that
    // rebuilds the arrow-layout cache (#1499 fix).
    await expect(page.getByText(/Depends on: Foundation/)).toBeVisible();
    await expect(page.getByText(/Leads to: Framing/)).toBeVisible();

    // Cancel rather than Confirm — this spec only exercises the preview
    // window before commit, not the PATCH itself (covered elsewhere, e.g.
    // schedule-commit-popover.spec.ts and useScheduleCommit.test.tsx).
    await popover.getByRole('button', { name: 'Cancel' }).click();
    await expect(popover).toBeHidden();

    // Cancel reverted the engine to the original state — the relationship is
    // still intact and unaffected by the aborted preview.
    await expect(page.getByText(/Depends on: Foundation/)).toBeVisible();
  });
});
