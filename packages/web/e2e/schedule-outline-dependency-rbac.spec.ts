/**
 * The outline's dependency affordances answer to the EDGE band (#3142).
 *
 * Follow-up to #3053, which split `ScheduleView`'s single `readOnly` flag and
 * fixed the **canvas**. The outline beside it still resolved the same question
 * the old way, so both of #3053's failure directions were live one column to
 * the left: a Scheduler was refused `Add dependency…` the server accepts, and a
 * Member was offered it and 403'd.
 *
 * Every case drives **`can_edit` and the membership role together**. That is the
 * point of the file: they are the two inputs that must disagree for the bug to
 * appear, and a spec varying only one keeps passing against a gate re-collapsed
 * onto the task-content verdict.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER } from '../src/lib/roles';

const PROJECT_ID = 'e2e-outline-rbac-0000-0000-0000-00000003142';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Outline RBAC Project',
    description: '',
    start_date: '2026-06-01',
    calendar: 'default',
  },
];

/**
 * `can_edit` is the SERVER's per-task task-content verdict and is threaded
 * separately from the role — so each test states both, and the Scheduler case
 * is the one where they disagree.
 */
function task(id: string, wbs: string, name: string, canEdit: boolean) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-06-01',
    early_finish: '2026-06-10',
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
    can_edit: canEdit,
  };
}

/**
 * Serve the caller's own membership row at a chosen role.
 *
 * `setupApiMocks` hardcodes an Admin row on the `?self=true` branch, so this
 * override is what makes a role other than Admin expressible at all. Registered
 * AFTER `setupApiMocks` so it takes precedence, and it must handle only GET —
 * anything else falls through.
 */
async function serveSelfRole(page: Page, role: number) {
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.searchParams.get('self') === 'true') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'mem-self', role, role_label: `Role ${role}` }]),
      });
      return;
    }
    await route.fallback();
  });
}

async function gotoOutline(page: Page, role: number, canEdit: boolean) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    tasks: [
      task('task-a', '1', 'Design Phase', canEdit),
      task('task-b', '2', 'Build Phase', canEdit),
    ],
  });
  await serveSelfRole(page, role);
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({ timeout: 10_000 });
}

async function openRowMenu(page: Page, taskName: string) {
  const row = page.getByRole('row').filter({ hasText: taskName }).first();
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
}

test.describe('Outline dependency affordances follow the edge band (#3142)', () => {
  test('a Scheduler reaches Add dependency… despite can_edit=false', async ({ page }) => {
    // The stranding this issue is named for. The server sends can_edit:false for
    // the whole Scheduler band, so the old `authoring` gate emptied the menu.
    await gotoOutline(page, ROLE_SCHEDULER, false);
    await openRowMenu(page, 'Build Phase');
    await expect(page.getByRole('menuitem', { name: /Add dependency/ })).toBeVisible();
  });

  test('a Member with can_edit=true is NOT offered it — the 403 half', async ({ page }) => {
    await gotoOutline(page, ROLE_MEMBER, true);
    await openRowMenu(page, 'Build Phase');
    // The menu opens — a Member authors task content — but without this item.
    await expect(page.getByRole('menuitem', { name: /Duplicate/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Add dependency/ })).toHaveCount(0);
  });

  test('a Viewer opens no row menu at all', async ({ page }) => {
    await gotoOutline(page, ROLE_VIEWER, false);
    await openRowMenu(page, 'Build Phase');
    await expect(page.getByRole('menuitem')).toHaveCount(0);
  });

  test('the Links-cell control follows the same band as the menu item', async ({ page }) => {
    await gotoOutline(page, ROLE_SCHEDULER, false);
    await expect(page.getByTestId('links-cell-control').first()).toBeVisible();

    // Same page, same tasks, only the role differs — a Member gets text.
    await gotoOutline(page, ROLE_MEMBER, true);
    await expect(page.getByTestId('links-cell-control')).toHaveCount(0);
  });
});
