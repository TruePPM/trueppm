/**
 * The task drawer's Dependencies section must not offer edge writes to a
 * reader the server refuses (#3143).
 *
 * Before this, `DependenciesSection` took no role and derived none, so add
 * predecessor, add successor and per-edge Remove rendered for every reader —
 * Viewer included. It is the only one of the five dependency-write surfaces
 * that offers a **delete**.
 *
 * Both bands are driven, not just Viewer: edges are `IsProjectScheduler` and
 * task content is `IsProjectPlanAuthor`, and neither contains the other
 * (ADR-0773 §7). A spec that only proved "Viewer sees nothing" would keep
 * passing against a gate re-collapsed onto the task-content verdict, which is
 * the exact regression #3142/#3143 are named for — so the Scheduler case is
 * asserted in the same file.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER } from '../src/lib/roles';

const PROJECT_ID = 'e2e-dep-rbac-0000-0000-0000-000000003143';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Dependency RBAC Project',
    description: '',
    start_date: '2026-06-01',
    calendar: 'default',
  },
];

function task(id: string, wbs: string, name: string, start: string, finish: string) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: start,
    early_finish: finish,
    duration: 7,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    assignments: [],
    notes: '',
  };
}

const FIXTURE_TASKS = [
  task('task-a', '1', 'Design Phase', '2026-06-01', '2026-06-10'),
  task('task-b', '2', 'Build Phase', '2026-06-11', '2026-06-20'),
];

/** One existing edge, so the per-edge Remove control has something to render on. */
const FIXTURE_DEPENDENCY = {
  id: 'dep-1',
  predecessor: 'task-a',
  successor: 'task-b',
  dep_type: 'FS',
  lag: 0,
  is_critical: false,
};

async function gotoScheduleAs(page: import('@playwright/test').Page, role: number) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    tasks: FIXTURE_TASKS,
    dependencies: [FIXTURE_DEPENDENCY],
    // The gate's only input: the role served to `?self=true`, which is what
    // `useCurrentUserRole` reads. Note `members` would NOT work here — that
    // option feeds the roster list, and the self branch ignores it.
    selfRole: role,
  });
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({ timeout: 10_000 });
}

async function openDependencies(page: import('@playwright/test').Page, taskName: string) {
  const grid = page.getByRole('treegrid', { name: 'Item list' });
  await grid.getByRole('button', { name: `Open properties for ${taskName}` }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(taskName) }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await drawer.getByRole('button', { name: 'Dependencies' }).click();
  const region = drawer.getByRole('region', { name: /dependencies/i }).first();
  await expect(region).toBeVisible({ timeout: 5_000 });
  return region;
}

test.describe('Task drawer dependency writes are role-gated (#3143)', () => {
  test('a Viewer gets no add, no remove, and no edge editing', async ({ page }) => {
    await gotoScheduleAs(page, ROLE_VIEWER);
    const region = await openDependencies(page, 'Build Phase');

    // The existing edge is still listed — gated, not hidden. Waiting on this
    // first means the assertions below run against a rendered section rather
    // than an empty one, so "absent" cannot pass for "not painted yet".
    await expect(region.getByText(/1 — Design Phase/)).toBeVisible();
    await expect(region.getByText(/Finish-to-Start/)).toBeVisible();

    await expect(region.getByRole('button', { name: 'Add predecessor' })).toHaveCount(0);
    await expect(region.getByRole('button', { name: 'Add successor' })).toHaveCount(0);
    await expect(region.getByRole('button', { name: /Remove dependency on/ })).toHaveCount(0);
    // The type select and lag input are controls too — absent, not disabled.
    await expect(region.getByRole('combobox')).toHaveCount(0);
    await expect(region.getByRole('spinbutton')).toHaveCount(0);
  });

  test('a Member is refused too — task content does not imply edges', async ({ page }) => {
    await gotoScheduleAs(page, ROLE_MEMBER);
    const region = await openDependencies(page, 'Build Phase');

    await expect(region.getByText(/1 — Design Phase/)).toBeVisible();
    await expect(region.getByRole('button', { name: 'Add predecessor' })).toHaveCount(0);
    await expect(region.getByRole('button', { name: /Remove dependency on/ })).toHaveCount(0);
  });

  test('a Scheduler keeps the drawer route — it is their keyboard path', async ({ page }) => {
    await gotoScheduleAs(page, ROLE_SCHEDULER);
    const region = await openDependencies(page, 'Build Phase');

    await expect(region.getByRole('button', { name: 'Add predecessor' })).toBeVisible();
    await expect(region.getByRole('button', { name: 'Add successor' })).toBeVisible();
    await expect(region.getByRole('button', { name: /Remove dependency on/ })).toBeVisible();
  });
});
