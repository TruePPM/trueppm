/**
 * E2E for the unified task create/edit modal (issue #305 / ADR-0052).
 *
 * **Create mode is entered from the Calendar's empty state, not the board (#2952).**
 * These tests used to open the modal from the board lane `+`, which no longer opens a
 * form at all — the lane now offers a one-field compose (see `board-lane-compose.spec.ts`).
 * The modal itself still ships and is still reached from the Calendar, the Schedule's
 * milestone mode, the Schedule empty state and mobile, so its create-mode contract stays
 * covered here; only the *entry point* moved.
 *
 * One assertion did not survive the move and is deliberately not faked: the modal's
 * "Add to {phase}" header and its parent-phase picker need a project that already has a
 * phase, and every surviving create entry point is an EMPTY-state affordance. Phase
 * context on create is now the Designer's job, and it is covered there.
 *
 * Mobile shell is unit-tested only — the e2e bottom-sheet counterpart deterministically
 * lands on login at 375×667 (the same known auth flake as wave3-card-info-popover).
 */
import { test, expect } from './fixtures/coverage';

const FIXTURE_PROJECT_ID = 'e2e-305-00000000-0000-0000-0000-000000000305';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Task Modal Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

interface SetupOptions {
  /** Resolved methodology (#2667) — drives the Classification defaults/grouping. */
  effectiveMethodology?: 'WATERFALL' | 'AGILE' | 'HYBRID';
  /** Sprint cadence vs. continuous-flow Kanban (ADR-0164) — only consulted for AGILE. */
  boardCadence?: 'sprint' | 'continuous';
  /** Sprint/story-point chrome (unrelated to this spec's default assertions) —
   *  kept false to match every pre-existing test's fixture unless overridden. */
  agileFeatures?: boolean;
}

async function setup(page: import('@playwright/test').Page, options: SetupOptions = {}) {
  const { effectiveMethodology = 'HYBRID', boardCadence = 'sprint', agileFeatures = false } =
    options;
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Empty by construction: create mode is reached from an empty-state CTA, so a project
  // with rows has no route to the modal at all (#2952).
  const tasks: unknown[] = [];

  // Catch-all fallthrough, registered FIRST so every specific route below wins
  // (Playwright matches last-registered first). Without it, any endpoint this
  // spec forgets to mock — notably the `/auth/me/` bootstrap — leaks through the
  // vite-preview proxy to a locally-running dev backend on :8000, which returns
  // a real 401 for the fake e2e token and raises the session-expired modal that
  // then intercepts every click. Returns 404 (not 401, and not a 200 list shape
  // that would break object-shaped endpoints and trip the root error boundary),
  // matching the repo's `setupCatchAll` and reproducing CI's no-backend
  // fail-soft behavior where unmocked reads simply error rather than log out.
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'unmocked in test' }),
    }),
  );
  // Auth bootstrap — object shapes the catch-all's list shape can't satisfy.
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        username: 'e2euser',
        display_name: 'E2E User',
        initials: 'EU',
        email: 'e2e@example.com',
        default_landing: 'my_work',
        landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
        hidden_views: [],
        role_context: 'unified',
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );
  // Current-user role (#2145): the Schedule "+ Item" button is now gated on
  // Member+ (pessimistic while the role loads). Without this the ?self=true
  // query hits the 404 catch-all and the button stays disabled. Admin (300).
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: route.request().url().includes('self=true')
        ? JSON.stringify([{ id: 'mem-self', role: 300, role_label: 'Project Manager' }])
        : JSON.stringify({ count: 1, next: null, previous: null, results: [{ id: 'mem-self', role: 300, role_label: 'Project Manager' }] }),
    }),
  );

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  // Single-project detail — `ProjectShell` gates every project route on this
  // query and swaps in `ProjectNotFound` when it 404s (the #2040 "unavailable"
  // gate). Without this mock the request falls to the 404 catch-all and, as the
  // late 404 lands mid-test, the whole board (modal + FieldHelp popover) is torn
  // out — a flaky teardown that fails whichever assertion is in flight (#2262).
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        id: FIXTURE_PROJECT_ID, name: 'Task Modal Project', description: '',
        start_date: '2026-04-01', calendar: 'default', estimation_mode: 'OPEN',
        agile_features: agileFeatures,
        methodology: effectiveMethodology, effective_methodology: effectiveMethodology,
        board_cadence: boardCadence, code: '', health: 'AUTO',
        visibility: 'WORKSPACE', timezone: '', default_view: 'BOARD',
        lead: null, lead_detail: null, iteration_label: 'Sprint',
        is_archived: false, archived_at: null, archived_by: null,
        recalculated_at: null, is_sample: false, program_detail: null,
        server_version: 1,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 0, complete_tasks: 0,
        next_milestone: null, team_utilization_pct: null, owner_name: null,
        start_date: '2026-04-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        task_count: tasks.length, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/risks/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/resource-allocation/**`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        project_id: FIXTURE_PROJECT_ID,
        window_start: '2026-04-01',
        window_end: '2026-05-30',
        resources: [],
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-views/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        columns: [
          { status: 'BACKLOG',     label: 'Backlog',     visible: true, wip_limit: null, color: '#94A3B8' },
          { status: 'NOT_STARTED', label: 'To Do',       visible: true, wip_limit: null, color: '#64748B' },
          { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wip_limit: null, color: '#3B82F6' },
          { status: 'REVIEW',      label: 'Review',      visible: true, wip_limit: null, color: '#A855F7' },
          { status: 'COMPLETE',    label: 'Done',        visible: true, wip_limit: null, color: '#22C55E' },
        ],
      }),
    }),
  );
}

