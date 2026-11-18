import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Workspace `/settings/webhooks` E2E (#3549).
 *
 * In the OSS edition this route is NOT a workspace webhook manager: it is the same
 * redirect shim as `/settings/integrations` (ADR-0076) — webhooks are configured per
 * project, and the workspace-level manager is an Enterprise slot. The shim has three
 * states, driven by how many projects the user can see; each is asserted here.
 */

const PROJECT_ID = 'e2e-wh-00000000-0000-0000-0000-000000003549';
const PROJECT_ID_TWO = 'e2e-wh-00000000-0000-0000-0000-000000003550';

const project = (id: string, name: string) => ({
  id,
  name,
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  methodology: 'HYBRID',
});

const ME = {
  can_access_admin_settings: true,
  id: 'user-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const json = (data: unknown) => JSON.stringify(data);

async function routes(page: Page, projects: ReturnType<typeof project>[]) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  // Catch-all first so an unmocked read 404s loudly instead of 401ing (#1513, #2366).
  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: json({ count: projects.length, next: null, previous: null, results: projects }),
    }),
  );
  for (const p of projects) {
    await page.route(`**/api/v1/projects/${p.id}/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: json(p) }),
    );
  }
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: json(ME) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: json([]) }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: json({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

test.describe('Workspace /settings/webhooks (redirect shim)', () => {
  test('empty state: no projects explains webhooks are per project', async ({ page }) => {
    await routes(page, []);
    await page.goto('/settings/webhooks');

    await expect(
      page.getByRole('heading', { name: 'Integrations are configured per project' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create your first project' })).toBeVisible();
    await expect(page.getByText(/part of the Enterprise edition/i)).toBeVisible();
  });

  test('a single project is a transparent redirect to its integrations tab', async ({ page }) => {
    await routes(page, [project(PROJECT_ID, 'Only Project')]);
    await page.goto('/settings/webhooks');

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/settings[#/]integrations`));
  });

  test('2+ projects render a picker whose links target each project', async ({ page }) => {
    await routes(page, [
      project(PROJECT_ID, 'Alpha Project'),
      project(PROJECT_ID_TWO, 'Beta Project'),
    ]);
    await page.goto('/settings/webhooks');

    await expect(
      page.getByRole('heading', { name: /Which project's integrations/i }),
    ).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: 'Alpha Project', exact: true })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/settings/integrations`,
    );
    await expect(main.getByRole('link', { name: 'Beta Project', exact: true })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID_TWO}/settings/integrations`,
    );
  });

  test('picker link navigates to the chosen project integrations tab', async ({ page }) => {
    await routes(page, [
      project(PROJECT_ID, 'Alpha Project'),
      project(PROJECT_ID_TWO, 'Beta Project'),
    ]);
    await page.goto('/settings/webhooks');
    await page.getByRole('main').getByRole('link', { name: 'Beta Project', exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${PROJECT_ID_TWO}/settings[#/]integrations`),
    );
  });
});
