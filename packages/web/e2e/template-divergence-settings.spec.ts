import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Project Settings → Template divergence (#2971, epic #2743).
 *
 * The spec that carries the issue is `every role reads the same page` — it drives
 * the real UI as a **Viewer** (role 0, the lowest) and asserts the full digest is
 * on screen. A report about a team's decisions that the team cannot read is
 * surveillance with better typography, so the failure this locks out is not a 403;
 * it is a *narrower page* for the people the report is about.
 *
 * The rest: the not-adopted answer, the deleted-template provenance line, and the
 * failed read reporting itself as a failure rather than as "nothing to report".
 */

const PROJECT_ID = 'e2e-project-00000000-0000-0000-0000-000000002971';

const pj = (data: unknown) => JSON.stringify(data);

/**
 * `can_access_admin_settings` is derived from `role` on purpose (Admin=300+).
 *
 * That flag — not the project role — is what the `/projects/:id/settings` route
 * used to gate on, so a spec whose `/auth/me` omits it renders the page for a
 * "Viewer" that a real Viewer would be redirected off. The strict `=== false`
 * check in the guard passes on `undefined`, which is exactly how that gap stays
 * green. Deriving it here means the Viewer case runs the real gate.
 */
function me(role: number) {
  return {
    id: 'user-alice',
    username: 'alice',
    display_name: 'Alice',
    initials: 'AL',
    email: 'alice@example.com',
    can_access_admin_settings: role >= 300,
    workspace_role: role >= 300 ? 300 : 100,
    max_project_role: role,
  };
}

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Atlas',
  description: '',
  start_date: '2026-03-02',
  calendar: 'cal-default',
  estimation_mode: 'OPEN',
  agile_features: true,
  methodology: 'HYBRID',
  code: 'ATLAS',
  health: 'ON_TRACK',
  visibility: 'WORKSPACE',
  timezone: 'UTC',
  default_view: 'SCHEDULE',
  is_archived: false,
  archived_at: null,
  archived_by: null,
};

const ADOPTED = {
  project: PROJECT_ID,
  adopted: true,
  application: 'app-2971',
  application_count: 1,
  template: 'tpl-2971',
  template_name: 'Delivery skeleton',
  template_version: 3,
  template_available: true,
  applied_at: '2026-08-12T09:00:00Z',
  applied_by_name: 'Priya',
  seeded_row_count: 42,
  unchanged: 30,
  adapted: 8,
  removed: 4,
  added: 11,
};

const NOT_ADOPTED = {
  ...ADOPTED,
  adopted: false,
  application: null,
  application_count: 0,
  template: null,
  template_name: '',
  template_version: 0,
  template_available: false,
  applied_at: null,
  applied_by_name: '',
  seeded_row_count: 0,
  unchanged: 0,
  adapted: 0,
  removed: 0,
  added: 7,
};

type Page = import('@playwright/test').Page;

async function setup(
  page: Page,
  opts: { role?: number; digest?: unknown; digestStatus?: number } = {},
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

  // Catch-all 401-guard FIRST (ADR-0146): the project settings page mounts every
  // section on one scrolling page, so every sibling section fires its own reads.
  // Without the net they hit the preview server, 401, and trip the session-expired
  // modal, which replaces the app and detaches whatever this spec was asserting on.
  await setupCatchAll(page);

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(me(opts.role ?? 0)) }),
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
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );
  // Owner=400, Scheduler=200, Member=100, Viewer=0 (ADR-0072).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/*`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([{ id: 'm-alice', role: opts.role ?? 0 }]),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/template-divergence/`, (r) =>
    r.fulfill({
      status: opts.digestStatus ?? 200,
      contentType: 'application/json',
      body: pj(opts.digestStatus && opts.digestStatus >= 400 ? { detail: 'nope' } : (opts.digest ?? ADOPTED)),
    }),
  );
}

/** The settings shell is one scrolling page — sub-slugs redirect to `#<id>`. */
const URL = `/projects/${PROJECT_ID}/settings#template-divergence`;

