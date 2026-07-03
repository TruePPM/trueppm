import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Settings save contract E2E (#536).
 *
 * The SettingsShell save bar is gated on the active page's dirty state via
 * `useDirtyForm`. This spec exercises the cross-cutting contract on the one
 * page wired in this MR (Project General — name + description), and verifies
 * the nav guard:
 *   1. Save bar appears within 1 tick of input change.
 *   2. Discard reverts to the last-saved value.
 *   3. Save dispatches a real PATCH and clears the bar.
 *   4. Navigating to another settings page while dirty opens the confirm
 *      dialog; "Keep editing" preserves the edit, "Discard changes" navigates.
 */

const PROJECT_ID = 'e2e-settings-save-00000000-0000-0000-0000-000000000536';

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
  // #520 extended fields — every PATCH from the General page now carries the
  // full editable payload (one consolidated request rather than per-field
  // patches). Seed defaults so the save assertion below reflects the actual
  // shape posted by the page.
  code: '',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  timezone: '',
  default_view: 'SCHEDULE',
  // Duration-change percent policy (ADR-0151, issue 1254) — null override inherits
  // the resolved 'keep' default so the General page renders the inheriting control.
  task_duration_change_percent_policy: null,
  effective_task_duration_change_percent_policy: 'keep',
  inherited_task_duration_change_percent_policy: 'keep',
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

  // Catch-all for any unmocked /api/v1/* endpoint — return an empty 200 so the
  // app stays in a healthy state. Specific routes below override this because
  // Playwright matches the most recently added route first.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) });
    }
    return r.continue();
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
  // Members endpoint is hit by the Access page after a discard navigation; keep it
  // an empty roster (the Access page expects a richer member shape than we need here).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  // useCurrentUserRole reads only the first row's `role` from `?self=true`. Resolve
  // it to Admin (400) so the General page stays editable under the #1084 role gate,
  // without polluting the roster above. Registered last → wins Playwright's LIFO
  // match for the self-scoped request.
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
  // NotificationBell polls /me/notifications/; unmocked the static preview
  // server returns the SPA index.html and axios rejects the response with a
  // shape mismatch. Keep it quiet so the AppShell renders cleanly.
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

const ORIGINAL_NAME = FIXTURE_PROJECT.name;
const EDITED_NAME = 'Atlas Migration (renamed)';

test.describe('Settings save contract (#536)', () => {
  test('save bar is hidden until an input change', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await expect(nameInput).toHaveValue(ORIGINAL_NAME);
    await expect(page.getByText('You have unsaved changes')).toBeHidden();
  });

  test('save bar appears within 1 tick of the first input change', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill(EDITED_NAME);
    await expect(page.getByText('You have unsaved changes')).toBeVisible();
    await expect(page.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });

  test('Discard restores the last-saved value', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill(EDITED_NAME);
    await page.getByRole('button', { name: /^discard$/i }).click();
    await expect(nameInput).toHaveValue(ORIGINAL_NAME);
    await expect(page.getByText('You have unsaved changes')).toBeHidden();
  });

  test('Save dispatches PATCH /projects/:id and collapses the bar', async ({ page }) => {
    await setup(page);

    let patchBody: unknown = null;
    // Override the setup route — must also serve the GET because Playwright
    // routes are LIFO and `r.fallback()` is required to reach the next handler.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...FIXTURE_PROJECT, name: EDITED_NAME }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FIXTURE_PROJECT),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill(EDITED_NAME);
    await page.getByRole('button', { name: /save changes/i }).click();

    // Page sends the full consolidated payload — #520 extended the surface
    // beyond name + description; use `toMatchObject` so additional fields
    // (code, health, visibility, timezone, default_view, calendar) on the
    // request don't make this contract brittle as the schema grows.
    await expect
      .poll(() => patchBody)
      .toMatchObject({
        name: EDITED_NAME,
        description: FIXTURE_PROJECT.description,
      });
    await expect(page.getByText('You have unsaved changes')).toBeHidden();
  });

  // ── ADR-0146 (issue 1248): sections are now anchored regions on ONE mounted
  // page. Clicking a section in the rail scroll-spies in place (no route change,
  // no data loss), so it must NOT trip the dirty guard. The guard now fires only
  // on a real route departure — here the scope switcher's "Workspace" button.

  test('switching section in the rail while dirty stays on the page (no guard)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill(EDITED_NAME);
    // 'Access' is now a scroll-spy rail button, not a route link.
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    // Same mounted page — no confirm dialog, edit preserved, bar still armed.
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect(nameInput).toHaveValue(EDITED_NAME);
    await expect(page.getByText('You have unsaved changes')).toBeVisible();
  });

  test('leaving settings (scope switch) while dirty opens the confirm-discard dialog', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await page.getByRole('textbox', { name: /project name/i }).fill(EDITED_NAME);
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible();
  });

  test('Keep editing closes the dialog and preserves the edit', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill(EDITED_NAME);
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect(nameInput).toHaveValue(EDITED_NAME);
    // Still on the project settings page.
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/settings`));
  });

  test('Discard changes leaves settings and drops the edit', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await page.getByRole('textbox', { name: /project name/i }).fill(EDITED_NAME);
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    // Navigated away from the project settings page to the workspace settings.
    await expect(page).toHaveURL(/\/settings(\b|#|$)/);
    await expect(page).not.toHaveURL(new RegExp(`/projects/${PROJECT_ID}/settings`));
  });

  test('stub pages signal preview state for an unwired API', async ({ page }) => {
    await setup(page);
    // Workspace Roles & permissions is still a stub (RBAC-matrix write path is
    // tracked in #510). The Methodology pages, formerly stubs, are now wired by
    // the cascade (issue 955 / issue 1169), so the preview signal moved here.
    // The matrix body is wrapped in a `<fieldset disabled>` (read-only preview)
    // and the page carries the stub banner; assert the banner as the canonical
    // preview signal. Scope to the section — the consolidated page (#1248) mounts
    // every section at once.
    await page.goto('/settings/roles');
    const roles = page.locator('[data-settings-section="roles"]');
    await expect(roles.getByTestId('stub-page-banner')).toBeVisible();
  });
});
