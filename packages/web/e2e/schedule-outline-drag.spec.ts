/**
 * Drag a Schedule outline row to reorder or reparent it (#2954, epic #2946).
 *
 * The invariant worth an E2E rather than another unit test: the gesture is a
 * *pointer* gesture over a virtualized list, wired to two different endpoints
 * depending on what the drop meant. The drop arithmetic is covered exhaustively
 * in `outlineDrag.test.ts`; what only a browser can prove is that a real
 * pointer, over real row geometry, produces the request the drop model says it
 * should — and that the consequence is on screen *before* the release.
 *
 * Real `page.mouse`, not `dispatchEvent`: the hook listens on `window` and the
 * activation threshold needs genuine intermediate moves, the same reason
 * `board-collapsed-lane-drop.spec.ts` uses real pointer events for dnd-kit.
 *
 * `setupTaskStore` is deliberately NOT used here: it mocks neither `reparent/`
 * nor `tasks/reorder/` (it `route.fallback()`s the first and never matches the
 * second), and every assertion below is on the *request* the drag produced,
 * which is the contract. The two routes are captured by hand, as
 * `schedule-authoring-tokens.spec.ts` and `schedule-build-mode.spec.ts` already
 * do for the same pair.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-drag-00000000-0000-0000-0000-000000002954';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Outline Drag Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function taskRow(over: Record<string, unknown>) {
  return {
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
    ...over,
  };
}

/**
 *   1     Mobilization   (phase — has one child)
 *   1.1     Survey
 *   2     Notice to proceed  (milestone — a gate cannot hold work)
 *   3     Closeout       (leaf — becomes a phase if something lands in it)
 */
const TASKS = [
  taskRow({ id: 'dphase', wbs_path: '1', name: 'Mobilization', is_summary: true }),
  taskRow({ id: 'dsurvey', wbs_path: '1.1', name: 'Survey', parent_id: 'dphase' }),
  taskRow({
    id: 'dgate',
    wbs_path: '2',
    name: 'Notice to proceed',
    is_milestone: true,
    duration: 0,
  }),
  taskRow({ id: 'dtail', wbs_path: '3', name: 'Closeout' }),
];

interface Captured {
  reparents: { url: string; body: Record<string, unknown> }[];
  reorders: Record<string, unknown>[];
}

async function captureStructuralWrites(
  page: import('@playwright/test').Page,
): Promise<Captured> {
  const captured: Captured = { reparents: [], reorders: [] };
  await page.route('**/api/v1/projects/*/tasks/*/reparent/', async (route) => {
    captured.reparents.push({
      url: route.request().url(),
      body: route.request().postDataJSON() as Record<string, unknown>,
    });
    await route.fulfill({ json: { updated: [], warning: null } });
  });
  await page.route('**/api/v1/projects/*/tasks/reorder/', async (route) => {
    captured.reorders.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { updated: [] } });
  });
  return captured;
}

/** Centre of a row's band, in client coordinates. */
async function rowBox(page: import('@playwright/test').Page, name: string) {
  const row = page.getByRole('row').filter({ hasText: name }).first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  if (!box) throw new Error(`no bounding box for row "${name}"`);
  return box;
}

/**
 * Press the row's ⋮⋮ grip and travel to `(x, y)`, without releasing.
 *
 * Two intermediate moves, for the same reason the canvas drag helpers use them:
 * the first crosses the 4px activation threshold, the second is the one whose
 * position the drop model actually reads.
 */
async function liftRow(page: import('@playwright/test').Page, name: string, toY: number) {
  const source = await rowBox(page, name);
  const row = page.getByRole('row').filter({ hasText: name }).first();
  const grip = row.getByTestId('row-reorder-grip');
  // The grip is revealed on row hover; hovering the row first is what a user does.
  await row.hover();
  const gripBox = await grip.boundingBox();
  if (!gripBox) throw new Error('grip has no bounding box');

  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2, source.y + source.height / 2 + 8, {
    steps: 3,
  });
  await page.mouse.move(gripBox.x + gripBox.width / 2, toY, { steps: 10 });
}

