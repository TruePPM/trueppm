import { test, expect, type Page } from './fixtures/coverage';
import { setupApiMocks, setupCatchAll, type ProjectFixture } from './fixtures';

/**
 * Program membership vs. project membership, and the chrome in between (#3469).
 *
 * `GET /projects/` and `GET /projects/{id}/` are scoped to the caller's own
 * `ProjectMembership`; `GET /programs/{id}/projects/` is scoped to the PROGRAM and
 * deliberately lists rows the caller cannot open (#3439). The two membership
 * shapes that fall through that gap each broke the shell in their own direction,
 * and each gets a test here:
 *
 *  (a) a program Owner with no project membership — clicked a row on
 *      Program › Projects and landed on "This project isn't available" while the
 *      chrome around it kept describing a project that was not there: a
 *      placeholder rail card, an "On track" health chip, a permanent "Connecting…",
 *      and a "No projects yet — create one or load a demo" for the owner of a
 *      four-project program;
 *
 *  (b) a project member who is not a program member — a leading empty breadcrumb
 *      segment, a rail subtitle naming a program they cannot open, and a failing
 *      `GET /programs/{id}/` on every page.
 *
 * Every endpoint each page reads is mocked with its REAL shape. The catch-all
 * returns a LIST envelope for object endpoints (`/programs/:id/rollup/`,
 * `/projects/:id/overview/`), which crashes the component into the root error
 * boundary and surfaces later as an unrelated detached-element flake (#1190) — so
 * `/projects/{MISSING}/` 404ing is something this spec asks for EXPLICITLY, not
 * something it leaves to the net.
 */

const ME_ID = 'e2e-3469-user';
const PROGRAM_ID = 'e2e-3469-prog-0000-0000-0000-000000003469';
const OPEN_PROJECT = 'e2e-3469-proj-0000-0000-0000-0000000000a1';
const CLOSED_PROJECT = 'e2e-3469-proj-0000-0000-0000-0000000000b2';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'atlas-alex',
  display_name: 'Alex Atlas',
  initials: 'AA',
  email: 'alex@example.com',
  can_access_admin_settings: false,
  hidden_views: [],
  role_context: 'unified',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Harbour Modernization',
  description: '',
  methodology: 'HYBRID',
  effective_methodology: 'HYBRID',
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Owner',
  // Four projects in the program — the count the rail and My Work must read, and
  // the whole reason "No projects yet" was wrong for this user.
  project_count: 4,
  member_count: 1,
  code: 'HBR',
  color: null,
  target_date: null,
  is_sample: false,
  is_closed: false,
  closed_at: null,
  closed_by: null,
};

/** One `ProgramProjectRowSerializer` row (#3439). `my_role` is the openability flag. */
function rosterRow(id: string, name: string, myRole: number | null) {
  return {
    id,
    name,
    code: '',
    program: PROGRAM_ID,
    start_date: '2026-01-05',
    methodology: 'HYBRID',
    effective_methodology: 'HYBRID',
    inherited_methodology: 'HYBRID',
    iteration_label: null,
    effective_iteration_label: 'Sprint',
    health: 'AUTO',
    lifecycle: 'active',
    is_archived: false,
    overdue_count: 0,
    at_risk_count: 0,
    is_pinned: false,
    my_role: myRole,
    my_role_label: myRole === null ? null : 'Member',
    can_author: myRole !== null,
    can_undo_batch_operations: false,
  };
}

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const paginated = (results: unknown[]) => json({ count: results.length, next: null, previous: null, results });

async function seedAuth(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
}

