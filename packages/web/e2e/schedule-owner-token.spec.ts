/**
 * The `@owner` inline authoring token in build-mode row entry (ADR-0774, #2718).
 *
 * The property under test is not "the popover opens" — it is that the token reaches the
 * API as an `owners` array, which becomes a `TaskResource` row with units and therefore
 * a real number on the capacity surfaces. Writing `Task.assignee` instead would look
 * identical in the UI and contribute ZERO to every capacity, utilization, heat-map and
 * sprint-capacity computation, silently and permanently.
 *
 * The heat-map assertion is served by a **stateful** mock derived from the PATCH the app
 * actually sent: if the client wrote `assignee` instead of `owners`, the roster row the
 * heat map is built from never appears, and the last test fails. A static heat-map
 * fixture would pass either way and prove nothing.
 *
 * Every task read here goes through `setupTaskStore`, not the stateless default list
 * mock. The tests that assert on the row *after* the commit would otherwise be racing
 * the `['tasks']` invalidation `useUpdateTask` fires on success (#2752).
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, setupTaskStore } from './fixtures';
import type { TaskStoreHandle } from './fixtures';

type Page = import('@playwright/test').Page;

const PROJECT_ID = 'e2e-owner-00000000-0000-0000-0000-000000002718';
const SCHEDULE_URL = `/projects/${PROJECT_ID}/schedule`;
const ANA_ID = 'res-ana-2718';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Owner Token Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'ot1',
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    planned_start: '2026-04-06',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    assignments: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

const ROSTER = [
  {
    id: 'pr-ana',
    project: PROJECT_ID,
    resource: ANA_ID,
    resource_detail: {
      id: ANA_ID,
      name: 'Ana Rivera',
      email: 'ana@example.com',
      job_role: 'Analyst',
      max_units: '1.00',
      calendar: null,
      skills: [],
    },
    role_title: 'Analyst',
    units_override: null,
    effective_max_units: '1.00',
    notes: '',
  },
  {
    id: 'pr-ben',
    project: PROJECT_ID,
    resource: 'res-ben-2718',
    resource_detail: {
      id: 'res-ben-2718',
      name: 'Ben Okafor',
      email: 'ben@example.com',
      job_role: 'Engineer',
      max_units: '1.00',
      calendar: null,
      skills: [],
    },
    role_title: 'Engineer',
    units_override: null,
    effective_max_units: '1.00',
    notes: '',
  },
];

async function setup(page: Page): Promise<TaskStoreHandle> {
  await setupAuth(page);
  await setupCatchAll(page);
  // No `tasks:` — setupTaskStore below owns every /tasks/ read, and leaving the
  // stateless default registered as well would put two sources of truth for the same
  // list one route-precedence change apart.
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
  });

  // Registered after setupApiMocks so it wins over the default empty roster.
  await page.route('**/api/v1/project-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: ROSTER.length, next: null, previous: null, results: ROSTER }),
    }),
  );

  // A STATEFUL task store, not a per-request echo: the commit assertions below read the
  // DOM *after* the write, and `useUpdateTask` invalidates `['tasks', projectId]` in
  // `onSuccess`. Against the stateless default list mock that refetch re-serves
  // `Foundation` and erases the committed name within tens of milliseconds, which is the
  // race that failed `web:e2e` on main (#2752). The store makes the refetch return what
  // was written, so the assertion has a stable end state to see.
  return setupTaskStore(page, {
    tasks: FIXTURE_TASKS,
    // `owners` is write-only on TaskSerializer; the read projection is `assignments`.
    // A shallow merge would echo back a field the real API never returns.
    applyPatch: (body, current) => {
      const { owners, ...rest } = body as {
        owners?: { resource: string; units: number }[];
      } & Record<string, unknown>;
      return {
        ...current,
        ...rest,
        ...(owners
          ? {
              assignments: owners.map((o) => ({
                resource_id: o.resource,
                resource_name: o.resource === ANA_ID ? 'Ana Rivera' : 'Ben Okafor',
                units: String(o.units),
              })),
            }
          : {}),
      };
    },
  });
}

/** Put the Foundation row's Name cell into build-mode edit. */
async function editName(page: Page) {
  await expect(page.getByText('Foundation')).toBeVisible();
  await page.getByText('Foundation').dblclick();
  return page.getByLabel('Rename item Foundation');
}

