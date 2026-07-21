import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

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
  my_role_label: 'Program Admin',
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
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);

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

test.describe('Programs — creation error paths (#1365)', () => {
  // Drive the create modal to both an error class and assert it degrades the
  // same safe way: the failure is surfaced (role="alert"), the dialog stays
  // open over /programs (no optimistic navigation to a program that was never
  // created), and the submit button re-enables so the user can retry. The
  // happy path above only proved the success branch.
  async function openCreateModalAndSubmit(page: Page) {
    await page.goto('/programs');
    await page.getByRole('button', { name: /Create your first program/i }).click();
    await page.getByLabel(/^name/i).fill('Phase 2 Modernization');
    await page.getByRole('button', { name: /Create program/i }).click();
    return page.getByRole('dialog', { name: /New program/i });
  }

  test('keeps the modal open and alerts when the create POST 500s', async ({ page }) => {
    await setup(page);
    // Override the create POST to fail; GET still lists (registered last → wins).
    await page.route('**/api/v1/programs/', (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Internal server error.' }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [], count: 0, next: null, previous: null }),
      });
    });

    const dialog = await openCreateModalAndSubmit(page);
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/programs$/);
    // Button reset out of its "Creating…" pending state so a retry is possible.
    await expect(dialog.getByRole('button', { name: /Create program/i })).toBeEnabled();
  });

  test('keeps the modal open and alerts on a duplicate-name 400', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/programs/', (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ name: ['program with this name already exists.'] }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [], count: 0, next: null, previous: null }),
      });
    });

    const dialog = await openCreateModalAndSubmit(page);
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/programs$/);
  });
});

test.describe('Programs — "Use program defaults" on project create (#1909)', () => {
  // Golden path: create a project under a program with the "Use program defaults"
  // opt-in on, and assert the create POST carries inherit_program_defaults (and
  // omits an explicit methodology so the program's value is copied server-side).
  test('creating a project with the toggle on sends inherit_program_defaults', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });

    let captured: Record<string, unknown> | null = null;
    // Registered after setup() → wins. Captures the POST body; GET still lists
    // the (empty) readable projects the copy-settings picker reads.
    await page.route('**/api/v1/projects/', (r) => {
      if (r.request().method() === 'POST') {
        captured = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'e2e-new-project-1909', name: 'Seeded Project' }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [], count: 0, next: null, previous: null }),
      });
    });

    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    // Gate on the page-loaded signal (the "New project" admin control) before driving
    // the modal, per the data-driven-route rule (avoids the #1190 detach flake).
    const newProjectBtn = page.getByRole('button', { name: 'New project', exact: true });
    await expect(newProjectBtn).toBeVisible();
    await newProjectBtn.click();

    const dialog = page.getByRole('dialog', { name: /new project/i });
    await dialog.getByLabel(/^name/i).fill('Seeded Project');
    await dialog.getByRole('button', { name: /^next$/i }).click(); // step 1 → 2
    await dialog.getByRole('button', { name: /^next$/i }).click(); // step 2 → 3

    // The toggle is labeled with the program name and appears only under a program.
    const toggle = dialog.getByRole('checkbox', { name: /use .*defaults/i });
    await expect(toggle).toBeVisible();
    await toggle.check();

    await dialog.getByRole('button', { name: /create project/i }).click();

    await expect.poll(() => captured?.inherit_program_defaults).toBe(true);
    expect(captured).not.toHaveProperty('methodology');
    expect(captured).not.toHaveProperty('copy_settings_from');
    expect(captured?.program).toBe(PROGRAM_ID);
  });

  // Empty / no-program state: the standalone create modal (opened from the global
  // sidebar with no program context) must NOT offer the program-defaults affordance.
  test('the toggle is absent when creating a standalone project (no program)', async ({ page }) => {
    await setup(page);
    // /me/work renders the global shell + Sidebar. The standalone (programId-less)
    // "+ New project" affordance lives in the "Browse projects and programs" popover,
    // which we open first — the reliable no-program entry point.
    await page.goto('/me/work');
    await expect(page.getByRole('heading', { name: /good morning|good afternoon|good evening/i })).toBeVisible();
    await page.getByRole('button', { name: /Browse projects and programs/i }).click();

    // Scope to the browse popover: a zero-project sidebar now also renders a
    // "+ New project" fallback action (#2034), so the bare role+name matches two
    // buttons. We want the popover's entry point, per this test's intent.
    await page.locator('#rail-browse-panel').getByRole('button', { name: /\+ New project/i }).click();
    const dialog = page.getByRole('dialog', { name: /new project/i });
    await dialog.getByLabel(/^name/i).fill('Standalone Project');
    await dialog.getByRole('button', { name: /^next$/i }).click(); // step 1 → 2
    await dialog.getByRole('button', { name: /^next$/i }).click(); // step 2 → 3

    // Planning model picker is present, but no "Use program defaults" toggle.
    await expect(dialog.getByRole('radiogroup', { name: /project methodology/i })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /use .*defaults/i })).toHaveCount(0);
  });
});

