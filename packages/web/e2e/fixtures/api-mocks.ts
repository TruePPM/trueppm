import type { Page } from '@playwright/test';

/**
 * Shared Playwright API mocks — kills `ECONNREFUSED 127.0.0.1:8000` log noise
 * and removes ~50 lines of boilerplate per spec. See ./README.md for the
 * pattern.
 *
 * Call order in a spec's beforeEach (or shared setup helper):
 *   await setupAuth(page);
 *   await setupCatchAll(page);          // catch-all 404 — register FIRST
 *   await setupApiMocks(page, {...});   // common auxiliaries — overrides catchall
 *   // (test-specific page.route(...) calls come later in the test body)
 *
 * Playwright matches routes in REVERSE registration order — last-registered
 * wins. Tests calling page.route(...) inside the test body will override
 * setupApiMocks defaults for those URLs.
 */

// -----------------------------------------------------------------------------
// Fixture types — minimal shapes; tests pass exactly what they need.
// -----------------------------------------------------------------------------

export interface ProjectFixture {
  id: string;
  name: string;
  description?: string;
  start_date?: string;
  calendar?: string;
  agile_features?: boolean;
  [key: string]: unknown;
}

export interface BoardColumnConfig {
  status: string;
  label: string;
  visible: boolean;
  wip_limit: number | null;
  color: string;
}

export interface UserFixture {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  email: string;
  [key: string]: unknown;
}

export interface OverviewFixture {
  schedule_health: 'unknown' | 'on_track' | 'at_risk' | 'critical';
  spi: number | null;
  tasks_late_count: number;
  critical_task_count: number;
  total_tasks: number;
  complete_tasks: number;
  next_milestone: unknown | null;
  team_utilization_pct: number | null;
  owner_name: string | null;
  start_date: string;
}

export interface StatusSummaryFixture {
  task_count: number;
  critical_path_count: number;
  monte_carlo_p80: string | null;
  at_risk_count: number;
  critical_count: number;
  at_risk_tasks: unknown[];
  critical_tasks: unknown[];
  last_saved: string | null;
  recalculated_at: string | null;
}

export interface ApiMockOptions {
  /** Project list returned by GET /projects/. Defaults to a single generic project. */
  projects?: ProjectFixture[];
  /** Project ID for project-scoped mocks. Defaults to projects[0].id. */
  projectId?: string;
  /** Project tasks returned by GET /tasks/. Defaults to []. */
  tasks?: unknown[];
  /** Dependencies returned by GET /dependencies/. Defaults to []. */
  dependencies?: unknown[];
  /** Project members returned by GET /projects/{id}/members/. Defaults to a single Admin row. */
  members?: unknown[];
  /** Risks returned by GET /projects/{id}/risks/. Defaults to []. */
  risks?: unknown[];
  /** Board column config returned by GET /projects/{id}/board-config/. Defaults to the canonical 5-column set. */
  boardConfig?: { columns: BoardColumnConfig[] };
  /** Saved board views. Defaults to []. */
  boardViews?: unknown[];
  /** /me payload. Defaults to a generic e2e-user row. */
  user?: UserFixture;
  /** /projects/{id}/overview/ payload. Defaults to an empty unknown-health overview. */
  overview?: Partial<OverviewFixture>;
  /** /projects/{id}/status-summary/ payload. */
  statusSummary?: Partial<StatusSummaryFixture>;
  /** Edition flag returned by /edition/. Defaults to 'community'. */
  edition?: 'community' | 'enterprise';
}

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

