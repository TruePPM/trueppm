/**
 * Board viewability overhaul E2E (epic #1457, ADR-0192).
 *
 * Covers the three keystone behaviours of the first-class board:
 *   - #1459 column collapse-to-stub: a column folds to a narrow stub, a
 *     "N columns collapsed" banner appears with bulk expand, and a breaching
 *     folded column surfaces a tappable WIP popover.
 *   - #1460 phase-lane focus mode: focusing a lane hides the others, shows a
 *     focus banner, and is shareable/restorable via the ?focus= URL param.
 *
 * The fixed-width sticky grid (#1458) is structural CSS not assertable as a
 * discrete user action; its geometry helper is unit-tested in
 * src/features/board/boardGrid.test.ts.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-bv-00000000-0000-0000-0000-000000000020';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Viewability Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

// Two summary phases so focus mode has something to hide. Six IN_PROGRESS leaf
// tasks push that column over its default WIP limit (5) so the collapsed-stub
// breach popover has something to show.
const leaf = (
  id: string,
  parent: string,
  wbs: string,
  status: string,
  name: string,
) => ({
  id,
  wbs_path: wbs,
  name,
  early_start: '2026-01-05',
  early_finish: '2026-01-16',
  planned_start: '2026-01-05',
  duration: 10,
  percent_complete: 20,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  parent_id: parent,
  status,
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
});

const FIXTURE_TASKS = [
  {
    id: 'b1', wbs_path: '1', name: 'Alpha Phase',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 40, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  leaf('a1', 'b1', '1.1', 'IN_PROGRESS', 'Alpha Build 1'),
  leaf('a2', 'b1', '1.2', 'IN_PROGRESS', 'Alpha Build 2'),
  leaf('a3', 'b1', '1.3', 'IN_PROGRESS', 'Alpha Build 3'),
  leaf('a4', 'b1', '1.4', 'IN_PROGRESS', 'Alpha Build 4'),
  leaf('a5', 'b1', '1.5', 'IN_PROGRESS', 'Alpha Build 5'),
  leaf('a6', 'b1', '1.6', 'IN_PROGRESS', 'Alpha Build 6'),
  {
    id: 'c1', wbs_path: '2', name: 'Beta Phase',
    early_start: '2026-02-01', early_finish: '2026-03-14',
    duration: 30, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  leaf('c2', 'c1', '2.1', 'NOT_STARTED', 'Beta Spec'),
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 7 },
  });
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_TASKS,
      }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

test.describe('Board viewability — column collapse (#1459)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 10_000 });
  });

  test('collapsing a column folds it to a stub and shows the banner', async ({ page }) => {
    await expect(page.getByTestId('column-stub-IN_PROGRESS')).toHaveCount(0);

    await page.getByRole('button', { name: 'Collapse In Progress column' }).click();

    await expect(page.getByTestId('column-stub-IN_PROGRESS')).toBeVisible();
    const banner = page.getByTestId('collapsed-columns-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('1 column collapsed');
  });

  test('"Expand all" restores every collapsed column', async ({ page }) => {
    await page.getByRole('button', { name: 'Collapse In Progress column' }).click();
    await page.getByRole('button', { name: 'Collapse Review column' }).click();
    await expect(page.getByTestId('collapsed-columns-banner')).toContainText('2 columns collapsed');

    await page.getByTestId('expand-all-columns').click();

    await expect(page.getByTestId('collapsed-columns-banner')).toHaveCount(0);
    await expect(page.getByTestId('column-stub-IN_PROGRESS')).toHaveCount(0);
  });

  test('a folded over-WIP column surfaces a breach popover', async ({ page }) => {
    // 6 IN_PROGRESS tasks > default WIP limit 5 → over.
    await page.getByRole('button', { name: 'Collapse In Progress column' }).click();

    const trigger = page.getByTestId('collapsed-wip-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText('1 over WIP');

    await trigger.click();
    const popover = page.getByTestId('collapsed-wip-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('In Progress');
    await expect(popover).toContainText('6/5');
  });
});

test.describe('Board viewability — collapsed stub signals (#1695/#1696/#1697)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 10_000 });
  });

  test('a WIP breach stays visible on the stub with "Show WIP limits" off (#1695)', async ({
    page,
  }) => {
    // Turn "Show WIP limits" off, then fold the over-limit column (6 > 5).
    await page.getByRole('button', { name: 'More board controls' }).click();
    await page.getByLabel('Show WIP limits').click();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Collapse In Progress column' }).click();

    const stub = page.getByTestId('column-stub-IN_PROGRESS');
    await expect(stub).toBeVisible();
    // The breach tone + N/limit survive the toggle being off.
    await expect(stub).toHaveAttribute('data-wip-state', 'over');
    await expect(stub).toContainText('6/5');
    await expect(stub).toHaveAccessibleName(/over WIP limit of 5/);
  });

  test('an empty folded column shows a hollow-0 "empty" stub (#1697)', async ({ page }) => {
    // Review holds no cards in the fixture.
    await page.getByRole('button', { name: 'Collapse Review column' }).click();

    const stub = page.getByTestId('column-stub-REVIEW');
    await expect(stub).toBeVisible();
    await expect(stub).toHaveAccessibleName(/Expand Review column, empty/);
  });
});

test.describe('Board viewability — your cards inside a stub (#1696)', () => {
  // One IN_PROGRESS leaf assigned to the current user, plus an is_me resource so
  // myResourceId resolves. Both are registered after setup() so they take route
  // precedence over the empty defaults (Playwright honors last-registered).
  const MY_TASKS = FIXTURE_TASKS.map((t) =>
    t.id === 'a1'
      ? { ...t, assignments: [{ resource_id: 'rme', resource_name: 'Me', units: '1.00' }] }
      : t,
  );
  const RESOURCES_WITH_ME = [
    {
      id: 'pr-me',
      project: FIXTURE_PROJECT_ID,
      resource: 'rme',
      resource_detail: {
        id: 'rme',
        name: 'Me',
        email: 'e2e@example.com',
        job_role: '',
        max_units: '1.00',
        calendar: null,
        skills: [],
        is_me: true,
      },
      role_title: '',
      units_override: null,
      effective_max_units: '1.00',
      notes: '',
    },
  ];

  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/project-resources/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: RESOURCES_WITH_ME }),
      }),
    );
    await page.route('**/api/v1/tasks/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: MY_TASKS.length, next: null, previous: null, results: MY_TASKS }),
      }),
    );
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
  });

  test('folding a column with your card marks the stub and offers a banner expand', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Collapse In Progress column' }).click();

    const stub = page.getByTestId('column-stub-IN_PROGRESS');
    await expect(stub).toHaveAttribute('data-has-my-cards', 'true');
    await expect(stub).toHaveAccessibleName(/contains 1 of your card/);

    const banner = page.getByTestId('collapsed-columns-banner');
    const expandMine = banner.getByTestId('expand-my-hidden-columns');
    await expect(expandMine).toContainText('1 of your card hidden');

    await expandMine.click();
    await expect(stub).toHaveCount(0);
  });
});

