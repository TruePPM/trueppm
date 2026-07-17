import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program agent-oversight panel E2E (#2020).
 *
 * Drives the real UI against mocked endpoints: the membership-scoped agent-action
 * log (`agent-actions?program=`), the program object + projects, and the program
 * forecast rollup. Every endpoint the panel's hooks read is mocked with its real
 * shape — never leaning on the catch-all for an object endpoint (the #1190 lesson).
 * Covers the golden path (Activity → row drawer → Refusals → Forecast) and the
 * "no agents connected yet" empty state.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000002020';

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
  name: 'Website Replatform',
  description: 'Marketing site rebuild',
  code: 'WEB',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 2,
  member_count: 3,
};

const PROJECTS = [
  { id: 'proj-core', name: 'Platform Core' },
  { id: 'proj-mig', name: 'Migration Tooling' },
];

function action(overrides: Record<string, unknown> = {}) {
  return {
    id: `act-${Math.random().toString(36).slice(2)}`,
    schema_version: 1,
    sequence: 1274,
    actor_kind: 'mcp_token',
    actor_token_prefix: '3f9a1122',
    principal: ME_ID,
    action: 'get_schedule',
    method: 'GET',
    object_type: 'project',
    object_id: 'proj-core',
    project: 'proj-core',
    capability_used: 'mcp:read',
    verdict: 'allowed',
    refusal_reason: '',
    refusal_detail: null,
    engine_version: 'trueppm-scheduler 0.4.1',
    payload_hash: 'c7e25510payload',
    record_hash: '9f2ca71bRECORD',
    summary: '',
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

const ALLOWED = action({ sequence: 1274, action: 'get_schedule', verdict: 'allowed' });
const REFUSED = action({
  sequence: 1251,
  action: 'get_forecast',
  verdict: 'refused',
  refusal_reason: 'policy',
  capability_used: 'mcp:read',
});

const ROLLUP = {
  aggregation_policy: 'worst',
  policy_available: true,
  project_count: 2,
  program_health: 'at_risk',
  kpis: { p80_completion: { available: true, value: 'Nov 2' } },
};

type Page = import('@playwright/test').Page;

async function setup(page: Page, { rows = [ALLOWED, REFUSED] }: { rows?: unknown[] } = {}) {
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
  const paginated = (results: unknown[]) =>
    pj({ count: results.length, next: null, previous: null, results });

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
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(PROJECTS) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(ROLLUP) }),
  );
  // URL-predicate matcher so the ?program=&verdict= query string can't defeat a
  // path glob. Branches on ?verdict= so the Refusals view sees only refused rows.
  await page.route(
    (url) => url.pathname === '/api/v1/agent-actions/',
    (r) => {
      const verdict = new URL(r.request().url()).searchParams.get('verdict');
      const list =
        verdict === 'refused'
          ? (rows as { verdict?: string }[]).filter((a) => a.verdict === 'refused')
          : rows;
      return r.fulfill({ status: 200, contentType: 'application/json', body: paginated(list) });
    },
  );

  await page.goto(`/programs/${PROGRAM_ID}/agents`);
}

test.describe('Program agent-oversight panel', () => {
  test('golden path — activity, row drawer, refusals, forecast', async ({ page }) => {
    await setup(page);

    // Page-rendered signal before interacting with chrome.
    await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();

    // Activity shows the allowed action + its verdict.
    const table = page.getByRole('table').first();
    await expect(table.getByText('get_schedule')).toBeVisible();
    await expect(table.getByText('Allowed')).toBeVisible();

    // Open the row drawer and read the chain record_hash verbatim.
    await page.getByRole('button', { name: /Action #1274, get_schedule, Allowed/i }).click();
    const drawer = page.getByRole('dialog', { name: /Action #1274/i });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('record_hash')).toBeVisible();
    await expect(drawer.getByText('9f2ca71bRECORD')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    // Switch to Refusals — see the policy refusal and its why-string.
    await page.getByRole('tab', { name: 'Refusals' }).click();
    await expect(page.getByText(/Missing mcp:read scope/i)).toBeVisible();
    await expect(page.getByText(/arrives with 0.6 writes/i)).toBeVisible();

    // Switch to Forecast impact — see the rollup P80 + the honest N=0 strip.
    await page.getByRole('tab', { name: 'Forecast impact' }).click();
    await expect(page.getByText('Nov 2')).toBeVisible();
    await expect(page.getByText(/No agent-completed work yet/i)).toBeVisible();
  });

  test('empty state — no agents connected yet', async ({ page }) => {
    await setup(page, { rows: [] });
    await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
    await expect(page.getByText(/No agent activity yet/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /Connect an agent/i })).toBeVisible();
  });
});
