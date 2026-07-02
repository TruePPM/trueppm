import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Skill-aware assignment picker E2E — task detail drawer with skill requirements.
 * Covers: three-group picker (Best fit / Partial fit / No skill match),
 * skill_mismatch warning, skill chip rendering.
 */

const PROJECT_ID = 'e2e-proj-00000000-0000-0000-0000-000000000002';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Beta Launch',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Build API',
    early_start: '2026-01-05',
    early_finish: '2026-01-15',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
  },
];

const FIXTURE_RESOURCES_SKILL_FIT = [
  {
    id: 'res-1',
    name: 'Alice Nguyen',
    email: 'alice@example.com',
    job_role: 'Engineer',
    max_units: '1.00',
    calendar: null,
    skills: [
      { id: 'rs-1', resource: 'res-1', skill: 'sk-1', skill_name: 'Django', proficiency: 3 },
    ],
    skill_fit: 'exact',
    missing_skills: [],
  },
  {
    id: 'res-2',
    name: 'Bob Carter',
    email: 'bob@example.com',
    job_role: 'Designer',
    max_units: '1.00',
    calendar: null,
    skills: [],
    skill_fit: 'missing',
    missing_skills: [
      {
        skill_id: 'sk-1',
        skill_name: 'Django',
        required: 2,
        required_label: 'Intermediate',
        actual: 0,
        actual_label: 'None',
      },
    ],
  },
];

async function seedAndNavigate(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  // Project detail — ProjectShell gates every project route on this query (#1111).
  // Under the shared 404 catch-all (issue 1513) this must be mocked with a real
  // object shape or ProjectShell renders ProjectNotFound and the schedule/task
  // list never mounts (the #1190 latent bug this migration surfaced).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: PROJECT_ID,
        name: 'Beta Launch',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        estimation_mode: 'OPEN',
        agile_features: false,
        methodology: 'WATERFALL',
        code: '',
        health: 'AUTO',
        visibility: 'WORKSPACE',
        timezone: '',
        default_view: 'SCHEDULE',
        lead: null,
        lead_detail: null,
        iteration_label: 'Sprint',
        is_archived: false,
        archived_at: null,
        archived_by: null,
        recalculated_at: null,
        is_sample: false,
        program_detail: null,
        server_version: 1,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 0,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_TASKS }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/task-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/task-skill-requirements/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 'tsr-1',
            server_version: 1,
            task: 't1',
            skill: 'sk-1',
            skill_name: 'Django',
            min_proficiency: 2,
          },
        ],
      }),
    }),
  );
  // Resources with ?task= returns skill-fit annotated results
  await page.route(`**/api/v1/resources/**task=t1**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 2,
        next: null,
        previous: null,
        results: FIXTURE_RESOURCES_SKILL_FIT,
      }),
    }),
  );
  await page.route('**/api/v1/project-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  // The redesigned drawer gates write controls (the "add resource" button) off
  // the caller's project role via GET members/?self= (ADR-0133). Without this
  // mock the role never resolves, canEdit falls to false, and the button is
  // hidden. Return an Admin (role 300) as a single-element list.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-e2e', role: 300, user_id: 'e2e-user' }]),
    }),
  );

  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  // Gate on the schedule's Task list grid rendering (the page's core reads have
  // resolved) rather than `networkidle`, which never settles cleanly while the
  // app-wide hooks poll and the WebSocket handshake runs.
  await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
}

// 401-guard safety net, registered before each test so it is the EARLIEST route
// and every specific mock in seedAndNavigate wins over it by Playwright's
// most-recently-added precedence. Any endpoint not mocked there (the app-wide shell
// + ⌘K palette fetch programs, sprints, velocity, project detail, me/work, …) would
// otherwise 401 → refresh → expire and raise the full-screen session-expired modal,
// which then intercepts every click. This spec previously passed on timing slack
// that #647's extra app-wide hook subscriptions removed.
test.beforeEach(async ({ page }) => {
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'u1', email: 'pm@example.com', first_name: 'P', last_name: 'M' }),
    }),
  );
});

test('Skill-fit groups appear in the assignment picker when task has requirements', async ({
  page,
}) => {
  await seedAndNavigate(page);

  // Open task detail drawer by clicking the task row (scoped to grid to avoid
  // matching the canvas aria-overlay row which resolves to a second element)
  await page
    .getByRole('grid', { name: 'Task list' })
    .getByRole('row', { name: /Build API/i })
    .click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();

  // Resource assignment lives inside the Dependencies section, which is
  // collapsed by default in the redesigned drawer (ADR-0050).
  await drawer.getByRole('button', { name: 'Dependencies' }).click();

  // Click "Add assignee" to open the resource combobox
  await drawer.getByRole('button', { name: /add resource/i }).click();

  // Should show grouped headings
  await expect(page.getByText('Best fit')).toBeVisible();
  await expect(page.getByText('No skill match')).toBeVisible();

  // Alice appears under Best fit, Bob under No skill match
  await expect(page.getByRole('option', { name: /Alice Nguyen/i })).toBeVisible();
  await expect(page.getByRole('option', { name: /Bob Carter/i })).toBeVisible();
});

test('Missing skill badge shown for no-match resources', async ({ page }) => {
  await seedAndNavigate(page);

  await page
    .getByRole('grid', { name: 'Task list' })
    .getByRole('row', { name: /Build API/i })
    .click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Dependencies' }).click();
  await drawer.getByRole('button', { name: /add resource/i }).click();

  // Bob should have a "Missing: Django" chip
  await expect(page.getByText('Missing: Django')).toBeVisible();
});
