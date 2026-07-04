import { test, expect } from '@playwright/test';

/**
 * Resource assignment E2E tests — TaskDetailDrawer integration (#97).
 *
 * Tests the full path: Schedule task row click → drawer opens →
 * ResourceAssignmentSection renders → add/warn/dismiss/remove flows.
 *
 * All API calls are intercepted with Playwright route mocking so the tests
 * run against the production build without a live Django backend.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Alpha Platform Upgrade',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_API_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Alpha Platform Upgrade',
    early_start: '2026-10-05',
    early_finish: '2026-11-14',
    duration: 30,
    percent_complete: 40,
    is_critical: false,
    is_milestone: false,
  },
  {
    id: 't2',
    wbs_path: '1.1',
    name: 'Discovery & Design',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    duration: 10,
    percent_complete: 100,
    is_critical: true,
    is_milestone: false,
  },
];

/** Seed auth + mock core API routes and navigate to the Schedule view. */
async function gotoSchedule(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: {
          accessToken: 'e2e-token',
          refreshToken: 'e2e-refresh',
          isAuthenticated: true,
        },
        version: 0,
      }),
    );
  });

  // 401-guard safety net. Any endpoint not explicitly mocked below (the app-wide
  // shell + ⌘K palette fetch programs, sprints, velocity, project detail, me/work,
  // …) would otherwise 401 → refresh → expire and raise the full-screen
  // session-expired modal, which then intercepts every click. Registered FIRST so
  // the specific routes below (added later) take precedence; returns a benign empty
  // list shape. This previously passed on timing slack that #647's extra app-wide
  // hook subscriptions removed.
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );

  // The app fetches the current user on boot; give it a real user object (the
  // empty-list catch-all above would otherwise stand in and the shell would treat
  // the session as unauthenticated).
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'u1', email: 'pm@example.com', first_name: 'P', last_name: 'M' }),
    }),
  );

  // Cross-team "current sprint" lens (#1594) — CurrentSprintButton is mounted
  // globally in TopBar, so every routed page calls this. useMyActiveSprints
  // expects a raw array; without this mock it falls through to the paginated
  // catch-all object above, which crashes the app when the hook iterates it.
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_API_PROJECTS.length,
        next: null,
        previous: null,
        results: FIXTURE_API_PROJECTS,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    }),
  );
  // Stub overview endpoints
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 0,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    }),
  );
  // ADR-0133/#1142: the drawer gates write controls off the caller's project role
  // (GET members/?self=true). Without this mock the role never resolves and the
  // assignment controls render read-only, failing the editable-flow assertions.
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-self', role: 300 }]),
    }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_API_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_API_TASKS,
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
  // Default: tasks have no assignments
  await page.route('**/api/v1/task-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  // Default: resource search returns two resources (full shape for skill-fit hook)
  await page.route('**/api/v1/resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 2,
        next: null,
        previous: null,
        results: [
          {
            id: 'res-1',
            name: 'Alice Nguyen',
            email: '',
            job_role: '',
            max_units: '1.00',
            calendar: null,
            skills: [],
            skill_fit: 'missing',
            missing_skills: [],
          },
          {
            id: 'res-2',
            name: 'Bob Carter',
            email: '',
            job_role: '',
            max_units: '1.00',
            calendar: null,
            skills: [],
            skill_fit: 'missing',
            missing_skills: [],
          },
        ],
      }),
    }),
  );

  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

/** Click a task row by name and wait for the detail drawer to appear. */
async function openDrawer(page: import('@playwright/test').Page, taskName: string) {
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });

  // TaskListRow renders as role="row" without aria-label. The task name text
  // is inside a span within the row — clicking the text propagates to the row's
  // onClick which sets selectedTaskId and opens the drawer.
  await grid.getByText(taskName, { exact: true }).click();

  // On desktop (1280px viewport) the drawer renders as a slide-in role="dialog".
  // Its aria-label is set to drawerTitle only when a task is selected.
  const drawer = page.getByRole('dialog', { name: new RegExp(taskName) });
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

