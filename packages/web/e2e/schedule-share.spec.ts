import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

/**
 * Public read-only schedule share viewer E2E (#1486, ADR-0265).
 *
 * The viewer is a public (no-auth) standalone page whose only network call on load
 * is a single GET to /api/v1/share/schedule/<token>/. Each state is driven by mocking
 * that one endpoint with its real projection shape (never the catch-all): a 200
 * schedule snapshot, a 410 (revoked/expired), a 404 (invalid/disabled), and a 429
 * (rate-limited). Read-only is asserted by the absence of any create/edit affordance.
 */

// `**` (not `*`) so the glob spans the token's trailing slash (/schedule/<token>/).
const SHARE_URL = '**/api/v1/share/schedule/**';

const SCHEDULE = {
  content_kind: 'schedule',
  project: { name: 'Atlas Rollout', short_id: 'ATLAS' },
  tasks: [
    {
      short_id: 'ATLAS-1',
      name: 'Discovery & scope',
      wbs_path: '1',
      duration: 10,
      planned_start: '2026-05-01',
      early_start: '2026-05-01',
      early_finish: '2026-05-14',
      is_milestone: false,
      is_critical: false,
      percent_complete: 100,
      status: 'COMPLETE',
      assignee: null,
    },
    {
      short_id: 'ATLAS-2',
      name: 'Requirements baseline',
      wbs_path: '1.2',
      duration: 8,
      planned_start: '2026-05-14',
      early_start: '2026-05-14',
      early_finish: '2026-05-25',
      is_milestone: false,
      is_critical: true,
      percent_complete: 70,
      status: 'IN_PROGRESS',
      assignee: null,
    },
    {
      short_id: 'ATLAS-3',
      name: 'Scope sign-off',
      wbs_path: '1.3',
      duration: 0,
      planned_start: '2026-05-25',
      early_start: '2026-05-25',
      early_finish: '2026-05-25',
      is_milestone: true,
      is_critical: false,
      percent_complete: 0,
      status: 'NOT_STARTED',
      assignee: null,
    },
  ],
  dependencies: [
    { predecessor_short_id: 'ATLAS-1', successor_short_id: 'ATLAS-2', dep_type: 'FS', lag: 0 },
  ],
  show_assignees: false,
  show_milestone_dates: true,
  truncated: false,
};

/**
 * The same snapshot as the server builds it for a link minted with the milestone
 * reveal OFF (#2532): the milestone ROW is gone entirely — it is withheld at the
 * projection, not hidden at the renderer — and so is the edge that pointed at it.
 */
const SCHEDULE_NO_MILESTONES = {
  ...SCHEDULE,
  tasks: SCHEDULE.tasks.filter((t) => !t.is_milestone),
  show_milestone_dates: false,
};

test.describe('Public schedule share viewer', () => {
  test('golden path: renders the read-only schedule', async ({ page }) => {
    // Catch-all FIRST so an unmocked endpoint returns a typed 404 instead of
    // falling through and 401ing, which trips the token-refresh session
    // teardown and races the page render (#2366). Routes below win.
    await setupCatchAll(page);

    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SCHEDULE),
      }),
    );

    await page.goto('/share/schedule/tok123');

    await expect(
      page.getByRole('heading', { name: 'Atlas Rollout — Schedule' }),
    ).toBeVisible();
    await expect(page.getByText('Read-only shared view')).toBeVisible();
    await expect(page.getByText('Requirements baseline')).toBeVisible();
    // The critical task carries the non-color "CP" signal (WCAG 1.4.1).
    await expect(page.getByText('CP').first()).toBeVisible();
    // #1684: the milestone renders (amber diamond) with its dated lane label and a
    // legend entry, and the FS dependency edge (ATLAS-1 → ATLAS-2) is an SVG connector.
    await expect(page.getByText(/Scope sign-off · \d+ May/)).toBeVisible();
    await expect(page.getByText('Milestone')).toBeVisible();
    await expect(page.getByText('Dependency')).toBeVisible();
    // At least one dependency connector path is present in the timeline overlay.
    await expect(page.locator('svg polygon').first()).toBeVisible();
    // #1847: the demo landing surfaces the curated MCP example prompts so a
    // Claude Desktop evaluator knows what to ask — a link, not a write control.
    await expect(page.getByRole('heading', { name: 'Ask this schedule anything' })).toBeVisible();
    await expect(
      page.getByText('What breaks if I slip the integration task 5 days?'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Connect an AI assistant/i })).toBeVisible();
    // Read-only: no create/edit affordances anywhere on the page.
    await expect(page.getByRole('button', { name: /add|create|new task|edit/i })).toHaveCount(0);
  });

  test('revoked/expired link shows the branded 410 page', async ({ page }) => {
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'This share link has expired.' }),
      }),
    );

    await page.goto('/share/schedule/tok123');
    await expect(page.getByText('This link is no longer active')).toBeVisible();
  });

  test('a link withdrawn by the sharing policy shows the same 410 page (#2697)', async ({
    page,
  }) => {
    // Turning the workspace "Public sharing" toggle off retroactively withdraws
    // every minted link. The server answers 410 with this detail — the same
    // "intentionally gone" family as revoked/expired, NOT the 404 that means
    // "no such link". Pinned here because the toggle's own help copy promises
    // 410, and for two releases the serve path answered 404 instead.
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({
          detail: 'Public sharing has been turned off for this project.',
        }),
      }),
    );

    await page.goto('/share/schedule/tok123');
    await expect(page.getByText('This link is no longer active')).toBeVisible();
    await expect(
      page.getByText(
        'It was revoked, it expired, or public sharing was turned off. Ask the project owner for a new share link.',
      ),
    ).toBeVisible();
    // Not the 404 page — a withdrawn link is not an invalid one.
    await expect(page.getByText("This share link isn't available")).toHaveCount(0);
  });

  test('invalid/disabled link shows the not-available page on a 404', async ({ page }) => {
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: "This share link isn't available." }),
      }),
    );

    await page.goto('/share/schedule/nope');
    await expect(page.getByText("This share link isn't available")).toBeVisible();
  });

  test('rate-limited link shows the 429 page', async ({ page }) => {
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Request was throttled.' }),
      }),
    );

    await page.goto('/share/schedule/tok123');
    await expect(page.getByText('Too many requests')).toBeVisible();
  });
});