test.describe('Board viewability — phase-lane focus (#1460)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Beta Phase')).toBeVisible({ timeout: 10_000 });
  });

  test('focusing a lane hides the others and shows the focus banner', async ({ page }) => {
    await page.getByTestId('focus-lane-b1').click();

    const banner = page.getByTestId('focus-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Alpha Phase');
    // The Alpha lane stays; the Beta lane is hidden while Alpha is focused.
    // Scope to the swimlane group so the banner's copy doesn't collide.
    await expect(page.getByRole('group', { name: 'Alpha Phase swimlane' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Beta Phase swimlane' })).toHaveCount(0);
  });

  test('exiting focus restores all lanes', async ({ page }) => {
    await page.getByTestId('focus-lane-b1').click();
    await expect(page.getByTestId('focus-banner')).toBeVisible();

    await page.getByTestId('exit-focus').click();

    await expect(page.getByTestId('focus-banner')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Beta Phase swimlane' })).toBeVisible();
  });

  test('?focus= deep link opens the board already focused', async ({ page }) => {
    await page.goto(`${BASE_URL}/board?focus=c1`);
    await expect(page.getByRole('group', { name: 'Beta Phase swimlane' })).toBeVisible({
      timeout: 10_000,
    });

    await expect(page.getByTestId('focus-banner')).toContainText('Beta Phase');
    await expect(page.getByRole('group', { name: 'Alpha Phase swimlane' })).toHaveCount(0);
  });
});

test.describe('Board viewability — per-cell card cap (#1967, ADR-0420)', () => {
  // A phase with 8 calm leaf cards in To Do (NOT_STARTED has wip_limit null in
  // the canonical config, so the cell is under-WIP and the cap — not a breach —
  // governs it).
  const CAP_PHASE = {
    id: 'cap-phase', wbs_path: '9', name: 'Cap Phase',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  };
  const CAP_TASKS = [
    CAP_PHASE,
    ...Array.from({ length: 8 }, (_, i) =>
      leaf(`cap${i}`, 'cap-phase', `9.${i + 1}`, 'NOT_STARTED', `Cap Card ${i + 1}`),
    ),
  ];

  async function setupCap(page: import('@playwright/test').Page, capOn: boolean) {
    if (capOn) {
      await page.addInitScript(() => {
        localStorage.setItem('trueppm.board.toolbarPrefs.v1', JSON.stringify({ cellCap: 6 }));
      });
    }
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: CAP_TASKS,
      statusSummary: { task_count: 8 },
    });
    await page.route('**/api/v1/tasks/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: CAP_TASKS.length, next: null, previous: null, results: CAP_TASKS }),
      }),
    );
    await page.route('**/api/v1/dependencies/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Cap Phase')).toBeVisible({ timeout: 10_000 });
  }

  test('with the cap off (default) every card renders and no overflow toggle appears', async ({
    page,
  }) => {
    await setupCap(page, false);
    await expect(page.getByRole('button', { name: /Cap Card 8,/ })).toBeVisible();
    await expect(page.getByTestId('cell-overflow-toggle')).toHaveCount(0);
  });

  test('with the cap on, the calm overflow collapses behind a "+N more" disclosure', async ({
    page,
  }) => {
    await setupCap(page, true);
    const toggle = page.getByTestId('cell-overflow-toggle');
    await expect(toggle).toBeVisible();
    // 8 calm cards, cap 6 → 2 hidden.
    await expect(toggle).toHaveAccessibleName('Show 2 more cards');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('clicking the disclosure reveals the hidden cards', async ({ page }) => {
    await setupCap(page, true);
    const toggle = page.getByTestId('cell-overflow-toggle');
    await toggle.click();
    await expect(page.getByTestId('cell-overflow-toggle')).toHaveAccessibleName('Show fewer cards');
    await expect(page.getByTestId('cell-overflow-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  test('the "Cap tall cells" control lives in the More menu', async ({ page }) => {
    await setupCap(page, false);
    await page.getByRole('button', { name: 'More board controls' }).click();
    await expect(page.getByRole('checkbox', { name: /Cap tall cells/ })).toBeVisible();
  });
});