/**
 * Open the drawer; the resource assignment UI lives inside the Overview
 * section (issue #313 — pulled out of Dependencies to align with the May 2026
 * mockup). Overview is expanded by default per ADR-0050, so no extra clicks
 * are required.
 */
async function openDrawerWithResources(page: import('@playwright/test').Page, taskName: string) {
  return await openDrawer(page, taskName);
}

// ---------------------------------------------------------------------------
// Drawer open/close
// ---------------------------------------------------------------------------

test.describe('TaskDetailDrawer — open and close', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('clicking a task row opens the task detail drawer', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    // The redesigned header (#962) renders the task name as an editable input.
    await expect(drawer.getByRole('textbox', { name: 'Task name' })).toHaveValue(
      'Discovery & Design',
    );
  });

  test('close button dismisses the drawer', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: 'Close task detail' }).click();
    await expect(drawer).not.toBeVisible();
  });

  test('Escape key closes the drawer', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Assignees section structure
// ---------------------------------------------------------------------------

test.describe('ResourceAssignmentSection — structure inside drawer', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('drawer contains the Assignees section with Add resource button', async ({ page }) => {
    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    await expect(drawer.getByRole('region', { name: 'Assignees' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /Add resource/i })).toBeVisible();
  });

  test('shows "None" when the task has no assignments', async ({ page }) => {
    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    const section = drawer.getByRole('region', { name: 'Assignees' });
    await expect(section.getByText('None')).toBeVisible();
  });

  test('shows existing assignment row when task has an assignment', async ({ page }) => {
    // Override the task-resources route to return one assignment for t2
    await page.route('**/api/v1/task-resources/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              id: 'tr-1',
              task: 't2',
              resource: 'res-1',
              resource_name: 'Alice Nguyen',
              units: 0.75,
            },
          ],
        }),
      }),
    );

    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    const section = drawer.getByRole('region', { name: 'Assignees' });
    await expect(section.getByText('Alice Nguyen')).toBeVisible();
    // Allocation input should show 75 (percent)
    await expect(
      section.getByRole('spinbutton', { name: /Allocation percent for Alice Nguyen/i }),
    ).toHaveValue('75');
  });
});

// ---------------------------------------------------------------------------
// Add resource flow
// ---------------------------------------------------------------------------

test.describe('ResourceAssignmentSection — add resource flow', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('clicking Add resource opens the search combobox', async ({ page }) => {
    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: /Add resource/i }).click();
    await expect(drawer.getByRole('combobox', { name: 'Search resources' })).toBeVisible();
  });

  test('Escape inside the combobox closes the combobox', async ({ page }) => {
    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: /Add resource/i }).click();

    const combobox = drawer.getByRole('combobox', { name: 'Search resources' });
    await expect(combobox).toBeVisible();

    // Escape calls onDismiss which hides the combobox. The native Escape keydown
    // also propagates to the drawer's document-level listener which closes the drawer;
    // both the combobox and the drawer close on a single Escape press.
    await combobox.press('Escape');
    await expect(combobox).not.toBeVisible();
  });

  test('resource search shows results from the API', async ({ page }) => {
    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: /Add resource/i }).click();

    // The combobox preloads on mount; results should appear
    await expect(drawer.getByRole('listbox', { name: 'Resource options' })).toBeVisible();
    await expect(drawer.getByRole('option', { name: 'Alice Nguyen' })).toBeVisible();
    await expect(drawer.getByRole('option', { name: 'Bob Carter' })).toBeVisible();
  });

  test('selecting a resource from the list creates the assignment', async ({ page }) => {
    let postBody: { task?: string; resource?: string; units?: number } | null = null;
    let created = false;
    // Stateful: the GET returns [] until the POST fires, then the new row —
    // mirroring the live refetch. A GET that returns the post-create row from
    // time zero passes even when the mutation never fires, hits the wrong
    // endpoint, or sends the wrong body (issue 1512).
    // Use ** suffix so the pattern also matches GET ?task=t2 query-param requests.
    await page.route('**/api/v1/task-resources/**', async (route) => {
      if (route.request().method() === 'POST') {
        postBody = route.request().postDataJSON() as {
          task?: string;
          resource?: string;
          units?: number;
        };
        created = true;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'tr-new',
            task: 't2',
            resource: 'res-1',
            resource_name: 'Alice Nguyen',
            units: 1.0,
            warnings: [],
          }),
        });
      } else {
        // GET — empty until the create has been recorded, then the new row.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            count: created ? 1 : 0,
            next: null,
            previous: null,
            results: created
              ? [
                  {
                    id: 'tr-new',
                    task: 't2',
                    resource: 'res-1',
                    resource_name: 'Alice Nguyen',
                    units: 1.0,
                  },
                ]
              : [],
          }),
        });
      }
    });

    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: /Add resource/i }).click();
    await drawer.getByRole('option', { name: 'Alice Nguyen' }).click();

    // Combobox closes after selection
    await expect(drawer.getByRole('combobox', { name: 'Search resources' })).not.toBeVisible();
    // Assignment row appears
    const section = drawer.getByRole('region', { name: 'Assignees' });
    await expect(section.getByText('Alice Nguyen')).toBeVisible();
    // No warning banner for a clean add
    await expect(drawer.getByRole('alert')).not.toBeVisible();

    // The create actually fired against /task-resources/ with the task under
    // edit, the chosen resource, and full (1.0) allocation.
    expect(postBody).toMatchObject({ task: 't2', resource: 'res-1', units: 1 });
  });
});

