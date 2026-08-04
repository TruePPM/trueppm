/**
 * Inline authoring tokens in the schedule row editor (#2722).
 *
 * The acceptance flow: type one row carrying four tokens, commit it, and confirm
 * every field the tokens named reached the server — plus the two behaviors that make
 * the grammar usable rather than a memory test. A token that resolves to nothing must
 * not block the commit, and a picker must be dismissible without eating the text.
 *
 * The grammar itself (every token, every invalid form, the milestone/mode conflict,
 * lag and dependency-type cycling) is exercised at the vitest layer, where it can be
 * asserted without network coupling — see `buildMode/authoringTokens.test.ts`.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-tok-00000000-0000-0000-0000-000000002722';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Token Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function task(id: string, wbs: string, name: string, isSummary = false) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: isSummary,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  };
}

const FIXTURE_TASKS = [
  task('tk1', '1', 'Discovery', true),
  task('tk2', '2', 'Survey'),
  task('tk3', '3', 'Draft row'),
];

const ANA = { id: 'res-ana', name: 'Ana Rivera' };

async function enableBuildMode(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm.featureFlags',
      JSON.stringify({ schedule_build_mode_v1: true }),
    );
  });
}

/**
 * The roster the `@owner` picker resolves against. The catch-all returns an empty
 * list here, which reads as "no roster" and silently disables the token — the
 * object-vs-list trap the catch-all rule warns about.
 */
async function mockRoster(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/project-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 'pr-ana',
            project: FIXTURE_PROJECT_ID,
            resource: ANA.id,
            resource_detail: {
              id: ANA.id,
              name: ANA.name,
              email: 'ana@example.test',
              job_role: '',
              max_units: '1.00',
              calendar: null,
              skills: [],
            },
            role_title: '',
            units_override: null,
            effective_max_units: '1.00',
            notes: '',
          },
        ],
      }),
    }),
  );
}

test.describe('Inline authoring tokens', () => {
  test.beforeEach(async ({ page }) => {
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
    await mockRoster(page);
  });

  test('a row typed with four tokens commits every field they name', async ({ page }) => {
    const patches: Record<string, unknown>[] = [];
    const reparents: Record<string, unknown>[] = [];
    const deps: Record<string, unknown>[] = [];

    // `parent` and `predecessors` are NOT writable on the task serializer, so
    // asserting them on the PATCH body would pass while the feature did nothing.
    // Each has its own endpoint, and that is what this asserts.
    await page.route('**/api/v1/projects/*/tasks/tk3/reparent/', async (route) => {
      reparents.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: 1, warning: null }),
      });
    });
    await page.route('**/api/v1/dependencies/', async (route) => {
      if (route.request().method() === 'POST') {
        deps.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'dep1' }),
        });
        return;
      }
      await route.fallback();
    });
    await page.route('**/api/v1/tasks/tk3/', async (route) => {
      if (route.request().method() === 'PATCH') {
        patches.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...FIXTURE_TASKS[2], name: 'Wireframes' }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto(BASE_URL);
    await expect(page.getByText('Draft row')).toBeVisible();

    // Enter the Name cell of the third row.
    await page.getByText('Draft row').click();
    await page.keyboard.press('F2');
    const input = page.getByRole('textbox', { name: /Rename task Draft row/ });
    await expect(input).toBeVisible();

    await input.fill('Wireframes #5d @ana >2 [Discovery]');
    await page.keyboard.press('Enter');

    await expect.poll(() => patches.length).toBeGreaterThan(0);
    const patch = patches[0];
    // The tokens are stripped from the committed name...
    expect(patch.name).toBe('Wireframes');
    // ...and each one lands on the field it named.
    expect(patch.duration).toBe(5);
    expect(patch.owners).toEqual([{ resource: ANA.id, units: 1 }]);
    // These two never ride the PATCH — the serializer would drop them silently.
    expect(patch.parent).toBeUndefined();
    expect(patch.predecessors).toBeUndefined();

    await expect.poll(() => reparents.length).toBeGreaterThan(0);
    expect(reparents[0]).toEqual({ new_parent_id: 'tk1' });

    await expect.poll(() => deps.length).toBeGreaterThan(0);
    expect(deps[0]).toMatchObject({
      predecessor: 'tk2',
      successor: 'tk3',
      dep_type: 'FS',
      lag: 0,
    });
  });

  test('an unresolvable token does not block the commit', async ({ page }) => {
    const patches: Record<string, unknown>[] = [];
    await page.route('**/api/v1/tasks/tk3/', async (route) => {
      if (route.request().method() === 'PATCH') {
        patches.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...FIXTURE_TASKS[2], name: 'Wireframes @nobody' }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto(BASE_URL);
    await expect(page.getByText('Draft row')).toBeVisible();
    await page.getByText('Draft row').click();
    await page.keyboard.press('F2');
    const input = page.getByRole('textbox', { name: /Rename task Draft row/ });
    await input.fill('Wireframes #5d @nobody');
    await page.keyboard.press('Enter');

    await expect.poll(() => patches.length).toBeGreaterThan(0);
    const patch = patches[0];
    // The row still commits, the resolvable token still applies, and the token that
    // matched nobody stays in the name verbatim rather than being dropped.
    expect(patch.duration).toBe(5);
    expect(patch.name).toBe('Wireframes @nobody');
    expect(patch.owners).toBeUndefined();
  });

  test('the owner picker opens on @ and Esc dismisses it without eating the text', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Draft row')).toBeVisible();
    await page.getByText('Draft row').click();
    await page.keyboard.press('F2');
    const input = page.getByRole('textbox', { name: /Rename task Draft row/ });

    await input.fill('Wireframes @an');
    const picker = page.getByRole('listbox', { name: 'Assign owner' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('option', { name: /Ana Rivera/ })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    // Esc dismisses the popover only — the draft is deliberately untouched, because
    // the author may have typed something the picker could not offer.
    await expect(input).toHaveValue('Wireframes @an');
  });

  test('the / command menu lists the tokens and inserts the one you choose', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Draft row')).toBeVisible();
    await page.getByText('Draft row').click();
    await page.keyboard.press('F2');
    const input = page.getByRole('textbox', { name: /Rename task Draft row/ });

    await input.fill('Wireframes /');
    const menu = page.getByRole('listbox', { name: 'Insert' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('option', { name: /Set duration/ })).toBeVisible();
    await expect(menu.getByRole('option', { name: /Assign owner/ })).toBeVisible();

    // Choosing a command inserts its sigil and hands over to that token's picker —
    // it never completes a value on its own.
    await menu.getByRole('option', { name: /Assign owner/ }).click();
    await expect(input).toHaveValue('Wireframes @');
    await expect(page.getByRole('listbox', { name: 'Assign owner' })).toBeVisible();
  });
});
