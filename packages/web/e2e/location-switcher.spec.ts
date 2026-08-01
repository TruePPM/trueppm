import { test, expect, type Page } from './fixtures/coverage';
import { setupApiMocks, setupCatchAll, type ProjectFixture } from './fixtures';

/**
 * Top-bar location switcher E2E (#1643, ADR-0203).
 *
 * The switcher (`Program › Project › Leaf`) replaces the former breadcrumb + in-
 * chrome ProjectSwitcher. Its project segment lets a member jump between projects
 * without leaving the chrome; the leaf is a plain "you are here" label, never a
 * dropdown (the left rail owns view switching). This spec covers:
 *   - golden path: open the project picker on A → search → select B → land on B's
 *     equivalent view with the chrome intact (never a listing route);
 *   - the leaf is not an interactive control;
 *   - edge: a member of a single project sees no project picker (nothing to switch);
 *   - off-project (My Work): the segment becomes an unanchored "Jump to project…"
 *     placeholder picker whose options land on a project's Overview (#2102, ADR-0508 D3).
 *
 * Every project-scoped endpoint the Overview page reads is mocked with its real
 * shape for BOTH project ids (via `*` wildcards), so switching to B doesn't crash
 * the page on an unmocked object endpoint (#1190 lesson).
 */

const PROJECT_A = 'e2e-loc-000000000-0000-0000-0000-0000000000a1';
const PROJECT_B = 'e2e-loc-000000000-0000-0000-0000-0000000000b2';

function projectFixture(id: string, name: string): ProjectFixture {
  return {
    id,
    name,
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    effective_methodology: 'HYBRID',
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: [],
  };
}

const TWO_PROJECTS: ProjectFixture[] = [
  projectFixture(PROJECT_A, 'Apollo Rebuild'),
  projectFixture(PROJECT_B, 'Borealis Pipeline'),
];

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * Register wildcard object-endpoint mocks so BOTH project ids resolve — the
 * built-in `setupApiMocks` keys detail/overview/status-summary to a single id.
 * Registered AFTER setupApiMocks so they win (last-registered wins).
 */
