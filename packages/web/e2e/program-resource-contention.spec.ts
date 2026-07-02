import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program resource-contention view E2E (#1149).
 *
 * Golden path: the Resources tab renders people over-allocated across the
 * program's projects, with the cross-project breakdown and an over-allocation
 * flag. Plus the schedule-not-run (409) empty state.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000001149';

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
  name: 'GA Launch',
  description: '1.0 GA',
  methodology: 'HYBRID',
  created_by: ME_ID,
  created_at: '2026-07-06T00:00:00Z',
  updated_at: '2026-07-06T00:00:00Z',
  my_role: 400,
  my_role_label: 'Project Admin',
  project_count: 2,
  member_count: 1,
};

const CONTENTION = {
  program_id: PROGRAM_ID,
  window_start: '2026-07-06',
  window_end: '2026-08-02',
  resources: [
    {
      id: 'r-janus',
      name: 'Janus',
      email: 'janus@trueppm.demo',
      max_units: '1.00',
      tasks: [
        {
          assignment_id: 'a1',
          id: 't1',
          name: 'Remediate criticals',
          project_id: 'p-sec',
          project_name: 'Security',
          early_start: '2026-07-13',
          early_finish: '2026-07-21',
          units: '1.00',
          status: 'IN_PROGRESS',
        },
        {
          assignment_id: 'a2',
          id: 't2',
          name: 'Evidence collection',
          project_id: 'p-soc',
          project_name: 'SOC2',
          early_start: '2026-07-13',
          early_finish: '2026-07-20',
          units: '0.50',
          status: 'NOT_STARTED',
        },
      ],
    },
  ],
};

type Page = import('@playwright/test').Page;

async function setup(page: Page, contention: { status: number; body: unknown }) {
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

  // Catch-all 401-guard FIRST (last-registered-wins): the program shell + ⌘K
  // palette read endpoints this spec does not mock (notifications, ws ticket,
  // calendars, …) which would otherwise fall through to the real backend and
  // 401 into the session-expired modal mid-test (issue 1572 / #1190 class).
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
  await page.route('**/api/v1/me/work/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ results: [], due_today_count: 0 }) }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [FIXTURE_PROGRAM], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
  // The contention endpoint under test.
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/resource-contention/**`, (r) =>
    r.fulfill({ status: contention.status, contentType: 'application/json', body: pj(contention.body) }),
  );
}

test.describe('Program resource contention (#1149)', () => {
  test('Resources tab shows cross-project allocation and an over-allocation flag', async ({ page }) => {
    await setup(page, { status: 200, body: CONTENTION });
    await page.goto(`/programs/${PROGRAM_ID}/resources`);

    await expect(page.getByRole('heading', { name: 'Resource contention' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('Janus')).toBeVisible();
    // Both source projects of the contention are listed.
    await expect(page.getByText('Security')).toBeVisible();
    await expect(page.getByText('SOC2')).toBeVisible();
    // 1.0 + 0.5 in the same window → over-allocated badge (color + text + aria-label).
    await expect(page.getByLabel(/Over-allocated in W/)).toBeVisible();
  });

  test('shows the schedule-not-run empty state on 409', async ({ page }) => {
    await setup(page, {
      status: 409,
      body: { detail: 'Schedule has not been computed. Run the scheduler first.' },
    });
    await page.goto(`/programs/${PROGRAM_ID}/resources`);
    await expect(page.getByText(/has a computed schedule yet/)).toBeVisible({ timeout: 10_000 });
  });
});
