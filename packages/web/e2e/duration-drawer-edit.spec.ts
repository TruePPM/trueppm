/**
 * Task detail drawer — editable Duration cell (#2106, ADR-0515).
 *
 * The schedule "vitals" strip (Start · Finish · Duration · Float) used to be a
 * fully read-only grid; the only way to change a task's duration was to drag the
 * Gantt bar's resize handle. The Duration cell is now an inline click-to-edit
 * field that commits IMMEDIATELY via PATCH /tasks/:id/ (mirroring build mode) and
 * lets the strip refresh to the recomputed dates. Editing is gated on can_edit,
 * suppressed for milestones, and rejects invalid input inline (web-rule 225); a
 * server span-cap 400 (#1862) surfaces inline.
 *
 * Host: the Sprints backlog (SprintsView) — the simplest deterministic host for
 * this drawer (a backlog ROW is a plain "Open <name>" button that opens the
 * shared TaskDetailDrawer directly, no canvas hit-testing / drag layer). Mock
 * scaffold mirrors e2e/task-drawer-estimate-batch.spec.ts.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

const PROJECT_ID = 'e2e-dur-edit-00000000-0000-0000-0000-000000002106';
const TASK_ID = 'dur-task-a';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Duration Edit Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Duration Edit Project',
  description: '',
  start_date: '2026-04-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
  // Default duration-change policy — 'keep' means a duration edit never raises
  // the ADR-0151 recalc-% prompt, keeping these assertions deterministic.
  effective_task_duration_change_percent_policy: 'keep',
};

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'C0FF',
  short_id_display: 'SP-C0FF',
  name: 'Telemetry & FAT prep',
  goal: 'Close out telemetry firmware sweep.',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  committed_points: 40,
  committed_task_count: 18,
  completed_points: 14,
  completed_task_count: 6,
  completion_ratio_points: 0.35,
  completion_ratio_tasks: 0.33,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-04T12:00:00Z',
};

const BACKLOG_TASKS = [
  {
    id: TASK_ID,
    short_id: 'A1',
    name: 'Calibrate sensors',
    wbs_path: '1.1',
    status: 'IN_PROGRESS',
    story_points: 5,
    is_critical: false,
    assignments: [],
  },
];

function fullTasks(duration: number) {
  return [
    {
      id: TASK_ID,
      name: 'Calibrate sensors',
      wbs_path: '1.1',
      status: 'IN_PROGRESS',
      parent_id: null,
      notes: '',
      early_start: '2026-04-05',
      early_finish: '2026-04-10',
      planned_start: '2026-04-05',
      duration,
      percent_complete: 0,
      is_critical: false,
      is_milestone: false,
      is_summary: false,
      assignees: [],
      total_float: 4,
      // Deliberately different from `total_float` so the Float cell renders the
      // `free 2d` chip (#3344) — the widest this cell ever gets, and therefore
      // the case the strip's fit has to be measured against.
      free_float: 2,
      predecessor_count: 0,
      is_blocked: false,
      linked_risks_count: 0,
      linked_risks_max_severity: null,
      can_edit: true,
    },
  ];
}

/**
 * Install the shared mock scaffold. `state.duration` is the single source of
 * truth for the task's duration across the GET task lists AND the PATCH
 * response, so a committed edit is reflected by the post-mutation refetch
 * (['tasks'] invalidation) rather than snapping back to the seed value.
 * `state.failMessage` forces the next PATCH to 400 with a `{duration:[…]}` body.
 */
