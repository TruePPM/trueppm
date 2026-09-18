import { test, expect } from './fixtures/coverage';

import {
  expectNoA11yViolations,
  setupApiMocks,
  setupAuth,
  setupCatchAll,
  type ProjectFixture,
} from './fixtures';

/**
 * Accessibility gate (#1685, expanded #2202).
 *
 * Runs axe-core against TruePPM's core chrome and its major routes inside the
 * existing `web:e2e` job and fails on critical/serious WCAG 2.1 A/AA violations
 * (moderate per-scope where a scope is verified clean — see the ratchet note in
 * `fixtures/a11y.ts`). The gate started (#1685) as a two-state foothold — the
 * public login page plus the empty authenticated shell — and #2202 ratcheted it
 * up: one scan per major route (Overview, Schedule, Board, Settings), the
 * task-drawer-open and command-palette-open states, a dark-mode and a
 * mobile-viewport variant of the shell, and the four TopBar popovers.
 *
 * Each test gates on a "page rendered" locator before scanning: axe on a
 * mid-load DOM (loading skeletons, un-hydrated regions) reports transient noise.
 * Every route mocks the specific endpoints its hooks read with their REAL
 * response shape — never the list-shaped catch-all for an object endpoint
 * (which crashes the page into the root error boundary), per the project rule.
 *
 * ## Known-debt exclusions (deferred, tracked — remove as fixes land)
 *
 * #2202 says to land these scans AFTER the 2026-07-18 audit fixes, but those
 * MRs are still in flight. To keep the pipeline green now WITHOUT hiding the new
 * coverage, each route that trips an already-tracked, not-yet-fixed rule keeps
 * its scan live and excludes ONLY that specific rule (option (a) in the issue),
 * with the tracking issue named inline. No route is `test.fixme`'d — every scan
 * runs and gates all other WCAG 2.1 A/AA rules today. As each fix lands, delete
 * the matching `disableRules` entry.
 *
 * These cited #2204 until #2603. #2204 closed without fixing them: re-running
 * the four affected scans with every exclusion deleted still failed all four, so
 * the debt was live and was simply pointing at a dead issue — the gate stayed
 * green by hiding failures nothing tracked. They then cited #2618, and #2618 is
 * now fully closed out. All three of its rules are FIXED and every one of its
 * exclusions is gone:
 *   • `aria-required-children` — the Schedule chart's live region moved to a
 *     sibling of the `role="listbox"` (ScheduleAriaOverlay.tsx), the Item-list
 *     treegrid's row-edge insert button is wrapped in its own `role="gridcell"`
 *     (TaskListRow.tsx), and the Board backlog rail's empty-state hint sits in
 *     its own `role="listitem"` (BacklogBand.tsx).
 *   • `aria-required-attr` — fixed by #2635; both board resize handles declare
 *     `aria-valuenow`/`aria-valuemax`/`aria-valuetext`.
 *   • `nested-interactive` on the Board — the card root was `role="button"`
 *     wrapping the card's real controls (health badge, dependency/risk chips,
 *     accept ✓, ··· overflow trigger). The root is now a plain roleless
 *     container and the card's accessible name, tab stop, and Enter/Space
 *     activation live on a real `<button>` around the title (`CardTitleButton`),
 *     which contains nothing focusable. The name string is byte-identical, so
 *     `getByRole('button', { name: /…% complete/ })` still resolves — to the
 *     title button rather than the root.
 * The `color-contrast` (HealthCluster/health chip, ⌘K kbd chips + group labels,
 * Schedule/Board toolbar labels, Add-milestone button, Settings chips, drawer
 * body text) and `aria-prohibited-attr` (mobile logo `.select-none`) debt
 * tracked by #2265 has been FIXED and its exclusions dropped — every scan below
 * now enforces `color-contrast`, so contrast regressions anywhere fail the
 * build. The one exclusion left anywhere in this file is `color-contrast` on the
 * Calendar scan, which is debt that scan FOUND and which #3879 tracks.
 */

/**
 * `color-contrast` is fully enforced. The foothold's first run (#1685) surfaced
 * only pre-existing DS-v2 color-token contrast debt — the sage-500 wordmark,
 * login disabled/placeholder text, the brand-primary/15 badge, and the StatusBar
 * build hash on the sunken surface. That debt was resolved through /brand +
 * /ux-review in #1689 (wordmark → sage-700 brand-primary; disabled text →
 * secondary; badge tint /15 → /10; StatusBar moved to the raised surface), so the
 * gate now runs with no rule exclusions — every critical/serious WCAG 2.1 A/AA
 * rule, contrast included, fails the pipeline.
 */

// -----------------------------------------------------------------------------
// Shared fixtures for the route scans.
// -----------------------------------------------------------------------------

const PROJECT_ID = 'e2e-a11y-00000000-0000-0000-0000-000000002202';