test.describe('Schedule outline — drag to reorder or reparent (#2954)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
  });

  test('dropping onto a leaf says it becomes a phase, then reparents into it', async ({
    page,
  }) => {
    const captured = await captureStructuralWrites(page);
    await page.goto(BASE_URL);
    await expect(page.getByText('Mobilization')).toBeVisible();

    const target = await rowBox(page, 'Closeout');
    await liftRow(page, 'Survey', target.y + target.height / 2);

    // The consequence is on screen BEFORE the release — that is the whole point
    // of the preview, and a bare insertion line could not say this.
    await expect(page.getByTestId('outline-drop-consequence')).toHaveText('↳ becomes a phase');

    await page.mouse.up();

    await expect
      .poll(() => captured.reparents.length, { message: 'expected one reparent' })
      .toBe(1);
    expect(captured.reparents[0].body).toEqual({ new_parent_id: 'dtail' });
    expect(captured.reparents[0].url).toContain('/tasks/dsurvey/reparent/');
  });

  test('a milestone refuses work, and the refusal is stated rather than silent', async ({
    page,
  }) => {
    const captured = await captureStructuralWrites(page);
    await page.goto(BASE_URL);
    await expect(page.getByText('Mobilization')).toBeVisible();

    const gate = await rowBox(page, 'Notice to proceed');
    await liftRow(page, 'Closeout', gate.y + gate.height / 2);

    const chip = page.getByTestId('outline-drop-consequence');
    await expect(chip).toHaveText('a gate cannot hold work');
    // A refusal is marked, never offered — no insertion line invites the drop.
    await expect(page.getByTestId('outline-drop-line')).toHaveCount(0);

    await page.mouse.up();
    // Nothing was written. The client refused before the server had to.
    await page.waitForTimeout(200);
    expect(captured.reparents).toHaveLength(0);
    expect(captured.reorders).toHaveLength(0);
  });

  test('Escape mid-drag abandons the move and writes nothing', async ({ page }) => {
    const captured = await captureStructuralWrites(page);
    await page.goto(BASE_URL);
    await expect(page.getByText('Mobilization')).toBeVisible();

    const target = await rowBox(page, 'Closeout');
    await liftRow(page, 'Survey', target.y + target.height / 2);
    await expect(page.getByTestId('outline-drop-consequence')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('outline-drop-indicator')).toHaveCount(0);

    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(captured.reparents).toHaveLength(0);
    expect(captured.reorders).toHaveLength(0);
  });

  test('a same-level drop reorders rather than reparenting', async ({ page }) => {
    const captured = await captureStructuralWrites(page);
    await page.goto(BASE_URL);
    await expect(page.getByText('Mobilization')).toBeVisible();

    // Drop "Closeout" into the gap above "Notice to proceed" — both are roots,
    // so the parent does not change and only the order does.
    const gate = await rowBox(page, 'Notice to proceed');
    await liftRow(page, 'Closeout', gate.y + 2);

    await expect(page.getByTestId('outline-drop-consequence')).toContainText('same level as');
    await page.mouse.up();

    await expect
      .poll(() => captured.reorders.length, { message: 'expected one reorder' })
      .toBe(1);
    expect(captured.reorders[0]).toMatchObject({ parent_path: '' });
    expect(captured.reorders[0].ordered_ids).toEqual(['dphase', 'dtail', 'dgate']);
    // A same-parent move must NOT go through reparent/, which treats an
    // unchanged parent as a no-op and would drop the reposition on the floor.
    expect(captured.reparents).toHaveLength(0);
  });

  test('"Move to…" reaches the same operation with no drag at all', async ({ page }) => {
    const captured = await captureStructuralWrites(page);
    await page.goto(BASE_URL);
    await expect(page.getByText('Mobilization')).toBeVisible();

    await page.getByText('Survey').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Move to/ }).click();

    const dialog = page.getByRole('dialog', { name: /Move “Survey”/ });
    await expect(dialog).toBeVisible();
    // The drag's refusals apply here too, by omission.
    await expect(dialog.getByRole('radio', { name: /Notice to proceed/ })).toHaveCount(0);

    await dialog.getByRole('radio', { name: /Closeout/ }).click();
    await dialog.getByRole('button', { name: 'Move' }).click();

    await expect.poll(() => captured.reparents.length).toBe(1);
    expect(captured.reparents[0].body).toEqual({ new_parent_id: 'dtail' });
  });
});
