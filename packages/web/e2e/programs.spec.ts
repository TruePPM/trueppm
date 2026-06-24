import { test, expect } from '@playwright/test';

/**
 * Programs E2E (#502, ADR-0070).
 *
 * Covers:
 *  - /programs empty state + "Create your first program" CTA opens the modal
 *  - Modal creates a program and navigates to /programs/{id}/projects
 *  - Members tab renders the auto-OWNER membership row
 *  - Backlog tab renders the backlog workspace (#742; detailed coverage lives
 *    in program-backlog.spec.ts)
 *  - Sidebar program scope picker lists the user's programs after creation (#959)
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000502';
const MEMBERSHIP_ID = 'e2e-prog-mem-alice';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Phase 2 Modernization',
  description: 'Q3 platform rebuild',
  methodology: 'HYBRID',
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Project Admin',
  project_count: 0,
  member_count: 1,
};

const FIXTURE_MEMBERSHIP = {
  id: MEMBERSHIP_ID,
  server_version: 1,
  program: PROGRAM_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 400,
  role_label: 'Project Admin',
};

// Default program rollup (#713). project_count > 0 with a mix of a count KPI,
// a health KPI, and a deferred KPI so the overview renders all three treatments.
const FIXTURE_ROLLUP = {
  aggregation_policy: 'worst',
  policy_available: true,
  project_count: 2,
  program_health: 'at_risk',
  kpis: {
    schedule_health: { available: true, value: 'at_risk' },
    critical_tasks: { available: true, value: 5 },
    cost_variance: { available: false, reason: 'no_cost_data' },
  },
};

type Page = import('@playwright/test').Page;

async function setup(page: Page, { existingPrograms = [] as (typeof FIXTURE_PROGRAM)[] } = {}) {
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

  const pj = (data: unknown) => JSON.stringify(data);
  let programs = [...existingPrograms];

  // Catch-all 401-guard (registered FIRST → lowest precedence; every specific
  // route below is more-recent and wins). Without it, any endpoint the shell
  // touches but this spec does not mock (notifications, presence, …) hits the
  // real network, 401s, and trips the session-expired modal — which then
  // intercepts pointer events and cascades into unrelated failures. Returns the
  // empty list shape; object endpoints the page reads are all mocked explicitly
  // below, so none fall through to this net.
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
  await page.route('**/api/v1/me/work/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], due_today_count: 0 }),
    }),
  );

  await page.route('**/api/v1/programs/', (r) => {
    if (r.request().method() === 'POST') {
      programs = [...programs, FIXTURE_PROGRAM];
      return r.fulfill({ status: 201, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: programs, count: programs.length, next: null, previous: null }),
    });
  });

  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/backlog-items/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([FIXTURE_MEMBERSHIP]),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ROLLUP) }),
  );
}

test.describe('Programs — empty state and creation', () => {
  test('shows hero empty state with CTA', async ({ page }) => {
    await setup(page);
    await page.goto('/programs');
    await expect(page.getByText(/Programs group related projects/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Create your first program/i })).toBeVisible();
  });

  test('create modal includes the cascading-access onboarding hint', async ({ page }) => {
    await setup(page);
    await page.goto('/programs');
    await page.getByRole('button', { name: /Create your first program/i }).click();
    await expect(
      page.getByText(/Project access is managed separately on each project/i),
    ).toBeVisible();
  });

  test('creating a program navigates to its Projects tab', async ({ page }) => {
    await setup(page);
    await page.goto('/programs');
    await page.getByRole('button', { name: /Create your first program/i }).click();
    await page.getByLabel(/^name/i).fill('Phase 2 Modernization');
    await page.getByRole('button', { name: /Create program/i }).click();
    await expect(page).toHaveURL(`/programs/${PROGRAM_ID}/projects`);
  });
});

