/**
 * Relative task links — drawer "Related tasks" section (#2068).
 *
 * Golden path: open a task drawer, open the Related-links picker, search a
 * sibling-project task, pick it with a relation type, and see the grouped row
 * appear; clicking the row navigates to the cross-project task detail.
 * Edge: removing a relation via the × control empties the section.
 *
 * The /api/v1/task-relations/ backend ships in a separate MR, so every endpoint
 * this UI reads is mocked here with its real shape (this UI is a pure consumer).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROGRAM_ID = 'e2e-prog-00000000-0000-0000-0000-000000002068';
const PROJECT_ID = 'e2e-rel-00000000-0000-0000-0000-000000002068';
const TASK_ID = 't1';
const SIBLING_PROJECT_ID = 'e2e-sib-00000000-0000-0000-0000-000000002068';
const SIBLING_TASK_ID = 'tsib';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Relations Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    // Non-null program → the picker's Program scope + task-search endpoint light up.
    program: PROGRAM_ID,
  },
];

const FIXTURE_TASKS = [
  {
    id: TASK_ID,
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
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
];

interface RelationCardWire {
  id: string;
  title: string;
  hex_id: string;
  project_id: string;
  project_name: string;
  is_milestone: boolean;
  early_start: string | null;
  early_finish: string | null;
  is_critical: boolean;
}

interface RelationWire {
  id: string;
  source: string;
  target: string;
  relation_type: string;
  note: string;
  created_by: string | null;
  created_at: string;
  source_card: RelationCardWire | null;
  target_card: RelationCardWire | null;
}

const SIBLING_CARD: RelationCardWire = {
  id: SIBLING_TASK_ID,
  title: 'Sibling Task',
  hex_id: '00A3F',
  project_id: SIBLING_PROJECT_ID,
  project_name: 'Sibling Project',
  is_milestone: false,
  early_start: '2026-05-01',
  early_finish: '2026-05-04',
  is_critical: false,
};

/** Stub the /task-relations/ endpoints with a stateful in-memory array. */
async function stubRelations(page: Page, initial: RelationWire[] = []): Promise<void> {
  let relations: RelationWire[] = JSON.parse(JSON.stringify(initial));

  // GET list (with ?task=) + POST create. Registered FIRST so the more specific
  // id route below wins for DELETE/PATCH paths (Playwright: last-registered wins).
  await page.route('**/api/v1/task-relations/**', (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        source: string;
        target: string;
        relation_type: string;
      };
      const row: RelationWire = {
        id: `rel-${relations.length + 1}`,
        source: body.source,
        target: body.target,
        relation_type: body.relation_type,
        note: '',
        created_by: 'e2e-user',
        created_at: new Date().toISOString(),
        source_card: null,
        // The picked task is cross-project, so the server returns its redacted card.
        target_card: body.target === SIBLING_TASK_ID ? SIBLING_CARD : null,
      };
      relations.push(row);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(row),
      });
    }
    const task = new URL(route.request().url()).searchParams.get('task');
    const results = relations.filter((r) => r.source === task || r.target === task);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(results),
    });
  });

  // DELETE/PATCH by id — registered AFTER the list route so it wins for id paths.
  await page.route('**/api/v1/task-relations/*/', (route) => {
    const method = route.request().method();
    const id = new URL(route.request().url()).pathname.match(/task-relations\/([^/]+)\//)?.[1];
    if (method === 'DELETE') {
      relations = relations.filter((r) => r.id !== id);
      return route.fulfill({ status: 204, body: '' });
    }
    if (method === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { note?: string };
      const row = relations.find((r) => r.id === id);
      if (row) row.note = body.note ?? row.note;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(row),
      });
    }
    return route.fallback();
  });

  // Program task-search — backs the picker's Program scope.
  await page.route('**/api/v1/programs/*/task-search/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: SIBLING_TASK_ID,
          name: 'Sibling Task',
          short_id: '00A3F',
          project_id: SIBLING_PROJECT_ID,
          project_name: 'Sibling Project',
        },
      ]),
    }),
  );
}

async function openRelatedSection(page: Page): Promise<Locator> {
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  const grid = page.getByRole('grid', { name: 'Task list' });
  await grid.getByText('Foundation', { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /Foundation/ }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  // Related tasks lives in the Details tab (default) as a collapsed accordion.
  const header = drawer.getByRole('button', { name: 'Related tasks' });
  await expect(header).toBeVisible();
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  const section = drawer.getByRole('region', { name: 'Related tasks' });
  await expect(section).toBeVisible();
  return section;
}

test.describe('Task relations (#2068)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('golden path: link a cross-project task, then navigate to it', async ({ page }) => {
    await stubRelations(page, []);
    const section = await openRelatedSection(page);

    // Empty state.
    await expect(section.getByText(/No related tasks\./i)).toBeVisible();

    // Open the picker (a modal dialog on top of the non-modal drawer).
    await section.getByRole('button', { name: 'Link task' }).click();
    const picker = page.getByRole('dialog', { name: /Link a task/ });
    await expect(picker).toBeVisible();

    // Choose the relation type + search the program for the sibling task.
    await picker.getByLabel('Relation').selectOption('blocks');
    await picker.getByLabel('Search tasks').fill('Sib');
    const option = picker.getByRole('option', { name: /Sibling Task/ });
    await expect(option).toBeVisible();
    await option.click();

    // The picker closes and the new row appears under the "Blocks" heading with
    // the cross-project project tag.
    await expect(picker).toBeHidden();
    const row = section.getByRole('button', { name: /Blocks.*Sibling Task/ });
    await expect(row).toBeVisible();
    // The inverse-aware heading and the cross-project tag both render.
    await expect(section.getByRole('heading', { name: 'Blocks' })).toBeVisible();
    await expect(section.getByText('Sibling Project')).toBeVisible();

    // Clicking the cross-project row navigates to its task detail page.
    await row.click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${SIBLING_PROJECT_ID}/tasks/${SIBLING_TASK_ID}`),
    );
  });

  test('edge: removing a relation empties the section', async ({ page }) => {
    await stubRelations(page, [
      {
        id: 'rel-1',
        source: TASK_ID,
        target: SIBLING_TASK_ID,
        relation_type: 'blocks',
        note: '',
        created_by: 'e2e-user',
        created_at: '2026-07-16T00:00:00Z',
        source_card: null,
        target_card: SIBLING_CARD,
      },
    ]);
    const section = await openRelatedSection(page);

    const row = section.getByRole('button', { name: /Blocks.*Sibling Task/ });
    await expect(row).toBeVisible();

    await section.getByRole('button', { name: 'Remove relation' }).click();

    await expect(row).toBeHidden();
    await expect(section.getByText(/No related tasks\./i)).toBeVisible();
  });
});
