import { test, expect } from '@playwright/test';

/**
 * Project Settings → Notifications E2E (#522).
 *
 * Verifies the page is wired to the real
 * /projects/<id>/notification-preferences/ endpoint and the hardcoded
 * matrix is gone:
 *  - GET returns the seeded matrix; toggles reflect it.
 *  - Clicking a cell PATCHes a partial matrix payload.
 *  - Quiet hours toggle PATCHes quiet_hours_enabled.
 *  - The stub banner is no longer rendered.
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-notifications-00000000-0000-0000-0000-000000000522';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

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

const MEMBER_MEMBERSHIP = {
  id: 'mem-self',
  server_version: 1,
  project: PROJECT_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 100,
  role_label: 'Project Member',
};

const FIXTURE_PREFERENCES = {
  matrix: {
    task_assigned: { in_app: true, email: true, slack: true, mobile_push: true },
    task_overdue: { in_app: true, email: true, slack: true, mobile_push: true },
    comment_mention: { in_app: true, email: true, slack: true, mobile_push: true },
    status_change: { in_app: true, email: false, slack: false, mobile_push: false },
    budget_alert: { in_app: true, email: true, slack: true, mobile_push: true },
    risk_created: { in_app: true, email: true, slack: true, mobile_push: true },
    milestone_reached: { in_app: true, email: true, slack: true, mobile_push: false },
    sprint_start: { in_app: true, email: true, slack: true, mobile_push: false },
    sprint_end: { in_app: true, email: true, slack: true, mobile_push: false },
  },
  paused: false,
  quiet_hours_enabled: true,
  quiet_hours_from: '20:00:00',
  quiet_hours_until: '07:00:00',
  updated_at: '2026-05-22T00:00:00Z',
};

type Page = import('@playwright/test').Page;

interface Captures {
  patches: Record<string, unknown>[];
  current?: Record<string, unknown>;
}

async function setup(page: Page, captures: Captures) {
  captures.current = { ...FIXTURE_PREFERENCES };
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

  // Catch-all so unrelated surfaces (presence, attention, …) don't 404.
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [FIXTURE_PROJECT], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );

  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([MEMBER_MEMBERSHIP]) }),
  );

  await page.route(
    `**/api/v1/projects/${PROJECT_ID}/notification-preferences/`,
    async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = (await route.request().postDataJSON()) as Record<string, unknown>;
        captures.patches.push(body);
        // Merge so subsequent GETs (e.g. after reload) see the latest state
        // — required for the pause-persist test (#589).
        captures.current = { ...(captures.current ?? FIXTURE_PREFERENCES), ...body };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj(captures.current),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(captures.current ?? FIXTURE_PREFERENCES),
      });
    },
  );
}

test.describe('Project Settings → Notifications (#522)', () => {
  test('renders the API-backed matrix and PATCHes a single cell on toggle', async ({ page }) => {
    const captures: Captures = { patches: [] };
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/notifications`);

    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    // Stub banner is gone — page is wired.
    await expect(page.getByTestId('stub-page-banner')).toBeHidden();

    // Initial state: "Task moves to another column" via email is OFF.
    const statusEmail = page.getByRole('switch', {
      name: /task moves to another column via email/i,
    });
    await expect(statusEmail).toHaveAttribute('aria-checked', 'false');

    // Toggle a cell and confirm a partial PATCH was sent.
    const assignedEmail = page.getByRole('switch', {
      name: /task assigned to me via email/i,
    });
    await expect(assignedEmail).toHaveAttribute('aria-checked', 'true');
    await assignedEmail.click();

    await expect.poll(() => captures.patches.length).toBeGreaterThan(0);
    expect(captures.patches[0]).toEqual({ matrix: { task_assigned: { email: false } } });
  });

  test('pauses all notifications and persists the kill-switch across reload (#589)', async ({ page }) => {
    const captures: Captures = { patches: [] };
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/notifications`);

    const pause = page.getByRole('switch', { name: 'Pause all project notifications' });
    await expect(pause).toHaveAttribute('aria-checked', 'false');
    await pause.click();

    await expect.poll(() => captures.patches.length).toBe(1);
    expect(captures.patches[0]).toEqual({ paused: true });
    await expect(pause).toHaveAttribute('aria-checked', 'true');

    // Reload — the fixture echoes back the patched fields, so paused=true
    // round-trips through the GET on the next mount.
    await page.reload();
    await expect(
      page.getByRole('switch', { name: 'Pause all project notifications' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('toggles quiet hours and persists a new start time', async ({ page }) => {
    const captures: Captures = { patches: [] };
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/notifications`);

    const quiet = page.getByRole('switch', { name: 'Quiet hours' });
    await expect(quiet).toHaveAttribute('aria-checked', 'true');
    await quiet.click();
    await expect.poll(() => captures.patches.length).toBe(1);
    expect(captures.patches[0]).toEqual({ quiet_hours_enabled: false });

    // Scope to the settings pane — the v2 rail's "Import a project from a file"
    // button's aria-label also contains "from", so an unscoped getByLabel('From')
    // is ambiguous.
    const from = page.getByTestId('settings-content-scroll').getByLabel('From');
    await from.selectOption('22:00');
    await expect.poll(() => captures.patches.length).toBe(2);
    expect(captures.patches[1]).toEqual({ quiet_hours_from: '22:00:00' });
  });
});