test.describe('Programs — shell tabs', () => {
  // #790 / ADR-0095: program navigation lives in the global TopBar (mirroring
  // project ViewTabs) and now includes a discoverable Settings tab.
  test('program nav is in the top bar and includes a Settings tab', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/overview`);

    const nav = page.getByRole('navigation', { name: 'Program' });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: /Backlog/i })).toBeVisible();
    await nav.getByRole('link', { name: /Settings/i }).click();

    // Lands on the consolidated program settings page (ADR-0146; no per-section
    // route redirect anymore), and the Settings tab stays active there.
    await page.waitForURL(`**/programs/${PROGRAM_ID}/settings`);
    await expect(
      page.getByRole('navigation', { name: 'Program' }).getByRole('link', { name: /Settings/i }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('Backlog tab renders the backlog workspace (empty)', async ({ page }) => {
    // backlog-items is mocked to [] in setup(), so the workspace shows its
    // empty state. Populated behavior is covered in program-backlog.spec.ts.
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/backlog`);
    // exact: the empty-state h2 ("The program backlog is empty") also contains
    // "backlog", so a substring name match would resolve to two headings.
    await expect(page.getByRole('heading', { name: 'Backlog', exact: true })).toBeVisible();
    await expect(page.getByText('The program backlog is empty')).toBeVisible();
  });

  test('Projects tab shows empty state for an empty program', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    await expect(page.getByText(/No projects in this program yet/i)).toBeVisible();
    await expect(page.getByText(/These projects belong to the program/i)).toBeVisible();
  });

  test('Projects tab shows Add existing, Import, and New project buttons (admin)', async ({
    page,
  }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    // Scope to the toolbar so we don't hit the sidebar or empty-state copies.
    const toolbar = page.getByRole('toolbar', { name: /program projects actions/i });
    await expect(toolbar.getByRole('button', { name: /^New project$/i })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: /^Add existing$/i })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: /^Import$/i })).toBeVisible();
  });

  test('Import button creates a project assigned to the program', async ({ page }) => {
    const NEW_PROJECT_ID = 'e2e-imported-project-uuid-001';
    let sentProgramField = false;

    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });

    // The create-from-import endpoint returns the new project's id synchronously
    // (202); the caller then navigates to it (ADR-0092). Inspect the multipart
    // body to prove the import lands assigned to this program.
    await page.route('**/api/v1/projects/import/msproject/', (route) => {
      const body = route.request().postData() ?? '';
      sentProgramField = body.includes('name="program"') && body.includes(PROGRAM_ID);
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ project_id: NEW_PROJECT_ID, detail: 'Import queued.' }),
      });
    });

    // Stub the navigated-to project so the redirect doesn't 404.
    await page.route(`**/api/v1/projects/${NEW_PROJECT_ID}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: NEW_PROJECT_ID,
          server_version: 1,
          name: 'Imported Plan',
          description: '',
          start_date: '2026-05-18',
          methodology: 'HYBRID',
          program: PROGRAM_ID,
        }),
      }),
    );

    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    await page
      .getByRole('toolbar', { name: /program projects actions/i })
      .getByRole('button', { name: /^Import$/i })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Import a project' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Will be added to the/i)).toContainText(FIXTURE_PROGRAM.name);

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'plan.xml',
      mimeType: 'application/xml',
      buffer: Buffer.from('<Project><Tasks/></Project>'),
    });
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page).toHaveURL(`/projects/${NEW_PROJECT_ID}/overview`);
    expect(sentProgramField).toBe(true);
  });

  test('New project button creates a project assigned to the program', async ({ page }) => {
    const NEW_PROJECT_ID = 'e2e-new-project-uuid-0001';
    let capturedBody: Record<string, unknown> | null = null;

    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });

    // Override the default /projects/ stub so POST records the body and
    // returns a created project. GET continues to return an empty list —
    // navigation happens immediately so the cache invalidation is a follow-up.
    await page.route('**/api/v1/projects/', (r) => {
      if (r.request().method() === 'POST') {
        capturedBody = r.request().postDataJSON() as Record<string, unknown>;
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: NEW_PROJECT_ID,
            server_version: 1,
            name: capturedBody.name,
            description: capturedBody.description ?? '',
            start_date: capturedBody.start_date,
            calendar: null,
            methodology: capturedBody.methodology ?? 'HYBRID',
            program: capturedBody.program ?? null,
          }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [], count: 0, next: null, previous: null }),
      });
    });

    // Stub the project overview endpoints the navigated-to page will fetch
    // so the redirect doesn't 404 in the test environment.
    await page.route(`**/api/v1/projects/${NEW_PROJECT_ID}/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: NEW_PROJECT_ID,
          server_version: 1,
          name: 'Tower A Buildout',
          description: '',
          start_date: '2026-05-18',
          methodology: 'HYBRID',
          program: PROGRAM_ID,
        }),
      }),
    );

    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    // Scope to the toolbar so the sidebar's "New project" button (no programId) is not picked.
    await page
      .getByRole('toolbar', { name: /program projects actions/i })
      .getByRole('button', { name: /^New project$/i })
      .click();
    await page.getByLabel(/^name/i).fill('Tower A Buildout');
    await page.getByRole('button', { name: /next/i }).click(); // step 1 → 2
    await page.getByRole('button', { name: /next/i }).click(); // step 2 → 3
    await page.getByRole('button', { name: /create project/i }).click();

    await expect(page).toHaveURL(`/projects/${NEW_PROJECT_ID}/overview`);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.program).toBe(PROGRAM_ID);
    expect(capturedBody!.name).toBe('Tower A Buildout');
  });

  test('Members tab shows the auto-OWNER row', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/members`);
    const aliceRow = page.locator('li').filter({ hasText: 'alice' }).first();
    await expect(aliceRow).toBeVisible();
    await expect(aliceRow.getByText('(you)')).toBeVisible();
    // The role badge in the row uses the role label as exact text.
    await expect(aliceRow.getByText('Project Admin', { exact: true })).toBeVisible();
  });
});

test.describe('Programs — overview rollup (#713)', () => {
  test('Overview is the default landing tab and renders the health hero', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    // Bare program URL redirects to the Overview tab (router index Navigate).
    await page.goto(`/programs/${PROGRAM_ID}`);
    await expect(page).toHaveURL(`/programs/${PROGRAM_ID}/overview`);
    await expect(page.getByLabel('Program health: At risk')).toBeVisible();
    await expect(page.getByText('Worst-case across 2 projects')).toBeVisible();
  });

  test('renders enabled KPI values and a deferred KPI with its reason', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/overview`);
    const kpis = page.getByRole('region', { name: /program kpis/i });
    await expect(kpis.getByText('5')).toBeVisible(); // critical_tasks
    await expect(kpis.getByText('At risk')).toBeVisible(); // schedule_health band
    // Deferred KPI is shown with its reason, not hidden.
    await expect(kpis.getByText('Cost variance')).toBeVisible();
    await expect(kpis.getByText('Needs cost data')).toBeVisible();
  });

  test('shows the empty state when the program has no projects', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          aggregation_policy: 'worst',
          policy_available: true,
          project_count: 0,
          program_health: 'unknown',
          kpis: {},
        }),
      }),
    );
    await page.goto(`/programs/${PROGRAM_ID}/overview`);
    await expect(page.getByText('No projects in this program yet.')).toBeVisible();
  });
});

