import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program Settings → General E2E (#523).
 *
 * Verifies the page is wired to the real `/api/v1/programs/:id/` endpoint:
 * - Initial values seed from the GET response (name, description, code,
 *   methodology, health, visibility, lead_detail).
 * - Editing a field arms the save bar.
 * - Clicking Save issues a PATCH carrying the changed fields.
 * - Discard reverts to the seeded snapshot.
 */

const ME_ID = 'user-alice';
const LEAD_ID = 'user-lead';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000523';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_LEAD_DETAIL = {
  id: LEAD_ID,
  username: 'anika.k',
  email: 'anika@example.com',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Phase 2 Modernization',
  description: 'Q3 platform rebuild',
  code: 'PH2',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: LEAD_ID,
  lead_detail: FIXTURE_LEAD_DETAIL,
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 2,
  member_count: 1,
  // Sharing override fields (ADR-0135, #978). Own override null = inherit; the
  // effective_* values resolve own ?? inherited; inherited_* is what the parent
  // (workspace) would supply if the override were cleared.
  public_sharing: null,
  allow_guests: null,
  effective_public_sharing: false,
  effective_allow_guests: true,
  inherited_public_sharing: false,
  inherited_allow_guests: true,
};

type Page = import('@playwright/test').Page;

async function setup(page: Page, captures: { patch?: Record<string, unknown> }) {
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
      body: pj({ results: [FIXTURE_PROGRAM], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, async (route) => {
    if (route.request().method() === 'PATCH') {
      captures.patch = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...FIXTURE_PROGRAM, ...captures.patch }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(FIXTURE_PROGRAM),
    });
  });
}

