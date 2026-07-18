import { test, expect, type Page } from './fixtures/coverage';
import { setupApiMocks, setupCatchAll, type ProjectFixture } from './fixtures';

/**
 * Top-bar location switcher E2E (#1643, ADR-0203).
 *
 * The switcher (`Program › Project › Leaf`) replaces the former breadcrumb + in-
 * chrome ProjectSwitcher. Its project segment lets a member jump between projects
 * without leaving the chrome; the leaf is a plain "you are here" label, never a
 * dropdown (the left rail owns view switching). This spec covers:
 *   - golden path: open the project picker on A → search → select B → land on B's
 *     equivalent view with the chrome intact (never a listing route);
 *   - the leaf is not an interactive control;
 *   - edge: a member of a single project sees no project picker (nothing to switch).
 *
 * Every project-scoped endpoint the Overview page reads is mocked with its real
 * shape for BOTH project ids (via `*` wildcards), so switching to B doesn't crash
 * the page on an unmocked object endpoint (#1190 lesson).
 */

const PROJECT_A = 'e2e-loc-000000000-0000-0000-0000-0000000000a1';
const PROJECT_B = 'e2e-loc-000000000-0000-0000-0000-0000000000b2';

function projectFixture(id: string, name: string): ProjectFixture {
  return {
    id,
    name,
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    effective_methodology: 'HYBRID',
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: [],
  };
}

const TWO_PROJECTS: ProjectFixture[] = [
  projectFixture(PROJECT_A, 'Apollo Rebuild'),
  projectFixture(PROJECT_B, 'Borealis Pipeline'),
];

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * Register wildcard object-endpoint mocks so BOTH project ids resolve — the
 * built-in `setupApiMocks` keys detail/overview/status-summary to a single id.
 * Registered AFTER setupApiMocks so they win (last-registered wins).
 */
async function setupBothProjects(page: Page, projects: ProjectFixture[]) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await setupCatchAll(page);
  await setupApiMocks(page, { projects, projectId: projects[0].id });

  // Project detail — resolve the requested id from the URL so the switcher trigger
  // shows the correct project after a switch.
  await page.route('**/api/v1/projects/*/', (route) => {
    const m = /\/projects\/([^/]+)\/$/.exec(new URL(route.request().url()).pathname);
    const id = m?.[1];
    const project = projects.find((p) => p.id === id) ?? projects[0];
    return route.fulfill(json(project));
  });
  await page.route('**/api/v1/projects/*/overview/', (route) =>
    route.fulfill(
      json({
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
    ),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill(
      json({
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
    ),
  );
  await page.route('**/api/v1/projects/*/blocked/', (route) =>
    route.fulfill(json({ project_id: PROJECT_A, count: 0, blocked: [] })),
  );
  await page.route('**/api/v1/projects/*/members/**', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('self') === 'true') {
      return route.fulfill(json([{ id: 'mem-admin', role: 300, user_id: 'e2e-user' }]));
    }
    return route.fulfill(json([{ id: 'mem-admin', role: 300 }]));
  });
}

test.describe('Top-bar location switcher (#1643)', () => {
  test('golden path — switch from one member project to another without leaving the chrome', async ({
    page,
  }) => {
    await setupBothProjects(page, TWO_PROJECTS);
    await page.goto(`/projects/${PROJECT_A}/overview`);

    // Page-rendered signal: the rail's view nav (chrome) plus the project picker
    // trigger for the current project.
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    const trigger = page.getByRole('button', {
      name: 'Current project: Apollo Rebuild. Switch project.',
    });
    await expect(trigger).toBeVisible();

    // The leaf is a plain aria-current label, never an interactive control.
    const location = page.getByRole('navigation', { name: 'Location' });
    await expect(location.getByText('Overview')).toHaveAttribute('aria-current', 'page');
    await expect(location.getByRole('button', { name: 'Overview' })).toHaveCount(0);

    // Open the picker and confirm it lists both member projects.
    await trigger.click();
    const listbox = page.getByRole('listbox', { name: 'Switch project' });
    await expect(listbox.getByRole('option')).toHaveCount(2);

    // Search narrows to the target project.
    const search = page.getByRole('combobox', { name: 'Find a project' });
    await search.fill('borealis');
    await expect(listbox.getByRole('option')).toHaveCount(1);

    // Select it → navigate to the equivalent view on project B.
    await listbox.getByRole('option', { name: /Borealis Pipeline/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_B}/overview$`));

    // The chrome is intact and the switcher now reflects the new current project.
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Current project: Borealis Pipeline. Switch project.' }),
    ).toBeVisible();
  });

  test('edge — a member of a single project sees no project picker', async ({ page }) => {
    await setupBothProjects(page, [projectFixture(PROJECT_A, 'Apollo Rebuild')]);
    await page.goto(`/projects/${PROJECT_A}/overview`);

    // Chrome renders, but with nothing to switch to the picker is absent (the name
    // still shows as static wayfinding).
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Switch project/ })).toHaveCount(0);
  });
});
