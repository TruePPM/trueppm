/**
 * Cross-project dependency creation (#1150 / ADR-0120 create side).
 *
 * The schedule dependency picker (opened from the build-mode row menu's
 * "Add successor…") gains a "This project / Program" scope toggle when the
 * project belongs to a program. In Program scope the user searches sibling
 * projects and picks a task to gate against; the created edge is either modeled
 * immediately (creator has Scheduler+ on both sides) or created inert pending the
 * counterpart team's acceptance (ADR-0120 D2). The success toast reflects which.
 *
 * Covers: the toggle appears only for a programmed project, a Program-scope
 * search returns grouped sibling tasks, picking one POSTs the edge and fires the
 * consent-aware toast (accepted vs pending), and a standalone project shows no
 * toggle (regression).
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROGRAM_ID = 'e2e-prog-00000000-0000-0000-0000-000000001150';
const PROJECT_ID = 'e2e-xproj-00000000-0000-0000-0000-000000001150';
const STANDALONE_ID = 'e2e-solo-00000000-0000-0000-0000-000000001150';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROGRAMMED_PROJECT = {
  id: PROJECT_ID,
  name: 'Marketing',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  program: PROGRAM_ID,
};

const STANDALONE_PROJECT = {
  id: STANDALONE_ID,
  name: 'Solo Project',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  program: null,
};

const FIXTURE_TASKS = [
  {
    id: 'bm1', wbs_path: '1', name: 'Foundation',
    early_start: '2026-04-05', early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  // A second local task so the picker's "This project" scope has a pickable
  // option (the source task itself is always excluded from its own results).
  {
    id: 'bm2', wbs_path: '2', name: 'Framing',
    early_start: '2026-04-12', early_finish: '2026-04-16',
    planned_start: '2026-04-12',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

// Sibling-project tasks returned by the program task-search endpoint.
const CROSS_ROWS = [
  { id: 'x1', name: 'Security sign-off', short_id: 'SEC-3', project_id: 'p-sec', project_name: 'Security' },
  { id: 'x2', name: 'Security review', short_id: 'SEC-8', project_id: 'p-sec', project_name: 'Security' },
  { id: 'x3', name: 'Legal go-ahead', short_id: 'LEG-1', project_id: 'p-leg', project_name: 'Legal' },
];

async function enableBuildMode(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ schedule_build_mode_v1: true }));
  });
}

/** Register the program task-search mock. */
async function mockTaskSearch(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/programs/*/task-search/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CROSS_ROWS),
    }),
  );
}

/**
 * Register the /dependencies/ handler: POST captures the payload and returns the
 * created edge with `pending_acceptance` = `pending`; GET returns an empty list.
 * `capture.payload` holds the last POST body for assertions.
 */
async function mockDependencies(
  page: import('@playwright/test').Page,
  pending: boolean,
  capture: { payload: Record<string, unknown> | null },
) {
  await page.route('**/api/v1/dependencies/**', (route) => {
    if (route.request().method() === 'POST') {
      capture.payload = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'dep-new',
          predecessor: capture.payload.predecessor,
          successor: capture.payload.successor,
          dep_type: capture.payload.dep_type ?? 'FS',
          lag: capture.payload.lag ?? 0,
          pending_acceptance: pending,
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    });
  });
}

async function openSuccessorPicker(page: import('@playwright/test').Page) {
  await page.goto(BASE_URL);
  // Gate on a rendered row (not a spinner) before driving the context menu.
  await expect(page.getByText('Foundation')).toBeVisible({ timeout: 10_000 });
  await page.getByText('Foundation').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Row actions' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /Add successor/ }).click();
  return page.getByRole('dialog', { name: /Add successor/ });
}

