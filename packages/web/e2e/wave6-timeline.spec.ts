import { test, expect } from '@playwright/test';

/**
 * Wave 6 — Resource allocation timeline (issue #164, ADR-0031).
 *
 * Golden path: SCHEDULER user opens Timeline sub-tab → resource rows and
 * task bars render with correct colour coding, overallocation badge appears,
 * inline edit popover opens on click, unscheduled tray renders.
 *
 * All API calls are intercepted via page.route() — no backend required.
 */

const PROJECT_ID = 'e2e-timeline-00000000-0000-0000-0000-000000000007';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Timeline Test Project',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  estimation_mode: 'open',
};

// Alice: two overlapping tasks in W18 → overallocated (sum 0.80 + 0.50 > 1.0).
// Bob: one partial task (no overlap), one normal task, one unscheduled.
const FIXTURE_ALLOCATION = {
  project_id: PROJECT_ID,
  window_start: '2026-04-13', // Mon W16
  window_end: '2026-05-10',   // Sun W19
  resources: [
    {
      id: 'res-alice',
      name: 'Alice Kim',
      email: 'alice@example.com',
      max_units: '1.00',
      tasks: [
        {
          assignment_id: 'asgn-1',
          id: 'task-1',
          name: 'Design Sprint',
          early_start: '2026-04-20', // W17
          early_finish: '2026-05-03', // spans W17–W18
          units: '0.80',
          status: 'IN_PROGRESS',
        },
        {
          assignment_id: 'asgn-2',
          id: 'task-2',
          name: 'Risk Review',
          early_start: '2026-04-27', // W18 — overlaps asgn-1 (sum 1.30 > 1.0)
          early_finish: '2026-05-10',
          units: '0.50',
          status: 'NOT_STARTED',
        },
      ],
    },
    {
      id: 'res-bob',
      name: 'Bob Nguyen',
      email: 'bob@example.com',
      max_units: '1.00',
      tasks: [
        {
          // No overlap with anything — safe to click for edit tests
          assignment_id: 'asgn-3',
          id: 'task-3',
          name: 'Backend API',
          early_start: '2026-04-13',
          early_finish: '2026-04-26', // entirely in W16–W17, no overlap
          units: '0.50',
          status: 'IN_PROGRESS',
        },
        {
          // Unscheduled — no CPM dates
          assignment_id: 'asgn-4',
          id: 'task-4',
          name: 'Load Testing',
          early_start: null,
          early_finish: null,
          units: '1.00',
          status: 'NOT_STARTED',
        },
      ],
    },
  ],
};

const MEMBER_SCHEDULER = [{ id: 'mem-sched', role: 200 }];
const MEMBER_MEMBER = [{ id: 'mem-member', role: 100 }];

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------

type Page = import('@playwright/test').Page;

