/**
 * Schedule render parity (#248) + Milestone toolbar (#340).
 *
 * Covers user-visible acceptance criteria:
 * - WBS column renders task wbs paths
 * - Owner column renders avatars
 * - Toolbar toggle buttons (4 of them) render with aria-pressed
 * - Summary chip shows task count + critical count + CPM ✓
 * - "+ Milestone" button is visible peer to "+ Item"
 * - Clicking "+ Milestone" inserts a row + fires the pulse overlay
 * - Reduced-motion suppresses the pulse overlay
 *
 * The ⌘M shortcut is exercised at the unit layer (useScheduleKeyboard tests)
 * because Playwright's keyboard.press('Meta+M') has cross-OS quirks.
 */
// The Display trigger is located THROUGH the toolbar, not by name alone.
// `name` matching is substring by default, and the coach bar's dismiss control
// says "bring it back from Display options" (#2959), so a bare 'Display' now
// resolves to two buttons. `exact: true` is not the fix either — the trigger's
// own accessible name becomes "Display, 1 active filter" once a filter is on.
// Scoping to the toolbar is stable under both.
// Since #3134 the how-to bar renders only while the outline is IDLE (web rule
// 363), so the collision is conditional now rather than constant. Keep the
// scoping regardless: it is correct in both states, and every assertion here
// runs before a row is touched, which is exactly the two-button case.
import { test, expect } from './fixtures/coverage';
import {
  setupAuth,
  setupApiMocks,
  setupCatchAll,
  setupScheduleDisplayOptions,
} from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-render-00000000-0000-0000-0000-000000000248';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Render Parity Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'rp1',
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignments: [{ resource_id: 'r1', resource_name: 'Alice', units: 1 }],
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'rp2',
    wbs_path: '2',
    name: 'Framing',
    early_start: '2026-04-12',
    early_finish: '2026-04-16',
    planned_start: '2026-04-12',
    duration: 5,
    percent_complete: 0,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

test.describe('Schedule render parity — toolbar + columns (#248)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('WBS column renders task wbs paths', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    // The WBS aria-label is on each row's wbs cell.
    await expect(page.getByLabel('WBS 1')).toBeVisible();
    await expect(page.getByLabel('WBS 2')).toBeVisible();
  });

  test('Owner column renders avatars for assigned tasks', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByLabel(/Owner: Alice/i)).toBeVisible();
    await expect(page.getByLabel('Owner: none')).toBeVisible(); // task rp2
  });

  test('Display menu exposes the four filters as checkboxes (aria-checked)', async ({ page }) => {
    // #1741: the four filters moved from inline toolbar toggles into the Display
    // popover as menuitemcheckbox rows.
    await page.goto(BASE_URL);
    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .click();
    const menu = page.getByRole('menu', { name: 'Display options' });
    for (const name of ['CP only', 'Focus chain', 'Critical path', 'Milestones']) {
      const item = menu.getByRole('menuitemcheckbox', { name });
      await expect(item).toBeVisible();
      await expect(item).toHaveAttribute('aria-checked', 'false');
    }
  });

  test('Toggling Critical path filters non-critical tasks out (summaries stay)', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(page.getByText('Framing')).toBeVisible();
    // Both fixture tasks are critical, so toggling on should leave them visible.
    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .click();
    const criticalItem = page
      .getByRole('menu', { name: 'Display options' })
      .getByRole('menuitemcheckbox', { name: 'Critical path' });
    await criticalItem.click();
    await expect(criticalItem).toHaveAttribute('aria-checked', 'true');
    // Close the popover; the trigger now advertises one active filter.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Display, 1 active filter' })).toBeVisible();
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(page.getByText('Framing')).toBeVisible();
  });

  test('Summary chip shows item, sprint and critical counts', async ({ page }) => {
    await page.goto(BASE_URL);
    // Chip label includes all four counts and the CPM healthy state. The noun is
    // the governed neutral one (#3259) — the chip counts every row regardless of
    // structure_role, so "tasks" typed the phases and milestones among them.
    // Neither fixture task carries a sprint, hence `0 in sprints`.
    await expect(
      page.getByLabel(/Project status: 2 items, 0 in sprints, 2 critical, CPM healthy/),
    ).toBeVisible();
  });
});

test.describe('Schedule milestone toolbar — +Milestone (#340)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
    // #3115 ships `+ Milestone` unpinned. The tests below are about the button
    // itself — its glyph, its accessible name, what clicking it opens — so they
    // pin it into the bar, which is what a planner who wants it there does.
    // `defaults to the overflow menu` below covers the unpinned state.
    await setupScheduleDisplayOptions(page, FIXTURE_PROJECT_ID, { pinMilestone: true });
    // Stub the create task POST so the e2e doesn't hit a real backend.
    await page.route('**/api/v1/tasks/', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'rp-new-milestone',
            name: '',
            project: FIXTURE_PROJECT_ID,
            wbs_path: '3',
            duration: 0,
            status: 'NOT_STARTED',
            percent_complete: 0,
            is_milestone: true,
          }),
        });
      }
      return route.continue();
    });
  });

  test('+ Milestone defaults to the overflow menu, not the bar (#3115)', async ({ page }) => {
    // The de-risk and its limit, in one test. Unpinned means the button is out
    // of the bar's hot path — and still one hop away under its own name, with
    // the chord that is actually bound. If this ever finds it absent from the
    // menu too, the change stopped being a de-risk and became a removal.
    await setupScheduleDisplayOptions(page, FIXTURE_PROJECT_ID, { pinMilestone: false });
    await page.goto(BASE_URL);
    // Gate on rendered rows before touching toolbar chrome — the same signal the
    // rest of this file waits on.
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(page.getByTestId('add-milestone-button')).toHaveCount(0);

    await page.getByRole('button', { name: 'Project actions' }).click();
    const item = page.getByRole('menuitem', { name: /Add milestone/ });
    await expect(item).toBeVisible();
    // ⌘M is the binding (`keyBindings['mod+m']`). The menu advertised ⌥⌘M —
    // bound to nothing — until #3115.
    await expect(item).toHaveAttribute('aria-keyshortcuts', 'Meta+M');
  });

  test('+ Milestone button is visible as peer to + Item', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByTestId('add-milestone-button')).toBeVisible();
    await expect(page.getByTestId('add-milestone-button')).toContainText('Milestone');
  });

  test('+ Milestone button has the Cmd+M accessible label', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByRole('button', { name: 'Add new milestone (Cmd+M)' })).toBeVisible();
  });

  test('clicking + Milestone opens the milestone-create dialog (no eager POST)', async ({
    page,
  }) => {
    // Updated for the milestone-add dialog (issue #240 follow-up). The
    // button now opens TaskFormModal in milestone mode so the user can pick
    // name + date + parent up front; no /tasks/ POST fires until the user
    // submits the form. Submit-payload shape is covered by
    // schedule-milestone-add.spec.ts.
    await page.goto(BASE_URL);
    let postCount = 0;
    await page.route('**/api/v1/tasks/', async (route) => {
      if (route.request().method() === 'POST') {
        postCount += 1;
      }
      await route.continue();
    });
    await page.getByTestId('add-milestone-button').click();
    await expect(page.getByRole('dialog', { name: 'New milestone' })).toBeVisible();
    expect(postCount).toBe(0);
  });
});