const DEFAULT_PROJECT: ProjectFixture = {
  id: 'e2e-project-00000000-0000-0000-0000-000000000001',
  name: 'E2E Test Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  // Resolved attachment policy (ADR-0153, #976) — the task drawer reads these to
  // gate the "+ Attach file" control and mirror the allowed-type set. Default to
  // uploads-enabled with the system seed allow-list so existing upload specs pass;
  // specs exercising the disabled state override `projects`.
  effective_attachments_enabled: true,
  effective_allowed_attachment_types: [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  // Duration-change percent policy (ADR-0151, issue 1254) — the schedule reads the
  // resolved value to decide whether to prompt on a duration edit. Default to the
  // no-op 'keep' so existing schedule specs behave as before.
  task_duration_change_percent_policy: null,
  effective_task_duration_change_percent_policy: 'keep',
  inherited_task_duration_change_percent_policy: 'keep',
};

const DEFAULT_USER: UserFixture = {
  id: 'e2e-user',
  username: 'e2euser',
  display_name: 'E2E User',
  initials: 'EU',
  email: 'e2e@example.com',
  // Role-based landing (ADR-0129). Default to a concrete preference so the
  // first-login prompt stays hidden in unrelated specs; RootRedirect resolves
  // `/` to My Work via landing.path. Specs that exercise landing override `user`.
  default_landing: 'my_work',
  landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
  // Per-user nav visibility (ADR-0139) — empty so specs see the full methodology
  // nav by default; the customize-views spec overrides `user` to hide views.
  hidden_views: [],
  // Role-context lens (issue 1263, ADR-0162) — neutral default so the project
  // index redirects to Overview and the view bar keeps canonical order; the
  // role-context spec overrides `user` to exercise the PM / Scrum Master lenses.
  role_context: 'unified',
  // Schedule-in-Deliver placement opt-in (ADR-0203, #1645) — off by default so
  // the calm Schedule-in-Plan-only nav is what specs see unless they override it.
  schedule_in_deliver: false,
};

const DEFAULT_BOARD_CONFIG = {
  columns: [
    { status: 'BACKLOG', label: 'Backlog', visible: true, wip_limit: null, color: '#94A3B8' },
    { status: 'NOT_STARTED', label: 'To Do', visible: true, wip_limit: null, color: '#64748B' },
    { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wip_limit: 5, color: '#3B82F6' },
    { status: 'REVIEW', label: 'Review', visible: true, wip_limit: 3, color: '#A855F7' },
    { status: 'COMPLETE', label: 'Done', visible: true, wip_limit: null, color: '#22C55E' },
  ],
};

const DEFAULT_OVERVIEW: OverviewFixture = {
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
};

const DEFAULT_STATUS_SUMMARY: StatusSummaryFixture = {
  task_count: 0,
  critical_path_count: 0,
  monte_carlo_p80: null,
  at_risk_count: 0,
  critical_count: 0,
  at_risk_tasks: [],
  critical_tasks: [],
  last_saved: null,
  recalculated_at: null,
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

function paginated(results: unknown[]) {
  return { count: results.length, next: null, previous: null, results };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Register a final fallthrough route that returns 404 for any /api/v1/* request
 * not matched by a more-specific handler. Without this, unmocked endpoints fall
 * through Vite's dev-mode proxy to localhost:8000 and produce ECONNREFUSED log
 * noise.
 *
 * Register BEFORE setupApiMocks so more-specific routes win.
 */
export async function setupCatchAll(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    // eslint-disable-next-line no-console
    console.warn(`[e2e mock] unmocked ${req.method()} ${req.url()} → 404`);
    await route.fulfill(
      jsonResponse(
        { detail: 'unmocked in test — add to setupApiMocks options or add a per-spec page.route' },
        404,
      ),
    );
  });
}

/**
 * Register the common auxiliary endpoint mocks. Sensible defaults; pass
 * `opts` to override the test-specific ones (projects, tasks, board config,
 * etc.). Tests can also call additional `page.route(...)` AFTER this to win
 * for specific URLs (last-registered wins).
 */
export async function setupApiMocks(page: Page, opts: ApiMockOptions = {}): Promise<void> {
  const projects = opts.projects ?? [DEFAULT_PROJECT];
  const projectId = opts.projectId ?? projects[0].id;
  const user = opts.user ?? DEFAULT_USER;
  const overview: OverviewFixture = { ...DEFAULT_OVERVIEW, ...opts.overview };
  const statusSummary: StatusSummaryFixture = { ...DEFAULT_STATUS_SUMMARY, ...opts.statusSummary };
  const boardConfig = opts.boardConfig ?? DEFAULT_BOARD_CONFIG;

  // ----- Global (non-project-scoped) -----
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill(jsonResponse({ edition: opts.edition ?? 'community' })),
  );
  await page.route('**/api/v1/auth/me/', (route) => route.fulfill(jsonResponse(user)));
  await page.route('**/api/v1/calendars/', (route) => route.fulfill(jsonResponse(paginated([]))));
  // WebSocket connection ticket (ADR-0141, #818). The project/workshop sockets
  // mint a single-use ticket via this POST before opening; without the mock it
  // 404s through setupCatchAll and the socket never opens (connection pill never
  // goes Live). The value is irrelevant — page.routeWebSocket matches on path.
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill(jsonResponse({ ticket: 'e2e-ticket', expires_in: 30 })),
  );
  // NotificationBell (TopBar, mounted on every project route) polls this every
  // 30s. Default to empty so every spec touching a routed page doesn't fall
  // through setupCatchAll → 404 → TanStack retry, which under high Playwright
  // worker counts pushes spec timeouts past the 10s threshold. Per-spec
  // page.route(...) overrides still win (last-registered).
  await page.route('**/api/v1/me/notifications/**', (route) =>
    route.fulfill(jsonResponse(paginated([]))),
  );
  // Cross-team "current sprint" lens (#1594) — the pinned CurrentSprintButton and
  // the ⌘K sprint action are mounted on every routed page, so default to an empty
  // list. Specs exercising the control override this with their own page.route(...).
  await page.route('**/api/v1/me/active-sprints/', (route) => route.fulfill(jsonResponse([])));

  // ----- Project list -----
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill(jsonResponse(paginated(projects))),
  );

  // ----- Project-scoped (any project id, glob) -----
  // Registered with a wildcard so multiple project IDs in one test still match.
  await page.route('**/api/v1/projects/*/presence/', (route) => route.fulfill(jsonResponse([])));
  await page.route('**/api/v1/projects/*/attention/', (route) =>
    route.fulfill(jsonResponse({ items: [] })),
  );
  await page.route('**/api/v1/projects/*/my-tasks/', (route) =>
    route.fulfill(jsonResponse({ tasks: [] })),
  );
  await page.route('**/api/v1/projects/*/workshop/current/', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill(jsonResponse({ detail: 'No active workshop session.' }, 404));
    }
    return route.continue();
  });
  await page.route('**/api/v1/projects/*/resource-allocation/**', (route) =>
    route.fulfill(
      jsonResponse({
        project_id: projectId,
        window_start: '2026-01-01',
        window_end: '2026-03-01',
        resources: [],
      }),
    ),
  );
  await page.route('**/api/v1/monte-carlo/**', (route) =>
    route.fulfill(jsonResponse({ runs: 0, p50: null, p80: null, p95: null, buckets: [] })),
  );
  // Wave-7 unified Monte Carlo data path — a separate per-project endpoint.
  await page.route('**/api/v1/projects/*/monte-carlo/latest/', (route) =>
    route.fulfill(
      jsonResponse({ runs: 0, p50: null, p80: null, p95: null, buckets: [], last_run_at: null }),
    ),
  );

  // ----- Project-scoped (specific project id) -----
  // GET /projects/{id}/ — project detail. Returned from the projects list above
  // for the matching id; many components fetch this directly too.
  await page.route(`**/api/v1/projects/${projectId}/`, (route) => {
    if (route.request().method() === 'GET') {
      const project = projects.find((p) => p.id === projectId) ?? projects[0];
      return route.fulfill(jsonResponse(project));
    }
    return route.continue();
  });
  await page.route(`**/api/v1/projects/${projectId}/overview/`, (route) =>
    route.fulfill(jsonResponse(overview)),
  );
  // Backlog forecast (#487) — default to warming-up so board/overview specs that
  // don't set their own forecast don't fall through to a 404→retry. Per-spec
  // page.route(...) overrides still win.
  await page.route(`**/api/v1/projects/${projectId}/sprint-forecast/`, (route) =>
    route.fulfill(
      jsonResponse({
        status: 'warming_up',
        remaining_points: 0,
        remaining_count: null,
        sample_count: 0,
        p50_sprints: null,
        p80_sprints: null,
        p50_date: null,
        p80_date: null,
        p95_date: null,
        basis: 'monte_carlo',
        forecast_basis: 'velocity',
        velocity_suppressed: false,
      }),
    ),
  );
  // Flow analytics (ADR-0130 D1) — default to suppressed so the board's
  // collapsed-by-default panel never trips the 401-guard catch-all if expanded.
  await page.route(`**/api/v1/projects/${projectId}/flow-metrics/**`, (route) =>
    route.fulfill(
      jsonResponse({
        window_days: 90,
        since: '2026-05-01',
        until: '2026-07-30',
        cycle_time: { p50: null, p80: null, p95: null },
        lead_time: { p50: null, p80: null, p95: null },
        cfd: [],
        throughput: [],
        data_integrity: {
          bulk_moved_count: 0,
          backdated_count: 0,
          missing_transition_count: 0,
        },
        flow_metrics_suppressed: false,
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${projectId}/status-summary/`, (route) =>
    route.fulfill(jsonResponse(statusSummary)),
  );
  await page.route(`**/api/v1/projects/${projectId}/members/**`, (route) => {
    if (route.request().method() === 'GET') {
      const url = new URL(route.request().url());
      // ?self=true returns just the caller's membership row — still a list (the
      // backend filters the queryset but serializes many=True). useCurrentUserRole()
      // reads res.data[0]; a bare object left role null and hid every role-gated
      // write control (#1046).
      if (url.searchParams.get('self') === 'true') {
        return route.fulfill(jsonResponse([{ id: 'mem-admin', role: 300, user_id: user.id }]));
      }
      return route.fulfill(jsonResponse(opts.members ?? [{ id: 'mem-admin', role: 300 }]));
    }
    return route.continue();
  });
  await page.route(`**/api/v1/projects/${projectId}/risks/**`, (route) => {
    // Inject the server-owned display ids (#929) so fixtures that predate them
    // still render a valid R-NNN id / matrix badge instead of blank/"?".
    // Explicit fixture values win; the index-based fallback mirrors the API's
    // contiguous decimal sequence.
    const risks = (opts.risks ?? []).map((r: Record<string, unknown>, i: number) => {
      const display = `R-${String(i + 1).padStart(3, '0')}`;
      return { short_id_display: display, qualified_id: display, ...r };
    });
    return route.fulfill(jsonResponse(paginated(risks)));
  });
  await page.route(`**/api/v1/projects/${projectId}/board-config/`, (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { columns: unknown[] };
      return route.fulfill(jsonResponse({ columns: body.columns }));
    }
    return route.fulfill(jsonResponse(boardConfig));
  });
  await page.route(`**/api/v1/projects/${projectId}/board-views/`, (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { name: string; config: unknown };
      return route.fulfill(
        jsonResponse(
          {
            id: 'sv-e2e-1',
            name: body.name,
            config: body.config,
            created_by: 'e2e-user',
            server_version: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
          201,
        ),
      );
    }
    return route.fulfill(jsonResponse(opts.boardViews ?? []));
  });

  // ----- Tasks + dependencies (default-only — most tests override) -----
  await page.route('**/api/v1/tasks/**', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill(jsonResponse(paginated(opts.tasks ?? [])));
    }
    return route.continue();
  });
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill(jsonResponse(paginated(opts.dependencies ?? []))),
  );

  // ----- Auxiliaries surfaced by TaskFormModal (#305) and related -----
  await page.route(`**/api/v1/projects/${projectId}/sprints/**`, (route) =>
    route.fulfill(jsonResponse(paginated([]))),
  );
  // Live retro board + team-health pulse (ADR-0117). The retro panel fires these
  // on mount for any ACTIVE/COMPLETED sprint, so every sprints-view spec needs a
  // safe default: empty board, no own response, GATED trend (renders the
  // private-pulse wall — no data leaks). Specs that exercise the board override
  // these with their own page.route(...) after setup.
  await page.route(/\/api\/v1\/sprints\/.*\/retro-board\//, (route) =>
    route.fulfill(
      jsonResponse({
        columns: [
          { key: 'went_well', label: 'What went well' },
          { key: 'to_improve', label: 'What to improve' },
          { key: 'ideas', label: 'Ideas & discussion' },
        ],
        items: [],
      }),
    ),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/pulse-trend\//, (route) =>
    route.fulfill(jsonResponse({ gated: true })),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/pulse\//, (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  // Daily standup delta (ADR-0119) — the active-sprint view fires this on mount;
  // default to an empty delta so every sprints-view spec gets a clean "nothing
  // changed" panel rather than a 404-retry storm.
  await page.route(/\/api\/v1\/sprints\/.*\/daily-delta\//, (route) =>
    route.fulfill(
      jsonResponse({
        sprint_id: 'sp',
        since: '',
        until: '',
        task_changes: [],
        scope_added: [],
        new_blockers: [],
        burndown_delta: null,
        per_actor: [],
      }),
    ),
  );
  // Per-task history endpoint — paginated, opens via the modal "Last edited by" footer.
  await page.route(`**/api/v1/projects/${projectId}/tasks/*/history/**`, (route) =>
    route.fulfill(jsonResponse({ count: 0, next: null, previous: null, results: [] })),
  );
  // Task notes (#740, ADR-0143). The Notes section is the FIRST section on the
  // Activity tab (priority 480, ahead of Comments at 500), so it auto-expands and
  // fires this GET whenever a spec opens that tab. Default to empty so unrelated
  // Activity-tab specs don't fall through setupCatchAll → 404 → "Couldn't load
  // notes" alert + TanStack retry storm (the #1190 flake class). Per-spec
  // page.route(...) overrides still win (last-registered).
  await page.route('**/api/v1/projects/*/tasks/*/notes/**', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill(jsonResponse(paginated([])));
    }
    return route.continue();
  });
  // Project resource pool — populates the assignees editor.
  await page.route('**/api/v1/project-resources/**', (route) =>
    route.fulfill(jsonResponse(paginated([]))),
  );
  // Task-resource assignments — read + write surface used by TaskFormModal.
  await page.route('**/api/v1/task-resources/**', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill(jsonResponse(paginated([])));
    }
    return route.continue();
  });
}
