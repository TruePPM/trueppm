import { test, expect } from '@playwright/test';

/**
 * Settings shell UX affordances (#595 copy-link, #596 saved-time footer).
 *
 * These two features both attach to SettingsShell and share a mock surface,
 * so they ride in one spec file. Mirrors the route stubs from
 * settings-save-contract.spec.ts so the Project General page renders
 * end-to-end without a real API.
 */

const PROJECT_ID = 'e2e-shell-ux-00000000-0000-0000-0000-000000000595';

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

const FIXTURE_ME = {
  id: 'u-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

type Page = import('@playwright/test').Page;

async function setup(page: Page) {
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

  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
    if (r.request().method() === 'PATCH') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...FIXTURE_PROJECT, name: 'Atlas Migration (renamed)' }),
      });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) });
  });
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
        task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0,
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

test.describe('Settings shell — copy-link affordance (#595)', () => {
  test('copy-link button is present and labelled', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await expect(page.getByRole('button', { name: 'Copy link to settings' })).toBeVisible();
  });

  test('clicking copies the current URL and shows a confirmation', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    await page.getByRole('button', { name: 'Copy link to settings' }).click();
    await expect(page.getByText('Link copied to clipboard')).toBeVisible();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`/projects/${PROJECT_ID}/settings/general`);
  });
});

test.describe('Settings shell — scrollbar-gutter layout shift (#776)', () => {
  test('content scroll container reserves a stable scrollbar gutter', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    const scroll = page.getByTestId('settings-content-scroll');
    await expect(scroll).toBeVisible();
    // scrollbar-gutter:stable holds the scrollbar track on every sub-page, so a
    // tall page (General) and a short page (Projects/Integrations) render at the
    // same content width — the panel no longer jumps horizontally on navigation.
    const gutter = await scroll.evaluate((el) => getComputedStyle(el).scrollbarGutter);
    expect(gutter).toBe('stable');
  });

  // #776: the SCOPE switcher must not navigate to a blank page. With no programs
  // in the workspace, the Program scope segment is disabled rather than falling
  // back to a non-settings landing.
  test('Program scope segment is disabled when the workspace has no programs', async ({ page }) => {
    await setup(page); // no programs mocked → usePrograms() resolves empty
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    // exact: true so we hit the scope segment, not the sidebar's "New program" button.
    const program = page.getByRole('button', { name: 'Program', exact: true });
    await expect(program).toBeDisabled();
    await expect(program).toHaveAttribute('title', 'No programs yet');
    // Workspace and the active Project scope remain usable.
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toBeEnabled();
  });

  // #776: from a project, the Program scope lands on the project's OWN parent
  // program — not an arbitrary first program, and never a blank page.
  test('Program scope navigates to the project\'s parent program settings', async ({ page }) => {
    await setup(page);
    const PARENT = 'e2e-parent-prog-0000-0000-0000-000000000776';
    const pj = (d: unknown) => JSON.stringify(d);
    // This project belongs to PARENT (program FK set on the list payload).
    await page.route('**/api/v1/projects/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj([{ ...FIXTURE_PROJECT, program: PARENT }]) }),
    );
    const FIXTURE_PARENT = { id: PARENT, server_version: 1, name: 'Parent Program', health: 'AUTO' };
    await page.route('**/api/v1/programs/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj({ results: [FIXTURE_PARENT], count: 1, next: null, previous: null }) }),
    );
    await page.route(`**/api/v1/programs/${PARENT}/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PARENT) }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await page.getByRole('button', { name: 'Program', exact: true }).click();
    await page.waitForURL(`**/programs/${PARENT}/settings/general`);
  });
});

test.describe('Settings shell — saved-time footer (#596)', () => {
  test('footer is hidden on initial render with no save', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await expect(page.getByTestId('settings-saved-footer')).toBeHidden();
  });

  test('after a successful save, "Saved just now" footer appears', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill('Atlas Migration (renamed)');
    await page.getByRole('button', { name: /save changes/i }).click();

    const footer = page.getByTestId('settings-saved-footer');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText(/Saved/);
    await expect(footer.getByText('just now')).toBeVisible();
  });
});
