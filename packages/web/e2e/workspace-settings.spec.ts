import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Workspace settings — General, Members, and Groups pages.
 *
 * Golden path + one empty/error state per page.  All API calls are intercepted
 * via page.route() so no running backend is required.
 */

const pj = (data: unknown) => JSON.stringify(data);
// A single-page DRF envelope — /workspace/members/ is cursor-paginated (#1317),
// and the page fetches it via fetchAllPages (reads .results, follows .next).
const pjPage = (results: unknown[]) => JSON.stringify({ results, next: null });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  // Public-sharing cascade policy (ADR-0135, #978 / #2014) — the General page
  // renders "may override" vs the Enterprise ENFORCE lock seeded from this.
  public_sharing_override_policy: 'suggest',
  // Iteration-label cascade (ADR-0116, #1106) — the real /workspace/ payload always
  // carries these; without them IterationLabelField crashes on `value.trim()`.
  iteration_label: 'Sprint',
  iteration_label_override_policy: 'suggest',
  // Forecast-history config (ADR-0144, issue 1232) — the workspace root is non-null,
  // so the General page renders plain (non-inheritable) controls seeded from these.
  mc_history_enabled: true,
  mc_history_retention_cap: 100,
  mc_history_attribution_audience: 'ADMIN_OWNER',
  mc_history_override_policy: 'suggest',
};

const MEMBER = {
  id: 'u1',
  name: 'Alice Khoury',
  initials: 'AK',
  color: '#3E8C6D',
  email: 'alice@truescope.io',
  role: 'Admin',
  role_value: 300,
  groups: ['Leadership'],
  project_count: 5,
  last_active: '2h ago',
  status: 'active',
  sso: true,
  two_fa: true,
};

const INVITE = {
  id: 'inv-1',
  email: 'bob@example.com',
  role: 'Member',
  role_value: 100,
  status: 'pending',
  invited_by: 'AK',
  created_at: '2026-05-20T10:00:00Z',
  expires_at: '2026-06-20T10:00:00Z',
};

const GROUP = {
  id: 'grp-1',
  name: 'Avionics',
  description: 'Flight computer and firmware',
  lead: 'AK',
  lead_user_id: 'u1',
  member_count: 1,
  members: [{ id: 'u1', name: 'Alice Khoury', initials: 'AK', color: '#3E8C6D' }],
  // #2253: project links now carry id + conferred role (not bare name strings).
  projects: [
    { id: 'p-orion', name: 'Orion', role: 100, role_label: 'Team Member' },
    { id: 'p-artemis', name: 'Artemis IV', role: 300, role_label: 'Project Manager' },
  ],
};

// A workspace member NOT yet in the group above — the only addable option in the
// Manage drawer's member picker (Alice/u1 is already a member).
const OTHER_MEMBER = {
  id: 'u2',
  name: 'Bob Stone',
  initials: 'BS',
  color: '#C17A10',
  email: 'bob@truescope.io',
  role: 'Team Member',
  role_value: 100,
  groups: [],
  project_count: 0,
  last_active: '1d ago',
  status: 'active',
  sso: false,
  two_fa: false,
};

// Projects the drawer's grant picker reads (/projects/). Orion + Artemis are
// already linked, so only Gemini is grantable.
const DRAWER_PROJECTS = [
  { id: 'p-orion', name: 'Orion', start_date: '2026-01-01', calendar: 'c1' },
  { id: 'p-artemis', name: 'Artemis IV', start_date: '2026-01-01', calendar: 'c1' },
  { id: 'p-gemini', name: 'Gemini', start_date: '2026-01-01', calendar: 'c1' },
];

// ---------------------------------------------------------------------------
// Common setup
// ---------------------------------------------------------------------------

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

  // Catch-all — prevents unmocked requests from 401ing into the session-expired loop.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
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
        // Workspace admin — the threshold RequireWorkspaceAdmin gates on (#2012).
        can_access_admin_settings: true,
        workspace_role: 300,
      }),
    }),
  );

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Workspace General page
// ---------------------------------------------------------------------------

