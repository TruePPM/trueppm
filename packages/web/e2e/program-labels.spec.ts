import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program label view E2E (#2333, ADR-0638).
 *
 * Golden path (pick a label → grouped cross-project results) plus the two states
 * that carry the design's actual risk: the withheld-projects disclosure, and the
 * empty result where that disclosure is the likely explanation.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000002333';

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
  name: 'Apollo Program',
  description: 'Cross-project label view',
  code: 'APOLLO',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  created_by: ME_ID,
  created_at: '2026-07-26T00:00:00Z',
  updated_at: '2026-07-26T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 2,
  member_count: 3,
};

const CATALOG = {
  results: [
    { name: 'security-review', project_count: 2 },
    { name: 'performance', project_count: 1 },
  ],
  withheld_project_count: 0,
};

function taskRow(
  id: string,
  name: string,
  wbs: string,
  project: { id: string; name: string; code: string },
  label: { id: string; name: string; color: string },
) {
  return {
    id,
    short_id: id.toUpperCase(),
    name,
    wbs_path: wbs,
    status: 'NOT_STARTED',
    percent_complete: 0,
    early_finish: '2026-03-04',
    is_milestone: false,
    project,
    labels: [label],
  };
}

const ARES = { id: 'proj-ares', name: 'Ares Platform', code: 'APL' };
const BEACON = { id: 'proj-beacon', name: 'Beacon API', code: 'BCN' };

const TASKS = {
  count: 2,
  next: null,
  previous: null,
  withheld_project_count: 0,
  results: [
    taskRow('t1', 'Threat model sign-off', '1.2.1', ARES, {
      id: 'l1',
      name: 'security-review',
      color: 'teal',
    }),
    taskRow('t2', 'Auth review', '2.1.3', BEACON, {
      id: 'l2',
      name: 'Security-Review',
      color: 'amber',
    }),
  ],
};

type Page = import('@playwright/test').Page;

async function setup(page: Page, tasks: unknown = TASKS, catalog: unknown = CATALOG) {
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

  // Catch-all first; specific routes registered after win (last-match wins).
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/label-catalog/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(catalog) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/label-tasks/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(tasks) }),
  );
}

test.describe('program label view', () => {
  test('prompts for a label, then shows matches grouped by project', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/labels`);

    await expect(page.getByText('Pick a label to see its work')).toBeVisible();

    await page.getByLabel('Label').selectOption('security-review');

    await expect(page.getByRole('heading', { name: /Ares Platform/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Beacon API/ })).toBeVisible();
    await expect(page.getByText('Threat model sign-off')).toBeVisible();
    await expect(page.getByText('Auth review')).toBeVisible();
  });

  test('catalog counts read as projects, not tasks', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/labels`);

    await expect(
      page.getByRole('option', { name: 'security-review — in 2 projects', exact: true }),
    ).toBeAttached();
    await expect(
      page.getByRole('option', { name: 'performance — in 1 project', exact: true }),
    ).toBeAttached();
  });

  test('explains that label colors are per project when they differ', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/labels?fl=security-review`);

    await expect(page.getByText(/Label colors are set per project/)).toBeVisible();
  });

  test('discloses projects withheld for lack of membership', async ({ page }) => {
    await setup(page, { ...TASKS, withheld_project_count: 2 });
    await page.goto(`/programs/${PROGRAM_ID}/labels?fl=security-review`);

    await expect(page.getByTestId('withheld-note')).toHaveText(
      "2 projects in this program aren't shown — you're not a member of them.",
    );
  });

  test('empty result still carries the withheld disclosure', async ({ page }) => {
    await setup(page, {
      count: 0,
      next: null,
      previous: null,
      withheld_project_count: 1,
      results: [],
    });
    await page.goto(`/programs/${PROGRAM_ID}/labels?fl=security-review`);

    await expect(page.getByText(/No tasks carry/)).toBeVisible();
    await expect(page.getByTestId('withheld-note')).toHaveText(
      "1 project in this program isn't shown — you're not a member of it.",
    );
  });
});