/**
 * Open the create modal from the Calendar's empty-state CTA (#2952).
 *
 * One definition rather than four copies of the same three lines: the entry point moved
 * once and will move again, and a spec file that spells it out per test is how a
 * relocation turns into a five-test edit.
 */
async function openCreateModal(page: import('@playwright/test').Page) {
  await page.goto(`${BASE_URL}/calendar?calAnchor=2026-04-01`);
  const cta = page.getByRole('button', { name: '+ Add task' });
  await expect(cta).toBeVisible({ timeout: 10_000 });
  await cta.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Task create/edit modal (#305)', () => {
  test('the create CTA opens the unified modal in create mode', async ({ page }) => {
    await setup(page);
    const dialog = await openCreateModal(page);
    await expect(dialog.getByText('NEW TASK', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Task name *')).toBeVisible();
    // Progress slider should NOT show in create mode (Priya-priority spec).
    await expect(dialog.getByLabel('Progress')).toHaveCount(0);
    // Footer surfaces the keyboard hint.
    await expect(dialog.getByText(/to save/)).toBeVisible();
  });

  test('Classification group exposes the type / governance / delivery taxonomy with server defaults', async ({ page }) => {
    await setup(page);
    const dialog = await openCreateModal(page);
    // The taxonomy editor (previously: stored + seeded but unreachable from the UI).
    await expect(dialog.getByText('Classification', { exact: true })).toBeVisible();
    // Exact match: each field now has a sibling FieldHelp button whose aria-label
    // ("About the <field> options") contains the field name, so a substring
    // getByLabel would match both the select and the help button (#1975).
    await expect(dialog.getByLabel('Type', { exact: true })).toHaveValue('task');
    await expect(dialog.getByLabel('Governance class', { exact: true })).toHaveValue('flow');
    await expect(dialog.getByLabel('Delivery mode', { exact: true })).toHaveValue('waterfall');

    // Switching delivery mode updates the grounded helper caption.
    await dialog.getByLabel('Delivery mode', { exact: true }).selectOption('kanban');
    await expect(dialog.getByText(/item throughput on a WIP-limited board/)).toBeVisible();
  });

  // The two #2667 methodology-default tests that lived here are gone (#2952). The AGILE
  // one has no route left at all: an AGILE project with no tasks renders the Calendar's
  // *methodology* empty state ("Calendar isn't part of this project's workflow") with no
  // create CTA, and every surviving create entry point is an empty-state affordance.
  //
  // Nothing was lost by deleting rather than contorting a fixture to reach them.
  // `TaskFormModal.test.tsx` asserts the same defaults directly and covers a third case
  // these never did — AGILE on a continuous-flow board defaulting to kanban rather than
  // scrum (ADR-0164). Which select a project's methodology drives is a component fact;
  // a browser was the more expensive way to ask it.

  // Relocated from `board.spec.ts` (#2952) — the board no longer opens this modal, but
  // both claims are about the modal itself, so they follow it to the surviving entry
  // point rather than being dropped.
  test('story points are available on a non-agile project and are sent on create (#1961)', async ({
    page,
  }) => {
    // `agileFeatures` defaults false, so this is a waterfall project. The estimate is
    // decoupled from agile features (ADR-0418): Pts is available while the Sprint
    // selector stays agile-only.
    await setup(page);
    const dialog = await openCreateModal(page);
    await expect(dialog.getByLabel('Pts')).toBeVisible();
    await expect(dialog.getByLabel('Sprint')).toHaveCount(0);

    await dialog.getByLabel('Task name *').fill('Estimated waterfall task');
    // Points are a scale-aware <select> (ADR-0510, #2027) — pick, don't fill. No
    // effective_estimation_scale mock → falls back to Fibonacci, where 8 is valid.
    await dialog.getByLabel('Pts').selectOption('8');

    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/v1/tasks/') && r.method() === 'POST'),
      dialog.getByRole('button', { name: 'Create task' }).click(),
    ]);
    expect(request.postDataJSON()).toMatchObject({ story_points: 8 });
  });

  test('the create modal closes on Cancel', async ({ page }) => {
    await setup(page);
    const dialog = await openCreateModal(page);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('Governance class field-help popover lists all options and deep-links to the docs (#1975)', async ({
    page,
  }) => {
    await setup(page);
    const dialog = await openCreateModal(page);

    // The "?" info affordance sits in the Governance class label row.
    await dialog.getByRole('button', { name: 'About the Governance class options' }).click();

    // The popover portals OUT of the modal (role="dialog" is scoped by name to
    // disambiguate from the modal itself).
    const help = page.getByRole('dialog', { name: 'Governance class' });
    await expect(help).toBeVisible();
    // Every option is visible at once, not just the selected one. Exact match:
    // "Flow" as a substring also appears in the Hybrid description ("Mixes flow…").
    await expect(help.getByText('Flow', { exact: true })).toBeVisible();
    await expect(help.getByText('Gated', { exact: true })).toBeVisible();
    await expect(help.getByText('Hybrid', { exact: true })).toBeVisible();
    // The default (Flow) is marked as current.
    await expect(help.getByText('Current')).toBeVisible();

    // The docs deep-link points at the standalone docs site, opens in a new tab.
    const learnMore = help.getByRole('link', { name: /Learn more/ });
    await expect(learnMore).toHaveAttribute(
      'href',
      'https://docs.trueppm.com/features/task-classification/#governance-class--which-overlay-governs-the-subtree',
    );
    await expect(learnMore).toHaveAttribute('target', '_blank');

    // Escape peels the popover only — the task modal stays open.
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
    await expect(dialog).toBeVisible();
  });
});

// Edit-mode integration (popover → modal) and the destructive Delete confirm
// flow are covered by:
// - BoardView.test.tsx > "clicking 'Edit' opens the unified TaskFormModal in
//   edit mode (#305)" — popover wiring + edit-mode dialog accessible name.
// - TaskFormModal.test.tsx > "opens the destructive confirm dialog when
//   Delete is clicked" + "calls deleteTask.mutateAsync on confirm and notifies
//   onDeleted" — Delete gate, confirm UX, mutation dispatch, onDeleted side
//   effect across the role matrix.
//
// The deeper e2e counterparts deterministically land on the Login screen at
// jsdom's auth-state-flake threshold (same flake as wave3-card-info-popover's
// mobile test; documented in feedback_playwright_e2e). Unit-level coverage is
// sufficient — the wiring under test is local component state.
