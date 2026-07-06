import { test, expect, type Page } from '@playwright/test';

/**
 * Program visual identity & wayfinding (#963).
 *
 * The per-program accent color renders as a rounded identity SQUARE on the
 * sidebar wayfinding surfaces. The square is decorative (aria-hidden) — the
 * program NAME is always the accessible signal — and an accent-set program
 * fills the square with its color in both the grouped list header and the
 * scope-picker option row.
 */

function seedAuth(page: Page) {
  return page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({ state: { accessToken: 'e2e-token', isAuthenticated: true }, version: 0 }),
    );
  });
}

// Cloud Migration has an accent (#7C3AED → rgb(124, 58, 237)); Mobile Platform
// leaves it unset (neutral square).
const ACCENT = 'rgb(124, 58, 237)';
const PROGRAMS = [
  { id: 'pg-a', name: 'Cloud Migration', code: 'CLD', color: '#7C3AED' },
  { id: 'pg-b', name: 'Mobile Platform', code: '', color: null },
];

const PROJECTS = [
  {
    id: '1',
    name: 'Phoenix Rollout',
    program: 'pg-a',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
  {
    id: '2',
    name: 'Quartz Rollout',
    program: 'pg-b',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

function paginated<T>(results: T[]) {
  return JSON.stringify({ count: results.length, next: null, previous: null, results });
}

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
  // Keep the session live so the SessionExpiredBanner overlay never intercepts
  // clicks (in-memory access token since #897).
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        email: 'e2e@trueppm.local',
        username: 'e2e',
        first_name: 'E2E',
        last_name: 'User',
        is_active: true,
      }),
    }),
  );
  await page.route('**/api/v1/auth/token/refresh/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access: 'e2e-token-refreshed' }),
    }),
  );
  await page.route('**/api/v1/projects/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: paginated(PROJECTS) }),
  );
  await page.route('**/api/v1/programs/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: paginated(PROGRAMS) }),
  );
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [],
        next: null,
        previous: null,
        due_today_count: 0,
        active_sprints: [],
        server_version_high_water: 0,
        retro_action_items: [],
      }),
    }),
  );
});

function sidebar(page: Page) {
  return page.locator('aside[aria-label="Primary navigation"]');
}

test('the v2 rail program row shows the accent identity square; the name is the accessible signal', async ({
  page,
}) => {
  await page.goto('/me/work');
  const sb = sidebar(page);
  // The Programs tree relocated into the Tier-3 Browse switcher (#1642) — open it.
  await sb.getByRole('button', { name: 'Browse projects and programs' }).click();
  // The program NAME is the row's open-button accessible name — the square is decorative.
  const nameBtn = sb.getByRole('button', { name: 'Cloud Migration', exact: true });
  await expect(nameBtn).toBeVisible();
  // The identity square (rule 158) is the direct-child aria-hidden span of the row,
  // filled with the program accent. (The v2 rail is a cross-program list, so each
  // program row carries the square; the scope picker it replaced is gone.)
  const row = nameBtn.locator('xpath=..');
  const square = row.locator('span[aria-hidden="true"]').first();
  await expect(square).toHaveCSS('background-color', ACCENT);
});

test('an unset-color program row labels its identity tile with name initials (issue 1051)', async ({
  page,
}) => {
  await page.goto('/me/work');
  const sb = sidebar(page);
  // The Programs tree relocated into the Tier-3 Browse switcher (#1642) — open it.
  await sb.getByRole('button', { name: 'Browse projects and programs' }).click();
  // Mobile Platform has no accent — its tile is the faint neutral square. Without
  // the initials, every uncolored program in this dense list would look identical;
  // the xs-label variant labels it "MP" so it stays distinguishable.
  const nameBtn = sb.getByRole('button', { name: 'Mobile Platform', exact: true });
  await expect(nameBtn).toBeVisible();
  const row = nameBtn.locator('xpath=..');
  const square = row.locator('span[aria-hidden="true"]').first();
  await expect(square).toHaveText('MP');
});