test.describe('Workspace General page', () => {
  test('golden path — shows workspace name and subdomain', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
    );

    await page.goto('/settings/general');

    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    // Wait for the input to be seeded from the API response
    await expect(page.locator('input[value="TrueScope Aerospace"]')).toBeVisible();
    await expect(page.getByText('truescope', { exact: true })).toBeVisible();
  });

  test('golden path — work-week toggles reflect loaded state', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
    );

    await page.goto('/settings/general');

    // Monday should be pressed (true), Saturday should not
    await expect(page.getByRole('button', { name: 'Monday' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Saturday' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('forecast history — group renders seeded controls and the toggle flips (ADR-0144)', async ({
    page,
  }) => {
    await setup(page);
    let patchBody: Record<string, unknown> | undefined;
    await page.route('**/api/v1/workspace/', (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...WORKSPACE, mc_history_enabled: false }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });

    await page.goto('/settings/general');

    // The group renders, seeded from the workspace payload.
    await expect(page.getByRole('heading', { name: 'Forecast history' })).toBeVisible();
    const keepToggle = page.getByRole('switch', { name: 'Keep Monte Carlo run history' });
    await expect(keepToggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('spinbutton', { name: 'Run history limit' })).toHaveValue('100');
    await expect(page.getByRole('combobox', { name: 'Run attribution visible to' })).toHaveValue(
      'ADMIN_OWNER',
    );

    // The workspace-only override policy renders the Lock option as a disabled
    // Enterprise affordance; "May override" is the live OSS default.
    await expect(page.getByRole('radio', { name: /Lock workspace-wide/i })).toBeDisabled();

    // Flipping the toggle arms the save bar and the PATCH carries the new value.
    await keepToggle.click();
    await expect(keepToggle).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => patchBody).toMatchObject({ mc_history_enabled: false });
  });

  test('golden path — PATCH dispatched when Save is triggered via name change', async ({
    page,
  }) => {
    await setup(page);
    let patchBody: Record<string, unknown> | undefined;
    await page.route('**/api/v1/workspace/', (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...WORKSPACE, name: 'Updated Corp' }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });

    await page.goto('/settings/general');

    const nameInput = page.locator('input[value="TrueScope Aerospace"]');
    await nameInput.fill('Updated Corp');

    // The dirty form registers a save handler — invoke it via the shell's
    // save bar. No isVisible guard: if the save bar never renders, the test
    // must fail here rather than silently skip past the save-then-PATCH
    // path (issue 1574). Capture and assert the PATCH body like the
    // sibling forecast-history and fiscal-year tests above.
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => patchBody).toMatchObject({ name: 'Updated Corp' });
  });

  test('fiscal year — picking a preset chip dispatches the structured month/day', async ({
    page,
  }) => {
    await setup(page);
    let patchBody: Record<string, unknown> | undefined;
    await page.route('**/api/v1/workspace/', (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({
            ...WORKSPACE,
            fiscal_year_start_month: 4,
            fiscal_year_start_display: 'April 1',
          }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });

    await page.goto('/settings/general');

    // Loaded value is January 1 — that chip is pressed.
    await expect(page.getByRole('button', { name: 'Jan 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Switch to the April-1 preset, then save via the shell save bar.
    await page.getByRole('button', { name: 'Apr 1' }).click();
    await expect(page.getByRole('button', { name: 'Apr 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();

    await expect
      .poll(() => patchBody)
      .toMatchObject({
        fiscal_year_start_month: 4,
        fiscal_year_start_day: 1,
      });
  });

  test('fiscal year — Custom picker sends an oddball month/day (April 6)', async ({ page }) => {
    await setup(page);
    let patchBody: Record<string, unknown> | undefined;
    await page.route('**/api/v1/workspace/', (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({
            ...WORKSPACE,
            fiscal_year_start_month: 4,
            fiscal_year_start_day: 6,
            fiscal_year_start_display: 'April 6',
          }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });

    await page.goto('/settings/general');

    await page.getByRole('button', { name: 'Custom…' }).click();
    await page.getByLabel('Fiscal year start month').selectOption('4');
    await page.getByLabel('Fiscal year start day').selectOption('6');
    // No preset matches April 6, so the Custom chip stays pressed.
    await expect(page.getByRole('button', { name: 'Custom…' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();

    await expect
      .poll(() => patchBody)
      .toMatchObject({
        fiscal_year_start_month: 4,
        fiscal_year_start_day: 6,
      });
  });

  test('error state — shows loading skeleton when workspace fetch is slow', async ({ page }) => {
    await setup(page);
    // Override catch-all: make /workspace/ return empty object to trigger loading state
    // by never resolving during test startup (checking skeleton visibility window).
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });

    await page.route('**/api/v1/workspace/', async (r) => {
      await pending;
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });

    await page.goto('/settings/general');

    // Loading skeleton is visible before data arrives
    await expect(page.locator('[class*="animate-pulse"]').first()).toBeVisible();

    // Unblock so the page can finish loading
    resolve(undefined);
  });

  test('public-sharing override policy — renders the "may override" + Enterprise-locked radios (#2014)', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
    );

    await page.goto('/settings/general');

    // suggest (the seeded value) → "may override" is the checked, enabled option.
    const mayOverride = page.getByRole('radio', { name: /May narrow or widen this default/i });
    await expect(mayOverride).toBeChecked();
    await expect(mayOverride).toBeEnabled();
    // ENFORCE is the Enterprise lock — present but disabled on the OSS surface.
    await expect(
      page.getByRole('radio', { name: /Enforce sharing workspace-wide/i }),
    ).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Workspace-admin route gate (#2012)
// ---------------------------------------------------------------------------

test.describe('Workspace settings — workspace-admin gate (#2012)', () => {
  test('a project-admin who is a plain workspace member is bounced off /settings', async ({
    page,
  }) => {
    await setup(page);
    // Re-mock /auth/me AFTER setup (last registration wins): admin of some project
    // (can_access_admin_settings) but a sub-ADMIN workspace_role — the exact #2012
    // profile that used to land on enabled-but-403 controls.
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
          workspace_role: 100,
        }),
      }),
    );
    // Personal notifications is the redirect target — mock its prefs so it renders.
    await page.route('**/api/v1/notification-preferences/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj({}) }),
    );

    await page.goto('/settings/general');

    // RequireWorkspaceAdmin redirects; the workspace General heading never renders.
    await expect(page).toHaveURL(/\/me\/settings\/notifications/);
    await expect(page.getByRole('heading', { name: 'General' })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Workspace Members page
// ---------------------------------------------------------------------------

test.describe('Workspace Members page', () => {
  test('golden path — shows member name and email', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([]) }),
    );

    await page.goto('/settings/members');

    // All sections mount at once now (#1248); "Alice Khoury" also appears as an
    // option in the Danger section's transfer-owner select, so scope to the
    // members section to avoid a strict-mode collision.
    const members = page.locator('[data-settings-section="members"]');
    await expect(members.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(members.getByText('Alice Khoury')).toBeVisible();
    await expect(members.getByText('alice@truescope.io')).toBeVisible();
  });

  test('golden path — pending invite section renders', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([INVITE]) }),
    );

    await page.goto('/settings/members');

    await expect(page.getByText('bob@example.com')).toBeVisible();
    await expect(page.getByText('1 pending invites')).toBeVisible();
  });

  test('golden path — POST dispatched when invite form is submitted', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({ status: 201, contentType: 'application/json', body: pj(INVITE) });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([]) });
    });

    await page.goto('/settings/members');

    await page.getByRole('textbox', { name: /email/i }).fill('carol@example.com');
    await page.getByRole('button', { name: /invite members/i }).click();

    // Request is dispatched (the button text changes to "Sending…" then back).
    // We verify by the form clearing.
    await expect(page.getByRole('textbox', { name: /email/i })).toHaveValue('');
  });

  test('golden path — Export CSV downloads the visible members (issue 969)', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([]) }),
    );

    await page.goto('/settings/members');

    const exportBtn = page.getByRole('button', { name: 'Export CSV' });
    await expect(exportBtn).toBeEnabled();

    const [download] = await Promise.all([page.waitForEvent('download'), exportBtn.click()]);
    expect(download.suggestedFilename()).toBe('trueppm-workspace-members.csv');
  });

  test('empty state — shows skeleton when loading', async ({ page }) => {
    await setup(page);
    // Both member endpoints are covered by catch-all returning [] which triggers
    // a resolved-empty state. Test the loading state instead with a slow route.
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });

    await page.route('**/api/v1/workspace/members/', async (r) => {
      await pending;
      return r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([]) });
    });
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([]) }),
    );

    await page.goto('/settings/members');

    await expect(page.locator('[class*="animate-pulse"]').first()).toBeVisible();
    resolve(undefined);
  });
});