test.describe('Programs — shell nav', () => {
  // #790 / ADR-0095 / #1920: program navigation lives in the left rail's "This
  // program" tier (mirroring the project "This project" tier) and includes a
  // discoverable Settings entry. Detailed reachability of all 8 views lives in
  // program-rail-nav.spec.ts.
  test('program nav is in the rail and includes a Settings entry', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/overview`);

    const nav = page.getByRole('navigation', { name: 'Program' });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: /Backlog/i })).toBeVisible();
    // Assets (ADR-0215, #971) is a discoverable rail entry too.
    await expect(nav.getByRole('link', { name: /Assets/i })).toBeVisible();
    await nav.getByRole('link', { name: /Settings/i }).click();

    // Lands on the consolidated program settings page (ADR-0146; no per-section
    // route redirect anymore), and the Settings entry stays active there.
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

  test('a program KPI card drills into the projects list, at-risk-sorted (#2155)', async ({
    page,
  }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    // A rollup with both task-count KPIs, and a populated, annotated projects
    // list so the drill-through lands somewhere the PM can act. Registered after
    // setup()'s stubs → wins.
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...FIXTURE_ROLLUP,
          kpis: {
            critical_tasks: { available: true, value: 5 },
            at_risk_tasks: { available: true, value: 3 },
          },
        }),
      }),
    );
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'pa', name: 'Low Risk', methodology: 'HYBRID', program: PROGRAM_ID, overdue_count: 0, at_risk_count: 1 },
          { id: 'pb', name: 'High Risk', methodology: 'HYBRID', program: PROGRAM_ID, overdue_count: 2, at_risk_count: 6 },
        ]),
      }),
    );

    await page.goto(`/programs/${PROGRAM_ID}/overview`);

    // The at-risk card is a drill-through link that sorts the offending projects first.
    const atRiskCard = page.getByRole('link', { name: /At-risk tasks: 3\. View at-risk projects\./ });
    await expect(atRiskCard).toBeVisible({ timeout: 5_000 });
    await atRiskCard.click();

    await expect(page).toHaveURL(`/programs/${PROGRAM_ID}/projects?sort=at-risk`);
    // Highest at_risk_count floats to the top of the annotated list.
    const rowNames = page.getByRole('list', { name: 'Projects in this program' }).getByRole('link');
    await expect(rowNames.first()).toHaveText('High Risk');
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
    // No source project picked (the projects list is empty) → copy_settings_from
    // is omitted so the new project starts with blank defaults (#1659, ADR-0242).
    expect(capturedBody).not.toHaveProperty('copy_settings_from');
  });

  test('New project "Copy settings from" picker sends copy_settings_from (#1659)', async ({
    page,
  }) => {
    const NEW_PROJECT_ID = 'e2e-new-project-uuid-0002';
    const SOURCE_PROJECT_ID = 'e2e-source-project-uuid-0001';
    let capturedBody: Record<string, unknown> | null = null;

    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });

    // GET returns a readable source project so the picker has an option; POST
    // records the create body. (Overrides the empty-list default from setup.)
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
            description: '',
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
        body: JSON.stringify({
          results: [
            {
              id: SOURCE_PROJECT_ID,
              name: 'Reference Waterfall',
              description: '',
              start_date: '2026-01-01',
              calendar: null,
              methodology: 'WATERFALL',
              program: null,
            },
          ],
          count: 1,
          next: null,
          previous: null,
        }),
      });
    });

    await page.route(`**/api/v1/projects/${NEW_PROJECT_ID}/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: NEW_PROJECT_ID,
          server_version: 1,
          name: 'Seeded Project',
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
      .getByRole('button', { name: /^New project$/i })
      .click();
    await page.getByLabel(/^name/i).fill('Seeded Project');
    await page.getByRole('button', { name: /next/i }).click(); // step 1 → 2
    await page.getByRole('button', { name: /next/i }).click(); // step 2 → 3
    await page
      .getByRole('combobox', { name: /copy settings from/i })
      .selectOption(SOURCE_PROJECT_ID);
    await page.getByRole('button', { name: /create project/i }).click();

    await expect(page).toHaveURL(`/projects/${NEW_PROJECT_ID}/overview`);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.copy_settings_from).toBe(SOURCE_PROJECT_ID);
    expect(capturedBody!.name).toBe('Seeded Project');
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
    await expect(row.getByText('38% complete')).toBeVisible();
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

test.describe('Programs — directory filter & sort (#1796)', () => {
  // A small directory of programs with distinct names, methodologies, health, and
  // updated_at so filter, methodology facet, and each sort key are observable.
  const DIRECTORY = [
    {
      ...FIXTURE_PROGRAM,
      id: 'dir-apollo',
      name: 'Apollo Migration',
      description: 'billing platform rebuild',
      methodology: 'WATERFALL',
      health: 'ON_TRACK',
      updated_at: '2026-03-01T00:00:00Z',
    },
    {
      ...FIXTURE_PROGRAM,
      id: 'dir-zephyr',
      name: 'Zephyr Mobile',
      description: 'field app',
      methodology: 'AGILE',
      health: 'CRITICAL',
      updated_at: '2026-06-01T00:00:00Z',
    },
    {
      ...FIXTURE_PROGRAM,
      id: 'dir-meridian',
      name: 'Meridian Data',
      description: 'warehouse',
      methodology: 'HYBRID',
      health: 'AT_RISK',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ];

  async function gotoDirectory(page: Page) {
    await setup(page, { existingPrograms: DIRECTORY as unknown as (typeof FIXTURE_PROGRAM)[] });
    await page.goto('/programs');
    // Page-rendered signal: the grid resolved before we touch the toolbar chrome.
    await expect(page.getByRole('link', { name: /Apollo Migration/i })).toBeVisible();
  }

  function cardNames(page: Page) {
    return page.getByRole('list', { name: 'Programs' }).getByRole('heading', { level: 2 });
  }

  test('golden path: filter narrows cards; sort changes and persists across reload', async ({
    page,
  }) => {
    await gotoDirectory(page);

    // Default sort is "Recently active" (updated_at desc): Zephyr → Apollo → Meridian.
    await expect(cardNames(page)).toHaveText([
      'Zephyr Mobile',
      'Apollo Migration',
      'Meridian Data',
    ]);

    // Filter narrows as you type.
    await page.getByRole('searchbox', { name: /Filter programs by name/i }).fill('merid');
    await expect(cardNames(page)).toHaveText(['Meridian Data']);
    await page.getByRole('button', { name: 'Clear filter' }).click();
    await expect(cardNames(page)).toHaveCount(3);

    // Sort by name A→Z is visible in the ordering.
    await page.getByRole('combobox', { name: /Sort/i }).selectOption('name');
    await expect(cardNames(page)).toHaveText([
      'Apollo Migration',
      'Meridian Data',
      'Zephyr Mobile',
    ]);

    // The choice persists per-browser across a reload.
    await page.reload();
    await expect(page.getByRole('combobox', { name: /Sort/i })).toHaveValue('name');
    await expect(cardNames(page)).toHaveText([
      'Apollo Migration',
      'Meridian Data',
      'Zephyr Mobile',
    ]);
  });

  test('empty-filter-result state appears when no program matches', async ({ page }) => {
    await gotoDirectory(page);
    await page
      .getByRole('searchbox', { name: /Filter programs by name/i })
      .fill('nonexistent-program');
    await expect(page.getByText(/No programs match your filter/i)).toBeVisible();
    // Recovering via the empty-state action restores the full directory.
    await page.getByRole('status').getByRole('button', { name: /Clear filter/i }).click();
    await expect(cardNames(page)).toHaveCount(3);
  });

  test('methodology facet narrows the directory', async ({ page }) => {
    await gotoDirectory(page);
    await page
      .getByRole('radiogroup', { name: 'Filter by methodology' })
      .getByRole('radio', { name: 'Agile' })
      .click();
    await expect(cardNames(page)).toHaveText(['Zephyr Mobile']);
  });
});

test.describe('Programs — mobile touch affordances (#1802)', () => {
  // The card pin star reveals on hover/focus on desktop, but a phone has no
  // hover — below `md` it must be always-visible (max-md:opacity-100) so an
  // unpinned program's pin affordance is discoverable by touch.
  test('pin star is visible without hover below md', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/programs');

    const pin = page.getByRole('button', { name: `Pin ${FIXTURE_PROGRAM.name}` });
    await expect(pin).toBeVisible();
    // A 44px hit target that is actually opaque on a phone (not opacity-0).
    await expect(pin).toHaveCSS('opacity', '1');
    const box = await pin.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe('Programs — sidebar entry', () => {
  test('the rail lists the program in the Programs tree after creation', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    const sidebar = page.locator('aside[aria-label="Primary navigation"]');
    await expect(sidebar).toBeVisible();
    // 3-tier rail (#1642): the Programs tree relocated into the Tier-3 "Browse"
    // switcher — open it, then the program is a row (name = the open button's name).
    await sidebar.getByRole('button', { name: 'Browse projects and programs' }).click();
    await expect(
      sidebar.getByRole('button', { name: 'Phase 2 Modernization', exact: true }),
    ).toBeVisible();
  });

  test('the rail Programs header links to the /programs gateway (#1334 regression)', async ({
    page,
  }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    const sidebar = page.locator('aside[aria-label="Primary navigation"]');
    // The Programs gateway link now lives in the Tier-3 "Browse" switcher (#1642);
    // it is still a link to /programs (where the "Load demo data" on-ramp lives),
    // so the #1334 regression (no clickable path to /programs) can't return silently.
    await sidebar.getByRole('button', { name: 'Browse projects and programs' }).click();
    const gateway = sidebar.getByRole('link', { name: 'Programs', exact: true });
    await expect(gateway).toBeVisible();
    await gateway.click();
    await expect(page).toHaveURL(/\/programs$/);
    await expect(page.getByRole('heading', { name: 'Programs', level: 1 })).toBeVisible();
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
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROGRAM_PROJECTS),
      }),
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
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROGRAM_PROJECTS),
      }),
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
