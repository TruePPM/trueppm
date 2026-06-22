import { test, expect } from '@playwright/test';

/**
 * Project Settings → Signal privacy E2E (ADR-0104, #553/#854).
 *
 * Golden path: ladder renders → set an audience (PATCH) → raise a ceiling via the
 * team-decision dialog (POST). Read-only: a non-facilitator sees no controls.
 */

const PROJECT_ID = 'e2e-sigpriv-0000-0000-0000-000000000553';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Signal Privacy Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  methodology: 'HYBRID',
};

const FIXTURE_ME = { id: 'user-alice', username: 'alice', display_name: 'Alice', initials: 'AL', email: 'alice@example.com' };

function policy(over: Record<string, unknown> = {}) {
  return {
    signals: {
      velocity: { audience: 'team', ceiling: 'team' },
      throughput_rollup: { audience: 'team', ceiling: 'program_shared' },
      pulse: { audience: 'team', ceiling: 'team' },
    },
    requester_tier: 'team_sm_pm',
    can_set_audience: true,
    can_raise_ceiling: true,
    can_vote: true,
    open_proposals: {},
    ...over,
  };
}

/** A live OPEN ceiling-raise proposal for `velocity` (ADR-0104 Amendment A / #930). */
function proposal(over: Record<string, unknown> = {}) {
  return {
    id: 'prop-velocity',
    signal: 'velocity',
    from_ceiling: 'team',
    to_ceiling: 'team_sm',
    status: 'open',
    proposed_by: FIXTURE_ME.id,
    created_at: '2026-06-21T00:00:00Z',
    expires_at: '2026-06-24T00:00:00Z',
    resolved_at: null,
    approve_count: 1,
    reject_count: 0,
    eligible_count: 3,
    threshold: 2,
    your_vote: null,
    can_vote: true,
    votes: [],
    ...over,
  };
}

type Page = import('@playwright/test').Page;

const pj = (data: unknown) => JSON.stringify(data);

