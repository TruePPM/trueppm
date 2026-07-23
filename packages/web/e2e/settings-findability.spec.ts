import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/**
 * Settings findability (ADR-0606).
 *
 * FEATURE A (#2320) — the desktop settings rail filter: type to narrow the
 * section list, empty state, clear, and Enter-to-jump.
 * FEATURE B (#2319) — the ⌘K "Settings" query-only group indexing individual
 * settings sections (tested via the ungated Personal sections, which need no
 * workspace-admin role).
 *
 * All API calls are route-mocked; no server required.
 */

// ── Feature A: rail filter ────────────────────────────────────────────────────

const PROJECT_ID = 'e2e-find-00000000-0000-0000-0000-000000002320';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Atlas Migration',
  description: 'Original description.',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
  agile_features: false,
  methodology: 'HYBRID',
};

const FIXTURE_ME = {
  id: 'u-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

async function setupProjectSettings(page: Page) {
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

  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/attention/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/my-tasks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  // Resolve self to Admin (role 400) so the shell renders fully (mirrors
  // settings-shell-ux.spec). Registered after the roster route → wins LIFO for self.
  await page.route(
    (url) =>
      url.pathname.endsWith(`/projects/${PROJECT_ID}/members/`) &&
      url.searchParams.get('self') === 'true',
    (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj([{ id: 'self', role: 400 }]),
      }),
  );
  await page.route('**/api/v1/me/notifications/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/me/notification-preferences/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
}

test.describe('Settings rail filter (#2320)', () => {
  test('narrows to matching sections, shows the empty state, and clears', async ({ page }) => {
    await setupProjectSettings(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    const filter = page.getByRole('searchbox', { name: 'Filter settings sections' });
    await expect(filter).toBeVisible();
    // Gate on the rail being populated before filtering.
    await expect(page.getByRole('button', { name: 'General', exact: true })).toBeVisible();

    // Narrow: only Access survives; General and the Danger/Lifecycle group drop.
    await filter.fill('access');
    await expect(page.getByRole('button', { name: 'Access', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'General', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Lifecycle', exact: true })).toHaveCount(0);

    // Empty state.
    await filter.fill('zzzznomatch');
    await expect(page.getByText(/No settings match/)).toBeVisible();

    // Clear restores the full rail.
    await page.getByRole('button', { name: 'Clear filter' }).click();
    await expect(page.getByRole('button', { name: 'General', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Access', exact: true })).toBeVisible();
  });

  test('Enter jumps to the first match', async ({ page }) => {
    await setupProjectSettings(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    const filter = page.getByRole('searchbox', { name: 'Filter settings sections' });
    await expect(page.getByRole('button', { name: 'General', exact: true })).toBeVisible();
    await filter.fill('methodolog');
    await filter.press('Enter');
    // Scroll-spy hash reflects the jumped section; same page (no route change).
    await expect(page).toHaveURL(/#methodology/);
    // Filter cleared, rail restored.
    await expect(filter).toHaveValue('');
    await expect(page.getByRole('button', { name: 'General', exact: true })).toBeVisible();
  });
});

// ── Feature B: ⌘K settings-section indexing ──────────────────────────────────

test.describe('Command palette settings sections (#2319)', () => {
  async function setup(page: Page): Promise<void> {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: [{ id: 'find-proj', name: 'Apollo' }], projectId: 'find-proj' });
    await page.goto('/me/work');
  }

  test('indexes a personal settings section under a query-only Settings group', async ({ page }) => {
    await setup(page);
    await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    // Cold: the section is query-only, so it is absent until we type.
    await expect(dialog.getByRole('option', { name: /API tokens/ })).toHaveCount(0);

    // A keyword synonym ("pat") surfaces the personal "API tokens" section.
    await page.getByRole('combobox').fill('pat');
    const option = dialog.getByRole('option', { name: /API tokens/ });
    await expect(option).toBeVisible();

    // Selecting it deep-links to the personal settings route.
    await option.click();
    await expect(page).toHaveURL(/\/me\/settings\/api-tokens/);
  });
});
