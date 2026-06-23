import { test, expect } from '@playwright/test';

/**
 * Project Settings → Workflow E2E (#521).
 *
 * Verifies the page is wired to the real /phases/, /board-config/, and
 * /fields/ endpoints — the stub PHASES / STATUSES / FIELDS arrays are gone:
 * - Phases list renders from GET /phases/ and "+ Add phase" POSTs it.
 * - Status visibility toggle issues a PUT /board-config/.
 * - "+ New field" opens a modal whose Add button POSTs to /fields/.
 * - The stub banner is no longer rendered.
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-workflow-00000000-0000-0000-0000-000000000521';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Atlas Migration',
  description: 'Original description.',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
  agile_features: false,
  methodology: 'HYBRID',
  board_cadence: 'sprint',
};

const FIXTURE_PHASE_ENG = {
  id: 'phase-eng',
  name: 'Engineering',
  color: '#3E8C6D',
  priority_rank: 10,
  wbs_path: '1',
  task_count: 12,
  server_version: 1,
};

const FIXTURE_PHASE_BUILD = {
  id: 'phase-build',
  name: 'Build',
  color: '#7C3AED',
  priority_rank: 20,
  wbs_path: '2',
  task_count: 5,
  server_version: 1,
};

// Default 5-column board config — matches the hardcoded fallback in
// useBoardConfig.ts when a project has no saved row.
const FIXTURE_BOARD_COLUMNS = [
  { status: 'BACKLOG', label: 'Backlog', visible: true, color: '#94A3B8', wip_limit: null },
  { status: 'NOT_STARTED', label: 'To Do', visible: true, color: '#64748B', wip_limit: null },
  {
    status: 'IN_PROGRESS',
    label: 'In Progress',
    visible: true,
    color: '#3B82F6',
    wip_limit: 5,
  },
  { status: 'REVIEW', label: 'Review', visible: true, color: '#A855F7', wip_limit: 3 },
  { status: 'COMPLETE', label: 'Done', visible: true, color: '#22C55E', wip_limit: null },
];

const FIXTURE_FIELD_VENDOR = {
  id: 'field-vendor',
  name: 'Vendor',
  field_type: 'SINGLE_SELECT',
  required: false,
  options: [{ value: 'siemens', label: 'Siemens', color: null }],
  order: 1,
  server_version: 1,
  created_at: '2026-05-21T00:00:00Z',
  updated_at: '2026-05-21T00:00:00Z',
};

const ADMIN_MEMBERSHIP = {
  id: 'mem-self',
  server_version: 1,
  project: PROJECT_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 300, // ADMIN
  role_label: 'Project Admin',
};

type Page = import('@playwright/test').Page;

interface Captures {
  phaseCreate?: Record<string, unknown>;
  boardConfigPut?: Record<string, unknown>;
  fieldCreate?: Record<string, unknown>;
  projectPatch?: Record<string, unknown>;
}

async function setup(page: Page, captures: Captures) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const pj = (data: unknown) => JSON.stringify(data);

  // Catch-all — returns [] so the page can mount without 404s for surfaces
  // we don't care about (presence, attention, my-tasks, notifications, …).
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [FIXTURE_PROJECT], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, async (route) => {
    if (route.request().method() === 'PATCH') {
      captures.projectPatch = (await route.request().postDataJSON()) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...FIXTURE_PROJECT, ...captures.projectPatch }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) });
  });

  // useCurrentUserRole hits /members/?self=true — admin so all edit controls show.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([ADMIN_MEMBERSHIP]) }),
  );

  // Phases — GET returns two, POST captures the body.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/phases/`, async (route) => {
    if (route.request().method() === 'POST') {
      captures.phaseCreate = (await route.request().postDataJSON()) as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: pj({
          id: 'phase-new',
          name: (captures.phaseCreate?.name as string) ?? 'New phase',
          color: (captures.phaseCreate?.color as string | null) ?? null,
          priority_rank: 30,
          wbs_path: '3',
          task_count: 1,
          server_version: 1,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([FIXTURE_PHASE_ENG, FIXTURE_PHASE_BUILD]),
    });
  });

  // Board config — GET returns defaults, PUT captures the payload.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/board-config/`, async (route) => {
    if (route.request().method() === 'PUT') {
      captures.boardConfigPut = (await route.request().postDataJSON()) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(captures.boardConfigPut),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ columns: FIXTURE_BOARD_COLUMNS }),
    });
  });

  // Custom fields — GET returns one, POST captures the body.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/fields/`, async (route) => {
    if (route.request().method() === 'POST') {
      captures.fieldCreate = (await route.request().postDataJSON()) as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: pj({
          id: 'field-new',
          name: (captures.fieldCreate?.name as string) ?? 'New field',
          field_type: (captures.fieldCreate?.field_type as string) ?? 'TEXT',
          required: (captures.fieldCreate?.required as boolean) ?? false,
          options: (captures.fieldCreate?.options as unknown[]) ?? [],
          order: 2,
          server_version: 1,
          created_at: '2026-05-21T00:00:00Z',
          updated_at: '2026-05-21T00:00:00Z',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([FIXTURE_FIELD_VENDOR]),
    });
  });
}

test.describe('Project Settings → Workflow (#521)', () => {
  test('renders phases, statuses, and custom fields from the API (no stub banner)', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/workflow`);

    await expect(page.getByRole('heading', { name: /^Workflow & fields/ })).toBeVisible();

    // Phases from the API — locate by the rename button to avoid colliding with
    // the build-version footer that includes the word "Build".
    const phasesSection = page.getByRole('region', { name: /Phases/i });
    await expect(phasesSection.getByRole('button', { name: 'Engineering', exact: true })).toBeVisible();
    await expect(phasesSection.getByRole('button', { name: 'Build', exact: true })).toBeVisible();
    await expect(phasesSection.getByText(/12 tasks/)).toBeVisible();

    // Statuses from the board config defaults. The status enum name (BACKLOG)
    // and label (Backlog) both appear in each row, so locate via the rename
    // button which carries only the label.
    const statusesSection = page.getByRole('region', { name: /Statuses/i });
    await expect(statusesSection.getByRole('button', { name: 'Backlog', exact: true })).toBeVisible();
    await expect(statusesSection.getByRole('button', { name: 'In Progress', exact: true })).toBeVisible();

    // Custom fields list — built-ins above, dynamic below.
    const fieldsSection = page.getByRole('region', { name: /Fields/i });
    await expect(fieldsSection.getByText('Phase')).toBeVisible(); // built-in
    await expect(fieldsSection.getByText('Vendor')).toBeVisible(); // dynamic

    // Stub banner must not render once this section is wired. Scope to the
    // Workflow section: the consolidated page (ADR-0146) mounts every section,
    // and unmocked sibling sections render their own stub banners.
    await expect(
      page.locator('[data-settings-section="workflow"]').getByTestId('stub-page-banner'),
    ).toHaveCount(0);
  });

  test('+ Add phase POSTs to /phases/ with the default name', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/workflow`);

    await page.getByRole('button', { name: /\+ Add phase/i }).click();
    await expect.poll(() => captures.phaseCreate).toEqual(
      expect.objectContaining({ name: 'New phase' }),
    );
  });

  test('Hide column toggle issues a PUT /board-config/ with visible=false', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/workflow`);

    const statusesSection = page.getByRole('region', { name: /Statuses/i });
    await statusesSection.getByRole('button', { name: /Hide column/i }).first().click();

    await expect.poll(() => captures.boardConfigPut).toBeTruthy();
    const cols = (captures.boardConfigPut?.columns as Array<Record<string, unknown>>) ?? [];
    const backlog = cols.find((c) => c.status === 'BACKLOG');
    expect(backlog?.visible).toBe(false);
  });

  test('+ New field opens a modal and POSTs a TEXT field on Add', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/workflow`);

    await page.getByRole('button', { name: /\+ New field/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('textbox').first().fill('Compliance gate');
    await dialog.getByRole('button', { name: /Add field/i }).click();

    await expect.poll(() => captures.fieldCreate).toEqual(
      expect.objectContaining({
        name: 'Compliance gate',
        field_type: 'TEXT',
        required: false,
      }),
    );
  });

  test('SINGLE_SELECT without options keeps the Add button disabled', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/workflow`);

    await page.getByRole('button', { name: /\+ New field/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').first().fill('Vendor');
    await dialog.getByRole('combobox').selectOption('SINGLE_SELECT');
    await expect(dialog.getByRole('button', { name: /Add field/i })).toBeDisabled();
  });

  // Board cadence picker (#410, ADR-0161)
  test('selecting Continuous flow PATCHes board_cadence=continuous', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/workflow`);

    const cadence = page.getByRole('region', { name: /Board cadence/i });
    await expect(cadence.getByRole('radio', { name: /Sprint-based/i })).toBeVisible();
    await cadence.getByRole('radio', { name: /Continuous flow/i }).click();

    await expect.poll(() => captures.projectPatch).toEqual(
      expect.objectContaining({ board_cadence: 'continuous' }),
    );
  });

  // Per-column aging threshold (#410, ADR-0161)
  test('setting a per-column age limit PUTs board-config with age_threshold_days', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/workflow`);

    const statusesSection = page.getByRole('region', { name: /Statuses/i });
    const ageInput = statusesSection.getByRole('spinbutton', {
      name: /Age limit in days for Backlog/i,
    });
    await ageInput.fill('6');
    await ageInput.blur();

    await expect.poll(() => captures.boardConfigPut).toBeTruthy();
    const cols = (captures.boardConfigPut?.columns as Array<Record<string, unknown>>) ?? [];
    expect(cols.find((c) => c.status === 'BACKLOG')?.age_threshold_days).toBe(6);
  });
});