// ---------------------------------------------------------------------------
// Overallocation warning
// ---------------------------------------------------------------------------

test.describe('ResourceAssignmentSection — overallocation warning', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('shows an overallocation warning when POST returns warnings', async ({ page }) => {
    let postBody: { task?: string; resource?: string; units?: number } | null = null;
    await page.route('**/api/v1/task-resources/**', async (route) => {
      if (route.request().method() === 'POST') {
        postBody = route.request().postDataJSON() as {
          task?: string;
          resource?: string;
          units?: number;
        };
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'tr-new',
            task: 't2',
            resource: 'res-1',
            resource_name: 'Alice Nguyen',
            units: 1.0,
            warnings: [
              {
                code: 'resource_overallocated',
                resource_id: 'res-1',
                resource_name: 'Alice Nguyen',
                detail: 'Alice Nguyen is allocated 150% across active tasks (capacity: 100%).',
              },
            ],
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
        });
      }
    });

    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: /Add resource/i }).click();
    await drawer.getByRole('option', { name: 'Alice Nguyen' }).click();

    const alert = drawer.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Alice Nguyen is allocated 150%');

    // The warning is the server's verdict on a real create — assert the POST
    // carried the resource the warning is about, not just that an alert showed.
    expect(postBody).toMatchObject({ task: 't2', resource: 'res-1', units: 1 });
  });

  test('dismissing the warning hides the alert', async ({ page }) => {
    await page.route('**/api/v1/task-resources/**', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'tr-new',
            task: 't2',
            resource: 'res-1',
            resource_name: 'Alice Nguyen',
            units: 1.0,
            warnings: [
              {
                code: 'resource_overallocated',
                resource_id: 'res-1',
                resource_name: 'Alice Nguyen',
                detail: 'Alice Nguyen is allocated 150% across active tasks (capacity: 100%).',
              },
            ],
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
        });
      }
    });

    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: /Add resource/i }).click();
    await drawer.getByRole('option', { name: 'Alice Nguyen' }).click();

    await expect(drawer.getByRole('alert')).toBeVisible();
    await drawer.getByRole('button', { name: 'Dismiss overallocation warning' }).click();
    await expect(drawer.getByRole('alert')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Remove assignment flow — the header promises "remove" but no test covered it.
// ---------------------------------------------------------------------------

test.describe('ResourceAssignmentSection — remove resource flow', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('removing an assignment fires DELETE and drops the row', async ({ page }) => {
    let deleted = false;
    let deletePath: string | null = null;
    // Stateful: the row exists until its DELETE fires, then the list is empty —
    // so the disappearance proves the DELETE round-tripped, not an optimistic
    // flicker that a body-blind mock can't distinguish from a broken endpoint.
    await page.route('**/api/v1/task-resources/**', async (route) => {
      const method = route.request().method();
      if (method === 'DELETE') {
        deleted = true;
        deletePath = new URL(route.request().url()).pathname;
        await route.fulfill({ status: 204, contentType: 'application/json', body: '' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: deleted ? 0 : 1,
          next: null,
          previous: null,
          results: deleted
            ? []
            : [
                {
                  id: 'tr-1',
                  task: 't2',
                  resource: 'res-1',
                  resource_name: 'Alice Nguyen',
                  units: 0.75,
                },
              ],
        }),
      });
    });

    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    const section = drawer.getByRole('region', { name: 'Assignees' });
    await expect(section.getByText('Alice Nguyen')).toBeVisible();

    await section.getByRole('button', { name: 'Remove Alice Nguyen from task' }).click();

    // The row is gone and the DELETE hit the specific assignment resource.
    await expect(section.getByText('Alice Nguyen')).toHaveCount(0);
    await expect(section.getByText('None')).toBeVisible();
    expect(deleted).toBe(true);
    expect(deletePath).toContain('/task-resources/tr-1/');
  });

  test('a failed remove rolls back and keeps the assignment row (#1518)', async ({ page }) => {
    let deleteAttempts = 0;
    // The DELETE 500s and the GET keeps returning the row (server-side the
    // assignment still exists). useRemoveAssignment applies an optimistic removal
    // in onMutate and restores the snapshot in onError, so the row must reappear —
    // the failed delete is non-destructive, not a silent data loss or a crash.
    await page.route('**/api/v1/task-resources/**', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteAttempts += 1;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"detail":"boom"}',
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [
            { id: 'tr-1', task: 't2', resource: 'res-1', resource_name: 'Alice Nguyen', units: 0.75 },
          ],
        }),
      });
    });

    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    const section = drawer.getByRole('region', { name: 'Assignees' });
    await expect(section.getByText('Alice Nguyen')).toBeVisible();

    await section.getByRole('button', { name: 'Remove Alice Nguyen from task' }).click();

    // The DELETE fired but failed; the row is restored (rollback + refetch) and
    // the section never collapses to the empty "None" state.
    await expect.poll(() => deleteAttempts).toBeGreaterThan(0);
    await expect(section.getByText('Alice Nguyen')).toBeVisible();
    await expect(section.getByText('None')).toHaveCount(0);
    // And the user gets an explicit error toast — the rollback is signalled (#1631).
    await expect(page.getByText("Couldn't remove the resource — try again.")).toBeVisible();
  });

  test('a failed add surfaces an error toast (#1631)', async ({ page }) => {
    let postAttempts = 0;
    // The POST 500s and the GET keeps returning [] (server-side nothing was
    // created). ResourceAssignmentSection closes the combobox in onSettled
    // regardless, so without a toast the failed add vanishes with no signal —
    // useAddAssignment.onError fires the toast (#1631).
    await page.route('**/api/v1/task-resources/**', async (route) => {
      if (route.request().method() === 'POST') {
        postAttempts += 1;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"detail":"boom"}',
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      });
    });

    const drawer = await openDrawerWithResources(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: /Add resource/i }).click();
    await drawer.getByRole('option', { name: 'Alice Nguyen' }).click();

    // The POST fired and failed; no row was added and the section stays "None",
    // but the user gets an explicit error toast rather than a silent close.
    await expect.poll(() => postAttempts).toBeGreaterThan(0);
    await expect(page.getByText("Couldn't add the resource — try again.")).toBeVisible();
    const section = drawer.getByRole('region', { name: 'Assignees' });
    await expect(section.getByText('None')).toBeVisible();
  });
});
