import { test, expect, type Page } from '@playwright/test';
import { setupAuth } from './fixtures/auth';
import { setupApiMocks, setupCatchAll } from './fixtures/api-mocks';

/**
 * E2E coverage for the sprint/phase/WBS guardrail drawer surface (#875 / ADR-0101).
 *
 * The warn / override / block spine on the task-drawer Sprint section:
 *  - Golden path: assigning a task that trips a warn-level rule surfaces a
 *    non-blocking notice with a one-tap "Keep it here" override; the assignment
 *    already succeeded.
 *  - Undo: the same notice reverts the assignment to its prior value.
 *  - Block path (error state): where an Owner has escalated a rule to a hard
 *    block, the rejected assignment shows a distinct alert with no override.
 *  - Empty state: a project with no PLANNED/ACTIVE sprints shows the nudge,
 *    not the assignment control.
 *
 * All API calls are intercepted with Playwright route mocking, mirroring
 * task-recurrence.spec.ts.
 */

const PROJECT_ID = 'e2e-guardrail-00000000-0000-0000-0000-000000000001';
const TASK_ID = 'task-guardrail-1';
const SPRINT_ID = 'sprint-guardrail-1';

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Guardrail Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    agile_features: true,
  },
];

// A leaf, non-summary, non-milestone task — SprintSection only renders for these.
const TASKS = [
  {
    id: TASK_ID,
    wbs_path: '1',
    name: 'Migrate billing service',
    early_start: '2026-03-02',
    early_finish: '2026-03-13',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    status: 'NOT_STARTED',
    planned_start: null,
    sprint: null,
    assignments: [],
  },
];

// One PLANNED sprint whose window does NOT contain the task dates above — the
// out-of-window warn rule the golden path trips.
const SPRINT = {
  id: SPRINT_ID,
  server_version: 1,
  short_id: 'SP-G1',
  short_id_display: 'SP-G1',
  name: 'Sprint 7',
  goal: '',
  notes: '',
  start_date: '2026-01-05',
  finish_date: '2026-01-16',
  state: 'PLANNED',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: null,
  committed_points: null,
  committed_task_count: null,
  completed_points: null,
  completed_task_count: null,
  completion_ratio_points: null,
  completion_ratio_tasks: null,
  activated_at: null,
  closed_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const WARN_DETAIL =
  'These dates fall outside the Sprint 7 window — the task will show as spillover in the burndown.';
const BLOCK_DETAIL =
  'This phase rolls up its child tasks — assigning it would double-count them in velocity. Assign the child tasks instead.';

interface SetupOptions {
  /** Sprints the project exposes. Empty array exercises the empty-state nudge. */
  sprints?: unknown[];
  /** How a sprint-setting PATCH (`sprint != null`) resolves. */
  patch?: 'warn' | 'block' | 'clean';
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}
function page200(results: unknown[]) {
  return json({ count: results.length, next: null, previous: null, results });
}

async function setup(page: Page, opts: SetupOptions = {}) {
  const { sprints = [SPRINT], patch = 'warn' } = opts;

  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });

  // Sprints — override the fixture default (empty) with our PLANNED sprint.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (r) =>
    r.fulfill(page200(sprints)),
  );

  // Tasks: GET returns the (stateful) list; PATCH resolves per `patch`. Assigning
  // to a sprint trips the configured outcome; clearing it (Undo) always succeeds
  // cleanly so the notice can disappear on revert.
  let assignedSprint: string | null = null;
  await page.route('**/api/v1/tasks/**', (r) => {
    const req = r.request();
    if (req.method() === 'PATCH') {
      const body = JSON.parse(req.postData() ?? '{}') as { sprint?: string | null };
      const settingSprint = body.sprint != null;
      const base = {
        id: TASK_ID,
        name: 'Migrate billing service',
        project: PROJECT_ID,
        wbs_path: '1',
        duration: 10,
        status: 'NOT_STARTED',
        percent_complete: 0,
      };
      if (settingSprint && patch === 'block') {
        return r.fulfill(
          json(
            {
              code: 'guardrail_blocked',
              rule: 'phase_in_sprint',
              detail: BLOCK_DETAIL,
              suggested_action: 'assign_child_tasks',
            },
            400,
          ),
        );
      }
      assignedSprint = body.sprint ?? null;
      const warnings = settingSprint && patch === 'warn'
        ? [{ rule: 'task_outside_sprint_window', detail: WARN_DETAIL }]
        : [];
      return r.fulfill(json({ ...base, warnings }));
    }
    return r.fulfill(page200(TASKS.map((t) => ({ ...t, sprint: assignedSprint }))));
  });

  await page.goto(`/projects/${PROJECT_ID}/schedule`);
}

