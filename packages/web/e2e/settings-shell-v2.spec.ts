import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';
import { expectNoA11yViolations } from './fixtures/a11y';

/**
 * Shell v2 Settings restyle (#4800) behind `?ff=shell_v2`: the dirty-state save bar
 * names what changed, Cmd/Ctrl+S saves, and leaving with unsaved edits asks first.
 * Mocks mirror settings-shell-ux.spec.ts (Project > General).
 */

const PROJECT_ID = 'e2e-shell-v2-settings-00000000-0000-0000-0000-000000004800';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Atlas Migration',
  description: 'Original description.',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
  agile_features: false,
  methodology: 'HYBRID',
};

const FIXTURE_ME = {
  id: 'u-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
  // Admin+ in at least one project (ADR-0122). `RequireAdminSettings` no longer
  // admits on a verdict-less /auth/me (#3350), and `can_access_admin_settings` is a
  // declared MeSerializer field, so a payload omitting it was never representable.
  can_access_admin_settings: true,
};

type Page = import('@playwright/test').Page;

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

  const pj = (data: unknown) => JSON.stringify(data);

  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
    if (r.request().method() === 'PATCH') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...FIXTURE_PROJECT, name: 'Atlas Migration (renamed)' }),
      });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) });
  });
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        task_count: 0,
        health_band: 'on_track',
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/attention/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ items: [] }) }),
  );
  await page.route('**/api/v1/projects/*/my-tasks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ tasks: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  // useCurrentUserRole's `?self=true` read resolves the Project General page to
  // Admin (role 400) so its fields stay editable under the #1084 role gate.
  // Registered after the roster route → wins Playwright's LIFO match for self.
  await page.route(
    (url) =>
      url.pathname.endsWith(`/projects/${PROJECT_ID}/members/`) &&
      url.searchParams.get('self') === 'true',
    (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj([{ id: 'self', role: 400 }]),
      }),
  );
  await page.route('**/api/v1/me/notifications/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/me/notification-preferences/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
}

const V2 = '?ff=shell_v2';