test.describe('Project Settings → Template divergence', () => {
  test('a Viewer reads the whole digest — the same page as everyone else', async ({ page }) => {
    // Role 0 on purpose. If a later change gates any part of this report above
    // Viewer, the counts below stop being on screen and this fails — which is the
    // only automated thing standing between the feature and the asymmetry the
    // issue exists to forbid.
    await setup(page, { role: 0 });
    await page.goto(URL);

    await expect(page.getByRole('heading', { name: 'Template divergence' })).toBeVisible();
    // Anchored on "This project started from" — the section subtitle also carries
    // "started from", and a bare /started from/ is a strict-mode collision.
    await expect(page.getByText(/This project started from/)).toBeVisible();
    await expect(page.getByText(/Delivery skeleton/).first()).toBeVisible();
    await expect(page.getByText(/applied by Priya/)).toBeVisible();

    for (const label of ['Unchanged', 'Adapted', 'Removed', 'Added']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByText(/Of the 42 rows the template wrote/)).toBeVisible();
    await expect(page.getByText(/Everyone on this project sees exactly this page/)).toBeVisible();
  });

  test('an Owner sees the identical page — no extra section, no verdict', async ({ page }) => {
    await setup(page, { role: 400 });
    await page.goto(URL);

    await expect(page.getByRole('heading', { name: 'Template divergence' })).toBeVisible();
    await expect(page.getByText(/Of the 42 rows the template wrote/)).toBeVisible();
    // Divergence produces a visible signal, never a block (epic #2743): nothing on
    // this section submits, approves, or scores. Scoped to the section so the rest
    // of the settings page's controls do not count.
    const section = page.locator('#template-divergence');
    await expect(section.getByRole('button')).toHaveCount(0);
    await expect(section.getByText(/complian/i)).toHaveCount(0);
  });

  test('a Viewer is not redirected off their own project settings', async ({ page }) => {
    // The regression test for the finding that nearly shipped this feature broken:
    // `/projects/:id/settings` was wrapped in `RequireAdminSettings`, which reads
    // the ORG-WIDE `can_access_admin_settings` (Admin+ in ANY project), not the
    // project role — so every Viewer, Member and Scheduler was bounced to
    // `/me/settings/notifications` before the page mounted. The endpoint answering
    // a Viewer with 200 proved nothing while no route rendered it.
    await setup(page, { role: 0 });
    await page.goto(URL);

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/settings`));
    await expect(page.getByRole('heading', { name: 'Template divergence' })).toBeVisible();
  });

  test('a Viewer gets the reduced rail — only what they can act on', async ({ page }) => {
    await setup(page, { role: 0 });
    await page.goto(URL);

    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByText('Template divergence')).toBeVisible();
    // Admin controls stay off a non-admin's page: admitting them to the route is
    // not the same as handing them a shell full of things the server will refuse.
    // Retitled by #2969 — 'Workflow & fields' is no longer a rail row for ANYONE,
    // so asserting its absence stopped saying anything about the member view.
    await expect(nav.getByText('How this team works')).toHaveCount(0);
    await expect(nav.getByText('Access', { exact: true })).toHaveCount(0);
  });

  test('the rail carries its own row, so the report is findable', async ({ page }) => {
    await setup(page, { role: 0 });
    await page.goto(URL);

    await expect(
      page.getByRole('navigation', { name: 'Settings sections' }).getByText('Template divergence'),
    ).toBeVisible();
  });

  test('a project with no template says so, and still explains the page', async ({ page }) => {
    await setup(page, { role: 100, digest: NOT_ADOPTED });
    await page.goto(URL);

    await expect(page.getByText(/wasn’t created from a template/)).toBeVisible();
    await expect(page.getByText(/Its 7 rows were all authored here/)).toBeVisible();
    await expect(page.getByText(/Everyone on this project sees exactly this page/)).toBeVisible();
  });

  test('a deleted template still names itself in the provenance line', async ({ page }) => {
    await setup(page, {
      role: 0,
      digest: { ...ADOPTED, template: null, template_available: false },
    });
    await page.goto(URL);

    await expect(page.getByText(/Delivery skeleton/).first()).toBeVisible();
    await expect(page.getByText(/has since been deleted/)).toBeVisible();
    // Not an error: the adoption record is denormalized precisely so it outlives
    // the template row.
    await expect(page.locator('#template-divergence').getByRole('alert')).toHaveCount(0);
  });

  test('a failed read reports itself as failed, not as "nothing to report"', async ({ page }) => {
    await setup(page, { role: 0, digestStatus: 500 });
    await page.goto(URL);

    await expect(
      page.getByText(/failed request, not an empty report/),
    ).toBeVisible();
    await expect(page.getByText('Unchanged', { exact: true })).toHaveCount(0);
  });
});
