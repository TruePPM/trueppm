import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program Settings → Rollup KPIs E2E (#527, ADR-0169).
 *
 * Verifies the settings surface is wired to ``/api/v1/programs/:id/rollup-config/``:
 * - The KPI list and aggregation policy radio render from the GET response.
 * - Toggling a KPI fires a PATCH (after the 250ms debounce).
 * - Changing the policy shows the Unsaved-changes bar; Save fires a PATCH.
 * - Non-admin role sees disabled controls and the Read-only pill.
 * - The stub-page-banner is gone (the page is no longer a stub).
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000527';

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
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 0,
  member_count: 1,
};

const FIXTURE_CONFIG = {
  enabled_kpis: ['schedule_health', 'milestone_health', 'p80_completion'],
  aggregation_policy: 'worst',
};

type Page = import('@playwright/test').Page;

interface Captures {
  lastPatchBody?: unknown;
  patchCount: number;
}

async function setup(page: Page, captures: Captures, opts: { myRole?: number } = {}) {
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
  const program = { ...FIXTURE_PROGRAM, my_role: opts.myRole ?? 400 };

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
      body: pj({ results: [program], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(program) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup-config/`, async (route) => {
    if (route.request().method() === 'PATCH') {
      captures.patchCount += 1;
      try {
        captures.lastPatchBody = JSON.parse(route.request().postData() ?? '{}');
      } catch {
        captures.lastPatchBody = null;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(FIXTURE_CONFIG),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(FIXTURE_CONFIG),
    });
  });
  // The page now hosts a live preview (#673) that calls the rollup consumer.
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        aggregation_policy: 'worst',
        policy_available: true,
        project_count: 2,
        program_health: 'at_risk',
        kpis: {
          schedule_health: { available: true, value: 'at_risk' },
          milestone_health: { available: true, value: 'on_track' },
          p80_completion: { available: false, reason: 'no_montecarlo_store' },
        },
      }),
    }),
  );
}

test.describe('Program Settings → Rollup KPIs', () => {
  test('Owner sees KPI groups, current toggles, and the policy radio', async ({ page }) => {
    const captures: Captures = { patchCount: 0 };
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/rollup`);

    await expect(page.getByRole('heading', { name: /^Rollup KPIs/ })).toBeVisible();
    // Subgroup headings render the three categories.
    await expect(page.getByRole('heading', { level: 3, name: /Schedule/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: /^Risk$/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: /^Cost$/ })).toBeVisible();

    // The three enabled KPIs from the fixture render as aria-checked switches.
    await expect(page.getByRole('switch', { name: 'Schedule health' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByRole('switch', { name: 'Milestone health' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByRole('switch', { name: 'P80 completion date' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // A KPI NOT in the fixture is off.
    await expect(page.getByRole('switch', { name: 'Risk score' })).toHaveAttribute(
      'aria-checked',
      'false',
    );

    // Stub banner is gone — the page is wired.
    await expect(page.getByTestId('stub-page-banner')).toHaveCount(0);
  });

  test('toggling a KPI fires a PATCH containing the updated enabled list', async ({ page }) => {
    const captures: Captures = { patchCount: 0 };
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/rollup`);

    await page.getByRole('switch', { name: 'Risk score' }).click();
    // Optimistic update flips the switch immediately.
    await expect(page.getByRole('switch', { name: 'Risk score' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // PATCH lands after the 250ms debounce + network round-trip.
    await expect.poll(() => captures.patchCount, { timeout: 2000 }).toBeGreaterThanOrEqual(1);
    const body = captures.lastPatchBody as { enabled_kpis?: string[] } | undefined;
    expect(body?.enabled_kpis).toContain('risk_score');
    expect(body?.enabled_kpis).toContain('schedule_health');
  });

  test('changing the aggregation policy shows Unsaved changes and Save sends a PATCH', async ({
    page,
  }) => {
    const captures: Captures = { patchCount: 0 };
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/rollup`);

    // Before any selection, no Unsaved-changes bar.
    await expect(page.getByText(/Unsaved changes/)).toHaveCount(0);

    // The radio input is sr-only; click the visible label text instead.
    await page.getByText('Average', { exact: true }).click();
    await expect(page.getByText(/Unsaved changes/)).toBeVisible();

    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect.poll(() => captures.patchCount, { timeout: 2000 }).toBeGreaterThanOrEqual(1);
    const body = captures.lastPatchBody as { aggregation_policy?: string } | undefined;
    expect(body?.aggregation_policy).toBe('average');
  });

  test('Team Member caller sees the Read-only pill and read-only KPI values', async ({ page }) => {
    const captures: Captures = { patchCount: 0 };
    await setup(page, captures, { myRole: 100 });
    await page.goto(`/programs/${PROGRAM_ID}/settings/rollup`);

    // All sections mount on one page (ADR-0146); the "Read-only" pill also appears
    // in the risk-policy section for a non-admin, so scope to the rollup section.
    const rollup = page.locator('[data-settings-section="rollup"]');
    await expect(rollup.getByRole('heading', { name: /^Rollup KPIs/ })).toBeVisible();
    await expect(rollup.getByText(/Read-only/)).toBeVisible();
    // Below-role users no longer see disabled switches (dead furniture); each KPI
    // renders its effective value + provenance (ReadOnlyIndicator, ADR-0133).
    await expect(rollup.getByRole('switch', { name: 'Schedule health' })).toHaveCount(0);
    await expect(
      rollup.getByLabel('Schedule health: On, managed by the program admin. View only.'),
    ).toBeVisible();
  });

  test('the live preview renders the program health and a deferred KPI (#673)', async ({ page }) => {
    const captures: Captures = { patchCount: 0 };
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/rollup`);

    const preview = page.getByRole('region', { name: 'Preview' });
    await expect(preview.getByLabel('Program health: At risk')).toBeVisible();
    await expect(preview.getByText('Worst-case across 2 projects')).toBeVisible();
    // Deferred KPI shows its label with an em-dash value rather than being hidden.
    await expect(preview.getByText('P80 completion')).toBeVisible();
  });

  test('a section-header field-help ⓘ opens a docs deep-link popover (#2266)', async ({ page }) => {
    const captures: Captures = { patchCount: 0 };
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/rollup`);

    const rollup = page.locator('[data-settings-section="rollup"]');
    await expect(rollup.getByRole('heading', { name: /^Rollup KPIs/ })).toBeVisible();

    // The Enabled KPIs section header carries a contextual-help ⓘ (FieldHelp).
    await rollup.getByRole('button', { name: /About the Enabled KPIs options/i }).click();

    // The popover is portaled to <body> (useAnchoredPopover), so query it at
    // page scope, not inside the section locator.
    const dialog = page.getByRole('dialog', { name: /Enabled KPIs/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link', { name: /Learn more/i })).toHaveAttribute(
      'href',
      /docs\.trueppm\.com\/administration\/program-settings/,
    );

    // Escape closes the popover (capture-phase, peels one layer) but keeps the
    // section heading — it never tears down the settings page.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(rollup.getByRole('heading', { name: /^Rollup KPIs/ })).toBeVisible();
  });
});
