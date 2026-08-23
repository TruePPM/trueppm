/**
 * Schedule rows at a coarse pointer (#2997).
 *
 * Why this needs a browser. `ROW_HEIGHT` is read by five subsystems, three of
 * which are not React — the canvas renderer, the hit index, and the engine's
 * virtualization. The unit tests prove they all read *one binding*. What only a
 * real layout can prove is the consequence of that binding being wrong: the DOM
 * outline painting rows at one pitch while the canvas hit-tests at another, so a
 * tap opens the task above or below the one under the finger. jsdom has no
 * layout, so it cannot see this class at all.
 *
 * `hasTouch` + `isMobile` are what make `(pointer: coarse)` actually match — a
 * bare `setViewportSize` leaves Chromium on a fine pointer, and the whole spec
 * would then assert the 28px behaviour while claiming to assert the 44px one
 * (the trap `programs.spec.ts` records for the same reason).
 */
import { test, expect } from './fixtures/coverage';
import {
  setupAuth,
  setupApiMocks,
  setupCatchAll,
  setupScheduleDisplayOptions,
} from './fixtures';

const PROJECT_ID = 'e2e-rowh-00000000-0000-0000-0000-000000002997';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Row Height Project',
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
 * Four leaf rows, all sharing dates so every bar occupies the same x-range —
 * which makes a mis-resolved tap unambiguous: the only thing distinguishing the
 * rows is y. The names drive the fixture rather than being read back out of it,
 * so there is one list and the row order is stated once.
 */
const NAMES = ['Mobilization', 'Survey', 'Foundations', 'Closeout'];

const TASKS = NAMES.map((name, i) => taskRow({ id: `r${i + 1}`, wbs_path: `${i + 1}`, name }));

/**
 * The Schedule reads baselines on mount and the catch-all would answer a *list*
 * envelope for it. Mocked explicitly per the project's catch-all rule — leaning
 * on the net for a shape it does not have is how a page crashes into the root
 * error boundary and surfaces as an unrelated flake.
 */
async function mockBaselines(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/projects/*/baselines/', (route) =>
    route.fulfill({ json: { count: 0, next: null, previous: null, results: [] } }),
  );
}

/** The outline row for a task, by its visible name. */
function outlineRow(page: import('@playwright/test').Page, name: string) {
  return page.getByRole('row').filter({ hasText: name }).first();
}

/** The aria overlay's option for a task — the DOM proxy for the canvas bar. */
function barOption(page: import('@playwright/test').Page, name: string) {
  return page.locator(
    `[role="listbox"][aria-label="Schedule chart"] [role="option"][aria-label^="${name},"]`,
  );
}

async function boxOf(locator: ReturnType<typeof outlineRow>) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error('locator has no bounding box');
  return box;
}

/**
 * Tap the interaction canvas at `(clientX, clientY)`.
 *
 * Raw PointerEvents rather than `page.tap()`: the canvas is a single element, so
 * Playwright's own actionability would aim at *its* centre, not at the row we
 * are testing. This is the same technique `drag-to-link.spec.ts` uses, and
 * `pointerType: 'touch'` is load-bearing — it is what the hit index branches on
 * for its touch-expanded zones.
 */
async function tapCanvasAt(
  page: import('@playwright/test').Page,
  clientX: number,
  clientY: number,
) {
  await page.evaluate(
    ({ clientX, clientY }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-layer="interaction"]');
      if (!canvas) throw new Error('no interaction canvas');
      const opts = (buttons: number): PointerEventInit => ({
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      });
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts(1)));
      canvas.dispatchEvent(new PointerEvent('pointerup', opts(0)));
    },
    { clientX, clientY },
  );
}