async function setup(page: Page, memberRows = MEMBER_SCHEDULER) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
    // Default to timeline mode so tests don't have to switch manually.
    localStorage.setItem('trueppm.resources.viewMode', 'timeline');
  });

  const pj = (results: unknown[]) =>
    JSON.stringify({ count: results.length, next: null, previous: null, results });

  // --- Standard shell routes ---
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'on_track', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 4, complete_tasks: 0,
        next_milestone: null, team_utilization_pct: 80, owner_name: null,
        start_date: '2026-04-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        task_count: 4, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/dependencies/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/risks/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/board-config/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ columns: [] }) }),
  );
  await page.route('**/api/v1/monte-carlo/**', (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ runs: 0, p50: null, p80: null, p95: null, buckets: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/resources/heatmap/**', (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ weeks: [], resources: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/resources/summary/**', (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        avg_utilization_pct: 0, over_allocated_count: 0, over_allocated_weeks: null,
        under_utilized_count: 0, under_utilized_names: [], headcount: 0, contractor_count: 0,
      }),
    }),
  );

  // --- RBAC ---
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(memberRows) }),
  );

  // --- Resource allocation timeline ---
  await page.route(`**/api/v1/projects/${PROJECT_ID}/resource-allocation/**`, (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(FIXTURE_ALLOCATION),
    }),
  );

  // Utilization endpoint (unused in timeline mode but may be fetched on mount)
  await page.route(`**/api/v1/projects/${PROJECT_ID}/utilization/**`, (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        project_id: PROJECT_ID,
        window: { start: '2026-04-13', end: '2026-05-10' },
        resources: [],
        unassigned_task_count: 0,
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

test.describe('Permission gate', () => {
  test('MEMBER role sees permission notice instead of timeline', async ({ page }) => {
    await setup(page, MEMBER_MEMBER);
    await page.goto(`/projects/${PROJECT_ID}/resources/allocation`);
    // PermissionDeniedNotice renders this exact text (resource/PermissionDeniedNotice.tsx)
    await expect(
      page.getByText(/Resource utilization is only visible to Schedulers/i),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Alice Kim')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Timeline — golden path
// ---------------------------------------------------------------------------

test.describe('Timeline golden path', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/resources/allocation`);
    // Wait for Alice's row — confirms allocation data loaded and rendered.
    await expect(page.getByText('Alice Kim')).toBeVisible({ timeout: 10_000 });
  });

  test('renders a row for each resource', async ({ page }) => {
    await expect(page.getByText('Alice Kim')).toBeVisible();
    // Bob appears in the row header AND in the unscheduled tray — use first()
    await expect(page.getByText('Bob Nguyen').first()).toBeVisible();
  });

  test('overallocation badge appears in toolbar for Alice', async ({ page }) => {
    // The toolbar badge has aria-label="N over-allocated resource(s)"
    await expect(
      page.getByLabel('1 over-allocated resource'),
    ).toBeVisible();
  });

  test('overallocation week range shown in Alice row header', async ({ page }) => {
    // Row header renders "· overallocated · W18" (W18 = Apr 27 - May 3 is the overlap)
    // The span uses class tppm-mono — match content directly
    await expect(page.getByText(/· overallocated · W/i, { exact: false })).toBeVisible();
  });

  test('status bar shows resource and assignment counts', async ({ page }) => {
    const bar = page.getByLabel('Resource timeline summary');
    await expect(bar).toBeVisible();
    await expect(bar.getByText('2 resources')).toBeVisible();
    // Alice: 2 tasks, Bob: 2 tasks (1 unscheduled) = 4 total assignments
    await expect(bar.getByText('4 assignments')).toBeVisible();
  });

  test('status bar legend is present', async ({ page }) => {
    const bar = page.getByLabel('Resource timeline summary');
    await expect(bar.getByText('Normal')).toBeVisible();
    // Legend uses exact "Over-allocated" text; scope prevents strict-mode clash
    await expect(bar.getByText('Over-allocated', { exact: true })).toBeVisible();
    await expect(bar.getByText('Complete')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Inline allocation editing — use Bob's "Backend API" bar (no overlap)
// ---------------------------------------------------------------------------

test.describe('Inline allocation editing', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/resources/allocation`);
    await expect(page.getByText('Alice Kim')).toBeVisible({ timeout: 10_000 });
  });

  test('clicking a task bar opens the allocation popover', async ({ page }) => {
    // Backend API (Bob, asgn-3) has no overlapping bars — safe to click
    await page.getByRole('button', { name: /Edit allocation for Backend API/i }).click();
    await expect(page.getByRole('dialog', { name: /Edit allocation for Backend API/i })).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: /Allocation/i })).toBeVisible();
  });

  test('Cancel button closes the popover without saving', async ({ page }) => {
    await page.getByRole('button', { name: /Edit allocation for Backend API/i }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('Save patches the assignment and closes the popover', async ({ page }) => {
    let patchCalled = false;
    await page.route(`**/api/v1/task-resources/asgn-3/`, (r) => {
      patchCalled = true;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ units: '0.75' }) });
    });

    await page.getByRole('button', { name: /Edit allocation for Backend API/i }).click();
    const input = page.getByRole('spinbutton', { name: /Allocation/i });
    await input.fill('75');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
    expect(patchCalled).toBe(true);
  });

  test('Escape key closes the popover', async ({ page }) => {
    await page.getByRole('button', { name: /Edit allocation for Backend API/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Unscheduled assignments tray
// ---------------------------------------------------------------------------

test.describe('Unscheduled assignments tray', () => {
  test('tray appears and lists unscheduled assignments', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/resources/allocation`);
    await expect(page.getByText('Alice Kim')).toBeVisible({ timeout: 10_000 });

    // "Load Testing" (asgn-4) has no CPM dates — should appear in unscheduled tray
    await expect(page.getByText(/1 unscheduled assignment/i)).toBeVisible();
    await expect(page.getByText('Load Testing')).toBeVisible();
    await expect(page.getByRole('button', { name: /Run scheduler/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Status filters
// ---------------------------------------------------------------------------

test.describe('Status filters', () => {
  test('unchecking In progress removes status from API request', async ({ page }) => {
    const seenUrls: string[] = [];

    await setup(page);
    // Override to capture request URLs after initial load.
    // Return full fixture so the page renders normally.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/resource-allocation/**`, (r) => {
      seenUrls.push(r.request().url());
      return r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(FIXTURE_ALLOCATION),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/resources/allocation`);
    await expect(page.getByText('Alice Kim')).toBeVisible({ timeout: 10_000 });

    const urlsBefore = seenUrls.length;

    // Uncheck "In progress" — triggers a new query with a different key
    await page.getByRole('checkbox', { name: 'In progress' }).uncheck();

    // Wait for the new request to arrive (TanStack Query fires on key change)
    await page.waitForTimeout(1_000);

    // At least one new request should have been made after unchecking
    const newUrls = seenUrls.slice(urlsBefore);
    expect(newUrls.length).toBeGreaterThan(0);
    // The latest request should NOT include IN_PROGRESS as a status param
    const lastUrl = newUrls[newUrls.length - 1];
    expect(lastUrl).not.toContain('IN_PROGRESS');
  });
});

// ---------------------------------------------------------------------------
// Resource search filter
// ---------------------------------------------------------------------------

test.describe('Resource search', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/resources/allocation`);
    await expect(page.getByText('Alice Kim')).toBeVisible({ timeout: 10_000 });
  });

  test('filtering by name hides non-matching resources', async ({ page }) => {
    await page.getByPlaceholder('Filter resources…').fill('Bob');
    // Bob's row header — first() because Bob also appears in the unscheduled tray
    await expect(page.getByText('Bob Nguyen').first()).toBeVisible();
    await expect(page.getByText('Alice Kim')).not.toBeVisible();
  });

  test('clearing the search restores all resources', async ({ page }) => {
    await page.getByPlaceholder('Filter resources…').fill('Bob');
    await expect(page.getByText('Alice Kim')).not.toBeVisible();

    await page.getByPlaceholder('Filter resources…').clear();
    await expect(page.getByText('Alice Kim')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 409 empty state (schedule not run)
// ---------------------------------------------------------------------------

test.describe('Schedule-not-run empty state', () => {
  test('shows empty state CTA when API returns 409', async ({ page }) => {
    await setup(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/resource-allocation/**`, (r) =>
      r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'No CPM dates.' }) }),
    );

    await page.goto(`/projects/${PROJECT_ID}/resources/allocation`);
    await expect(page.getByRole('button', { name: /Run Scheduler/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Alice Kim')).not.toBeVisible();
  });
});
