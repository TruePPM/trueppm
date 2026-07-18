/**
 * Board "My tasks" filter — issue #198.
 *
 * Verifies:
 *   - Pill renders, default-off for ADMIN role.
 *   - Toggling on hides tasks not assigned to the current user's resource.
 *   - "Filter: My tasks" chip + "Show all →" affordance appears.
 *   - Toggle state persists across reloads via localStorage.
 *   - Empty state renders when contributor has zero matching tasks.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-board-my-tasks-00000000-0000-0000-0000-0001';
const ROUTE = `/projects/${FIXTURE_PROJECT_ID}/board`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'My Tasks Filter Test',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

// Two tasks under one phase. Alice's task includes assignee with resourceId
// 'r1' (matches the user's resource via is_me=true below); Bob's task does not.
const FIXTURE_TASKS = [
  {
    id: 'mt-1',
    wbs_path: '1',
    name: 'Implementation Phase',
    early_start: '2026-01-05',
    early_finish: '2026-02-14',
    duration: 30,
    percent_complete: 30,
    is_critical: false,
    is_milestone: false,
    is_summary: true,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'mt-2',
    wbs_path: '1.1',
    name: 'Alice Build',
    early_start: '2026-01-05',
    early_finish: '2026-01-16',
    duration: 10,
    percent_complete: 50,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'mt-1',
    status: 'IN_PROGRESS',
    assignments: [{ resource_id: 'r1', resource_name: 'Alice', units: '1.00' }],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'mt-3',
    wbs_path: '1.2',
    name: 'Bob Build',
    early_start: '2026-01-19',
    early_finish: '2026-01-30',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'mt-1',
    status: 'NOT_STARTED',
    assignments: [{ resource_id: 'r2', resource_name: 'Bob', units: '1.00' }],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

const PROJECT_RESOURCES_WITH_ME = [
  {
    id: 'pr-1',
    project: FIXTURE_PROJECT_ID,
    resource: 'r1',
    resource_detail: {
      id: 'r1',
      name: 'Alice (you)',
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
  {
    id: 'pr-2',
    project: FIXTURE_PROJECT_ID,
    resource: 'r2',
    resource_detail: {
      id: 'r2',
      name: 'Bob',
      email: 'bob@example.com',
      job_role: '',
      max_units: '1.00',
      calendar: null,
      skills: [],
      is_me: false,
    },
    role_title: '',
    units_override: null,
    effective_max_units: '1.00',
    notes: '',
  },
];

async function setup(
  page: import('@playwright/test').Page,
  opts: { projectResources?: unknown[] } = {},
) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
  });
  // Override project-resources with our fixture (default in setupApiMocks is empty).
  await page.route('**/api/v1/project-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: (opts.projectResources ?? PROJECT_RESOURCES_WITH_ME).length,
        next: null,
        previous: null,
        results: opts.projectResources ?? PROJECT_RESOURCES_WITH_ME,
      }),
    }),
  );
}

test.describe('Board My tasks filter (#198)', () => {
  test('pill renders and toggling hides non-assigned tasks; chip persists across reload', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(ROUTE);
    // Both tasks visible by default (ADMIN role default = off).
    await expect(page.getByText('Alice Build')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Bob Build')).toBeVisible();

    const pill = page
      .getByRole('toolbar', { name: 'Board toolbar' })
      .getByRole('button', { name: 'My tasks', exact: true });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('aria-pressed', 'false');

    await expect(pill).toBeEnabled({ timeout: 10_000 });
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');

    // Alice's card stays; Bob's disappears.
    await expect(page.getByText('Alice Build')).toBeVisible();
    await expect(page.getByText('Bob Build')).not.toBeVisible();

    // The "Filter: My tasks · Show all →" chip is rendered.
    await expect(page.getByText('Filter: My tasks')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show all →' })).toBeVisible();

    // Reload — preference persisted in localStorage; filter remains active.
    await page.reload();
    await expect(
      page
        .getByRole('toolbar', { name: 'Board toolbar' })
        .getByRole('button', { name: 'My tasks', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Bob Build')).not.toBeVisible();
  });

  test('"Show all →" chip disables the filter and restores all tasks', async ({ page }) => {
    await setup(page);
    await page.goto(ROUTE);
    {
      const _pill = page
        .getByRole('toolbar', { name: 'Board toolbar' })
        .getByRole('button', { name: 'My tasks', exact: true });
      await expect(_pill).toBeEnabled({ timeout: 10_000 });
      await _pill.click();
    }
    await expect(page.getByText('Bob Build')).not.toBeVisible();

    await page.getByRole('button', { name: 'Show all →' }).click();
    await expect(page.getByText('Bob Build')).toBeVisible();
    await expect(
      page
        .getByRole('toolbar', { name: 'Board toolbar' })
        .getByRole('button', { name: 'My tasks', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  test('empty state renders when contributor has no matching tasks', async ({ page }) => {
    // Pool returns no resources flagged is_me — myResourceId is null and
    // every task is filtered out, surfacing the dedicated empty state.
    const noMatchPool = [
      {
        id: 'pr-only',
        project: FIXTURE_PROJECT_ID,
        resource: 'r2',
        resource_detail: {
          id: 'r2',
          name: 'Bob',
          email: 'bob@example.com',
          job_role: '',
          max_units: '1.00',
          calendar: null,
          skills: [],
          is_me: false,
        },
        role_title: '',
        units_override: null,
        effective_max_units: '1.00',
        notes: '',
      },
    ];
    await setup(page, { projectResources: noMatchPool });
    await page.goto(ROUTE);
    await expect(page.getByText('Alice Build')).toBeVisible({ timeout: 10_000 });
    {
      const _pill = page
        .getByRole('toolbar', { name: 'Board toolbar' })
        .getByRole('button', { name: 'My tasks', exact: true });
      await expect(_pill).toBeEnabled({ timeout: 10_000 });
      await _pill.click();
    }
    await expect(page.getByText('No tasks assigned to you in this project yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show all tasks' })).toBeVisible();
  });
});
