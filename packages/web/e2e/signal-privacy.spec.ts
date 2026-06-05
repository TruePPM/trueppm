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
    ...over,
  };
}

type Page = import('@playwright/test').Page;

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
  const pj = (data: unknown) => JSON.stringify(data);

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
      return r.continue();
    });
    await page.goto(`/projects/${PROJECT_ID}/settings/signal-privacy`);
    // throughput's ceiling is program_shared, so its SM rung is unlocked.
    const group = page.getByRole('radiogroup', { name: 'Throughput rollup audience' });
    await group.getByRole('radio', { name: /SM/ }).click();
    await expect.poll(() => patchBody).toEqual({ signal: 'throughput_rollup', audience: 'team_sm' });
  });

  test('raising a ceiling goes through the team-decision dialog', async ({ page }) => {
    await setup(page);
    let raiseDispatched = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/signal-privacy/raise_ceiling/`, (r) => {
      raiseDispatched = true;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(policy()) });
    });
    await page.goto(`/projects/${PROJECT_ID}/settings/signal-privacy`);
    const velocityRow = page.getByRole('radiogroup', { name: 'Velocity audience' }).locator('xpath=ancestor::li');
    await velocityRow.getByRole('button', { name: /Raise ceiling/ }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(raiseDispatched).toBe(false);
    await page.getByRole('button', { name: 'Raise ceiling' }).click();
    await expect.poll(() => raiseDispatched).toBe(true);
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
