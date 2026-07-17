/**
 * Methodology cascade settings (ADR-0107, issues 955 / 1169) — workspace + project.
 *
 * The planning methodology (Agile / Waterfall / Hybrid) cascades
 * workspace → program → project, switched by the workspace's override policy.
 * This spec covers the two new settings surfaces:
 *
 *  - Workspace methodology defaults: pick a default method + an override policy;
 *    the Enterprise-only "Enforce" policy is rendered disabled.
 *  - Project methodology: an Admin overrides the method under the default SUGGEST
 *    policy; under an INHERIT policy the picker locks to the workspace value.
 *
 * All API calls are intercepted via page.route() so no backend is required.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

const pj = (data: unknown) => JSON.stringify(data);
const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: pj(body),
});

const PROJECT_ID = 'e2e-meth-00000000-0000-0000-0000-000000000955';

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
    ...overrides,
  };
}

function projectDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    server_version: 1,
    name: 'Methodology Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: null,
    estimation_mode: 'open',
    agile_features: true,
    iteration_label: 'Sprint',
    methodology: 'AGILE',
    effective_methodology: 'AGILE',
    inherited_methodology: 'WATERFALL',
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

  // Catch-all 401-guard — keeps unmocked requests from tripping the session loop.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(
      json({
        id: 'u1',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'alice@truescope.io',
      }),
    ),
  );
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
}

// ---------------------------------------------------------------------------
// Workspace methodology defaults
// ---------------------------------------------------------------------------

test.describe('Workspace methodology defaults', () => {
  test('golden path — seeds the method + policy and saves a change', async ({ page }) => {
    await baseSetup(page);

    let patchBody: Record<string, unknown> | null = null;
    await page.route('**/api/v1/workspace/', (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        r.fulfill(json(workspace({ methodology: 'AGILE', methodology_override_policy: 'inherit' })));
        return;
      }
      r.fulfill(json(workspace()));
    });

    await page.goto('/settings/methodology');

    // The consolidated settings page (#1248) mounts every section at once, so the
    // iteration-label policy radios (Suggest/Inherit/Enforce) share the page with
    // the methodology ones — scope methodology assertions to the section (rule 195).
    const methodology = page.locator('[data-settings-section="methodology"]');

    // Seeded selection — Waterfall + Suggest.
    await expect(methodology.getByRole('radio', { name: /Waterfall/i, checked: true })).toBeVisible();
    await expect(
      methodology.getByRole('radio', { name: /Suggest \(recommended\)/i, checked: true }),
    ).toBeVisible();

    // The Enterprise-only Enforce policy is rendered but disabled.
    await expect(methodology.getByRole('radio', { name: /Enforce/i })).toBeDisabled();

    // Change the default method and policy, then save via the page save bar.
    // The method cards are <button role="radio"> (clickable directly). The policy
    // options are an sr-only <input type="radio"> inside a <label>; the input has
    // zero hit area, so click the visible label text — the label forwards to the
    // input's onChange. (check()/clicking the input is intercepted by the label.)
    await methodology.getByRole('radio', { name: /Agile/i }).click();
    await methodology.getByText('Inherit', { exact: true }).click();
    await expect(methodology.getByRole('radio', { name: /^Inherit/i, checked: true })).toBeVisible();
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody).toMatchObject({ methodology: 'AGILE', methodology_override_policy: 'inherit' });
  });
});

// ---------------------------------------------------------------------------
// Project methodology
// ---------------------------------------------------------------------------

test.describe('Project methodology', () => {
  async function projectRoutes(
    page: Page,
    opts: { ws?: Record<string, unknown>; project?: Record<string, unknown>; role?: number } = {},
  ) {
    const role = opts.role ?? 300; // Admin
    await page.route('**/api/v1/workspace/', (r) => r.fulfill(json(workspace(opts.ws))));
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
      r.fulfill(json([{ id: 'mem-1', role }])),
    );
    await page.route('**/api/v1/projects/*/presence/', (r) => r.fulfill(json([])));
  }

  test('golden path — an Admin overrides the method under SUGGEST', async ({ page }) => {
    await baseSetup(page);
    await projectRoutes(page);

    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        r.fulfill(json(projectDetail({ methodology: 'WATERFALL', effective_methodology: 'WATERFALL' })));
        return;
      }
      r.fulfill(json(projectDetail()));
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    const methodology = page.locator('[data-settings-section="methodology"]');
    // Seeded from the project's own method, with the inherited default surfaced.
    await expect(methodology.getByRole('radio', { name: /Agile/i, checked: true })).toBeVisible();
    await expect(methodology.getByText(/Inherited from the workspace default/i)).toBeVisible();

    // Override to Waterfall and save.
    await methodology.getByRole('radio', { name: /Waterfall/i }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody).toMatchObject({ methodology: 'WATERFALL' });
  });

  test('surfaces estimate governance and saves only estimation_mode (#2018)', async ({ page }) => {
    await baseSetup(page);
    await projectRoutes(page);

    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        r.fulfill(json(projectDetail({ estimation_mode: 'pm_only' })));
        return;
      }
      r.fulfill(json(projectDetail()));
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    const methodology = page.locator('[data-settings-section="methodology"]');
    const estimation = methodology.getByRole('combobox', { name: 'Estimate governance' });
    await expect(estimation).toHaveValue('open');

    await estimation.selectOption('pm_only');
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => patchBody).not.toBeNull();
    // Methodology was untouched → only estimation_mode is sent.
    expect(patchBody).toMatchObject({ estimation_mode: 'pm_only' });
    expect(patchBody).not.toHaveProperty('methodology');
  });

  test('keeps estimate governance editable under an INHERIT methodology lock (#2018)', async ({
    page,
  }) => {
    await baseSetup(page);
    await projectRoutes(page, { ws: { methodology_override_policy: 'inherit' } });

    let patchBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        r.fulfill(json(projectDetail({ estimation_mode: 'pm_only' })));
        return;
      }
      r.fulfill(json(projectDetail({ methodology: 'AGILE', effective_methodology: 'WATERFALL' })));
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);
    const methodology = page.locator('[data-settings-section="methodology"]');

    // Methodology is locked by the workspace policy…
    await expect(methodology.getByRole('radio', { name: /Agile/i })).toBeDisabled();
    // …but estimate governance is independent — still editable, saves on its own.
    const estimation = methodology.getByRole('combobox', { name: 'Estimate governance' });
    await expect(estimation).toBeEnabled();
    await estimation.selectOption('pm_only');
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => patchBody).not.toBeNull();
    expect(patchBody).toMatchObject({ estimation_mode: 'pm_only' });
    expect(patchBody).not.toHaveProperty('methodology');
  });

  test('locked state — INHERIT policy disables the picker and shows the workspace value', async ({
    page,
  }) => {
    await baseSetup(page);
    await projectRoutes(page, { ws: { methodology_override_policy: 'inherit' } });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
      r.fulfill(json(projectDetail({ methodology: 'AGILE', effective_methodology: 'WATERFALL' }))),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

    const methodology = page.locator('[data-settings-section="methodology"]');
    // The lock context message is shown.
    await expect(
      methodology.getByText(/requires every project to use its default methodology/i),
    ).toBeVisible();

    // The locked picker shows the workspace-resolved value (Waterfall) read-only —
    // no disabled radios (ADR-0133): effective value + provenance instead.
    await expect(methodology.getByRole('radio')).toHaveCount(0);
    await expect(
      methodology.getByLabel('Methodology: Waterfall, locked by workspace policy. View only.'),
    ).toBeVisible();
  });
});