/** A fully-populated project detail so the settings + shell chrome renders with
 *  real values (health chip, calendar block, visibility radios) rather than
 *  skeletons. Shape mirrors ProjectSerializer. */
const PROJECT: ProjectFixture = {
  id: PROJECT_ID,
  name: 'Accessibility Audit Project',
  description: 'Route-coverage fixture for the axe gate.',
  start_date: '2026-01-01',
  calendar: 'default',
  code: 'A11Y',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  timezone: '',
  methodology: 'HYBRID',
  // The consolidated settings page mounts every section, incl. the Methodology
  // block inside "How this team works", which reads these + workspace settings;
  // without them it stays in its loading skeleton and renders no title strip.
  effective_methodology: 'HYBRID',
  inherited_methodology: 'HYBRID',
  estimation_mode: 'open',
  agile_features: true,
  default_view: 'SCHEDULE',
  iteration_label: 'Sprint',
  lead: null,
  lead_detail: null,
  is_archived: false,
  archived_at: null,
  archived_by: null,
  recalculated_at: null,
  is_sample: false,
  program_detail: null,
  server_version: 1,
};

/** A small, valid task set so the Schedule grid and Board lanes render rows
 *  (each task row is a click target for the drawer scan). Shape mirrors
 *  TaskSerializer (snake_case). */
const TASKS = [
  {
    id: 'a1',
    wbs_path: '1',
    name: 'Discovery Phase',
    early_start: '2026-01-05',
    early_finish: '2026-02-14',
    duration: 30,
    percent_complete: 55,
    is_critical: false,
    is_milestone: false,
    is_summary: true,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'a2',
    wbs_path: '1.1',
    name: 'Requirements Workshop',
    early_start: '2026-01-05',
    early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10,
    percent_complete: 100,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'a1',
    status: 'COMPLETE',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'a3',
    wbs_path: '1.2',
    name: 'Technical Design',
    early_start: '2026-01-19',
    early_finish: '2026-01-30',
    planned_start: '2026-01-19',
    duration: 10,
    percent_complete: 30,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: 'a1',
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: 0,
    predecessor_count: 1,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

/**
 * Seed auth + the common shell/project mocks, then register the extra endpoints
 * a settled shell touches (programs list, My Work feed, timer) so the scanned
 * DOM is fully-rendered content, not a 404 error card. Registered AFTER
 * setupApiMocks so they win; each returns its REAL shape.
 */
async function setupShell(page: import('@playwright/test').Page): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: [PROJECT], projectId: PROJECT_ID, tasks: TASKS });

  // Programs list (paginated envelope) — read by the context switcher + settings.
  await page.route('**/api/v1/programs/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  // Workspace settings (object) — read by `useWorkspaceSettings` on the
  // consolidated Project Settings page. The Methodology block skeletons until BOTH
  // the project AND workspace settings resolve, and its skeleton renders no title
  // strip at all. Before #2969 Methodology was its own section, so that skeleton
  // dangled the section's `aria-labelledby` (→ `#settings-heading-methodology`,
  // stamped only by the title) and axe flagged a serious `aria-prohibited-attr` on
  // the now-unnamed `<section>`. It is now a block inside "How this team works",
  // whose own title always renders, so the dangle is structurally gone — but the
  // mock stays: an unmocked object endpoint still leaves the block a permanent
  // skeleton, and that is worth not shipping to an a11y baseline. Object endpoint,
  // so mock its REAL shape (never the list-shaped catch-all). Shape mirrors
  // WorkspaceSettingsRaw.
  await page.route('**/api/v1/workspace/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Accessibility Audit Workspace',
        subdomain: 'a11y',
        timezone: '',
        fiscal_year_start_month: 1,
        fiscal_year_start_day: 1,
        fiscal_year_start_display: 'January 1',
        work_week: [true, true, true, true, true, false, false],
        default_project_view: 'SCHEDULE',
        allow_guests: false,
        public_sharing: false,
        public_sharing_override_policy: 'suggest',
        iteration_label: 'Sprint',
        iteration_label_override_policy: 'suggest',
        mc_history_enabled: true,
        mc_history_retention_cap: 50,
        mc_history_attribution_audience: 'scheduler_plus',
        mc_history_override_policy: 'suggest',
        task_duration_change_percent_policy: 'confirm',
        task_duration_change_percent_override_policy: 'suggest',
        estimation_scale: 'fibonacci',
        methodology: 'HYBRID',
        methodology_override_policy: 'suggest',
        attachments_enabled: true,
        allowed_attachment_types: [],
        attachments_override_policy: 'suggest',
        calendar: null,
        calendar_override_policy: 'suggest',
        logo_url: null,
        // ADR-0758 (#2670) — a NOT-NULL boolean on the wire. Omitting it here
        // left `Toggle`'s `on` prop `undefined`, which React renders as no
        // `aria-checked` attribute at all — axe `aria-required-attr` (#3482),
        // not a production bug (the real endpoint never omits this field).
        sprint_picker_ready_only_default: true,
      }),
    }),
  );
  // My Work feed (paginated envelope + delta metadata) — read on /me/work. The
  // catch-all would 404 this into an error card; return an empty-but-valid feed
  // so the shell renders its calm empty state instead. Shape mirrors the
  // MyWorkSerializer envelope (see my-work.spec.ts).
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
      }),
    }),
  );
  // Running-timer probe — polled by the TopBar timer chip. `{active: false}` is
  // the real inactive-timer shape (MeTimerView never returns a bare null).
  await page.route('**/api/v1/me/timer/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ active: false }),
    }),
  );
  // This-week time entries — read by `useTimeRollup`/`useWeekTimesheet` on the My
  // Work week strip. Real shape is the weekly rollup envelope (results/totals/
  // submission), not a paginated list — see MeTimeEntryWeeklyView.
  await page.route('**/api/v1/me/time-entries/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [],
        totals: { by_day: {}, by_cell: {}, today_minutes: 0, week_minutes: 0 },
        submission: {
          week_start: new Date().toISOString().slice(0, 10),
          submitted: false,
          submitted_at: null,
        },
      }),
    }),
  );
}

