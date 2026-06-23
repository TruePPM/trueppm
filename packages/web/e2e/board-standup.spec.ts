/**
 * Daily standup walk-the-board E2E (#1278 / ADR-0166).
 *
 * Golden path: open standup mode → walk person-to-person → a teammate's blocker is
 * visible. The walk mounts off ?standup=1 (the same URL state the toolbar button sets),
 * so the core walk is tested without the sprint-header/burndown chrome. A separate test
 * drives the actual "Standup" entry button with a mocked active sprint + burndown.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-standup-0000-0000-0000-000000001278';
const BASE_URL = `/projects/${PROJECT_ID}`;

const TASKS = [
  {
    id: 'f1', wbs_path: '1', name: 'Vault card', early_start: '2026-06-05',
    early_finish: '2026-06-12', planned_start: '2026-06-05', duration: 5,
    percent_complete: 40, is_critical: false, is_milestone: false, is_summary: false,
    parent_id: null, status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

const card = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, name, status, story_points: 3, dwell_days: 1, aging: false,
  blocker_type: null, blocked_since: null, ...extra,
});

const WALK_PAYLOAD = {
  active: true,
  reason: null,
  sprint: {
    id: 'sp1', name: 'Sprint 7', goal: 'Ship the checkout redesign',
    start_date: '2026-06-01', finish_date: '2026-06-14',
  },
  generated_at: '2026-06-08T09:00:00Z',
  window_since: '2026-06-05T00:00:00Z',
  walk: [
    {
      assignee: { id: 'u-alex', name: 'Alex Rivera' },
      done: [card('f9', 'Coupon field', 'COMPLETE')],
      in_progress: [card('f1', 'Vault card', 'IN_PROGRESS')],
      blockers: [],
    },
    {
      assignee: { id: 'u-priya', name: 'Priya Patel' },
      done: [],
      in_progress: [],
      blockers: [
        card('f3', 'Tax service', 'IN_PROGRESS', {
          blocker_type: 'vendor', blocked_since: '2026-06-06T09:00:00Z',
        }),
      ],
    },
  ],
};

const EMPTY_PAYLOAD = {
  active: false, reason: 'no_active_sprint', sprint: null,
  generated_at: '2026-06-08T09:00:00Z', window_since: null, walk: [],
};

async function setup(page: import('@playwright/test').Page, standup: unknown) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [{
      id: PROJECT_ID, name: 'Sprint Demo', description: '',
      start_date: '2026-06-01', calendar: 'default', board_cadence: 'sprint',
    }],
    projectId: PROJECT_ID,
    tasks: TASKS,
    statusSummary: { task_count: 1 },
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/standup/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(standup) }),
  );
}

test.describe('Daily standup walk-the-board', () => {
  test('opens standup, walks to a teammate, and shows the blocker', async ({ page }) => {
    await setup(page, WALK_PAYLOAD);
    await page.goto(`${BASE_URL}/board?standup=1`);

    const mode = page.getByTestId('standup-mode');
    await expect(mode.getByText('Ship the checkout redesign')).toBeVisible({ timeout: 10_000 });
    // First teammate up; their in-progress card is shown, no blocker yet.
    await expect(mode.getByRole('heading', { name: 'Alex Rivera' })).toBeVisible();
    await expect(mode.getByText('Vault card')).toBeVisible();
    await expect(mode.getByText('External vendor')).toHaveCount(0);

    // Walk to the next teammate — their blocker is surfaced by type + age.
    await mode.getByRole('button', { name: 'Next teammate' }).click();
    await expect(mode.getByRole('heading', { name: 'Priya Patel' })).toBeVisible();
    await expect(mode.getByText('Tax service')).toBeVisible();
    await expect(mode.getByText('External vendor')).toBeVisible();
  });

  test('shows the honest empty state with no active sprint', async ({ page }) => {
    await setup(page, EMPTY_PAYLOAD);
    await page.goto(`${BASE_URL}/board?standup=1`);
    const mode = page.getByTestId('standup-mode');
    await expect(mode.getByText('No active sprint to walk')).toBeVisible({ timeout: 10_000 });
    await expect(mode.getByRole('link', { name: 'Go to sprints →' })).toBeVisible();
  });

  test('opens from the Standup button on the sprint header', async ({ page }) => {
    await setup(page, WALK_PAYLOAD);
    // An ACTIVE sprint so the board renders the sprint header (and its Standup button).
    const sprint = {
      id: 'sp1', server_version: 1, short_id: 'A1', short_id_display: 'SP-A1',
      name: 'Sprint 7', goal: 'Ship the checkout redesign', notes: '',
      start_date: '2026-06-01', finish_date: '2026-06-14', state: 'ACTIVE',
      target_milestone: null, target_milestone_detail: null, capacity_points: null,
    };
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: [sprint] }),
      }),
    );
    await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          sprint, snapshots: [], burn_status: 'no_data', trend_points: null,
          projected_finish_date: null,
        }),
      }),
    );

    await page.goto(`${BASE_URL}/board`);
    // Gate on the sprint header rendering (the goal) before clicking its button.
    await expect(page.getByText('Ship the checkout redesign').first()).toBeVisible({ timeout: 10_000 });
    // Exact match: the context-bar project switcher is also a button, so a substring
    // /Standup/ would be ambiguous — the header button's accessible name is exactly "Standup".
    await page.getByRole('button', { name: 'Standup', exact: true }).click();
    await expect(page.getByTestId('standup-mode')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Alex Rivera' })).toBeVisible();
  });
});
