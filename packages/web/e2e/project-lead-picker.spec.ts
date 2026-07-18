import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Project Settings → General lead picker E2E (#966).
 *
 * Golden path: the lead row seeds from the record (Unassigned when null) → open
 * the member picker → pick a member → the save bar arms → Save issues a PATCH
 * carrying `lead`. Plus: a seeded lead can be cleared via the Unassign row.
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-project-0000-0000-0000-000000000966';

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
  description: 'Migrate the warehouse',
  start_date: '2026-01-01',
  status_date: null,
  prioritization_model: 'none',
  stale_task_threshold_days: 14,
  end_date_shift_threshold_days: 3,
  calendar: null,
  estimation_mode: 'open',
  agile_features: false,
  methodology: 'HYBRID',
  code: 'ATLAS',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  timezone: '',
  default_view: 'SCHEDULE',
  lead: null,
  lead_detail: null,
  is_archived: false,
  archived_at: null,
  archived_by: null,
};

const MEMBERS = [
  { id: 'm1', user_detail: { id: 'u-anika', username: 'anika', email: 'anika@x.com' }, role: 400 },
  { id: 'm2', user_detail: { id: 'u-bob', username: 'bob', email: 'bob@x.com' }, role: 100 },
];

type Page = import('@playwright/test').Page;

async function setup(
  page: Page,
  captures: { patch?: Record<string, unknown> },
  project = FIXTURE_PROJECT,
) {
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
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  // `members/**` (not `members/`) so this also serves the `?self=true` request
  // useCurrentUserRole makes — its first row (anika, role 400) resolves the page
  // to Admin, keeping the lead picker editable under the #1084 role gate.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(MEMBERS) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, async (route) => {
    if (route.request().method() === 'PATCH') {
      captures.patch = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...project, ...captures.patch }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: pj(project) });
  });
}

test.describe('Project Settings → General lead picker', () => {
  test('picks a member as lead and PATCHes lead on save', async ({ page }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    // Scope to General: the consolidated page (ADR-0146) mounts the Team section
    // too, so member names/lead controls collide unless scoped to this region.
    const section = page.locator('[data-settings-section="general"]');
    await expect(section.getByRole('heading', { name: 'General' })).toBeVisible();
    // No lead → Unassigned + an "Assign" trigger (no hardcoded "Anika Krishnan").
    expect(await section.getByText('Anika Krishnan').count()).toBe(0);
    await section.getByRole('button', { name: 'Assign' }).click();

    const listbox = page.getByRole('listbox', { name: 'Select project lead' });
    await expect(listbox).toBeVisible();
    await listbox.getByRole('option', { name: 'bob' }).click();

    // Picking sets page state (not an immediate PATCH) → the save bar arms.
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toMatchObject({ lead: 'u-bob' });
  });

  test('clears an assigned lead via the Unassign row', async ({ page }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    const seeded = {
      ...FIXTURE_PROJECT,
      lead: 'u-anika',
      lead_detail: { id: 'u-anika', username: 'anika', email: 'anika@x.com' },
    };
    await setup(page, captures, seeded);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    // Scope to General — the Team section also lists "anika" on the consolidated page.
    const section = page.locator('[data-settings-section="general"]');
    // Seeded lead renders from lead_detail.
    await expect(section.getByText('anika')).toBeVisible();
    await section.getByRole('button', { name: 'Change' }).click();
    await page.getByRole('option', { name: 'Unassign' }).click();

    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toMatchObject({ lead: null });
  });
});
