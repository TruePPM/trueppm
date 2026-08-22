/**
 * Cadence generator E2E (#2968).
 *
 * The flow that matters is preview-then-commit: the wizard asks the server for a
 * `dry_run` cadence, renders it as editable rows, and only writes when the
 * operator presses Generate. This spec drives that end to end, edits a row in
 * between, and asserts the committed payload carries the edit — plus the two
 * guarantees that are easy to regress silently: a second submit creates nothing,
 * and the suggested capacity is never applied unless it is ticked on.
 */
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-gen-cadence-0000-0000-0000-000000002968';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Cadence Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Cadence Project',
  description: '',
  start_date: '2026-04-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
};

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'A1',
  short_id_display: 'SP-A1',
  name: 'Active sprint',
  goal: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: null,
  wip_limit: null,
  committed_points: 20,
  committed_task_count: 0,
  completed_points: 0,
  completed_task_count: 0,
  completion_ratio_points: 0,
  completion_ratio_tasks: 0,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

function row(
  name: string,
  start: string,
  finish: string,
  status: 'new' | 'exists' | 'created' = 'new',
) {
  return {
    name,
    start_date: start,
    finish_date: finish,
    working_days: 10,
    non_working_days_skipped: 4,
    status,
    id: status === 'created' ? `id-${name}` : null,
  };
}

const CAPACITY_HINT = {
  points: 24,
  basis: 'velocity_average',
  sprints_sampled: 3,
  note: "A starting point drawn from this team's own closed iterations — not a limit. The team decides what it commits to.",
};

interface GenerateBody {
  dry_run?: boolean;
  count?: number;
  sprints?: Array<{ name: string; start_date: string; finish_date: string }>;
  first_sprint_capacity_points?: number | null;
}

/**
 * Stateful generate mock: the preview answers from the request's `count`, and a
 * commit records the payload and then reports every name as `exists` on any
 * later call — the server's real idempotency-on-name behavior, which a stateless
 * mock cannot reproduce and which this spec asserts against.
 */