const PROGRAM_ID = 'e2e-a11y-00000000-0000-0000-0000-000000003476';

/**
 * Program detail (object endpoint). `my_role: 400` so the Members tab renders its
 * *editable* branch — the role `<select>` per member plus the Add-member form.
 * That is the state #3476 was about: a lower role renders read-only badges and no
 * combobox at all, so a scan of it could not have seen the `select-name` failure.
 * Shape mirrors ProgramSerializer.
 */
const PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Accessibility Audit Program',
  description: 'Route-coverage fixture for the axe gate.',
  code: 'A11YP',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: null,
  lead_detail: null,
  created_by: 'e2e-user',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 0,
  member_count: 3,
  is_sample: false,
  is_closed: false,
  closed_at: null,
  closed_by: null,
};

/**
 * Three memberships covering both role branches of the row: the caller's own
 * OWNER row (read-only badge, "(you)" annotation, Leave button) and two lower
 * roles that each render a picker — so the scan sees more than one unlabeled
 * combobox, which is what made the original finding 14 nodes rather than one.
 *
 * `role_label` deliberately carries the PROJECT-scoped string the API actually
 * sends for a program membership (`Role.label`, not `_PROGRAM_ROLE_LABELS` —
 * that server-side residual is #3503), so this fixture stays honest about the
 * wire and the assertion below proves the client re-scopes it. Shape mirrors
 * ProgramMembershipReadSerializer.
 */
const PROGRAM_MEMBERS = [
  {
    id: 'a11y-mem-1',
    server_version: 1,
    program: PROGRAM_ID,
    user: 'e2e-user',
    user_detail: { id: 'e2e-user', username: 'e2euser', email: 'e2e@example.com' },
    role: 400,
    role_label: 'Project Admin',
    joined_at: '2026-01-01T00:00:00Z',
    role_changed_at: null,
  },
  {
    id: 'a11y-mem-2',
    server_version: 1,
    program: PROGRAM_ID,
    user: 'user-sofia',
    user_detail: { id: 'user-sofia', username: 'sofia.p', email: 'sofia@example.com' },
    role: 300,
    role_label: 'Project Manager',
    joined_at: '2026-01-02T00:00:00Z',
    role_changed_at: null,
  },
  {
    id: 'a11y-mem-3',
    server_version: 1,
    program: PROGRAM_ID,
    user: 'user-dev',
    user_detail: { id: 'user-dev', username: 'dev.omar', email: 'omar@example.com' },
    role: 100,
    role_label: 'Team Member',
    joined_at: '2026-01-03T00:00:00Z',
    role_changed_at: null,
  },
];

/**
 * Register the program-scoped endpoints `/programs/:id/members` reads, each with
 * its REAL shape. Must run AFTER `setupShell`: that helper installs a broad
 * catch-all route on the programs prefix returning a paginated LIST envelope, and
 * `GET /programs/{id}/` is an OBJECT endpoint — served the list shape, `useProgram`
 * resolves to `{count, results}`, `my_role` is undefined, the editable branch never
 * renders, and the scan would pass against a page that shows nothing it was written
 * to check. Playwright matches last-registered first, so these win.
 */
async function setupProgramMembers(page: import('@playwright/test').Page): Promise<void> {
  // Programs LIST — the rail's "This program" tier reads it for the program name.
  await page.route('**/api/v1/programs/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [PROGRAM] }),
    }),
  );
  // Program members (bare array — this endpoint is not paginated).
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROGRAM_MEMBERS),
    }),
  );
  // Program DETAIL (object) — registered after the members route so the more
  // specific members URL is still reachable; these two globs do not overlap.
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROGRAM),
    }),
  );
}

