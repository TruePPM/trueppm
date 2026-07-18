/**
 * E2E for the unified task create/edit modal (issue #305 / ADR-0052).
 *
 * Covers the create flow (board phase + button → modal opens with the
 * phase context) and the edit flow (popover Edit → modal prefills with
 * task data). Mobile shell is unit-tested only — the e2e bottom-sheet
 * counterpart deterministically lands on login at 375×667 (the same
 * known auth flake as wave3-card-info-popover).
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

const PHASE_TASK = {
  id: 'p1', wbs_path: '1', name: 'Alpha Phase',
  early_start: '2026-04-05', early_finish: '2026-04-30',
  planned_start: '2026-04-05',
  duration: 20, percent_complete: 50, is_critical: false,
  is_milestone: false, is_summary: true, parent_id: null,
  status: 'IN_PROGRESS', assignees: [], total_float: null,
  predecessor_count: 0, is_blocked: false,
  linked_risks_count: 0, linked_risks_max_severity: null,
};

const TASK = {
  id: 't1', wbs_path: '1.1', name: 'Build feature',
  early_start: '2026-04-07', early_finish: '2026-04-14',
  planned_start: '2026-04-07',
  duration: 7, percent_complete: 30, is_critical: false,
  is_milestone: false, is_summary: false, parent_id: 'p1',
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: 5,
  predecessor_count: 0, is_blocked: false,
  linked_risks_count: 0, linked_risks_max_severity: null,
  readiness: 'ready',
  notes: 'Existing notes',
};

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const tasks = [PHASE_TASK, TASK];

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
        schedule_in_deliver: false,
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
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
  await page.route('**/api/v1/projects/*/workshop/current/', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active workshop session.' }) }),
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

test.describe('Task create/edit modal (#305)', () => {
  test('clicking the phase + button opens the unified create modal with phase context', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    const addButton = page.getByRole('button', { name: /Add task to Alpha Phase/ });
    await expect(addButton).toBeVisible({ timeout: 10_000 });
    await addButton.click();

    const dialog = page.getByRole('dialog', { name: /Add to Alpha Phase/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('NEW TASK', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Task name *')).toBeVisible();
    // Progress slider should NOT show in create mode (Priya-priority spec).
    await expect(dialog.getByLabel('Progress')).toHaveCount(0);
    // Footer surfaces the keyboard hint.
    await expect(dialog.getByText(/to save/)).toBeVisible();
  });

  test('Classification group exposes the type / governance / delivery taxonomy with server defaults', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    const addButton = page.getByRole('button', { name: /Add task to Alpha Phase/ });
    await expect(addButton).toBeVisible({ timeout: 10_000 });
    await addButton.click();

    const dialog = page.getByRole('dialog', { name: /Add to Alpha Phase/ });
    await expect(dialog).toBeVisible();
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

  test('Parent phase picker resolves a leaf task label and shows the promotion hint (#378)', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    const addButton = page.getByRole('button', { name: /Add task to Alpha Phase/ });
    await expect(addButton).toBeVisible({ timeout: 10_000 });
    await addButton.click();

    const dialog = page.getByRole('dialog', { name: /Add to Alpha Phase/ });
    await expect(dialog).toBeVisible();
    const picker = dialog.getByLabel(/Parent phase/);
    await expect(picker).toBeVisible();

    // Default hint surfaces the seeded summary parent (Alpha Phase / `p1`).
    await expect(
      dialog.getByText('New task will be added as a child of this phase.'),
    ).toBeVisible();

    // Selecting the leaf task option swaps the hint to the leaf-promotion
    // copy. Before #378 the leaf was filtered out of `parentOptions` entirely,
    // so the hint never matched. The picker is a native <select> (issue #444);
    // selectOption resolves by visible label.
    await picker.selectOption({ label: '1.1 · Build feature' });
    await expect(
      dialog.getByText('Adding a task here will turn this task into a phase.'),
    ).toBeVisible();
  });

  test('Governance class field-help popover lists all options and deep-links to the docs (#1975)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    const addButton = page.getByRole('button', { name: /Add task to Alpha Phase/ });
    await expect(addButton).toBeVisible({ timeout: 10_000 });
    await addButton.click();

    const dialog = page.getByRole('dialog', { name: /Add to Alpha Phase/ });
    await expect(dialog).toBeVisible();

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