async function setupBothProjects(page: Page, projects: ProjectFixture[]) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await setupCatchAll(page);
  await setupApiMocks(page, { projects, projectId: projects[0].id });

  // Project detail — resolve the requested id from the URL so the switcher trigger
  // shows the correct project after a switch.
  await page.route('**/api/v1/projects/*/', (route) => {
    const m = /\/projects\/([^/]+)\/$/.exec(new URL(route.request().url()).pathname);
    const id = m?.[1];
    const project = projects.find((p) => p.id === id) ?? projects[0];
    return route.fulfill(json(project));
  });
  await page.route('**/api/v1/projects/*/overview/', (route) =>
    route.fulfill(
      json({
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
    ),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill(
      json({
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
    ),
  );
  await page.route('**/api/v1/projects/*/blocked/', (route) =>
    route.fulfill(json({ project_id: PROJECT_A, count: 0, blocked: [] })),
  );
  await page.route('**/api/v1/projects/*/members/**', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('self') === 'true') {
      return route.fulfill(json([{ id: 'mem-admin', role: 300, user_id: 'e2e-user' }]));
    }
    return route.fulfill(json([{ id: 'mem-admin', role: 300 }]));
  });
}

/**
 * Object-shaped reads the My Work page (`/me/work`) makes that the list-shaped
 * catch-all would corrupt (#1190 lesson): the cross-project task page and the
 * weekly time rollup. Both are mocked empty so the page renders its calm empty
 * state and the off-project `LocationSwitcher` mounts without the root error
 * boundary tearing the chrome (which would surface as a flaky detached trigger).
 */
async function setupMyWorkPage(page: Page) {
  await page.route('**/api/v1/me/work/', (route) =>
    route.fulfill(
      json({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
        retro_action_items: [],
        signals: null,
        external_items: [],
        external_sources: [],
      }),
    ),
  );
  await page.route('**/api/v1/me/time-entries/**', (route) =>
    route.fulfill(
      json({
        results: [],
        totals: { by_day: {}, by_cell: {}, today_minutes: 0, week_minutes: 0 },
        submission: { week_start: '2026-01-05', submitted: false, submitted_at: null },
      }),
    ),
  );
}

test.describe('Top-bar location switcher (#1643)', () => {
  test('golden path — switch from one member project to another without leaving the chrome', async ({
    page,
  }) => {
    await setupBothProjects(page, TWO_PROJECTS);
    await page.goto(`/projects/${PROJECT_A}/overview`);

    // Page-rendered signal: the rail's view nav (chrome) plus the project picker
    // trigger for the current project.
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    const trigger = page.getByRole('button', {
      name: 'Current project: Apollo Rebuild. Switch project.',
    });
    await expect(trigger).toBeVisible();

    // The leaf is a plain aria-current label, never an interactive control.
    const location = page.getByRole('navigation', { name: 'Location' });
    await expect(location.getByText('Overview')).toHaveAttribute('aria-current', 'page');
    await expect(location.getByRole('button', { name: 'Overview' })).toHaveCount(0);

    // Open the picker and confirm it lists both member projects.
    await trigger.click();
    const listbox = page.getByRole('listbox', { name: 'Switch project' });
    await expect(listbox.getByRole('option')).toHaveCount(2);

    // Search narrows to the target project.
    const search = page.getByRole('combobox', { name: 'Find a project' });
    await search.fill('borealis');
    await expect(listbox.getByRole('option')).toHaveCount(1);

    // Select it → navigate to the equivalent view on project B.
    await listbox.getByRole('option', { name: /Borealis Pipeline/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_B}/overview$`));

    // The chrome is intact and the switcher now reflects the new current project.
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Current project: Borealis Pipeline. Switch project.' }),
    ).toBeVisible();
  });

  test('edge — a member of a single project sees no project picker', async ({ page }) => {
    await setupBothProjects(page, [projectFixture(PROJECT_A, 'Apollo Rebuild')]);
    await page.goto(`/projects/${PROJECT_A}/overview`);

    // Chrome renders, but with nothing to switch to the picker is absent (the name
    // still shows as static wayfinding).
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Switch project/ })).toHaveCount(0);
  });

  test('off-project (My Work) — the "Jump to project…" picker lands on a project Overview (#2102, ADR-0508 D3)', async ({
    page,
  }) => {
    await setupBothProjects(page, TWO_PROJECTS);
    await setupMyWorkPage(page);
    await page.goto('/me/work');

    // Page-rendered signal: gate on My Work's own greeting <h1> (always present,
    // above the loading/empty/populated fork) before touching the top bar, so the
    // trigger is queried against a fully-mounted page (#1190 lesson).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

    // Off-project anatomy is two-part: [Jump to project…] › Leaf — no program segment,
    // no current-implying "Switch project" name.
    const location = page.getByRole('navigation', { name: 'Location' });
    const trigger = page.getByRole('button', { name: 'Jump to a project' });
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText('Jump to project…');
    await expect(page.getByRole('button', { name: /Switch project/ })).toHaveCount(0);
    await expect(location.getByText('My Work')).toHaveAttribute('aria-current', 'page');

    // Open the placeholder picker — no option is pre-selected (there is no current).
    await trigger.click();
    const listbox = page.getByRole('listbox', { name: 'Jump to a project' });
    await expect(listbox.getByRole('option')).toHaveCount(2);
    for (const opt of await listbox.getByRole('option').all()) {
      await expect(opt).toHaveAttribute('aria-selected', 'false');
    }

    // Selecting a project jumps into its Overview (never a listing route).
    await listbox.getByRole('option', { name: /Borealis Pipeline/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_B}/overview$`));
    // On the project route the segment is now anchored to the chosen current project.
    await expect(
      page.getByRole('button', { name: 'Current project: Borealis Pipeline. Switch project.' }),
    ).toBeVisible();
  });
});

/**
 * Program breadcrumb — direct link back to the current program (#2669).
 *
 * Before this fix, the program segment was a switcher only: from a project route,
 * clicking the program name opened a "Find a program…" picker, and picking the
 * checked (current) row was an explicit no-op — there was no way back to the
 * program's own Overview from the chrome. The fix (`LocationSegment`'s
 * `linkToCurrent` prop, opted into only by the program segment) splits the name
 * into a direct `Link` to the program's own page, leaving the chevron as a
 * separate switcher-only control. This covers both the multi-program case (the
 * picker still switches) and the single-program case (previously a dead,
 * non-focusable `<span>` with no way back at all).
 */
