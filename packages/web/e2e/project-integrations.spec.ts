import { test, expect, type Page } from '@playwright/test';

/**
 * Project Settings → Integrations E2E (#638 / #600, ADR-0076).
 *
 * Covers the webhook + API-token CRUD UI that replaced the read-only summary:
 *   - golden path: both managers render their lists
 *   - opening the webhook editor (format picker + real-11-event picker)
 *   - API-token one-time reveal on create
 *   - empty + error states
 *   - the multi-project redirect shim at /settings/integrations
 */

const PROJECT_ID = 'e2e-integrations-00000000-0000-0000-0000-000000000569';
const PROJECT_ID_TWO = 'e2e-integrations-00000000-0000-0000-0000-000000000570';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Integrations Test Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  methodology: 'HYBRID',
};

const FIXTURE_PROJECT_TWO = { ...FIXTURE_PROJECT, id: PROJECT_ID_TWO, name: 'Second Project' };

const FIXTURE_ME = {
  id: 'user-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const WEBHOOK = {
  id: 'wh-1',
  project: PROJECT_ID,
  program: null,
  url: 'https://hooks.slack.com/services/X/Y/Z',
  events: ['task.created'],
  format: 'slack',
  is_active: true,
  created_at: '2026-05-20T12:00:00Z',
  created_by: null,
};

const TOKEN = {
  id: 'tok-1',
  project: PROJECT_ID,
  program: null,
  name: 'CI Pipeline',
  token_prefix: 'tppm_a1b',
  status_map: {},
  created_by: null,
  created_at: '2026-05-15T00:00:00Z',
  last_used_at: '2026-05-20T11:00:00Z',
  revoked_at: null,
  is_revoked: false,
};

const pj = (data: unknown) => JSON.stringify(data);
const page1 = (results: unknown[]) =>
  pj({ count: results.length, next: null, previous: null, results });

async function commonRoutes(page: Page, projects: (typeof FIXTURE_PROJECT)[]) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Catch-all so no unmocked /api/v1 call 401s into the session-expired loop
  // (registered first; the specific routes below override it — last wins).
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: page1([]) }),
  );

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: page1(projects) }),
  );
  for (const p of projects) {
    await page.route(`**/api/v1/projects/${p.id}/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(p) }),
    );
  }
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ results: [] }) }),
  );
}

/** Wire the webhook + token LIST endpoints with the given rows. */
async function listRoutes(
  page: Page,
  { webhooks, tokens }: { webhooks: unknown[]; tokens: unknown[] },
) {
  await page.route(`**/api/v1/projects/${PROJECT_ID}/webhooks/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: page1(webhooks) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/api-tokens/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: page1(tokens) }),
  );
}

