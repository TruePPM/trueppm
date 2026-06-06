import { test, expect, type Page } from '@playwright/test';

/**
 * Sidebar scope/grouping flow (#959, Direction C "at scale").
 *
 * Covers the program scope picker, the grouped "All programs" project list with
 * collapsible program headers, scoping to a single program (flat list), and the
 * in-scope project search.
 */

function seedAuth(page: Page) {
  return page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({ state: { accessToken: 'e2e-token', isAuthenticated: true }, version: 0 }),
    );
  });
}

const PROGRAMS = [
  { id: 'pg-a', name: 'Cloud Migration' },
  { id: 'pg-b', name: 'Mobile Platform' },
];

const PROJECTS = [
  { id: '1', name: 'Phoenix Rollout', program: 'pg-a', description: '', start_date: '2026-01-01', calendar: 'default' },
  { id: '2', name: 'Aspen Pilot', program: 'pg-a', description: '', start_date: '2026-01-01', calendar: 'default' },
  { id: '3', name: 'Quartz Rollout', program: 'pg-b', description: '', start_date: '2026-01-01', calendar: 'default' },
  { id: '4', name: 'Standalone Thing', program: null, description: '', start_date: '2026-01-01', calendar: 'default' },
];

function paginated<T>(results: T[]) {
  return JSON.stringify({ count: results.length, next: null, previous: null, results });
}

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
  // Keep the session live so the SessionExpiredBanner overlay never intercepts
  // clicks (the access token is in-memory since #897; without a refresh mock the
  // interceptor's 401→refresh→fail loop raises the overlay).
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
  return page.locator('aside[aria-label="Projects"]');
}

test('All programs scope groups projects under collapsible program headers', async ({ page }) => {
  await page.goto('/me/work');
  const sb = sidebar(page);
  await expect(sb).toBeVisible();
  // Scope defaults to "All programs".
  await expect(sb.getByRole('button', { name: /Program scope: All programs/i })).toBeVisible();
  // Group headers, including the orphan "No program" group.
  await expect(sb.getByRole('button', { name: /Cloud Migration/i })).toBeVisible();
  await expect(sb.getByRole('button', { name: /Mobile Platform/i })).toBeVisible();
  await expect(sb.getByRole('button', { name: /No program/i })).toBeVisible();
  // Projects render under their groups.
  await expect(sb.getByText('Phoenix Rollout')).toBeVisible();
  await expect(sb.getByText('Quartz Rollout')).toBeVisible();
  await expect(sb.getByText('Standalone Thing')).toBeVisible();
});

test('collapsing a program group hides its projects', async ({ page }) => {
  await page.goto('/me/work');
  const sb = sidebar(page);
  await expect(sb.getByText('Phoenix Rollout')).toBeVisible();
  await sb.getByRole('button', { name: /Cloud Migration/i }).click();
  await expect(sb.getByText('Phoenix Rollout')).toBeHidden();
  // A different group is unaffected.
  await expect(sb.getByText('Quartz Rollout')).toBeVisible();
});

test('scoping to one program flattens the list to that program', async ({ page }) => {
  await page.goto('/me/work');
  const sb = sidebar(page);
  await sb.getByRole('button', { name: /Program scope:/i }).click();
  await sb.getByRole('option', { name: /Cloud Migration/i }).click();
  // Picker reflects the scope; list is flat (no group header buttons).
  await expect(sb.getByRole('button', { name: /Program scope: Cloud Migration/i })).toBeVisible();
  await expect(sb.getByText('Phoenix Rollout')).toBeVisible();
  await expect(sb.getByText('Aspen Pilot')).toBeVisible();
  await expect(sb.getByText('Quartz Rollout')).toBeHidden();
  await expect(sb.getByRole('button', { name: /Mobile Platform/i })).toBeHidden();
});

test('the in-scope search narrows the project list', async ({ page }) => {
  await page.goto('/me/work');
  const sb = sidebar(page);
  await sb.getByRole('textbox', { name: /Search projects/i }).fill('aspen');
  await expect(sb.getByText('Aspen Pilot')).toBeVisible();
  await expect(sb.getByText('Phoenix Rollout')).toBeHidden();
  await expect(sb.getByText('Quartz Rollout')).toBeHidden();
});

test('the scope picker filters programs with its own search', async ({ page }) => {
  await page.goto('/me/work');
  const sb = sidebar(page);
  await sb.getByRole('button', { name: /Program scope:/i }).click();
  await expect(sb.getByRole('option', { name: /Cloud Migration/i })).toBeVisible();
  await sb.getByRole('combobox', { name: /Filter programs/i }).fill('mobile');
  await expect(sb.getByRole('option', { name: /Mobile Platform/i })).toBeVisible();
  await expect(sb.getByRole('option', { name: /Cloud Migration/i })).toBeHidden();
});
