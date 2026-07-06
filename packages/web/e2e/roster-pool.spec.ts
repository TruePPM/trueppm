import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures';

/**
 * Roster pool E2E — Team tab (Roster sub-view) with route mocking.
 * Covers: tab navigation, roster list renders, add-to-roster flow, cascade delete dialog.
 */

const PROJECT_ID = 'e2e-proj-00000000-0000-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Omega Launch', description: '', start_date: '2026-01-01', calendar: 'default' },
];

const FIXTURE_ROSTER = [
  {
    id: 'pr-1',
    project: PROJECT_ID,
    resource: 'res-1',
    resource_detail: {
      id: 'res-1', name: 'Alice Nguyen', email: 'alice@example.com',
      job_role: 'Frontend Engineer', max_units: '1.00', calendar: null,
      skills: [
        { id: 'rs-1', resource: 'res-1', skill: 'sk-1', skill_name: 'React', proficiency: 3 },
        { id: 'rs-2', resource: 'res-1', skill: 'sk-2', skill_name: 'TypeScript', proficiency: 2 },
      ],
    },
    role_title: 'Lead Dev',
    units_override: null,
    effective_max_units: '1.00',
    notes: '',
  },
];

const FIXTURE_RESOURCE_CANDIDATES = [
  { id: 'res-2', name: 'Bob Carter', email: 'bob@example.com', job_role: 'Designer' },
];

async function seedAuthAndNavigate(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({ state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true }, version: 0 }),
    );
  });

  // 401-guard net (registered FIRST so the specific routes below win): without it,
  // any endpoint this sparse spec doesn't mock falls through to the preview proxy
  // and, under the 3-tier rail's added shell reads (#1642), pops the session-expired
  // modal that blanks the roster. A 404 catch-all keeps unmocked reads inert.
  await setupCatchAll(page);

  // Shell/auth endpoints the app boots on. The 3-tier rail (#1642) resolves more
  // of these synchronously (identity, edition), so a missing /auth/me (previously
  // tolerated as an ECONNREFUSED on the preview proxy) now loses the race and the
  // session-expired modal pops mid-render, blanking the roster. Mock them so the
  // shell boots cleanly and no 401/session-expired can fire.
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'e2e-user', username: 'e2euser', display_name: 'E2E User', initials: 'EU', email: 'e2e@example.com', max_project_role: 200, workspace_role: null, can_access_admin_settings: true, default_landing: 'my_work', landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' }, hidden_views: [], role_context: 'unified' }) }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'e2e-ticket', expires_in: 30 }) }),
  );
  await page.route('**/api/v1/me/notifications/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }) }),
  );
  // The 3-tier rail's "This project" tier (#1642) reads the project DETAIL for
  // methodology/health/name (useProject → the same query ProjectShell gates on,
  // issue #1111). Without this the bare GET /projects/:id/ falls through to the
  // preview proxy and ProjectShell renders its "not available" state, replacing
  // the roster page. Mock it with a HYBRID shape so the rail (and shell) resolve.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...FIXTURE_PROJECTS[0], program: null, program_detail: null, health: 'AUTO', methodology: 'HYBRID', effective_methodology: 'HYBRID' }),
      });
    }
    return route.continue();
  });
  // The rail also reads /me/work (You-card badge) and /programs (Jump switcher);
  // mock both so their fetches resolve instead of hanging on the proxy.
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [], next: null, previous: null, active_sprints: [], due_today_count: 0, server_version_high_water: 0, retro_action_items: [] }) }),
  );
  await page.route('**/api/v1/programs/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/project-resources/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_ROSTER }) }),
  );
  await page.route('**/api/v1/resources/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_RESOURCE_CANDIDATES }) }),
  );
  // useCurrentUserRole() fetches members/?self=true — must return SCHEDULER (role 2)
  // so ViewTabs shows the Team tab. Without this mock, the request hits ECONNREFUSED
  // in CI (no backend) and the hook returns null, pessimistically hiding the tab.
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-sched', role: 200 }]) }),
  );

  await page.goto(`/projects/${PROJECT_ID}/resources/roster`);
  // Gate on the roster sub-nav rendering (the resources view has mounted and its
  // reads resolved) rather than `networkidle`, which never settles cleanly while
  // the app-wide hooks poll and the WebSocket handshake runs.
  await expect(page.getByRole('link', { name: 'Roster' })).toBeVisible({ timeout: 10_000 });
}

