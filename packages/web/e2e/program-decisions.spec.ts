import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program decision log E2E (#4772, ADR-1310).
 *
 * Golden path: reach Decisions from shell v2's More menu, log a decision, mark it
 * made — it moves from Awaiting to Made. Plus the empty state and a load error.
 *
 * The decisions mock is STATEFUL: every write invalidates the list and the app
 * refetches it, so a stateless list would erase the write it just made (see the
 * `setupTaskStore` note in CLAUDE.md).
 */

const ME_ID = 1;
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000004772';

const FIXTURE_ME = {
  id: String(ME_ID),
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Apollo Program',
  description: 'Decision log',
  code: 'APOLLO',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  created_by: ME_ID,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 0,
  member_count: 1,
};

const MEMBERS = [
  {
    id: 'pm-1',
    server_version: 1,
    program: PROGRAM_ID,
    user: ME_ID,
    user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
    role: 400,
    role_label: 'Program Admin',
    joined_at: '2026-10-01T00:00:00Z',
    role_changed_at: null,
    reinstated_at: null,
  },
];

type Decision = Record<string, unknown> & { id: string; status: string };
type Page = import('@playwright/test').Page;

async function setup(page: Page, opts: { failList?: boolean } = {}) {
  const decisions: Decision[] = [];
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
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
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(MEMBERS) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/decisions/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const detail = /\/decisions\/([^/]+)\/$/.exec(url.pathname);
    if (req.method() === 'GET' && !detail) {
      if (opts.failList) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        return;
      }
      const status = url.searchParams.get('status');
      const results = decisions.filter((d) => !status || d.status === status);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ count: results.length, next: null, previous: null, results }),
      });
      return;
    }
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      const now = '2026-10-31T12:00:00Z';
      const row: Decision = {
        id: `dec-${decisions.length + 1}`,
        server_version: 1,
        program: PROGRAM_ID,
        title: body.title,
        owner: body.owner ?? null,
        owner_detail: body.owner ? { id: ME_ID, username: 'alice', display_name: 'Alice' } : null,
        due_date: body.due_date ?? null,
        status: 'awaiting',
        decided_at: null,
        linked_task: null,
        linked_risk: null,
        link: null,
        impact_note: body.impact_note ?? '',
        created_by: ME_ID,
        created_at: now,
        updated_at: now,
      };
      decisions.push(row);
      await route.fulfill({ status: 201, contentType: 'application/json', body: pj(row) });
      return;
    }
    if (req.method() === 'PATCH' && detail) {
      const row = decisions.find((d) => d.id === detail[1]);
      if (!row) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        return;
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      Object.assign(row, body);
      if (body.status === 'made') row.decided_at = '2026-10-31T13:00:00Z';
      if (body.status === 'awaiting') row.decided_at = null;
      await route.fulfill({ status: 200, contentType: 'application/json', body: pj(row) });
      return;
    }
    await route.fallback();
  });
}

test.describe('program decision log', () => {
  test('reach Decisions from More, log a decision, then mark it made', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/overview`);

    await page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('button', { name: 'More' })
      .click();
    await page
      .getByRole('menu', { name: 'More views' })
      .getByRole('menuitem', { name: 'Decisions' })
      .click();
    // Program links canonicalize to the program key, not the UUID (ADR-1237).
    await expect(page).toHaveURL(/\/programs\/APOLLO\/decisions$/);
    await expect(page.getByText('No decisions logged')).toBeVisible();

    await page.getByRole('button', { name: 'Log a decision' }).click();
    const form = page.getByRole('form', { name: 'Log a decision' });
    await form.getByLabel('Decision').fill('Go or no-go on vendor cutover');
    await form.getByLabel('Owner', { exact: true }).selectOption('1');
    await form.getByLabel('Due date').fill('2030-11-20');
    await form.getByLabel("Owner's impact estimate").fill('recovers 2 days');
    await form.getByRole('button', { name: 'Save decision' }).click();

    const awaiting = page.getByRole('region', { name: /Awaiting/ });
    await expect(awaiting.getByText('Go or no-go on vendor cutover')).toBeVisible();
    await expect(awaiting.getByText('recovers 2 days')).toBeVisible();
    await expect(awaiting.getByText(/Owner's estimate · as of/)).toBeVisible();
    await expect(awaiting.getByText('Alice')).toBeVisible();

    await awaiting.getByRole('button', { name: 'Mark made' }).click();

    const made = page.getByRole('region', { name: /Made/ });
    await expect(made.getByText('Go or no-go on vendor cutover')).toBeVisible();
    await expect(made.getByText(/Decided /)).toBeVisible();
    await expect(awaiting.getByText('Nothing is waiting on a decision.')).toBeVisible();
  });

  test('shows the empty state with no decisions logged', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/decisions`);
    await expect(page.getByRole('heading', { name: 'Decisions', level: 1 })).toBeVisible();
    await expect(page.getByText('No decisions logged')).toBeVisible();
  });

  test('a failed load says so instead of showing an empty log', async ({ page }) => {
    await setup(page, { failList: true });
    await page.goto(`/programs/${PROGRAM_ID}/decisions`);
    await expect(page.getByText("Couldn't load decisions.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('No decisions logged')).toHaveCount(0);
  });
});
