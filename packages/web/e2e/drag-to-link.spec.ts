/**
 * Drag-to-link on the Schedule canvas (#1666).
 *
 * Wires the dead link-dot affordance end-to-end: pointer-down on a bar's
 * right-edge link handle → drag onto another task → release → the engine emits
 * `create-link`, which ScheduleView turns into an FS/0-lag POST /dependencies/.
 *
 * The gesture runs on the interaction canvas, whose bars have no DOM. Geometry
 * is read from the transparent ScheduleAriaOverlay (rule 67): every visible bar
 * has a `role="gridcell"` node positioned exactly over its bar, so its
 * boundingClientRect is the bar's on-screen rect — robust to the engine's
 * auto-fit zoom (no scale math replicated in the test). Synthetic PointerEvents
 * are dispatched directly on the interaction canvas (the same seam schedule.spec
 * uses for the pan integration test), so the aria overlay's pointer-events
 * don't interfere.
 *
 * Golden: link Foundation → Framing, assert the POST body + aria-live "Linked".
 * Error: the same drag against a mock that rejects the edge with the ADR-0055
 * cycle payload surfaces the circular-dependency toast and creates no arrow.
 *
 * Every endpoint the Schedule page reads is mocked with its real shape (per the
 * #1190 catch-all rule); interactions gate on a "page rendered" signal (the
 * bar's aria gridcell) so the drag never races the first paint.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-link-00000000-0000-0000-0000-000000001666';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Drag-to-link Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
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
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

type Rect = { left: number; right: number; top: number; bottom: number };

/** Read the on-screen rect of a bar from its aria-overlay gridcell. */
async function barRect(page: import('@playwright/test').Page, name: string): Promise<Rect> {
  const cell = page.locator(
    `[role="grid"][aria-label="Schedule chart"] [role="gridcell"][aria-label^="${name},"]`,
  );
  await expect(cell).toBeVisible();
  const box = await cell.boundingBox();
  if (!box) throw new Error(`no bounding box for bar "${name}"`);
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

/**
 * Dispatch a pointer link gesture on the interaction canvas: down on the
 * source bar's right-edge link-dot, move (crossing the 4px threshold) onto the
 * target bar's center, release there.
 */
async function dragLink(
  page: import('@playwright/test').Page,
  source: Rect,
  target: Rect,
): Promise<void> {
  const startX = source.right + 12; // inside the link-dot zone [barRight+8, +16]
  const startY = (source.top + source.bottom) / 2;
  const endX = (target.left + target.right) / 2;
  const endY = (target.top + target.bottom) / 2;
  await page.evaluate(
    ({ startX, startY, endX, endY }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas[data-layer="interaction"]',
      );
      if (!canvas) throw new Error('no interaction canvas');
      const opts = (clientX: number, clientY: number, buttons: number): PointerEventInit => ({
        pointerId: 1,
        pointerType: 'mouse',
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
        buttons,
      });
      // setPointerCapture throws on a synthetic (non-active) pointer; swallow so
      // the gesture continues — capture is not required for the FSM.
      const orig = canvas.setPointerCapture.bind(canvas);
      canvas.setPointerCapture = (id: number) => {
        try {
          orig(id);
        } catch {
          /* synthetic pointer not active in headless */
        }
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts(startX, startY, 1)));
      // First move crosses the 4px threshold → DRAGGING; second lands on target.
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(midX, midY, 1)));
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(endX, endY, 1)));
      canvas.dispatchEvent(new PointerEvent('pointerup', opts(endX, endY, 0)));
    },
    { startX, startY, endX, endY },
  );
}

test.describe('Drag-to-link on the Schedule canvas (#1666)', () => {
  let depPostAttempts: number;
  let depPostBody: { predecessor?: string; successor?: string; dep_type?: string } | null;

  test.beforeEach(async ({ page }) => {
    depPostAttempts = 0;
    depPostBody = null;
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
      dependencies: [],
    });
  });

  test('golden: dragging a link-dot onto another task creates an FS dependency', async ({
    page,
  }) => {
    // Stateful dependencies endpoint: [] until the drag posts the edge, then the
    // GET returns it so the arrow (its aria dep-description) becomes observable.
    let created: Array<Record<string, unknown>> = [];
    await page.route('**/api/v1/dependencies/**', (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        depPostAttempts += 1;
        depPostBody = req.postDataJSON() as typeof depPostBody;
        const dep = {
          id: 'dep-1',
          predecessor: depPostBody?.predecessor,
          successor: depPostBody?.successor,
          dep_type: depPostBody?.dep_type ?? 'FS',
          lag: 0,
        };
        created = [dep];
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(dep),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: created.length, next: null, previous: null, results: created }),
      });
    });

    await page.goto(BASE_URL);
    const foundation = await barRect(page, 'Foundation');
    const framing = await barRect(page, 'Framing');

    await dragLink(page, foundation, framing);

    // The engine emitted create-link → ScheduleView posted the FS edge with the
    // real orientation: source = predecessor, target = successor.
    await expect.poll(() => depPostAttempts).toBe(1);
    expect(depPostBody?.predecessor).toBe('bm1');
    expect(depPostBody?.successor).toBe('bm2');
    expect(depPostBody?.dep_type).toBe('FS');

    // Success is announced on the polite aria-live region (rule 30) — the arrow
    // is the visual confirmation, aria-live is its accessible equivalent.
    const live = page.locator('[aria-live="polite"]', { hasText: 'Linked Foundation → Framing.' });
    await expect(live).toHaveText(/Linked Foundation → Framing\./);

    // The dependency refetch draws the arrow; its accessible description appears
    // on the successor bar ("Depends on: Foundation").
    await expect(
      page.locator('[role="grid"][aria-label="Schedule chart"]').getByText(/Depends on: Foundation/),
    ).toBeAttached();
  });

  test('error: a drag that would create a cycle shows the circular-dependency toast and no arrow', async ({
    page,
  }) => {
    await page.route('**/api/v1/dependencies/**', (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        depPostAttempts += 1;
        depPostBody = req.postDataJSON() as typeof depPostBody;
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            detail: 'cyclic_dependency',
            cycle: [
              { id: 'bm1', name: 'Foundation', hex_id: 'aa11' },
              { id: 'bm2', name: 'Framing', hex_id: 'bb22' },
              { id: 'bm1', name: 'Foundation', hex_id: 'aa11' },
            ],
          }),
        });
      }
      // GET always empty — no arrow is ever added on a rejected edge.
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      });
    });

    await page.goto(BASE_URL);
    const foundation = await barRect(page, 'Foundation');
    const framing = await barRect(page, 'Framing');

    await dragLink(page, foundation, framing);

    // The edge was proposed once and rejected with the cycle verdict.
    await expect.poll(() => depPostAttempts).toBe(1);

    // The rejection surfaces the circular-dependency toast (rule 183 ink pill).
    await expect(
      page.getByText("Can’t link these — it would create a circular dependency."),
    ).toBeVisible();

    // No arrow was added — no dep description ever appears on either bar.
    await expect(
      page.locator('[role="grid"][aria-label="Schedule chart"]').getByText(/Depends on:/),
    ).toHaveCount(0);
  });
});