test.describe('Schedule rows on a coarse pointer (#2997)', () => {
  test.use({ viewport: { width: 900, height: 900 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
    await mockBaselines(page);
    await page.goto(BASE_URL);
    await expect(page.getByText('Mobilization').first()).toBeVisible();
  });

  test('every outline row is 44px tall and the pitch between rows is 44px', async ({ page }) => {
    const boxes = [];
    for (const name of NAMES) boxes.push(await boxOf(outlineRow(page, name)));

    for (const [i, box] of boxes.entries()) {
      // Web rule 5 / WCAG 2.5.5. Asserted as >= rather than == because the floor
      // is the requirement; the pitch check below is what pins the exact value.
      expect(box.height, `row ${i} ("${NAMES[i]}") height`).toBeGreaterThanOrEqual(44);
    }
    for (let i = 1; i < boxes.length; i++) {
      // A pitch that disagrees with the height means rows overlap or gap, and
      // the canvas — which lays out on pitch alone — would drift from row one.
      expect(boxes[i].y - boxes[i - 1].y, `pitch between rows ${i - 1} and ${i}`).toBeCloseTo(
        44,
        0,
      );
    }
  });

  test('the canvas puts row n exactly where the outline does', async ({ page }) => {
    // The overlay option is positioned from the *engine's* row model
    // (rowIndex * ROW_HEIGHT + HEADER_HEIGHT), the outline row from the
    // virtualizer's. Before #2997 both read a module constant and could not
    // disagree; now both resolve at runtime, and this is the assertion that
    // says they still resolve to the same thing.
    for (const name of NAMES) {
      const row = await boxOf(outlineRow(page, name));
      const bar = await boxOf(barOption(page, name));
      const rowCenter = row.y + row.height / 2;
      const barCenter = bar.y + bar.height / 2;
      expect(barCenter, `bar for "${name}" is centered on its outline row`).toBeCloseTo(
        rowCenter,
        0,
      );
      // Centered, not top-aligned: a 44px row with a bar still at the old 5px
      // inset would put 21px of dead space under every bar.
      expect(bar.y - row.y).toBeCloseTo(row.y + row.height - (bar.y + bar.height), 0);
    }
  });

  test('a tap lands on the row it visually covers, for every row', async ({ page }) => {
    // The regression this whole change risks: a hit index built at 28 while the
    // DOM paints 44. Row 3's visual centre would then fall inside the index's
    // row 5, and the tap would select a task the finger was never over — with
    // nothing on screen to suggest anything went wrong.
    for (const name of NAMES) {
      const row = await boxOf(outlineRow(page, name));
      const bar = await boxOf(barOption(page, name));

      await tapCanvasAt(page, bar.x + bar.width / 2, row.y + row.height / 2);

      await expect(barOption(page, name)).toHaveAttribute('aria-selected', 'true');
      for (const other of NAMES) {
        if (other === name) continue;
        await expect(barOption(page, other)).toHaveAttribute('aria-selected', 'false');
      }
    }
  });

  test('the insert-below affordance is visible and tappable without a hover', async ({
    page,
  }) => {
    // Hover-revealed on a mouse; there is no hover on a finger, so a coarse
    // branch is the only thing that makes build mode's "insert a sibling here"
    // reachable by pointer at all on the device 44px rows exist for.
    const insert = outlineRow(page, 'Survey').getByRole('button', {
      name: /Insert an item below Survey/,
    });
    await expect(insert).toBeVisible();
    await expect(insert).toHaveCSS('opacity', '1');
  });

  test('the ⋮⋮ reorder grip meets the 44x44 floor (the #2954 mitigation is closed)', async ({
    page,
  }) => {
    // #2954 shipped this grip at 26x28 with an accepted mitigation: it could not
    // reach 44 inside a 28px row without overlapping its neighbours' grips. The
    // row is 44 now, so the constraint that justified the exception is gone.
    const row = outlineRow(page, 'Survey');
    const grip = row.getByTestId('row-reorder-grip');
    const box = await boxOf(grip);
    expect(box.width, 'grip width').toBeGreaterThanOrEqual(44);
    expect(box.height, 'grip height').toBeGreaterThanOrEqual(44);
  });

  test('adjacent grips do not overlap — a 44px target that steals its neighbour is worse', async ({
    page,
  }) => {
    const a = await boxOf(outlineRow(page, 'Survey').getByTestId('row-reorder-grip'));
    const b = await boxOf(outlineRow(page, 'Foundations').getByTestId('row-reorder-grip'));
    expect(a.y + a.height).toBeLessThanOrEqual(b.y + 0.5);
  });

  test('the header and the rows reserve the SAME lane, so the columns line up', async ({
    page,
  }) => {
    // The lane is rendered independently by the header, every row, the pending
    // rows and the draft row. Drop it from any one of them and that element's
    // columns sit 44px off — which reads as a broken table, not as a constant
    // that drifted. jsdom cannot see this; only a real layout can.
    const header = page.getByRole('row', { name: 'Task list columns' });
    const headerWbs = await boxOf(header.getByRole('columnheader', { name: /Work breakdown/ }));
    const rowWbs = await boxOf(outlineRow(page, 'Survey').getByRole('gridcell', { name: /^WBS/ }));
    expect(rowWbs.x, 'row WBS column aligns with its header').toBeCloseTo(headerWbs.x, 0);
    expect(rowWbs.width).toBeCloseTo(headerWbs.width, 0);
  });

  test('the lane does not push the last column out of the panel', async ({ page }) => {
    // The reserve is added ahead of columns whose widths are fixed, so the row's
    // content is 44px wider on touch than it was. The panel must still be able
    // to show (or scroll to) its rightmost column.
    const panel = page.getByRole('treegrid').or(page.getByRole('grid')).first();
    const panelBox = await boxOf(panel);
    const row = await boxOf(outlineRow(page, 'Survey'));
    expect(row.x).toBeGreaterThanOrEqual(panelBox.x - 1);
    expect(row.x + row.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
  });

  test('the row name is still readable — the wider grip does not eat the label', async ({
    page,
  }) => {
    // The grip's width is reserved out of the task column. If the reserve and the
    // grip ever disagree the name is drawn under the grip, which reads as a
    // rendering bug rather than as a layout constant that drifted.
    const label = outlineRow(page, 'Foundations').getByText('Foundations').first();
    const labelBox = await boxOf(label);
    const gripBox = await boxOf(outlineRow(page, 'Foundations').getByTestId('row-reorder-grip'));
    expect(labelBox.x).toBeGreaterThanOrEqual(gripBox.x + gripBox.width);
  });
});

test.describe('Schedule rows on a fine pointer are unchanged (#2997)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
    await mockBaselines(page);
    await page.goto(BASE_URL);
    await expect(page.getByText('Mobilization').first()).toBeVisible();
  });

  test('rows stay at the 28px pitch a mouse gets', async ({ page }) => {
    // The counterweight to the coarse spec: a change that made every desktop row
    // 44px would pass all of the above and cost the PM a third of the plan they
    // can see at once.
    const first = await boxOf(outlineRow(page, 'Mobilization'));
    const second = await boxOf(outlineRow(page, 'Survey'));
    expect(first.height).toBeCloseTo(28, 0);
    expect(second.y - first.y).toBeCloseTo(28, 0);
  });

  test('a tap still lands on the row it covers at the fine height', async ({ page }) => {
    for (const name of NAMES) {
      const row = await boxOf(outlineRow(page, name));
      const bar = await boxOf(barOption(page, name));
      await tapCanvasAt(page, bar.x + bar.width / 2, row.y + row.height / 2);
      await expect(barOption(page, name)).toHaveAttribute('aria-selected', 'true');
    }
  });
});