test('Team tab is present in ViewTabs and labelled "Team"', async ({ page }) => {
  await seedAuthAndNavigate(page);
  // Scope to the TopBar's view nav: the left-rail "This project" tier (issue 1642)
  // now also renders a "Team" row, so an unscoped locator is strict-mode ambiguous.
  await expect(
    page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Team' }),
  ).toBeVisible();
});

test('Roster sub-nav shows Roster and Allocation tabs', async ({ page }) => {
  await seedAuthAndNavigate(page);
  await expect(page.getByRole('link', { name: 'Roster' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Allocation' })).toBeVisible();
});

test('Roster list renders rostered resources', async ({ page }) => {
  await seedAuthAndNavigate(page);
  await expect(page.getByText('Alice Nguyen')).toBeVisible();
  await expect(page.getByText('Frontend Engineer')).toBeVisible();
  await expect(page.getByText('100%')).toBeVisible();
});

test('Roster list shows skill chips', async ({ page }) => {
  await seedAuthAndNavigate(page);
  await expect(page.getByText('React')).toBeVisible();
  await expect(page.getByText('TypeScript')).toBeVisible();
});

test('Selecting a roster item shows the detail panel', async ({ page }) => {
  await seedAuthAndNavigate(page);
  await page.getByRole('option', { name: /Alice Nguyen/i }).click();
  await expect(page.getByRole('heading', { name: 'Alice Nguyen' })).toBeVisible();
  await expect(page.getByText('Lead Dev')).toBeVisible();
});

test('Detail panel shows full skill list', async ({ page }) => {
  await seedAuthAndNavigate(page);
  await page.getByRole('option', { name: /Alice Nguyen/i }).click();
  // SkillChips have title="Name — Proficiency"; use title to avoid strict-mode
  // collision with any plain-text "React" label elsewhere in the panel.
  await expect(page.getByTitle('React — Expert')).toBeVisible();
  await expect(page.getByTitle('TypeScript — Intermediate')).toBeVisible();
});

test('Add to project opens combobox with candidates', async ({ page }) => {
  await seedAuthAndNavigate(page);
  await page.getByRole('button', { name: 'Add to project' }).click();
  await expect(page.getByRole('combobox', { name: 'Search by name…' })).toBeVisible();
  await expect(page.getByRole('option', { name: /Bob Carter/i })).toBeVisible();
});

test('Cascade delete dialog appears when server returns 409', async ({ page }) => {
  await seedAuthAndNavigate(page);

  // Override: first DELETE returns 409 with assignment count
  await page.route(`**/api/v1/project-resources/pr-1/`, (route) => {
    if (route.request().method() === 'DELETE') {
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Resource has task assignments.', cascaded_assignment_count: 3 }),
      });
    } else {
      route.continue();
    }
  });

  await page.getByRole('option', { name: /Alice Nguyen/i }).click();
  await page.getByRole('button', { name: 'Remove from project' }).click();

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText(/3 task assignments/)).toBeVisible();
});

test('Cancel in cascade delete dialog dismisses it', async ({ page }) => {
  await seedAuthAndNavigate(page);

  await page.route(`**/api/v1/project-resources/pr-1/`, (route) => {
    if (route.request().method() === 'DELETE') {
      route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'Resource has task assignments.', cascaded_assignment_count: 2 }) });
    } else {
      route.continue();
    }
  });

  await page.getByRole('option', { name: /Alice Nguyen/i }).click();
  await page.getByRole('button', { name: 'Remove from project' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('Filter input narrows the roster list', async ({ page }) => {
  await seedAuthAndNavigate(page);
  await page.getByLabel('Filter team members').fill('bob');
  await expect(page.getByText('Alice Nguyen')).toBeHidden();
  await expect(page.getByText('No matching team members')).toBeVisible();
});
