/**
 * E2E for sync conflict hardening (ADR-0217, #322) and its #2036 follow-up.
 *
 * Two PMs edit the same task. When their edits are disjoint the server merges
 * (200) and the edit lands silently. When they overlap the server returns 409.
 * Before #2036 the modal closed and discarded the loser's edits; now it stays
 * open with an inline banner that names the conflicting fields and offers
 * "Keep my edits & save" (rebase onto the server version and re-save) — no
 * silent data loss. We drive one browser and mock the *other* PM's write as the
 * server response (200 merge / 409 conflict), which is the deterministic seam.
 */
import { test, expect } from './fixtures/coverage';
import type { Page, Route } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

const FIXTURE_PROJECT_ID = 'e2e-322-00000000-0000-0000-0000-000000000322';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Conflict Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const TASK = {
  id: 't1',
  wbs_path: '1',
  name: 'Build feature',
  early_start: '2026-04-07',
  early_finish: '2026-04-14',
  planned_start: '2026-04-07',
  duration: 7,
  percent_complete: 30,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  parent_id: null,
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: 5,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
  readiness: 'ready',
  notes: 'Existing notes',
  server_version: 4,
};

/** Install every mock the board page reads, plus a per-test PATCH handler. */
async function setup(page: Page, patchHandler: (route: Route) => void): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // 404 (not 401) for any endpoint this spec doesn't mock, so a stray unmocked
  // request never triggers the token-refresh → session-expired modal that
  // intercepts card clicks under parallel load. Registered first so the
  // specific routes below win (Playwright: last-registered wins).
  await setupCatchAll(page);
  // Project detail — BoardCard reads `effective_estimation_scale` via `useProject`
  // on every card. Without this the catch-all 404s it and TanStack retries 3×,
  // re-rendering the card mid-click and destabilizing the edit flow. A resolved
  // GET keeps the card static.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: FIXTURE_PROJECT_ID,
        name: 'Conflict Project',
        description: '',
        start_date: '2026-04-01',
        calendar: 'default',
        estimation_scale: null,
        effective_estimation_scale: 'fibonacci',
        inherited_estimation_scale: 'fibonacci',
      }),
    }),
  );

  const tasks = [TASK];

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 1, complete_tasks: 0,
        next_milestone: null, team_utilization_pct: null, owner_name: null,
        start_date: '2026-04-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/workshop/current/', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active workshop session.' }) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: tasks.length, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    }),
  );
  // The task PATCH — the write under test. Registered AFTER the list-shaped
  // '**/api/v1/tasks/**' catch above: Playwright checks routes in reverse
  // registration order (last-registered wins), so this more-specific handler
  // must come last to intercept PATCH /tasks/t1/ before the catch-all returns
  // a list shape. (Registering it first silently let the catch-all swallow the
  // PATCH — the 409/200 patchHandler never ran and the conflict path went untested.)
  await page.route(`**/api/v1/tasks/${TASK.id}/`, (route) => {
    if (route.request().method() === 'PATCH') {
      patchHandler(route);
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TASK),
    });
  });
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/risks/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/resource-allocation/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project_id: FIXTURE_PROJECT_ID, window_start: '2026-04-01', window_end: '2026-05-30', resources: [],
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-views/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  // BoardView reads the self-membership role (`useCurrentUserRole`) to pessimistically
  // gate write affordances (#2146). Left unmocked it 401s under parallel load and pops
  // the session-expired modal, which intercepts the card click. Return an Admin so the
  // role resolves and the board stays writable for this conflict-merge flow.
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: route.request().url().includes('self=true')
        ? JSON.stringify([{ id: 'mem-self', role: 300, role_label: 'Project Manager' }])
        : JSON.stringify({ count: 1, next: null, previous: null, results: [{ id: 'mem-self', role: 300, role_label: 'Project Manager' }] }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        columns: [
          { status: 'BACKLOG',     label: 'Backlog',     visible: true, wip_limit: null, color: '#94A3B8' },
          { status: 'NOT_STARTED', label: 'To Do',       visible: true, wip_limit: null, color: '#64748B' },
          { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wip_limit: null, color: '#3B82F6' },
          { status: 'REVIEW',      label: 'Review',      visible: true, wip_limit: null, color: '#A855F7' },
          { status: 'COMPLETE',    label: 'Done',        visible: true, wip_limit: null, color: '#22C55E' },
        ],
      }),
    }),
  );
}

