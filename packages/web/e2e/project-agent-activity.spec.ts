/**
 * Project Activity tab → Agents sub-view E2E — ADR-0677 / #2481.
 *
 * Golden path: deep-link to `?view=agents` → the team's own agent-action rows
 * render → the "Refusals only" chip re-queries with `verdict=refused` → switching
 * back to Changes restores the changelog. Plus the empty state and the
 * must-not-look-empty failure state.
 *
 * The agent-action read API is mocked; rows render in a real browser.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-agentact-0000-0000-0000-000000002481';
const BASE_URL = `/projects/${PROJECT_ID}`;

const ALLOWED_ACTION = {
  id: 'aa-1',
  schema_version: 1,
  sequence: 1841,
  actor_kind: 'mcp_token',
  actor_token_prefix: 'tppm_ab',
  principal: null,
  action: 'list_tasks',
  method: 'GET',
  object_type: 'task',
  object_id: 't9',
  project: PROJECT_ID,
  capability_used: 'mcp:read',
  verdict: 'allowed',
  refusal_reason: '',
  refusal_detail: null,
  engine_version: '0.4.0',
  payload_hash: 'p'.repeat(64),
  record_hash: 'r'.repeat(64),
  summary: 'Listed tasks',
  occurred_at: '2026-07-26T10:00:00Z',
};

const REFUSED_ACTION = {
  ...ALLOWED_ACTION,
  id: 'aa-2',
  sequence: 1842,
  action: 'update_task',
  method: 'PATCH',
  verdict: 'refused',
  refusal_reason: 'identity',
  refusal_detail: { constraint: 'token_identity', projected_impact: {} },
  summary: 'Refused: token identity',
  occurred_at: '2026-07-26T11:00:00Z',
};

const CHANGELOG = {
  results: [
    {
      id: 'task:9',
      object_type: 'task',
      object_id: 't9',
      object_label: 'Design the API',
      change_type: 'updated',
      history_date: '2026-06-21T00:00:00Z',
      user: { id: 'u-alice', display_name: 'Alice' },
      changes: [{ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' }],
    },
  ],
  next_cursor: null,
};

interface AgentRouteOptions {
  /** Rows returned for a non-refusal read. */
  actions?: unknown[];
  /** Rows returned when `verdict=refused` is asked for. */
  refusals?: unknown[];
  /** Fail the agent-action read instead of answering it. */
  fail?: boolean;
}

async function setup(
  page: import('@playwright/test').Page,
  { actions = [ALLOWED_ACTION], refusals = [REFUSED_ACTION], fail = false }: AgentRouteOptions = {},
) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Agent Oversight Project',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
      },
    ],
    projectId: PROJECT_ID,
    tasks: [],
    statusSummary: { task_count: 0 },
    members: [{ id: 'mem-1', role: 300, user_detail: { id: 'u-alice', username: 'alice' } }],
  });

  await page.route(`**/api/v1/projects/${PROJECT_ID}/changelog/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CHANGELOG),
    }),
  );

  const requests: string[] = [];
  await page.route('**/api/v1/agent-actions/**', async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (fail) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'boom' }),
      });
      return;
    }
    const results = url.includes('verdict=refused') ? refusals : actions;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: results.length, next: null, previous: null, results }),
    });
  });
  return requests;
}

test.describe('Project Activity → Agents sub-view', () => {
  test('deep-links to the team-scoped agent log and queries by project', async ({ page }) => {
    const requests = await setup(page);
    await page.goto(`${BASE_URL}/activity?view=agents`);

    await expect(page.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('status', { name: /Loading agent activity/i })).toHaveCount(0);
    await expect(page.getByText('list_tasks').first()).toBeVisible();

    // The read is scoped to THIS project — never the program union.
    expect(requests.some((u) => u.includes(`project=${PROJECT_ID}`))).toBe(true);
    expect(requests.some((u) => u.includes('program='))).toBe(false);
  });

  test('the Refusals only chip re-queries for refused verdicts', async ({ page }) => {
    const requests = await setup(page);
    await page.goto(`${BASE_URL}/activity?view=agents`);
    await expect(page.getByText('list_tasks').first()).toBeVisible();

    await page.getByRole('checkbox', { name: /Refusals only/i }).click();

    await expect(page.getByRole('checkbox', { name: /Refusals only/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect.poll(() => requests.some((u) => u.includes('verdict=refused'))).toBe(true);
    await expect(page).toHaveURL(/refused=1/);
  });

  test('switching back to Changes restores the changelog', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/activity?view=agents`);
    await expect(page.getByText('list_tasks').first()).toBeVisible();

    await page.getByRole('tab', { name: 'Changes' }).click();

    await expect(page.getByTestId('changelog-list')).toBeVisible();
    await expect(page.getByText('Design the API')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('an empty chain offers a way to connect an agent', async ({ page }) => {
    await setup(page, { actions: [] });
    await page.goto(`${BASE_URL}/activity?view=agents`);

    await expect(page.getByText(/No agent activity yet/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /Connect an agent/i })).toHaveAttribute(
      'href',
      '/me/settings/api-tokens',
    );
  });

  test('a failed read shows a retry, NOT an empty oversight surface', async ({ page }) => {
    // The misreading this guards: "couldn't load" rendering as "no agent has ever
    // touched this project" would be a false all-clear on a governance surface.
    await setup(page, { fail: true });
    await page.goto(`${BASE_URL}/activity?view=agents`);

    await expect(page.getByText(/Couldn't load agent activity/i)).toBeVisible();
    await expect(page.getByText(/No agent activity yet/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Retry/i })).toBeVisible();
  });

  test('arrow keys move focus across the tabs without switching sub-view', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/activity`);
    await expect(page.getByTestId('changelog-list')).toBeVisible();

    await page.getByRole('tab', { name: 'Changes' }).focus();
    await page.keyboard.press('ArrowRight');

    await expect(page.getByRole('tab', { name: 'Agents' })).toBeFocused();
    // Focus moved; selection did not (web-rule 167).
    await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('changelog-list')).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
