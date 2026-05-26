import { test, expect } from '@playwright/test';

/**
 * Smoke tests — verify the app shell loads and key structural elements are present.
 * These run against the production build (vite preview) with fixture data.
 *
 * Since the app now requires authentication, we seed the zustand-persist auth
 * key in localStorage via addInitScript before every navigation. The projects API
 * is intercepted with fixture data because useProjects calls the real API.
 */

/** Seed auth state so RequireAuth lets the test through. */
function seedAuth(page: import('@playwright/test').Page) {
  return page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
}

/** Minimal API-format projects matching what useProjects expects. */
const FIXTURE_API_PROJECTS = [
  { id: '1', name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default' },
  { id: '2', name: 'Beta Data Migration',    description: '', start_date: '2026-02-01', calendar: 'default' },
];

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
  await page.route('**/api/v1/projects/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE_API_PROJECTS) }),
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
});

test('page title is TruePPM', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('TruePPM');
});

test('top bar renders with logo and nav', async ({ page }) => {
  await page.goto('/');
  // TopBar is the page header landmark
  const header = page.getByRole('banner');
  await expect(header).toBeVisible();
  // Sidebar open/collapsed toggle is present (desktop — hamburger is md:hidden)
  await expect(page.getByRole('navigation', { name: 'Project list' })).toBeVisible();
});

test('sidebar shows PROJECTS section header', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'PROJECTS' })).toBeVisible();
});

test('status bar shows build hash and omits the connection pill off-project', async ({ page }) => {
  await page.goto('/');
  // StatusBar (#201) shows the build hash on every view. The connection pill
  // (#643) is gated on projectId — off a project there is no live channel, so
  // the pill is omitted rather than showing a misleading "Live · 0 online".
  const footer = page.getByRole('contentinfo', { name: 'Application status' });
  await expect(footer).toBeVisible();
  await expect(footer.getByText(/build /)).toBeVisible();
  await expect(
    footer.getByText(/Live|Connecting|Reconnecting|Connection lost|Disconnected/),
  ).toHaveCount(0);
});

test('no console errors on load', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto('/');
  // Allow React DevTools message but no real errors
  const realErrors = errors.filter(
    (e) => !e.includes('Download the React DevTools'),
  );
  expect(realErrors).toHaveLength(0);
});
