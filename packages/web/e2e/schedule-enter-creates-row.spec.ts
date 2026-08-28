/**
 * The `Enter creates a new row` outline preference (#3079).
 *
 * Since #1666 a plain Enter commits the row AND inserts a sibling below it. That
 * is the right default for rapid sequence entry — it is the spreadsheet motion the
 * outline is built around — and the wrong one for the other job: renaming rows
 * that already exist. Every commit spawned a blank row that then had to be
 * deleted, which a user testing the live outline reported.
 *
 * Why a browser. The preference gates a `keydown` handler that a real key press
 * routes through `EditableCell` → `onEnterCommit`; a jsdom `fireEvent` reaches the
 * same handler but not the same commit-then-continue sequence, so "the edit still
 * committed" and "no row was created" are only jointly observable here — and it is
 * their conjunction that is the feature. The unit specs pin each half separately.
 *
 * Seeded through `localStorage` per the fixture's contract ("this planner turned it
 * on last week"); `schedule-display-menu.spec` owns the toggle itself.
 */
import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll, setupScheduleDisplayOptions } from './fixtures';

const PROJECT_ID = 'e2e-enter-0000-0000-0000-000000003079';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Enter Preference Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
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
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    ...over,
  };
}

const TASKS = [
  row({ id: 'phase', wbs_path: '1', name: 'Design Phase', is_summary: true, duration: 12 }),
  row({ id: 'task-a', wbs_path: '1.1', name: 'Wireframes', parent_id: 'phase' }),
  row({ id: 'task-b', wbs_path: '1.2', name: 'Mockups', parent_id: 'phase' }),
];

interface Captured {
  posts: Array<Record<string, unknown>>;
  patches: Array<Record<string, unknown>>;
}

async function setup(
  page: import('@playwright/test').Page,
  { enterCreatesRow }: { enterCreatesRow: boolean },
): Promise<Captured> {
  const captured: Captured = { posts: [], patches: [] };
  const live = TASKS.map((t) => ({ ...t }));

  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: live });
  await setupScheduleDisplayOptions(page, PROJECT_ID, { enterCreatesRow });

  // Stateful, and registered after setupApiMocks so it wins (LIFO). A rename has
  // to read back under its new name or the assertion below would be asserting the
  // optimistic paint rather than the committed value.
  await page.route('**/api/v1/tasks/**', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      captured.posts.push(body);
      const id = `new-${captured.posts.length}`;
      const created = typeof body.name === 'string' ? body.name : '';
      live.push(row({ id, wbs_path: `1.${live.length}`, name: created, parent_id: 'phase' }));
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id, name: created, project: PROJECT_ID, duration: 1 }),
      });
      return;
    }
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Record<string, unknown>;
      captured.patches.push(body);
      const id = req.url().split('/').filter(Boolean).pop();
      const hit = live.find((t) => t.id === id);
      if (hit && typeof body.name === 'string') hit.name = body.name;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...(hit ?? {}), ...body }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: live.length, next: null, previous: null, results: live }),
    });
  });

  return captured;
}

const nameInput = (page: import('@playwright/test').Page) =>
  page.locator('input[aria-label^="Rename item"]');

test.describe('Enter creates a new row — preference OFF (#3079)', () => {
  test('committing a rename does not spawn a blank row', async ({ page }) => {
    const captured = await setup(page, { enterCreatesRow: false });
    await page.goto(BASE_URL);
    await expect(page.getByText('Wireframes').first()).toBeVisible();

    await page.getByText('Wireframes').first().click();
    await page.keyboard.press('F2');
    await expect(nameInput(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Wireframes v2');
    await page.keyboard.press('Enter');

    // The edit commits — the half the preference must not touch.
    await expect.poll(() => captured.patches.length).toBe(1);
    expect(captured.patches[0]).toMatchObject({ name: 'Wireframes v2' });
    // ...and nothing was created. This is the whole report.
    expect(captured.posts).toHaveLength(0);
  });

  test('Enter on a focused row opens that row’s name cell instead of making one', async ({
    page,
  }) => {
    const captured = await setup(page, { enterCreatesRow: false });
    await page.goto(BASE_URL);
    await expect(page.getByText('Wireframes').first()).toBeVisible();

    await page.getByText('Wireframes').first().click();
    await page.keyboard.press('Enter');

    // "Enter always ends with the cursor in an editable Name cell" is the one
    // mental model the outline states. Turning row creation off must not break it.
    await expect(nameInput(page)).toBeVisible();
    await expect(nameInput(page)).toHaveValue('Wireframes');
    expect(captured.posts).toHaveLength(0);
  });

  test('Shift+Enter still inserts — a modifier is an explicit insert gesture', async ({ page }) => {
    const captured = await setup(page, { enterCreatesRow: false });
    await page.goto(BASE_URL);
    await expect(page.getByText('Mockups').first()).toBeVisible();

    await page.getByText('Mockups').first().click();
    await page.keyboard.press('Shift+Enter');

    await expect.poll(() => captured.posts.length).toBe(1);
  });
});

test.describe('Enter creates a new row — preference ON, the default (#1666)', () => {
  test('Enter still commits and inserts a sibling below', async ({ page }) => {
    const captured = await setup(page, { enterCreatesRow: true });
    await page.goto(BASE_URL);
    await expect(page.getByText('Wireframes').first()).toBeVisible();

    await page.getByText('Wireframes').first().click();
    await page.keyboard.press('Enter');

    await expect.poll(() => captured.posts.length).toBe(1);
    expect(captured.posts[0]).toMatchObject({ parent_id: 'phase' });
  });
});
