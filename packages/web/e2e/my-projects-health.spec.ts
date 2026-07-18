import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * E2E for the "my projects" health summary on My Work (ADR-0401/#1941).
 *
 * Verifies the golden path (band tallies + drill-to-worst chip), the all-on-track
 * calm state, and that the card self-hides with fewer than 2 projects. All API
 * calls are route-mocked; no server required.
 */

const PROJECT_ID = 'e2e-health-00000000-0000-0000-0000-000000001941';
const WORST_ID = 'e2e-health-worst-0000-0000-0000-000000001941';

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  name: 'Design App',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'HYBRID',
};

async function setupAuthenticatedPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        username: 'priya',
        display_name: 'Priya',
        initials: 'P',
        email: 'priya@example.com',
        max_project_role: 100,
        workspace_role: null,
        can_access_admin_settings: false,
        default_landing: 'my_work',
        landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }),
    }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
      }),
    }),
  );
}

/** Wait for My Work to render before asserting on the health card. */
async function waitForMyWork(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening), Priya\./ }),
  ).toBeVisible();
}

test.describe('My Work — my projects health summary (#1941)', () => {
  test('shows band tallies and drills to the worst project', async ({ page }) => {
    await setupCatchAll(page);
    await setupAuthenticatedPage(page);
    // Override the health-summary default (empty) with a populated set.
    await page.route('**/api/v1/projects/health-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: WORST_ID, name: 'Apollo Migration', health_band: 'critical', at_risk_count: 1, critical_count: 3 },
          { id: 'p2', name: 'Gemini Rollout', health_band: 'at_risk', at_risk_count: 2, critical_count: 0 },
          { id: 'p3', name: 'Mercury', health_band: 'on_track', at_risk_count: 0, critical_count: 0 },
        ]),
      }),
    );

    await page.goto('/me/work');
    await waitForMyWork(page);

    const summary = page.getByRole('region', { name: 'Project health summary' });
    await expect(summary).toBeVisible();
    await expect(summary.getByText('My projects')).toBeVisible();
    // Band tallies present (project counts by band).
    await expect(summary.getByText('critical', { exact: true })).toBeVisible();
    await expect(summary.getByText('at risk', { exact: true })).toBeVisible();
    await expect(summary.getByText('on track', { exact: true })).toBeVisible();

    // Drill-to-worst chip = the critical project, linking to its overview.
    const worst = summary.getByRole('link', { name: /Apollo Migration/ });
    await expect(worst).toBeVisible();
    await expect(worst).toHaveAttribute('href', `/projects/${WORST_ID}/overview`);
    await expect(summary.getByText('3 critical tasks')).toBeVisible();
  });

  test('shows a calm "All on track" state when nothing needs attention', async ({ page }) => {
    await setupCatchAll(page);
    await setupAuthenticatedPage(page);
    await page.route('**/api/v1/projects/health-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'p1', name: 'Apollo', health_band: 'on_track', at_risk_count: 0, critical_count: 0 },
          { id: 'p2', name: 'Gemini', health_band: 'on_track', at_risk_count: 0, critical_count: 0 },
        ]),
      }),
    );

    await page.goto('/me/work');
    await waitForMyWork(page);

    const summary = page.getByRole('region', { name: 'Project health summary' });
    await expect(summary.getByText('All on track')).toBeVisible();
    await expect(summary.getByRole('link')).toHaveCount(0);
  });

  test('self-hides with a single project (nothing to triage)', async ({ page }) => {
    await setupCatchAll(page);
    await setupAuthenticatedPage(page);
    await page.route('**/api/v1/projects/health-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'p1', name: 'Apollo', health_band: 'critical', at_risk_count: 0, critical_count: 2 },
        ]),
      }),
    );

    await page.goto('/me/work');
    await waitForMyWork(page);
    await expect(page.getByRole('region', { name: 'Project health summary' })).toHaveCount(0);
  });
});
