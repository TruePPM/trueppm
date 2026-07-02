import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * "Preview — not yet saved" banner E2E (#538).
 *
 * Verifies the cross-cutting honesty signal that distinguishes stubbed
 * settings pages from API-wired ones. Filed from VoC audit on !302 — Marcus
 * (PMO Director) had no honest answer when an external compliance officer
 * asked whether a stubbed members list was the real one.
 *
 * Contract:
 *   1. Banner is present on a stubbed page (Workspace Roles & permissions,
 *      whose RBAC-matrix write path is still tracked in #510).
 *   2. Banner is absent on a wired page (Project General name+description,
 *      Project Access, and the now-wired Methodology pages).
 *   3. Issue link points to the page's wiring issue.
 *   4. Dismissing the banner persists across in-app navigation and across
 *      browser sessions (`localStorage`, #592), and reappears only when site
 *      data is cleared (or the page's `pageIssue` changes — a new stub).
 *
 * Note: as of the methodology cascade landing (issue 955 / issue 1169) the
 * Workspace and Project Methodology pages are API-wired and no longer render a
 * stub banner. Workspace Roles & permissions is the remaining genuine stub, so
 * the banner assertions are anchored there.
 */

const PROJECT_ID = 'e2e-settings-banner-00000000-0000-0000-0000-000000000538';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Atlas Migration',
  description: 'Original description.',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
  agile_features: false,
  methodology: 'HYBRID',
  effective_methodology: 'HYBRID',
  inherited_methodology: 'HYBRID',
};

const FIXTURE_ME = {
  id: 'u-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_WORKSPACE_SETTINGS = {
  name: 'Acme',
  methodology: 'HYBRID',
  methodologyOverridePolicy: 'suggest',
};

type Page = import('@playwright/test').Page;

async function setup(page: Page) {
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

  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/workspace/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_WORKSPACE_SETTINGS) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0,
      }),
    }),
  );
  // Overview reads res.data.items / res.data.tasks (object-shaped, not lists) —
  // useProjectAttention/useMyTasks in ProjectOverviewPage.tsx. A bare `[]` left
  // both undefined; the real shapes keep the Overview transit clean.
  await page.route('**/api/v1/projects/*/attention/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ items: [] }) }),
  );
  await page.route('**/api/v1/projects/*/my-tasks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ tasks: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/me/notifications/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/me/notification-preferences/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
}

test.describe('Settings stub banner (#538)', () => {
  test('renders on a stubbed page (Workspace Roles) with the page issue link', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/roles');

    const banner = page.getByTestId('stub-page-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/preview/i);
    await expect(banner).toContainText(/your changes will not be saved yet/i);

    const link = banner.getByRole('link', { name: '#510' });
    await expect(link).toHaveAttribute('href', 'https://gitlab.com/trueppm/trueppm/-/issues/510');
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('is absent on Project General (name + description are API-wired)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    // Wait for the wired field to settle so we know the page has mounted.
    await expect(page.getByRole('textbox', { name: /project name/i })).toBeVisible();
    // The consolidated page (#1248) mounts every section at once, and stub
    // sections (e.g. Methodology) render their own banner. Scope to the General
    // section: a wired page must carry no banner of its own.
    const general = page.locator('[data-settings-section="general"]');
    await expect(general.getByTestId('stub-page-banner')).toBeHidden();
  });

  test('is absent on Project Access (wraps live MembersTab)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/access`);
    const access = page.locator('[data-settings-section="access"]');
    await expect(access.getByRole('heading', { name: 'Access' })).toBeVisible();
    await expect(access.getByTestId('stub-page-banner')).toBeHidden();
  });

  test('is absent on Project Methodology (now API-wired by the cascade)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);
    // Methodology is now an API-wired cascade form, not a stub. The consolidated
    // page (#1248) mounts every section at once, so scope the banner assertion to
    // the methodology section.
    const methodology = page.locator('[data-settings-section="methodology"]');
    await expect(methodology.getByRole('heading', { name: 'Methodology', exact: true })).toBeVisible();
    await expect(methodology.getByTestId('stub-page-banner')).toBeHidden();
  });

  test('is absent on Workspace Methodology (now API-wired by the cascade)', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/methodology');
    // The workspace page still mounts a stub section (Roles), whose banner is
    // visible — so scope the absence assertion to the methodology section.
    const methodology = page.locator('[data-settings-section="methodology"]');
    await expect(methodology.getByRole('heading', { name: 'Methodology defaults' })).toBeVisible();
    await expect(methodology.getByTestId('stub-page-banner')).toBeHidden();
  });

  test('dismissal persists across in-app navigation back to the same page', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/roles');
    // Roles is the workspace stub section; scope to it.
    const roles = page.locator('[data-settings-section="roles"]');
    await roles.getByRole('button', { name: /dismiss preview banner/i }).click();
    await expect(roles.getByTestId('stub-page-banner')).toBeHidden();

    // Dismissal is persisted in localStorage (#592), so it survives a full
    // departure from the settings page and a return. Sections are anchors on one
    // page rather than separate routes, so leave settings entirely (project root)
    // and navigate back.
    await page.goto(`/projects/${PROJECT_ID}`);
    await page.goto('/settings/roles');
    await expect(page.locator('[data-settings-section="roles"]').getByTestId('stub-page-banner')).toBeHidden();
  });

  test('reappears after the per-issue dismissal flag is cleared (fresh site data)', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/roles');
    await page.getByRole('button', { name: /dismiss preview banner/i }).click();
    await expect(page.getByTestId('stub-page-banner')).toBeHidden();

    // Simulate a cleared-site-data / new-stub scenario: the per-issue flag is
    // the single source of truth for dismissal, so removing it re-shows it.
    await page.evaluate(() =>
      localStorage.removeItem('trueppm.settings.stub-banner-dismissed.510'),
    );
    await page.reload();
    await expect(page.getByTestId('stub-page-banner')).toBeVisible();
  });
});
