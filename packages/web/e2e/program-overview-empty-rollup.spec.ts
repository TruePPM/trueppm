import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * #4506 — Program Overview with no KPIs enabled shows the facts the page already
 * holds (program health, project count) above the configure link, and carries no
 * Enterprise upsell. Every endpoint the page reads is mocked with its real shape.
 */

const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000004506';

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Atlas Launch',
  description: '',
  code: 'ATL',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  created_by: 'user-alice',
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 3,
  member_count: 3,
};

async function setup(page: import('@playwright/test').Page, kpis: Record<string, unknown>) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  const pj = (data: unknown) => JSON.stringify(data);
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ id: 'user-alice', username: 'alice', display_name: 'Alice', initials: 'AL', email: 'alice@example.com' }),
    }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        aggregation_policy: 'worst',
        policy_available: true,
        project_count: 3,
        program_health: 'at_risk',
        kpis,
      }),
    }),
  );
  await page.goto(`/programs/${PROGRAM_ID}`);
}

test.describe('Program Overview rollup empty state (#4506)', () => {
  test('no KPIs enabled: shows health and project count, one configure link, no Enterprise pitch', async ({ page }) => {
    await setup(page, {});
    const status = page.getByRole('status');
    await expect(status.getByText('Program health')).toBeVisible();
    await expect(status.getByText('At risk')).toBeVisible();
    await expect(status.getByText('Projects')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Configure rollup' })).toHaveCount(1);
    await expect(page.getByText(/Enterprise/)).toHaveCount(0);
  });

  test('KPIs enabled: renders the KPI strip and no Enterprise pitch', async ({ page }) => {
    await setup(page, { critical_tasks: { available: true, value: 4 } });
    await expect(page.getByRole('region', { name: 'Program KPIs' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Configure rollup' })).toBeVisible();
    await expect(page.getByText(/Enterprise/)).toHaveCount(0);
  });
});
