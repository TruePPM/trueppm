import { test, expect } from '@playwright/test';

/**
 * "Preview — not yet saved" banner E2E (#538).
 *
 * Verifies the cross-cutting honesty signal that distinguishes stubbed
 * settings pages from API-wired ones. Filed from VoC audit on !302 — Marcus
 * (PMO Director) had no honest answer when an external compliance officer
 * asked whether a stubbed members list was the real one.
 *
 * Contract:
 *   1. Banner is present on a stubbed page (Methodology).
 *   2. Banner is absent on a wired page (Access / General name+description).
 *   3. Issue link points to the page's 0.2 wiring issue.
 *   4. Dismissing the banner persists across in-app navigation and across
 *      browser sessions (`localStorage`, #592) — only reappears when site
 *      data is cleared or the page's `pageIssue` changes (a new stub).
 */

const PROJECT_ID = 'e2e-settings-banner-00000000-0000-0000-0000-000000000538';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Atlas Migration',
  description: 'Original description.',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'hours',
  agile_features: false,
  methodology: 'HYBRID',
};

const FIXTURE_ME = {
  id: 'u-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
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

  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
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
  await page.route('**/api/v1/projects/*/attention/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/my-tasks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
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
  test('renders on a stubbed page (Methodology) with the page issue link', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    const banner = page.getByTestId('stub-page-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/preview/i);
    await expect(banner).toContainText(/your changes will not be saved yet/i);

    const link = banner.getByRole('link', { name: '#511' });
    await expect(link).toHaveAttribute('href', 'https://gitlab.com/trueppm/trueppm/-/issues/511');
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('is absent on Project General (name + description are API-wired)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    // Wait for the wired field to settle so we know the page has mounted.
    await expect(page.getByRole('textbox', { name: /project name/i })).toBeVisible();
    await expect(page.getByTestId('stub-page-banner')).toBeHidden();
  });

  test('is absent on Project Access (wraps live MembersTab)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/access`);
    await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();
    await expect(page.getByTestId('stub-page-banner')).toBeHidden();
  });

  test('per-issue dismissal: navigating to another stub keeps the new banner visible', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);
    await page.getByRole('button', { name: /dismiss preview banner/i }).click();
    await expect(page.getByTestId('stub-page-banner')).toBeHidden();

    // Lifecycle is a separate stub page with a different issue ref — its
    // banner must remain visible because dismissal is keyed per pageIssue.
    await page.getByRole('link', { name: 'Lifecycle' }).click();
    await expect(page.getByTestId('stub-page-banner')).toBeVisible();
  });

  test('dismissal persists across in-app navigation back to the same page', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);
    await page.getByRole('button', { name: /dismiss preview banner/i }).click();
    await expect(page.getByTestId('stub-page-banner')).toBeHidden();

    await page.getByRole('link', { name: 'Lifecycle' }).click();
    await page.getByRole('link', { name: 'Methodology' }).click();
    await expect(page.getByTestId('stub-page-banner')).toBeHidden();
  });
});