async function setupGenerateRoute(
  page: import('@playwright/test').Page,
  sink: { commits: GenerateBody[] },
): Promise<void> {
  const created = new Set<string>();
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/generate/`, async (route) => {
    const body = route.request().postDataJSON() as GenerateBody;
    if (body.dry_run) {
      const count = body.count ?? 2;
      const rows = Array.from({ length: count }, (_, i) =>
        row(
          `Sprint ${i + 1}`,
          `2026-04-${String(6 + i * 14).padStart(2, '0')}`,
          `2026-04-${String(17 + i * 14).padStart(2, '0')}`,
          created.has(`Sprint ${i + 1}`) ? 'exists' : 'new',
        ),
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          dry_run: true,
          sprints: rows,
          created_count: rows.filter((r) => r.status === 'new').length,
          skipped_count: rows.filter((r) => r.status === 'exists').length,
          capacity_hint: CAPACITY_HINT,
        }),
      });
      return;
    }
    sink.commits.push(body);
    const rows = (body.sprints ?? []).map((r) => {
      const already = created.has(r.name);
      if (!already) created.add(r.name);
      return row(r.name, r.start_date, r.finish_date, already ? 'exists' : 'created');
    });
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        dry_run: false,
        sprints: rows,
        created_count: rows.filter((r) => r.status === 'created').length,
        skipped_count: rows.filter((r) => r.status === 'exists').length,
        capacity_hint: CAPACITY_HINT,
      }),
    });
  });
}

async function setupCommon(page: import('@playwright/test').Page): Promise<void> {
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

  // Catch-all FIRST — an unmocked endpoint must return a typed 404 rather than
  // 401ing into the session-teardown path. Routes registered below win.
  await setupCatchAll(page);

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: FIXTURE_PROJECTS,
      }),
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
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [ACTIVE_SPRINT],
      }),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sprint: ACTIVE_SPRINT, snapshots: [] }),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (route) =>
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
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"detail":"None"}',
    }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    }),
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
  // `/members/**` so the `?self=true` role query matches too — the header's
  // lifecycle chrome, including the Generate trigger, is SCHEDULER+ gated.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300 }]),
    }),
  );
}

/** Open the wizard and reach the editable preview with `count` rows. */
async function openPreview(
  page: import('@playwright/test').Page,
  count = 2,
): Promise<import('@playwright/test').Locator> {
  await page.goto(BASE_URL);
  // Gate on the header having rendered before touching its chrome — the page is
  // data-driven, and clicking before the reads resolve tears the button out
  // mid-click.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Generate a run of sprints/i }).click();

  const dialog = page.getByRole('dialog', { name: /Generate sprints/i });
  await expect(dialog).toBeVisible();

  const countField = dialog.getByLabel(/How many sprints/i);
  await countField.fill(String(count));
  await dialog.getByRole('button', { name: /^Preview$/ }).click();
  return dialog;
}

test.describe('Sprint cadence generator', () => {
  test('previews before writing, and commits the operator’s edit', async ({ page }) => {
    const sink: { commits: GenerateBody[] } = { commits: [] };
    await setupCommon(page);
    await setupGenerateRoute(page, sink);

    const previewRequest = page.waitForRequest(
      (req) =>
        req.url().includes(`/projects/${PROJECT_ID}/sprints/generate/`) &&
        req.method() === 'POST',
    );

    const dialog = await openPreview(page, 2);

    // The first call is a dry run — nothing is written yet.
    const req = await previewRequest;
    expect((req.postDataJSON() as GenerateBody).dry_run).toBe(true);
    expect(sink.commits).toHaveLength(0);

    // The preview is editable.
    await expect(dialog.getByLabel(/Name for row 1/i)).toHaveValue('Sprint 1');
    await dialog.getByLabel(/Name for row 1/i).fill('Hardening');
    await dialog.getByLabel(/Finish date for row 1/i).fill('2026-04-20');

    await dialog.getByRole('button', { name: /Generate 2 sprints/i }).click();
    await expect(dialog).toBeHidden();

    expect(sink.commits).toHaveLength(1);
    const committed = sink.commits[0];
    expect(committed.sprints?.map((r) => r.name)).toEqual(['Hardening', 'Sprint 2']);
    expect(committed.sprints?.[0].finish_date).toBe('2026-04-20');
    // Never applied unless the operator ticked it on.
    expect(committed.first_sprint_capacity_points).toBeUndefined();
  });

  test('shows the suggested capacity as an opt-in with its bounding sentence', async ({
    page,
  }) => {
    const sink: { commits: GenerateBody[] } = { commits: [] };
    await setupCommon(page);
    await setupGenerateRoute(page, sink);

    const dialog = await openPreview(page, 2);

    await expect(dialog.getByText(/not a limit/i)).toBeVisible();
    const optIn = dialog.getByRole('checkbox');
    await expect(optIn).not.toBeChecked();

    await optIn.check();
    await dialog.getByRole('button', { name: /Generate 2 sprints/i }).click();
    await expect(dialog).toBeHidden();

    expect(sink.commits[0].first_sprint_capacity_points).toBe(24);
  });

  test('a second run creates nothing — generation is idempotent on name', async ({
    page,
  }) => {
    const sink: { commits: GenerateBody[] } = { commits: [] };
    await setupCommon(page);
    await setupGenerateRoute(page, sink);

    const first = await openPreview(page, 2);
    await first.getByRole('button', { name: /Generate 2 sprints/i }).click();
    await expect(first).toBeHidden();

    const second = await openPreview(page, 2);
    await expect(
      second.getByText(/already exist and will be left alone/i),
    ).toBeVisible();
    // Nothing left to create, so the commit button is unavailable.
    await expect(second.getByRole('button', { name: /^Generate 0 /i })).toBeDisabled();
    expect(sink.commits).toHaveLength(1);
  });

  test('refuses a name pattern with no {n} token', async ({ page }) => {
    const sink: { commits: GenerateBody[] } = { commits: [] };
    await setupCommon(page);
    await setupGenerateRoute(page, sink);

    await page.goto(BASE_URL);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /Generate a run of sprints/i }).click();

    const dialog = page.getByRole('dialog', { name: /Generate sprints/i });
    await dialog.getByLabel(/Name pattern/i).fill('Sprint');

    await expect(dialog.getByRole('alert')).toContainText('{n}');
    await expect(dialog.getByRole('button', { name: /^Preview$/ })).toBeDisabled();
    expect(sink.commits).toHaveLength(0);
  });

  test('surfaces a server rejection without closing the wizard', async ({ page }) => {
    await setupCommon(page);
    await page.route(
      `**/api/v1/projects/${PROJECT_ID}/sprints/generate/`,
      async (route) => {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            detail: "This project's calendar has no working day.",
          }),
        });
      },
    );

    await page.goto(BASE_URL);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /Generate a run of sprints/i }).click();

    const dialog = page.getByRole('dialog', { name: /Generate sprints/i });
    await dialog.getByRole('button', { name: /^Preview$/ }).click();

    await expect(dialog.getByRole('alert')).toContainText(/Could not work out/i);
    await expect(dialog).toBeVisible();
  });
});