test.describe('Project Integrations — CRUD UI', () => {
  test('renders both managers with their lists', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT]);
    await listRoutes(page, { webhooks: [WEBHOOK], tokens: [TOKEN] });

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);

    await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
    await expect(page.getByText('Outbound webhooks')).toBeVisible();
    await expect(page.getByText('Inbound API tokens')).toBeVisible();
    await expect(page.getByText('https://hooks.slack.com/services/X/Y/Z')).toBeVisible();
    await expect(page.getByText('CI Pipeline')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New webhook' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create token' })).toBeVisible();
    // Roadmap callout (#588) — the "this is coming" discoverability signal.
    await expect(page.getByRole('heading', { name: 'Coming soon' })).toBeVisible();
  });

  test('opens the webhook editor with the real event catalog', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT]);
    await listRoutes(page, { webhooks: [], tokens: [] });

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);
    await page.getByRole('button', { name: 'New webhook' }).click();

    const dialog = page.getByRole('dialog', { name: 'New webhook' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('task.assigned')).toBeVisible();
    // The new 0.2 events carry a "new" badge.
    await expect(dialog.getByText('new').first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create webhook' })).toBeVisible();
  });

  test('creates a webhook — POST dispatched and the new row appears', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT]);
    await listRoutes(page, { webhooks: [], tokens: [] });

    const NEW_WEBHOOK = { ...WEBHOOK, id: 'wh-new', url: 'https://example.com/hooks/ci' };
    // Stateful: GET returns [] until the POST lands, then the new row (the create
    // hook invalidates + refetches the list).
    let created = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/webhooks/`, (r) => {
      if (r.request().method() === 'POST') {
        created = true;
        return r.fulfill({ status: 201, contentType: 'application/json', body: pj(NEW_WEBHOOK) });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: page1(created ? [NEW_WEBHOOK] : []),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);
    await page.getByRole('button', { name: 'New webhook' }).click();

    const dialog = page.getByRole('dialog', { name: 'New webhook' });
    await dialog.getByPlaceholder('hooks.slack.com/services').fill('https://example.com/hooks/ci');
    await dialog.getByPlaceholder('whsec_').fill('whsec_supersecret');
    await dialog.getByText('task.assigned', { exact: true }).click(); // subscribe to ≥1 event

    const postReq = page.waitForRequest(
      (req) =>
        req.url().includes(`/projects/${PROJECT_ID}/webhooks/`) && req.method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Create webhook' }).click();
    await postReq;

    await expect(dialog).toBeHidden();
    const section = page.locator('[data-settings-section="integrations"]');
    await expect(section.getByText('https://example.com/hooks/ci')).toBeVisible();
  });

  test('deletes a webhook — confirm dispatches DELETE and the row disappears', async ({
    page,
  }) => {
    await commonRoutes(page, [FIXTURE_PROJECT]);
    await listRoutes(page, { webhooks: [], tokens: [] });

    let deleted = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/webhooks/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: page1(deleted ? [] : [WEBHOOK]),
      }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/webhooks/${WEBHOOK.id}/`, (r) => {
      if (r.request().method() === 'DELETE') {
        deleted = true;
        return r.fulfill({ status: 204, contentType: 'application/json', body: '' });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WEBHOOK) });
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);
    const section = page.locator('[data-settings-section="integrations"]');
    const row = section.getByRole('listitem').filter({ hasText: WEBHOOK.url });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete webhook?' });
    await expect(confirm).toBeVisible();

    const delReq = page.waitForRequest(
      (req) => req.url().includes(`/webhooks/${WEBHOOK.id}/`) && req.method() === 'DELETE',
    );
    await confirm.getByRole('button', { name: 'Delete webhook' }).click();
    await delReq;

    // Assert the confirm dialog closed before checking the row is gone: its body
    // ("This stops deliveries to {url}…") also contains WEBHOOK.url, so a broad
    // section-scoped getByText(url) matched both the row span and the dialog <p>
    // mid-close — a strict-mode collision that raced green and only failed under
    // CI shard load. Scope to the listitem row (the dialog <p> is not a listitem).
    await expect(confirm).toBeHidden();
    await expect(row).toBeHidden();
    await expect(section.getByText(/No webhooks yet/i)).toBeVisible();
  });

  test('reveals a new API token exactly once', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT]);
    await listRoutes(page, { webhooks: [], tokens: [] });
    await page.route(
      `**/api/v1/projects/${PROJECT_ID}/api-tokens/`,
      (r) => {
        if (r.request().method() === 'POST') {
          return r.fulfill({
            status: 201,
            contentType: 'application/json',
            body: pj({ ...TOKEN, id: 'tok-new', token: 'tppm_THE_RAW_SECRET_VALUE' }),
          });
        }
        return r.fulfill({ status: 200, contentType: 'application/json', body: page1([]) });
      },
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);
    await page.getByRole('button', { name: 'Create token' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create API token' });
    await dialog.getByPlaceholder('e.g. Jira Production').fill('My CI token');
    await dialog.getByRole('button', { name: 'Create token' }).click();

    await expect(page.getByText(/only time you.ll see this token/i)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'New API token' })).toHaveValue(
      'tppm_THE_RAW_SECRET_VALUE',
    );
  });

  test('shows empty states when there are no integrations', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT]);
    await listRoutes(page, { webhooks: [], tokens: [] });

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);

    await expect(page.getByText(/No webhooks yet/i)).toBeVisible();
    await expect(page.getByText(/No tokens yet/i)).toBeVisible();
  });

  test('shows an error + Retry when the webhook list fails', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT]);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/webhooks/`, (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: pj({ detail: 'boom' }) }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/api-tokens/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: page1([]) }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);

    // Scope to the Integrations section: the consolidated page (ADR-0146) mounts
    // every section, and sibling sections backed only by the catch-all mock
    // render their own "Retry" error states — so an unscoped Retry collides.
    const section = page.locator('[data-settings-section="integrations"]');
    await expect(section.getByText(/Couldn.t load webhooks/i)).toBeVisible();
    await expect(section.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});

test.describe('Workspace integrations redirect shim', () => {
  test('renders multi-project picker when the user has 2+ projects', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT, FIXTURE_PROJECT_TWO]);

    await page.goto('/settings/integrations');

    await expect(
      page.getByRole('heading', { name: /Which project's integrations/i }),
    ).toBeVisible();
    // The workspace `/settings/integrations` shim (IntegrationsRedirect) renders
    // OUTSIDE SettingsShell now (ADR-0146) — it's a standalone redirect page, not
    // a consolidated section — so there's no `settings-content-scroll` panel.
    // Scope to the main content region to keep the picker links disambiguated
    // from the redesigned sidebar (#959) project rows.
    const picker = page.getByRole('main');
    await expect(
      picker.getByRole('link', { name: 'Integrations Test Project', exact: true }),
    ).toBeVisible();
    await expect(
      picker.getByRole('link', { name: 'Second Project', exact: true }),
    ).toBeVisible();
  });
});
