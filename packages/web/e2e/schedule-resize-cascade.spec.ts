/**
 * Resize-gesture CPM cascade preview E2E (#4317, feature #4237).
 *
 * Dragging a bar's right-edge resize handle runs a live CPM cascade preview:
 * a downstream FS successor must move with the new finish BEFORE the gesture is
 * committed. The worker/engine/hook layers have unit tests; this drives the real
 * pointer gesture on the interaction canvas (same synthetic-pointer seam as
 * `schedule-drag-dependency-arrow.spec.ts`) and reads the successor's on-screen
 * position from its ARIA overlay option (engine rule 67), mid-gesture.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-resizecasc-0000-0000-0000-000000004317';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Resize Cascade Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'rz1',
    wbs_path: '1',
    name: 'Pour slab',
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    planned_start: '2026-04-06',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'rz2',
    wbs_path: '2',
    name: 'Slab cured',
    early_start: '2026-04-10',
    early_finish: '2026-04-10',
    planned_start: null,
    duration: 0,
    percent_complete: 0,
    is_critical: false,
    is_milestone: true,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    total_float: null,
    predecessor_count: 1,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

const FIXTURE_LINKS = [
  { id: 'dep1', predecessor: 'rz1', successor: 'rz2', dep_type: 'FS', lag: 0 },
];

/** Read the on-screen rect of a bar from its aria-overlay option (rule 67). */
async function barRect(page: import('@playwright/test').Page, namePrefix: string) {
  const cell = page.locator(
    `[role="listbox"][aria-label="Schedule chart"] [role="option"][aria-label^="${namePrefix},"]`,
  );
  await expect(cell).toBeVisible({ timeout: 10_000 });
  const box = await cell.boundingBox();
  if (!box) throw new Error(`no bounding box for bar "${namePrefix}"`);
  return box;
}

/** Run a pointer gesture in steps; `release` false holds the pointer down. */
async function resizeGesture(
  page: import('@playwright/test').Page,
  phase: 'down-and-move' | 'up',
  x: number,
  y: number,
  dx: number,
): Promise<void> {
  await page.evaluate(
    ({ phase, x, y, dx }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-layer="interaction"]');
      if (!canvas) throw new Error('no interaction canvas');
      const opts = (clientX: number, buttons: number): PointerEventInit => ({
        pointerId: 1,
        pointerType: 'mouse',
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: y,
        button: 0,
        buttons,
      });
      const orig = canvas.setPointerCapture.bind(canvas);
      canvas.setPointerCapture = (id: number) => {
        try {
          orig(id);
        } catch {
          /* synthetic pointer not active in headless */
        }
      };
      if (phase === 'down-and-move') {
        canvas.dispatchEvent(new PointerEvent('pointerdown', opts(x, 1)));
        canvas.dispatchEvent(new PointerEvent('pointermove', opts(x + dx / 2, 1)));
        canvas.dispatchEvent(new PointerEvent('pointermove', opts(x + dx, 1)));
      } else {
        canvas.dispatchEvent(new PointerEvent('pointerup', opts(x + dx, 0)));
      }
    },
    { phase, x, y, dx },
  );
}

test.describe('Schedule resize gesture cascades to the successor (#4237)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
      dependencies: FIXTURE_LINKS,
    });
    await page.goto(BASE_URL);
  });

  test('lengthening a bar previews the downstream milestone slip before the gesture is released', async ({
    page,
  }) => {
    const barBefore = await barRect(page, 'Pour slab');
    const live = page.getByTestId('schedule-act-live');
    await expect(live).toHaveText('');

    // Grab the right edge (resize zone: barRight - 16 .. barRight).
    const startX = barBefore.x + barBefore.width - 4;
    const startY = barBefore.y + barBefore.height / 2;
    const canvasBox = await page.locator('canvas[data-layer="interaction"]').boundingBox();
    if (!canvasBox) throw new Error('no interaction canvas box');
    // Derived from the canvas, never a constant: chart width depends on the outline columns.
    const dx = Math.min(120, canvasBox.x + canvasBox.width - 24 - startX);
    expect(dx).toBeGreaterThan(40);

    await resizeGesture(page, 'down-and-move', startX, startY, dx);

    // Mid-gesture and uncommitted: the CPM cascade has already reached the milestone.
    await expect(live).toHaveText(/^Slab cured slips \d+ days?$/, { timeout: 5_000 });
    // The resized bar grew; it did not move.
    expect(Math.abs((await barRect(page, 'Pour slab')).x - barBefore.x)).toBeLessThan(2);

    await resizeGesture(page, 'up', startX, startY, dx);
    await expect(page.getByRole('dialog', { name: /Resize task/ })).toBeVisible({ timeout: 5_000 });
    // The popover states the cascade the preview showed (#4314).
    await expect(page.getByTestId('commit-popover-cascade')).toHaveText(
      /^1 downstream task moves; finish /,
    );
  });

  test('an empty resize (no pointer travel) previews no slip', async ({ page }) => {
    const barBefore = await barRect(page, 'Pour slab');
    const startX = barBefore.x + barBefore.width - 4;
    const startY = barBefore.y + barBefore.height / 2;
    await resizeGesture(page, 'down-and-move', startX, startY, 0);
    await resizeGesture(page, 'up', startX, startY, 0);
    await expect(page.getByTestId('schedule-act-live')).not.toHaveText(/slips/);
    await expect(page.getByRole('dialog', { name: /Resize task/ })).toBeHidden();
  });
});