/** Open the task's edit modal: card → info popover → Edit → TaskFormModal.
 * The card's kebab "Actions" menu has Move/Reject but no Edit; the Edit
 * affordance lives in the card popover footer (mirrors wave3-card-info-popover). */
async function openEditModal(page: Page) {
  await page.goto(`${BASE_URL}/board`);
  // Gate on the card being rendered (board reads resolved) before touching chrome.
  const card = page.getByRole('button', { name: /^Build feature, \d+% complete/ });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  // The card info popover (role=dialog, named after the task) exposes Edit.
  const popover = page.getByRole('dialog', { name: /^Build feature$/ });
  await popover.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: /Build feature/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Sync conflict — field-level merge (#322)', () => {
  test('overlapping edit keeps the modal open with an inline banner, not a toast (#2036)', async ({
    page,
  }) => {
    await setup(page, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'sync_conflict',
          detail: 'Someone else changed this.',
          conflict_fields: ['name'],
          server_value: { name: 'Their edit' },
          client_value: { name: 'My edit' },
          server_version: 6,
        }),
      }),
    );
    const dialog = await openEditModal(page);
    await dialog.getByLabel(/Task name/).fill('My edit');
    await dialog.getByRole('button', { name: 'Save changes' }).click();

    // New behavior: an inline banner inside the modal names the conflicting
    // field; the modal stays open with the user's edit preserved.
    const banner = dialog.getByRole('alert');
    await expect(banner).toContainText(/Someone else changed/);
    await expect(banner).toContainText('Name');
    await expect(banner).toContainText('Their edit');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/Task name/)).toHaveValue('My edit');
    // The old toast Reload affordance is gone — the banner is the single signal.
    await expect(page.getByRole('button', { name: /^Reload$/ })).toHaveCount(0);
  });

  test('"Keep my edits & save" rebases onto the server version and re-saves (#2036)', async ({
    page,
  }) => {
    let calls = 0;
    await setup(page, (route) => {
      calls += 1;
      if (calls === 1) {
        // First save: overlapping conflict.
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'sync_conflict',
            detail: 'Someone else changed this.',
            conflict_fields: ['name'],
            server_value: { name: 'Their edit' },
            client_value: { name: 'My edit' },
            server_version: 6,
          }),
        });
      } else {
        // Retry after rebase: accepted.
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...TASK, name: 'My edit', server_version: 7 }),
        });
      }
    });
    const dialog = await openEditModal(page);
    await dialog.getByLabel(/Task name/).fill('My edit');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/Someone else changed/);

    await dialog.getByRole('button', { name: 'Keep my edits & save' }).click();

    // The rebased retry is accepted → the modal closes with no lost work.
    await expect(dialog).toBeHidden();
    expect(calls).toBe(2);
  });

  test('disjoint edit merges (200) and closes the modal with no error', async ({ page }) => {
    await setup(page, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Merged-Concurrent-Fields': 'status' },
        body: JSON.stringify({ ...TASK, name: 'My edit', server_version: 6 }),
      }),
    );
    const dialog = await openEditModal(page);
    await dialog.getByLabel(/Task name/).fill('My edit');
    await dialog.getByRole('button', { name: /Save/ }).click();

    // Merge succeeded: the dialog closes and no conflict toast appears.
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Someone else changed this/)).toHaveCount(0);
  });
});