// ---------------------------------------------------------------------------
// Workspace logo upload (#969, ADR-0149) — General page
// ---------------------------------------------------------------------------

// A 1×1 PNG — valid magic bytes, so the client decode resolves and no soft
// dimension warning fires from the synchronous type/size pre-flight either way.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('Workspace logo (#969)', () => {
  test('golden path — Upload posts the file and the thumbnail swaps to the served logo', async ({
    page,
  }) => {
    await setup(page);
    let uploaded = false;
    let postContentType: string | undefined;
    await page.route('**/api/v1/workspace/', (r) => {
      if (r.request().method() === 'POST') {
        uploaded = true;
        postContentType = r.request().headers()['content-type'];
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...WORKSPACE, logo_url: '/api/v1/workspace/logo/?v=2' }),
        });
      }
      // After upload the settings refetch carries the logo_url so the picker
      // flips Upload → Replace.
      const body = uploaded ? { ...WORKSPACE, logo_url: '/api/v1/workspace/logo/?v=2' } : WORKSPACE;
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(body) });
    });
    // The dedicated logo endpoint is what the FormData POST targets.
    await page.route('**/api/v1/workspace/logo/', (r) => {
      uploaded = true;
      postContentType = r.request().headers()['content-type'];
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...WORKSPACE, logo_url: '/api/v1/workspace/logo/?v=2' }),
      });
    });

    await page.goto('/settings/general');

    // Empty state: the picker reads "Upload".
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });

    await expect.poll(() => uploaded).toBe(true);
    expect(postContentType).toContain('multipart/form-data');
    // Refetch flips the control to Replace and renders the served image.
    await expect(page.getByRole('button', { name: 'Replace', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Workspace logo' })).toBeVisible();
  });

  test('client pre-flight blocks a non-raster file before any request', async ({ page }) => {
    await setup(page);
    let posted = false;
    await page.route('**/api/v1/workspace/logo/', (r) => {
      posted = true;
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
    );

    await page.goto('/settings/general');

    // The accept attribute filters the OS picker, but a forced wrong type must
    // still be rejected client-side with a toast and no network call.
    await page.locator('input[type="file"]').setInputFiles({
      name: 'logo.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    });

    await expect(page.getByText('PNG or WebP only.')).toBeVisible();
    expect(posted).toBe(false);
  });

  test('remove — inline confirm dispatches DELETE and falls back to the letter-mark', async ({
    page,
  }) => {
    await setup(page);
    let removed = false;
    await page.route('**/api/v1/workspace/logo/', (r) => {
      if (r.request().method() === 'DELETE') {
        removed = true;
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...WORKSPACE, logo_url: null }),
        });
      }
      return r.fulfill({ status: 404, contentType: 'application/json', body: pj({}) });
    });
    await page.route('**/api/v1/workspace/', (r) => {
      const body = removed ? WORKSPACE : { ...WORKSPACE, logo_url: '/api/v1/workspace/logo/?v=1' };
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(body) });
    });

    await page.goto('/settings/general');

    // Logo present → Remove visible; clicking it asks for inline confirmation.
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('Remove?')).toBeVisible();
    await page.getByRole('button', { name: 'Yes, remove' }).click();

    await expect.poll(() => removed).toBe(true);
    // Refetch with no logo_url restores the Upload affordance.
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Resend pending invite (#969, ADR-0149) — Members page
// ---------------------------------------------------------------------------

test.describe('Resend invite (#969)', () => {
  test('per-row Resend posts to the invite resend endpoint and shows the Sent cue', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([INVITE]) }),
    );
    let resendPosted = false;
    await page.route('**/api/v1/workspace/invites/inv-1/resend/', (r) => {
      resendPosted = r.request().method() === 'POST';
      return r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: pj({ queued: true }),
      });
    });

    await page.goto('/settings/members');

    await page.getByRole('button', { name: 'Resend invite to bob@example.com' }).click();

    await expect.poll(() => resendPosted).toBe(true);
    // The 202 is fire-and-forget; the admin's confirmation is the row cue.
    await expect(page.getByText('Sent ✓')).toBeVisible();
  });

  test('bulk "Resend all" posts to the resend-all endpoint', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([INVITE]) }),
    );
    let resendAllPosted = false;
    await page.route('**/api/v1/workspace/invites/resend-all/', (r) => {
      resendAllPosted = r.request().method() === 'POST';
      return r.fulfill({ status: 202, contentType: 'application/json', body: pj({ requeued: 1 }) });
    });

    await page.goto('/settings/members');

    await page.getByRole('button', { name: 'Resend all →' }).click();

    await expect.poll(() => resendAllPosted).toBe(true);
  });

  test('throttled per-row resend (429) surfaces a wait-a-minute toast', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([INVITE]) }),
    );
    await page.route('**/api/v1/workspace/invites/inv-1/resend/', (r) =>
      r.fulfill({
        status: 429,
        contentType: 'application/json',
        body: pj({ detail: 'throttled' }),
      }),
    );

    await page.goto('/settings/members');

    await page.getByRole('button', { name: 'Resend invite to bob@example.com' }).click();

    await expect(page.getByText(/Too many resends/i)).toBeVisible();
    // The Sent cue must NOT appear on a throttled attempt.
    await expect(page.getByText('Sent ✓')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Account-menu nav entry (#2033) — workspace settings must be reachable from
// the UI: the UserMenu "Workspace settings" row is the only always-available
// path to /settings (members + invites) for a fresh workspace.
// ---------------------------------------------------------------------------

test.describe('Workspace settings nav entry (#2033)', () => {
  async function setupMembersSection(page: Page) {
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
    );
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([]) }),
    );
  }

  test('golden path — admin opens the account menu and lands on the Members section', async ({
    page,
  }) => {
    await setup(page);
    // Later route registrations win, so this admin-flavored /auth/me/ overrides
    // the base one from setup(): the menu row is gated on workspace-admin
    // (workspace_role >= 300), the same threshold RequireWorkspaceAdmin enforces
    // on the /settings route (#2012).
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
    await setupMembersSection(page);

    await page.goto('/settings/general');
    // "Page rendered" gate before touching chrome (data-driven route).
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();

    await page.getByRole('button', { name: 'Account — Alice' }).last().click();
    // The account menu is a non-modal dialog (#2167); its rows are links/buttons,
    // not menuitems. Scope to the dialog so the row name is unambiguous.
    const menu = page.getByRole('dialog', { name: 'User menu' });
    const row = menu.getByRole('link', { name: 'Workspace settings' });
    await expect(row).toBeVisible();
    await row.click();

    await expect(page).toHaveURL(/\/settings#members$/);
    const members = page.locator('[data-settings-section="members"]');
    await expect(members.getByRole('heading', { name: 'Members' })).toBeVisible();
  });

  test('non-admin — the account menu has no "Workspace settings" row', async ({ page }) => {
    await setup(page);
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
          can_access_admin_settings: false,
        }),
      }),
    );
    await setupMembersSection(page);

    // Non-admins can't sit on /settings (RequireAdminSettings bounces them), so
    // open the menu from the personal settings page the sidebar gear targets.
    await page.goto('/me/settings/general');
    await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();

    await page.getByRole('button', { name: 'Account — Alice' }).last().click();
    // Account menu is a non-modal dialog (#2167); rows are links, not menuitems.
    const menu = page.getByRole('dialog', { name: 'User menu' });
    await expect(menu.getByRole('link', { name: 'My Work' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Workspace settings' })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Workspace Groups page
// ---------------------------------------------------------------------------

test.describe('Workspace Groups page', () => {
  test('golden path — shows group name and description', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/groups/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([GROUP]) }),
    );

    await page.goto('/settings/groups');

    await expect(page.getByRole('heading', { name: 'Groups & teams' })).toBeVisible();
    await expect(page.getByText('Avionics')).toBeVisible();
    await expect(page.getByText('Flight computer and firmware')).toBeVisible();
    // #2295: a small group shows member names on the card, not anonymous dots.
    await expect(page.getByText('Alice Khoury')).toBeVisible();
  });

  test('golden path — POST dispatched when create group form is submitted', async ({ page }) => {
    await setup(page);
    let postBody: unknown;
    await page.route('**/api/v1/workspace/groups/', (r) => {
      if (r.request().method() === 'POST') {
        postBody = r.request().postDataJSON();
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: pj({ ...GROUP, id: 'grp-new', name: 'Propulsion' }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([GROUP]) });
    });

    await page.goto('/settings/groups');

    await page.getByRole('button', { name: /create group/i }).click();
    await page.getByPlaceholder(/e\.g\. Avionics/i).fill('Propulsion');
    await page.getByRole('button', { name: /^create$/i }).click();

    await expect.poll(() => postBody).toMatchObject({ name: 'Propulsion' });
  });

  test('empty state — shows empty-state message when no groups exist', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/groups/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([]) }),
    );

    await page.goto('/settings/groups');

    await expect(page.getByText(/No groups yet/i)).toBeVisible();
  });

  test('error-adjacent — shows skeleton when loading', async ({ page }) => {
    await setup(page);
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });

    await page.route('**/api/v1/workspace/groups/', async (r) => {
      await pending;
      return r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([GROUP]) });
    });

    await page.goto('/settings/groups');

    await expect(page.locator('[class*="animate-pulse"]').first()).toBeVisible();
    resolve(undefined);
  });
});