async function setup(page: Page) {
  const state = { duration: 5, failMessage: null as string | null };
  const patches: Array<Record<string, unknown>> = [];

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

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROJECT_DETAIL),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] }),
    }),
  );
  await page.route(`**/api/v1/sprints/${ACTIVE_SPRINT.id}/burndown/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sprint: ACTIVE_SPRINT, snapshots: [] }),
    }),
  );
  await page.route(`**/api/v1/sprints/${ACTIVE_SPRINT.id}/capacity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        members: [],
        totals: {
          committed_hours: 0,
          available_hours: 0,
          ratio: 0,
          buffer_hours: 0,
          label: 'on_track',
          pto_days: 0,
        },
        working_days: 0,
        hours_per_day: 8,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sprints: [],
        rolling_avg_points: null,
        rolling_stdev_points: null,
        forecast_range_low: null,
        forecast_range_high: null,
        rolling_avg_tasks: null,
        rolling_stdev_tasks: null,
      }),
    }),
  );

  // PATCH /tasks/:id/ — captured; success updates the shared duration, a forced
  // failMessage returns the server span-cap 400 shape (#1862). Registered before
  // the GET task-list routes but after setupCatchAll; the URL regex excludes
  // query strings so the GET lists never match here.
  await page.route(/\/api\/v1\/tasks\/[^/?]+\/$/, async (route) => {
    const req = route.request();
    if (req.method() !== 'PATCH') return route.fallback();
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    patches.push(body);
    if (state.failMessage) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ duration: [state.failMessage] }),
      });
      return;
    }
    if (typeof body.duration === 'number') state.duration = body.duration;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: TASK_ID,
        name: 'Calibrate sensors',
        project: PROJECT_ID,
        wbs_path: '1.1',
        duration: state.duration,
        status: 'IN_PROGRESS',
        percent_complete: 0,
      }),
    });
  });

  // Catch-all /tasks/ (empty list), then the specific project task list — last
  // registered wins in Playwright, so the specific matches take precedence.
  await page.route(/\/api\/v1\/tasks\//, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    });
  });
  await page.route(/\/api\/v1\/tasks\/\?(?!.*sprint=).*project=/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: fullTasks(state.duration),
      }),
    }),
  );
  await page.route(/\/api\/v1\/tasks\/.*sprint=sp-active/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: BACKLOG_TASKS.length,
        next: null,
        previous: null,
        results: BACKLOG_TASKS,
      }),
    }),
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
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        username: 'e2e',
        display_name: 'E2E',
        initials: 'E',
        email: 'e2e@example.com',
      }),
    }),
  );
  await page.route(/\/api\/v1\/projects\/[^/]*\/members\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300, role_label: 'Admin' }]),
    }),
  );
  await page.route(/\/api\/v1\/tasks\/[^/]+\/velocity-suggestions\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );

  return { state, patches };
}

/** Open the backlog row's drawer and gate on the drawer's reads resolving. */
async function openDrawer(page: Page) {
  const backlog = page.getByRole('region', { name: /Sprint Backlog/i });
  await backlog.getByRole('button', { name: /Open Calibrate sensors/i }).click();
  const drawer = page.getByRole('dialog', { name: /Calibrate sensors/i });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel('Task name')).toHaveValue('Calibrate sensors');
  return drawer;
}

