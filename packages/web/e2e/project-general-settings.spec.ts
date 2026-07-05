import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

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
 * - The working-calendar override picker (#968) seeds the current calendar,
 *   PATCHes a new selection, and clears to null via "Inherit from workspace".
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
  // Sharing override fields (ADR-0135, #978). Own override null = inherit;
  // inherited_* is what program/workspace would supply if the override were
  // cleared; effective_* resolves own ?? inherited.
  public_sharing: null,
  allow_guests: null,
  effective_public_sharing: false,
  effective_allow_guests: true,
  inherited_public_sharing: false,
  inherited_allow_guests: true,
};

// Org-level working calendars the override picker (#968) chooses from. Paginated
// envelope — the endpoint uses the global PageNumberPagination default.
const FIXTURE_CALENDARS = [
  { id: 'cal-default', name: 'Workspace standard', working_days: [1, 2, 3, 4, 5], hours_per_day: 8 },
  { id: 'cal-site', name: 'Site 6-day week', working_days: [1, 2, 3, 4, 5, 6], hours_per_day: 10 },
];

type Page = import('@playwright/test').Page;
type Route = import('@playwright/test').Route;

interface Captures {
  patch?: Record<string, unknown>;
}

async function setup(
  page: Page,
  captures: Captures,
  opts: { patchStatus?: number; patchBody?: unknown; selfRole?: number } = {},
) {
  // Role ordinals (ADR-0072): VIEWER=0, MEMBER=100, SCHEDULER=200, ADMIN=300,
  // OWNER=400. ProjectGeneralPage gates the sharing override on role >= ADMIN via
  // useCurrentUserRole → GET /projects/:id/members/?self=true. Default Admin so
  // the override chips/switch render; pass a lower selfRole to exercise read-only.
  const selfRole = opts.selfRole ?? 300;
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
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
  // Working-calendar list feeding the override picker (#968).
  await page.route('**/api/v1/calendars/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: FIXTURE_CALENDARS, count: FIXTURE_CALENDARS.length, next: null, previous: null }),
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
  // useCurrentUserRole reads the first row of this self-scoped list (a plain
  // array, not the paginated envelope). Without this the catch-all returns `[]`,
  // role resolves null, and the sharing controls would render read-only.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([{ id: 'membership-self', role: selfRole }]),
    }),
  );
}

