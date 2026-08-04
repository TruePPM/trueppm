/**
 * Server reconciliation markers (#2725, ADR-0784).
 *
 * The state machine itself is covered exhaustively at the vitest layer
 * (`reconcile/reconcileState.test.ts`, 18 tests). This spec covers the thing
 * only a real page can prove: that a date the SERVER changed out from under a
 * local preview actually reaches the planner — the marker in the row, the count
 * on the strip, and the polite live-region sentence.
 *
 * Divergence is forced through the milestone date popover rather than a canvas
 * drag, following the codebase precedent in `schedule-build-mode.spec.ts`: the
 * popover is a real DOM affordance, so the flow is deterministic without
 * pointer/canvas coupling.
 *
 * The tasks list mock is STATEFUL on purpose. A stateless list mock re-serves
 * the original fixture on the post-write refetch and silently erases the
 * optimistic value — which here would not just flake, it would fake the very
 * divergence under test.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-recon-00000000-0000-0000-0000-000000002725';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

/** What the planner picks (the phase finish). */
const AUTHORED = '2026-10-13';
/** What the engine decides instead — a Friday, three days later. */
const SERVER = '2026-10-16';

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Reconciliation Project',
    description: '',
    start_date: '2026-09-01',
    calendar: 'default',
  },
];

function task(over: Record<string, unknown>) {
  return {
    wbs_path: '1',
    name: 'Task',
    early_start: '2026-09-01',
    early_finish: '2026-09-05',
    planned_start: '2026-09-01',
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

const PHASE = task({
  id: 'ph1',
  wbs_path: '1',
  name: 'Discovery',
  is_summary: true,
  early_start: '2026-09-01',
  early_finish: AUTHORED,
  planned_start: '2026-09-01',
});

/** The milestone whose date the server will move. */
function milestone(start: string) {
  return task({
    id: 'ms1',
    wbs_path: '1.1',
    name: 'Spec freeze',
    parent_id: 'ph1',
    is_milestone: true,
    duration: 0,
    early_start: start,
    early_finish: start,
    planned_start: start,
  });
}

/**
 * Serve the tasks list, switching the milestone's dates to `SERVER` once the
 * PATCH has landed — the CPM result arriving after the optimistic write.
 */
async function setupStatefulTasks(page: import('@playwright/test').Page) {
  const state = { patched: false };

  await page.route('**/api/v1/tasks/**', async (route) => {
    const req = route.request();
    const url = req.url();

    if (req.method() === 'PATCH') {
      state.patched = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'ms1', name: 'Spec freeze' }),
      });
      return;
    }

    if (req.method() === 'GET' && url.includes('/tasks/')) {
      const results = [PHASE, milestone(state.patched ? SERVER : '2026-09-20')];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: results.length, next: null, previous: null, results }),
      });
      return;
    }

    await route.continue();
  });

  return state;
}

test.describe('Schedule reconciliation markers (#2725)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: [PHASE, milestone('2026-09-20')],
    });
    // Registered last so it wins — Playwright route precedence is reverse order.
    await setupStatefulTasks(page);
  });

  test('the strip is silent until something diverges', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Spec freeze')).toBeVisible();

    // The live region must already exist so the FIRST announcement is heard.
    await expect(page.getByTestId('reconcile-live')).toHaveCount(1);
    await expect(page.getByTestId('reconcile-live')).toHaveText('');
    await expect(page.getByTestId('reconcile-count')).toHaveCount(0);
  });

  test('a server-changed date surfaces as a row marker, a count, and an announcement', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Spec freeze')).toBeVisible();

    // Author a date: the milestone's Start cell opens the quick-pick popover.
    // Target the Start cell by its accessible name — filtering by visible text
    // would also match the milestone's em-dash Dur cell.
    await page
      .getByRole('row')
      .filter({ hasText: 'Spec freeze' })
      .getByRole('gridcell', { name: /^starts / })
      .click();
    await page.getByRole('dialog', { name: 'Pick milestone date' }).waitFor();
    await page.getByRole('button', { name: 'End of Discovery' }).click();

    // The server answered with a different date — the row must SAY so.
    await expect(page.getByTestId('reconcile-count')).toHaveText(/1 date changed/);
    await expect(page.getByTestId('reconcile-live')).toHaveText(
      /Schedule recomputed\. 1 date changed\./,
    );
    await expect(page.getByTestId('reconcile-cell-diverged').first()).toContainText('Oct 16');
  });

  test('"Show 1 change" filters the outline instead of opening a dialog', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Spec freeze')).toBeVisible();

    // Target the Start cell by its accessible name — filtering by visible text
    // would also match the milestone's em-dash Dur cell.
    await page
      .getByRole('row')
      .filter({ hasText: 'Spec freeze' })
      .getByRole('gridcell', { name: /^starts / })
      .click();
    await page.getByRole('dialog', { name: 'Pick milestone date' }).waitFor();
    await page.getByRole('button', { name: 'End of Discovery' }).click();

    const toggle = page.getByTestId('reconcile-review-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // A filter, not a dialog — and the full old → new sentence is readable here,
    // because the ~74px grid cell cannot carry it.
    await expect(page.getByTestId('reconcile-change-list')).toContainText('Oct 13 → Oct 16');

    // Acknowledging the last change releases the filter.
    await page.getByTestId('reconcile-ack-all').click();
    await expect(page.getByTestId('reconcile-count')).toHaveCount(0);
    await expect(page.getByTestId('reconcile-review-toggle')).toHaveCount(0);
  });
});

test.describe('Schedule reconciliation — refusals (#2725)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: [PHASE, milestone('2026-09-20')],
    });

    await page.route('**/api/v1/tasks/**', async (route) => {
      const req = route.request();
      if (req.method() === 'PATCH') {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'You do not have permission to reschedule this task.' }),
        });
        return;
      }
      if (req.method() === 'GET' && req.url().includes('/tasks/')) {
        const results = [PHASE, milestone('2026-09-20')];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: results.length, next: null, previous: null, results }),
        });
        return;
      }
      await route.continue();
    });
  });

  test('a refused write is named with its reason, never silently reverted', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Spec freeze')).toBeVisible();

    // Target the Start cell by its accessible name — filtering by visible text
    // would also match the milestone's em-dash Dur cell.
    await page
      .getByRole('row')
      .filter({ hasText: 'Spec freeze' })
      .getByRole('gridcell', { name: /^starts / })
      .click();
    await page.getByRole('dialog', { name: 'Pick milestone date' }).waitFor();
    await page.getByRole('button', { name: 'End of Discovery' }).click();

    await expect(page.getByTestId('reconcile-rejected-count')).toHaveText(/1 change refused/);
    await expect(page.getByTestId('reconcile-rejected-list')).toContainText(
      'You do not have permission to reschedule this task.',
    );
    await expect(
      page.getByRole('button', { name: /Retry the refused change on Spec freeze/ }),
    ).toBeVisible();
  });
});