test.describe('#2106 — editable Duration in the task detail drawer', () => {
  test('typing a new duration and pressing Enter commits it via PATCH', async ({ page }) => {
    const { patches } = await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);

    // At rest, Duration is an edit button (not a plain read-only cell).
    const durationButton = drawer.getByRole('button', { name: /Duration, 5 days\. Edit\./ });
    await expect(durationButton).toBeVisible();
    await durationButton.click();

    const input = drawer.getByRole('textbox', { name: 'Duration in days' });
    await input.fill('12');
    await input.press('Enter');

    // Exactly one PATCH carrying just the duration (id/projectId build the URL,
    // they are stripped from the body by the mutation).
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ duration: 12 });

    // The strip refreshes to the recomputed value (stateful mock), and the
    // commit is announced on the live region.
    await expect(drawer.getByRole('button', { name: /Duration, 12 days\. Edit\./ })).toBeVisible();
    // The commit is announced on the visually-hidden (sr-only) live region.
    await expect(drawer.getByText('Duration set to 12 days. Schedule updated.')).toBeAttached();
  });

  test('invalid input is rejected inline without a PATCH (rule 225)', async ({ page }) => {
    const { patches } = await setup(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    await drawer.getByRole('button', { name: /Duration, 5 days/ }).click();

    const input = drawer.getByRole('textbox', { name: 'Duration in days' });
    await input.fill('abc');
    await input.press('Enter');

    await expect(drawer.getByRole('alert')).toContainText(/whole number of days/i);
    // Still in edit mode so the user can fix it; nothing was written.
    await expect(drawer.getByRole('textbox', { name: 'Duration in days' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(patches).toHaveLength(0);
  });

  test('a server span-cap 400 surfaces inline (#1862)', async ({ page }) => {
    const { state } = await setup(page);
    state.failMessage = 'Project span cannot exceed the maximum.';
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    await drawer.getByRole('button', { name: /Duration, 5 days/ }).click();

    const input = drawer.getByRole('textbox', { name: 'Duration in days' });
    await input.fill('9999');
    await input.press('Enter');

    await expect(drawer.getByRole('alert')).toContainText(
      'Project span cannot exceed the maximum.',
    );
  });
});

/**
 * #3211 — the unit picker must never overflow the Duration cell.
 *
 * The vitals strip is a `grid-cols-4`, which sizes each TRACK `minmax(0, 1fr)`
 * but leaves each ITEM at `min-width: auto` — so a cell wider than its track
 * overflows into its neighbour rather than shrinking, and nothing clips it. With
 * the picker laid out BESIDE the duration button, this cell's min-content was
 * 169.6px against a 126.25px track in the 540px drawer, and the 43px of overflow
 * painted over the Float cell's label and value.
 *
 * These assert the geometry, not `toBeVisible()` — the picker and the Float cell
 * both had boxes and both passed `toBeVisible()` on the broken build (web rule
 * 354(e)). The invariant is that their boxes do not intersect.
 */
test.describe('#3211 — the duration unit picker stays inside its cell', () => {
  test('the picker does not overlap the Float cell in the 540px drawer', async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    const picker = drawer.getByRole('radiogroup', { name: 'Duration unit' });
    const floatCell = drawer.getByRole('group', { name: 'Float' });
    await expect(picker).toBeVisible();
    await expect(floatCell).toBeVisible();

    const pickerBox = (await picker.boundingBox())!;
    const floatBox = (await floatCell.boundingBox())!;
    expect(pickerBox).not.toBeNull();
    expect(floatBox).not.toBeNull();

    // The whole picker sits left of where the Float cell begins.
    expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(floatBox.x);
  });

  test('the Duration cell does not overflow its grid track', async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    const durationCell = drawer.getByRole('group', { name: 'Float' })
      .locator('xpath=preceding-sibling::div[1]');
    const picker = drawer.getByRole('radiogroup', { name: 'Duration unit' });

    const cellBox = (await durationCell.boundingBox())!;
    const pickerBox = (await picker.boundingBox())!;

    // The picker is contained by the cell on both axes. The right edge is the one
    // that regressed; the left is asserted so a future fix cannot satisfy this by
    // pushing the picker out of the other side of the cell.
    expect(pickerBox.x).toBeGreaterThanOrEqual(cellBox.x);
    expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width);
  });

  test('the picker still commits a unit change from its stacked position', async ({ page }) => {
    const { patches } = await setup(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    await drawer.getByRole('radio', { name: 'Hours' }).click();

    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ duration_unit: 'hours' });
  });

  test('the strip is the same height at rest and while editing', async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    const frame = drawer
      .getByRole('group', { name: 'Float' })
      .locator('xpath=ancestor::div[contains(@class,"rounded-card")][1]');

    const atRest = (await frame.boundingBox())!.height;
    await drawer.getByRole('button', { name: /Duration, 5 days/ }).click();
    await expect(drawer.getByRole('textbox', { name: 'Duration in days' })).toBeVisible();
    const editing = (await frame.boundingBox())!.height;

    // Stacked, an edit-mode cell that dropped the picker collapsed the strip by
    // 35px and re-expanded on commit, jumping every drawer section below it.
    // The tolerance is the input's own 1px border, which is not a layout jump —
    // it is deliberately far below the 35px regression this pins.
    expect(Math.abs(editing - atRest)).toBeLessThanOrEqual(2);
  });

  test('the picker is still clickable while the duration input is open', async ({ page }) => {
    const { patches } = await setup(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    await drawer.getByRole('button', { name: /Duration, 5 days/ }).click();
    await expect(drawer.getByRole('textbox', { name: 'Duration in days' })).toBeVisible();

    // The input's onBlur commits and leaves edit mode, and blur fires on
    // mousedown — so if the picker unmounted with the branch it would be gone
    // before mouseup and no click would ever fire.
    await drawer.getByRole('radio', { name: 'Hours' }).click();

    await expect.poll(() => patches.filter((b) => 'duration_unit' in b).length).toBe(1);
    expect(patches.find((b) => 'duration_unit' in b)).toEqual({ duration_unit: 'hours' });
  });
});

