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

test('status bar shows task count from fixture', async ({ page }) => {
  await page.goto('/');
  // useShellStats is still a stub returning 42 tasks (endpoint not yet implemented)
  const footer = page.getByRole('contentinfo', { name: 'Project status' });
  await expect(footer).toBeVisible();
  await expect(footer.getByText('42 tasks')).toBeVisible();
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
