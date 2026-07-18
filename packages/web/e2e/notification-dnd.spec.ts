import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Account-wide Do-Not-Disturb E2E (#1707, ADR-0292).
 *
 * Golden path: toggling DND on the /me/settings/notifications card PATCHes
 * /me/notification-settings/ and the TopBar bell reflects the real muted state
 * (its aria-label gains the DND phrase — web-rule 240). Error path: a failed
 * PATCH rolls the switch back (optimistic).
 */

const ME_ID = 'user-dnd';

const fixtureMe = (dnd: boolean) => ({
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
  max_project_role: 300,
  workspace_role: 100,
  can_access_admin_settings: true,
  default_landing: 'auto',
  landing: { intent: 'my_work', path: '/me/work', resolved_by: 'fallback' },
  hidden_views: [],
  role_context: 'unified',
  schedule_in_deliver: false,
  dnd_enabled: dnd,
});

const PREFS = {
  count: 2,
  next: null,
  previous: null,
  results: [
    {
      id: 1,
      event_type: 'task.assigned',
      channel: 'in_app',
      enabled: true,
      updated_at: '2026-05-24T00:00:00Z',
    },
    {
      id: 2,
      event_type: 'task.assigned',
      channel: 'email',
      enabled: false,
      updated_at: '2026-05-24T00:00:00Z',
    },
  ],
};

type Page = import('@playwright/test').Page;

interface State {
  dnd: boolean;
  patches: Record<string, unknown>[];
  failPatch: boolean;
}

async function setup(page: Page, state: State) {
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

  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(fixtureMe(state.dnd)) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/projects/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/programs/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/me/notification-preferences/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(PREFS) }),
  );
  await page.route('**/api/v1/me/notifications/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/me/notification-settings/', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = (await route.request().postDataJSON()) as Record<string, unknown>;
      if (state.failPatch) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: pj({ detail: 'boom' }),
        });
        return;
      }
      state.patches.push(body);
      state.dnd = Boolean(body.dnd_enabled);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ dnd_enabled: state.dnd }),
    });
  });
}

test.describe('Account-wide Do Not Disturb (#1707)', () => {
  test('toggling DND PATCHes the setting and the bell reflects the muted state', async ({
    page,
  }) => {
    const state: State = { dnd: false, patches: [], failPatch: false };
    await setup(page, state);
    await page.goto('/me/settings/notifications');

    // Gate on the page having rendered before touching shell chrome.
    const dndSwitch = page.getByRole('switch', { name: 'Do Not Disturb' });
    await expect(dndSwitch).toBeVisible();
    await expect(dndSwitch).toHaveAttribute('aria-checked', 'false');

    // The bell starts in the plain (non-DND) state.
    await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();

    await dndSwitch.click();

    // The setting is PATCHed with dnd_enabled: true.
    await expect.poll(() => state.patches.length).toBeGreaterThan(0);
    expect(state.patches[0]).toEqual({ dnd_enabled: true });
    await expect(dndSwitch).toHaveAttribute('aria-checked', 'true');

    // The TopBar bell now advertises the real DND state (web-rule 240).
    await expect(page.getByRole('button', { name: /Do Not Disturb on/ })).toBeVisible();

    // Toggling back off reverts both the switch and the bell.
    await dndSwitch.click();
    await expect.poll(() => state.patches.length).toBe(2);
    expect(state.patches[1]).toEqual({ dnd_enabled: false });
    await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
  });

  test('a failed PATCH rolls the switch back (optimistic)', async ({ page }) => {
    const state: State = { dnd: false, patches: [], failPatch: true };
    await setup(page, state);
    await page.goto('/me/settings/notifications');

    const dndSwitch = page.getByRole('switch', { name: 'Do Not Disturb' });
    await expect(dndSwitch).toBeVisible();
    await expect(dndSwitch).toHaveAttribute('aria-checked', 'false');

    await dndSwitch.click();

    // Optimistic flip reverts once the PATCH 500s — the switch ends back at off
    // and the bell never enters the DND state.
    await expect(dndSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Do Not Disturb on/ })).toHaveCount(0);
  });
});
