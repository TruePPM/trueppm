import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Workspace + Program Settings → Agents E2E (#2700, #2716, ADR-0678).
 *
 * The MCP read-consent cascade is restrictive-only: any scope may block, none may
 * re-enable what a higher scope blocked. Covers the golden path at each scope
 * (one PATCH carrying `mcp_enabled`) and the disabled-by-parent state at program
 * scope, where the page must say the workspace's block wins.
 */

type Page = import('@playwright/test').Page;
type Captures = { patch?: Record<string, unknown> };

const pj = (data: unknown) => JSON.stringify(data);
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000002700';

const WORKSPACE = {
  name: 'TrueScope Aerospace',
  subdomain: 'truescope',
  timezone: 'America/Los_Angeles',
  fiscal_year_start_month: 1,
  fiscal_year_start_day: 1,
  fiscal_year_start_display: 'January 1',
  work_week: [true, true, true, true, true, false, false],
  default_project_view: 'Board',
  allow_guests: true,
  public_sharing: false,
  public_sharing_override_policy: 'suggest',
  iteration_label: 'Sprint',
  iteration_label_override_policy: 'suggest',
  mc_history_enabled: true,
  mc_history_retention_cap: 100,
  mc_history_attribution_audience: 'admin_owner',
  mc_history_override_policy: 'suggest',
  near_critical_threshold_days: 10,
  mcp_enabled: true,
};

const PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Phase 2 Modernization',
  description: '',
  code: 'PH2',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: null,
  lead_detail: null,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 0,
  member_count: 1,
  is_closed: false,
  // Own value null = no opinion; inherited_* is the workspace's value.
  mcp_enabled: null,
  effective_mcp_enabled: true,
  inherited_mcp_enabled: true,
};

async function setup(page: Page) {
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
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        id: 'u1',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'alice@truescope.io',
        can_access_admin_settings: true,
        workspace_role: 300,
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

async function mockWorkspace(page: Page, captures: Captures, ws = WORKSPACE) {
  await page.route('**/api/v1/workspace/', async (route) => {
    if (route.request().method() === 'PATCH') {
      captures.patch = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...ws, ...captures.patch }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: pj(ws) });
  });
}

async function mockProgram(page: Page, captures: Captures, program: Record<string, unknown>) {
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [program], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, async (route) => {
    if (route.request().method() === 'PATCH') {
      captures.patch = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...program, ...captures.patch }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: pj(program) });
  });
}

test.describe('Workspace Settings → Agents', () => {
  test('is a two-state switch and PATCHes mcp_enabled:false when blocked', async ({ page }) => {
    const captures: Captures = {};
    await setup(page);
    await mockWorkspace(page, captures);
    await page.goto('/settings#agents');

    const section = page.locator('[data-settings-section="agents"]');
    await expect(section.getByRole('heading', { name: 'Agents' })).toBeVisible();
    // The workspace is the root of the cascade: no Inherit state.
    await expect(section.getByRole('radio')).toHaveCount(0);
    const toggle = section.getByRole('switch', { name: 'Agent read access' });
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect(section.getByTestId('agent-access-workspace-note')).toContainText(
      'cannot re-enable',
    );
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => captures.patch).toBeTruthy();
    expect(captures.patch).toMatchObject({ mcp_enabled: false });
  });

  test('loads Blocked from the server and says lower scopes cannot lift it', async ({ page }) => {
    await setup(page);
    await mockWorkspace(page, {}, { ...WORKSPACE, mcp_enabled: false });
    await page.goto('/settings#agents');

    const section = page.locator('[data-settings-section="agents"]');
    await expect(section.getByRole('switch', { name: 'Agent read access' })).not.toBeChecked();
    await expect(section.getByTestId('agent-access-workspace-note')).toContainText('blocked');
  });
});

test.describe('Program Settings → Agents', () => {
  test('starts inheriting and PATCHes mcp_enabled:false when blocked', async ({ page }) => {
    const captures: Captures = {};
    await setup(page);
    await mockWorkspace(page, {});
    await mockProgram(page, captures, PROGRAM);
    await page.goto(`/programs/${PROGRAM_ID}/settings#agents`);

    const section = page.locator('[data-settings-section="agents"]');
    await expect(section.getByRole('heading', { name: 'Agents' })).toBeVisible();
    await expect(section.getByTestId('agent-access-blocked-above-note')).toHaveCount(0);

    const group = section.getByRole('radiogroup', { name: 'Agent read access' });
    await group.locator('label', { hasText: 'Override' }).click();
    await section.getByRole('switch', { name: 'Agent read access' }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => captures.patch).toBeTruthy();
    expect(captures.patch).toMatchObject({ mcp_enabled: false });
  });

  test('says so when the workspace has blocked agents — a program cannot re-enable', async ({
    page,
  }) => {
    await setup(page);
    await mockWorkspace(page, {}, { ...WORKSPACE, mcp_enabled: false });
    await mockProgram(
      page,
      {},
      {
        ...PROGRAM,
        inherited_mcp_enabled: false,
        effective_mcp_enabled: false,
      },
    );
    await page.goto(`/programs/${PROGRAM_ID}/settings#agents`);

    const section = page.locator('[data-settings-section="agents"]');
    await expect(section.getByTestId('agent-access-blocked-above-note')).toContainText(
      'blocked at the workspace level',
    );
  });
});
