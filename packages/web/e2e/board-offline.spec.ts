/**
 * Board offline — cached read + queued card-status writes (#606, ADR-0220).
 *
 * Exercises the offline → status-change → online round-trip and the
 * server-version conflict path. The "Move to…" menu is used as the status-change
 * write path: it flows through the identical `updateStatus.mutate` → offline
 * queue → reconnect flush code as drag-end, and is deterministic in Playwright
 * (dnd-kit pointer-drag emulation is flaky), per the E2E-reliability guidance in
 * CLAUDE.md.
 *
 * Route mocks intercept before the network, so `context.setOffline(true)` here
 * drives `navigator.onLine` (which is what the app branches on) rather than
 * failing requests — exactly how the feature behaves in a real dead zone where
 * the app declines to send rather than the socket erroring.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-offline-00000000-0000-0000-0000-000000000606';
const BASE_URL = `/projects/${PROJECT_ID}`;

const PROJECT = {
  id: PROJECT_ID,
  name: 'Offline Board Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
};

const PHASE = {
  id: 'ph1',
  wbs_path: '1',
  name: 'Foundation',
  early_start: '2026-01-05',
  early_finish: '2026-02-14',
  duration: 30,
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

/** The card we move — starts in "To Do" (NOT_STARTED) at server_version 3. */
function card(version: number) {
  return {
    id: 'c1',
    wbs_path: '1.1',
    name: 'Frame wall',
    early_start: '2026-01-05',
    early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'ph1',
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    server_version: version,
  };
}

const PENDING_BADGE = { role: 'status' as const, name: /Sync pending/i };

/**
 * Mutable route state shared with the test body (route closures run in the test's
 * Node scope): `cardVersion` is the server_version served for the card, and
 * `patchCount` records replayed status PATCHes.
 */
async function setup(page: import('@playwright/test').Page) {
  const state = { cardVersion: 3, patchCount: 0 };

  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [PROJECT],
    projectId: PROJECT_ID,
    tasks: [PHASE, card(3)],
  });

  // Register AFTER setupApiMocks so this wins (last-registered wins). Handles both
  // the list GET (with the current mutable version) and the replayed PATCH.
  await page.route('**/api/v1/tasks/**', (route) => {
    if (route.request().method() === 'PATCH') {
      state.patchCount += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'c1', status: 'REVIEW' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 2,
        next: null,
        previous: null,
        results: [PHASE, card(state.cardVersion)],
      }),
    });
  });

  return state;
}

/** Open the card's action menu and move it to the given column label. */
async function moveCardTo(
  page: import('@playwright/test').Page,
  cardName: string,
  columnLabel: string,
) {
  await page.getByRole('button', { name: `Actions for ${cardName}` }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  await page.getByRole('menuitem', { name: columnLabel, exact: true }).click();
}

test.describe('Board offline card-status queue (#606)', () => {
  test('offline move queues, then flushes on reconnect', async ({ page, context }) => {
    const state = await setup(page);
    await page.goto(BASE_URL);

    // Page-rendered signal: the card content only exists after the tasks fetch
    // resolves. Gate the whole interaction on it, not on the control alone.
    await expect(page.getByText('Frame wall')).toBeVisible();

    await context.setOffline(true);
    await moveCardTo(page, 'Frame wall', 'Review');

    // Queued optimistically: the pending badge shows and no PATCH was attempted.
    await expect(page.getByRole('status', PENDING_BADGE).first()).toBeVisible();
    expect(state.patchCount).toBe(0);

    // Reconnect → flush. The queued move replays exactly once and the badge clears.
    await context.setOffline(false);
    await expect.poll(() => state.patchCount, { timeout: 10_000 }).toBe(1);
    await expect(page.getByRole('status', PENDING_BADGE)).toHaveCount(0);
  });

  test('server-version conflict reverts the move and toasts instead of clobbering', async ({
    page,
    context,
  }) => {
    const state = await setup(page);
    await page.goto(BASE_URL);
    await expect(page.getByText('Frame wall')).toBeVisible();

    await context.setOffline(true);
    await moveCardTo(page, 'Frame wall', 'Review');
    await expect(page.getByRole('status', PENDING_BADGE).first()).toBeVisible();

    // Someone else advanced the card on the server while we were offline.
    state.cardVersion = 9;
    await context.setOffline(false);

    // Honest conflict: a toast (naming the card), no clobbering PATCH, badge cleared.
    await expect(page.getByText(/changed on the server while you were offline/i)).toBeVisible();
    await expect(page.getByRole('status', PENDING_BADGE)).toHaveCount(0);
    expect(state.patchCount).toBe(0);
  });
});