test.describe('@owner token — build-mode row entry', () => {
  test('typing @ opens the roster picker and picking a person writes owners', async ({
    page,
  }) => {
    const store = await setup(page);
    await page.goto(SCHEDULE_URL);

    const input = await editName(page);
    await input.fill('Draft migration plan @an');

    const listbox = page.getByRole('listbox', { name: 'Assign owner' });
    await expect(listbox).toBeVisible();
    await listbox.getByRole('option', { name: /Ana Rivera/ }).click();

    // Since #2722 a pick COMPLETES the token in place rather than committing the
    // row — focus never leaves the row, so more tokens may follow. Enter commits.
    await expect(input).toHaveValue('Draft migration plan @"Ana Rivera"');
    await input.press('Enter');

    await expect.poll(() => store.patches.length).toBeGreaterThan(0);
    const body = store.patches[store.patches.length - 1];
    // The assignment lands on TaskResource (via `owners`), never on `assignee`.
    expect(body.owners).toEqual([{ resource: ANA_ID, units: 1 }]);
    expect(body).not.toHaveProperty('assignee');
    // The token itself is not part of the task's name.
    expect(body.name).toBe('Draft migration plan');
  });

  test('@ana:50 commits a half allocation as the API fraction', async ({ page }) => {
    const store = await setup(page);
    await page.goto(SCHEDULE_URL);

    const input = await editName(page);
    await input.fill('Review the estimates @"Ana Rivera":50');
    await input.press('Enter');

    await expect.poll(() => store.patches.length).toBeGreaterThan(0);
    const body = store.patches[store.patches.length - 1];
    expect(body.owners).toEqual([{ resource: ANA_ID, units: 0.5 }]);
    expect(body.name).toBe('Review the estimates');
  });

  test('an unmatched name still commits the row and is underlined, not dropped', async ({
    page,
  }) => {
    const store = await setup(page);
    await page.goto(SCHEDULE_URL);

    const input = await editName(page);
    await input.fill('Draft plan @nobody');
    await input.press('Enter');

    await expect.poll(() => store.patches.length).toBeGreaterThan(0);
    const body = store.patches[store.patches.length - 1];
    // The row commits with the literal text intact and no owners — never a silent drop.
    expect(body.name).toBe('Draft plan @nobody');
    expect(body).not.toHaveProperty('owners');
    await expect(page.getByLabel('@nobody — unresolved')).toBeVisible();
  });

  test('an @ inside a word does not summon the picker', async ({ page }) => {
    await setup(page);
    await page.goto(SCHEDULE_URL);

    const input = await editName(page);
    await input.fill('Email ana@example');
    await expect(page.getByRole('listbox', { name: 'Assign owner' })).toHaveCount(0);
  });
});

test.describe('@owner token — the assignment reaches the heat map', () => {
  test('a person assigned by token shows on the resource heat map', async ({ page }) => {
    const store = await setup(page);

    // The heat map is built from what the PATCH actually carried. Writing `assignee`
    // instead of `owners` yields an empty grid here — which is precisely the silent
    // zero-capacity failure this issue exists to prevent.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/resources/heatmap/**`, (route) => {
      const assigned = store.patches.flatMap(
        (p) => (p.owners ?? []) as { resource: string; units: number }[],
      );
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          weeks: ['2026-W15', '2026-W16', '2026-W17', '2026-W18'],
          resources: assigned.map((o) => ({
            id: o.resource,
            name: 'Ana Rivera',
            initials: 'AR',
            job_role: 'Analyst',
            color: '#3E8C6D',
            calendar_differs_from_project: false,
            util: [Math.round(o.units * 100), 0, 0, 0],
          })),
        }),
      });
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/resources/summary/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          avg_utilization_pct: 100,
          over_allocated_count: 0,
          over_allocated_weeks: '',
          under_utilized_count: 0,
          under_utilized_names: [],
          headcount: 1,
          contractor_count: 0,
        }),
      }),
    );

    await page.goto(SCHEDULE_URL);
    const input = await editName(page);
    await input.fill('Draft migration plan @an');
    await page
      .getByRole('listbox', { name: 'Assign owner' })
      .getByRole('option', { name: /Ana Rivera/ })
      .click();
    // The pick completes the token; Enter is what commits the row (#2722).
    await input.press('Enter');
    await expect.poll(() => store.patches.length).toBeGreaterThan(0);

    await page.goto(`/projects/${PROJECT_ID}/resources/heatmap`);
    const grid = page.getByRole('grid', { name: 'Resource utilization heatmap' });
    await expect(grid).toBeVisible({ timeout: 15_000 });
    await expect(grid.getByText('Ana Rivera')).toBeVisible();
  });
});
