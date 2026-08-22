import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Retired project-settings anchors keep resolving (#2969, epic #2743).
 *
 * "How this team works" collapses three rail rows — Methodology, Workflow &
 * fields, and Sprint guardrails — into one section. The stated regression risk on
 * the issue is the addresses those sections used to answer on: a settings URL in
 * someone's runbook or bookmark must not 404 to make a nav change tidy.
 *
 * Two mechanisms carry the promise and neither can see the other, which is why
 * this spec drives both:
 *   - `/projects/:id/settings/<slug>` is a real route, redirected by
 *     `SectionRedirect` in `router.tsx`;
 *   - `/projects/:id/settings#<slug>` is a hash, which is not part of the path a
 *     route matches, so only `SettingsShell`'s `anchorAliases` can rewrite it.
 *
 * A type-checker sees neither. A failure here is silent in production: an unknown
 * hash produces no error and no scroll, just a page top that reads like a slow
 * load.
 */

const PROJECT_ID = 'e2e-project-00000000-0000-0000-0000-000000002969';
const SECTION = 'how-this-team-works';

const pj = (data: unknown) => JSON.stringify(data);

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
  effective_methodology: 'AGILE',
  inherited_methodology: 'AGILE',
  board_cadence: 'sprint',
  code: 'ATLAS',
  health: 'ON_TRACK',
  visibility: 'WORKSPACE',
  timezone: 'UTC',
  default_view: 'SCHEDULE',
  is_archived: false,
  archived_at: null,
  archived_by: null,
};

type Page = import('@playwright/test').Page;

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Catch-all 401-guard FIRST (ADR-0146): the settings page mounts every section
  // at once, so every sibling section fires its own reads. Unmocked, they 401 into
  // the session-expired modal, which replaces the app and detaches whatever this
  // spec was asserting on.
  await setupCatchAll(page);

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        id: 'user-alice',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'alice@example.com',
        can_access_admin_settings: true,
        workspace_role: 300,
        max_project_role: 400,
      }),
    }),
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
      body: pj([{ id: 'm-alice', role: 400 }]),
    }),
  );
  // The Methodology block gates its ENTIRE render — heading included — on the
  // workspace settings resolving, because until they do it cannot tell an
  // inherited selection from a locked one. Unmocked it stays a skeleton forever
  // and the block's h3 never appears, which is a missing mock, not a redirect bug.
  await page.route('**/api/v1/workspace/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        name: 'TrueScope Aerospace',
        subdomain: 'truescope',
        timezone: 'UTC',
        fiscal_year_start_month: 1,
        fiscal_year_start_day: 1,
        fiscal_year_start_display: 'January 1',
        work_week: [true, true, true, true, true, false, false],
        default_project_view: 'Overview',
        allow_guests: false,
        public_sharing: false,
        iteration_label: 'Sprint',
        iteration_label_override_policy: 'suggest',
        methodology: 'AGILE',
        methodology_override_policy: 'suggest',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/guardrail-policy/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
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
      }),
    }),
  );
}

/** The section really rendered — not merely "the URL changed". */
async function expectLanded(page: Page) {
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/settings#${SECTION}$`));
  await expect(page.getByRole('heading', { level: 2, name: 'How this team works' })).toBeVisible();
}

test.describe('Project settings — retired anchors redirect (#2969)', () => {
  // The route half. One case per retired slug, spelled out rather than looped over
  // a fixture, so a failure names the address that broke.
  test('/settings/methodology → #how-this-team-works', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);
    await expectLanded(page);
  });

  test('/settings/workflow → #how-this-team-works', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/workflow`);
    await expectLanded(page);
  });

  test('/settings/guardrails → #how-this-team-works', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/guardrails`);
    await expectLanded(page);
  });

  // The hash half — the one no route can reach, and the form the product's own
  // deep links use (ADR-0146 made every section an anchor, so every link mailed or
  // bookmarked since then is this shape).
  test('#methodology → #how-this-team-works', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings#methodology`);
    await expectLanded(page);
  });

  test('#workflow → #how-this-team-works', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings#workflow`);
    await expectLanded(page);
  });

  test('#guardrails → #how-this-team-works', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings#guardrails`);
    await expectLanded(page);
  });

  test('the redirect lands on the real content, not just the heading', async ({ page }) => {
    // The three blocks the section absorbed are all on screen at the destination.
    // A redirect that resolves to an empty section would satisfy every assertion
    // above and still lose the user everything they came for.
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/guardrails`);
    await expectLanded(page);

    const section = page.locator('[data-settings-section="how-this-team-works"]');
    await expect(section.getByRole('heading', { level: 3, name: 'Methodology' })).toBeVisible();
    await expect(
      section.getByRole('heading', { level: 3, name: 'Workflow & fields' }),
    ).toBeVisible();
    await expect(
      section.getByRole('heading', { level: 3, name: 'Sprint guardrails' }),
    ).toBeVisible();
  });

  test('the rail carries one row for the three, and none of the old three', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings#${SECTION}`);
    await expectLanded(page);

    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByText('How this team works')).toBeVisible();
    await expect(nav.getByText('Workflow & fields')).toHaveCount(0);
    await expect(nav.getByText('Sprint guardrails')).toHaveCount(0);
    await expect(nav.getByText('Methodology', { exact: true })).toHaveCount(0);
  });

  test('an unrelated legacy anchor is unaffected', async ({ page }) => {
    // The consolidation touched three redirects out of fifteen. This is the guard
    // against a fix applied to the wrong scope — every other settings deep link
    // still answers on its own id.
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/settings#general$`));
    await expect(page.getByRole('heading', { level: 2, name: 'General' })).toBeVisible();
  });

  test('a hash nobody declared is left alone rather than guessed at', async ({ page }) => {
    // An alias map that swallowed unknown hashes would make a typo look like a
    // working deep link, which is worse than landing at the top of the page.
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings#not-a-section`);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/settings#not-a-section$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Project settings' })).toBeVisible();
  });
});
