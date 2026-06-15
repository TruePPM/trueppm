import { test, expect } from '@playwright/test';

/**
 * #1179 — context-aware "+ New" in the v2 unified shell bar (ADR-0131). Golden path:
 * create from two distinct contexts — the menu context (Schedule → New ▾ → Milestone,
 * opening the task/milestone modal) and a single-button context on a different create
 * flow (Program → New project, opening the project modal). The per-route Task/Story
 * dispatch + RBAC gating are covered exhaustively in the CreateMenu vitest spec.
 */

const PID = 'e2e-1179-0000-0000-0000-000000000001';
const GID = 'e2e-1179-0000-0000-0000-0000000000aa';
const BASE = `/projects/${PID}`;

const PROJECT_DETAIL = {
  id: PID, name: 'Create Affordance Project', description: '', start_date: '2026-01-01',
  calendar: 'default', estimation_mode: 'OPEN', agile_features: true, methodology: 'HYBRID',
  code: '', health: 'AUTO', visibility: 'WORKSPACE', timezone: '', default_view: 'BOARD',
  lead: null, lead_detail: null, iteration_label: 'Sprint', is_archived: false, archived_at: null,
  archived_by: null, recalculated_at: null, is_sample: false, program_detail: null, server_version: 1,
};

const pj = (b: unknown) => JSON.stringify(b);
const page200 = { count: 0, next: null, previous: null, results: [] };

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({ state: { accessToken: 'e2e', refreshToken: 'r', isAuthenticated: true }, version: 0 }),
    );
  });
  // Catch-all FIRST (Playwright: later routes win) so no unmocked /api request 401s —
  // a 401 trips the session-expired modal in this preview env. Auth endpoints get
  // explicit success shapes so the bootstrap never declares the session expired.
  await page.route('**/api/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) }));
  await page.route('**/api/v1/auth/token/refresh/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj({ access: 'e2e-access' }) }));
  await page.route('**/api/v1/auth/me/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj({ id: 1, username: 'e2e', email: 'e2e@example.com', workspace_role: 300 }) }));
  await page.route('**/api/v1/me/notifications/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj({ count: 0, next: null, previous: null, results: [] }) }));

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }) }),
  );
  await page.route(`**/api/v1/projects/${PID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(PROJECT_DETAIL) }),
  );
  // useCurrentUserRole reads members/?self=true → [{ role }]; ADMIN (300) so create gates pass.
  await page.route(`**/api/v1/projects/${PID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([{ id: 'm1', role: 300 }]) }),
  );
  await page.route(`**/api/v1/projects/${PID}/overview/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }) }),
  );
  await page.route(`**/api/v1/projects/${PID}/board-config/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ columns: [
      { status: 'BACKLOG', label: 'Backlog', visible: true },
      { status: 'NOT_STARTED', label: 'To Do', visible: true },
      { status: 'IN_PROGRESS', label: 'In Progress', visible: true },
      { status: 'REVIEW', label: 'Review', visible: true },
      { status: 'COMPLETE', label: 'Done', visible: true },
    ] }) }),
  );
  // Broad empty stubs so the views (and the TaskFormModal's dependent queries) don't
  // hit the live network. The "+ New" lives in the chrome, independent of view data.
  for (const path of ['tasks', 'dependencies', 'sprints', 'risks', 'attention', 'my-tasks', 'resource-allocation', 'status-summary', 'presence', 'velocity', 'monte-carlo/latest']) {
    await page.route(`**/api/v1/projects/${PID}/${path}/**`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) }),
    );
  }
  await page.route('**/api/v1/projects/*/presence/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }));
  await page.route('**/api/v1/tasks/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) }));
  await page.route('**/api/v1/dependencies/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) }));

  // Program detail — my_role ADMIN (300) so the program "New project" target is allowed.
  // Registered after the catch-all so this specific shape (with my_role) wins.
  await page.route(`**/api/v1/programs/${GID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ id: GID, name: 'Delivery Program', description: '', my_role: 300, project_count: 1, color: null, code: '', server_version: 1 }) }),
  );
  // Program rollup — ProgramOverviewPage reads this and does `Object.entries(rollup.kpis)`.
  // Without an explicit mock the catch-all returns the list shape `{count, results}` (truthy,
  // but no `kpis`), so `Object.entries(undefined)` throws and the root error boundary replaces
  // the whole shell — detaching the shell-bar button mid-click. That was the #1190 flake.
  await page.route(`**/api/v1/programs/${GID}/rollup/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ aggregation_policy: 'worst', policy_available: true, project_count: 1, program_health: 'unknown', kpis: {} }) }),
  );
}

test.describe('#1179 context-aware "+ New" (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('Schedule context → the "New" menu offers Milestone, which opens the milestone modal', async ({ page }) => {
    await page.goto(`${BASE}/schedule`);
    await page.getByRole('button', { name: 'Create new' }).click();
    // force: the menu is correctly open; the Schedule canvas repaints underneath it,
    // so Playwright's animation-stability gate never settles. The click is valid.
    await page.getByRole('menuitem', { name: 'milestone' }).click({ force: true });
    await expect(page.getByRole('dialog', { name: /new milestone/i })).toBeVisible();
  });

  test('Program context → a single "New project" button opens the project create modal', async ({ page }) => {
    await page.goto(`/programs/${GID}/overview`);
    // Wait for the overview to finish rendering before clicking the shell-bar control.
    // The program <h1> renders only after /programs/:id/ (+ its rollup) resolve, so it is a
    // reliable "page loaded without crashing" signal — clicking before then races the
    // bootstrap and was the #1190 detach flake.
    await expect(page.getByRole('heading', { name: 'Delivery Program' })).toBeVisible();
    // exact:true so this matches the shell-bar control, not the Sidebar's "+ New project".
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await expect(page.getByRole('dialog', { name: /new project/i })).toBeVisible();
  });
});
