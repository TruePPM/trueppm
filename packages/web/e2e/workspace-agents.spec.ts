import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';
import { expectNoA11yViolations } from './fixtures/a11y';

/**
 * Workspace Agents page + refused-action Inbox item (#4814, #4757).
 *
 * Every endpoint the page reads is mocked with its real shape (the #1190 lesson):
 * the agents list, one agent's detail, and the audit-verify line. The pause mock
 * is stateful — the detail GET the app refetches after the write echoes it — so the
 * assertion after the click cannot be erased by the refetch (#2752).
 */

type Page = import('@playwright/test').Page;

const AGENT_ID = '7d1c9b3e-0000-4000-8000-000000004814';
const AREAS = [
  { key: 'schedule', label: 'Schedule & tasks', covers: 'Projects, tasks and forecasts.' },
  { key: 'dependencies', label: 'Dependencies', covers: 'Dependency links and the driving chain.' },
  { key: 'resources', label: 'Resources', covers: 'Project cost and task assignments.' },
  { key: 'baselines', label: 'Baselines', covers: 'Baselines and their task snapshots.' },
];
const READ_ALL = { schedule: 'read', dependencies: 'read', resources: 'read', baselines: 'read' };

function agent(paused: boolean) {
  return {
    id: AGENT_ID,
    name: 'Claude',
    token_prefix: 'ab12cd34',
    principal: { id: 1, name: 'Alice' },
    created_at: '2026-11-01T00:00:00Z',
    last_used_at: '2026-11-22T10:00:00Z',
    expires_at: null,
    revoked_at: null,
    paused: paused
      ? { paused_at: new Date().toISOString(), paused_by: { id: 1, name: 'Alice' } }
      : null,
    scope: READ_ALL,
    effective_scope: READ_ALL,
    last_action: {
      occurred_at: '2026-11-22T10:00:00Z',
      verdict: 'refused',
      summary: 'MCP GET projects:project-overview — refused (403)',
      redacted: false,
    },
    refusals_7d: 3,
    programs: [{ id: '5a1c9b3e-0000-4000-8000-000000000001', name: 'Atlas' }],
    can_manage: true,
  };
}

function detail(paused: boolean) {
  return {
    ...agent(paused),
    recent_actions: [
      {
        id: '9e1c9b3e-0000-4000-8000-000000000001',
        occurred_at: '2026-11-22T10:00:00Z',
        actor_kind: 'mcp_token',
        action: 'projects:project-overview',
        verdict: 'refused',
        constraint: 'capability_scope',
        summary: 'MCP GET projects:project-overview — refused (403)',
        redacted: false,
      },
    ],
  };
}

const pj = (data: unknown) => JSON.stringify(data);
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: pj(body) });

const OTHER_ID = '7d1c9b3e-0000-4000-8000-000000005110';

/** A second agent listed *first*, so selecting the refused one is not the default. */
function other() {
  return { ...agent(false), id: OTHER_ID, name: 'Cursor', token_prefix: 'ff00ee11' };
}

async function setup(
  page: Page,
  { agents = true, second = false }: { agents?: boolean; second?: boolean } = {},
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
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(json({ id: '1', username: 'alice', display_name: 'Alice', initials: 'AL' })),
  );
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));

  let paused = false;
  await page.route(
    (url) => url.pathname === '/api/v1/agents/',
    (r) =>
      r.fulfill(
        json({
          agents: agents ? [...(second ? [other()] : []), agent(paused)] : [],
          truncated: false,
          areas: AREAS,
          grantable_levels: ['none', 'read', 'propose'],
          can_verify_log: true,
        }),
      ),
  );
  await page.route('**/api/v1/agents/audit-verify/', (r) =>
    r.fulfill(
      json({
        ok: true,
        record_count: 128,
        checked_at: new Date().toISOString(),
        anchor: 'genesis',
        break_sequence: null,
      }),
    ),
  );
  await page.route(`**/api/v1/agents/${AGENT_ID}/`, (r) => r.fulfill(json(detail(paused))));
  await page.route(`**/api/v1/agents/${OTHER_ID}/`, (r) =>
    r.fulfill(json({ ...other(), recent_actions: [] })),
  );
  await page.route(`**/api/v1/agents/${AGENT_ID}/pause/`, (r) => {
    paused = true;
    return r.fulfill(json(detail(true)));
  });
}