async function openSprintSection(page: Page) {
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await grid.getByText('Migrate billing service', { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /Migrate billing service/ }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await drawer.getByRole('button', { name: 'Sprint' }).click();
  return drawer;
}

test('warn: assigning an out-of-window task surfaces the override notice and keeps the assignment', async ({
  page,
}) => {
  await setup(page, { patch: 'warn' });
  const drawer = await openSprintSection(page);

  // The drawer also carries its own sr-only save-status live region (#1977), so
  // scope the guardrail notice lookup to the Sprint section region to stay unique.
  const sprint = drawer.getByRole('region', { name: 'Sprint' });

  await drawer.getByLabel('Sprint assignment').selectOption(SPRINT_ID);

  // Non-blocking notice (role="status"), in outcome language, with a one-tap override.
  const notice = sprint.getByRole('status');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(WARN_DETAIL);
  await expect(notice.getByRole('button', { name: 'Keep it here' })).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Undo' })).toBeVisible();

  // "Keep it here" dismisses the notice; the assignment (already succeeded) stays.
  await notice.getByRole('button', { name: 'Keep it here' }).click();
  await expect(sprint.getByRole('status')).toHaveCount(0);
});

test('undo: the override notice reverts the assignment to its prior value', async ({ page }) => {
  await setup(page, { patch: 'warn' });
  const drawer = await openSprintSection(page);

  const patches: (string | null)[] = [];
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && /\/tasks\//.test(req.url())) {
      const body = JSON.parse(req.postData() ?? '{}') as { sprint?: string | null };
      patches.push(body.sprint ?? null);
    }
  });

  // Scope to the Sprint region — the drawer's own save-status live region (#1977)
  // also has role="status".
  const sprint = drawer.getByRole('region', { name: 'Sprint' });

  await drawer.getByLabel('Sprint assignment').selectOption(SPRINT_ID);
  const notice = sprint.getByRole('status');
  await expect(notice).toBeVisible();

  await notice.getByRole('button', { name: 'Undo' }).click();
  await expect(sprint.getByRole('status')).toHaveCount(0);

  // Undo re-PATCHes the prior (null) sprint — the revert hit the server.
  await expect.poll(() => patches.at(-1)).toBeNull();
});

test('block: an Owner-escalated rule shows a non-overridable alert', async ({ page }) => {
  await setup(page, { patch: 'block' });
  const drawer = await openSprintSection(page);

  await drawer.getByLabel('Sprint assignment').selectOption(SPRINT_ID);

  // Blocking notice uses role="alert" and offers acknowledge only — no override.
  const alert = drawer.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(BLOCK_DETAIL);
  await expect(alert.getByRole('button', { name: 'Got it' })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Keep it here' })).toHaveCount(0);
  await expect(alert.getByRole('button', { name: 'Undo' })).toHaveCount(0);

  // "Got it" clears the block.
  await alert.getByRole('button', { name: 'Got it' }).click();
  await expect(drawer.getByRole('alert')).toHaveCount(0);
});

test('empty state: a project with no planned or active sprints shows the nudge', async ({
  page,
}) => {
  await setup(page, { sprints: [] });
  const drawer = await openSprintSection(page);

  await expect(drawer.getByText(/No active or planned sprints/i)).toBeVisible();
  await expect(drawer.getByLabel('Sprint assignment')).toHaveCount(0);
});

// --- touch-target geometry (#1801 backfill) ---
//
// Rule 228 / WCAG 2.5.5: these controls keep a 44px touch target on phones,
// compacting to a shorter `md:h-8` only at >=768px. The guardrail notice/block
// renders inside the mobile task-detail bottom sheet (rule 140), so 375px is a
// real phone target, not a hypothetical one. Prior coverage
// (GuardrailNotice.test.tsx / GuardrailBlock.test.tsx) only asserted the
// className string ('min-h-[44px]' / 'md:min-h-0' etc.) — these assert the
// real rendered bounding-box height at a real 375px viewport.
//
// The Schedule task-list grid this spec's other tests drive (`openSprintSection`)
// is desktop-only — it never mounts below `md:` (the schedule route switches to
// the dedicated `MobileSchedule` list-timeline surface, ADR-0348). Reaching
// the drawer at a real 375px viewport therefore goes through that surface's
// own row-open button instead of the desktop grid; `TaskDetailDrawer` itself
// (and its Sprint accordion / notice / alert) is unchanged — only the trigger
// differs. `TaskDetailDrawer` renders TWO sibling `role="dialog"` copies of
// the content unconditionally (a desktop right-side panel `hidden md:flex`
// and a mobile bottom sheet `md:hidden`), each mounting its own
// `DrawerContent` instance with independent local state — so this MUST
// drive the interaction through the mobile-visible copy directly rather than
// setting up state via the desktop copy and resizing after the fact (tried
// first; the desktop copy's local "warning" state never propagates to the
// sibling mobile instance, which never fired its own mutation).

for (const scenario of ['warn', 'block'] as const) {
  test(`touch targets: ${scenario} notice buttons stay >=44px tall at a 375px viewport (mobile schedule surface)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await setup(page, { patch: scenario });

    // MobileSchedule renders each task as a full-bleed open button labelled
    // "{name}, {status}, {dates}…" — tap it to open the SAME TaskDetailDrawer
    // the desktop grid opens, but through the phone-reachable trigger.
    const row = page.getByRole('button', { name: /^Migrate billing service, / });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();

    const drawer = page.getByRole('dialog', { name: /Migrate billing service/ });
    await expect(drawer).toBeVisible({ timeout: 5_000 });
    await drawer.getByRole('button', { name: 'Sprint' }).click();
    await drawer.getByLabel('Sprint assignment').selectOption(SPRINT_ID);

    if (scenario === 'warn') {
      // Scope to the Sprint region — the drawer's save-status live region (#1977)
      // also has role="status".
      const notice = drawer.getByRole('region', { name: 'Sprint' }).getByRole('status');
      await expect(notice).toBeVisible();
      for (const name of ['Keep it here', 'Undo']) {
        const box = await notice.getByRole('button', { name }).boundingBox();
        expect(box, `${name} bounding box`).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    } else {
      const alert = drawer.getByRole('alert');
      await expect(alert).toBeVisible();
      const box = await alert.getByRole('button', { name: 'Got it' }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
}