test.describe('Program Settings → General', () => {
  test('seeds fields from the API and PATCHes edited values on save', async ({ page }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    // All sections mount on one page (ADR-0146) — scope to the general section so
    // shared labels (e.g. "Program code" also appears in the lifecycle delete-confirm
    // field) don't trip strict mode.
    const general = page.locator('[data-settings-section="general"]');
    await expect(general.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(general.getByLabel('Program name')).toHaveValue('Phase 2 Modernization');
    await expect(general.getByLabel('Program code')).toHaveValue('PH2');
    await expect(general.getByLabel('Description')).toHaveValue('Q3 platform rebuild');

    // Lead block renders the username from lead_detail (no hardcoded "Anika Krishnan").
    await expect(general.getByText('anika.k')).toBeVisible();
    await expect(general.getByText('Anika Krishnan')).toHaveCount(0);

    // Edit the name and flip health to At risk.
    await general.getByLabel('Program name').fill('Phase 2 Rebuilt');
    await general.getByRole('button', { name: 'At risk' }).click();

    // Save bar arms — click "Save changes" (provided by SettingsShell).
    await page.getByRole('button', { name: /Save changes/i }).click();

    // PATCH issued with the consolidated payload (waits for the route handler
    // to populate captures.patch).
    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toMatchObject({
      name: 'Phase 2 Rebuilt',
      health: 'AT_RISK',
    });
  });

  // #2266: jargon/policy/cascade fields carry a FieldHelp ⓘ (web-rule 263) that
  // opens a non-modal dialog with a "Learn more →" deep-link into the docs.
  test('opens a field-help popover with a docs deep-link', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const general = page.locator('[data-settings-section="general"]');
    await expect(general.getByRole('heading', { name: 'General' })).toBeVisible();

    await general.getByRole('button', { name: /About the Methodology options/i }).click();

    const dialog = page.getByRole('dialog', { name: /Methodology/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link', { name: /Learn more/i })).toHaveAttribute(
      'href',
      /docs\.trueppm\.com\/features\/methodology-preset/,
    );

    // Escape peels only the popover (capture-phase handler, web-rule 263f) — the
    // settings page stays put.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(general.getByRole('heading', { name: 'General' })).toBeVisible();
  });

  // #790 / ADR-0095 / #1920: program navigation lives in the left rail's "This
  // program" tier, which persists across settings routes with the Settings entry
  // active. There is no in-content program tab strip, so the shared SettingsShell
  // (and its SCOPE switcher) mounts top-aligned, identical to the workspace and
  // project scopes — the #776 top-alignment fix is preserved, just without any
  // chrome to suppress.
  test('keeps program nav in the rail with Settings active, settings shell top-aligned', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const general = page.locator('[data-settings-section="general"]');
    await expect(general.getByRole('heading', { name: 'General' })).toBeVisible();
    // The program nav now lives in the rail and persists here, Settings active.
    const programNav = page.getByRole('navigation', { name: 'Program' });
    await expect(programNav.getByRole('link', { name: /Backlog/i })).toBeVisible();
    await expect(programNav.getByRole('link', { name: /Settings/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The settings shell still rendered its own scroll-spy rail (ADR-0146) — the
    // section items are buttons, not links. Scope to the settings nav region.
    const settingsNav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(settingsNav.getByRole('button', { name: 'Risk policy', exact: true })).toBeVisible();
  });

  // #776: the context pill is a switcher — from one program's settings you can
  // jump straight to another program's settings (preserving the sub-page),
  // instead of having no path to it.
  test('context pill switches to another program\'s settings', async ({ page }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    await setup(page, captures);

    const PROGRAM_2 = 'e2e-program-00000000-0000-0000-0000-000000000524';
    const pj = (d: unknown) => JSON.stringify(d);
    const FIXTURE_PROGRAM_2 = {
      ...FIXTURE_PROGRAM,
      id: PROGRAM_2,
      name: 'Phase 3 Rollout',
      code: 'PH3',
      health: 'ON_TRACK',
    };
    // Two programs → the switcher renders (registered after setup so it wins).
    await page.route('**/api/v1/programs/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ results: [FIXTURE_PROGRAM, FIXTURE_PROGRAM_2], count: 2, next: null, previous: null }),
      }),
    );
    await page.route(`**/api/v1/programs/${PROGRAM_2}/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM_2) }),
    );

    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);
    const general = page.locator('[data-settings-section="general"]');
    await expect(general.getByLabel('Program name')).toHaveValue('Phase 2 Modernization');

    // Open the switcher and pick the other program.
    await page.getByRole('button', { name: /Switch program/ }).click();
    await expect(page.getByRole('listbox', { name: 'Switch program' })).toBeVisible();
    await page.getByRole('option', { name: /Phase 3 Rollout/ }).click();

    // Navigated to program 2's consolidated settings page (one page per entity,
    // ADR-0146 — no per-section route segment).
    await page.waitForURL(`**/programs/${PROGRAM_2}/settings`);
    await expect(general.getByLabel('Program name')).toHaveValue('Phase 3 Rollout');
    await expect(page.getByRole('button', { name: /Current program: Phase 3 Rollout/ })).toBeVisible();
  });

  // #776 follow-on: with many programs the switcher gains a type-to-filter search
  // box so you don't have to scan the whole list.
  test('context switcher filters by search when there are many programs', async ({ page }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    await setup(page, captures);

    const pj = (d: unknown) => JSON.stringify(d);
    // 8 programs → search box appears (threshold). Include a uniquely-named target.
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...FIXTURE_PROGRAM,
      id: `e2e-prog-many-${i}`,
      name: `Program ${i}`,
      code: `PG${i}`,
    }));
    const ZENITH = 'e2e-prog-zenith-0000-0000-0000-000000000999';
    const FIXTURE_ZENITH = { ...FIXTURE_PROGRAM, id: ZENITH, name: 'Zenith Initiative', code: 'ZEN' };
    await page.route('**/api/v1/programs/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ results: [FIXTURE_PROGRAM, ...many, FIXTURE_ZENITH], count: 9, next: null, previous: null }),
      }),
    );
    await page.route(`**/api/v1/programs/${ZENITH}/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ZENITH) }),
    );

    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);
    await page.getByRole('button', { name: /Switch program/ }).click();

    // Search box present; typing narrows to the matching program.
    const search = page.getByRole('combobox', { name: 'Find a program' });
    await expect(search).toBeVisible();
    await search.fill('zenith');
    await expect(page.getByRole('option')).toHaveCount(1);

    // Enter selects the single match and navigates to its settings.
    await search.press('Enter');
    await page.waitForURL(`**/programs/${ZENITH}/settings`);
    await expect(
      page.locator('[data-settings-section="general"]').getByLabel('Program name'),
    ).toHaveValue('Zenith Initiative');
  });

  test('discard reverts edited fields to the seeded snapshot', async ({ page }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const general = page.locator('[data-settings-section="general"]');
    await expect(general.getByLabel('Program name')).toHaveValue('Phase 2 Modernization');

    await general.getByLabel('Program name').fill('Should Be Discarded');
    await expect(general.getByLabel('Program name')).toHaveValue('Should Be Discarded');

    // The shell save-bar Discard button reverts immediately (no confirmation modal —
    // ConfirmDiscardDialog only gates pending-nav scenarios in SettingsShell).
    await page.getByRole('button', { name: /^Discard$/ }).click();

    await expect(general.getByLabel('Program name')).toHaveValue('Phase 2 Modernization');
    expect(captures.patch).toBeUndefined();
  });

  // ADR-0135 / #978: the two sharing rows render via InheritableToggleField.
  // Admin (my_role=400) gets the Inherit/Override chip pair plus a role="switch"
  // when overriding. Flipping the switch and saving must PATCH public_sharing /
  // allow_guests with the overridden boolean.
  test('Admin overrides sharing and PATCHes public_sharing / allow_guests on save', async ({
    page,
  }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const general = page.locator('[data-settings-section="general"]');
    await expect(general.getByRole('heading', { name: 'General' })).toBeVisible();

    // (b) Both rows start on "Inherit", and the chip suffix reflects inherited_*
    // (allow_guests inherited On, public_sharing inherited Off).
    const guestGroup = general.getByRole('radiogroup', { name: 'Allow guest access' });
    const sharingGroup = general.getByRole('radiogroup', { name: 'Allow public link sharing' });
    await expect(guestGroup.getByText('Inherit (On)')).toBeVisible();
    await expect(sharingGroup.getByText('Inherit (Off)')).toBeVisible();

    // (a) Override public sharing, then flip the revealed switch to On.
    await sharingGroup.getByText('Override', { exact: true }).click();
    const sharingSwitch = general.getByRole('switch', { name: 'Allow public link sharing' });
    await expect(sharingSwitch).toBeVisible();
    // Seeded from the effective value (inherited Off) → starts unchecked.
    await expect(sharingSwitch).toHaveAttribute('aria-checked', 'false');
    await sharingSwitch.click();
    await expect(sharingSwitch).toHaveAttribute('aria-checked', 'true');

    // Override allow guests and flip its switch to Off (was inherited On).
    await guestGroup.getByText('Override', { exact: true }).click();
    const guestSwitch = general.getByRole('switch', { name: 'Allow guest access' });
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

  // (c) Edge: re-selecting "Inherit" after overriding clears the override back to
  // null. With a clean form (no other edits) the save bar is not armed, so we
  // assert the switch disappears and the inheriting body line returns instead.
  test('selecting Inherit clears a sharing override back to the inherited value', async ({
    page,
  }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const general = page.locator('[data-settings-section="general"]');
    const sharingGroup = general.getByRole('radiogroup', { name: 'Allow public link sharing' });
    await sharingGroup.getByText('Override', { exact: true }).click();
    await expect(general.getByRole('switch', { name: 'Allow public link sharing' })).toBeVisible();

    // Back to Inherit → switch is gone, inheriting line shows the workspace value.
    await sharingGroup.getByText(/^Inherit/).click();
    await expect(general.getByRole('switch', { name: 'Allow public link sharing' })).toHaveCount(0);
    await expect(sharingGroup.getByText('Inherit (Off)')).toBeVisible();
  });

  // #2008: clicking an inheritable "Override" chip focuses its visually-hidden
  // (`sr-only`, position:absolute) radio. Before the fix, that focused radio's
  // containing block escaped the (non-positioned) settings scroll container, so
  // the browser scrolled the WINDOW to reveal it — pushing the h-screen app up
  // and blanking the screen. The scroll authority is now a positioned containing
  // block, so focus-scroll stays inside it and the window never moves.
  test('overriding an inheritable setting does not scroll the window (no blank screen)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const general = page.locator('[data-settings-section="general"]');
    await expect(general.getByRole('heading', { name: 'General' })).toBeVisible();

    // Scroll the (below-the-fold) Run history limit override into the container's
    // view, then click Override — the exact reported gesture.
    const runHistory = general.getByRole('radiogroup', { name: 'Run history limit' });
    await runHistory.scrollIntoViewIfNeeded();
    const scrollYBefore = await page.evaluate(() => window.scrollY);

    await runHistory.getByText('Override', { exact: true }).click();

    // The override input revealed (the click registered)…
    await expect(general.getByRole('spinbutton', { name: 'Run history limit' })).toBeVisible();
    // …and the click did NOT scroll the window (the regression: pre-fix the focused
    // sr-only radio scrolled the h-screen app up by ~890px, blanking the screen).
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    expect(Math.abs(scrollYAfter - scrollYBefore)).toBeLessThan(50);
    // The field the user acted on is still within the viewport, not pushed off-screen.
    await expect(runHistory).toBeInViewport();
  });
});