/** Opens the task detail drawer and expands its (collapsed-by-default) Dependencies section. */
async function openDrawerDependencies(
  page: import('@playwright/test').Page,
  taskName: string,
  url: string = BASE_URL,
) {
  await page.goto(url);
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await grid.getByText(taskName, { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(taskName) }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await drawer.getByRole('button', { name: 'Dependencies' }).click();
  return drawer;
}

test.describe('Cross-project dependency picker (#1150)', () => {
  test('a programmed project offers the Program scope; picking a sibling task links it (accepted)', async ({
    page,
  }) => {
    const capture: { payload: Record<string, unknown> | null } = { payload: null };
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [PROGRAMMED_PROJECT],
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
    await mockTaskSearch(page);
    await mockDependencies(page, false, capture);

    const dialog = await openSuccessorPicker(page);
    await expect(dialog).toBeVisible();

    // The scope toggle is present because the project belongs to a program.
    await dialog.getByRole('tab', { name: 'Program' }).click();
    await dialog.getByLabel('Search tasks').fill('sec');

    // Grouped sibling results appear (after the 200ms search debounce).
    const list = dialog.getByRole('listbox', { name: 'Program task results' });
    await expect(list.getByText('Security', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /Security sign-off/ }).click();

    // The edge is posted source → picked (successor mode).
    await expect(page.getByText(/Linked across projects/)).toBeVisible();
    expect(capture.payload).toMatchObject({ predecessor: 'bm1', successor: 'x1' });
  });

  test('an inert (pending-acceptance) edge surfaces the consent toast', async ({ page }) => {
    const capture: { payload: Record<string, unknown> | null } = { payload: null };
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [PROGRAMMED_PROJECT],
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
    await mockTaskSearch(page);
    await mockDependencies(page, true, capture);

    const dialog = await openSuccessorPicker(page);
    await dialog.getByRole('tab', { name: 'Program' }).click();
    await dialog.getByLabel('Search tasks').fill('leg');
    await dialog.getByRole('button', { name: /Legal go-ahead/ }).click();

    await expect(page.getByText(/waiting for Legal to accept/)).toBeVisible();
  });

  test('a standalone project shows no scope toggle (regression)', async ({ page }) => {
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [STANDALONE_PROJECT],
      projectId: STANDALONE_ID,
      tasks: FIXTURE_TASKS,
    });

    await page.goto(`/projects/${STANDALONE_ID}/schedule`);
    await expect(page.getByText('Foundation')).toBeVisible({ timeout: 10_000 });
    await page.getByText('Foundation').click({ button: 'right' });
    await page.getByRole('menu', { name: 'Row actions' }).getByRole('menuitem', { name: /Add successor/ }).click();

    const dialog = page.getByRole('dialog', { name: /Add successor/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Program' })).toHaveCount(0);
    await expect(dialog.getByRole('option').first()).toBeVisible();
  });
});

test.describe('Drawer cross-project search link (gap closed — DependenciesTab lacked ADR-0120 parity)', () => {
  test('the drawer\'s "Search another project" link opens the picker landed on Program scope', async ({
    page,
  }) => {
    const capture: { payload: Record<string, unknown> | null } = { payload: null };
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [PROGRAMMED_PROJECT],
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
    await mockTaskSearch(page);
    await mockDependencies(page, false, capture);

    const drawer = await openDrawerDependencies(page, 'Foundation');
    // First link belongs to the Predecessors section (rendered before Successors).
    await drawer
      .getByRole('button', { name: /Search another project in this program/ })
      .first()
      .click();

    const dialog = page.getByRole('dialog', { name: /Add predecessor/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Program', selected: true })).toBeVisible();

    await dialog.getByLabel('Search tasks').fill('sec');
    const list = dialog.getByRole('listbox', { name: 'Program task results' });
    await expect(list.getByText('Security', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /Security sign-off/ }).click();

    // predecessor mode: picked → source.
    await expect(page.getByText(/Linked across projects/)).toBeVisible();
    expect(capture.payload).toMatchObject({ predecessor: 'x1', successor: 'bm1' });
  });

  test('a standalone project\'s drawer shows no cross-project search link (regression)', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [STANDALONE_PROJECT],
      projectId: STANDALONE_ID,
      tasks: FIXTURE_TASKS,
    });

    const drawer = await openDrawerDependencies(
      page,
      'Foundation',
      `/projects/${STANDALONE_ID}/schedule`,
    );
    await expect(
      drawer.getByRole('button', { name: /Search another project in this program/ }),
    ).toHaveCount(0);
  });
});