async function setup(page: Page, policyBody: Record<string, unknown> = policy()) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Catch-all 401-guard FIRST (ADR-0146): the consolidated settings page mounts
  // every section at once, so sibling sections fire their own endpoints. Without
  // this net those unmocked requests 401 and trip the session-expired modal,
  // which replaces the app and detaches the signal-privacy ladders. Specific
  // routes below override it (Playwright applies routes LIFO).
  await page.route('**/api/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.route('**/api/v1/projects/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }));
  await page.route('**/api/v1/auth/me/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }));
  await page.route('**/api/v1/projects/*/presence/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }));
  await page.route('**/api/v1/projects/*/status-summary/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj({ task_count: 0, critical_path_count: 0, monte_carlo_p80: null, at_risk_count: 0, critical_count: 0 }) }));
  await page.route('**/api/v1/projects/*/attention/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }));
  await page.route('**/api/v1/projects/*/my-tasks/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }));
  await page.route('**/api/v1/projects/*/members/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj([{ id: 'mem-alice', role: 300 }]) }));

  // The signal-privacy policy GET (mutations are routed per-test).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/signal-privacy/`, (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(policyBody) });
    }
    return r.continue();
  });
}

test.describe('Signal privacy — golden path', () => {
  test('the three ladders render', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/signal-privacy`);
    await expect(page.getByRole('radiogroup', { name: 'Velocity audience' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Retro pulse audience' })).toBeVisible();
  });

  test('setting an audience dispatches a PATCH', async ({ page }) => {
    await setup(page);
    let patchBody: unknown;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/signal-privacy/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(policy()) });
      }
      // GET falls back to the setup handler (don't hit the network).
      return r.fallback();
    });
    await page.goto(`/projects/${PROJECT_ID}/settings/signal-privacy`);
    // throughput's ceiling is program_shared, so its Scrum Master rung is unlocked.
    const group = page.getByRole('radiogroup', { name: 'Throughput rollup audience' });
    // Rung accessible name is the spelled-out label, never the bare "SM" (#975).
    await group.getByRole('radio', { name: 'Scrum Master' }).click();
    await expect.poll(() => patchBody).toEqual({ signal: 'throughput_rollup', audience: 'team_sm' });
  });

  test('raising a ceiling opens a pending proposal (not a silent no-op)', async ({ page }) => {
    // The raise now returns 202 + an OPEN proposal; once it lands, the policy GET
    // carries that proposal under open_proposals, so the inline pending card appears.
    let raiseDispatched = false;
    let raised = false;
    await setup(page); // initial GET has no open proposals
    await page.route(`**/api/v1/projects/${PROJECT_ID}/signal-privacy/`, (r) => {
      if (r.request().method() === 'GET') {
        const body = raised ? policy({ open_proposals: { velocity: proposal() } }) : policy();
        return r.fulfill({ status: 200, contentType: 'application/json', body: pj(body) });
      }
      return r.fallback();
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/signal-privacy/raise-ceiling/`, (r) => {
      raiseDispatched = true;
      raised = true;
      // 202 Accepted + the freshly opened proposal (ADR-0104 Amendment A).
      return r.fulfill({ status: 202, contentType: 'application/json', body: pj(proposal()) });
    });
    await page.goto(`/projects/${PROJECT_ID}/settings/signal-privacy`);
    const velocityRow = page.getByRole('radiogroup', { name: 'Velocity audience' }).locator('xpath=ancestor::li');
    await velocityRow.getByRole('button', { name: /Raise ceiling/ }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    expect(raiseDispatched).toBe(false);
    // Scope to the dialog — the ladder's "↑ Raise ceiling…" also matches the name.
    await dialog.getByRole('button', { name: 'Raise ceiling' }).click();
    await expect.poll(() => raiseDispatched).toBe(true);
    // The pending indicator confirms the raise opened a ratification proposal.
    await expect(page.getByLabel('Pending ceiling raise for Velocity')).toBeVisible();
    await expect(page.getByText('⏳ Pending team decision')).toBeVisible();
  });

  test('a team member ratifies an open proposal', async ({ page }) => {
    // Start with the proposal already open and one approval short of the threshold.
    let voteBody: unknown;
    await setup(page, policy({ open_proposals: { velocity: proposal() } }));
    await page.route(
      `**/api/v1/projects/${PROJECT_ID}/signal-privacy/ceiling-proposals/*/vote/`,
      (r) => {
        voteBody = r.request().postDataJSON();
        // Second approval reaches threshold → ratified.
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj(proposal({ status: 'ratified', approve_count: 2, your_vote: 'approve' })),
        });
      },
    );
    await page.goto(`/projects/${PROJECT_ID}/settings/signal-privacy`);
    const card = page.getByLabel('Pending ceiling raise for Velocity');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /Approve/ }).click();
    await expect.poll(() => voteBody).toEqual({ choice: 'approve' });
  });

  test('lone proposer sees the needs-more-approvals hint', async ({ page }) => {
    // A 2-person team where the proposer already approved can't ratify alone.
    await setup(
      page,
      policy({
        open_proposals: {
          velocity: proposal({ eligible_count: 2, threshold: 2, approve_count: 1, your_vote: 'approve' }),
        },
      }),
    );
    await page.goto(`/projects/${PROJECT_ID}/settings/signal-privacy`);
    await expect(page.getByText(/Needs 1 more teammate to approve/)).toBeVisible();
  });
});

test.describe('Signal privacy — read-only', () => {
  test('a non-facilitator sees the banner and no ratchet button', async ({ page }) => {
    await setup(page, policy({ can_set_audience: false, can_raise_ceiling: false, requester_tier: 'team' }));
    await page.goto(`/projects/${PROJECT_ID}/settings/signal-privacy`);
    await expect(page.getByText(/Only the Scrum Master can change signal privacy/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Make everything team-only' })).toHaveCount(0);
  });
});