test.describe('Workspace Agents page', () => {
  test('lists agents, shows the scope matrix, and pauses an agent', async ({ page }, testInfo) => {
    await setup(page);
    await page.goto('/agents');

    await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
    await expect(page.getByTestId('agents-verified')).toContainText(
      'Action log verified · 128 records',
    );
    const list = page.getByRole('list', { name: 'Agents' });
    await expect(list.getByText('Acts for Alice')).toBeVisible();
    await expect(list.getByText('3 refused in 7 days')).toBeVisible();

    const panel = page.getByRole('region', { name: 'Claude', exact: true });
    await expect(panel.getByRole('columnheader', { name: 'Dry run' })).toBeVisible();
    await expect(panel.getByRole('checkbox', { name: 'Resources: Write' })).toBeDisabled();
    await expect(panel.getByText(/Refused · outside scope/)).toBeVisible();
    await expectNoA11yViolations(page, testInfo);

    // Keyboard-complete: the panel's controls are reachable and operable by key.
    await panel.getByRole('button', { name: 'Edit scope' }).focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('checkbox', { name: 'Resources: Read' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Cancel' }).click();

    await panel.getByRole('button', { name: 'Pause' }).click();
    await expect(panel.getByText(/Paused by Alice/)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Resume' })).toBeVisible();
  });

  test('empty state when no agents are configured', async ({ page }) => {
    await setup(page, { agents: false });
    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
    await expect(page.getByText('No agents configured')).toBeVisible();
  });

  test('a refused agent call appears in the Inbox and opens its agent', async ({ page }) => {
    await setup(page, { second: true });
    const refusal = {
      id: '3b1c9b3e-0000-4000-8000-000000000001',
      recipient: 1,
      mention: null,
      event_type: 'agent.refused',
      subject: 'Refused: agent Claude (tppm_ab12cd34) is paused',
      body:
        'It is paused, so every call it makes is refused until it is resumed.\n' +
        'Attempted: GET projects:project-overview.\n' +
        'Agent: Claude (tppm_ab12cd34), refused 3 times in the last 15 minutes.\n' +
        'Nothing changed in the schedule.',
      project: null,
      is_read: false,
      is_archived: false,
      snoozed_until: null,
      category: 'project',
      created_at: new Date().toISOString(),
      read_at: null,
      snippet: '',
      task_id: null,
      agent_id: AGENT_ID,
    };
    await page.route(
      (url) => url.pathname === '/api/v1/me/notifications/',
      (r) => r.fulfill(json({ count: 1, next: null, previous: null, results: [refusal] })),
    );
    // Opening the row marks it read.
    await page.route(`**/api/v1/me/notifications/${refusal.id}/`, (r) =>
      r.fulfill(json({ ...refusal, is_read: true, read_at: new Date().toISOString() })),
    );
    await page.goto('/me/notifications');
    const item = page.getByRole('article', {
      name: /Refused: agent Claude \(tppm_ab12cd34\) is paused/,
    });
    await expect(item).toBeVisible();
    await expect(item.getByText(/Nothing changed in the schedule/)).toBeVisible();
    await item
      .getByRole('button', { name: /Refused: agent Claude \(tppm_ab12cd34\) is paused/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`/agents\\?agent=${AGENT_ID}$`));
    // The refused agent is selected, not the first one on the list (#5110).
    await expect(page.getByRole('region', { name: 'Claude', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Cursor', exact: true })).toHaveCount(0);
    // The notice's live region is mounted but empty: the agent is listed.
    await expect(page.getByTestId('agents-requested-notice')).toHaveText('');
  });

  test('an Inbox link to an agent no longer listed says so', async ({ page }) => {
    await setup(page);
    await page.goto('/agents?agent=00000000-0000-4000-8000-000000000000');
    await expect(
      page.getByRole('status').filter({
        hasText: 'The agent from your Inbox item is no longer on this list',
      }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Claude', exact: true })).toBeVisible();
  });
});
