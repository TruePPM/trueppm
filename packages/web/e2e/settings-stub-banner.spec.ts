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
 *   1. No settings page renders the stub banner: every one is either API-wired
 *      or an intentional read-only reference. Workspace Roles & permissions —
 *      the last genuine stub — became a read-only reference in #1649 (the
 *      five-role model is fixed in OSS; editing roles is Enterprise, so there is
 *      no OSS write path to wire and a "changes won't be saved" banner would
 *      have promised wiring that never lands).
 *   2. Wired / reference pages (Project General, Project Access, Methodology,
 *      Workspace Roles) carry no banner of their own.
 *
 * Note: as of the methodology cascade (issue 955 / 1169) the Methodology pages
 * are API-wired, and as of #1649 Roles is a read-only reference — so there is no
 * live stub page left to anchor a positive banner assertion. The StubPageBanner
 * component's own render + per-issue dismissal/persistence contract (#592) is
 * covered at the unit level in StubPageBanner.test.tsx.
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
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(FIXTURE_WORKSPACE_SETTINGS),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
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
  test('Workspace Roles is a read-only reference, not a stub (no banner) (#1649)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/settings/roles');

    const roles = page.locator('[data-settings-section="roles"]');
    await expect(roles.getByRole('heading', { name: 'Roles & permissions' })).toBeVisible();
    // The last genuine stub is gone: no preview banner, no "won't be saved" copy.
    await expect(roles.getByTestId('stub-page-banner')).toHaveCount(0);
    await expect(roles.getByText(/your changes will not be saved yet/i)).toHaveCount(0);
    // It reads as an intentional read-only reference instead.
    await expect(roles.getByText(/read-only reference/i)).toBeVisible();
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
    await expect(
      methodology.getByRole('heading', { name: 'Methodology', exact: true }),
    ).toBeVisible();
    await expect(methodology.getByTestId('stub-page-banner')).toBeHidden();
  });

  test('is absent on Workspace Methodology (now API-wired by the cascade)', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/methodology');
    const methodology = page.locator('[data-settings-section="methodology"]');
    await expect(methodology.getByRole('heading', { name: 'Methodology defaults' })).toBeVisible();
    await expect(methodology.getByTestId('stub-page-banner')).toBeHidden();
  });

  // The banner's dismissal persistence (#592) — dismiss → survives remount / new
  // tab, reappears when the per-issue flag is cleared — was previously exercised
  // here against the Roles stub. Roles became a read-only reference in #1649, so
  // there is no live stub page left to drive it end-to-end; that contract now
  // lives entirely in StubPageBanner.test.tsx (unit), which mounts the component
  // directly and asserts the localStorage keying.
});
