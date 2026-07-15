import { test, expect } from '@playwright/test';

/**
 * Schedule view E2E tests — toolbar, task list panel, and accessibility basics.
 *
 * The app makes real API calls; we intercept them with Playwright route mocking
 * and navigate to /projects/:id/schedule so useScheduleTasks fires the queries.
 * Auth state is seeded in localStorage before each test so RequireAuth passes.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

/** Minimal API-format projects matching what useProjects expects. */
const FIXTURE_API_PROJECTS = [
  { id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default' },
];

/** Minimal API-format tasks (snake_case) matching TaskSerializer output. */
const FIXTURE_API_TASKS = [
  {
    id: 't1', wbs_path: '1', name: 'Alpha Platform Upgrade',
    early_start: '2026-10-05', early_finish: '2026-11-14',
    duration: 30, percent_complete: 40, is_critical: false, is_milestone: false,
    status: 'IN_PROGRESS', is_summary: false, parent_id: null,
  },
  {
    id: 't2', wbs_path: '1.1', name: 'Discovery & Design',
    early_start: '2026-10-05', early_finish: '2026-10-16',
    // A completed task is never on the critical path (#1863): it is done and
    // cannot drive the finish, so the engine reports is_critical=false for it.
    duration: 10, percent_complete: 100, is_critical: false, is_milestone: false,
    status: 'COMPLETE', is_summary: false, parent_id: null,
  },
  {
    id: 't3', wbs_path: '1.2', name: 'Backend Implementation',
    early_start: '2026-10-19', early_finish: '2026-10-30',
    duration: 10, percent_complete: 60, is_critical: true, is_milestone: false,
    status: 'IN_PROGRESS', is_summary: false, parent_id: null,
  },
  {
    id: 't4', wbs_path: '1.3', name: 'Frontend Implementation',
    early_start: '2026-10-19', early_finish: '2026-11-06',
    duration: 15, percent_complete: 30, is_critical: false, is_milestone: false,
    status: 'IN_PROGRESS', is_summary: false, parent_id: null,
  },
  {
    id: 't5', wbs_path: '1.4', name: 'Go-Live Milestone',
    early_start: '2026-11-14', early_finish: '2026-11-14',
    duration: 0, percent_complete: 0, is_critical: true, is_milestone: true,
    status: 'NOT_STARTED', is_summary: false, parent_id: null,
  },
];

/** Set up API route interception and navigate to the Schedule view. */
async function gotoSchedule(page: import('@playwright/test').Page) {
  // Seed auth state so RequireAuth lets the test through.
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_PROJECTS.length, next: null, previous: null, results: FIXTURE_API_PROJECTS }) }),
  );
  // Project detail — ProjectShell now gates every project route on this query
  // (#1111). A 200 keeps the shell mounted; an unmocked 404 would render
  // ProjectNotFound instead of the schedule.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default', estimation_mode: 'OPEN', agile_features: false, methodology: 'HYBRID', code: '', health: 'AUTO', visibility: 'WORKSPACE', timezone: '', default_view: 'SCHEDULE', lead: null, lead_detail: null, iteration_label: 'Sprint', is_archived: false, archived_at: null, archived_by: null, recalculated_at: null, is_sample: false, program_detail: null, server_version: 1 }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
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
    }),
  );
  // Stub overview endpoints so ProjectOverviewPage doesn't error on navigation
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_TASKS.length, next: null, previous: null, results: FIXTURE_API_TASKS }) }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  // The socket mints a single-use ticket first (ADR-0141, #818); mock it so the
  // handshake proceeds instead of 404ing through the catch-all.
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'e2e-ticket', expires_in: 30 }) }),
  );
  // Keep the session-expired banner (SessionExpiredBanner, `fixed inset-0
  // z-[100]`) from ever mounting over the canvas (issue 805). The banner is a
  // full-screen overlay that intercepts every real pointer event, so a
  // `page.mouse` drag lands on the banner instead of the interaction canvas and
  // scrollLeft never moves. It is tripped when an unmocked endpoint 401s and the
  // recovery `POST /auth/token/refresh/` also 401s (expireSession). Mocking the
  // secondary endpoints the shell/toolbar read on a project route — and making
  // refresh succeed — removes that trigger so the canvas stays hit-testable.
  await page.route('**/api/v1/auth/token/refresh/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access: 'e2e-token' }) }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'u1', email: 'e2e@example.com', first_name: 'E', last_name: '2E', is_staff: false }) }),
  );
  await page.route('**/api/v1/workspace/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'w1', name: 'E2E', public_sharing_enabled: false }) }),
  );
  await page.route('**/api/v1/programs/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/projects/*/sprints/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/projects/*/velocity/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sprints: [] }) }),
  );
  await page.route('**/api/v1/projects/*/monte-carlo/latest/**', (route) =>
    route.fulfill({ status: 204, contentType: 'application/json', body: '' }),
  );
  await page.route('**/api/v1/projects/*/visit/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
  );
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/me/notifications/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  // Accept the project WebSocket so the StatusBar connection pill (#643) reaches
  // "Live" instead of stalling on "Connecting…". Leaving the socket open (never
  // closing it) makes the client fire `open` → markLive(); we send no frames.
  await page.routeWebSocket('**/ws/v1/projects/**', () => {
    /* accept and hold the connection open */
  });
  // Path-based routing (ADR-0030): /projects/:projectId/schedule
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

