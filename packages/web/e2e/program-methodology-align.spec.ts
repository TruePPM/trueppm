import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program methodology → "Align the N" offer and its deep link (#3293).
 *
 * Setting a program's methodology does not re-shape the projects already in it —
 * `methodology` is NOT-NULL at every scope, so effective resolution short-circuits on
 * the project's own value. The offer states the resolved consequence after a save and
 * links to the one surface that can change it.
 *
 * This spec covers the seam the unit tests cannot: program settings is ONE consolidated
 * scrolling page (ADR-0146), so the offer's link is an in-page navigation between two
 * already-mounted sections. The arming has to survive that.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000003293';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
  can_access_admin_settings: true,
};

type Page = import('@playwright/test').Page;

const pj = (data: unknown) => JSON.stringify(data);

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

  /**
   * The program's methodology is live state, not a constant: the save PATCHes it and
   * both the program detail and the project roster are refetched by
   * `useUpdateProgram`'s invalidation. A stateless mock would re-serve HYBRID and the
   * offer would report the partition for a value nobody saved — the #2752 class.
   */
  let programMethodology = 'HYBRID';

  const program = () => ({
    id: PROGRAM_ID,
    server_version: 1,
    name: 'Phase 2 Modernization',
    description: 'Q3 platform rebuild',
    code: 'PH2',
    methodology: programMethodology,
    effective_methodology: programMethodology,
    inherited_methodology: 'HYBRID',
    health: 'AUTO',
    visibility: 'WORKSPACE',
    lead: null,
    lead_detail: null,
    created_by: ME_ID,
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    my_role: 400,
    my_role_label: 'Program Admin',
    project_count: 3,
    member_count: 1,
    public_sharing: null,
    allow_guests: null,
    effective_public_sharing: false,
    effective_allow_guests: true,
    inherited_public_sharing: false,
    inherited_allow_guests: true,
  });

  /** Two of the three run something other than Waterfall. */
  const PROJECT_METHODOLOGY: Record<string, string> = {
    'pr-1': 'AGILE',
    'pr-2': 'HYBRID',
    'pr-3': 'WATERFALL',
  };
  const PROJECT_NAME: Record<string, string> = {
    'pr-1': 'Artemis IV Lift',
    'pr-2': 'Launch Control Software',
    'pr-3': 'Ground Support Equipment',
  };
  const projectRows = () =>
    Object.keys(PROJECT_METHODOLOGY).map((id) => ({
      id,
      name: PROJECT_NAME[id],
      start_date: '2026-01-01',
      methodology: PROJECT_METHODOLOGY[id],
      effective_methodology: PROJECT_METHODOLOGY[id],
      // What `resolve_inherited_methodology` returns: the program's value. It moves
      // with the save, which is exactly what makes the matrix's deviation cohort and
      // the offer's partition describe the same three rows.
      inherited_methodology: programMethodology,
      program: PROGRAM_ID,
    }));

  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [program()], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const patch = JSON.parse(route.request().postData() ?? '{}') as { methodology?: string };
      if (patch.methodology) programMethodology = patch.methodology;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(program()),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: pj(program()) });
  });
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(projectRows()) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/workspace/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        name: 'Acme',
        subdomain: 'acme',
        timezone: 'UTC',
        fiscal_year_start_month: 1,
        fiscal_year_start_day: 1,
        fiscal_year_start_display: 'January 1',
        work_week: [false, true, true, true, true, true, false],
        default_project_view: 'SCHEDULE',
        allow_guests: false,
        public_sharing: false,
        public_sharing_override_policy: 'suggest',
        iteration_label: 'Sprint',
        iteration_label_override_policy: 'suggest',
        mc_history_enabled: false,
        mc_history_retention_cap: 10,
        mc_history_attribution_audience: 'ADMINS',
        mc_history_override_policy: 'suggest',
        task_duration_change_percent_policy: 'WARN',
        task_duration_change_percent_override_policy: 'suggest',
        estimation_scale: 'FIBONACCI',
        sprint_picker_ready_only_default: false,
        methodology: 'HYBRID',
        methodology_override_policy: 'suggest',
        attachments_enabled: true,
        allowed_attachment_types: [],
        attachments_override_policy: 'suggest',
        calendar: null,
        calendar_override_policy: 'suggest',
        logo_url: null,
      }),
    }),
  );
}

