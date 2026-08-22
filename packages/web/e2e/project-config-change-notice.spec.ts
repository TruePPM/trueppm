import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Config-change notice, as the RECIPIENT sees it (#2972).
 *
 * The API half of this feature is covered by pytest. What only an E2E can show
 * is the thing the issue is actually about: a contributor who did not touch the
 * settings page opens their bell and learns, in words, what happened to their
 * own work. So the assertions are on the *copy* reaching the inbox — the lane
 * that went away, the destination its cards resolved to, and the count of the
 * reader's own items — and on the absence of "configuration updated", which is
 * the notification this issue exists to refuse.
 *
 * Also covers the preferences matrix row: a new event type that renders as a
 * raw key (`project.config_changed`) is a control nobody can find, and
 * `EVENT_LABELS` has no exhaustiveness check to catch that.
 */

const ME_ID = 'user-priya';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'priya',
  display_name: 'Priya',
  initials: 'PR',
  email: 'priya@example.com',
  max_project_role: 100,
  workspace_role: 100,
  can_access_admin_settings: false,
  default_landing: 'auto',
  landing: { intent: 'my_work', path: '/me/work', resolved_by: 'fallback' },
  hidden_views: [],
  role_context: 'unified',
  schedule_in_deliver: false,
  dnd_enabled: false,
};

const PROJECT_ID = 'e2e-cfg-00000000-0000-0000-0000-000000002972';

/** The lane-removal notice, exactly as the API renders it per recipient. */
const LANE_NOTICE = {
  id: 'notif-lane-2972',
  event_type: 'project.config_changed',
  subject: 'A board lane was removed — 3 items moved',
  body:
    'Dana removed the “QA” lane from Review. Your 3 items in there now show in ' +
    '“Review” — the first lane of that column.',
  project: PROJECT_ID,
  task_id: null,
  mention: null,
  snippet: null,
  category: 'project',
  is_read: false,
  is_archived: false,
  snoozed_until: null,
  created_at: '2026-08-22T09:00:00Z',
  read_at: null,
};

/** The preset-switch notice — the other trigger, same event type. */
const PRESET_NOTICE = {
  ...LANE_NOTICE,
  id: 'notif-preset-2972',
  subject: 'This project now runs as Waterfall',
  body:
    'Dana switched this project’s planning preset from Agile to Waterfall. ' +
    'Baselines and Monte Carlo are now shown. Your 2 items keep their status, ' +
    'dates and assignments — what changed is where you find them.',
  created_at: '2026-08-22T08:00:00Z',
};

const PREFS = {
  count: 2,
  next: null,
  previous: null,
  results: [
    {
      id: 1,
      event_type: 'project.config_changed',
      channel: 'in_app',
      enabled: true,
      updated_at: '2026-08-22T00:00:00Z',
    },
    {
      id: 2,
      event_type: 'project.config_changed',
      channel: 'email',
      enabled: false,
      updated_at: '2026-08-22T00:00:00Z',
    },
  ],
};

type Page = import('@playwright/test').Page;

async function setup(page: Page, notifications: unknown[]) {
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
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/me/notification-preferences/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(PREFS) }),
  );
  // The unread-count read (`?limit=0`) and the list read share this path, and the
  // bell badge is driven by `count` — so it must be the real number, not 0, or the
  // panel opens on a list the badge says is empty.
  await page.route('**/api/v1/me/notifications/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        count: notifications.length,
        next: null,
        previous: null,
        results: notifications,
      }),
    }),
  );
  await page.route('**/api/v1/me/notification-settings/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ dnd_enabled: false }) }),
  );
}

test.describe('Config-change notice (#2972)', () => {
  test('a lane removal reaches an assignee who never opened settings, and names what moved', async ({
    page,
  }) => {
    await setup(page, [LANE_NOTICE]);
    await page.goto('/me/notifications');

    // The subject already carries the consequence — a reader scanning a full bell
    // should not have to open the row to learn their work moved.
    await expect(
      page.getByText('A board lane was removed — 3 items moved'),
    ).toBeVisible();

    // The body names the lane, the reader's OWN count, and the destination the
    // board actually resolves an orphaned lane key to.
    const body = page.getByText(/Dana removed the “QA” lane from Review/);
    await expect(body).toBeVisible();
    await expect(body).toContainText('Your 3 items');
    await expect(body).toContainText('“Review” — the first lane of that column');

    // The notice this issue exists to refuse must not be what shipped.
    await expect(page.getByText(/configuration updated/i)).toHaveCount(0);
    await expect(page.getByText(/settings? (were|was) saved/i)).toHaveCount(0);
  });

  test('a preset switch names both presets and the views that moved', async ({ page }) => {
    await setup(page, [PRESET_NOTICE]);
    await page.goto('/me/notifications');

    await expect(page.getByText('This project now runs as Waterfall')).toBeVisible();
    const body = page.getByText(/switched this project’s planning preset/);
    await expect(body).toContainText('from Agile to Waterfall');
    await expect(body).toContainText('Baselines and Monte Carlo are now shown');
    await expect(body).toContainText('what changed is where you find them');
  });

  test('the notice is reachable from the bell and filed under the Project category', async ({
    page,
  }) => {
    await setup(page, [LANE_NOTICE, PRESET_NOTICE]);
    await page.goto('/me/work');

    const bell = page.getByRole('button', { name: /Notifications/ });
    await expect(bell).toBeVisible();
    await bell.click();

    const panel = page.getByRole('dialog', { name: /Notifications/ });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('A board lane was removed — 3 items moved')).toBeVisible();

    // Category is derived server-side from the event type; the row must be
    // reachable under Project rather than falling through to Mentions.
    await panel.getByRole('radio', { name: 'Project' }).click();
    await expect(panel.getByText('A board lane was removed — 3 items moved')).toBeVisible();
  });

  test('the preference matrix names the event in words, not as a raw key', async ({ page }) => {
    await setup(page, []);
    await page.goto('/me/settings/notifications');

    // Priya is a contributor with no admin access, so she lands on the
    // Signal-only card with the full matrix collapsed behind it (#855) — which
    // is exactly the person this event is written for, so the spec goes through
    // that door rather than around it.
    await page.getByRole('button', { name: 'Show all notification types' }).click();

    // Scoped to the desktop table's row header: the page renders the same label
    // twice (a table on ≥ md, a card per event below it), so an unscoped text
    // locator is a strict-mode collision rather than a missing row.
    await expect(
      page.getByRole('rowheader', { name: /the board or views you work on are reconfigured/ }),
    ).toBeVisible();
    // EVENT_LABELS has no exhaustiveness check — an unlabelled type renders its
    // raw key, which is a control nobody can find.
    await expect(page.getByText('project.config_changed')).toHaveCount(0);
  });
});