test.describe('Schedule toolbar', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
    // Wait for the Schedule view to finish loading (task list should be visible)
    await expect(
      page.getByRole('grid', { name: 'Task list' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('view-mode switcher has Schedule active; Grid is present', async ({ page }) => {
    // ViewTabs renders as <nav aria-label="View"> with <Link> children (role="link").
    // Active state is indicated by aria-current="page" (not aria-pressed).
    // Grid replaces WBS + Table (issue #334, ADR-0053).
    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav).toBeVisible();

    const scheduleLink = nav.getByRole('link', { name: 'Schedule' });
    const gridLink = nav.getByRole('link', { name: 'Grid' });

    await expect(scheduleLink).toBeVisible();
    await expect(scheduleLink).toHaveAttribute('aria-current', 'page');

    await expect(gridLink).toBeVisible();
    await expect(gridLink).not.toHaveAttribute('aria-current', 'page');

    await expect(nav.getByRole('link', { name: 'WBS' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Table' })).toHaveCount(0);
  });

  test('switching to Grid view shows the unified Grid surface', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Grid' }).click();
    await expect(page).toHaveURL(/\/grid$/);
    // HYBRID methodology defaults to Outline mode → role="treegrid".
    await expect(page.getByRole('treegrid', { name: 'Outline task tree' })).toBeVisible();
  });

  // Interaction coverage for Today/Fit lives in "Schedule toolbar — Today & Fit
  // interactions" below: presence + focus alone let handleScrollToToday /
  // engine.fitToProject regress to no-ops undetected (issue 1512).
});

test.describe('Schedule toolbar — Today & Fit interactions (#1512)', () => {
  const readScrollLeft = (page: import('@playwright/test').Page) =>
    page
      .getByTestId('schedule-canvas-scroll')
      .evaluate((el) => (el as HTMLElement).scrollLeft);

  /**
   * Park the viewport at the far right and return that starting scrollLeft. Both
   * Today (centers "today", which for the fixture's Oct–Nov span sits far left of
   * the parked position) and Fit (pins the project start near the left edge) must
   * then move the viewport substantially leftward; a no-op handler leaves it
   * pinned far right. The assertion is a large leftward delta, so it is robust
   * to viewport width and to where exactly "today" lands.
   */
  async function parkFarRight(page: import('@playwright/test').Page): Promise<number> {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoSchedule(page);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
    const scroll = page.getByTestId('schedule-canvas-scroll');
    await expect(scroll).toBeVisible();
    // Wait until the canvas is actually wider than its viewport, then scroll to
    // the far right so a leftward move is observable.
    await expect
      .poll(() =>
        scroll.evaluate(
          (el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth,
        ),
      )
      .toBeGreaterThan(400);
    await scroll.evaluate((el) => {
      (el as HTMLElement).scrollLeft = (el as HTMLElement).scrollWidth;
    });
    const parked = await readScrollLeft(page);
    expect(parked).toBeGreaterThan(400);
    return parked;
  }

  test('Today button scrolls the timeline toward today', async ({ page }) => {
    const parked = await parkFarRight(page);
    await page.getByRole('button', { name: 'Today' }).click();
    // Centering today moves the viewport well to the left of the far-right park;
    // a no-op leaves scrollLeft pinned at `parked`.
    await expect.poll(() => readScrollLeft(page)).toBeLessThan(parked - 200);
  });

  test('Fit button reframes the project start to the left edge', async ({ page }) => {
    const parked = await parkFarRight(page);
    await page.getByRole('button', { name: 'Fit schedule to window' }).first().click();
    // Fit rescales so the whole project fits and pins the start near the left
    // edge, collapsing scrollLeft back toward 0.
    await expect.poll(() => readScrollLeft(page)).toBeLessThan(parked - 200);
  });
});

test.describe('Schedule task list', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
    await expect(
      page.getByRole('grid', { name: 'Task list' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('task list header shows Dur, Start, Finish, and % columns', async ({ page }) => {
    const header = page.getByRole('row', { name: 'Task list columns' });
    await expect(header).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Duration' })).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Start date' })).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Finish date' })).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Progress' })).toBeVisible();
  });

  test('critical path tasks are announced accessibly', async ({ page }) => {
    // At least one task should have "(critical path)" in its aria-label
    const criticalCell = page.locator('[aria-label*="critical path"]').first();
    await expect(criticalCell).toBeVisible();
  });
});

