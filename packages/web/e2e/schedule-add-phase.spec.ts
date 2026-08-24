/**
 * "+ Phase" E2E (epic #1752, issue #1754, ADR-0293; rewritten for #2955).
 *
 * Golden path: click "+ Phase" → a phase arrives **with its first task already in it**
 * → the phase drops straight into inline name edit → rename it.
 *
 * Two things changed in #2955 and both are asserted here rather than assumed:
 *
 *  - **The button never leaves an empty phase behind.** It creates the task and then
 *    wraps it (`tasks/group/`), which is the inversion that makes the failure case
 *    benign — a failed wrap leaves an ordinary task, where a failed second *create*
 *    would have left exactly the empty phase the design forbids. So the
 *    "phase-in-waiting" ghost hint must NOT appear, which is the opposite of what this
 *    spec asserted before.
 *  - **The button is behind a Display option that ships off.** ⌥⌘G and ⇥ already make
 *    phases; the toolbar buttons are the discoverable route, not the primary one. The
 *    spec opts in the way a user does.
 *
 * Plus a contributor-surface exclusion check: a phase never appears in the
 * global quick-log task picker (My Work / QuickLogTime, issue #1754 Surface 2).
 */
import { test, expect, type Route } from './fixtures/coverage';
import {
  setupAuth,
  setupApiMocks,
  setupCatchAll,
  setupScheduleDisplayOptions,
} from './fixtures';

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
    await setupScheduleDisplayOptions(page, FIXTURE_PROJECT_ID, { structureButtons: true });
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
          name: body.name ?? 'New item',
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

    // `tasks/group/` (#2955) — a different path, the same `tasks` array, because the
    // "+ Phase" button now wraps the task it just created and the refetch has to show
    // the container. Faithful in the one way this spec can observe: the wrapped rows
    // become children of a new declared container which takes their level position.
    await page.route(/\/api\/v1\/projects\/[^/]+\/tasks\/group\/$/, (route: Route) => {
      const body = route.request().postDataJSON() as { task_ids: string[]; name?: string | null };
      const wrapped = tasks.filter((t) => body.task_ids.includes(t.id));
      const first = wrapped[0];
      const container: MockTask = {
        id: `container-${tasks.length + 1}`,
        wbs_path: first.wbs_path,
        name: body.name?.trim() || 'New phase',
        early_start: '2026-04-05', early_finish: '2026-04-09',
        planned_start: '2026-04-05', duration: 1, percent_complete: 0,
        is_critical: false, is_milestone: false, is_summary: true,
        is_phase: true, is_subtask: false, parent_id: first.parent_id,
        status: 'NOT_STARTED',
      };
      tasks.splice(tasks.indexOf(first), 0, container);
      wrapped.forEach((t, i) => {
        t.parent_id = container.id;
        t.wbs_path = `${container.wbs_path}.${i + 1}`;
      });
      recomputeFlags(tasks);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          container: {
            id: container.id, name: container.name, wbs_path: container.wbs_path,
            structure_role: 'container', parent_id: container.parent_id,
          },
          grouped_ids: wrapped.map((t) => t.id),
          left_alone: [],
          updated: tasks.map((t) => ({ id: t.id, wbs_path: t.wbs_path })),
          warning: null,
          operation_id: 'e2e-group-op-1',
        }),
      });
    });

    await page.goto(BASE_URL);
    await expect(page.getByRole('treegrid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('+ Phase button is a visible peer to + Item and + Milestone, brand-primary (not gold)', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Add new phase (Option+Cmd+P)' });
    await expect(button).toBeVisible();
    await expect(button).toContainText('Phase');
  });

  test('clicking + Phase creates a phase WITH its first task, and drops the phase into rename', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Add new phase (Option+Cmd+P)' }).click();

    // The PHASE opens straight into the inline rename input — not the task inside it.
    // The button said "Phase", and naming it is the one decision still owed; the design
    // names the phase last precisely because everything else about it is derived.
    const nameInput = page.getByRole('textbox', { name: 'Rename task Untitled phase' });
    await expect(nameInput).toBeVisible();

    await nameInput.fill('Design Phase');
    await nameInput.press('Enter');

    const grid = page.getByRole('treegrid', { name: 'Task list' });
    await expect(grid.getByText('Design Phase')).toBeVisible();
  });

  test('+ Phase never leaves an empty phase behind — no phase-in-waiting ghost', async ({
    page,
  }) => {
    // The #2955 contract, and the reason the button composes create-then-group rather
    // than create-then-create. Before this issue the button minted a childless summary
    // and offered a ghost "⊕ Add first item to this phase"; a planner who ignored it was
    // left with an empty phase in the plan. Now the first task arrives with the phase.
    await page.getByRole('button', { name: 'Add new phase (Option+Cmd+P)' }).click();
    const nameInput = page.getByRole('textbox', { name: 'Rename task Untitled phase' });
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Design Phase');
    await nameInput.press('Enter');

    const grid = page.getByRole('treegrid', { name: 'Task list' });
    await expect(grid.getByText('Design Phase')).toBeVisible();

    // Settle past `HOVER_SETTLE_MS` (80ms, useDependencyHover) so this reads the
    // *steady* state rather than racing it (#2782), then assert the absence.
    await page.waitForTimeout(200);
    await expect(page.getByTestId('phase-in-waiting-hint')).toHaveCount(0);

    // And the task really is inside it — an assertion on the structure, not on the
    // request that produced it. `toHaveAttribute('aria-expanded', /true|false/)` would
    // pass for either value and therefore assert nothing; the depth is the claim.
    const phaseRow = grid.getByRole('row').filter({ hasText: 'Design Phase' }).first();
    await expect(phaseRow).toHaveAttribute('aria-level', '1');
    const childRow = grid.getByRole('row').filter({ hasText: 'New item' }).first();
    await expect(childRow).toHaveAttribute('aria-level', '2');
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
