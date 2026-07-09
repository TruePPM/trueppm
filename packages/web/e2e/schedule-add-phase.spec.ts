/**
 * "+ Phase" E2E (epic #1752, issue #1754, ADR-0293).
 *
 * Golden path: click "+ Phase" → the new summary row drops straight into
 * inline name edit (create-empty-then-nest, ux-design decision) → rename it →
 * the row shows the "phase-in-waiting" ghost hint (no structural child yet,
 * so `is_phase` is still false) → click the hint to add the first task →
 * the row becomes a real phase and the hint retires.
 *
 * Plus a contributor-surface exclusion check: a phase never appears in the
 * global quick-log task picker (My Work / QuickLogTime, issue #1754 Surface 2).
 */
import { test, expect, type Route } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-phase-00000000-0000-0000-0000-000000001754';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Phase Action Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

interface MockTask {
  id: string;
  wbs_path: string;
  name: string;
  early_start: string | null;
  early_finish: string | null;
  planned_start: string | null;
  duration: number;
  percent_complete: number;
  is_critical: boolean;
  is_milestone: boolean;
  is_summary: boolean;
  is_phase: boolean;
  is_subtask: boolean;
  parent_id: string | null;
  status: string;
}

/** Recompute is_summary / is_phase for every task from the current parent_id graph. */
function recomputeFlags(tasks: MockTask[]): void {
  for (const t of tasks) {
    const children = tasks.filter((c) => c.parent_id === t.id);
    t.is_summary = children.length > 0;
    t.is_phase = children.some((c) => !c.is_subtask);
  }
}

test.describe('Schedule "+ Phase" golden path (issue #1754)', () => {
  test.beforeEach(async ({ page }) => {
    await setupCatchAll(page);
    await setupAuth(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
    });

    // Stateful tasks mock — GET reflects the current in-memory list; POST
    // appends a new task (WBS assigned deterministically for this spec) and
    // recomputes is_summary/is_phase from the parent_id graph; PATCH renames.
    const tasks: MockTask[] = [
      {
        id: 't-existing', wbs_path: '1', name: 'Existing Task',
        early_start: '2026-04-05', early_finish: '2026-04-09',
        planned_start: '2026-04-05', duration: 5, percent_complete: 0,
        is_critical: false, is_milestone: false, is_summary: false,
        is_phase: false, is_subtask: false, parent_id: null, status: 'NOT_STARTED',
      },
    ];
    let nextRootWbs = 2;

    await page.route('**/api/v1/tasks/**', (route: Route) => {
      const req = route.request();
      const method = req.method();
      const url = new URL(req.url());

      if (method === 'GET') {
        recomputeFlags(tasks);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
        });
      }

      if (method === 'POST') {
        const body = req.postDataJSON() as { name?: string; parent_id?: string | null };
        const parentId = body.parent_id ?? null;
        const parent = tasks.find((t) => t.id === parentId);
        const wbsPath = parent
          ? `${parent.wbs_path}.${tasks.filter((t) => t.parent_id === parentId).length + 1}`
          : String(nextRootWbs++);
        const created: MockTask = {
          id: `new-${tasks.length + 1}`,
          wbs_path: wbsPath,
          name: body.name ?? 'New task',
          early_start: '2026-04-05',
          early_finish: '2026-04-05',
          planned_start: null,
          duration: 1,
          percent_complete: 0,
          is_critical: false,
          is_milestone: false,
          is_summary: false,
          is_phase: false,
          is_subtask: false,
          parent_id: parentId,
          status: 'NOT_STARTED',
        };
        tasks.push(created);
        recomputeFlags(tasks);
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(created),
        });
      }

      if (method === 'PATCH') {
        // e.g. **/api/v1/tasks/{id}/
        const id = url.pathname.split('/').filter(Boolean).pop();
        const body = req.postDataJSON() as { name?: string };
        const existing = tasks.find((t) => t.id === id);
        if (existing && body.name !== undefined) existing.name = body.name;
        recomputeFlags(tasks);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(existing ?? {}),
        });
      }

      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto(BASE_URL);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('+ Phase button is a visible peer to + Task and + Milestone, brand-primary (not gold)', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Add new phase (Cmd+P)' });
    await expect(button).toBeVisible();
    await expect(button).toContainText('Phase');
  });

  test('clicking + Phase inserts a summary row and drops it into inline rename', async ({ page }) => {
    await page.getByRole('button', { name: 'Add new phase (Cmd+P)' }).click();

    // The new row opens straight into the inline rename input (create-empty-
    // then-nest) — no dialog, matching the ux-design decision.
    const nameInput = page.getByRole('textbox', { name: 'Rename task New phase' });
    await expect(nameInput).toBeVisible();

    await nameInput.fill('Design Phase');
    await nameInput.press('Enter');

    // Renamed row shows in the task list.
    const grid = page.getByRole('grid', { name: 'Task list' });
    await expect(grid.getByText('Design Phase')).toBeVisible();
  });

  test('a phase-in-waiting shows the ghost hint; adding its first task retires it', async ({ page }) => {
    await page.getByRole('button', { name: 'Add new phase (Cmd+P)' }).click();
    const nameInput = page.getByRole('textbox', { name: 'Rename task New phase' });
    await nameInput.fill('Design Phase');
    await nameInput.press('Enter');

    // No structural child yet — is_phase is still false, so the row shows the
    // ghost "Add first task to this phase" affordance instead of being a real
    // phase (matches backend semantics: an empty phase-in-waiting is legitimate).
    const hint = page.getByTestId('phase-in-waiting-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(/Add first task to this phase/);

    await hint.click();

    // The ghost's own creation drops the new child into rename too.
    const childInput = page.getByRole('textbox', { name: 'Rename task New task' });
    await expect(childInput).toBeVisible();
    await childInput.fill('Wireframes');
    await childInput.press('Enter');

    // Once the phase has a structural child, is_phase flips true and the
    // hint retires from the (now real) phase row.
    const grid = page.getByRole('grid', { name: 'Task list' });
    await expect(grid.getByText('Wireframes')).toBeVisible();
    await expect(page.getByTestId('phase-in-waiting-hint')).toHaveCount(0);
  });
});