/**
 * The Duration cell's grid item and the box the picker actually has to fit in.
 *
 * The cell wrapper is the grid item (`Float`'s preceding sibling); the picker's
 * own parent is the `px-3.5 pb-2.5` row inside it, and *that* row's content box
 * is the real constraint — the wrapper's box includes padding the picker can
 * never use, so measuring against it would overstate the room by 28px and this
 * whole assertion would go slack exactly where #3211 went wrong.
 */
async function pickerFit(picker: ReturnType<Page['getByRole']>) {
  return picker.evaluate((el) => {
    const row = el.parentElement;
    if (!row) throw new Error('picker has no parent row');
    const cs = getComputedStyle(row);
    const content =
      row.clientWidth -
      Number.parseFloat(cs.paddingLeft) -
      Number.parseFloat(cs.paddingRight);
    return { picker: el.getBoundingClientRect().width, content, slack: content - el.getBoundingClientRect().width };
  });
}

/**
 * #3212 — the `d` / `h` radios under a coarse pointer.
 *
 * `hasTouch` + `isMobile` are what make `(pointer: coarse)` actually match; a
 * bare `setViewportSize` leaves Chromium on a fine pointer and the whole block
 * would assert the 28px behaviour while claiming to assert the 44px one (the
 * trap `schedule-coarse-row-height.spec.ts` records for the same reason). The
 * viewport stays at 1280 so the drawer is still the ≥ md 540px slide-in — the
 * geometry the acceptance criteria are written against, and the tightest one:
 * a tablet in landscape is a coarse pointer at a desktop width.
 *
 * This lives here rather than in `schedule-coarse-row-height.spec.ts` because
 * the control lives in the task drawer, and the size assertion and the fit
 * assertion have to read the SAME layout — a 44px floor proven in one host and a
 * fit proven in another proves neither. That spec's header points here.
 *
 * Every assertion below is a browser measurement. jsdom resolves no lengths at
 * all, so `DurationUnitPicker.test.tsx` can pin the custom property and the class
 * shape and nothing else (web rule 330(c)); this is the only instrument that can
 * read the resulting box.
 */
