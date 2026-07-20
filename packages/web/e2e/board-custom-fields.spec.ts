/**
 * Custom-field values on board cards (#2144, ADR-0528, web-rule 271).
 *
 * Golden path: a field flagged `show_on_card` renders its value as a type-aware mark
 * on the card face; a card with more than three populated flagged fields folds the rest
 * behind a "+N more" tap-to-peek disclosure (CardPeekButton, web-rule 256).
 *
 * Mock discipline (CLAUDE.md): the board now reads the field DEFINITIONS from
 * GET /projects/:id/fields/ (a BARE array — not paginated), so the catch-all's
 * {count,results} object shape would break useProjectCustomFields. We mock /fields/
 * explicitly (registered after setup so it wins). Values ride each task's `custom_fields`
 * map from /tasks/. Card interactions gate on a "board rendered" signal first.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-board-cf-0000-0000-0000-000000002144';
const ROUTE = `/projects/${FIXTURE_PROJECT_ID}/board`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Custom Fields Test',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

// Five flagged (show_on_card) definitions, ordered — a rich card populates all five,
// so the comfortable card shows 3 inline (Env, Sev, Cost) + "+2 more" (Client, Reviewer).
const FIXTURE_FIELDS = [
  {
    id: 'f-env',
    name: 'Env',
    field_type: 'SINGLE_SELECT',
    required: false,
    order: 0,
    show_on_card: true,
    server_version: 1,
    options: [
      { value: 'prod', label: 'Prod', color: '#2F6FD1' },
      { value: 'staging', label: 'Staging', color: '#D97706' },
    ],
  },
  {
    id: 'f-sev',
    name: 'Sev',
    field_type: 'SINGLE_SELECT',
    required: false,
    order: 1,
    show_on_card: true,
    server_version: 1,
    options: [
      { value: 'low', label: 'Low', color: '#6B7585' },
      { value: 'high', label: 'High', color: '#B91C1C' },
    ],
  },
  {
    id: 'f-cost',
    name: 'Cost',
    field_type: 'NUMBER',
    required: false,
    order: 2,
    show_on_card: true,
    server_version: 1,
    options: [],
  },
  {
    id: 'f-client',
    name: 'Client',
    field_type: 'TEXT',
    required: false,
    order: 3,
    show_on_card: true,
    server_version: 1,
    options: [],
  },
  {
    id: 'f-rev',
    name: 'Reviewer',
    field_type: 'USER',
    required: false,
    order: 4,
    show_on_card: true,
    server_version: 1,
    options: [],
  },
];

function leaf(id: string, name: string, wbs: string, customFields: Record<string, unknown>) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-01-05',
    early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'cf-1',
    status: 'NOT_STARTED',
    assignments: [],
    labels: [],
    custom_fields: customFields,
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  };
}

const FIXTURE_TASKS = [
  {
    id: 'cf-1',
    wbs_path: '1',
    name: 'Delivery Phase',
    early_start: '2026-01-05',
    early_finish: '2026-02-14',
    planned_start: '2026-01-05',
    duration: 30,
    percent_complete: 20,
    is_critical: false,
    is_milestone: false,
    is_summary: true,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignments: [],
    labels: [],
    custom_fields: {},
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  leaf('cf-2', 'Rich Card', '1.1', {
    'f-env': 'staging',
    'f-sev': 'high',
    'f-cost': 1240,
    'f-client': 'Northwind Retail',
    'f-rev': { id: 'u1', name: 'Aisha Bello', initials: 'AB' },
  }),
  leaf('cf-3', 'Plain Card', '1.2', {}),
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
  });
  // /fields/ is a BARE array — mock it explicitly (wins over the catch-all object shape).
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/fields/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_FIELDS),
    }),
  );
}

function card(page: import('@playwright/test').Page, name: string) {
  return page.getByRole('button', { name: new RegExp(`^${name}, \\d`) });
}

test.describe('Board custom-field marks (#2144)', () => {
  test('renders flagged field values on a card and folds overflow behind a peek', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(ROUTE);

    // Board rendered signal.
    await expect(card(page, 'Rich Card')).toBeVisible({ timeout: 10_000 });
    await expect(card(page, 'Plain Card')).toBeVisible();

    // The first three flagged fields (by order) render inline on the rich card.
    await expect(page.getByLabel('Env: Staging')).toBeVisible();
    await expect(page.getByLabel('Sev: High')).toBeVisible();
    await expect(page.getByLabel('Cost: 1,240')).toBeVisible();

    // The remaining two fold behind a "+2 more" disclosure — not inline.
    await expect(page.getByText('Northwind Retail')).toHaveCount(0);
    const moreTrigger = page.getByRole('button', { name: '2 more custom fields' });
    await expect(moreTrigger).toBeVisible();

    // Tapping the peek reveals the hidden fields in a role=note popover.
    await moreTrigger.click();
    const peek = page.getByRole('note', { name: 'Custom fields' });
    await expect(peek).toBeVisible();
    await expect(peek.getByText('Northwind Retail')).toBeVisible();
    await expect(peek.getByText('Aisha')).toBeVisible();

    // A card with no populated custom fields shows no field band (no stray marks).
    await expect(page.getByLabel('Env: Staging')).toHaveCount(1);
  });
});
