/**
 * Workspace → Programs bulk-edit matrix (#1283, ADR-0161).
 *
 * The second mount of the entity-agnostic BulkFieldsMatrix: a workspace admin selects
 * programs and sets one inherited/policy field across them in a single atomic
 * POST /api/v1/programs/bulk-fields/. Lives inline as the `programs` section of the
 * consolidated workspace settings page (#1248), so assertions are scoped to the
 * section's `data-settings-section` to dodge the SettingsShell strict-mode collisions
 * (other sections mount the same radio/checkbox roles).
 *
 * All API calls are intercepted via page.route() so no backend is required.
 */
import { test, expect, type Page } from '@playwright/test';

const pj = (data: unknown) => JSON.stringify(data);
const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: pj(body),
});

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
    mc_history_override_policy: 'allow',
    methodology: 'WATERFALL',
    methodology_override_policy: 'suggest',
    ...overrides,
  };
}

function program(over: Record<string, unknown> = {}) {
  return {
    id: 'pg-1',
    server_version: 1,
    name: 'Apollo',
    description: '',
    methodology: 'HYBRID',
    effective_methodology: 'HYBRID',
    inherited_methodology: 'HYBRID',
    iteration_label: null,
    inherited_iteration_label: 'Sprint',
    risk_slip_propagation: 'warn',
    risk_escalation_days: 3,
    health: 'AUTO',
    my_role: 400,
    project_count: 2,
    member_count: 1,
    ...over,
  };
}

async function baseSetup(page: Page, opts: { workspaceRole?: number } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Catch-all 401-guard — keeps unmocked requests from tripping the session loop.
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(
      json({
        id: 'u1',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'alice@truescope.io',
        workspace_role: opts.workspaceRole ?? 300,
      }),
    ),
  );
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/workspace/', (r) => r.fulfill(json(workspace())));
}

const PROGRAMS = [
  program({ id: 'pg-1', name: 'Apollo' }),
  program({ id: 'pg-2', name: 'Gemini', risk_slip_propagation: 'none' }),
];

test.describe('Workspace → Programs bulk matrix', () => {
  test('golden path — an admin bulk-sets slip propagation across selected programs', async ({
    page,
  }) => {
    await baseSetup(page);
    await page.route('**/api/v1/programs/', (r) =>
      r.fulfill(json({ count: PROGRAMS.length, next: null, previous: null, results: PROGRAMS })),
    );

    let postBody: Record<string, unknown> | null = null;
    await page.route('**/api/v1/programs/bulk-fields/', (r) => {
      postBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
      r.fulfill(
        json({
          updated: PROGRAMS.map((p) => ({ id: p.id, server_version: 2 })),
          fields: ['risk_slip_propagation'],
        }),
      );
    });

    await page.goto('/settings/programs');

    const section = page.locator('[data-settings-section="programs"]');
    await expect(section.getByText('Apollo')).toBeVisible();
    await expect(section.getByText('Gemini')).toBeVisible();

    // Select both programs, switch the field picker to Slip propagation, set Block & escalate.
    await section.getByLabel('Select all rows').check();
    await section.getByLabel('Field to set').selectOption({ label: 'Slip propagation' });
    await section.getByRole('radio', { name: 'Block & escalate' }).click();
    await section.getByTestId('bulk-fields-apply').click();

    await expect.poll(() => postBody).not.toBeNull();
    expect(postBody).toMatchObject({
      ids: ['pg-1', 'pg-2'],
      fields: { risk_slip_propagation: 'block' },
    });
  });

  test('read-only — a non-admin member sees the matrix without the edit action bar', async ({
    page,
  }) => {
    await baseSetup(page, { workspaceRole: 100 });
    await page.route('**/api/v1/programs/', (r) =>
      r.fulfill(json({ count: PROGRAMS.length, next: null, previous: null, results: PROGRAMS })),
    );

    await page.goto('/settings/programs');

    const section = page.locator('[data-settings-section="programs"]');
    await expect(section.getByText('Apollo')).toBeVisible();
    // No bulk action bar and no per-row selection without workspace-admin rights.
    await expect(section.getByTestId('bulk-fields-action-bar')).toHaveCount(0);
    await expect(section.getByLabel('Select Apollo')).toHaveCount(0);
  });
});