test.describe('Program breadcrumb — direct link to the current program (#2669)', () => {
  const PROGRAM_ID = 'e2e-loc-prog-00000000-0000-0000-0000-00000002669';
  const OTHER_PROGRAM_ID = 'e2e-loc-prog-00000000-0000-0000-0000-00000002670';
  const PROJECT_ID = 'e2e-loc-proj-00000000-0000-0000-0000-00000002669';

  const FIXTURE_PROGRAM = {
    id: PROGRAM_ID,
    server_version: 1,
    name: 'Phase 2 Modernization',
    description: '',
    methodology: 'HYBRID',
    effective_methodology: 'HYBRID',
    created_by: 'e2e-user',
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    my_role: 400,
    my_role_label: 'Program Admin',
    project_count: 1,
    member_count: 1,
  };

  const OTHER_PROGRAM = {
    ...FIXTURE_PROGRAM,
    id: OTHER_PROGRAM_ID,
    name: 'Other Program',
    project_count: 0,
  };

  const FIXTURE_ROLLUP = {
    aggregation_policy: 'worst',
    policy_available: true,
    project_count: 1,
    program_health: 'unknown',
    kpis: {},
  };

  function projectInProgram(id: string, name: string): ProjectFixture {
    return {
      ...projectFixture(id, name),
      program: PROGRAM_ID,
      program_detail: { id: PROGRAM_ID, name: FIXTURE_PROGRAM.name },
    };
  }

  /** Every endpoint `/programs/${PROGRAM_ID}/overview` reads, mocked to a benign
   *  empty 200 (#1190 lesson) so landing there never trips the root error boundary. */
  async function setupProgramRoutes(page: Page, programList: (typeof FIXTURE_PROGRAM)[]) {
    await page.route(
      '**/api/v1/programs/',
      (route) =>
        route.fulfill(json({ results: programList, count: programList.length, next: null, previous: null })),
    );
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (route) => route.fulfill(json(FIXTURE_PROGRAM)));
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (route) =>
      route.fulfill(json(FIXTURE_ROLLUP)),
    );
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (route) => route.fulfill(json([])));
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/backlog-items/**`, (route) =>
      route.fulfill(json([])),
    );
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/**`, (route) => route.fulfill(json([])));
    await page.route('**/api/v1/ws/ticket/', (route) => route.fulfill(json({ ticket: 'e2e' })));
  }

  test('from a project route, the program name links directly to the program’s own Overview', async ({
    page,
  }) => {
    const project = projectInProgram(PROJECT_ID, 'Apollo Rebuild');
    await setupBothProjects(page, [project]);
    await setupProgramRoutes(page, [FIXTURE_PROGRAM, OTHER_PROGRAM]);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    const location = page.getByRole('navigation', { name: 'Location' });
    const programLink = location.getByRole('link', {
      name: `Current program: ${FIXTURE_PROGRAM.name}. Open program.`,
    });
    await expect(programLink).toBeVisible();
    await expect(programLink).toHaveAttribute('href', `/programs/${PROGRAM_ID}/overview`);

    // The chevron is a separate, switcher-only control — picking a different
    // program from it still works exactly as before.
    await expect(location.getByRole('button', { name: 'Switch program' })).toBeVisible();

    // Clicking the name — not the chevron — lands on the program's own Overview.
    await programLink.click();
    await expect(page).toHaveURL(new RegExp(`/programs/${PROGRAM_ID}/overview$`));
    await expect(page.getByRole('navigation', { name: 'Program' })).toBeVisible();
  });

  test('single-program workspace: the static program row is a live link, not dead text', async ({
    page,
  }) => {
    const project = projectInProgram(PROJECT_ID, 'Apollo Rebuild');
    await setupBothProjects(page, [project]);
    await setupProgramRoutes(page, [FIXTURE_PROGRAM]);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    const location = page.getByRole('navigation', { name: 'Location' });
    // Nothing to switch to (a single program) — no chevron/switcher button — but
    // the name is a live link now, where before it was a non-focusable `<span>`.
    await expect(location.getByRole('button', { name: /Switch program/ })).toHaveCount(0);
    const programLink = location.getByRole('link', {
      name: `Current program: ${FIXTURE_PROGRAM.name}. Open program.`,
    });
    await expect(programLink).toBeVisible();
    await expect(programLink).toHaveAttribute('href', `/programs/${PROGRAM_ID}/overview`);

    await programLink.click();
    await expect(page).toHaveURL(new RegExp(`/programs/${PROGRAM_ID}/overview$`));
    await expect(page.getByRole('navigation', { name: 'Program' })).toBeVisible();
  });
});
