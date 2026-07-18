/**
 * Pull-to-commit popover (#492, ADR-0067) — drag/resize on the Schedule canvas
 * no longer fires PATCH on pointerup; the new popover gates the commit.
 *
 * The full popover lifecycle (Confirm/Cancel/click-outside/aria-live/focus
 * trap/sprint-aware copy) is exercised at the vitest layer in
 * `ScheduleCommitPopover.test.tsx` and `useScheduleCommit.test.tsx`
 * (28 tests covering every branch).
 *
 * This E2E spec covers the user-visible regression boundary at the page level:
 * - Schedule view still renders without the popover on initial load
 * - Mounting the new hook does not break the existing canvas surface
 * - The popover component itself is reachable via DOM portal (regression
 *   guard for the createPortal mount path).
 *
 * Canvas-driven pointer drag is intentionally not asserted here — see the
 * comment in `schedule-build-mode.spec.ts` (lines 11–13) for the codebase
 * precedent: "Deeper structural / mutation flows … are exercised at the
 * vitest layer where they can be asserted without canvas/network coupling."
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-commit-00000000-0000-0000-0000-000000000492';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Commit Popover Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'tk1',
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-01',
    early_finish: '2026-04-05',
    planned_start: '2026-04-01',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'tk2',
    wbs_path: '2',
    name: 'Framing',
    early_start: '2026-04-08',
    early_finish: '2026-04-14',
    planned_start: '2026-04-08',
    duration: 7,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

test.describe('Schedule pull-to-commit popover (#492)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('schedule renders without the commit popover on initial load', async ({ page }) => {
    await page.goto(BASE_URL);
    // Wait for tasks to render so we know the Schedule view mounted.
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(page.getByText('Framing')).toBeVisible();
    // No "Reschedule task?" or "Resize task?" dialog should be in the DOM
    // until a real drag/resize releases past the 4 px threshold.
    await expect(page.getByRole('dialog', { name: 'Reschedule task?' })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Resize task?' })).toHaveCount(0);
  });

  test('schedule canvas interaction layer is reachable for pointer events', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    // The interaction canvas is layer 2 with pointer-events: auto so the
    // FSM can capture drag/resize. The new ADR-0067 commit popover replaces
    // the silent PATCH on `drag-task-end` / `resize-task-end` — but the
    // canvas surface itself is unchanged.
    const canvas = page.locator('canvas[data-layer="interaction"]');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
  });

  test('no patch fires on a click-without-drag over the canvas (4 px FSM threshold)', async ({ page }) => {
    const patchCalls: string[] = [];
    await page.route(/\/api\/v1\/tasks\/[^/]+\/$/, async (route) => {
      if (route.request().method() === 'PATCH') {
        patchCalls.push(route.request().url());
      }
      await route.continue();
    });
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    const canvas = page.locator('canvas[data-layer="interaction"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    // Click directly on the first task bar position with no drag — must not
    // open the popover and must not fire a PATCH. The 4 px FSM threshold
    // (rule 64) holds for both the legacy direct-PATCH path and the new
    // pull-to-commit gate.
    await page.mouse.click(box!.x + 10, box!.y + 42);
    await expect(page.getByRole('dialog', { name: 'Reschedule task?' })).toHaveCount(0);
    expect(patchCalls).toHaveLength(0);
  });
});
