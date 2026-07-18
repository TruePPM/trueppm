/**
 * Per-project leaf-surface visibility settings (ADR-0193, issue 956).
 *
 * Each project can independently hide four optional surfaces — Reports,
 * Time tracking, Baselines, Monte-Carlo forecast — from the project's
 * methodology default, or override it. The toggles are InheritableToggleField
 * controls (Inherit / Override + on/off switch). Writes are Admin-only; Members
 * and below see a read-only indicator. All API calls are intercepted.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

const pj = (data: unknown) => JSON.stringify(data);
const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: pj(body),
});

const PROJECT_ID = 'e2e-surf-00000000-0000-0000-0000-000000000956';

function projectDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    server_version: 1,
    name: 'Surface Visibility Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: null,
    estimation_mode: 'open',
    agile_features: true,
    iteration_label: 'Sprint',
    methodology: 'WATERFALL',
    effective_methodology: 'WATERFALL',
    inherited_methodology: 'WATERFALL',
    // Leaf-surface visibility — null = inherit (ADR-0193, #956)
    show_reporting: null,
    show_time_tracking: null,
    show_baselines: null,
    show_monte_carlo: null,
    effective_surface_visibility: {
      reporting: true,
      time_tracking: true,
      baselines: true,
      monte_carlo: true,
    },
    inherited_surface_visibility: {
      reporting: true,
      time_tracking: true,
      baselines: true,
      monte_carlo: true,
    },
    ...overrides,
  };
}

async function baseSetup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Catch-all 401-guard — keeps unmocked object endpoints from crashing the app.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(
      json({
        id: 'u1',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'alice@example.com',
      }),
    ),
  );
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/workspace/', (r) =>
    r.fulfill(
      json({
        name: 'TruePPM E2E',
        subdomain: 'trueppm',
        timezone: 'UTC',
        fiscal_year_start_month: 1,
        fiscal_year_start_day: 1,
        fiscal_year_start_display: 'January 1',
        work_week: [true, true, true, true, true, false, false],
        default_project_view: 'Overview',
        allow_guests: false,
        public_sharing: false,
        iteration_label: 'Sprint',
        iteration_label_override_policy: 'suggest',
        mc_history_enabled: true,
        mc_history_retention_cap: 100,
        mc_history_attribution_audience: 'ADMIN_OWNER',
        mc_history_override_policy: 'suggest',
        methodology: 'WATERFALL',
        methodology_override_policy: 'suggest',
      }),
    ),
  );
}

async function projectRoutes(page: Page, { role = 300 } = {}) {
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill(json([{ id: 'mem-1', role }])),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) => r.fulfill(json([])));
}

// ---------------------------------------------------------------------------
// Golden path
// ---------------------------------------------------------------------------

test.describe('Project surface visibility settings', () => {
  test('golden path — Admin overrides Reports to hidden and saves', async ({ page }) => {
    await baseSetup(page);
    await projectRoutes(page, { role: 300 }); // Admin

    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        r.fulfill(
          json(
            projectDetail({
              show_reporting: false,
              effective_surface_visibility: {
                reporting: false,
                time_tracking: true,
                baselines: true,
                monte_carlo: true,
              },
            }),
          ),
        );
        return;
      }
      r.fulfill(json(projectDetail()));
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/surfaces`);

    // Page title is visible once the section loads. Target the heading by role —
    // the test project's name ("Surface Visibility Test Project") also contains the
    // phrase, so a bare getByText hits a strict-mode collision.
    await expect(page.getByRole('heading', { name: 'Surface visibility', exact: true })).toBeVisible();

    // All four toggle labels are present. Scope to the settings content — the
    // project view rail also renders a "Reports" nav row, so an unscoped
    // getByText collides in strict mode. Exact match — each label word also
    // appears inside its own hint copy (e.g. "…hides the Reports tab…"), so a
    // substring getByText would collide with the hint too.
    const surfacesPanel = page.getByTestId('settings-content-scroll');
    await expect(surfacesPanel.getByText('Reports', { exact: true })).toBeVisible();
    await expect(surfacesPanel.getByText('Time tracking', { exact: true })).toBeVisible();
    await expect(surfacesPanel.getByText('Baselines', { exact: true })).toBeVisible();
    await expect(surfacesPanel.getByText('Monte-Carlo forecast', { exact: true })).toBeVisible();

    // Reports group starts on Inherit (methodology default = Shown).
    const reportsGroup = page.getByRole('radiogroup', { name: /Show the Reports surface/i });
    await expect(reportsGroup.getByRole('radio', { name: /Inherit/i })).toBeChecked();

    // Switch to Override (seeds the switch to the inherited value = Shown).
    await reportsGroup.getByText('Override').click();
    // Override reveals the on/off switch (role="switch", named by the surface's
    // aria-label); click it to flip Shown → Hidden.
    await page.getByRole('switch', { name: /Show the Reports surface/i }).click();

    // Save bar appears; click save.
    await page.getByRole('button', { name: /Save changes/i }).click();

    // PATCH was called with show_reporting: false.
    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody).toMatchObject({ show_reporting: false });
  });

  test('Member role sees read-only indicators — no radios', async ({ page }) => {
    await baseSetup(page);
    await projectRoutes(page, { role: 200 }); // Member
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => r.fulfill(json(projectDetail())));

    await page.goto(`/projects/${PROJECT_ID}/settings/surfaces`);

    await expect(page.getByRole('heading', { name: 'Surface visibility', exact: true })).toBeVisible();

    // No editable radiogroups — canEdit is false for Member.
    await expect(page.getByRole('radiogroup', { name: /Show the Reports surface/i })).not.toBeVisible();

    // Read-only indicator is present (aria-label pattern from InheritableToggleField read-only branch).
    await expect(
      page.getByLabel(/Show the Reports surface: On, inherited from the methodology default/i),
    ).toBeVisible();
  });
});