test.describe('#3212 — the unit picker meets the 44px touch floor on a finger', () => {
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: true, isMobile: true });

  test('each radio is at least 44x44, and the drawer is the 540px one', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    // Pinned first: the 540px shell is the constraint the fit test below is
    // about, and a coarse run that had silently fallen through to the mobile
    // bottom sheet would satisfy the size assertions while measuring a
    // different layout entirely.
    const drawerBox = (await drawer.boundingBox())!;
    expect(drawerBox.width, 'the ≥ md slide-in').toBeCloseTo(540, 0);

    for (const name of ['Days', 'Hours']) {
      const box = (await drawer.getByRole('radio', { name }).boundingBox())!;
      // Web rule 5 / WCAG 2.5.5, on the only pointer route to switching a task
      // between days and hours. `>=` because the floor is the requirement; the
      // exact value is pinned by the custom property below.
      expect(box.width, `"${name}" width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `"${name}" height`).toBeGreaterThanOrEqual(44);
    }
  });

  test('the size comes from the row-height owner, resolved at runtime', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    const picker = drawer.getByRole('radiogroup', { name: 'Duration unit' });
    // The measured box above could be 44 for any number of reasons — a padding,
    // a min-height, a literal somebody typed. This is the assertion that says it
    // is 44 *because the row model resolved 44 for this pointer class*, which is
    // the acceptance criterion the box size alone cannot express.
    const resolved = await picker.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--unit-segment-size').trim(),
    );
    expect(resolved).toBe('44px');
  });

  test('the picker still fits its cell at 540px — measured, not assumed', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    const picker = drawer.getByRole('radiogroup', { name: 'Duration unit' });
    await expect(picker).toBeVisible();

    // At 44px the group is 2 × 44 + its own 2 × 1px border = 90px against a
    // ~97px content box. That margin is single digits, which is exactly why it
    // is measured: #3211 is the issue that exists because this cell's width was
    // reasoned about rather than read out of a browser.
    const fit = await pickerFit(picker);
    expect(
      fit.slack,
      `picker ${fit.picker}px in a ${fit.content}px content box`,
    ).toBeGreaterThanOrEqual(0);
    // Non-vacuous: a picker that had collapsed (or a content box measured off
    // the wrong element) would pass the slack check trivially.
    expect(fit.picker, 'the pair, at the floor, plus the group border').toBeGreaterThanOrEqual(90);
  });

  test('growing to 44px does not re-break #3211 — no overlap onto Float', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    const picker = drawer.getByRole('radiogroup', { name: 'Duration unit' });
    const floatCell = drawer.getByRole('group', { name: 'Float' });
    const durationCell = floatCell.locator('xpath=preceding-sibling::div[1]');

    const pickerBox = (await picker.boundingBox())!;
    const floatBox = (await floatCell.boundingBox())!;
    const cellBox = (await durationCell.boundingBox())!;

    // The #3211 invariant, re-asserted at the larger size. The picker got 24px
    // wider on this pointer class, and that is precisely the change that could
    // put it back over the Float cell's label — where `toBeVisible()` would
    // still pass on both (web rule 354(e)).
    expect(pickerBox.x).toBeGreaterThanOrEqual(cellBox.x);
    expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width);
    expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(floatBox.x);
  });

  test('a TAP on the bigger target actually commits the unit', async ({ page }) => {
    const { patches } = await setup(page);
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    // The floor is not the point on its own — being able to hit the thing is.
    // `tap()` rather than `click()`: this context has `hasTouch`, and the
    // gesture under test is the one a tablet user makes.
    await drawer.getByRole('radio', { name: 'Hours' }).tap();

    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ duration_unit: 'hours' });
  });
});

/**
 * The phone, which is the OTHER coarse pointer and the one the 540px assertions
 * above cannot see (#3212).
 *
 * Below `md` the drawer is the 85vh bottom sheet, not the 540px slide-in, and
 * the vitals strip is 356px wide there. Four tracks made each cell an 89px box
 * with a 60px content area — already 6px too narrow for the 66px picker before
 * this change, and 30px too narrow for the 90px one after it. The strip is
 * therefore two-up below `md`, and these are the assertions that say the touch
 * floor was paid for out of the layout rather than out of the Float cell.
 *
 * Measured on both axes because the failure is silent: the grid item is
 * `min-w-0` and the picker is `shrink-0`, so an overflow neither clips nor
 * scrolls — it paints straight over the neighbouring cell, and every element
 * involved still passes `toBeVisible()` (web rule 354(e)).
 */
test.describe('#3212 — the picker fits the phone bottom sheet too', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the radios keep the 44px floor in the sheet', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    for (const name of ['Days', 'Hours']) {
      const box = (await drawer.getByRole('radio', { name }).boundingBox())!;
      expect(box.width, `"${name}" width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `"${name}" height`).toBeGreaterThanOrEqual(44);
    }
  });

  test('and the cell is wide enough to hold them', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    const picker = drawer.getByRole('radiogroup', { name: 'Duration unit' });
    const fit = await pickerFit(picker);
    expect(
      fit.slack,
      `picker ${fit.picker}px in a ${fit.content}px content box`,
    ).toBeGreaterThanOrEqual(0);
  });

  test('the picker does not paint over the Float cell', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    const pickerBox = (await drawer
      .getByRole('radiogroup', { name: 'Duration unit' })
      .boundingBox())!;
    const floatBox = (await drawer.getByRole('group', { name: 'Float' }).boundingBox())!;

    // Two-up, Float sits to the RIGHT of Duration on the strip's second row, so
    // this is the same non-intersection claim the 540px case makes — asserted on
    // boxes rather than on a column count, so it survives a different answer to
    // "how should a 356px strip lay out" as long as that answer still fits.
    const overlapsHorizontally =
      pickerBox.x < floatBox.x + floatBox.width && floatBox.x < pickerBox.x + pickerBox.width;
    const overlapsVertically =
      pickerBox.y < floatBox.y + floatBox.height && floatBox.y < pickerBox.y + pickerBox.height;
    expect(overlapsHorizontally && overlapsVertically, 'picker/Float boxes intersect').toBe(false);
  });
});

/**
 * The counterweight. A change that made every desktop segment 44px would satisfy
 * every assertion above and cost the planner a third of the vitals strip — the
 * same trade `schedule-coarse-row-height.spec.ts` guards for the row itself.
 */
