/**
 * E2E for the Board sprint view switcher (#429, ADR-0119) + chrome (#1138/#1141, ADR-0123).
 *
 * Covers the golden path: the board now SMART-DEFAULTS to a project's single
 * active sprint (#1141) — the switcher no longer resets to "Project" every load.
 * From there: switch to "All tasks" and back, the scope persists in ?sprint=,
 * and a COMPLETED sprint shows the read-only banner (#1141).
 *
 * The drag-to-assign behaviour (and the drop toast, #1140) is validated in the
 * BoardView/useBoardTasks unit tests (dnd-kit drag is brittle in Playwright);
 * this spec asserts the filter + URL + chrome surface. Day-counter / date text
 * is intentionally NOT asserted — it is wall-clock + locale dependent.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-sv-00000000-0000-0000-0000-000000000429';
const BASE_URL = `/projects/${PROJECT_ID}`;
const SPRINT_ID = 'sprint-atlas-4';
const DONE_SPRINT_ID = 'sprint-atlas-3';

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Sprint View Project',
    description: '',
    start_date: '2026-06-01',
    calendar: 'default',
    agile_features: true,
    methodology: 'HYBRID',
  },
];

const SUMMARY_TASK = {
  id: 'phase-1',
  wbs_path: '1',
  name: 'Delivery',
  duration: 25,
  percent_complete: 30,
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
  sprint: null,
};

function task(id: string, name: string, sprint: string | null) {
  return {
    id,
    wbs_path: `1.${id}`,
    name,
    parent_id: 'phase-1',
    status: 'IN_PROGRESS',
    early_start: '2026-06-02',
    early_finish: '2026-06-06',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    sprint,
  };
}

const IN_SPRINT = task('t-in', 'In the sprint', SPRINT_ID);
const OUT_SPRINT = task('t-out', 'Not in the sprint', null);
// A task inside the COMPLETED sprint so the closed-sprint board renders a card
// whose write path can be exercised (and must stay blocked).
const DONE_SPRINT_TASK = task('t-done', 'Done sprint task', DONE_SPRINT_ID);

function sprintFixture(id: string, name: string, state: string) {
  return {
    id,
    server_version: 1,
    short_id: name.replace(/\s/g, ''),
    short_id_display: `SP-${name.replace(/\s/g, '')}`,
    name,
    goal: '',
    notes: '',
    start_date: '2026-06-01',
    finish_date: '2026-06-14',
    state,
    target_milestone: null,
    capacity_points: null,
    wip_limit: null,
    exclude_from_velocity: false,
  };
}

// Exactly one ACTIVE sprint → the smart default (#1141) pre-selects it. The
// COMPLETED sprint drives the read-only banner test.
const SPRINTS = [
  sprintFixture(SPRINT_ID, 'Atlas 4', 'ACTIVE'),
  sprintFixture(DONE_SPRINT_ID, 'Atlas 3', 'COMPLETED'),
];

async function setup(page: import('@playwright/test').Page) {
  const tasks = [SUMMARY_TASK, IN_SPRINT, OUT_SPRINT, DONE_SPRINT_TASK];
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: PROJECTS,
    projectId: PROJECT_ID,
    tasks,
    statusSummary: { task_count: tasks.length },
  });
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: SPRINTS.length, next: null, previous: null, results: SPRINTS }),
    }),
  );
}

test.describe('Board sprint view (#429 / chrome #1138 #1141)', () => {
  test('smart-defaults to the single active sprint, switches to All tasks and back', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    // #1141 smart default: the board pre-selects the single ACTIVE sprint, so
    // the scope lands on Atlas 4 (URL + switcher label) and the out-of-sprint
    // card is hidden — no manual pick needed.
    await expect(page).toHaveURL(/[?&]sprint=sprint-atlas-4/);
    await expect(page.getByRole('button', { name: /Sprint view: Atlas 4/i })).toBeVisible();
    await expect(page.getByText('In the sprint', { exact: true })).toBeVisible();
    await expect(page.getByText('Not in the sprint', { exact: true })).toHaveCount(0);

    // Switch back to the full project board.
    await page.getByRole('button', { name: /Sprint view: Atlas 4/i }).click();
    await page.getByRole('menuitemradio', { name: /All tasks/ }).click();
    await expect(page).not.toHaveURL(/sprint=/);
    await expect(page.getByText('Not in the sprint', { exact: true })).toBeVisible();

    // And back into the sprint scope via the switcher.
    await page.getByRole('button', { name: /Board scope: Project/i }).click();
    await page.getByRole('menuitemradio', { name: /Atlas 4/ }).click();
    await expect(page).toHaveURL(/[?&]sprint=sprint-atlas-4/);
    await expect(page.getByText('Not in the sprint', { exact: true })).toHaveCount(0);
  });

  test('a failed status move keeps the card on the board (#1518)', async ({ page }) => {
    await setup(page);
    // The status PATCH 500s. useUpdateTaskStatus only invalidates on success, so
    // a failed move must leave the card exactly where it was — a recoverable
    // failure, not a crash that tears down the board.
    let patchAttempts = 0;
    await page.route('**/api/v1/tasks/*/', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchAttempts += 1;
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"detail":"boom"}',
        });
      }
      return route.fallback();
    });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${BASE_URL}/board`);
    // Smart-default lands on the single active sprint (Atlas 4).
    await expect(page).toHaveURL(/[?&]sprint=sprint-atlas-4/);
    const card = page.getByText('In the sprint', { exact: true });
    await expect(card).toBeVisible();
    await card.hover();

    await page.getByRole('button', { name: 'Actions for In the sprint' }).click();
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    await page.getByRole('menuitem', { name: 'Done' }).click();

    // The PATCH fired and failed; the card is still on the board and the switcher
    // chrome is intact (no error boundary).
    await expect.poll(() => patchAttempts).toBeGreaterThan(0);
    await expect(page.getByText('In the sprint', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sprint view: Atlas 4/i })).toBeVisible();
    // And the user gets an explicit error toast — the silent revert is signalled (#1631).
    await expect(page.getByText("Couldn't move the card — try again.")).toBeVisible();
  });

  test('shows the read-only banner on a closed sprint (#1141)', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board?sprint=${DONE_SPRINT_ID}`);

    // A shared ?sprint= link to a COMPLETED sprint surfaces the read-only banner.
    await expect(page.getByText(/Closed sprint — read only/i)).toBeVisible();
  });

  test('closed sprint blocks the keyboard "Move to…" write path (#1141)', async ({ page }) => {
    await setup(page);

    // Spy every task PATCH. The read-only banner is cosmetic; the actual
    // write-protection is that no status mutation may leave the board. The
    // keyboard "Move to…" menu is a second write path alongside (disabled) drag,
    // so it must be exercised — a banner-only assertion misses a regressed
    // readOnly guard entirely (issue 1512).
    let taskPatches = 0;
    await page.route('**/api/v1/tasks/*/', (route) => {
      if (route.request().method() === 'PATCH') {
        taskPatches += 1;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 't-done', status: 'COMPLETE' }),
        });
      }
      return route.continue();
    });

    // The action button is opacity-0 until hover and the card lifts on hover —
    // reduced motion removes the transform so the button settles as "stable".
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${BASE_URL}/board?sprint=${DONE_SPRINT_ID}`);
    await expect(page.getByText(/Closed sprint — read only/i)).toBeVisible();

    const card = page.getByText('Done sprint task', { exact: true });
    await expect(card).toBeVisible();
    await card.hover();

    // Open the card's action menu → Move to… → Done, then confirm the mutation
    // never fired. The card carries aria-disabled (dnd-kit's sortable is disabled
    // on a closed sprint), which Playwright reports as "not enabled" for its
    // descendants — but the buttons still respond to a real click, so force past
    // the advisory ARIA state to exercise the actual write path.
    await page.getByRole('button', { name: 'Actions for Done sprint task' }).click({ force: true });
    await page.getByRole('menuitem', { name: 'Move to…' }).click({ force: true });
    await page.getByRole('menuitem', { name: 'Done' }).click({ force: true });

    // No sleep-and-hope: handleMenuMove's `if (readOnly) return;` guard
    // (BoardView.tsx) is the first statement in a fully synchronous handler
    // chain — it either returns before updateStatus.mutate() is ever called,
    // or it doesn't. There is no await between the click and that decision,
    // so waiting longer can't surface anything a fixed sleep couldn't; it
    // only added flake risk (too short on loaded CI, dead time otherwise)
    // without adding coverage. Assert immediately.
    expect(taskPatches).toBe(0);
    // The card stays put on the closed board.
    await expect(page.getByText('Done sprint task', { exact: true })).toBeVisible();
  });

  test('activity rail defaults to sprint scope with a whole-board toggle (#1946)', async ({
    page,
  }) => {
    await setup(page);
    // Capture every board-activity request URL so we can assert the scope param.
    const activityUrls: string[] = [];
    await page.route(`**/api/v1/projects/${PROJECT_ID}/board/activity**`, (route) => {
      activityUrls.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [
            {
              id: 's1',
              event_type: 'entered_sprint',
              actor: 'Priya',
              actor_id: 'u-priya',
              timestamp: '2026-06-10T00:00:00Z',
              task_id: 't-in',
              task_name: 'In the sprint',
              sprint_id: SPRINT_ID,
              scope_change_status: null,
              changes: [{ field: 'sprint', old: null, new: 'Atlas 4' }],
            },
          ],
          next_until: null,
        }),
      });
    });

    await page.goto(`${BASE_URL}/board`);
    // Smart-default lands on the single active sprint (Atlas 4).
    await expect(page).toHaveURL(/[?&]sprint=sprint-atlas-4/);

    // Open the activity rail from the board toolbar.
    await page.getByRole('button', { name: 'Board activity feed' }).click();
    const panel = page.getByRole('complementary', { name: 'Board activity' });
    await expect(panel.getByRole('heading', { name: 'Activity' })).toBeVisible();

    // Defaults to "This sprint" scope → the request carried ?sprint=, and the
    // relabeled "Scope changes" chip is present.
    await expect(panel.getByRole('button', { name: 'This sprint' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Whole board' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Scope changes' })).toBeVisible();
    await expect
      .poll(() => activityUrls.some((u) => /sprint=sprint-atlas-4/.test(decodeURIComponent(u))))
      .toBe(true);
    // The scope-change row is visible in the sprint-scoped rail.
    await expect(
      panel.getByRole('button', { name: /Priya added to sprint In the sprint/ }),
    ).toBeVisible();

    // Toggling to "Whole board" re-queries WITHOUT the sprint scope.
    activityUrls.length = 0;
    await panel.getByRole('button', { name: 'Whole board' }).click();
    await expect
      .poll(
        () =>
          activityUrls.length > 0 &&
          activityUrls.every((u) => !/[?&]sprint=/.test(decodeURIComponent(u))),
      )
      .toBe(true);
  });
});
