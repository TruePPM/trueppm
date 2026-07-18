import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, type UserFixture } from './fixtures';

/**
 * Per-user timezone + date-format preferences (#1953, ADR-0410).
 *
 * The two display preferences are set on /me/settings/general and persist across
 * a reload (the AC). Golden path covers the date-format radios and the searchable
 * timezone combobox; the error path proves the optimistic control reverts when the
 * PATCH is rejected.
 */

const PROJECT_ID = 'e2e-tzdf-0000-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Apollo Platform', description: '', start_date: '2026-01-01', calendar: 'default' },
];

function user(timezone: string, dateFormat: string): UserFixture {
  return {
    id: 'e2e-user',
    username: 'e2euser',
    display_name: 'E2E User',
    initials: 'EU',
    email: 'e2e@example.com',
    default_landing: 'my_work',
    landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
    hidden_views: [],
    role_context: 'unified',
    schedule_in_deliver: false,
    dnd_enabled: false,
    timezone,
    date_format: dateFormat,
  };
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function setup(page: Page, timezone: string, dateFormat: string) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    user: user(timezone, dateFormat),
  });
}

test.describe('Timezone & date format preferences (ADR-0410)', () => {
  test('setting the date format and timezone persists across reload', async ({ page }) => {
    await setup(page, 'auto', 'auto');

    // Stateful /auth/me/ + profile PATCH (registered after setup → take precedence)
    // so the new prefs are reflected on refetch and survive a reload.
    const state = { timezone: 'auto', date_format: 'auto' };
    await page.route('**/api/v1/auth/me/', (route) =>
      route.fulfill(json(user(state.timezone, state.date_format))),
    );
    await page.route('**/api/v1/auth/me/profile/', (route) => {
      const body = route.request().postDataJSON() as { timezone?: string; date_format?: string };
      if (body.timezone) state.timezone = body.timezone;
      if (body.date_format) state.date_format = body.date_format;
      route.fulfill(json({ ...state, default_landing: 'my_work', hidden_views: [] }));
    });

    await page.goto('/me/settings/general');

    // Date format — Automatic is checked initially; switch to ISO 8601. (Native
    // radios use the `checked` property, not aria-checked.)
    await expect(page.getByRole('radio', { name: /Automatic/ })).toBeChecked();
    await page.getByRole('radio', { name: /ISO 8601/ }).check();
    await expect(page.getByRole('radio', { name: /ISO 8601/ })).toBeChecked();

    // Timezone — open the searchable combobox, filter by city, pick Europe/London.
    await page.getByRole('button', { name: /^Timezone:/ }).click();
    const search = page.getByRole('combobox', { name: 'Search timezones' });
    await expect(search).toBeFocused();
    await search.fill('london');
    await page.getByRole('option', { name: 'Europe/London' }).click();
    await expect(page.getByRole('button', { name: 'Timezone: Europe/London' })).toBeVisible();

    // Reload — both prefs are re-read from /auth/me/ and stay set.
    await page.reload();
    await expect(page.getByRole('radio', { name: /ISO 8601/ })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Timezone: Europe/London' })).toBeVisible();
  });

  test('the date-format samples show each style, and a rejected save reverts', async ({ page }) => {
    await setup(page, 'auto', 'auto');

    // The ISO radio's live sample renders an ISO-8601 date (YYYY-MM-DD).
    await page.goto('/me/settings/general');
    await expect(page.getByRole('radio', { name: /ISO 8601/ })).toHaveAccessibleName(
      /\d{4}-\d{2}-\d{2}/,
    );

    // A rejected PATCH reverts the optimistic selection back to Automatic.
    await page.route('**/api/v1/auth/me/', (route) => route.fulfill(json(user('auto', 'auto'))));
    await page.route('**/api/v1/auth/me/profile/', (route) =>
      route.fulfill(json({ date_format: ['Unsupported style.'] }, 400)),
    );

    // `.click()`, not `.check()`: the optimistic check reverts on the 400, and
    // `.check()` would race waiting for a checked state that intentionally undoes.
    await page.getByRole('radio', { name: /European/ }).click();
    // Unique error copy (no other section produces this exact string) — avoids the
    // strict-mode collision of the three role="status" lines on this page.
    await expect(page.getByText("Couldn't save. Try again.")).toBeVisible();
    await expect(page.getByRole('radio', { name: /Automatic/ })).toBeChecked();
  });
});
