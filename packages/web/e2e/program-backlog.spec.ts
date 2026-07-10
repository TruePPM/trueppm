import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program backlog E2E (#742).
 *
 * Drives the real UI against mocked ADR-0069 endpoints (#737): the backlog-item
 * list, the program's projects (pull targets), and the pull action. Covers the
 * golden path (search → select → pull → confirmation) and the no-results state.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000742';

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
  name: 'Artemis Program',
  description: 'Crewed lift program',
  code: 'ARTM',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400, // Owner (ROLE_OWNER) — can create / pull / delete
  my_role_label: 'Program Admin',
  project_count: 3,
  member_count: 4,
};

const PROJECTS = [
  { id: 'proj-lift', name: 'Artemis IV Lift' },
  { id: 'proj-avionics', name: 'Avionics' },
  { id: 'proj-ground', name: 'Ground Ops' },
];

function apiItem(
  i: number,
  title: string,
  item_type: string,
  status: 'proposed' | 'pulled' = 'proposed',
) {
  return {
    id: `item-${String(i).padStart(3, '0')}`,
    server_version: 1,
    program: PROGRAM_ID,
    title,
    description: '',
    item_type,
    status,
    tags: [],
    priority_rank: i,
    story_points: null,
    pulled_task: status === 'pulled' ? `task-${i}` : null,
    pulled_at: status === 'pulled' ? '2026-05-23T00:00:00Z' : null,
    pulled_by: null,
    created_by: ME_ID,
    created_at: '2026-05-10T00:00:00Z',
    updated_at: '2026-05-20T00:00:00Z',
  };
}

// 9 items total: 7 proposed, 2 pulled — drives "All 9 · Proposed 7 · Pulled 2".
const BACKLOG_ITEMS = [
  apiItem(1, 'Crew safety review', 'epic'),
  apiItem(2, 'Range licensing coordination', 'story'),
  apiItem(3, 'Telemetry channel B', 'story'),
  apiItem(4, 'FAT prep harness', 'spike'),
  apiItem(5, 'Decommission legacy console', 'chore'),
  apiItem(6, 'Valve telemetry dropout', 'bug'),
  apiItem(7, 'Weather-hold automation', 'story'),
  apiItem(8, 'Pad water-deluge study', 'spike', 'pulled'),
  apiItem(9, 'Bench power supply upgrade', 'chore', 'pulled'),
];

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

  // Catch-all first; specific routes registered after win (last-match wins).
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
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
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/backlog-items/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(BACKLOG_ITEMS) }),
  );
  // Pull action (registered last so it wins over the list route for this path).
  await page.route('**/api/v1/programs/*/backlog-items/*/pull/', (r) =>
    r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: pj({ task: { id: 'task-new' } }),
    }),
  );

  await page.goto(`/programs/${PROGRAM_ID}/backlog`);
}

test.describe('Program backlog', () => {
  test('golden path — search, select, pull', async ({ page }) => {
    await setup(page);

    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();
    const row = page.getByRole('button', { name: 'Telemetry channel B', exact: true });
    await expect(row).toBeVisible();

    // Search narrows the match counter. Use "Telemetry channel" (unique to the
    // target row) rather than bare "Telemetry", which also matches "Valve
    // telemetry dropout" and would make the counter "2 of 9".
    await page.getByRole('searchbox', { name: 'Search backlog' }).fill('Telemetry channel');
    await expect(page.getByText('1 of 9')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();

    // Select → detail pane.
    await row.click();
    await expect(page.getByRole('heading', { name: 'Telemetry channel B' })).toBeVisible();

    // Enter the pull flow and confirm to Avionics.
    await page.getByRole('button', { name: 'Pull to project…' }).click();
    // "Target project" also appears in the sr-only announcement and the
    // explainer copy; match the section label exactly.
    await expect(page.getByText('Target project', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: /Avionics/ }).click();
    await page.getByRole('button', { name: 'Pull to Avionics' }).click();

    // Confirmation toast.
    await expect(page.getByText('Pulled to Avionics.')).toBeVisible();
  });

  test('no-results state offers recovery', async ({ page }) => {
    await setup(page);

    await page.getByRole('searchbox', { name: 'Search backlog' }).fill('quasar');
    await expect(page.getByText('Nothing matches "quasar"')).toBeVisible();
    // Two controls share the accessible name "Clear search" while the no-results
    // panel is up (the search field's icon button via aria-label, and this
    // recovery button). Target the recovery button by its visible text — the
    // icon button has none — to avoid a strict-mode match on both.
    await expect(page.getByText('Clear search')).toBeVisible();
  });
});