/**
 * "Show milestone dates" reveal toggle (#2532) — the second toggle the #1486
 * handoff specified. Drives the real Project Settings → Sharing dialog: turn the
 * reveal off, mint, then open the resulting public page and prove no milestone
 * row survives. The mint response and the public snapshot are mocked with the
 * shapes the server actually returns for `show_milestone_dates: false`.
 */
const PROJECT_ID = 'e2e-project-00000000-0000-0000-0000-000000002532';

test.describe('Schedule share — milestone reveal', () => {
  async function setupSettings(page: import('@playwright/test').Page, minted: { body?: unknown }) {
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
    await setupCatchAll(page);
    await page.route('**/api/v1/auth/me/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ id: 'u-1', username: 'alice', display_name: 'Alice', initials: 'AL' }),
      }),
    );
    await page.route('**/api/v1/edition/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ edition: 'community' }),
      }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({
          id: PROJECT_ID,
          server_version: 1,
          name: 'Atlas Rollout',
          start_date: '2026-05-01',
          public_sharing: true,
          effective_public_sharing: true,
        }),
      }),
    );
    // Admin (ADR-0072 ordinal 300) so the Sharing section renders its write controls.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj([{ id: 'membership-self', role: 300 }]),
      }),
    );
    // Route order: the more specific share-links route is declared AFTER the
    // project detail route, and Playwright matches most-recently-added first.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/share-links/`, async (route) => {
      if (route.request().method() === 'POST') {
        minted.body = JSON.parse(route.request().postData() ?? '{}');
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: pj({
            id: 'link-2532',
            content_kind: 'schedule',
            token_prefix: 'nomiles-tok',
            label: 'Vendor review',
            show_assignees: false,
            show_milestone_dates: false,
            created_by: 'Alice',
            created_at: '2026-07-29T00:00:00Z',
            expires_at: null,
            revoked_at: null,
            access_count: 0,
            last_accessed_at: null,
            is_active: true,
            is_expired: false,
            token: 'nomiles',
            share_path: '/share/schedule/nomiles',
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: pj([]) });
    });
  }

  test('minting with the reveal off omits every milestone row from the public page', async ({
    page,
  }) => {
    const minted: { body?: unknown } = {};
    await setupSettings(page, minted);

    await page.goto(`/projects/${PROJECT_ID}/settings#sharing`);
    await page.getByRole('button', { name: 'Create link…' }).click();

    // One dialog is ever mounted, and its accessible NAME changes as the phase
    // swaps (create → reveal), so locate it by role only and assert the phase copy.
    const dialog = page.getByRole('dialog');
    await expect(page.getByRole('dialog', { name: 'Share this schedule' })).toBeVisible();
    const milestones = dialog.getByRole('checkbox', { name: /Show milestone dates/ });
    // On by default — this is a missing option, not a disclosure fix.
    await expect(milestones).toBeChecked();
    await milestones.uncheck();
    await dialog.getByRole('button', { name: 'Create link' }).click();

    await expect(dialog.getByText(/milestone dates hidden/)).toBeVisible();
    expect(minted.body).toMatchObject({ show_milestone_dates: false, content_kind: 'schedule' });

    // Open the link that was just minted — the server withheld the milestone rows.
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SCHEDULE_NO_MILESTONES),
      }),
    );
    await page.goto('/share/schedule/nomiles');

    await expect(page.getByRole('heading', { name: 'Atlas Rollout — Schedule' })).toBeVisible();
    // Real work still renders…
    await expect(page.getByText('Requirements baseline')).toBeVisible();
    // …but no milestone row, no dated diamond label, and no legend entry for one.
    await expect(page.getByText('Scope sign-off')).toHaveCount(0);
    await expect(page.getByText(/Scope sign-off · \d+ May/)).toHaveCount(0);
    await expect(page.getByText('Milestone', { exact: true })).toHaveCount(0);
    // …and the omission is named, so the WBS gap doesn't read as missing data.
    await expect(
      page.getByText('Milestone dates were not included in this shared view.'),
    ).toBeVisible();
  });

  test('the board dialog still carries a single reveal toggle (unchanged by #2532)', async ({
    page,
  }) => {
    const minted: { body?: unknown } = {};
    await setupSettings(page, minted);

    await page.goto(`/projects/${PROJECT_ID}/settings#sharing`);
    await page.getByRole('button', { name: 'Create link…' }).click();
    // Role-only locator: switching kind renames the dialog, so a name-scoped one
    // would silently stop resolving after the click and pass by matching nothing.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'board', exact: true }).click();

    await expect(page.getByRole('dialog', { name: 'Share this board' })).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(1);
    await expect(dialog.getByRole('checkbox', { name: /Show assignee names/ })).toBeVisible();
  });
});
