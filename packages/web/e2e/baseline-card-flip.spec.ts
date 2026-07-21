/**
 * Baseline card-flip E2E (#2215).
 *
 * Capturing the FIRST baseline (no active baseline yet) must auto-activate it so
 * board-card readiness flips estimated→baselined with no separate "Set active"
 * step. Drives the real board + task drawer against mocked API routes: open a
 * card, capture a baseline from its Baseline section, and assert the card's
 * readiness chip flips once the (auto-activated) baseline overlay is applied.
 *
 * The tasks endpoint is stateful — readiness resolves to `estimated` until the
 * baseline is activated, then `baselined` — mirroring the server's
 * TaskSerializer.get_readiness, which only returns `baselined` under the
 * project's ACTIVE baseline.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-baseflip-00000000-0000-0000-0000-000000000001';
const BASE_URL = `/projects/${PROJECT_ID}`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Baseline Flip Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const SUMMARY_TASK = {
  id: 'phase1',
  wbs_path: '1',
  name: 'Delivery Phase',
  early_start: '2026-01-05',
  early_finish: '2026-02-14',
  duration: 30,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  is_summary: true,
  parent_id: null,
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

/** Leaf card whose readiness flips once a baseline is activated. */
function leafTask(readiness: 'estimated' | 'baselined') {
  return {
    id: 'login',
    wbs_path: '1.1',
    name: 'Design Login',
    early_start: '2026-01-05',
    early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'phase1',
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    readiness,
  };
}

async function setup(page: Page) {
  // `activated` flips when the capture flow POSTs to the activate endpoint. The
  // stateful tasks route reads it so a post-activation refetch returns the
  // `baselined` readiness the server would compute under the active baseline.
  let activated = false;

  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: PROJECTS,
    projectId: PROJECT_ID,
    tasks: [SUMMARY_TASK, leafTask('estimated')],
    statusSummary: { task_count: 2 },
  });

  // Stateful tasks GET (registered after setupApiMocks so it wins).
  await page.route('**/api/v1/tasks/**', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 2,
          next: null,
          previous: null,
          results: [SUMMARY_TASK, leafTask(activated ? 'baselined' : 'estimated')],
        }),
      });
    }
    return route.continue();
  });

  // Drawer Activity-tab siblings (Comments / Activity feed) — safe empties so
  // the tab renders without falling through the catch-all to a 404 error card.
  await page.route('**/api/v1/tasks/*/comments/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/tasks/*/activity/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );

  // No active baseline yet → the drawer's Baseline section shows the capture CTA.
  await page.route('**/api/v1/projects/*/tasks/*/baseline/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ has_baseline: false }) }),
  );

  // Baseline collection: GET → empty (no active baseline anywhere); POST → a new
  // INACTIVE baseline (server default is_active=false). The hook then reads the
  // list, finds no active baseline, and chains the activate call.
  await page.route('**/api/v1/projects/*/baselines/', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'bl-new',
          project: PROJECT_ID,
          name: 'Baseline 1',
          created_by: null,
          created_at: '2026-07-20T10:00:00Z',
          is_active: false,
          has_cpm_dates: true,
          task_count: 2,
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    });
  });

  // Activate: mark the project baselined and return the now-active baseline.
  await page.route('**/api/v1/projects/*/baselines/*/activate/', (route) => {
    activated = true;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'bl-new',
        project: PROJECT_ID,
        name: 'Baseline 1',
        created_by: null,
        created_at: '2026-07-20T10:00:00Z',
        is_active: true,
        has_cpm_dates: true,
        task_count: 2,
      }),
    });
  });

  await page.routeWebSocket('**/ws/v1/projects/**', () => {
    /* accept and hold open */
  });
}

test.describe('Baseline card flip (#2215)', () => {
  test('capturing the FIRST baseline auto-activates and flips the card to baselined', async ({
    page,
  }) => {
    await setup(page);

    // Deep-link straight into the Design Login card's drawer.
    await page.goto(`${BASE_URL}/board?task=login`);
    await expect(page.getByText('Delivery Phase')).toBeVisible({ timeout: 10_000 });

    // Card starts at `estimated`.
    const card = page.getByRole('button', { name: /^Design Login,/ });
    await expect(card.getByText('estimated')).toBeVisible({ timeout: 10_000 });

    // Drawer → Activity tab → expand the (collapsed) Baseline section → capture CTA.
    // Only the first section in a tab auto-expands; Baseline (order 1000) starts
    // collapsed, so its "Capture baseline" button isn't in the DOM until the
    // section header is toggled open.
    const drawer = page.getByRole('dialog').filter({ hasText: 'Design Login' });
    await drawer.getByRole('tab', { name: 'Activity' }).click();
    const baselineHeader = drawer.getByRole('button', { name: 'Baseline', exact: true });
    await expect(baselineHeader).toHaveAttribute('aria-expanded', 'false');
    await baselineHeader.click();
    await expect(baselineHeader).toHaveAttribute('aria-expanded', 'true');
    await drawer.getByRole('button', { name: 'Capture baseline' }).click();

    // First-baseline confirm copy promises the auto-activation (accurate now).
    const confirm = page.getByRole('dialog', { name: 'Capture a baseline?' });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/baselined on the board/i)).toBeVisible();

    // Capture → the hook chains create → activate → tasks refetch.
    const [activateReq] = await Promise.all([
      page.waitForRequest(
        (r) => /\/baselines\/[^/]+\/activate\/$/.test(r.url()) && r.method() === 'POST',
      ),
      confirm.getByRole('button', { name: 'Capture baseline' }).click(),
    ]);
    expect(activateReq).toBeTruthy();

    // Close the drawer and assert the card flipped estimated→baselined.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const flipped = page.getByRole('button', { name: /^Design Login,/ });
    await expect(flipped.getByText('baselined')).toBeVisible({ timeout: 10_000 });
    await expect(flipped.getByText('estimated')).toHaveCount(0);
  });
});
