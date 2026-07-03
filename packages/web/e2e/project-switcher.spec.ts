import { test, expect, type Page } from '@playwright/test';
import { setupApiMocks, setupCatchAll, type ProjectFixture } from './fixtures';

/**
 * In-chrome project switcher E2E (#1478).
 *
 * The switcher sits at the left edge of the view-tab bar and lets a member jump
 * between their projects without leaving the project chrome (no round-trip out to
 * a listing/portfolio view). This spec covers:
 *   - golden path: open the switcher on project A → search → select project B →
 *     land on B's equivalent view with the chrome intact (never a listing route).
 *   - edge: a member of a single project sees no switcher (nothing to switch to).
 *
 * Every project-scoped endpoint the Overview page reads is mocked with its real
 * shape for BOTH project ids (via `*` wildcards), so switching to B doesn't crash
 * the page on an unmocked object endpoint (#1190 lesson).
 */

const PROJECT_A = 'e2e-switch-00000000-0000-0000-0000-0000000000a1';
const PROJECT_B = 'e2e-switch-00000000-0000-0000-0000-0000000000b2';

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

  // Project detail — resolve the requested id from the URL so the breadcrumb and
  // switcher trigger show the correct project after a switch.
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

test.describe('In-chrome project switcher (#1478)', () => {
  test('golden path — switch from one member project to another without leaving the chrome', async ({
    page,
  }) => {
    await setupBothProjects(page, TWO_PROJECTS);
    await page.goto(`/projects/${PROJECT_A}/overview`);

    // Page-rendered signal: the view-tab bar (chrome) plus the switcher trigger
    // for the current project.
    const viewNav = page.getByRole('navigation', { name: 'View' });
    await expect(viewNav).toBeVisible({ timeout: 10_000 });
    const trigger = page.getByRole('button', {
      name: 'Current project: Apollo Rebuild. Switch project.',
    });
    await expect(trigger).toBeVisible();

    // Open the switcher and confirm it lists both member projects.
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

    // The chrome is intact (never bounced out to a listing/portfolio route) and the
    // switcher now reflects the new current project.
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Current project: Borealis Pipeline. Switch project.' }),
    ).toBeVisible();
  });

  test('edge — a member of a single project sees no switcher', async ({ page }) => {
    await setupBothProjects(page, [projectFixture(PROJECT_A, 'Apollo Rebuild')]);
    await page.goto(`/projects/${PROJECT_A}/overview`);

    // Chrome renders, but with nothing to switch to the switcher is absent.
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Switch project/ })).toHaveCount(0);
  });
});
