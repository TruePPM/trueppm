import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Project Settings → Sprint guardrails E2E (#875 / ADR-0101 §3).
 *
 * Verifies the Owner-only escalation surface end-to-end:
 *  - the page seeds from GET /api/v1/projects/:id/guardrail-policy/
 *  - rule rows render with outcome-language copy (no WBS jargon)
 *  - Owner clicking Block on a composition rule fires a PATCH carrying
 *    only that rule in the `levels` map
 *  - the advisory `subtasks_split` rule does not expose a Block path
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-project-00000000-0000-0000-0000-000000000875';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Atlas',
  description: '',
  start_date: '2026-03-02',
  calendar: 'cal-default',
  estimation_mode: 'OPEN',
  agile_features: true,
  methodology: 'AGILE',
  code: 'ATLAS',
  health: 'ON_TRACK',
  visibility: 'WORKSPACE',
  timezone: 'UTC',
  default_view: 'SCHEDULE',
  is_archived: false,
  archived_at: null,
  archived_by: null,
};

const ALL_WARN_POLICY = {
  levels: {},
  effective_levels: {
    summary_in_sprint: 'warn',
    phase_in_sprint: 'warn',
    task_outside_sprint_window: 'warn',
    recurring_in_sprint: 'warn',
    subtasks_split: 'warn',
  },
  policy_source: 'owner',
  source_label: '',
  acknowledged_by_team: false,
  server_version: 1,
};

type Page = import('@playwright/test').Page;
type Route = import('@playwright/test').Route;

interface Captures {
  patch?: Record<string, unknown>;
}

async function setup(
  page: Page,
  captures: Captures,
  opts: { ownerRole?: boolean } = {},
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

  const pj = (data: unknown) => JSON.stringify(data);
  // Owner=400, Member=100 (ADR-0072). Owner is the default for this spec.
  const role = opts.ownerRole === false ? 100 : 400;

  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [FIXTURE_PROJECT], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/*`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([{ id: 'm-alice', role }]),
    }),
  );
  await page.route(
    `**/api/v1/projects/${PROJECT_ID}/guardrail-policy/`,
    async (route: Route) => {
      if (route.request().method() === 'PATCH') {
        captures.patch = JSON.parse(route.request().postData() ?? '{}');
        const merged = {
          ...ALL_WARN_POLICY,
          levels: { ...ALL_WARN_POLICY.levels, ...((captures.patch?.levels as object) ?? {}) },
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj(merged),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(ALL_WARN_POLICY),
      });
    },
  );
}

test.describe('Project Settings → Sprint guardrails', () => {
  test('Owner escalates a composition rule to Block via the matrix', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/guardrails`);

    await expect(page.getByRole('heading', { name: 'Sprint guardrails' })).toBeVisible();
    // Outcome-language copy reaches the page (no WBS jargon).
    await expect(page.getByText(/Double-counts in velocity/)).toBeVisible();
    // Advisory rule renders the fixed pill, not a Warn/Block pair.
    await expect(page.getByText('Warn (advisory)')).toBeVisible();

    // Owner clicks Block on the summary-in-sprint rule and the PATCH fires
    // with only that rule in the levels map — partial updates are safe by
    // contract (the server merges onto the existing map).
    const blockButtons = page.getByRole('button', { name: /block \(no override\)/i });
    await expect(blockButtons).toHaveCount(4);
    await blockButtons.first().click();
    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toEqual({ levels: { summary_in_sprint: 'block' } });
  });

  test('non-Owner cannot escalate — Block buttons are disabled with helper text', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures, { ownerRole: false });
    await page.goto(`/projects/${PROJECT_ID}/settings/guardrails`);

    await expect(page.getByRole('heading', { name: 'Sprint guardrails' })).toBeVisible();
    const blockButtons = page.getByRole('button', { name: /block \(no override\)/i });
    for (let i = 0; i < (await blockButtons.count()); i++) {
      await expect(blockButtons.nth(i)).toBeDisabled();
    }
    await expect(
      page.getByText(/Only a project Owner can change a sprint-composition rule/),
    ).toBeVisible();
    expect(captures.patch).toBeUndefined();
  });
});