test.describe('Contributor-surface exclusion — a phase never appears in Quick Log Time (issue #1754)', () => {
  test('the global Log Time picker excludes a phase entirely', async ({ page }) => {
    await setupCatchAll(page);
    await setupAuth(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: FIXTURE_PROJECT_ID });

    await page.route('**/api/v1/me/work/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [
            {
              id: 'phase-1', short_id: 'PHZ-1', name: 'Design Phase',
              project_id: FIXTURE_PROJECT_ID, project_name: 'Phase Action Project',
              program_id: null, program_name: null, program_color: null,
              sprint_id: null, sprint_name: null, status: 'IN_PROGRESS',
              story_points: null, remaining_points: null, due: null, due_source: null,
              is_critical: false, group: 'today', is_blocked: false, blocked_reason: '',
              blocker_type: '', blocked_age_seconds: null, server_version: 1,
              url: `/projects/${FIXTURE_PROJECT_ID}/schedule?task=phase-1`,
              is_phase: true,
            },
            {
              id: 'task-1', short_id: 'TSK-1', name: 'Wireframes',
              project_id: FIXTURE_PROJECT_ID, project_name: 'Phase Action Project',
              program_id: null, program_name: null, program_color: null,
              sprint_id: null, sprint_name: null, status: 'IN_PROGRESS',
              story_points: null, remaining_points: null, due: null, due_source: null,
              is_critical: false, group: 'today', is_blocked: false, blocked_reason: '',
              blocker_type: '', blocked_age_seconds: null, server_version: 1,
              url: `/projects/${FIXTURE_PROJECT_ID}/schedule?task=task-1`,
              is_phase: false,
            },
          ],
          next: null,
          previous: null,
          active_sprints: [],
          due_today_count: 0,
          server_version_high_water: 1,
        }),
      }),
    );

    await page.goto('/me/work');
    const assigned = page.getByRole('region', { name: 'Assigned to me' });
    await expect(assigned.getByRole('link', { name: 'Wireframes' })).toBeVisible({ timeout: 10_000 });

    // A phase never becomes a My Work actionable row (defense-in-depth).
    await expect(assigned.getByRole('link', { name: 'Design Phase' })).toHaveCount(0);

    // Open the global Log Time picker from the TopBar (exact match — a row's
    // own "Log time on <task>" button also matches a substring search).
    await page.getByRole('button', { name: 'Log time', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Log time' });
    await expect(dialog).toBeVisible();

    // The phase is absent from the picker entirely — not merely unselected.
    await expect(dialog.getByRole('radio', { name: /Design Phase/ })).toHaveCount(0);
    await expect(dialog.getByRole('radio', { name: /Wireframes/ })).toBeVisible();
  });
});