/**
 * Wait for the app shell + My Work content to settle before scanning. `/`
 * redirects to /me/work; the greeting `h1` renders only once the feed resolves,
 * so it is a reliable "content settled" signal at every viewport (the desktop
 * `Workspace navigation` rail landmark collapses into a drawer below `md`, so it
 * is not a mobile-safe gate).
 */
async function expectShellReady(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening)/ }),
  ).toBeVisible({ timeout: 10_000 });
}

test.describe('accessibility @a11y', () => {
  test('login page has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    // Public route — no auth seed, no API mocks needed. It renders a self-
    // contained credentials form, which makes it a stable, deterministic target.
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    // Login is a small, fully-audited surface — gate at the moderate floor too.
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('authenticated app shell has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    // Seed auth and mock the shell's data reads so the chrome (top bar, rail,
    // status bar) renders fully before axe runs.
    await setupShell(page);

    await page.goto('/');
    await expectShellReady(page);

    // Shell chrome is the original foothold and stays clean at moderate too.
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });
});

/**
 * Theme / viewport matrix (#2202 gap 3). axe `color-contrast` is theme-sensitive
 * and several 2026-07-18 audit findings were dark-mode-only, so the shell is
 * re-scanned in dark mode and at a phone viewport. In-test emulation is used
 * rather than extra Playwright projects: the matrix is small (two shell variants)
 * and keeping it in one file keeps the mocks colocated.
 */
test.describe('accessibility @a11y — theme + viewport matrix', () => {
  test('app shell in dark mode has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    // Force the dark palette two ways: seed the stored preference (theme-init.js
    // applies `.dark` before first paint) AND emulate the OS media so canvas
    // renderers that read prefers-color-scheme also flip.
    await page.addInitScript(() => localStorage.setItem('trueppm.theme', 'dark'));
    await page.emulateMedia({ colorScheme: 'dark' });
    await setupShell(page);

    await page.goto('/');
    await expectShellReady(page);
    // Confirm dark actually applied before scanning — a scan of the light palette
    // labeled "dark" would be a silent false-negative.
    await expect(page.locator('html')).toHaveClass(/dark/);

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('app shell at a mobile viewport has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupShell(page);

    await page.goto('/');
    await expectShellReady(page);

    // Every rule — contrast and aria-prohibited-attr included — is enforced in
    // dark + mobile. (The mobile logo's roleless `aria-label` was fixed in #2265.)
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });
});

/**
 * TopBar popover states (#2202 gap 4). The shell scan runs with every popover
 * closed, so their DOM is never audited. Open each and re-scan. UserMenu and
 * NotificationBell live on the global TopBar (/me/work); CreateMenu is only a
 * menu (>1 target) on the Schedule route and HealthCluster is project-scoped, so
 * both are covered under the routes block below.
 */
test.describe('accessibility @a11y — TopBar popovers', () => {
  test.beforeEach(async ({ page }) => {
    await setupShell(page);
    await page.goto('/');
    await expectShellReady(page);
  });

  test('NotificationBell popover has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('UserMenu popover has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await page.getByRole('button', { name: /^Account/ }).click();
    await expect(page.getByRole('dialog', { name: 'User menu' })).toBeVisible();

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });
});

/**
 * Major route scans (#2202 gap 1). One axe scan per route, each gated on a
 * content locator that only appears after the route's data reads resolve.
 */
