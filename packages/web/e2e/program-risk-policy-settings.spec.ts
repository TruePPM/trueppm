import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program Settings → Risk & deps policy E2E (#529).
 *
 * Verifies the settings surface is wired to ``/api/v1/programs/:id/risk-policy/``:
 * - The slip-propagation radio and escalation_days input render from GET.
 * - Changing either field arms the shell save bar; Save fires a PATCH.
 * - Non-admin role sees disabled controls and the Read-only pill.
 * - The stub-page-banner is gone (the page is no longer a stub).
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000529';

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
  created_at: '2026-05-22T00:00:00Z',
  updated_at: '2026-05-22T00:00:00Z',
  my_role: 400,
  my_role_label: 'Project Admin',
  project_count: 0,
  member_count: 1,
};

const FIXTURE_POLICY = {
  slip_propagation: 'warn',
  escalation_days: 3,
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
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/risk-policy/`, async (route) => {
    if (route.request().method() === 'PATCH') {
      captures.patchCount += 1;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(route.request().postData() ?? '{}');
      } catch {
        // Fall through with empty body — the assertion will fail and surface the bug.
      }
      captures.lastPatchBody = body;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...FIXTURE_POLICY, ...body }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(FIXTURE_POLICY),
    });
  });
}

test.describe('Program Settings → Risk & deps policy', () => {
  test('Owner sees the matrix, the slip radio, and the escalation input', async ({ page }) => {
    const captures: Captures = { patchCount: 0 };
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/risk`);

    await expect(page.getByRole('heading', { name: /Risk & deps policy/ })).toBeVisible();
    // Matrix legend chips render at the bottom of the read-only matrix.
    await expect(page.getByRole('heading', { level: 2, name: /Risk matrix/ })).toBeVisible();
    // The warn radio is the default fixture; the sr-only input carries the checked state.
    await expect(page.getByRole('radio', { name: /Warn only/ })).toBeChecked();
    await expect(page.getByRole('spinbutton')).toHaveValue('3');
    // Stub banner is gone — the page is wired.
    await expect(page.getByTestId('stub-page-banner')).toHaveCount(0);
  });

  test('changing the slip radio arms the save bar and Save sends a PATCH', async ({ page }) => {
    const captures: Captures = { patchCount: 0 };
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/risk`);

    // Wait for the page to settle and the seed effect to run.
    await expect(page.getByRole('radio', { name: /Warn only/ })).toBeChecked();
    // Before any change the shell save bar is not rendered (it only mounts when dirty=true).
    await expect(page.getByText(/You have unsaved changes/)).toHaveCount(0);

    // Click the visible label — the radio input itself is sr-only.
    await page.getByText('Block & escalate', { exact: true }).click();
    // Save bar arms once the page reports dirty.
    await expect(page.getByText(/You have unsaved changes/)).toBeVisible();
    const saveBtn = page.getByRole('button', { name: /Save changes/ });
    await saveBtn.click();
    await expect.poll(() => captures.patchCount, { timeout: 2000 }).toBeGreaterThanOrEqual(1);
    const body = captures.lastPatchBody as { slip_propagation?: string } | undefined;
    expect(body?.slip_propagation).toBe('block');
  });

  test('Team Member caller sees the Read-only pill and disabled controls', async ({ page }) => {
    const captures: Captures = { patchCount: 0 };
    await setup(page, captures, { myRole: 100 });
    await page.goto(`/programs/${PROGRAM_ID}/settings/risk`);

    // All sections mount on one page (ADR-0146); the "Read-only" pill also appears
    // in the rollup section for a non-admin, so scope to the risk section.
    const risk = page.locator('[data-settings-section="risk"]');
    await expect(risk.getByRole('heading', { name: /Risk & deps policy/ })).toBeVisible();
    await expect(risk.getByText(/Read-only/)).toBeVisible();
    await expect(risk.getByRole('radio', { name: /Warn only/ })).toBeDisabled();
    await expect(risk.getByRole('spinbutton')).toBeDisabled();
  });
});
