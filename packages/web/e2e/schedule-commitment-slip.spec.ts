/**
 * Commitment-slip gate on the Gantt reschedule commit (ADR-1485 D1).
 *
 * A caller who cannot accept scope changes moves committed sprint work past the
 * sprint end. The server does not apply the write: it answers 409
 * `commitment_slip_requires_acceptance` and records a PENDING scope change. The
 * client must say the edit is waiting on a decision, not show an error.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, readFields } from './fixtures';

const PROJECT_ID = 'e2e-slip00-0000-0000-0000-000000002563';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Slip Project',
    description: '',
    start_date: '2026-03-02',
    status_date: '2026-03-02',
    calendar: 'default',
  },
];

const TASKS = [
  {
    id: 'slip-task-1',
    wbs_path: '1',
    name: 'Committed work',
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    planned_start: '2026-04-06',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignments: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    notes: '',
  },
];

test.describe('Commitment slip on reschedule (ADR-1485 D1)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('a non-admin move past the sprint end waits for a sprint decision', async ({ page }) => {
    let patched = false;
    await page.route('**/api/v1/tasks/slip-task-1/', async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      patched = true;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'commitment_slip_requires_acceptance',
          detail: 'This change moves committed work past the end of the active sprint.',
          structure_role: 'work',
          scope_change_id: '7d1f2c3a-0000-4000-8000-000000002563',
          batch_id: '7d1f2c3a-0000-4000-8000-000000000001',
          sprint_id: '7d1f2c3a-0000-4000-8000-000000000002',
          sprint_name: 'Sprint 4',
          proposed_start: '2026-04-13',
          proposed_finish: '2026-04-17',
          sprint_finish_date: '2026-04-14',
          current_start: '2026-04-06',
          current_finish: '2026-04-10',
        }),
      });
    });

    await page.goto(BASE_URL);
    const bar = page.getByRole('option', { name: /Committed work/ });
    await expect(bar).toBeVisible();
    await bar.focus();
    await page.keyboard.press('r');
    await expect(page.getByTestId('preview-overlay')).toBeVisible();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    await expect.poll(() => patched).toBe(true);
    await expect(page.getByText('Waiting for a Sprint 4 decision')).toBeVisible();
    await expect(page.getByText("Couldn't save the change.")).toHaveCount(0);
  });

  test('an authority holder is asked for a reason and the retry carries it', async ({ page }) => {
    const bodies: Record<string, unknown>[] = [];
    await page.route('**/api/v1/tasks/slip-task-1/', async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      bodies.push(body);
      if (!body.slip_reason) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            slip_reason: ['Moving committed work past the sprint end needs a reason.'],
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...TASKS[0], ...readFields(body) }),
      });
    });

    await page.goto(BASE_URL);
    const bar = page.getByRole('option', { name: /Committed work/ });
    await expect(bar).toBeVisible();
    await bar.focus();
    await page.keyboard.press('r');
    await expect(page.getByTestId('preview-overlay')).toBeVisible();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Move past the sprint end?' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Reason').fill('Vendor slipped');
    await dialog.getByRole('button', { name: 'Move it' }).click();

    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1].slip_reason).toBe('Vendor slipped');
    await expect(dialog).toBeHidden();
  });
});

// --------------------------------------------------------------------------- //
// Deciding a pending slip from the sprint's scope-change drawer (board)
// --------------------------------------------------------------------------- //

const SPRINT = {
  id: 'sp-slip',
  server_version: 1,
  short_id: 'D1D1',
  short_id_display: 'SP-D1D1',
  name: 'Sprint 4',
  goal: '',
  notes: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: null,
  committed_points: 5,
  committed_task_count: 1,
  pending_count: 0,
  completed_points: 0,
  completed_task_count: 0,
  completion_ratio_points: 0,
  completion_ratio_tasks: 0,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

const SLIP_ID = '7d1f2c3a-0000-4000-8000-000000002564';

function slipEvent(status: 'pending' | 'accepted') {
  return {
    id: SLIP_ID,
    item_name: 'Committed work',
    story_points: null,
    added_by_name: 'Sam',
    added_at: '2026-04-08T09:00:00Z',
    goal_impact: false,
    status,
    kind: 'slip',
    proposed_start: '2026-04-06',
    proposed_finish: '2026-04-17',
    batch_id: null,
    task_id: '7d1f2c3a-0000-4000-8000-000000000003',
    sprint_finish_date: '2026-04-14',
    current_start: '2026-04-06',
    current_finish: '2026-04-10',
    reason: 'Crane is late',
    decided_by_name: status === 'accepted' ? 'Ada Admin' : null,
    decided_at: status === 'accepted' ? '2026-04-08T10:00:00Z' : null,
    decision_reason: status === 'accepted' ? 'Vendor late' : '',
  };
}

test.describe('Deciding a commitment slip from the drawer (ADR-1485 D1)', () => {
  test('an Admin accepts the only pending slip from the sprint badge', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    const project = {
      ...FIXTURE_PROJECTS[0],
      agile_features: true,
      methodology: 'AGILE' as const,
    };
    await setupApiMocks(page, {
      projects: [project],
      projectId: PROJECT_ID,
      tasks: [{ ...TASKS[0], sprint: SPRINT.id, sprint_pending: false }],
      members: [{ id: 'mem-1', role: 300 }],
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...project,
          server_version: 1,
          calendar: null,
          estimation_mode: 'open',
        }),
      }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'mem-1', role: 300 }]),
      }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: [SPRINT] }),
      }),
    );
    await page.route(/\/api\/v1\/sprints\/sp-slip\/burndown\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sprint: SPRINT, snapshots: [] }),
      }),
    );
    await page.route('**/api/v1/sprints/sp-slip/duration-events/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: [] }),
      }),
    );
    let accepted = false;
    await page.route('**/api/v1/sprints/sp-slip/scope-changes/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          summary: {
            points_added: 0,
            points_removed: 0,
            added_mid_sprint_count: 0,
            pending_slip_count: accepted ? 0 : 1,
            total: 1,
          },
          events: [slipEvent(accepted ? 'accepted' : 'pending')],
        }),
      }),
    );
    let acceptBody: unknown = null;
    await page.route(`**/api/v1/scope-changes/${SLIP_ID}/accept/`, async (route) => {
      acceptBody = route.request().postDataJSON();
      accepted = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: SLIP_ID,
          item_name: 'Committed work',
          status: 'accepted',
          goal_impact: false,
          added_at: '2026-04-08T09:00:00Z',
          kind: 'slip',
          proposed_start: '2026-04-06',
          proposed_finish: '2026-04-17',
          batch_id: null,
          decision_reason: 'Vendor late',
          task: 'slip-task-1',
          sprint: SPRINT.id,
          reason: '',
          pending_count: 0,
        }),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/board`);
    await page.getByRole('button', { name: /1 date change waiting/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Scope changes' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('slip-row')).toContainText('Crane is late');
    await drawer.getByLabel(/Reason for the decision on Committed work/).fill('Vendor late');
    await drawer.getByRole('button', { name: 'Accept the date change for Committed work' }).click();

    await expect.poll(() => acceptBody).toEqual({ reason: 'Vendor late' });
    await expect(drawer.getByTestId('slip-row')).toContainText('Accepted');
    await expect(
      drawer.getByRole('button', { name: 'Accept the date change for Committed work' }),
    ).toHaveCount(0);
  });
});