// ---------------------------------------------------------------------------
// Workspace Groups — Manage drawer (#2253): add members + grant project access
// ---------------------------------------------------------------------------

test.describe('Workspace Groups — Manage drawer (#2253)', () => {
  async function setupManage(page: Page) {
    await setup(page);
    await page.route('**/api/v1/workspace/groups/', (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([GROUP]) });
      }
      return r.continue();
    });
    // The drawer reads the workspace roster (member picker) and the project list
    // (grant picker); mock both with their real shapes.
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pjPage([MEMBER, OTHER_MEMBER]),
      }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pjPage([]) }),
    );
    await page.route('**/api/v1/projects/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({
          count: DRAWER_PROJECTS.length,
          next: null,
          previous: null,
          results: DRAWER_PROJECTS,
        }),
      }),
    );
  }

  test('golden path — Manage opens a drawer listing members and project grants', async ({
    page,
  }) => {
    await setupManage(page);
    await page.goto('/settings/groups');
    await expect(page.getByText('Avionics')).toBeVisible();

    await page.getByRole('button', { name: 'Manage Avionics' }).click();

    const dialog = page.getByRole('dialog', { name: 'Avionics' });
    await expect(dialog).toBeVisible();
    // Existing member and existing project grant (with its conferred role) render.
    await expect(dialog.getByText('Alice Khoury')).toBeVisible();
    await expect(dialog.getByText('Orion')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: /Revoke Avionics access to Orion/i }),
    ).toBeVisible();
  });

  test('golden path — adding a member POSTs the chosen user id', async ({ page }) => {
    await setupManage(page);
    let postBody: unknown;
    await page.route('**/api/v1/workspace/groups/grp-1/members/', (r) => {
      postBody = r.request().postDataJSON();
      return r.fulfill({ status: 201, contentType: 'application/json', body: pj(GROUP) });
    });

    await page.goto('/settings/groups');
    await page.getByRole('button', { name: 'Manage Avionics' }).click();
    const dialog = page.getByRole('dialog', { name: 'Avionics' });
    await expect(dialog).toBeVisible();

    // Alice is already a member, so Bob is the only addable option. Scope to the
    // combobox's own listbox — the Danger section (also mounted on the consolidated
    // page) has a transfer-owner <select> whose native "Bob Stone" option collides.
    await dialog.getByRole('button', { name: 'Add' }).click();
    await page
      .getByRole('listbox', { name: 'Select member' })
      .getByRole('option', { name: 'Bob Stone' })
      .click();

    await expect.poll(() => postBody).toMatchObject({ user: 'u2' });
  });

  test('golden path — granting project access POSTs the project and chosen role', async ({
    page,
  }) => {
    await setupManage(page);
    let postBody: unknown;
    await page.route('**/api/v1/workspace/groups/grp-1/projects/', (r) => {
      postBody = r.request().postDataJSON();
      return r.fulfill({ status: 201, contentType: 'application/json', body: pj(GROUP) });
    });

    await page.goto('/settings/groups');
    await page.getByRole('button', { name: 'Manage Avionics' }).click();
    const dialog = page.getByRole('dialog', { name: 'Avionics' });
    await expect(dialog).toBeVisible();

    // Orion + Artemis are already linked, so Gemini is the only grantable project.
    await dialog.getByRole('button', { name: 'Choose' }).click();
    await page
      .getByRole('listbox', { name: 'Select project' })
      .getByRole('option', { name: 'Gemini' })
      .click();
    await dialog.getByLabel('Role to confer').selectOption('200'); // Resource Manager
    await dialog.getByRole('button', { name: 'Grant' }).click();

    await expect.poll(() => postBody).toMatchObject({ project: 'p-gemini', role: 200 });
  });

  test('revoke — removing a grant DELETEs by project id', async ({ page }) => {
    await setupManage(page);
    let deleted = false;
    await page.route('**/api/v1/workspace/groups/grp-1/projects/p-orion/', (r) => {
      deleted = r.request().method() === 'DELETE';
      return r.fulfill({ status: 204, body: '' });
    });

    await page.goto('/settings/groups');
    await page.getByRole('button', { name: 'Manage Avionics' }).click();
    const dialog = page.getByRole('dialog', { name: 'Avionics' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: /Revoke Avionics access to Orion/i }).click();

    await expect.poll(() => deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Workspace Danger page — transfer / export / delete (#641)
// ---------------------------------------------------------------------------

const DANGER_MEMBER = {
  // Numeric id — real workspace member ids are the integer auth.User PK as a
  // string, which the transfer select coerces with Number().
  id: '2',
  name: 'Bob Stone',
  initials: 'BS',
  color: '#C17A10',
  email: 'bob@truescope.io',
  role: 'Member',
  role_value: 100,
  groups: [],
  project_count: 1,
  last_active: '1d ago',
  status: 'active',
  sso: false,
  two_fa: false,
};

async function setupDanger(page: Page) {
  await setup(page);
  await page.route('**/api/v1/workspace/members/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pjPage([MEMBER, DANGER_MEMBER]),
    }),
  );
}

test.describe('Workspace Danger page', () => {
  test('golden path — delete is gated by typed confirmation and sends the confirm header', async ({
    page,
  }) => {
    await setupDanger(page);
    let confirmHeader: string | null = null;
    await page.route('**/api/v1/workspace/', async (r) => {
      if (r.request().method() === 'DELETE') {
        confirmHeader = r.request().headers()['x-confirm-workspace'] ?? null;
        return r.fulfill({ status: 204, body: '' });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });

    await page.goto('/settings/danger');

    const deleteBtn = page.getByRole('button', { name: 'Delete workspace permanently' });
    await expect(deleteBtn).toBeDisabled();

    const confirmInput = page.getByLabel(/Confirm delete by typing the workspace name/i);
    await confirmInput.fill('wrong name');
    await expect(deleteBtn).toBeDisabled();

    await confirmInput.fill('TrueScope Aerospace');
    await expect(deleteBtn).toBeEnabled();
    await deleteBtn.click();

    // Post-delete we bounce to /login. clearTokens() flips isAuthenticated,
    // so RequireAuth (still mounted on /settings) may win a race with the
    // page's own navigate('/login') and append a `?next=%2Fsettings` capture.
    // Both outcomes are correct — assert with the /login regex the auth specs
    // use rather than an exact glob that rejects the query (#1646 flake).
    await page.waitForURL(/\/login/);
    expect(confirmHeader).toBe('TrueScope Aerospace');
  });

  test('golden path — Export all data queues a job and shows the queued state', async ({
    page,
  }) => {
    await setupDanger(page);
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
    );
    let exportPosted = false;
    await page.route('**/api/v1/workspace/export/', (r) => {
      exportPosted = true;
      return r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: pj({ id: 'exp-1', status: 'pending', download_url: null }),
      });
    });
    await page.route('**/api/v1/workspace/export/exp-1/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ id: 'exp-1', status: 'pending', download_url: null }),
      }),
    );

    await page.goto('/settings/danger');
    await page.getByRole('button', { name: 'Export all data' }).click();

    expect(exportPosted).toBe(true);
    await expect(page.getByText(/Export queued/i)).toBeVisible();
  });

  test('transfer — lists eligible members and dispatches the chosen owner', async ({ page }) => {
    await setupDanger(page);
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
    );
    let transferBody: Record<string, unknown> | undefined;
    await page.route('**/api/v1/workspace/transfer-ownership/', (r) => {
      transferBody = r.request().postDataJSON();
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ detail: 'Workspace ownership transferred.', new_owner_user_id: 2 }),
      });
    });

    await page.goto('/settings/danger');

    const transferBtn = page.getByRole('button', { name: /Transfer ownership/i });
    await expect(transferBtn).toBeDisabled();
    await page.getByLabel('New owner').selectOption('2');
    await expect(transferBtn).toBeEnabled();
    await transferBtn.click();

    await expect(page.getByText(/ownership transferred/i)).toBeVisible();
    expect(transferBody?.new_owner_user_id).toBe(2);
  });
});
