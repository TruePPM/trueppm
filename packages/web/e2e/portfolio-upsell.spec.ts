import { test, expect, type Page } from '@playwright/test';

/**
 * Entitlement-aware Portfolio rollup gating (#1173, web rule 177).
 *
 * Under the community edition the cross-program Portfolio rollup is gated as
 * Enterprise — but instead of being hidden (reads as broken OSS) the Sidebar
 * shows an EE-badged row that routes to a designed in-app upsell page with the
 * external "Explore TruePPM Enterprise" CTA. Under the enterprise edition the
 * upsell route redirects to the real (slot-registered) /portfolio view.
 *
 * Mirrors the #541 roles-matrix upsell spec. All API calls are route-mocked.
 */

const pj = (data: unknown) => JSON.stringify(data);

async function setup(page: Page, edition: 'community' | 'enterprise') {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  // Catch-all first (Playwright matches last-registered first); specific routes win.
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        id: 'u1',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'a@x.io',
        landing: { intent: 'my_work', path: '/me/work', resolved_by: 'fallback' },
      }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition }) }),
  );
}

test.describe('Portfolio rollup upsell (#1173)', () => {
  test('community: sidebar EE row routes to the designed upsell with the external CTA', async ({ page }) => {
    await setup(page, 'community');
    await page.goto('/programs');

    // The cross-program Portfolio rollup is no longer hidden — it is an EE-gated
    // nav row whose composite accessible name states the gate (rule 177).
    const row = page.getByRole('link', {
      name: 'Portfolio rollup — available in TruePPM Enterprise',
    });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('href', '/portfolio-upsell');

    await row.click();

    // The designed upsell surface — not a 404, not a dead control.
    await expect(page.getByRole('heading', { level: 1, name: /Portfolio rollup/i })).toBeVisible();
    await expect(page.getByText(/Portfolio dashboard & health rollups/i)).toBeVisible();

    const cta = page.getByRole('link', { name: /Explore TruePPM Enterprise \(opens in a new tab\)/i });
    await expect(cta).toHaveAttribute('href', 'https://trueppm.com/enterprise');
    await expect(cta).toHaveAttribute('target', '_blank');
  });

  test('enterprise: the upsell route redirects away to the real /portfolio', async ({ page }) => {
    await setup(page, 'enterprise');
    await page.goto('/portfolio-upsell');

    // The upsell body never renders for an enterprise user — the guard redirects
    // to the real (slot-registered) /portfolio route.
    await expect(page).toHaveURL(/\/portfolio$/);
    await expect(page.getByRole('heading', { level: 1, name: /Portfolio rollup/i })).toHaveCount(0);
  });
});