test.describe('Settings under shell v2 (#4800)', () => {
  test('edit shows the save bar naming the section; Ctrl+S saves it', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general${V2}`);

    await expect(page.getByTestId('settings-save-bar')).toBeHidden();
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill('Atlas Migration (renamed)');

    const bar = page.getByTestId('settings-save-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Unsaved changes in');

    await nameInput.press('Control+s');
    await expect(page.getByTestId('settings-save-bar')).toBeHidden();
    await expect(page.getByTestId('settings-saved-footer')).toBeVisible();
  });

  test('leaving with unsaved edits asks first; Keep editing stays', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general${V2}`);

    await page.getByRole('textbox', { name: /project name/i }).fill('Dirty name');
    await page.getByRole('button', { name: 'Personal', exact: true }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /keep editing/i }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/settings`));
  });

  test('v1 (flag off) has no Personal segment', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Personal', exact: true })).toHaveCount(0);
  });
});

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
};

/** Workspace-admin identity + the /workspace/ read/write the General page uses. */
async function setupWorkspace(page: Page, onPatch?: (body: Record<string, unknown>) => void) {
  await setup(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...FIXTURE_ME, workspace_role: 300 }),
    }),
  );
  const stored: Record<string, unknown> = { ...WORKSPACE };
  await page.route('**/api/v1/workspace/', (r) => {
    if (r.request().method() === 'PATCH') {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      onPatch?.(body);
      Object.assign(stored, body);
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(stored),
    });
  });
}

test.describe('Settings v2: Workspace > General save bar (#4800)', () => {
  test('dirty edit shows the save bar naming General, and Save writes it', async ({ page }) => {
    let patch: Record<string, unknown> | undefined;
    await setupWorkspace(page, (b) => (patch = b));
    await page.goto(`/settings/general${V2}`);

    const guests = page.getByRole('switch', { name: 'Allow guest access' });
    await expect(guests).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('settings-save-bar')).toBeHidden();

    await guests.click();
    const bar = page.getByTestId('settings-save-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Unsaved changes in');
    await expect(bar).toContainText('General');

    await bar.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => patch).toMatchObject({ allow_guests: false });
    await expect(page.getByTestId('settings-save-bar')).toBeHidden();
  });
});

test.describe('Settings v2: guest count readout (#5102)', () => {
  test('the Guest access toggle reports the count the server sends', async ({ page }) => {
    await setupWorkspace(page);
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...WORKSPACE, guest_count: 3 }),
      }),
    );
    await page.goto(`/settings/general${V2}`);
    await expect(page.getByText('Enabled - 3 guests')).toBeVisible();
  });
});

test.describe('Settings v2: a11y and phone viewport (#4800)', () => {
  test('Project > General has no critical/serious axe violations, light', async ({
    page,
  }, testInfo) => {
    await setup(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => localStorage.setItem('trueppm.theme', 'light'));
    await page.goto(`/projects/${PROJECT_ID}/settings/general${V2}`);
    await expect(page.getByRole('textbox', { name: /project name/i })).toBeVisible();
    await page.getByRole('textbox', { name: /project name/i }).fill('Dirty');
    await expect(page.getByTestId('settings-save-bar')).toBeVisible();
    await expectNoA11yViolations(page, testInfo);
  });

  test('Project > General has no critical/serious axe violations, dark', async ({
    page,
  }, testInfo) => {
    await setup(page);
    await page.addInitScript(() => localStorage.setItem('trueppm.theme', 'dark'));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`/projects/${PROJECT_ID}/settings/general${V2}`);
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('textbox', { name: /project name/i }).fill('Dirty');
    await expect(page.getByTestId('settings-save-bar')).toBeVisible();
    await expectNoA11yViolations(page, testInfo);
  });

  test('phone (390px): save bar, scope segments and toggles are >= 44px tall', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupWorkspace(page);
    await page.goto(`/settings/general${V2}`);

    const guests = page.getByRole('switch', { name: 'Allow guest access' });
    await expect(guests).toBeVisible();
    await guests.click();
    const bar = page.getByTestId('settings-save-bar');
    await expect(bar).toBeVisible();

    const heightOf = async (loc: import('@playwright/test').Locator) => {
      const box = await loc.boundingBox();
      expect(box).not.toBeNull();
      return box!.height;
    };
    expect(await heightOf(guests)).toBeGreaterThanOrEqual(44);
    expect(
      await heightOf(bar.getByRole('button', { name: 'Save changes' })),
    ).toBeGreaterThanOrEqual(44);
    for (const name of ['Personal', 'Workspace']) {
      const seg = page.getByRole('button', { name, exact: true }).first();
      await expect(seg).toBeVisible();
      expect(await heightOf(seg)).toBeGreaterThanOrEqual(44);
    }
  });

  async function shortControls(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const root = document.querySelector('[data-testid="settings-content-scroll"]')!;
      return [
        ...root.querySelectorAll<HTMLElement>(
          'button, select, input:not([type=checkbox]):not([type=radio]):not([type=file])',
        ),
      ]
        .filter((el) => !el.classList.contains('sr-only'))
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0 && r.height < 43.5)
        .map(
          ({ el, r }) =>
            `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 30)} ${r.height}`,
        );
    });
  }

  test('phone (390px): every button, select and text input in the page body is >= 44px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupWorkspace(page);
    await page.goto(`/settings/general${V2}`);
    await expect(page.getByRole('switch', { name: 'Allow guest access' })).toBeVisible();
    expect(await shortControls(page)).toEqual([]);
  });

  test('phone (390px): Workspace > Archive / Delete (select, text input, buttons) is >= 44px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupDangerV2(page);
    await page.goto(`/settings/danger${V2}`);
    await expect(page.getByRole('button', { name: 'Delete workspace permanently' })).toBeVisible();
    await expect(page.locator('#new-owner')).toBeVisible();
    expect(await shortControls(page)).toEqual([]);
  });

  test('phone (390px): Project > Lifecycle buttons are >= 44px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    const project = { ...FIXTURE_PROJECT, code: 'ATLAS', is_archived: false };
    await page.route(new RegExp(`/api/v1/projects/${PROJECT_ID}/(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(project) }),
    );
    await page.goto(`/projects/${PROJECT_ID}/settings/lifecycle${V2}`);
    const archive = page.getByRole('button', { name: /Archive Atlas Migration/i });
    await expect(archive).toBeVisible();
    expect(await shortControls(page)).toEqual([]);

    // The action fills its card (16px padding + 1px border a side), not just clears 44px.
    const btnBox = await archive.boundingBox();
    const cardBox = await archive.locator('xpath=..').boundingBox();
    expect(btnBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(btnBox!.width).toBeGreaterThanOrEqual(cardBox!.width - 34);

    // The typed-confirm input is stacked full width, not its 240px desktop width.
    const confirm = page.getByLabel('Confirm delete by typing the project code or name');
    await expect(confirm).toBeVisible();
    // It spans its inner card (12px padding + 1px border a side), not the 240px desktop width.
    const innerCard = await confirm.locator('xpath=../..').boundingBox();
    expect(innerCard).not.toBeNull();
    expect((await confirm.boundingBox())!.width).toBeGreaterThanOrEqual(innerCard!.width - 26);
  });
});