test.describe('Accessibility basics', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('sidebar has accessible label', async ({ page }) => {
    // v2 left rail (ADR-0126): the aside is now labeled "Primary navigation".
    await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toBeVisible();
  });

  test('status bar is a contentinfo landmark', async ({ page }) => {
    // StatusBar redesigned in #201 — aria-label is now "Application status"
    await expect(
      page.getByRole('contentinfo', { name: 'Application status' }),
    ).toBeVisible();
  });

  test('status bar shows live presence and build hash', async ({ page }) => {
    // On a project page the connection pill (#643) goes Live once the WebSocket
    // opens (routed in gotoSchedule), then appends the viewing count (#1560).
    const footer = page.getByRole('contentinfo', { name: 'Application status' });
    await expect(footer).toBeVisible();
    await expect(footer.getByText(/Live · \d+ viewing/)).toBeVisible({ timeout: 10_000 });
    await expect(footer.getByText(/build /)).toBeVisible();
  });
});

test.describe('Schedule zoom & pan (#351 / #491)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('zoom stepper steps the derived tier; Fit button is present (#351)', async ({ page }) => {
    const group = page.getByRole('group', { name: 'Timeline zoom' }).first();
    // role="status" is now the debounced sr-only announcement (#793): the visible
    // readout is aria-hidden and updates instantly, while this live region settles
    // to the final tier ~250ms after the last change. `toHaveText` auto-retries,
    // so it waits out the debounce.
    await expect(group.getByRole('status')).toHaveText('Week'); // default tier

    // Two geometric zoom-ins from week (12 px/day) cross into the day band.
    await group.getByRole('button', { name: 'Zoom in' }).click();
    await group.getByRole('button', { name: 'Zoom in' }).click();
    await expect(group.getByRole('status')).toHaveText('Day'); // settled tier after debounce

    // Fit-to-project control exists (⌘0).
    await expect(page.getByRole('button', { name: 'Fit schedule to window' }).first()).toBeVisible();
  });

  // Real-mouse middle-button drag pans the timeline end-to-end (#491, #805).
  //
  // This was fixme'd because both gesture variants deterministically landed
  // `scrollLeft === 0` in headless. Root cause (issue 805): unmocked shell/
  // toolbar endpoints 401 and the recovery `POST /auth/token/refresh/` — also
  // unmocked — 401s too, tripping `expireSession()`, which mounts
  // SessionExpiredBanner as a `fixed inset-0 z-[100]` overlay directly over the
  // canvas. Real pointer input (`page.mouse`) hit-tests to the topmost element,
  // so every event landed on the banner and never reached the interaction
  // canvas. It was never a GanttPanFSM or pointer-capture bug — the FSM is unit-
  // covered and works. With those endpoints now mocked in `gotoSchedule` the
  // banner never mounts, the canvas is hit-testable, and the genuine user
  // gesture drives `_onPointerDown → panFSM.start → _onPointerMove → scrollLeft`.
  test('drag pans the timeline horizontally (#491)', async ({ page }) => {
    const scroll = page.getByTestId('schedule-canvas-scroll');
    await expect(scroll).toBeVisible();

    // Wait for the engine to build a scrollable timeline (_rebuildScales forces
    // totalWidth >= 3 × viewport) before driving the pan — otherwise there is
    // nothing to scroll and the assertion would race the first paint.
    await expect
      .poll(async () =>
        scroll.evaluate((el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth),
      )
      .toBeGreaterThan(0);

    const box = await scroll.boundingBox();
    if (!box) throw new Error('canvas scroll container has no bounding box');
    const y = box.y + 14;
    const startX = box.x + box.width * 0.6;

    // Middle-button drag claims the gesture immediately (no arm step) and
    // bypasses the bar-drag FSM (rule 129). Dragging left reveals later dates,
    // so scrollLeft increases.
    await page.mouse.move(startX, y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(startX - 40, y, { steps: 4 });
    await page.mouse.move(startX - 200, y, { steps: 8 });
    await page.mouse.up({ button: 'middle' });

    // The scroll container actually scrolls — proves the pan FSM moved through
    // PANNING and the engine applied the delta to the real scroll container.
    await expect
      .poll(async () => scroll.evaluate((el) => (el as HTMLElement).scrollLeft))
      .toBeGreaterThan(0);
  });

  // Complementary integration check that drives the SAME engine path
  // (interaction-canvas pointerdown[middle] → _onPointerDown → panFSM.start →
  // pointermove → panFSM.move → container.scrollLeft) by dispatching synthetic
  // PointerEvents directly on the interaction canvas. It targets the canvas
  // element regardless of any overlay, so it isolates the component→engine→
  // scrollLeft wiring from real-mouse hit-testing. If this regresses, the pan is
  // broken at the seam independent of the real-gesture test above.
  test('middle-button pointer sequence pans the engine scrollLeft (#491, integration seam for #805)', async ({
    page,
  }) => {
    const scroll = page.getByTestId('schedule-canvas-scroll');
    await expect(scroll).toBeVisible();

    // Wait for the engine to build a scrollable timeline (_rebuildScales forces
    // totalWidth >= 3 × viewport, so scrollWidth exceeds clientWidth) before
    // driving the pan — otherwise there is nothing to scroll.
    await expect
      .poll(async () =>
        scroll.evaluate((el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth),
      )
      .toBeGreaterThan(0);

    const startScrollLeft = await scroll.evaluate((el) => (el as HTMLElement).scrollLeft);
    expect(startScrollLeft).toBe(0);

    // Dispatch the pointer sequence the engine listens for on the interaction
    // canvas. Middle button (button:1, buttons:4) claims the pan immediately and
    // bypasses the bar-drag FSM (rule 129). Two moves: the first arms/starts the
    // FSM, the second produces the delta that the engine subtracts from scrollLeft.
    const moved = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-layer="interaction"]');
      if (!canvas) return { ok: false, reason: 'no interaction canvas' };
      const rect = canvas.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const startX = rect.left + rect.width * 0.7;
      const opts = (clientX: number, buttons: number, button: number): PointerEventInit => ({
        pointerId: 1,
        pointerType: 'mouse',
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: y,
        button,
        buttons,
      });
      // setPointerCapture throws on a synthetic (non-active) pointer; swallow it so
      // the pan path continues — capture is not required to move scrollLeft.
      const originalCapture = canvas.setPointerCapture.bind(canvas);
      canvas.setPointerCapture = (id: number) => {
        try {
          originalCapture(id);
        } catch {
          /* synthetic pointer is not active in headless — pan does not need capture */
        }
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts(startX, 4, 1)));
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(startX - 40, 4, -1)));
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(startX - 200, 4, -1)));
      canvas.dispatchEvent(new PointerEvent('pointerup', opts(startX - 200, 0, 1)));
      return { ok: true };
    });
    expect(moved.ok, moved.reason).toBe(true);

    // Dragging content left (negative dx) increases scrollLeft — the engine applied
    // the pan delta to the real scroll container.
    await expect
      .poll(async () => scroll.evaluate((el) => (el as HTMLElement).scrollLeft))
      .toBeGreaterThan(0);
  });
});

