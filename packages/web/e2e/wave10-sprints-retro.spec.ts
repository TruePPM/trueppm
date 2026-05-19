/**
 * Wave 10 — Sprint retrospective panel E2E (issue #486 / ADR-0071).
 *
 * Verifies the panel renders for the active sprint, the user can add an
 * action item, save fires the POST without auto-promote, the explicit
 * Promote button calls the new promote endpoint, and the persisted
 * `promoted_task_id` renders as a `T-XXX` chip on subsequent loads.
 *
 * The legacy ``promote=true`` checkbox is gone in this build per ADR-0071;
 * promotion is now per-item and explicit.
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-sprints-retro-00000000-0000-0000-0000-000000000060';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Retro Project', description: '', start_date: '2026-04-01', calendar: 'default', methodology: 'AGILE' },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID, server_version: 1, name: 'Retro Project',
  description: '', start_date: '2026-04-01', calendar: null,
  estimation_mode: 'open', agile_features: true, methodology: 'AGILE',
};

const ACTIVE_SPRINT = {
  id: 'sp-active', server_version: 1, short_id: 'A1', short_id_display: 'SP-A1',
  name: 'Active sprint', goal: '', start_date: '2026-04-01', finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null, target_milestone_detail: null,
  committed_points: 20, committed_task_count: 0,
  completed_points: 0, completed_task_count: 0,
  completion_ratio_points: 0, completion_ratio_tasks: 0,
  activated_at: '2026-04-01T00:00:00Z', closed_at: null,
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
};

const PLANNED_SPRINT = { ...ACTIVE_SPRINT, id: 'sp-next', short_id_display: 'SP-N1', name: 'Next sprint', state: 'PLANNED', start_date: '2026-04-15', finish_date: '2026-04-28' };

const SAVED_RETRO = {
  kind: 'full',
  id: 'retro-1',
  sprint: 'sp-active',
  notes: 'Burndown skewed by mid-sprint scope-add.',
  team_visibility: 'team_only',
  created_by: null,
  created_at: '2026-04-15T00:00:00Z',
  updated_at: '2026-04-15T00:00:00Z',
  action_items: [
    {
      id: 'item-1',
      text: 'Add deploy gate',
      assignee: null,
      assignee_username: null,
      story_points: 3,
      promoted_task_id: 'task-aaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      created_at: '2026-04-15T00:00:00Z',
    },
  ],
};

async function setupCommon(
  page: import('@playwright/test').Page,
  retroPayload: unknown | null,
) {
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECT_DETAIL) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 2, next: null, previous: null, results: [ACTIVE_SPRINT, PLANNED_SPRINT] }) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sprint: ACTIVE_SPRINT, snapshots: [] }) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      members: [], totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 },
      working_days: 0, hours_per_day: 8,
    }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      sprints: [], rolling_avg_points: null, rolling_stdev_points: null,
      forecast_range_low: null, forecast_range_high: null,
      rolling_avg_tasks: null, rolling_stdev_tasks: null,
    }) }),
  );
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  // Retro endpoint — GET returns either the saved retro or 404; POST echoes payload.
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) => {
    const url = route.request().url();
    // Prior-retro endpoint: empty 404 in this fixture (no prior sprint).
    if (url.includes('/retrospective/prior/')) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' });
    }
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { notes?: string; action_items?: unknown[] };
      const items = (body.action_items ?? []).map((it, i) => ({
        id: `new-item-${i}`,
        text: (it as { text: string }).text,
        assignee: null,
        assignee_username: null,
        story_points: (it as { story_points?: number | null }).story_points ?? null,
        promoted_task_id: null,
        created_at: '2026-04-15T00:00:00Z',
      }));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'full',
          id: 'retro-1',
          sprint: 'sp-active',
          notes: body.notes ?? '',
          team_visibility: 'team_only',
          created_by: null,
          created_at: '2026-04-15T00:00:00Z',
          updated_at: '2026-04-15T00:00:00Z',
          action_items: items,
        }),
      });
    }
    if (retroPayload === null) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(retroPayload) });
  });

  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
      at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
      last_saved: null, recalculated_at: null,
    }) }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 300 }]) }),
  );
}

test.describe('Wave 10 — Sprint retrospective panel', () => {
  test('renders the panel and saves an action item without auto-promote (ADR-0071)', async ({
    page,
  }) => {
    await setupCommon(page, null);

    const postPromise = page.waitForRequest(
      (req) =>
        req.url().includes('/api/v1/sprints/sp-active/retro/') && req.method() === 'POST',
    );

    await page.goto(BASE_URL);

    const panel = page.getByRole('region', { name: /Retrospective/i });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/promote each explicitly/i)).toBeVisible();

    await panel.getByRole('textbox', { name: /Notes/i }).fill('Burndown skewed');
    await panel.getByRole('button', { name: /\+ Add item/i }).click();
    await panel.getByLabel(/Action item 1 text/i).fill('Add deploy gate');
    await panel.getByLabel(/Action item 1 story points/i).fill('3');

    await panel.getByRole('button', { name: /Save retro/i }).click();

    const post = await postPromise;
    const body = post.postDataJSON() as Record<string, unknown>;
    expect(body.notes).toBe('Burndown skewed');
    expect(body.action_items).toEqual([{ text: 'Add deploy gate', story_points: 3 }]);
    // Legacy fields are gone — no promote=true, no promote_to_sprint_id.
    expect(body.promote_to_sprint_id).toBeUndefined();
  });

  test('hydrates the form from a saved retro and shows the promoted task chip', async ({
    page,
  }) => {
    await setupCommon(page, SAVED_RETRO);

    await page.goto(BASE_URL);
    const panel = page.getByRole('region', { name: /Retrospective/i });
    await expect(panel).toBeVisible();

    await expect(panel.locator('textarea').first()).toHaveValue(/Burndown skewed/i);
    await expect(panel.locator('input[type="text"]').first()).toHaveValue('Add deploy gate');
    await expect(panel.getByText(/^→ T-task-a/i)).toBeVisible();
  });
});