test.describe('#3212 — a mouse keeps the compact picker', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('each radio is the row model\'s fine height, square', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    for (const name of ['Days', 'Hours']) {
      const box = (await drawer.getByRole('radio', { name }).boundingBox())!;
      expect(box.width, `"${name}" width`).toBeCloseTo(28, 0);
      expect(box.height, `"${name}" height`).toBeCloseTo(28, 0);
    }
  });

  test('and therefore has MORE room in the cell than the coarse one', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const drawer = await openDrawer(page);
    const fit = await pickerFit(drawer.getByRole('radiogroup', { name: 'Duration unit' }));
    expect(fit.slack, `picker ${fit.picker}px in a ${fit.content}px content box`).toBeGreaterThan(
      0,
    );
  });
});


/**
 * The Float cell grew a second value (#3344), and web rule 366 says a control's
 * width is a claim on a box somebody else owns — so the claim gets measured, in a
 * browser, at every shell the strip renders in.
 *
 * `TaskDetailDrawer` renders its content TWICE: a `hidden md:flex` 540px slide-in
 * and a `md:hidden` 85vh bottom sheet. The strip is `grid-cols-2 md:grid-cols-4`,
 * which makes those two layouts a ~97px and a ~149px content box per cell, and the
 * free-float chip rides inside the existing Float cell rather than becoming a
 * fifth track precisely because a fifth track fits in neither.
 *
 * `toBeVisible()` cannot see the failure this guards: the grid item is `min-w-0`
 * and the chips are `shrink-0`, so an overflowing cell neither clips nor scrolls —
 * it paints over its neighbour, and both keep boxes and both stay "visible" (rule
 * 366(c)). Assert NON-INTERSECTION of the boxes instead. jsdom resolves no
 * lengths, so the vitest half of this can only pin the suppression logic.
 */
async function assertFloatCellFits(page: Page) {
  const drawer = page.getByRole('dialog', { name: /Calibrate sensors/i });
  const floatCell = drawer.getByRole('group', { name: 'Float' }).first();
  await expect(floatCell).toBeVisible();
  const floatBox = await floatCell.boundingBox();
  expect(floatBox).not.toBeNull();

  // The chip is inside its own cell, not spilling past the cell's right edge.
  const chip = floatCell.getByText('free 2d');
  await expect(chip).toBeVisible();
  const chipBox = await chip.boundingBox();
  expect(chipBox).not.toBeNull();
  expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(floatBox!.x + floatBox!.width + 1);
  expect(chipBox!.x).toBeGreaterThanOrEqual(floatBox!.x - 1);

  // …and no two cells of the strip overlap. Taken from the grid itself rather
  // than from two named cells, because the neighbour differs by layout: the
  // Duration cell is a `<button>` in the editable strip and a plain `Cell` in the
  // read-only one, and the two-up shell puts a different cell beside Float than
  // the four-up one does. Comparing every same-row pair is the assertion that
  // survives both.
  const overlaps = await floatCell.evaluate((cell) => {
    const grid = cell.parentElement?.parentElement;
    if (!grid) return ['no grid'];
    const boxes = Array.from(grid.children).map((el) => {
      const r = el.getBoundingClientRect();
      return { r, label: el.textContent?.slice(0, 16) ?? '' };
    });
    const bad: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const sameRow = Math.abs(a.r.top - b.r.top) < 4;
        const xOverlap = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        if (sameRow && xOverlap > 1) bad.push(`${a.label} / ${b.label} overlap ${xOverlap}px`);
      }
    }
    return bad;
  });
  expect(overlaps).toEqual([]);
}

test.describe('#3344 — free float fits the Float cell in the 540px slide-in', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('the free-float chip stays inside its cell at the four-up strip', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);
    await openDrawer(page);
    await assertFloatCellFits(page);
  });
});

test.describe('#3344 — free float fits the Float cell in the phone bottom sheet', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the free-float chip stays inside its cell at the two-up strip', async ({ page }) => {
    // The narrow shell, where rule 366 measured a 149px content box and where a
    // fix that only fits the tablet would have moved the failure onto the device
    // the touch floor exists for.
    await setup(page);
    await page.goto(BASE_URL);
    await openDrawer(page);
    await assertFloatCellFits(page);
  });
});
