import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

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

  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
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
  // useCurrentUserRole's `?self=true` read resolves the Project General page to
  // Admin (role 400) so its fields stay editable under the #1084 role gate.
  // Registered after the roster route → wins Playwright's LIFO match for self.
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
    // The legacy /settings/general path redirects to the consolidated page at the
    // #general anchor (ADR-0146); the copied link is the deep-linkable anchor URL.
    expect(copied).toContain(`/projects/${PROJECT_ID}/settings`);
    expect(copied).toContain('#general');
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

  // #1618: min-h-0 keeps the flex-1 scroll child from taking its content-height
  // min and overflowing the height chain, which let <main> scroll past the
  // content into empty canvas. The panel must not exceed the viewport height.
  test('content scroll container is height-constrained (no over-scroll into empty canvas)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    const scroll = page.getByTestId('settings-content-scroll');
    await expect(scroll).toBeVisible();
    const minHeight = await scroll.evaluate((el) => getComputedStyle(el).minHeight);
    expect(minHeight).toBe('0px');
    // The scroll panel is bounded by the viewport — it never grows to its full
    // content height (which is what produced the over-scroll into blank canvas).
    const viewport = page.viewportSize();
    const panelHeight = await scroll.evaluate((el) => el.getBoundingClientRect().height);
    expect(panelHeight).toBeLessThanOrEqual((viewport?.height ?? 720) + 1);
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
  test("Program scope navigates to the project's parent program settings", async ({ page }) => {
    await setup(page);
    const PARENT = 'e2e-parent-prog-0000-0000-0000-000000000776';
    const pj = (d: unknown) => JSON.stringify(d);
    // This project belongs to PARENT (program FK set on the list payload).
    await page.route('**/api/v1/projects/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj([{ ...FIXTURE_PROJECT, program: PARENT }]),
      }),
    );
    const FIXTURE_PARENT = {
      id: PARENT,
      server_version: 1,
      name: 'Parent Program',
      health: 'AUTO',
    };
    await page.route('**/api/v1/programs/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ results: [FIXTURE_PARENT], count: 1, next: null, previous: null }),
      }),
    );
    await page.route(`**/api/v1/programs/${PARENT}/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PARENT) }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await page.getByRole('button', { name: 'Program', exact: true }).click();
    // Scope switch targets the consolidated program settings page (ADR-0146).
    await page.waitForURL(new RegExp(`/programs/${PARENT}/settings`));
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

test.describe('Settings shell — mobile responsive collapse (#539)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('below md: the 240px rail collapses to a "Jump to section" select', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    // The desktop rail (a nav labelled "Settings navigation") is not rendered on a
    // phone; the section picker takes its place. Both the scope switcher and the
    // copy-link affordance survive the collapse.
    await expect(page.getByRole('navigation', { name: 'Settings navigation' })).toHaveCount(0);
    const jump = page.getByLabel('Jump to section');
    await expect(jump).toBeVisible();
    // exact: avoid colliding with the "Inherit from workspace" methodology button.
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy link to settings' })).toBeVisible();
  });

  test('the settings page does not overflow horizontally at 375px', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await expect(page.getByLabel('Jump to section')).toBeVisible();

    // The fixed 240px label column + 240px rail were the overflow culprits; the
    // rail is gone and FieldRow stacks below md:, so the document must not scroll
    // sideways on a phone viewport (44px touch targets stay reachable).
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });

  // The mobile header carries the only clear way out of settings on a phone: the
  // desktop Sidebar is a hidden drawer and BottomNav self-suppresses off-project
  // (issue 1709).
  test('below md: an exit button leaves settings for the entity surface', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    const exit = page.getByRole('button', { name: /back to/i });
    await expect(exit).toBeVisible();
    await exit.click();
    // Left the settings tree — the URL no longer points at /settings.
    await expect(page).not.toHaveURL(/\/settings/);
  });

  test('below md: exiting with unsaved changes opens the discard guard', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await expect(page.getByLabel('Jump to section')).toBeVisible();

    // Dirty the form, then attempt to exit — the guard must intercept.
    await page.getByRole('textbox', { name: /project name/i }).fill('Atlas (renamed)');
    await page.getByRole('button', { name: /back to/i }).click();

    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
    // Still on settings — navigation was blocked pending the choice.
    await expect(page).toHaveURL(/\/settings/);
  });
});
