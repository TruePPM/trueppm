/**
 * In-product feedback / report-a-bug control (#2392).
 *
 * The privacy promise is only real if it holds against the running app, so this
 * spec watches the network while the control is opened rather than trusting the
 * unit-level mocks.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { paletteSearch, setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-feedback-0000-0000-0000-000000002392';

/**
 * Whether `url`'s host is the issue tracker, by exact or subdomain match.
 *
 * Deliberately not `url.includes('gitlab.com')`: a substring test is also
 * satisfied by a path segment (`https://evil.test/gitlab.com/beacon`) and by a
 * lookalike host (`gitlab.com.evil.test`), so it does not actually express "the
 * request went to the tracker". Same reasoning — and same shape — as
 * `detectProviderForMock` in `task-external-links.spec.ts`. An unparseable URL
 * is not the tracker, so it falls through to `false`.
 */
function isTrackerHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return host === 'gitlab.com' || host.endsWith('.gitlab.com');
}

async function setup(page: Page, opts: { enabled?: boolean; url?: string } = {}) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Feedback Project',
        description: '',
        start_date: '2026-04-01',
        calendar: 'default',
        program: null,
        program_detail: null,
        health: 'ON_TRACK',
        methodology: 'HYBRID',
        effective_methodology: 'HYBRID',
      },
    ],
    projectId: PROJECT_ID,
  });
  await page.route('**/api/v1/workspace/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'E2E',
        subdomain: 'e2e',
        timezone: '',
        fiscal_year_start_month: 1,
        fiscal_year_start_day: 1,
        fiscal_year_start_display: 'January 1',
        work_week: [true, true, true, true, true, false, false],
        default_project_view: 'SCHEDULE',
        allow_guests: false,
        public_sharing: false,
        public_sharing_override_policy: 'suggest',
        iteration_label: 'Sprint',
        iteration_label_override_policy: 'suggest',
        mc_history_enabled: true,
        mc_history_retention_cap: 50,
        mc_history_attribution_audience: 'SCHEDULER_PLUS',
        mc_history_override_policy: 'suggest',
        task_duration_change_percent_policy: 'confirm',
        task_duration_change_percent_override_policy: 'suggest',
        estimation_scale: 'fibonacci',
        methodology: 'HYBRID',
        methodology_override_policy: 'suggest',
        attachments_enabled: true,
        allowed_attachment_types: [],
        attachments_override_policy: 'suggest',
        calendar: null,
        calendar_override_policy: 'suggest',
        feedback_enabled: opts.enabled ?? true,
        feedback_url: opts.url ?? '',
        logo_url: null,
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        edition: 'community',
        version: '0.4.0-beta.1',
        build_sha: 'deadbeefcafe1234',
      }),
    }),
  );
}

function openUserMenu(page: Page) {
  return page.getByRole('button', { name: /Account/ }).click();
}

test.describe('Report a bug (#2392)', () => {
  test('is reachable from the user menu and shows what would be sent', async ({ page }) => {
    await setup(page);
    await page.goto('/me/work');

    await openUserMenu(page);
    await page.getByRole('button', { name: 'Report a bug' }).click();

    const dialog = page.getByRole('dialog', { name: 'Report a bug or send feedback' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Nothing is sent from here');

    const body = dialog.getByLabel('Report contents');
    await expect(body).toContainText('0.4.0-beta.1');
    await expect(body).toContainText('community');
  });

  test('opening it makes NO request to the tracker or anywhere else', async ({ page }) => {
    await setup(page);
    await page.goto('/me/work');

    // Watch from the click onward: the promise is that a self-hosted instance
    // never phones home *because the control was used*.
    //
    // Scoped deliberately to (a) the tracker host and (b) any non-GET request:
    // those are the two shapes this feature could plausibly take if it were a
    // beacon. A blanket "no external request" assertion instead catches the
    // app's web-font fetch — a real air-gap concern, but a pre-existing and
    // app-wide one, tracked separately in #2419. Asserting it here would make
    // this spec fail for a reason that has nothing to do with feedback.
    const tracker: string[] = [];
    const writes: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (isTrackerHost(url)) tracker.push(url);
      if (req.method() !== 'GET') writes.push(`${req.method()} ${url}`);
    });

    await openUserMenu(page);
    await page.getByRole('button', { name: 'Report a bug' }).click();
    await expect(page.getByRole('dialog', { name: 'Report a bug or send feedback' })).toBeVisible();

    expect(tracker).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('strips the project id and query string from the reported screen', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/board?q=payroll`);

    await openUserMenu(page);
    await page.getByRole('button', { name: 'Report a bug' }).click();

    const body = page.getByRole('dialog').getByLabel('Report contents');
    await expect(body).toContainText('/projects/:id/board');
    await expect(body).not.toContainText(PROJECT_ID);
    await expect(body).not.toContainText('payroll');
  });

  test('is reachable from the command palette', async ({ page }) => {
    await setup(page);
    await page.goto('/me/work');

    await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();

    await paletteSearch(page).fill('report a bug');
    await palette
      .getByRole('option', { name: /Report a bug/ })
      .first()
      .click();

    await expect(page.getByRole('dialog', { name: 'Report a bug or send feedback' })).toBeVisible();
  });

  test('is hidden entirely when the operator disables it', async ({ page }) => {
    await setup(page, { enabled: false });
    await page.goto('/me/work');

    await openUserMenu(page);
    // Hidden, not disabled: a locked-down install should not advertise a route
    // it has closed.
    await expect(page.getByRole('button', { name: 'Report a bug' })).toHaveCount(0);
  });

  test('points at the operator tracker when one is configured', async ({ page }) => {
    await setup(page, { url: 'https://helpdesk.internal/new' });
    await page.goto('/me/work');

    await openUserMenu(page);
    await page.getByRole('button', { name: 'Report a bug' }).click();

    await expect(
      page.getByRole('dialog').getByRole('link', { name: 'Continue to tracker' }),
    ).toHaveAttribute('href', /helpdesk\.internal/);
  });
});