/** Program-scoped reads the program shell + Projects tab make. */
async function setupProgramReads(page: Page, roster: ReturnType<typeof rosterRow>[]) {
  await page.route('**/api/v1/programs/', (route) => route.fulfill(paginated([FIXTURE_PROGRAM])));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (route) =>
    route.fulfill(json(FIXTURE_PROGRAM)),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (route) =>
    route.fulfill(json(roster)),
  );
  // Object-shaped, so the list-shaped catch-all would crash ProgramOverviewPage
  // and tear out the chrome mid-assertion (#1190).
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (route) =>
    route.fulfill(
      json({
        aggregation_policy: 'worst',
        policy_available: true,
        project_count: 4,
        program_health: 'unknown',
        kpis: {},
      }),
    ),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/**`, (route) => route.fulfill(json([])));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/backlog-items/**`, (route) =>
    route.fulfill(json([])),
  );
}

/** The object-shaped reads My Work makes, so its empty state is the real one. */
async function setupMyWorkReads(page: Page) {
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill(
      json({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
        retro_action_items: [],
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

// ---------------------------------------------------------------------------
// (a) Program Owner, no project membership
// ---------------------------------------------------------------------------

test.describe('program Owner with no project membership (#3469)', () => {
  const ROSTER = [
    rosterRow(CLOSED_PROJECT, 'Quay Resurfacing', null),
    rosterRow('e2e-3469-proj-0000-0000-0000-0000000000c3', 'Crane Retrofit', null),
  ];

  async function setup(page: Page) {
    await seedAuth(page);
    await setupCatchAll(page);
    // `projects: []` is the membership-scoped list this caller really gets — the
    // whole defect is that the shell had nothing else to count.
    await setupApiMocks(page, { projects: [], projectId: CLOSED_PROJECT, user: FIXTURE_ME });
    await setupProgramReads(page, ROSTER);
    await setupMyWorkReads(page);
    // Registered LAST so it beats setupApiMocks' 200 for this id. This is the
    // state under test, so it is asked for explicitly rather than inherited from
    // the catch-all.
    await page.route(`**/api/v1/projects/${CLOSED_PROJECT}/`, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Not found.' }),
      }),
    );
  }

  test('Program › Projects marks the rows the viewer cannot open, and does not link them', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/projects`);

    // Page-rendered signal: the roster list itself, which only exists once
    // `/programs/:id/projects/` has resolved.
    const roster = page.getByRole('list', { name: 'Projects in this program' });
    await expect(roster).toBeVisible({ timeout: 10_000 });

    // The row is still there — a program member is meant to see what is in the
    // program (#3439) — but it no longer offers a click that dead-ends.
    await expect(roster.getByText('Quay Resurfacing', { exact: true })).toBeVisible();
    await expect(roster.getByRole('link', { name: 'Quay Resurfacing' })).toHaveCount(0);
    await expect(roster.getByRole('link')).toHaveCount(0);

    // …and it says why, in words rather than by absence.
    await expect(roster.getByText('No access').first()).toBeVisible();
    await expect(roster.getByText(/not a member of this project/).first()).toBeAttached();

    // The remedy is drawn at rest, not only in a `title` (which never fires on
    // touch) — otherwise a sighted touch user gets a dead-end marker.
    await expect(
      page.getByText(/need a project owner to add you before you can open them/),
    ).toBeVisible();

    // Pinning is an @action on the membership-scoped ProjectViewSet, so it 404s for
    // exactly these rows; the toggle would offer a Retry that can never succeed.
    await expect(roster.getByRole('button', { name: /pin/i })).toHaveCount(0);
  });

  test('the mobile bottom nav is absent too — not just the desktop rail', async ({ page }) => {
    // `BottomNav` is `md:hidden`, so every other assertion in this file is
    // structurally blind to it. It is the mobile counterpart of the rail's project
    // tier and drew the same literal-fallback tab set, every tap of which re-landed
    // on this same page.
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    await page.goto(`/projects/${CLOSED_PROJECT}/overview`);

    await expect(page.getByRole('heading', { name: /isn.t available/i })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('navigation', { name: 'View' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^More/ })).toHaveCount(0);
  });

  test('no chrome element states a health, a view list, or a connection state on a project the Owner cannot open', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${CLOSED_PROJECT}/overview`);

    // Page-rendered signal: the route's own terminal state. Everything below is
    // asserted against a fully-settled page, not a mid-flight one.
    await expect(page.getByRole('heading', { name: /isn.t available/i })).toBeVisible({
      timeout: 10_000,
    });

    // 1. No health. The chip used to read "On track" off a zero/zero status-summary.
    await expect(page.getByTestId('health-cluster')).toHaveCount(0);

    // 2. No view list. The rail's project tier used to draw "Project · Hybrid
    //    methodology" with Plan/Deliver bands entirely from its literal fallbacks.
    await expect(page.getByRole('navigation', { name: 'View' })).toHaveCount(0);
    // `exact` — the not-found page's own copy starts "This project isn't
    // available", which a substring match would collide with.
    await expect(page.getByText('This project', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Hybrid methodology')).toHaveCount(0);

    // 3. No connection state. ProjectShell holds the socket closed here, so the
    //    pill sat on "Connecting…" for the rest of the session.
    const statusBar = page.getByRole('contentinfo', { name: 'Application status' });
    await expect(statusBar).toBeVisible();
    await expect(
      statusBar.getByText(/Live|Connecting|Reconnecting|Connection lost|Disconnected/),
    ).toHaveCount(0);

    // 4. The breadcrumb reports the terminal state instead of naming a view of a
    //    project that is not there ("› Dashboard" was the reported symptom), and
    //    carries no leading empty program segment.
    const location = page.getByRole('navigation', { name: 'Location' });
    await expect(location.getByText('Project unavailable')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(location.getByText('Dashboard')).toHaveCount(0);
    await expect(location.getByRole('button', { name: /Switch program/ })).toHaveCount(0);
    await expect(location.getByRole('link', { name: /Open program/ })).toHaveCount(0);
  });

  test('the rail does not tell the owner of a four-project program that they have no projects', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${CLOSED_PROJECT}/overview`);
    await expect(page.getByRole('heading', { name: /isn.t available/i })).toBeVisible({
      timeout: 10_000,
    });

    // The rail falls back to the pinned tier here — its zero-project onboarding
    // counted only membership projects, so it fired for a program Owner.
    await expect(page.getByText(/No projects yet/)).toHaveCount(0);
    await expect(page.getByText(/Pin a project from its Overview/)).toBeVisible();
  });

  test('My Work does not greet the owner of a four-project program as a brand-new user', async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/me/work');

    // Page-rendered signal: My Work's greeting heading, present above the
    // loading/empty/populated fork.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText(/let.s get you started/i)).toHaveCount(0);
    await expect(page.getByText(/Create your first project/i)).toHaveCount(0);
    // Flavor B — they have somewhere to be, nothing is assigned to them…
    await expect(page.getByRole('heading', { name: /all caught up/i })).toBeVisible();
    // …and flavor B's own copy assumes project membership, so it needs the one
    // link that is actually right for a program-only member.
    await expect(page.getByRole('link', { name: /Browse programs/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// (b) Project member outside the program
// ---------------------------------------------------------------------------

test.describe('project member outside the program (#3469)', () => {
  const PROJECT: ProjectFixture = {
    id: OPEN_PROJECT,
    name: 'Berth 7 Fit-out',
    description: '',
    start_date: '2026-01-05',
    calendar: 'default',
    effective_methodology: 'HYBRID',
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: [],
    program: PROGRAM_ID,
    program_detail: { id: PROGRAM_ID, name: FIXTURE_PROGRAM.name },
  };

  /**
   * Records every request the page makes, so "no failing program request" can be
   * asserted about the CALL and not merely about what rendered. Returns the
   * collected URLs; start it before `goto`.
   */
  function recordRequests(page: Page): string[] {
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));
    return urls;
  }

  async function setup(page: Page) {
    await seedAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [PROJECT],
      projectId: OPEN_PROJECT,
      user: FIXTURE_ME,
    });
    // The caller is a member of NO program — this is the member-scoped list.
    await page.route('**/api/v1/programs/', (route) => route.fulfill(paginated([])));
    // Left to 404 deliberately: if the shell asks, the assertion below sees it.
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Not found.' }),
      }),
    );
  }

  test('the breadcrumb is coherent — no leading empty program segment', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${OPEN_PROJECT}/overview`);

    // Page-rendered signal: the rail's project tier, which only mounts once the
    // project detail read has resolved.
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });

    const location = page.getByRole('navigation', { name: 'Location' });
    // The project and the leaf are both present and named. (The project segment
    // renders as static wayfinding rather than a picker here — with one member
    // project there is nothing to switch to, rule 124.)
    await expect(location.getByText('Berth 7 Fit-out')).toBeVisible();
    await expect(location.getByText('Dashboard')).toHaveAttribute('aria-current', 'page');
    // …and the program segment is omitted rather than rendered as a nameless
    // picker followed by a chevron pointing at nothing.
    await expect(location.getByRole('button', { name: /Switch program/ })).toHaveCount(0);
    await expect(location.getByText(FIXTURE_PROGRAM.name)).toHaveCount(0);
    // The load-bearing assertion, and the one the absence checks above cannot
    // make: an OMITTED segment and an EMPTY one are both nameless, so only the
    // separator distinguishes them. The `›` is `aria-hidden`, so it is unreachable
    // by role — the breadcrumb's own leading text is what proves the segment is
    // gone rather than blank.
    await expect(location).not.toHaveText(/^\s*›/);
    await expect(location).toHaveText(/^\s*Berth 7 Fit-out/);
  });

  test('no failing program request is issued', async ({ page }) => {
    await setup(page);
    const urls = recordRequests(page);
    await page.goto(`/projects/${OPEN_PROJECT}/overview`);
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    // Give any deferred fetch a chance to fire before asserting on absence — an
    // `expect(...).toHaveLength(0)` that samples immediately is vacuous.
    await expect
      .poll(() => urls.filter((u) => u.includes(`/programs/${PROGRAM_ID}/`)).length, {
        timeout: 3_000,
      })
      .toBe(0);
  });

  test('the rail does not name a program the viewer cannot open', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${OPEN_PROJECT}/overview`);

    const rail = page.getByRole('navigation', { name: 'Workspace navigation' });
    await expect(rail.getByText('This project')).toBeVisible({ timeout: 10_000 });
    // The tier subtitle used to read `program_detail.name`, which is served to any
    // project member regardless of program membership.
    await expect(rail.getByText(FIXTURE_PROGRAM.name)).toHaveCount(0);
    // The methodology half of the subtitle survives.
    await expect(rail.getByText('Hybrid methodology')).toBeVisible();
  });
});