test.describe('Programs — ungrouped projects (#697, ADR-0171)', () => {
  const STANDALONE_ID = 'e2e-standalone-uuid-00000697';

  const FIXTURE_UNGROUPED = {
    id: STANDALONE_ID,
    name: 'Neptune Cryo Rig',
    code: 'NEP',
    health: 'ON_TRACK',
    percent_complete: 38,
    member_count: 4,
  };

  test('renders the ungrouped section below the program cards', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    // The ungrouped GET carries a query string the setup `**/projects/` glob
    // does not match — a regex route handles it and takes precedence.
    await page.route(/\/api\/v1\/projects\/\?.*program__isnull=true/, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [FIXTURE_UNGROUPED],
          count: 1,
          next: null,
          previous: null,
        }),
      }),
    );

    await page.goto('/programs');
    await expect(page.getByRole('heading', { name: /^Ungrouped projects$/i })).toBeVisible();
    await expect(page.getByText('1 need a home')).toBeVisible();
    const row = page.getByRole('listitem').filter({ hasText: 'Neptune Cryo Rig' });
    await expect(row).toBeVisible();
    await expect(row.getByText('NEP', { exact: true })).toBeVisible();
    await expect(row.getByText('38%')).toBeVisible();
    await expect(row.getByText('4 members')).toBeVisible();
  });

  test('moves a standalone project into a program, then the section self-hides', async ({
    page,
  }) => {
    let ungrouped: Array<typeof FIXTURE_UNGROUPED> = [FIXTURE_UNGROUPED];
    let patchedProgram: unknown = null;

    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.route(/\/api\/v1\/projects\/\?.*program__isnull=true/, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: ungrouped,
          count: ungrouped.length,
          next: null,
          previous: null,
        }),
      }),
    );
    await page.route(`**/api/v1/projects/${STANDALONE_ID}/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchedProgram = (r.request().postDataJSON() as Record<string, unknown>).program;
        ungrouped = []; // now grouped → drops out of the ungrouped list
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: STANDALONE_ID, server_version: 2, program: PROGRAM_ID }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: STANDALONE_ID }),
      });
    });

    await page.goto('/programs');
    const row = page.getByRole('listitem').filter({ hasText: 'Neptune Cryo Rig' });
    await row.getByRole('button', { name: /Move to program/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: /Phase 2 Modernization/i }).click();
    await dialog.getByRole('button', { name: /^Move project$/i }).click();

    // Dialog closes and the section self-hides once the list is empty.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Ungrouped projects$/i })).toHaveCount(0);
    expect(patchedProgram).toBe(PROGRAM_ID);
  });
});

test.describe('Programs — sidebar entry', () => {
  test('the v2 rail lists the program in the Programs tree after creation', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    const sidebar = page.locator('aside[aria-label="Primary navigation"]');
    await expect(sidebar).toBeVisible();
    // The #959 scope picker was replaced by the v2 rail's Programs tree — the
    // program is a row (its name is the open button's accessible name).
    await expect(
      sidebar.getByRole('button', { name: 'Phase 2 Modernization', exact: true }),
    ).toBeVisible();
  });
});

test.describe('Programs — Projects-tab rollup surfacing (#560 / #564)', () => {
  const PROGRAM_PROJECTS = [
    {
      id: 'pp-alpha',
      name: 'Alpha',
      methodology: 'WATERFALL',
      program: PROGRAM_ID,
      overdue_count: 2,
      at_risk_count: 1,
    },
    {
      id: 'pp-bravo',
      name: 'Bravo',
      methodology: 'AGILE',
      program: PROGRAM_ID,
      overdue_count: 0,
      at_risk_count: 0,
    },
  ];

  test('shows the program target date and per-project overdue / at-risk chips (#560)', async ({
    page,
  }) => {
    await setup(page);
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...FIXTURE_PROGRAM, target_date: '2026-09-30', project_count: 2 }),
      }),
    );
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROGRAM_PROJECTS) }),
    );
    await page.goto(`/programs/${PROGRAM_ID}/projects`);

    // Page-rendered signal: the project list resolved before asserting chrome.
    await expect(page.getByRole('link', { name: 'Alpha' })).toBeVisible();
    await expect(page.getByText(/^Target /)).toBeVisible();

    const alpha = page.getByRole('listitem').filter({ hasText: 'Alpha' });
    await expect(alpha.getByText('2 overdue')).toBeVisible();
    await expect(alpha.getByText('1 at risk')).toBeVisible();

    // A project with zero counts shows neither chip.
    const bravo = page.getByRole('listitem').filter({ hasText: 'Bravo' });
    await expect(bravo.getByText(/overdue/)).toHaveCount(0);
    await expect(bravo.getByText(/at risk/)).toHaveCount(0);
  });

  test('add-project modal shows methodology badges and filters by methodology (#564)', async ({
    page,
  }) => {
    await setup(page);
    // Non-empty program list → only the toolbar "Add existing" renders (the
    // empty-state duplicate would be a strict-mode collision).
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROGRAM_PROJECTS) }),
    );
    // The modal reads the global project list (useProjects) for candidates.
    await page.route('**/api/v1/projects/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [
            { id: 'c-wf', name: 'Riverside Waterfall', methodology: 'WATERFALL', program: null },
            { id: 'c-ag', name: 'Riverside Agile', methodology: 'AGILE', program: null },
          ],
          count: 2,
          next: null,
          previous: null,
        }),
      }),
    );
    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    await page.getByRole('button', { name: 'Add existing' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Riverside Waterfall')).toBeVisible();
    // Per-row methodology badge (scoped to its row, exact so it matches only the
    // badge — not the "Riverside Waterfall" name, nor the filter radio outside it).
    await expect(
      dialog
        .locator('label')
        .filter({ hasText: 'Riverside Waterfall' })
        .getByText('Waterfall', { exact: true }),
    ).toBeVisible();

    // Filter to Agile — scope to the methodology radiogroup so it doesn't collide
    // with the per-row project-selection radios (whose names also contain "Agile").
    const methodologyGroup = dialog.getByRole('radiogroup', { name: 'Filter by methodology' });
    await methodologyGroup.getByRole('radio', { name: 'Agile' }).click();
    await expect(dialog.getByText('Riverside Agile')).toBeVisible();
    await expect(dialog.getByText('Riverside Waterfall')).toHaveCount(0);
  });
});
