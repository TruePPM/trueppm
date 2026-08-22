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
 * the matching `disableRules` entry:
 *   - `aria-required-children` / `aria-required-attr` / `nested-interactive`
 *     (Schedule grid, Board resize handles + card overlay + backlog rail) → #2618
 *
 * These cited #2204 until #2603. #2204 closed without fixing them: re-running
 * the four affected scans with every exclusion deleted still fails all four, so
 * the debt is live and was simply pointing at a dead issue — the gate stayed
 * green by hiding failures nothing tracked. They now cite #2618, and each site
 * carries a `SUPPRESSED-UNTIL(#2618)` marker that scripts/check-suppression-issues.sh
 * fails on the moment #2618 closes with the exclusions still here. If you are
 * closing #2618, delete these entries in the same MR — the gate will tell you.
 * The `color-contrast` (HealthCluster/health chip, ⌘K kbd chips + group labels,
 * Schedule/Board toolbar labels, Add-milestone button, Settings chips, drawer body
 * text) and `aria-prohibited-attr` (mobile logo `.select-none`) debt tracked by
 * #2265 has been FIXED and its exclusions dropped — every scan below now enforces
 * `color-contrast`, so contrast regressions anywhere fail the build.
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
  estimation_mode: 'OPEN',
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
  // Running-timer probe (object or null) — polled by the TopBar timer chip.
  await page.route('**/api/v1/me/timer/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) }),
  );
  // This-week time entries (paginated) — read by the My Work week strip.
  await page.route('**/api/v1/me/time-entries/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
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
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible({
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
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible({
      timeout: 10_000,
    });
    // HealthCluster renders only on project routes (self-gates off `/`).
    await page.getByTestId('health-cluster').click();
    await expect(page.getByRole('dialog', { name: 'Project health' })).toBeVisible();

    // Chip/placeholder contrast fixed (#2265); the popover's structure is clean too.
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  // The Schedule chart `role="listbox"` holds a `role="status"` sr-only live region
  // as a direct child, which a listbox may not have (`aria-required-children`).
  // Excluded so the scan runs live for every OTHER rule (contrast now enforced —
  // #2265 landed). SUPPRESSED-UNTIL(#2618) — verified still failing, not stale.
  const SCHEDULE_EXCLUDED_RULES = ['aria-required-children'];

  test('project Schedule has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('treegrid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });

    await expectNoA11yViolations(page, testInfo, {
      gateModerate: true,
      disableRules: SCHEDULE_EXCLUDED_RULES,
    });
  });

  test('CreateMenu popover (Schedule) has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    // CreateMenu is a plain button on single-target routes and renders nothing
    // off a project — it is only a role="menu" popover where >1 target exists,
    // which is the Schedule view (New Task / New Milestone). It therefore shares
    // the Schedule route's excluded rules. SUPPRESSED-UNTIL(#2618)
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('treegrid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Create new' }).click();
    await expect(page.getByRole('menu', { name: 'Create new' })).toBeVisible();

    await expectNoA11yViolations(page, testInfo, {
      gateModerate: true,
      disableRules: SCHEDULE_EXCLUDED_RULES,
    });
  });

  test('project Board has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    await page.goto(`/projects/${PROJECT_ID}/board`);
    // A column heading only renders once board-config + tasks resolve.
    await expect(page.getByRole('heading', { name: /^In Progress,/ })).toBeVisible({
      timeout: 10_000,
    });

    // `aria-required-attr` is now ENFORCED on the Board (#2635). Both resize
    // handles were focusable `role="separator"` splitters carrying `aria-valuemin`
    // and no `aria-valuenow` — the one exclusion here that masked a live WCAG
    // 4.1.2 failure rather than tracked debt. They now declare valuenow/valuemax
    // (and a valuetext), so the rule runs.
    //
    // Two exclusions remain and are real: a grid holds `[role=status]` +
    // `button[aria-busy]` children (`aria-required-children`), and a card overlay
    // nests interactive controls (`nested-interactive`). Both verified still
    // failing by deleting the entry and re-running — not stale.
    // SUPPRESSED-UNTIL(#2618)
    await expectNoA11yViolations(page, testInfo, {
      gateModerate: true,
      disableRules: ['aria-required-children', 'nested-interactive'],
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
    const grid = page.getByRole('treegrid', { name: 'Task list' });
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

    // The scan still sees the Schedule grid behind the open drawer, so it inherits
    // the grid's `aria-required-children`. Every other rule — contrast included
    // (#2265 landed) — is enforced. SUPPRESSED-UNTIL(#2618)
    await expectNoA11yViolations(page, testInfo, {
      gateModerate: true,
      disableRules: ['aria-required-children'],
    });
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
});