/**
 * Comfortable rows at a **fine** pointer (#3019).
 *
 * The option shipped as a dead control: the Display menu toggled it, it
 * persisted to localStorage, and nothing read it — row height came from the
 * pointer class alone. The people it exists for are precisely the ones a
 * coarse-pointer heuristic cannot reach, so a mouse is the only configuration
 * that can prove it now works.
 *
 * Seeded through `localStorage` rather than by driving the menu, per the
 * fixture's own contract: this is the honest reproduction of "this planner
 * turned it on last week", and `schedule-display-menu.spec` owns the toggle.
 */
test.describe('Comfortable rows lifts a fine pointer to the 44px floor (#3019)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
    await mockBaselines(page);
    await setupScheduleDisplayOptions(page, PROJECT_ID, { comfortableRows: true });
    await page.goto(BASE_URL);
    await expect(page.getByText('Mobilization').first()).toBeVisible();
  });

  test('rows and the pitch between them are 44px on a mouse', async ({ page }) => {
    const boxes = [];
    for (const name of NAMES) boxes.push(await boxOf(outlineRow(page, name)));

    for (const [i, box] of boxes.entries()) {
      expect(box.height, `row ${i} ("${NAMES[i]}") height`).toBeGreaterThanOrEqual(44);
    }
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].y - boxes[i - 1].y, `pitch between rows ${i - 1} and ${i}`).toBeCloseTo(
        44,
        0,
      );
    }
  });

  test('the canvas follows the preference, not just the outline', async ({ page }) => {
    // The failure mode a DOM-only assertion cannot see. The preference reaches
    // the row model's single owner, so the non-React readers — renderer, hit
    // index, virtualization — resolve the same 44 the outline did. Had it been
    // wired into the React tree instead, this is the test that would fail: 44px
    // DOM rows over 28px canvas bands, with nothing on screen to say so.
    for (const name of NAMES) {
      const row = await boxOf(outlineRow(page, name));
      const bar = await boxOf(barOption(page, name));
      expect(bar.y + bar.height / 2, `bar for "${name}"`).toBeCloseTo(row.y + row.height / 2, 0);
    }
  });

  test('a click lands on the row it covers at the comfortable height', async ({ page }) => {
    for (const name of NAMES) {
      const row = await boxOf(outlineRow(page, name));
      const bar = await boxOf(barOption(page, name));
      await tapCanvasAt(page, bar.x + bar.width / 2, row.y + row.height / 2);
      await expect(barOption(page, name)).toHaveAttribute('aria-selected', 'true');
    }
  });

  test('the grip grows taller but does not take a 44px lane a mouse never needed', async ({
    page,
  }) => {
    // "Larger controls" arrives through the resolved height, which the grip's own
    // height is. Its *width* answers a different question — can this pointer aim?
    // — and a mouse still can, so the name column is not surrendered.
    const grip = await boxOf(outlineRow(page, 'Survey').getByTestId('row-reorder-grip'));
    expect(grip.height, 'grip height follows the row').toBeGreaterThanOrEqual(44);
    expect(grip.width, 'grip lane stays on the pointer class').toBeLessThan(44);
  });
});