test.describe('Program methodology align offer (#3293)', () => {
  test('a save that leaves deviating projects offers a deep link that lands pre-scoped', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const general = page.locator('[data-settings-section="general"]');
    const projects = page.locator('[data-settings-section="projects"]');
    // Gate on a rendered page, not just the control: both sections read their own
    // endpoints and an early click races them (#1190).
    await expect(general.getByRole('radiogroup', { name: 'Methodology' })).toBeVisible();
    await expect(projects.getByText('Artemis IV Lift')).toBeVisible();

    // No offer before a save — it reports on a write, not on a state.
    await expect(page.getByTestId('methodology-align-offer')).toHaveCount(0);

    await general
      .getByRole('radiogroup', { name: 'Methodology' })
      .getByRole('radio', { name: 'Waterfall' })
      .click();
    await page.getByRole('button', { name: /Save changes/i }).click();

    // The offer: "Saved." first, then the resolved partition.
    const offer = page.getByTestId('methodology-align-offer');
    await expect(offer).toBeVisible();
    await expect(offer).toContainText(
      '1 of 3 projects in this program run as Waterfall; 2 do not.',
    );
    await expect(offer).toContainText('Existing projects keep their own methodology.');

    // D19 — a link, never a button. Its accessible name says what "the 2" are.
    const align = page.getByRole('link', { name: 'Align the 2 projects that differ' });
    await expect(align).toHaveText('Align the 2');
    await align.click();

    // Arrival: the deviation cohort is in force and its rows are checked.
    const filter = projects.getByRole('radiogroup', { name: 'Filter by methodology' });
    await expect(filter.getByRole('radio', { name: 'Deviates from default, 2' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(projects.getByLabel('Select Artemis IV Lift')).toBeChecked();
    await expect(projects.getByLabel('Select Launch Control Software')).toBeChecked();
    // The matching project is outside the cohort entirely.
    await expect(projects.getByLabel('Select Ground Support Equipment')).toHaveCount(0);

    await expect(projects.getByLabel('Field to set')).toHaveValue('methodology');

    /**
     * D41's load-bearing half: nothing is staged, so Apply is disabled and #3296's
     * preview cannot be reached without the admin's own press. A link that arrived
     * armed would be a bulk write behind a URL.
     */
    await expect(projects.getByTestId('bulk-fields-apply')).toBeDisabled();

    // The arrival is announced on the matrix's own live region, not a second one, and
    // it names the next act — Apply is disabled on arrival by design (D19).
    await expect(projects.locator('[aria-live="polite"]')).toHaveText(
      'Methodology selected for 2 of 3 projects. Choose a methodology, then Apply.',
    );

    // Read once and stripped — a refresh must not silently re-check rows.
    await expect
      .poll(() => new URL(page.url()).search)
      .toBe('');
  });

  // D20 — the offer renders when there is nothing to offer, too. This is the only
  // sentence in the cluster that licenses "the program is standardized", and without it
  // the all-match case is silence a PM can read however they like.
  test('states the all-match case rather than offering nothing', async ({ page }) => {
    await setup(page);
    // Registered after `setup`, so it wins: every project already runs Waterfall.
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(
          ['Artemis IV Lift', 'Launch Control Software'].map((name, i) => ({
            id: `pr-${i + 1}`,
            name,
            start_date: '2026-01-01',
            methodology: 'WATERFALL',
            effective_methodology: 'WATERFALL',
            inherited_methodology: 'WATERFALL',
            program: PROGRAM_ID,
          })),
        ),
      }),
    );
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const general = page.locator('[data-settings-section="general"]');
    await expect(general.getByRole('radiogroup', { name: 'Methodology' })).toBeVisible();

    await general
      .getByRole('radiogroup', { name: 'Methodology' })
      .getByRole('radio', { name: 'Waterfall' })
      .click();
    await page.getByRole('button', { name: /Save changes/i }).click();

    const offer = page.getByTestId('methodology-align-offer');
    await expect(offer).toContainText(
      'All 2 projects in this program already run as Waterfall.',
    );
    await expect(page.getByRole('link', { name: /^Align/ })).toHaveCount(0);
  });

  test('the offer goes away as soon as the form is dirty again', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const general = page.locator('[data-settings-section="general"]');
    const methodology = general.getByRole('radiogroup', { name: 'Methodology' });
    await expect(methodology).toBeVisible();

    await methodology.getByRole('radio', { name: 'Waterfall' }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect(page.getByTestId('methodology-align-offer')).toBeVisible();

    // A pending edit makes "Saved." describe a state the page is no longer in.
    await methodology.getByRole('radio', { name: 'Agile' }).click();
    await expect(page.getByTestId('methodology-align-offer')).toHaveCount(0);
  });
});

/**
 * Web-rule 399. `SettingsShell`'s hash effect is guarded once-per-hash-*value*, and this
 * link's hash is always `#projects` — so on a SECOND use the shell's effect early-returns
 * and, without the section's own `scrollIntoView`, the viewport never moves while the
 * matrix silently filters and pre-checks rows off-screen.
 *
 * The first-use spec above cannot see this: it enters via `/settings/general`, so the
 * hash is fresh, and it asserts arrival STATE rather than position.
 */
test.describe('Program methodology align offer — repeat use (#3293)', () => {
  test('scrolls to the matrix on the second use, not just the first', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const general = page.locator('[data-settings-section="general"]');
    const projects = page.locator('[data-settings-section="projects"]');
    const methodology = general.getByRole('radiogroup', { name: 'Methodology' });
    await expect(methodology).toBeVisible();
    await expect(projects.getByText('Artemis IV Lift')).toBeVisible();

    // First use — consumes the `#projects` hash.
    await methodology.getByRole('radio', { name: 'Waterfall' }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();
    await page.getByRole('link', { name: 'Align the 2 projects that differ' }).click();
    await expect(projects.getByLabel('Select Artemis IV Lift')).toBeChecked();

    // Back to the top, exactly as an admin correcting themselves would.
    await methodology.scrollIntoViewIfNeeded();
    await expect(methodology).toBeInViewport();
    await expect(projects.getByRole('radiogroup', { name: 'Filter by methodology' })).not.toBeInViewport();

    // Second use — the hash does not change, so only the section's own scroll can move
    // the viewport.
    await methodology.getByRole('radio', { name: 'Agile' }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();
    await page.getByRole('link', { name: 'Align the 2 projects that differ' }).click();

    await expect(projects.getByRole('radiogroup', { name: 'Filter by methodology' })).toBeInViewport();
  });
});