/**
 * Task-edit error path (#1518). The plain Schedule view carries no server
 * mutation of its own — its Today/Fit/pan interactions are client-side scroll
 * state — but the task-edit write it fronts (the inline task-name PATCH surfaced
 * through the detail drawer) is a high-traffic mutation. useUpdateTask applies an
 * optimistic cache patch in onMutate and rolls it back in onError, so a 500 on
 * the PATCH must revert the grid row to its original name and leave the app
 * standing — not tear it down through the root error boundary.
 *
 * This describe uses its own richer setup because opening the drawer pulls the
 * caller's project role (members/?self) plus the drawer's section endpoints; the
 * catch-all is registered FIRST so the specific routes below win, and it returns
 * a benign empty-list shape (drawer sections read list-shaped endpoints).
 */
test.describe('Schedule task edit — failed rename rolls back (#1518)', () => {
  async function setupForEdit(page: import('@playwright/test').Page) {
    await page.addInitScript(() => {
      localStorage.setItem(
        'trueppm-auth',
        JSON.stringify({
          state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
          version: 0,
        }),
      );
    });

    const json = (body: unknown) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    const emptyList = { count: 0, next: null, previous: null, results: [] };

    // 401-guard safety net — registered FIRST so every specific route wins.
    await page.route('**/api/v1/**', (route) => route.fulfill(json(emptyList)));
    // `/me/active-sprints/` returns a BARE array (MyActiveSprintEntry[]), not a
    // paginated envelope. The shell's health popover sprint row and the ⌘K
    // "Current sprint" action (#1594, relocated in #1680) both read
    // `useCurrentSprintTargets`, which does `for (const e of myActiveSprints ?? [])`
    // — so the catch-all's `{count:0,…}` object above would be iterated as an object
    // and throw "(r ?? []) is not iterable", tripping the root error boundary and
    // unmounting the grid. Mock it with its real array shape.
    await page.route('**/api/v1/me/active-sprints/', (route) => route.fulfill(json([])));
    await page.route('**/api/v1/auth/me/', (route) =>
      route.fulfill(json({ id: 'u1', email: 'pm@example.com', first_name: 'P', last_name: 'M' })),
    );
    await page.route('**/api/v1/edition/', (route) => route.fulfill(json({ edition: 'community' })));
    // The always-mounted command palette (useCommandItems → useCurrentSprintTargets,
    // issue 1594) fires this fetch on every route regardless of palette open state.
    // useMyActiveSprints() returns res.data verbatim (a bare array, unlike the
    // paginated shape below) — without this route it falls through to the 401-guard
    // catch-all's `{count,...}` object, and `for (const entry of myActiveSprints ?? [])`
    // throws "is not iterable", crashing the whole app through the root error boundary.
    await page.route('**/api/v1/me/active-sprints/', (route) => route.fulfill(json([])));
    await page.route('**/api/v1/projects/', (route) =>
      route.fulfill(
        json({ count: FIXTURE_API_PROJECTS.length, next: null, previous: null, results: FIXTURE_API_PROJECTS }),
      ),
    );
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
      route.fulfill(
        json({
          id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01',
          calendar: 'default', estimation_mode: 'OPEN', agile_features: false, methodology: 'HYBRID', code: '',
          health: 'AUTO', visibility: 'WORKSPACE', timezone: '', default_view: 'SCHEDULE', lead: null,
          lead_detail: null, iteration_label: 'Sprint', is_archived: false, archived_at: null, archived_by: null,
          recalculated_at: null, is_sample: false, program_detail: null, server_version: 1,
        }),
      ),
    );
    await page.route('**/api/v1/projects/*/presence/', (route) => route.fulfill(json([])));
    await page.route('**/api/v1/projects/*/status-summary/', (route) =>
      route.fulfill(
        json({
          task_count: 0, critical_path_count: 0, monte_carlo_p80: null, at_risk_count: 0,
          critical_count: 0, at_risk_tasks: [], critical_tasks: [], last_saved: null, recalculated_at: null,
        }),
      ),
    );
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
      route.fulfill(
        json({
          schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0,
          total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null,
          owner_name: null, start_date: '2026-01-01',
        }),
      ),
    );
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
      route.fulfill(json({ items: [] })),
    );
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
      route.fulfill(json({ tasks: [] })),
    );
    // The drawer gates its editable title off the caller's project role
    // (members/?self). Role 300 (Admin) makes the title editable so the rename
    // fires; without this the input renders read-only and never PATCHes.
    await page.route('**/api/v1/projects/*/members/**', (route) =>
      route.fulfill(json([{ id: 'mem-self', role: 300 }])),
    );
    await page.route('**/api/v1/dependencies/**', (route) => route.fulfill(json(emptyList)));
    await page.route('**/api/v1/task-resources/**', (route) => route.fulfill(json(emptyList)));
    await page.route('**/api/v1/resources/**', (route) => route.fulfill(json(emptyList)));

    // Task list — the GET the grid reads. Registered before the PATCH override.
    await page.route('**/api/v1/tasks/**', (route) =>
      route.fulfill(
        json({ count: FIXTURE_API_TASKS.length, next: null, previous: null, results: FIXTURE_API_TASKS }),
      ),
    );

    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
  }

  test('a failed task rename reverts the grid row and does not crash the view', async ({ page }) => {
    await setupForEdit(page);
    // The task-update PATCH 500s; the GET list falls through to the handler above,
    // so the grid keeps rendering.
    let patchAttempts = 0;
    await page.route('**/api/v1/tasks/*/', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchAttempts += 1;
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"detail":"boom"}',
        });
      }
      return route.fallback();
    });

    const grid = page.getByRole('grid', { name: 'Task list' });
    await expect(grid).toBeVisible({ timeout: 10_000 });

    // Open the detail drawer for the task and rename it via the editable title.
    await grid.getByText('Discovery & Design', { exact: true }).click();
    const drawer = page.getByRole('dialog', { name: /Discovery & Design/ });
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    const title = drawer.getByRole('textbox', { name: 'Task name' });
    await expect(title).toHaveValue('Discovery & Design');
    await title.fill('Renamed — will fail to save');
    // #1977: the name stages behind the Save bar — clicking Save fires the PATCH
    // (blur no longer auto-saves).
    await drawer.getByRole('button', { name: 'Save' }).click();

    // The PATCH fired and failed. useUpdateTask rolled the optimistic cache patch
    // back, so the grid row is once again the original name (the phantom rename
    // never sticks), and the drawer + grid are intact — no error boundary.
    await expect.poll(() => patchAttempts).toBeGreaterThan(0);
    await expect(grid.getByText('Discovery & Design', { exact: true })).toBeVisible();
    await expect(grid.getByText('Renamed — will fail to save')).toHaveCount(0);
    await expect(drawer).toBeVisible();
  });
});

// The mobile Schedule surface below md is a dedicated DOM list-timeline
// (#1671, ADR-0348), not the desktop canvas. Its E2E coverage lives in
// e2e/mobile-schedule.spec.ts. The former #1670 "canvas full-width on mobile"
// describe and the #1787 fitted-viewport / collapsed-toolbar tests were removed
// here when the canvas (and its toolbar) stopped rendering below md.