const DANGER_MEMBER = {
  id: '2',
  name: 'Bob Stone',
  initials: 'BS',
  color: '#C17A10',
  email: 'bob@example.com',
  role: 'Member',
  role_value: 100,
  groups: [],
  project_count: 1,
  last_active: '1d ago',
  status: 'active',
  sso: false,
  two_fa: false,
  availability_percent: 100,
  availability_effective_from: null,
  availability_effective_to: null,
  availability_notes: '',
};

/** Workspace Owner (400) + the reads the Archive / Delete page makes. */
async function setupDangerV2(page: Page, onDelete?: (confirmHeader: string | null) => void) {
  await setupWorkspace(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...FIXTURE_ME, workspace_role: 400 }),
    }),
  );
  await page.route('**/api/v1/workspace/members/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ next: null, previous: null, results: [DANGER_MEMBER] }),
    }),
  );
  await page.route('**/api/v1/workspace/', (r) => {
    if (r.request().method() === 'DELETE') {
      onDelete?.(r.request().headers()['x-confirm-workspace'] ?? null);
      return r.fulfill({ status: 204, body: '' });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(WORKSPACE),
    });
  });
}

test.describe('Settings v2: workspace delete typed confirmation', () => {
  test('Delete stays disabled until the workspace name is typed exactly', async ({ page }) => {
    let deleted = 0;
    let header: string | null = null;
    await setupDangerV2(page, (h) => {
      deleted += 1;
      header = h;
    });
    await page.goto(`/settings/danger${V2}`);

    const del = page.getByRole('button', { name: 'Delete workspace permanently' });
    // Under v2 the accessible name is the long visible label, not the v1 aria-label.
    const input = page.getByRole('textbox', { name: /to delete this workspace/i });
    await expect(del).toBeDisabled();

    await input.fill('wrong name');
    await expect(del).toBeDisabled();

    await input.fill('TrueScope Aerospace');
    await expect(del).toBeEnabled();
    expect(deleted).toBe(0);

    await del.click();
    await expect.poll(() => deleted).toBe(1);
    expect(header).toBe('TrueScope Aerospace');
  });

  test('backing out (clearing the name) re-disables Delete and sends nothing', async ({ page }) => {
    let deleted = 0;
    await setupDangerV2(page, () => (deleted += 1));
    await page.goto(`/settings/danger${V2}`);

    const del = page.getByRole('button', { name: 'Delete workspace permanently' });
    const input = page.getByRole('textbox', { name: /to delete this workspace/i });
    await input.fill('TrueScope Aerospace');
    await expect(del).toBeEnabled();

    await input.fill('');
    await expect(del).toBeDisabled();
    expect(deleted).toBe(0);
  });
});

test.describe('Settings v2: project archive confirmation (#4800)', () => {
  test('Archive stays disabled until the project code is typed', async ({ page }) => {
    await setup(page);
    let archived = 0;
    const project = { ...FIXTURE_PROJECT, code: 'ATLAS', is_archived: false };
    await page.route(new RegExp(`/api/v1/projects/${PROJECT_ID}/(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(project) }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/archive/`, (r) => {
      archived += 1;
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...project, is_archived: true }),
      });
    });
    await page.goto(`/projects/${PROJECT_ID}/settings/lifecycle${V2}`);

    await page.getByRole('button', { name: /Archive Atlas Migration/i }).click();
    const confirm = page.getByTestId('archive-confirm');
    await expect(confirm).toBeVisible();
    const go = confirm.getByRole('button', { name: 'Archive project' });
    await expect(go).toBeDisabled();

    const input = confirm.getByRole('textbox');
    await input.fill('ATLA');
    await expect(go).toBeDisabled();
    await input.fill('ATLAS');
    await expect(go).toBeEnabled();
    expect(archived).toBe(0);
    await go.click();
    await expect.poll(() => archived).toBe(1);
  });
});
