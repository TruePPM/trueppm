import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Weekly digest schedule E2E (ADR-0663, #2407).
 *
 * Golden path: with a digest enabled, the schedule card renders and changing the
 * day PATCHes /me/notification-settings/ with the server's 0=Monday weekday.
 * Empty/negative path: with every digest off, the card is absent — a send-time
 * picker for a digest nobody subscribed to is a control with no effect.
 */

const ME_ID = 'user-digest';

const fixtureMe = {
  id: ME_ID,
  username: 'janet',
  display_name: 'Janet',
  initials: 'JA',
  email: 'janet@example.com',
  max_project_role: 300,
  workspace_role: 100,
  can_access_admin_settings: true,
  default_landing: 'auto',
  landing: { intent: 'my_work', path: '/me/work', resolved_by: 'fallback' },
  hidden_views: [],
  role_context: 'unified',
  dnd_enabled: false,
};

const prefs = (digestOn: boolean) => ({
  count: 2,
  next: null,
  previous: null,
  results: [
    {
      id: 1,
      event_type: 'program.health_digest',
      channel: 'in_app',
      enabled: digestOn,
      updated_at: '2026-07-26T00:00:00Z',
    },
    {
      id: 2,
      event_type: 'program.health_digest',
      channel: 'email',
      enabled: false,
      updated_at: '2026-07-26T00:00:00Z',
    },
  ],
});

type Page = import('@playwright/test').Page;

interface State {
  weekday: number;
  hour: number;
  patches: Record<string, unknown>[];
}

async function setup(page: Page, state: State, digestOn: boolean) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  const pj = (d: unknown) => JSON.stringify(d);
  const emptyList = { count: 0, next: null, previous: null, results: [] };

  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(fixtureMe) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/projects/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(emptyList) }),
  );
  await page.route('**/api/v1/programs/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(emptyList) }),
  );
  await page.route('**/api/v1/me/notification-preferences/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(prefs(digestOn)) }),
  );
  await page.route('**/api/v1/me/notifications/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(emptyList) }),
  );
  await page.route('**/api/v1/me/notification-settings/', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = (await route.request().postDataJSON()) as Record<string, unknown>;
      state.patches.push(body);
      if (typeof body.digest_weekday === 'number') state.weekday = body.digest_weekday;
      if (typeof body.digest_hour === 'number') state.hour = body.digest_hour;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        dnd_enabled: false,
        digest_weekday: state.weekday,
        digest_hour: state.hour,
        digest_timezone: 'America/New_York',
        updated_at: '2026-07-26T00:00:00Z',
      }),
    });
  });
}

test.describe('Weekly digest schedule (#2407)', () => {
  test('changing the day PATCHes the slot with the server 0=Monday weekday', async ({ page }) => {
    const state: State = { weekday: 6, hour: 17, patches: [] };
    await setup(page, state, true);
    await page.goto('/me/settings/notifications');

    // Gate on the page having rendered before touching the card.
    await expect(page.getByRole('switch', { name: 'Do Not Disturb' })).toBeVisible();

    // Scope to the card: "Day"/"Time" also match shell chrome ("Log time",
    // "Timesheet"), which is a strict-mode violation at page scope.
    const card = page.getByRole('region', { name: 'Digest schedule' });
    const day = card.getByLabel('Day');
    await expect(day).toBeVisible();
    // Defaults to Sunday (6) — Janet's "Sunday evening" slot.
    await expect(day).toHaveValue('6');
    const summary = page.getByTestId('digest-schedule-summary');
    await expect(summary).toHaveText(/Digests send Sundays at 5:00 pm/);

    await day.selectOption('4');

    await expect.poll(() => state.patches.length).toBeGreaterThan(0);
    // 4 is Friday under the server's Monday-first convention, NOT Thursday as a
    // JS Date#getDay reading would make it.
    expect(state.patches[0]).toEqual({ digest_weekday: 4 });
    await expect(summary).toHaveText(/Digests send Fridays/);
    // The change is also announced to screen readers.
    await expect(card.getByRole('status')).toHaveText(/Digests send Fridays/);
  });

  test('changing the time PATCHes the hour', async ({ page }) => {
    const state: State = { weekday: 6, hour: 17, patches: [] };
    await setup(page, state, true);
    await page.goto('/me/settings/notifications');

    const card = page.getByRole('region', { name: 'Digest schedule' });
    const time = card.getByLabel('Time');
    await expect(time).toBeVisible();
    await expect(time).toHaveValue('17');

    await time.selectOption('8');

    await expect.poll(() => state.patches.length).toBeGreaterThan(0);
    expect(state.patches[0]).toEqual({ digest_hour: 8 });
    await expect(page.getByTestId('digest-schedule-summary')).toHaveText(/at 8:00 am/);
  });

  test('the schedule card is absent when no digest is enabled', async ({ page }) => {
    const state: State = { weekday: 6, hour: 17, patches: [] };
    await setup(page, state, false);
    await page.goto('/me/settings/notifications');

    // The page rendered...
    await expect(page.getByRole('switch', { name: 'Do Not Disturb' })).toBeVisible();
    // ...but the send-time picker has nothing to schedule.
    await expect(page.getByRole('region', { name: 'Digest schedule' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Day' })).toHaveCount(0);
  });

  test('the digest rows appear in the preference matrix', async ({ page }) => {
    const state: State = { weekday: 6, hour: 17, patches: [] };
    await setup(page, state, true);
    await page.goto('/me/settings/notifications');

    await expect(
      page.getByRole('switch', { name: 'In-app notifications for Weekly program health digest' }),
    ).toBeVisible();
  });
});
