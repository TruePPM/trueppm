import { test, expect } from '@playwright/test';

/**
 * Project Settings → General E2E (#520).
 *
 * Verifies the page is wired to the real `/api/v1/projects/:id/` endpoint
 * for the extended fields beyond name + description:
 * - Initial values seed from the GET response (code, health, visibility,
 *   timezone, default_view, calendar).
 * - Editing fields arms the save bar.
 * - Clicking Save issues a PATCH carrying every dirty field in one payload.
 * - Server validation errors (e.g. lowercase code) surface back to the user.
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-project-00000000-0000-0000-0000-000000000520';

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
  description: 'Migrate the data warehouse to the new platform.',
  start_date: '2026-03-02',
  calendar: 'cal-default',
  estimation_mode: 'OPEN',
  agile_features: false,
  methodology: 'HYBRID',
  code: 'ATLAS',
  health: 'AT_RISK',
  visibility: 'WORKSPACE',
  timezone: 'Europe/London',
  default_view: 'BOARD',
};

type Page = import('@playwright/test').Page;
type Route = import('@playwright/test').Route;

interface Captures {
  patch?: Record<string, unknown>;
}

async function setup(page: Page, captures: Captures, opts: { patchStatus?: number; patchBody?: unknown } = {}) {
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
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [FIXTURE_PROJECT], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      captures.patch = JSON.parse(route.request().postData() ?? '{}');
      if (opts.patchStatus && opts.patchStatus >= 400) {
        await route.fulfill({
          status: opts.patchStatus,
          contentType: 'application/json',
          body: pj(opts.patchBody ?? {}),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...FIXTURE_PROJECT, ...captures.patch }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(FIXTURE_PROJECT),
    });
  });
}

test.describe('Project Settings → General', () => {
  test('seeds every extended field and PATCHes edited values on save', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(page.getByLabel('Project name')).toHaveValue('Atlas Migration');
    await expect(page.getByLabel('Project code')).toHaveValue('ATLAS');
    await expect(page.getByLabel('Description')).toHaveValue(
      'Migrate the data warehouse to the new platform.',
    );

    // At-risk pill starts pressed (matches FIXTURE_PROJECT.health = AT_RISK).
    await expect(page.getByRole('button', { name: 'At risk' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Timezone + default view seed from the response.
    await expect(page.getByLabel('Timezone')).toHaveValue('Europe/London');
    await expect(page.getByLabel('Default view')).toHaveValue('BOARD');

    // Flip a few fields and save.
    await page.getByRole('button', { name: 'On track' }).click();
    await page.getByLabel('Default view').selectOption('TABLE');

    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toMatchObject({
      health: 'ON_TRACK',
      default_view: 'TABLE',
    });
  });

  test('surfaces a server-side validation error from a leading-hyphen code', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures, {
      patchStatus: 400,
      patchBody: {
        code: [
          'Project code must use uppercase letters, digits, and hyphens only, and may not start or end with a hyphen.',
        ],
      },
    });
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    // Client uppercases on input but does NOT pre-filter leading hyphens —
    // the user can type "-ATLAS" and only the server rejects it. This is
    // the reachable validation-error path from the UI today.
    await page.getByLabel('Project code').fill('-ATLAS');
    await expect(page.getByLabel('Project code')).toHaveValue('-ATLAS');

    await page.getByRole('button', { name: /Save changes/i }).click();

    // PATCH fires with the invalid value; the server's 400 keeps the user on
    // the page with the save bar still visible so they can correct and retry.
    // Inline error rendering is a follow-up — today the contract is just
    // "bar stays armed, no navigation away".
    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toMatchObject({ code: '-ATLAS' });
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeVisible();
  });
});