test.describe('Project Settings → General', () => {
  test('seeds every extended field and PATCHes edited values on save', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    // Scope to the General section: all sections mount at once on the
    // consolidated page (ADR-0146), so unscoped labels like "Project code"
    // collide with the lifecycle "Type ATLAS to confirm" delete input.
    const section = page.locator('[data-settings-section="general"]');
    await expect(section.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(section.getByLabel('Project name')).toHaveValue('Atlas Migration');
    await expect(section.getByLabel('Project code')).toHaveValue('ATLAS');
    await expect(section.getByLabel('Description')).toHaveValue(
      'Migrate the data warehouse to the new platform.',
    );

    // At-risk pill starts pressed (matches FIXTURE_PROJECT.health = AT_RISK).
    // `exact` disambiguates the settings pill ("At risk") from the sidebar
    // project row, whose accessible name now embeds the health word for #960.
    await expect(section.getByRole('button', { name: 'At risk', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Timezone + default view seed from the response.
    await expect(section.getByLabel('Timezone')).toHaveValue('Europe/London');
    await expect(section.getByLabel('Default view')).toHaveValue('BOARD');

    // Flip a few fields and save.
    await section.getByRole('button', { name: 'On track' }).click();
    await section.getByLabel('Default view').selectOption('TABLE');

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

    // Scope to General — the lifecycle confirm input also matches "project code".
    const section = page.locator('[data-settings-section="general"]');
    // Client uppercases on input but does NOT pre-filter leading hyphens —
    // the user can type "-ATLAS" and only the server rejects it. This is
    // the reachable validation-error path from the UI today.
    await section.getByLabel('Project code').fill('-ATLAS');
    await expect(section.getByLabel('Project code')).toHaveValue('-ATLAS');

    await page.getByRole('button', { name: /Save changes/i }).click();

    // PATCH fires with the invalid value; the server's 400 keeps the user on
    // the page with the save bar still visible so they can correct and retry.
    // Inline error rendering is a follow-up — today the contract is just
    // "bar stays armed, no navigation away".
    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toMatchObject({ code: '-ATLAS' });
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeVisible();
  });

  // ADR-0135 / #978: the two sharing rows render via InheritableToggleField.
  // An Admin (self role 300) gets the Inherit/Override chip pair and a
  // role="switch" when overriding. Flipping and saving must PATCH
  // public_sharing / allow_guests with the overridden boolean.
  test('Admin overrides sharing and PATCHes public_sharing / allow_guests on save', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setup(page, captures); // default selfRole = 300 (Admin)
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();

    // (b) Both rows start on "Inherit"; the chip suffix reflects inherited_*
    // (allow_guests inherited On, public_sharing inherited Off).
    const guestGroup = page.getByRole('radiogroup', { name: 'Allow guest access' });
    const sharingGroup = page.getByRole('radiogroup', { name: 'Allow public link sharing' });
    await expect(guestGroup.getByText('Inherit (On)')).toBeVisible();
    await expect(sharingGroup.getByText('Inherit (Off)')).toBeVisible();

    // (a) Override public sharing → flip the revealed switch on (was inherited Off).
    await sharingGroup.getByText('Override', { exact: true }).click();
    const sharingSwitch = page.getByRole('switch', { name: 'Allow public link sharing' });
    await expect(sharingSwitch).toHaveAttribute('aria-checked', 'false');
    await sharingSwitch.click();
    await expect(sharingSwitch).toHaveAttribute('aria-checked', 'true');

    // Override allow guests → flip its switch off (was inherited On).
    await guestGroup.getByText('Override', { exact: true }).click();
    const guestSwitch = page.getByRole('switch', { name: 'Allow guest access' });
    await expect(guestSwitch).toHaveAttribute('aria-checked', 'true');
    await guestSwitch.click();
    await expect(guestSwitch).toHaveAttribute('aria-checked', 'false');

    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toMatchObject({
      public_sharing: true,
      allow_guests: false,
    });
  });

  // #968: the working-calendar override picker. Seeds the current calendar id,
  // lists the org calendars, and PATCHes the chosen id on save.
  test('override picker seeds the current calendar and PATCHes a new selection on save', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    const section = page.locator('[data-settings-section="general"]');
    await expect(section.getByRole('heading', { name: 'General' })).toBeVisible();

    // Seeds from FIXTURE_PROJECT.calendar = 'cal-default'.
    const picker = section.getByLabel('Working calendar override');
    await expect(picker).toHaveValue('cal-default');

    await picker.selectOption('cal-site');
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toMatchObject({ calendar: 'cal-site' });
  });

  test('Inherit from workspace clears the calendar override to null on save (#968)', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    const section = page.locator('[data-settings-section="general"]');
    await expect(section.getByRole('heading', { name: 'General' })).toBeVisible();

    // Gate on the seeded override before clicking Inherit — the heading renders
    // before the project GET resolves, and clicking pre-seed would set null over
    // an already-null initial value (no dirty change, save bar never arms).
    const picker = section.getByLabel('Working calendar override');
    await expect(picker).toHaveValue('cal-default');

    await section.getByRole('button', { name: 'Inherit from workspace' }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toMatchObject({ calendar: null });
  });

  // (c) Edge / read-only: a Member (role 100 < ADMIN) cannot override sharing.
  // The control collapses to a read-only indicator whose composite aria-label
  // ends "View only." and reflects the effective value + provenance — no
  // radiogroup, no switch.
  test('a Member below Admin sees a read-only sharing indicator, not the override control', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setup(page, captures, { selfRole: 100 }); // Member
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);

    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();

    // No editable affordances for either sharing row.
    await expect(page.getByRole('radiogroup', { name: 'Allow guest access' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Allow public link sharing' })).toHaveCount(0);

    // Read-only indicator: effective values are guests On (inherited true),
    // public sharing Off (inherited false), both inherited from the parent.
    await expect(
      page.getByLabel(
        'Allow guest access: On, inherited from the program or workspace default. View only.',
      ),
    ).toBeVisible();
    await expect(
      page.getByLabel(
        'Allow public link sharing: Off, inherited from the program or workspace default. View only.',
      ),
    ).toBeVisible();
  });
});
