/**
 * Board Space+drag panning E2E (issue 1265).
 *
 * Golden path: holding Space arms pan mode (grab cursor) and a click-drag
 * scrolls the board grid instead of lifting a card.
 * Guard: Space typed into the card search box types a space and never hijacks
 * the board scroll (no scroll while typing).
 *
 * A narrow desktop viewport (800×600, still ≥ md so the desktop grid renders —
 * not the mobile snap board) guarantees the phase sidebar + four columns
 * overflow horizontally, so the pan produces an observable `scrollLeft` change.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, delayRoute } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-spacepan-0000-0000-0000-000000000010';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Space Pan Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'b1', wbs_path: '1', name: 'Alpha Phase', early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 50, is_critical: false, is_milestone: false, is_summary: true,
    parent_id: null, status: 'IN_PROGRESS', assignees: [], total_float: null, predecessor_count: 0,
    is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'b2', wbs_path: '1.1', name: 'Design the foundation', early_start: '2026-01-05',
    early_finish: '2026-01-16', planned_start: '2026-01-05', duration: 10, percent_complete: 100,
    is_critical: false, is_milestone: false, is_summary: false, parent_id: 'b1', status: 'COMPLETE',
    assignees: [], total_float: null, predecessor_count: 0, is_blocked: false, linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'b3', wbs_path: '1.2', name: 'Build the walls', early_start: '2026-01-19',
    early_finish: '2026-01-30', planned_start: '2026-01-19', duration: 10, percent_complete: 40,
    is_critical: false, is_milestone: false, is_summary: false, parent_id: 'b1', status: 'IN_PROGRESS',
    assignees: [], total_float: null, predecessor_count: 0, is_blocked: false, linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

type Page = import('@playwright/test').Page;

interface SetupOptions {
  /**
   * Delay the `GET /tasks/` response by this many ms, forcing `BoardView` to
   * render its loading skeleton first so `board-scroll` mounts *after* the
   * first paint. This is the cold-load path — see the cold-load test below.
   */
  taskDelayMs?: number;
}

async function setup(page: Page, { taskDelayMs }: SetupOptions = {}) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 2 },
  });

  // Registered last so it wins (fixtures/README: last-registered route wins).
  if (taskDelayMs) await delayRoute(page, '**/api/v1/tasks/**', taskDelayMs);
}

/**
 * Wait for the board to finish loading. Gate on the rendered content, never on
 * the absence of the skeleton — an absence assertion passes before the surface
 * has even mounted and races the thing it means to wait for.
 */
async function waitForBoard(page: Page) {
  await expect(page.getByText('In Progress')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 15_000 });
}

/**
 * Arm pan mode with Space, drag leftward across the sticky header row, and
 * assert the grid actually scrolled. Shared by the warm- and cold-load tests so
 * the two can never drift.
 */
async function expectSpaceDragPans(page: Page) {
  const scroll = page.getByTestId('board-scroll');
  await expect(scroll).toBeVisible();

  // Wait for the columns to finish laying out so the grid overflows and the
  // pan is observable (polling avoids a cold-start race where the read lands
  // before layout settles).
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollWidth > el.clientWidth), { timeout: 10_000 })
    .toBe(true);

  const box = await scroll.boundingBox();
  if (!box) throw new Error('board scroll container has no bounding box');

  // Arm pan mode — the cursor switches to a grab hand.
  await page.keyboard.down('Space');
  await expect(scroll).toHaveClass(/cursor-grab/);

  // Drag from the right of the sticky header row toward the left (no cards
  // there, so no card drawer opens); content scrolls right → scrollLeft grows.
  const y = box.y + 24;
  await page.mouse.move(box.x + box.width * 0.75, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 8 });

  // Assert the observable outcome — the grid scrolled right — rather than the
  // transient `data-space-panning` attribute. That attribute is React state
  // (`isPanning`), whereas the scroll offset is written imperatively in the
  // pointermove handler; under CI load the true→false state transition can be
  // coalesced into a single render so the attribute never reads "true" even
  // though the pan physically happened. Every #1954 flake was on the attribute
  // snapshot, never on scrollLeft. Pan-mode arming stays covered by the
  // cursor-grab assertions above/below; the attribute wiring by the negative
  // case below and the useSpaceDragPan unit tests.
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollLeft), { timeout: 10_000 })
    .toBeGreaterThan(0);

  await page.mouse.up();
  await page.keyboard.up('Space');

  // Releasing Space restores the normal cursor.
  await expect(scroll).not.toHaveClass(/cursor-grab/);
}

test.describe('Board Space+drag panning (issue 1265)', () => {
  test.use({ viewport: { width: 800, height: 600 } });

  test('Space+drag pans the board grid horizontally', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await waitForBoard(page);

    await expectSpaceDragPans(page);
  });

  test('Space+drag still pans after a cold load (tasks resolve after first paint)', async ({
    page,
  }) => {
    // Regression guard for #2365. `BoardView` returns a loading skeleton before
    // the `board-scroll` container exists, so on a cold load the container
    // mounts *after* first commit. `useSpaceDragPan` used to attach its pointer
    // listeners in a mount effect keyed only on `enabled`, so it bailed on the
    // null ref and never re-ran — panning was silently dead for the whole page.
    // Delaying the tasks fetch makes that ordering deterministic rather than a
    // race against query-cache warmth (which is why this read as "flaky").
    await setup(page, { taskDelayMs: 1200 });
    await page.goto(`${BASE_URL}/board`);

    // The skeleton must genuinely render, or this test is not exercising the
    // cold path it claims to.
    await expect(page.getByRole('status', { name: /Loading board/i })).toBeVisible();
    await waitForBoard(page);

    await expectSpaceDragPans(page);
  });

  test('board edge-fade overflow cues appear after a cold load', async ({ page }) => {
    // Same #2365 root cause via a different consumer: `useHasScrollBelow` /
    // `useHasScrollRight` also attached their ResizeObserver in a mount effect
    // keyed on the (never-changing) ref object, so the #1962 / #1972 edge-fade
    // affordances never appeared when the container mounted late.
    await setup(page, { taskDelayMs: 1200 });
    await page.goto(`${BASE_URL}/board`);
    await waitForBoard(page);

    const scroll = page.getByTestId('board-scroll');
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollWidth > el.clientWidth), { timeout: 10_000 })
      .toBe(true);

    await expect(page.getByTestId('board-scroll-fade-right')).toBeVisible({ timeout: 10_000 });
  });

  test('Space while typing in the card search does not hijack the board scroll', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await waitForBoard(page);

    const scroll = page.getByTestId('board-scroll');
    const before = await scroll.evaluate((el) => el.scrollLeft);

    // `/` focuses the board card search box.
    await page.keyboard.press('/');
    const search = page.getByRole('searchbox', { name: 'Search cards' });
    await expect(search).toBeFocused();
    await search.fill('found');

    // Space typed into the field must land as a character, not arm pan mode.
    await page.keyboard.press('Space');
    await expect(search).toHaveValue(/^\s?found\s?$/); // space landed in the field

    await expect(scroll).not.toHaveClass(/cursor-grab/);
    await expect(scroll).not.toHaveAttribute('data-space-panning', 'true');
    const after = await scroll.evaluate((el) => el.scrollLeft);
    expect(after).toBe(before);
  });
});
