import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program Settings → Cadence & ceremonies E2E (#528, ADR-0079).
 *
 * Verifies the wiring of the previously-stubbed page:
 * - Ceremonies render from GET /programs/{id}/ceremonies/.
 * - Add modal validates Scrum reserved names client-side before submit.
 * - Inline enable/disable toggle issues a PATCH.
 * - Phase-gate slide-over opens and PATCHes the singleton config.
 * - Team Member sees no Add or row controls.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000528';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Phase 2 Modernization',
  description: '',
  code: '',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: null,
  lead_detail: null,
  created_by: ME_ID,
  created_at: '2026-05-21T00:00:00Z',
  updated_at: '2026-05-21T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 0,
  member_count: 1,
};

const CEREMONY_SYNC = {
  id: 'cer-1',
  server_version: 1,
  program: PROGRAM_ID,
  name: 'Program sync',
  cadence_type: 'weekly' as const,
  cadence_day: 'monday',
  cadence_time: '10:00:00',
  duration_minutes: 60,
  owner_role: 'Program Manager',
  enabled: true,
  created_by: ME_ID,
  created_at: '2026-05-21T00:00:00Z',
  updated_at: '2026-05-21T00:00:00Z',
};

const CEREMONY_RISK = {
  ...CEREMONY_SYNC,
  id: 'cer-2',
  name: 'Risk review',
  cadence_type: 'biweekly' as const,
  cadence_day: 'wednesday',
  cadence_time: '11:00:00',
  duration_minutes: 45,
  owner_role: 'Risk Lead',
  enabled: false,
};

const PHASE_GATE = {
  id: 'pgc-1',
  server_version: 1,
  program: PROGRAM_ID,
  enabled: false,
  invite_template: '',
  updated_at: '2026-05-21T00:00:00Z',
};

type Page = import('@playwright/test').Page;

interface Captures {
  postedCeremony?: Record<string, unknown>;
  patchedCeremony?: { id: string; patch: Record<string, unknown> };
  patchedPhaseGate?: Record<string, unknown>;
}

async function setup(
  page: Page,
  captures: Captures,
  opts: { myRole?: number; ceremonies?: typeof CEREMONY_SYNC[] } = {},
) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: {
          accessToken: 'e2e-token',
          refreshToken: 'e2e-refresh',
          isAuthenticated: true,
        },
        version: 0,
      }),
    );
  });

  const pj = (data: unknown) => JSON.stringify(data);
  const program = { ...FIXTURE_PROGRAM, my_role: opts.myRole ?? 400 };
  const ceremonies = opts.ceremonies ?? [CEREMONY_SYNC, CEREMONY_RISK];

  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
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
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [program], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(program) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  // Item-level routes must register before the collection so Playwright's
  // last-registered-wins match picks the more specific URL first.
  await page.route(
    `**/api/v1/programs/${PROGRAM_ID}/ceremonies/*/`,
    async (route) => {
      const url = route.request().url();
      const id =
        url.replace(/\?.*$/, '').split('/').filter(Boolean).pop() ?? '';
      const method = route.request().method();
      if (method === 'PATCH') {
        const body = JSON.parse(route.request().postData() ?? '{}');
        captures.patchedCeremony = { id, patch: body };
        const target = ceremonies.find((c) => c.id === id) ?? ceremonies[0];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...target, ...body, server_version: target.server_version + 1 }),
        });
        return;
      }
      if (method === 'DELETE') {
        await route.fulfill({ status: 204, contentType: 'application/json', body: '' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    },
  );
  await page.route(
    `**/api/v1/programs/${PROGRAM_ID}/ceremonies/`,
    async (route) => {
      const method = route.request().method();
      if (method === 'POST') {
        const body = JSON.parse(route.request().postData() ?? '{}');
        captures.postedCeremony = body;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: pj({ ...CEREMONY_SYNC, id: 'cer-new', ...body }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(ceremonies),
      });
    },
  );
  await page.route(
    `**/api/v1/programs/${PROGRAM_ID}/phase-gate-config/`,
    async (route) => {
      const method = route.request().method();
      if (method === 'PATCH') {
        const body = JSON.parse(route.request().postData() ?? '{}');
        captures.patchedPhaseGate = body;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...PHASE_GATE, ...body, server_version: 2 }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(PHASE_GATE),
      });
    },
  );
}

test.describe('Program Settings → Cadence & ceremonies', () => {
  test('Admin sees real ceremonies and can add a new one', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/cadence`);

    await expect(
      page.getByRole('heading', { name: /Cadence & ceremonies/ }),
    ).toBeVisible();
    await expect(page.getByText('Program sync')).toBeVisible();
    await expect(page.getByText('Risk review')).toBeVisible();
    await expect(page.getByText(/Weekly · Monday 10:00/)).toBeVisible();
    await expect(page.getByText(/Bi-weekly · Wednesday 11:00/)).toBeVisible();

    // Stub banner must not render once wired.
    await expect(page.getByTestId('stub-page-banner')).toHaveCount(0);

    // Open modal and submit.
    await page.getByRole('button', { name: /\+ Add ceremony/ }).click();
    const addCeremony = page.getByRole('dialog', { name: /Add ceremony/ });
    await expect(addCeremony).toBeVisible();
    await addCeremony.getByLabel(/^Name/).fill('Steering committee');
    await page.getByRole('button', { name: /^Save$/ }).click();

    await expect.poll(() => captures.postedCeremony?.name).toBe('Steering committee');
  });

  test('Scrum reserved name is rejected in the modal before submit', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/cadence`);

    await page.getByRole('button', { name: /\+ Add ceremony/ }).click();
    await page
      .getByRole('dialog', { name: /Add ceremony/ })
      .getByLabel(/^Name/)
      .fill('Sprint Planning');

    // Inline alert renders and Save is disabled.
    await expect(
      page.getByText(/Sprint events are configured per-sprint/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeDisabled();
    expect(captures.postedCeremony).toBeUndefined();
  });

  test('toggling enabled issues a PATCH', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/cadence`);

    await page.getByRole('switch', { name: /Disable Program sync/ }).click();
    await expect
      .poll(() => captures.patchedCeremony?.id)
      .toBe(CEREMONY_SYNC.id);
    expect(captures.patchedCeremony?.patch).toEqual({ enabled: false });
  });

  test('phase-gate slide-over saves invite template', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/cadence`);

    await page.getByRole('button', { name: /Configure gate template/ }).click();
    await expect(
      page.getByRole('dialog', { name: /Phase gate calendar/ }),
    ).toBeVisible();
    await page.getByLabel(/Invite template/).fill('Subject: gate review');
    await page.getByRole('button', { name: /^Save$/ }).click();

    await expect
      .poll(() => captures.patchedPhaseGate?.invite_template)
      .toBe('Subject: gate review');
  });

  test('Team Member sees no Add button and no row controls', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures, { myRole: 100 });
    await page.goto(`/programs/${PROGRAM_ID}/settings/cadence`);

    await expect(page.getByRole('button', { name: /\+ Add ceremony/ })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: /More options/ })).toHaveCount(0);
    // Toggle is rendered but disabled.
    const toggle = page.getByRole('switch', { name: /Disable Program sync/ });
    await expect(toggle).toBeDisabled();
  });
});
