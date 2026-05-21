import { test, expect, type Page } from '@playwright/test';

/**
 * Project Settings → Integrations E2E (#569, ADR-0076).
 *
 * Golden path:
 *   - Settings → Integrations renders both section cards with summary data
 *   - Multi-project picker appears at /settings/integrations when the user
 *     has two or more projects (redirect shim contract from ADR-0076)
 *   - 503 per-section fallback shows a Retry button on the failed card
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

const FIXTURE_PROJECT_TWO = {
  ...FIXTURE_PROJECT,
  id: PROJECT_ID_TWO,
  name: 'Second Project',
};

const FIXTURE_ME = {
  id: 'user-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_SUMMARY_WITH_DATA = {
  webhooks: {
    items: [
      {
        id: 'wh-1',
        url: 'https://hooks.slack.com/services/X/Y/Z',
        is_active: true,
        events: ['task.created'],
        created_at: '2026-05-20T12:00:00Z',
        last_delivery: {
          status: 'success',
          created_at: '2026-05-20T12:30:00Z',
          response_status: 200,
          attempt_count: 1,
        },
        recent_failure_count: 0,
      },
    ],
    total: 1,
    active_total: 1,
    last_delivery_at: '2026-05-20T12:30:00Z',
  },
  api_tokens: {
    items: [
      {
        id: 'tok-1',
        name: 'CI Pipeline',
        token_prefix: 'tppm_a1b',
        created_at: '2026-05-15T00:00:00Z',
        last_used_at: '2026-05-20T11:00:00Z',
      },
    ],
    active_total: 1,
    last_used_at: '2026-05-20T11:00:00Z',
  },
};

const FIXTURE_SUMMARY_EMPTY = {
  webhooks: { items: [], total: 0, active_total: 0, last_delivery_at: null },
  api_tokens: { items: [], active_total: 0, last_used_at: null },
};

async function commonRoutes(page: Page, projects: typeof FIXTURE_PROJECT[]) {
  const pj = (data: unknown) => JSON.stringify(data);

  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // /projects/ list is paginated — `useProjects` reads .results
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: projects.length, next: null, previous: null, results: projects }),
    }),
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
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
      }),
    }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ results: [] }) }),
  );
}

test.describe('Project Integrations — golden path', () => {
  test('renders both section cards with summary data', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT]);
    await page.route(
      `**/api/v1/projects/${PROJECT_ID}/integrations-summary/`,
      (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(FIXTURE_SUMMARY_WITH_DATA),
        }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);

    await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
    await expect(page.getByText('Outbound webhooks')).toBeVisible();
    await expect(page.getByText('Inbound API tokens')).toBeVisible();
    await expect(
      page.getByText('https://hooks.slack.com/services/X/Y/Z'),
    ).toBeVisible();
    await expect(page.getByText('CI Pipeline')).toBeVisible();
  });

  test('renders page-level empty state when both sections are empty', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT]);
    await page.route(
      `**/api/v1/projects/${PROJECT_ID}/integrations-summary/`,
      (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(FIXTURE_SUMMARY_EMPTY),
        }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);

    await expect(page.getByText('No integrations yet')).toBeVisible();
    await expect(page.getByText(/Add a webhook/)).toBeVisible();
  });

  test('shows per-section Retry when aggregator returns 503', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT]);
    await page.route(
      `**/api/v1/projects/${PROJECT_ID}/integrations-summary/`,
      (r) =>
        r.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ failed: 'webhooks' }),
        }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);

    await expect(page.getByText(/Couldn.t load this section/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Retry/i })).toBeVisible();
  });
});

test.describe('Workspace integrations redirect shim', () => {
  test('renders multi-project picker when the user has 2+ projects', async ({ page }) => {
    await commonRoutes(page, [FIXTURE_PROJECT, FIXTURE_PROJECT_TWO]);

    await page.goto('/settings/integrations');

    await expect(
      page.getByRole('heading', { name: /Which project's integrations/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Integrations Test Project', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Second Project', exact: true }),
    ).toBeVisible();
  });
});
