/**
 * Read-only demo — the board card move that outlives its refusal (ADR-1198, #3967).
 *
 * ADR-1197 D4 made the Schedule drag the demo's centerpiece and scoped that win
 * honestly: it answers the planner and nobody else. A Delivery Lead who walked the
 * board in the demo got the opposite of a preview — the card snapped back to where it
 * started, and a red toast told them to *try again* an action the mode refuses every
 * time. ADR-1198 extends the preview overlay to the board card's own status so the
 * dropped column holds, and replaces both toasts with one board-local notice.
 *
 * The write gesture driven here is the **"Move to…" card menu**, for the reason
 * `board-offline.spec.ts` gives: it flows through the identical
 * `updateStatus.mutate` path as drag-end, and dnd-kit pointer-drag emulation is flaky
 * in Playwright. What only an e2e can prove is the part unit tests cannot reach — that
 * the dropped column survives the app's own refetch loop, and that the *derived column
 * counts* move with it.
 *
 * The list mock is deliberately **stateless** here, which is the opposite of the usual
 * rule and is the point: the server never accepted this write, so every refetch re-serves
 * the ORIGINAL status. A card still sitting in Done after that is the overlay working,
 * not a cache that happened to keep an optimistic frame.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-demo-board-0000-0000-0000-000000003967';
const BASE_URL = `/projects/${PROJECT_ID}`;

const DEMO_HINT = { username: 'demo@trueppm.com', password: 'trueppm-demo' };

const PROJECT = {
  id: PROJECT_ID,
  name: 'Read-only Demo Board',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
};

const PHASE = {
  id: 'ph1',
  wbs_path: '1',
  name: 'Sprint 12',
  early_start: '2026-04-06',
  early_finish: '2026-04-24',
  duration: 15,
  percent_complete: 20,
  is_critical: false,
  is_milestone: false,
  is_summary: true,
  parent_id: null,
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
  server_version: 1,
};

/** The one story the visitor moves. Starts IN_PROGRESS; the move sends it to Done. */
const STORY = {
  id: 'demo-card-1',
  wbs_path: '1.1',
  name: 'Checkout retry banner',
  early_start: '2026-04-06',
  early_finish: '2026-04-10',
  planned_start: '2026-04-06',
  duration: 5,
  percent_complete: 60,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  parent_id: 'ph1',
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
  server_version: 3,
};

const TASKS = [PHASE, STORY];

const DEMO_403 = {
  status: 403,
  contentType: 'application/json',
  body: JSON.stringify({
    detail: 'This is a read-only demo. Your change was not saved.',
    code: 'demo_read_only',
  }),
};

const PLAIN_403 = {
  status: 403,
  contentType: 'application/json',
  body: JSON.stringify({ detail: 'You do not have permission to perform this action.' }),
};

const BOARD_NOTICE =
  'Read-only demo — the card kept its new column and the board counts updated. Nothing was saved.';

/**
 * Refuse every task PATCH with `body`, letting every other task request fall through
 * to the list mock registered before this. Playwright matches routes in reverse
 * registration order, so this must be registered LAST.
 */
async function refuseTaskWrites(
  page: import('@playwright/test').Page,
  body: typeof DEMO_403,
): Promise<{ count: () => number }> {
  let count = 0;
  await page.route(/\/api\/v1\/tasks\/[^/]+\/$/, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    count += 1;
    return route.fulfill(body);
  });
  return { count: () => count };
}

