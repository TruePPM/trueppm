/**
 * Working-calendar inheritance settings (ADR-0441, issue #1987) — workspace + program.
 *
 * The working calendar CPM schedules against cascades project → program → workspace →
 * system default, switched by the workspace's calendar override policy. This spec covers
 * the two new settings surfaces:
 *
 *  - Workspace working calendar: pick the org default + an override policy; the
 *    Enterprise-only "Enforce" policy is rendered disabled.
 *  - Program working calendar: under the default SUGGEST policy an Admin overrides the
 *    inherited workspace calendar; under an INHERIT policy the picker locks to it.
 *
 * All API calls are intercepted via page.route() so no backend is required.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

const pj = (data: unknown) => JSON.stringify(data);
const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: pj(body),
});

const PROGRAM_ID = 'e2e-cal-00000000-0000-0000-0000-000000001987';
const CAL_A = 'cal-a0000000-0000-0000-0000-000000000001';
const CAL_B = 'cal-b0000000-0000-0000-0000-000000000002';

const CALENDARS = {
  count: 2,
  next: null,
  previous: null,
  results: [
    { id: CAL_A, name: 'Standard 5-day (US)', working_days: 31, hours_per_day: 8 },
    { id: CAL_B, name: 'Delivery Team', working_days: 15, hours_per_day: 9 },
  ],
};

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    name: 'TrueScope Aerospace',
    subdomain: 'truescope',
    timezone: 'UTC',
    fiscal_year_start_month: 1,
    fiscal_year_start_day: 1,
    fiscal_year_start_display: 'January 1',
    work_week: [true, true, true, true, true, false, false],
    default_project_view: 'Overview',
    allow_guests: false,
    public_sharing: false,
    iteration_label: 'Sprint',
    iteration_label_override_policy: 'suggest',
    mc_history_enabled: true,
    mc_history_retention_cap: 100,
    mc_history_attribution_audience: 'ADMIN_OWNER',
    mc_history_override_policy: 'suggest',
    methodology: 'WATERFALL',
    methodology_override_policy: 'suggest',
    calendar: null,
    calendar_override_policy: 'suggest',
    ...overrides,
  };
}

const effCal = (over: Record<string, unknown> = {}) => ({
  id: CAL_A,
  name: 'Standard 5-day (US)',
  working_days: 31,
  hours_per_day: 8,
  timezone: 'UTC',
  holiday_count: 0,
  ...over,
});

function program(overrides: Record<string, unknown> = {}) {
  return {
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
    created_by: 'u1',
    created_at: '2026-05-21T00:00:00Z',
    updated_at: '2026-05-21T00:00:00Z',
    my_role: 400,
    my_role_label: 'Program Admin',
    project_count: 0,
    member_count: 1,
    // ADR-0441 fields — inherits the workspace calendar by default.
    calendar: null,
    effective_calendar: effCal(),
    inherited_calendar: effCal(),
    calendar_source: 'workspace',
    ...overrides,
  };
}

async function baseSetup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  await setupCatchAll(page);

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(json({ id: 'u1', username: 'alice', display_name: 'Alice', initials: 'AL', email: 'alice@truescope.io' })),
  );
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/calendars/**', (r) => r.fulfill(json(CALENDARS)));
}

// ---------------------------------------------------------------------------
// Workspace working calendar
// ---------------------------------------------------------------------------

test.describe('Workspace working calendar', () => {
  test('golden path — seeds the default + policy and saves a change', async ({ page }) => {
    await baseSetup(page);

    let patchBody: Record<string, unknown> | null = null;
    await page.route('**/api/v1/workspace/', (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        r.fulfill(json(workspace({ calendar: CAL_A, calendar_override_policy: 'inherit' })));
        return;
      }
      r.fulfill(json(workspace()));
    });

    await page.goto('/settings/calendar');

    const cal = page.locator('[data-settings-section="calendar"]');
    // Seeded: no workspace calendar yet → the picker shows the system default, and
    // the default SUGGEST policy is checked while Enterprise-only Enforce is disabled.
    await expect(cal.getByRole('combobox', { name: 'Default working calendar' })).toBeVisible();
    await expect(cal.getByRole('radio', { name: /Suggest \(recommended\)/i, checked: true })).toBeVisible();
    await expect(cal.getByRole('radio', { name: /Enforce/i })).toBeDisabled();

    // Choose an org default and switch the policy to Inherit, then save.
    await cal.getByRole('combobox', { name: 'Default working calendar' }).selectOption(CAL_A);
    await cal.getByText('Inherit', { exact: true }).click();
    await expect(cal.getByRole('radio', { name: /^Inherit/i, checked: true })).toBeVisible();
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody).toMatchObject({ calendar: CAL_A, calendar_override_policy: 'inherit' });
  });
});

// ---------------------------------------------------------------------------
// Program working calendar
// ---------------------------------------------------------------------------

test.describe('Program working calendar', () => {
  test('golden path — an Admin overrides the inherited workspace calendar', async ({ page }) => {
    await baseSetup(page);
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill(json(workspace({ calendar: CAL_A }))),
    );

    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        r.fulfill(json(program({ calendar: CAL_B, calendar_source: 'program', effective_calendar: effCal({ id: CAL_B, name: 'Delivery Team', working_days: 15, hours_per_day: 9 }) })));
        return;
      }
      r.fulfill(json(program()));
    });

    await page.goto(`/programs/${PROGRAM_ID}/settings/calendar`);

    const cal = page.locator('[data-settings-section="calendar"]');
    // Inherited state: no program override, so the banner names the workspace default.
    await expect(cal.getByText(/Inherited from the workspace default/i)).toBeVisible();
    await expect(cal.getByText(/Standard 5-day \(US\)/i).first()).toBeVisible();

    // Override with the program's own calendar and save.
    await cal.getByRole('combobox', { name: 'Working calendar override' }).selectOption(CAL_B);
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody).toMatchObject({ calendar: CAL_B });
  });

  test('locked state — INHERIT policy disables the picker and shows the workspace value', async ({ page }) => {
    await baseSetup(page);
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill(json(workspace({ calendar: CAL_A, calendar_override_policy: 'inherit' }))),
    );
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) => r.fulfill(json(program())));

    await page.goto(`/programs/${PROGRAM_ID}/settings/calendar`);

    const cal = page.locator('[data-settings-section="calendar"]');
    await expect(
      cal.getByText(/requires every program and project to use its default calendar/i),
    ).toBeVisible();
    // No disabled picker (ADR-0133) — the effective calendar shows read-only,
    // provenance "locked by workspace policy".
    await expect(cal.getByRole('combobox', { name: 'Working calendar override' })).toHaveCount(0);
    await expect(cal.getByRole('button', { name: /Inherit from workspace/i })).toHaveCount(0);
    await expect(
      cal.getByLabel(
        'Working calendar: Standard 5-day (US), locked by workspace policy. View only.',
      ),
    ).toBeVisible();
  });
});