test.describe('accessibility @a11y — routes', () => {
  test.beforeEach(async ({ page }) => {
    await setupShell(page);
    // Hold the project socket open so the connection pill settles.
    await page.routeWebSocket('**/ws/v1/projects/**', () => {
      /* accept and hold open */
    });
  });

  test('project Overview has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    // The fixture project has no tasks. Since #2733 there is no separate first-run
    // branch — the "add your first task" card was deleted rather than restyled, and
    // a zero-task project renders the ordinary Overview body. The sr-only page
    // landmark (#2200) is the h1 either way.
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible({
      timeout: 10_000,
    });

    // Overview (incl. the TopBar HealthCluster chip + health badge, fixed #2265)
    // is clean at the moderate floor with every rule enforced.
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('HealthCluster popover has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible({
      timeout: 10_000,
    });
    // HealthCluster renders only on project routes (self-gates off `/`).
    await page.getByTestId('health-cluster').click();
    await expect(page.getByRole('dialog', { name: 'Project health' })).toBeVisible();

    // Chip/placeholder contrast fixed (#2265); the popover's structure is clean too.
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  // `aria-required-children` on the Schedule chart listbox and the Item-list
  // treegrid rows is FIXED (#2618): the live region moved to a sibling of the
  // `role="listbox"` (ScheduleAriaOverlay.tsx) and the row-edge insert button
  // is now wrapped in its own `role="gridcell"` (TaskListRow.tsx, matching the
  // precedent `RowStructureNudges` already set for this exact constraint). No
  // exclusions remain for these two scans.

  test('project Schedule has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({
      timeout: 10_000,
    });

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('CreateMenu popover (Schedule) has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    // CreateMenu is a plain button on single-target routes and renders nothing
    // off a project — it is only a role="menu" popover where >1 target exists,
    // which is the Schedule view (New Task / New Milestone).
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Create new' }).click();
    await expect(page.getByRole('menu', { name: 'Create new' })).toBeVisible();

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('project Board has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await page.goto(`/projects/${PROJECT_ID}/board`);
    // A column heading only renders once board-config + tasks resolve.
    await expect(page.getByRole('heading', { name: /^In Progress,/ })).toBeVisible({
      timeout: 10_000,
    });

    // No exclusions. `aria-required-attr` was fixed by #2635 (both resize
    // handles now declare `aria-valuenow`/`aria-valuemax`/`aria-valuetext`),
    // `aria-required-children` by #2618 (the backlog rail's empty-state hint is
    // wrapped in its own `role="listitem"`, `BacklogBand.tsx`), and
    // `nested-interactive` by #2618 as well: the card root is no longer
    // `role="button"` around the card's real controls — see `CardShell.tsx` and
    // `CardTitleButton.tsx`. This scan is the regression guard for that shape;
    // putting a role back on the card root fails it here.
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('project Calendar has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    // This route carried no axe scan at all until #3241 — which is the reason a
    // seven-column grid of role-less <div>s, with no accessible names and no key
    // handling anywhere in the file, sat here unremarked: nothing looked. The
    // scan is the guard, not the fix; without it the next surface to lose its
    // roles does so silently again.
    //
    // Anchored on the fixture tasks' own month: the calendar defaults to today,
    // and a window with no tasks renders the empty state instead of the grid, so
    // an unanchored scan would cover a different surface every month.
    await page.goto(`/projects/${PROJECT_ID}/calendar?calAnchor=2026-01-12`);
    await expect(page.getByRole('grid', { name: 'Calendar dates' })).toBeVisible({
      timeout: 10_000,
    });

    // The one exclusion, and it is debt this scan FOUND rather than debt it
    // hides: the two day-cell mutes both push the date number below 4.5:1 —
    // weekend `opacity-60` over `text-neutral-text-primary` composites to
    // #767F92 on white (4.02:1), and out-of-month `text-neutral-text-disabled`
    // is #A09D99 on the sunken #EAE5D9 (~1.9:1). Raising either changes how the
    // Calendar looks (both mutes are documented visual behavior), which is a
    // ux-design question and not #3241's markup fix — and the naive token swap
    // does not work, since `opacity-60` composites whatever sits under it.
    // Every other rule runs live here, including the `aria-required-*` pair
    // that is the whole point of the scan. SUPPRESSED-UNTIL(#3879) — delete the
    // entry when that lands, do not narrow it.
    await expectNoA11yViolations(page, testInfo, {
      gateModerate: true,
      disableRules: ['color-contrast'],
    });
  });

  test('project Settings (General) has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible({ timeout: 10_000 });

    // Chip/label contrast fixed (#2265); the settings surface is fully clean.
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('task drawer (open) has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    const grid = page.getByRole('treegrid', { name: 'Item list' });
    await expect(grid).toBeVisible({ timeout: 10_000 });
    await grid.getByRole('button', { name: 'Open properties for Technical Design' }).click();
    const drawer = page.getByRole('dialog', { name: /Technical Design/ }).first();
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    // Clicking a row leaves the pointer hovering it, which triggers the transient
    // dependency-hover dim (opacity) on the non-chain rows behind the drawer —
    // dimmed-but-in-tree text that trips color-contrast for a pointer state that
    // is not the resting drawer view. Move the pointer off the grid so the scan
    // reflects the settled state (the same "don't scan a transient" discipline the
    // fixture docstring calls out); the drawer's own body text is contrast-clean
    // after #2265. See a11y-diag: 18 nodes → 7 → 0 once the dim clears + fixes land.
    await page.mouse.move(2, 2);
    await expect(drawer).toBeVisible();

    // The scan still sees the Schedule grid behind the open drawer, but its
    // `aria-required-children` violation is fixed (#2618, see ScheduleAriaOverlay.tsx
    // and TaskListRow.tsx) — no exclusion needed.
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('command palette (open) has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    await page.goto('/me/work');
    await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();

    // Kbd-chip + group-label contrast fixed (#2265); the palette's
    // listbox/option/combobox semantics and contrast are all clean and gated.
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('program Members has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    // #3476: every role `<select>` on this page shipped with an `id` and no
    // accessible name, so axe reported `select-name` (critical) once per member —
    // 14 nodes on a real program. The route had no scan at all, which is why the
    // gate never saw it.
    await setupProgramMembers(page);
    await page.goto(`/programs/${PROGRAM_ID}/members`);

    // Gate on the members list itself, not on the heading: the heading renders
    // while the query is still in flight, so scanning on it would audit the
    // skeleton rather than the rows (and the comboboxes would not exist yet).
    const list = page.getByRole('list', { name: 'Program members' });
    await expect(list).toBeVisible({ timeout: 10_000 });
    await expect(list.getByRole('listitem')).toHaveCount(3);

    // The acceptance criterion, asserted directly rather than left to axe: each
    // picker names the member whose role it changes. `exact: true` because
    // Playwright's `name` is a substring match, and "Role for sofia.p" would
    // otherwise also satisfy a lookup for "Role for sofia".
    await expect(
      list.getByRole('combobox', { name: 'Role for sofia.p', exact: true }),
    ).toBeVisible();
    await expect(
      list.getByRole('combobox', { name: 'Role for dev.omar', exact: true }),
    ).toBeVisible();

    // Program vocabulary, on both surfaces that carry it: the picker's options
    // and the Owner row's read-only badge. The badge is the one the API gets
    // wrong — `role_label` is "Project Admin" on the wire (see the fixture).
    await expect(
      list.getByRole('option', { name: 'Program Manager', exact: true }).first(),
    ).toBeAttached();
    await expect(list.getByText('Program Admin', { exact: true })).toBeVisible();
    await expect(list.getByText('Project Admin', { exact: true })).toHaveCount(0);
    await expect(list.getByText('Project Manager', { exact: true })).toHaveCount(0);

    // No rule exclusions — this route is clean at the moderate floor.
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });
});

/**
 * Expanded route coverage (#3482). The 2026-09-06 axe sweep (as workspace admin,
 * desktop + phone) found five new critical/serious rule violations this file's
 * routes never reached: `aria-prohibited-attr` (Workspace Settings, Board,
 * Sprints), `aria-required-children` (Schedule listbox / grid `role="status"`),
 * `nested-interactive` (Board cards, Risk rows, My Work), `aria-valid-attr-value`
 * (Grid collapse buttons), and `aria-hidden-focus` (chart containers on
 * Overview/Board/Sprints/Reports) — plus the moderate `page-has-heading-one`
 * gap on several routes. These scans widen the gate to the routes that surface
 * them; see `docs/adr` — no ADR, this is a remediation sweep, not a design change.
 */

const PROGRAM_PROJECT_ID = 'e2e-a11y-00000000-0000-0000-0000-000000003482';

/** One project row on the program's Projects tab (`ProgramProjectRowSerializer`,
 *  #3439) — enough fields for `useProgramProjects` to map a full `Project`. */
const PROGRAM_PROJECT = {
  id: PROGRAM_PROJECT_ID,
  name: 'Constellation Rollout',
  start_date: '2026-01-01',
  methodology: 'HYBRID',
  program: PROGRAM_ID,
  effective_methodology: 'HYBRID',
  inherited_methodology: 'HYBRID',
  iteration_label: null,
  effective_iteration_label: 'Sprint',
  overdue_count: 1,
  at_risk_count: 0,
  sprint_count: 2,
  backlog_story_count: 3,
  baseline_count: 1,
  dependency_count: 0,
  is_pinned: false,
  my_role: 300,
};

/** A handful of workspace programs so `WorkspaceProgramsPage`'s BulkFieldsMatrix
 *  actually renders rows (issue #3482: `aria-label` on the matrix's plain `<span>`
 *  value cells, 4 per row — the "48/page" finding). Shape mirrors `Program`. */
const WORKSPACE_PROGRAMS = ['Apollo', 'Artemis', 'Constellation', 'Orion'].map((name, i) => ({
  id: `wp-${i}`,
  server_version: 1,
  name,
  description: '',
  code: name.slice(0, 4).toUpperCase(),
  methodology: 'HYBRID',
  effective_methodology: 'HYBRID',
  inherited_methodology: 'HYBRID',
  iteration_label: i % 2 === 0 ? null : 'Sprint',
  inherited_iteration_label: 'Iteration',
  effective_iteration_label: i % 2 === 0 ? 'Iteration' : 'Sprint',
  risk_slip_propagation: 'warn',
  risk_escalation_days: 5,
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: null,
  lead_detail: null,
  created_by: 'e2e-user',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 1,
  member_count: 1,
  is_sample: false,
  is_closed: false,
  closed_at: null,
  closed_by: null,
}));

/** One active sprint with a bridge-forecast milestone so the burn/velocity
 *  chart (BurnChart → BurnChartCanvas, `aria-hidden` recharts) actually mounts
 *  rather than showing the chartless empty state. Shape mirrors `Sprint`. */
const ACTIVE_SPRINT = {
  id: 'sp-a11y-active',
  server_version: 1,
  short_id: 'A11Y1',
  short_id_display: 'SP-A11Y1',
  name: 'Sprint A11Y',
  goal: 'Ship the widened axe gate.',
  start_date: '2026-09-01',
  finish_date: '2026-09-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: 20,
  committed_points: 13,
  committed_task_count: 2,
  completed_points: 5,
  completed_task_count: 1,
  activated_at: '2026-09-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-08-25T00:00:00Z',
  updated_at: '2026-09-05T00:00:00Z',
};

/** Two risks — one with an owner, one unassigned — so the register renders more
 *  than one row: the "Unassigned" cell is where the `text-neutral-text-disabled`
 *  contrast + `aria-label`-on-`<span>` violations live (RiskTableRow). */
const RISKS = [
  {
    id: 'risk-a11y-1',
    short_id_display: 'R-1',
    title: 'Vendor API rate limits under sprint load',
    status: 'MITIGATING',
    probability: 3,
    impact: 4,
    severity: 12,
    owner: 'e2e-user',
    owner_initials: 'EU',
    owner_name: 'E2E User',
    mitigation_due_date: '2026-10-01',
  },
  {
    id: 'risk-a11y-2',
    short_id_display: 'R-2',
    title: 'Unclear data-retention requirement from legal',
    status: 'OPEN',
    probability: 2,
    impact: 3,
    severity: 6,
    owner: null,
    owner_initials: null,
    owner_name: null,
    mitigation_due_date: null,
  },
];

/** One project-scoped resource pool entry so the Roster list renders a row
 *  (`useProjectResourcePool` → `GET /project-resources/`). Shape mirrors
 *  `ProjectResourceSerializer` / `ResourceSerializer` (docs/api/openapi.json) —
 *  NOT the fields a plausible-looking guess would reach for (schema-guarded). */
const ROSTER_RESOURCE = {
  id: 'pr-a11y-1',
  server_version: 1,
  project: PROJECT_ID,
  resource: 'res-a11y-1',
  resource_detail: {
    id: 'res-a11y-1',
    server_version: 1,
    name: 'Priya Chandra',
    email: 'priya@example.com',
    job_role: 'Engineer',
    calendar: null,
    max_units: '1.00',
    skills: [],
    is_me: false,
  },
  role_title: 'Engineer',
  units_override: null,
  effective_max_units: '1.00',
  notes: '',
};

const MYWORK_SPRINT_ID = 'sprint-a11y-mywork';
const MYWORK_TASK_ID = 'task-a11y-mywork';

/** A populated My Work feed — the shell scan's default is the empty feed, which
 *  renders no task cards and so cannot see the row-level `nested-interactive`
 *  the audit found (a `role="button"` row wrapping a real status-chip button). */
const MYWORK_ACTIVE_SPRINT = {
  id: MYWORK_SPRINT_ID,
  name: 'Sprint A11Y',
  project_id: PROJECT_ID,
  project_name: PROJECT.name,
  finish_date: '2026-09-14',
  days_remaining: 4,
  task_count: 1,
};

const MYWORK_TASK = {
  id: MYWORK_TASK_ID,
  short_id: 'A11Y-01',
  name: 'Fix the axe gate route list',
  project_id: PROJECT_ID,
  project_name: PROJECT.name,
  program_id: null,
  program_name: null,
  program_color: null,
  sprint_id: MYWORK_SPRINT_ID,
  sprint_name: 'Sprint A11Y',
  status: 'IN_PROGRESS',
  story_points: 3,
  remaining_points: 2,
  due: '2026-09-12',
  due_source: 'planned',
  is_critical: true,
  group: 'this_sprint',
  is_blocked: false,
  blocked_reason: '',
  blocker_type: '',
  blocked_age_seconds: null,
  server_version: 1,
  url: `/projects/${PROJECT_ID}/schedule?task=${MYWORK_TASK_ID}`,
};

test.describe('accessibility @a11y — expanded route coverage (#3482)', () => {
  test.beforeEach(async ({ page }) => {
    await setupShell(page);
  });

  test('Workspace Settings has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    // RequireWorkspaceAdmin gates on `/auth/me`'s `workspace_role`
    // (useWorkspaceAdminStatus) — the shell's DEFAULT_USER fixture carries no
    // numeric role, which resolves to the 'unknown' verdict and renders
    // QueryErrorState instead of the page. Override AFTER setupShell so this
    // route wins (Playwright matches last-registered first).
    await page.route('**/api/v1/auth/me/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'e2e-user',
          username: 'e2euser',
          display_name: 'E2E User',
          initials: 'EU',
          email: 'e2e@example.com',
          default_landing: 'my_work',
          landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
          hidden_views: [],
          role_context: 'unified',
          can_access_admin_settings: true,
          workspace_role: 300,
        }),
      }),
    );
    // `/programs/samples/` is a bare array (WorkspaceSettingsPage's onboarding
    // banner), NOT the paginated list envelope setupShell's broader
    // `**/api/v1/programs/**` catch-all serves every prefixed path — register
    // the more specific route so it wins.
    await page.route('**/api/v1/programs/samples/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    );
    // Real programs so the Programs section's BulkFieldsMatrix renders rows
    // instead of the empty state (registered after setupShell's empty default).
    await page.route('**/api/v1/programs/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: WORKSPACE_PROGRAMS.length,
          next: null,
          previous: null,
          results: WORKSPACE_PROGRAMS,
        }),
      }),
    );
    // `/workspace/members/` is a cursor-paginated envelope (#1317). Left
    // unmocked, the Members section's title never mounts and its
    // `aria-labelledby` dangles — axe `aria-prohibited-attr` on the now-
    // unnamed `<section>` (same class of bug #2969 fixed for Methodology,
    // recurring here because this route never mocked it, #3482).
    await page.route('**/api/v1/workspace/members/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [], next: null }),
      }),
    );
    // `useWorkspaceMembers` combines members + pending invites into one
    // `isLoading` — mocking only `/members/` still left the section's title
    // (and its `settings-heading-members` id) skeleton-gated on this one too.
    await page.route('**/api/v1/workspace/invites/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [], next: null }),
      }),
    );
    // Retention & purge renders inline on the consolidated page. Left
    // unmocked, its loading skeleton (`aria-label` on a plain `role`-less
    // `<div>`) never clears — axe `aria-prohibited-attr` (#3482). Shape
    // mirrors `retention-purge.spec.ts`'s fixture.
    await page.route('**/api/v1/health/retention/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          policies: [
            {
              key: 'HISTORY_RETENTION_DAYS',
              label: 'Event history',
              note: 'Event history note',
              unit: 'days',
              value: 90,
              enabled: true,
              row_count: 100,
              bytes: 1_000_000,
            },
          ],
          schedule: {
            frequency: 'daily',
            time_of_day_utc: '02:00:00',
            day_of_week: null,
            on_failure: 'continue',
          },
          runs: [],
        }),
      }),
    );
    await page.route('**/api/v1/health/retention/impact/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ eligible_rows: 0, eligible_bytes: 0 }),
      }),
    );

    await page.goto('/settings');
    // The General section is the first on the consolidated scroll page and
    // always renders once `/workspace/` resolves — a stable gate independent
    // of the Programs section further down.
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible({ timeout: 10_000 });
    // Confirm the Programs section actually mounted its matrix rows — the
    // scan is worthless against the empty state.
    await expect(page.getByText('Apollo', { exact: true })).toBeVisible();

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('project Sprints (active) has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] }),
      }),
    );

    await page.goto(`/projects/${PROJECT_ID}/sprints`);
    await expect(page.getByText('Sprint A11Y').first()).toBeVisible({ timeout: 10_000 });

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('project Grid has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await page.goto(`/projects/${PROJECT_ID}/grid`);
    // The fixture's summary task ("Discovery Phase", is_summary: true) renders
    // an expand/collapse toggle — the surface the aria-controls finding is on.
    await expect(page.getByText('Discovery Phase')).toBeVisible({ timeout: 10_000 });

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('project Risk Register has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    await page.route(`**/api/v1/projects/${PROJECT_ID}/risks/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: RISKS.length, next: null, previous: null, results: RISKS }),
      }),
    );

    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByText(RISKS[0].title)).toBeVisible({ timeout: 10_000 });

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('project Resources (Roster) has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    await page.route('**/api/v1/project-resources/**', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [ROSTER_RESOURCE],
        }),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/resources`);
    await expect(page.getByText('Priya Chandra')).toBeVisible({ timeout: 10_000 });

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('project Reports has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await page.goto(`/projects/${PROJECT_ID}/reports`);
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible({
      timeout: 10_000,
    });

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('program Backlog has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/backlog-items/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    );

    await page.goto(`/programs/${PROGRAM_ID}/backlog`);
    await expect(page.getByRole('heading', { level: 1, name: 'Backlog' })).toBeVisible({
      timeout: 10_000,
    });

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('program Projects has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await setupProgramMembers(page);
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([PROGRAM_PROJECT]),
      }),
    );

    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    await expect(page.getByText(PROGRAM_PROJECT.name)).toBeVisible({ timeout: 10_000 });

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('My Work (populated) has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    await page.route('**/api/v1/me/work/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [MYWORK_TASK],
          next: null,
          previous: null,
          active_sprints: [MYWORK_ACTIVE_SPRINT],
          due_today_count: 0,
          server_version_high_water: 1,
        }),
      }),
    );

    await page.goto('/me/work');
    // The task title renders twice (the main row link + a compact duplicate in
    // a secondary summary) — `.first()` avoids a strict-mode collision.
    await expect(page.getByText(MYWORK_TASK.name).first()).toBeVisible({ timeout: 10_000 });

    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });
});