/** Open the card's action menu and move it to the given column label. */
async function moveCardTo(
  page: import('@playwright/test').Page,
  cardName: string,
  columnLabel: string,
): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${cardName}` }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  await page.getByRole('menuitem', { name: columnLabel, exact: true }).click();
}

async function setup(
  page: import('@playwright/test').Page,
  opts: { demoReadOnly: boolean },
): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [PROJECT],
    projectId: PROJECT_ID,
    tasks: TASKS,
    ...(opts.demoReadOnly ? { demoReadOnly: true, demoLoginHint: DEMO_HINT } : {}),
  });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Read-only demo — board card preview (ADR-1198)', () => {
  test('the dropped column holds across the refetch, and the counts move with it', async ({
    page,
  }) => {
    await setup(page, { demoReadOnly: true });
    const refusals = await refuseTaskWrites(page, DEMO_403);
    await page.goto(BASE_URL);

    // Page-rendered signal: the card only exists once the tasks fetch resolves.
    // Gating on it rather than on the menu button is what keeps this from racing.
    const doneCell = page.getByTestId('board-cell-ph1-COMPLETE');
    const inProgressCell = page.getByTestId('board-cell-ph1-IN_PROGRESS');
    await expect(inProgressCell.getByText('Checkout retry banner')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Done, 0 tasks' })).toBeVisible();

    await moveCardTo(page, 'Checkout retry banner', 'Done');
    await expect.poll(() => refusals.count()).toBeGreaterThan(0);

    // The board's own notice — board-local, not the app-wide toast (web rule 183).
    await expect(page.getByRole('status').filter({ hasText: BOARD_NOTICE })).toBeVisible();
    // The red "try again" is the defect this closes: the move DID land on screen, and
    // retrying it earns the same 403 forever.
    await expect(page.getByText("Couldn't move the card — try again.")).toHaveCount(0);
    // …and the generic mode toast stands down, because the board answered for itself.
    await expect(page.getByText("Read-only demo — that change wasn't saved.")).toHaveCount(0);

    // The load-bearing assertion. `expect.poll` across several seconds spans the
    // fallback refetch AND the mutation's own cache rollback; a single `toBeVisible()`
    // would pass on the optimistic frame alone, whether or not the overlay exists.
    await expect
      .poll(async () => doneCell.getByText('Checkout retry banner').count(), {
        timeout: 8000,
        intervals: [500],
      })
      .toBe(1);
    await page.waitForTimeout(1500);
    await expect(doneCell.getByText('Checkout retry banner')).toBeVisible();
    await expect(inProgressCell.getByText('Checkout retry banner')).toHaveCount(0);

    // The derived counts recomputed around it — this is what the visitor is meant to
    // notice, and it is a pure client-side read of the overlaid task list.
    await expect(page.getByRole('heading', { name: 'Done, 1 task' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'In Progress, 0 tasks' })).toBeVisible();

    // A full page reload is the mode's own reset: nothing was persisted, so the
    // server's original column comes back.
    await page.reload();
    await expect(inProgressCell.getByText('Checkout retry banner')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Done, 0 tasks' })).toBeVisible();
  });

  test('a second refused move re-notices rather than stacking a red error', async ({ page }) => {
    await setup(page, { demoReadOnly: true });
    const refusals = await refuseTaskWrites(page, DEMO_403);
    await page.goto(BASE_URL);
    await expect(page.getByText('Checkout retry banner')).toBeVisible();

    await moveCardTo(page, 'Checkout retry banner', 'Done');
    await expect.poll(() => refusals.count()).toBe(1);
    await moveCardTo(page, 'Checkout retry banner', 'Review');
    await expect.poll(() => refusals.count()).toBe(2);

    // Last write wins in the overlay — the card follows the most recent drop.
    await expect
      .poll(
        async () =>
          page.getByTestId('board-cell-ph1-REVIEW').getByText('Checkout retry banner').count(),
        { timeout: 8000, intervals: [500] },
      )
      .toBe(1);
    await expect(page.getByText("Couldn't move the card — try again.")).toHaveCount(0);
  });
});

test.describe('Read-only demo board preview — negative control', () => {
  // Without this the suite above could pass on a build that captured EVERY 403.
  test('an ordinary 403 on a normal install still snaps back and says try again', async ({
    page,
  }) => {
    // `demoReadOnly` omitted — this is a real install.
    await setup(page, { demoReadOnly: false });
    const refusals = await refuseTaskWrites(page, PLAIN_403);
    await page.goto(BASE_URL);

    const inProgressCell = page.getByTestId('board-cell-ph1-IN_PROGRESS');
    await expect(inProgressCell.getByText('Checkout retry banner')).toBeVisible();
    // No mode indicator anywhere.
    await expect(page.getByRole('complementary', { name: 'Demo mode' })).toHaveCount(0);

    await moveCardTo(page, 'Checkout retry banner', 'Done');
    await expect.poll(() => refusals.count()).toBeGreaterThan(0);

    // The ordinary failure path, untouched: red toast, and the card reverts.
    await expect(page.getByText("Couldn't move the card — try again.")).toBeVisible();
    await expect(page.getByText(BOARD_NOTICE)).toHaveCount(0);
    await expect(inProgressCell.getByText('Checkout retry banner')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Done, 0 tasks' })).toBeVisible();
  });
});
