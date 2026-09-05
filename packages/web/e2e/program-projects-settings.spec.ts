import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program Settings → Projects E2E (#524).
 *
 * Verifies the page is wired to the real `/api/v1/programs/:id/projects/`
 * endpoint and surfaces loading, empty, and populated states — and that
 * the "Preview — not yet saved" stub banner no longer renders.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000524';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Phase 2 Modernization',
  description: 'Q3 platform rebuild',
  methodology: 'HYBRID',
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 2,
  member_count: 1,
};

type Page = import('@playwright/test').Page;

async function setup(
  page: Page,
  projects: Array<Record<string, unknown>>,
  opts: { methodologyOverridePolicy?: string } = {},
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

  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
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
      body: pj({ results: [FIXTURE_PROGRAM], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(projects) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  // The matrix reads the workspace methodology policy for the rule-196 lock, and the
  // deviation marker re-parents to the workspace under it (#3295). Mock the real
  // object shape — the catch-all 404s, which leaves the policy undefined.
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
        methodology_override_policy: opts.methodologyOverridePolicy ?? 'suggest',
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

/** A program project row. `inherited_methodology` is what `ProjectSerializer` returns
 *  from `resolve_inherited_methodology` — never null, so a row that omits it is a
 *  stale client, not an expected payload. */
function project(
  id: string,
  name: string,
  methodology: string,
  inherited: string | null = 'HYBRID',
): Record<string, unknown> {
  return {
    id,
    name,
    description: '',
    start_date: '2026-01-01',
    methodology,
    effective_methodology: methodology,
    ...(inherited === null ? {} : { inherited_methodology: inherited }),
    program: PROGRAM_ID,
  };
}

test.describe('Program Settings → Projects', () => {
  test('renders real projects from the API and no stub banner', async ({ page }) => {
    await setup(page, [
      {
        id: 'pr-1',
        name: 'Artemis IV Lift',
        description: '',
        start_date: '2026-01-01',
        methodology: 'WATERFALL',
        program: PROGRAM_ID,
      },
      {
        id: 'pr-2',
        name: 'Launch Control Software',
        description: '',
        start_date: '2026-01-01',
        methodology: 'AGILE',
        program: PROGRAM_ID,
      },
    ]);

    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);

    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(page.getByText('Artemis IV Lift')).toBeVisible();
    await expect(page.getByText('Launch Control Software')).toBeVisible();
    await expect(page.getByText(/2 projects/)).toBeVisible();
    // Admin (role 400) gets the bulk-edit matrix: an action bar + per-row selection.
    await expect(page.getByTestId('bulk-fields-action-bar')).toBeVisible();
    await expect(page.getByLabel('Select Artemis IV Lift')).toBeVisible();

    // The hardcoded fixture row from the stub page must not appear.
    await expect(page.getByText('Ground Support Equipment')).toHaveCount(0);
  });

  test('admin bulk-sets a field on the selected projects (issue 1233)', async ({ page }) => {
    await setup(page, [
      { id: 'pr-1', name: 'Artemis IV Lift', description: '', start_date: '2026-01-01', methodology: 'WATERFALL', program: PROGRAM_ID },
      { id: 'pr-2', name: 'Launch Control Software', description: '', start_date: '2026-01-01', methodology: 'AGILE', program: PROGRAM_ID },
    ]);
    let posted: { ids: string[]; fields: Record<string, unknown> } | null = null;
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/bulk-project-fields/`, async (route) => {
      posted = route.request().postDataJSON() as { ids: string[]; fields: Record<string, unknown> };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: posted.ids.map((id) => ({ id, server_version: 2 })), fields: Object.keys(posted.fields) }),
      });
    });

    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    // Select one project, stage a methodology value, apply. The settings page is the
    // consolidated SettingsShell (rule 195) — all sections mount at once, so the
    // General section's own Methodology radiogroup also has an "Agile" radio. Scope to
    // the bulk action bar to avoid the strict-mode collision.
    await page.getByLabel('Select Artemis IV Lift').check();
    const bar = page.getByTestId('bulk-fields-action-bar');
    await bar.getByRole('radio', { name: 'Agile' }).click();
    await page.getByTestId('bulk-fields-apply').click();

    await expect.poll(() => posted).not.toBeNull();
    expect(posted!.ids).toEqual(['pr-1']);
    expect(posted!.fields).toEqual({ methodology: 'AGILE' });
  });

  test('shows empty state when the program has no projects', async ({ page }) => {
    await setup(page, []);
    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);

    await expect(page.getByText(/No projects in this program yet/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Add project/i })).toBeVisible();
  });
});

/**
 * Deviation visibility (#3295). The flag was computed per row and thrown away:
 * `ValueCell` annotated only `resettable` fields and methodology is `resettable:
 * false` (web-rule 196), so a 40-project scan told you every project's value and
 * never which ones deviate.
 */
test.describe('Program Settings → Projects — deviation from the default', () => {
  const DEVIATING = [
    project('pr-1', 'Artemis IV Lift', 'WATERFALL'),
    project('pr-2', 'Launch Control Software', 'AGILE'),
    project('pr-3', 'Ground Support Rig', 'HYBRID'),
  ];

  test('marks the deviating rows, counts them in the header, and filters to them', async ({
    page,
  }) => {
    await setup(page, DEVIATING);
    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    // Per-cell marker: text plus ≠, in the grammar of the existing "— inherited"
    // treatment. Two of three rows deviate from the program's HYBRID.
    const markers = page.getByTestId('deviation-marker-methodology');
    await expect(markers).toHaveCount(2);
    await expect(markers.first()).toHaveText('Waterfall ≠ program (Hybrid)');
    // Per-column count, as label text rather than a control.
    await expect(page.getByTestId('deviation-count')).toHaveText('· 2 differ');

    // The filter is mounted on THIS page for the first time. Scope every query to it —
    // the consolidated settings shell also carries the General section's own
    // Methodology radiogroup and the bulk bar's value picker.
    const filter = page.getByRole('radiogroup', { name: 'Filter by methodology' });
    await expect(filter).toBeVisible();
    await filter.getByRole('radio', { name: 'Deviates from default, 2' }).click();

    await expect(page.getByText('Artemis IV Lift')).toBeVisible();
    await expect(page.getByText('Ground Support Rig')).toHaveCount(0);
    await expect(page.getByTestId('bulk-fields-scope-note')).toHaveText(
      '2 of 3 shown · Deviates from default',
    );
    // The header tally keeps the facet chips' denominator — one word, one number.
    await expect(page.getByTestId('deviation-count')).toHaveText('· 2 differ');
  });

  test('clears a live selection when the cohort changes', async ({ page }) => {
    await setup(page, DEVIATING);
    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    const row = page.getByLabel('Select Ground Support Rig');
    await row.check();
    await expect(row).toBeChecked();

    await page
      .getByRole('radiogroup', { name: 'Filter by methodology' })
      .getByRole('radio', { name: 'Deviates from default, 2' })
      .click();

    // Ground Support is not in the new cohort at all, so an Apply can no longer
    // reach a row the user checked but can no longer see.
    await expect(page.getByLabel('Select Ground Support Rig')).toHaveCount(0);
    await expect(page.getByTestId('bulk-fields-apply')).toBeDisabled();
  });

  test('says "none differ" and disables the zero option when every project matches', async ({
    page,
  }) => {
    await setup(page, [
      project('pr-1', 'Artemis IV Lift', 'HYBRID'),
      project('pr-2', 'Launch Control Software', 'HYBRID'),
    ]);
    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    // "I checked, and none" — not "0 differ", and not silence.
    await expect(page.getByTestId('deviation-count')).toHaveText('· none differ');
    await expect(page.getByTestId('deviation-marker-methodology')).toHaveCount(0);
    const zero = page
      .getByRole('radiogroup', { name: 'Filter by methodology' })
      .getByRole('radio', { name: 'Deviates from default, 0' });
    await expect(zero).toBeVisible();
    await expect(zero).toHaveAttribute('aria-disabled', 'true');
  });

  test('renders nothing at all when the payload carries no inherited value', async ({ page }) => {
    // A stale client. The diff is purely additive over the pre-#3295 render, so this
    // degrades to the current product rather than to a broken one — and a disabled
    // zero would claim a check that never happened.
    await setup(page, [
      project('pr-1', 'Artemis IV Lift', 'WATERFALL', null),
      project('pr-2', 'Launch Control Software', 'AGILE', null),
    ]);
    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    await expect(page.getByTestId('deviation-count')).toHaveCount(0);
    await expect(page.getByTestId('deviation-marker-methodology')).toHaveCount(0);
    const filter = page.getByRole('radiogroup', { name: 'Filter by methodology' });
    await expect(filter.getByRole('radio')).toHaveCount(4);
    await expect(filter.getByRole('radio', { name: /Deviates/ })).toHaveCount(0);
  });

  test('re-parents label, count and marker to the workspace under an inherit lock', async ({
    page,
  }) => {
    // Under a lock `resolve_inherited_methodology` returns the WORKSPACE value, and
    // the effective value is the workspace's on every row — so a row that still
    // differs is a pre-lock override the policy has not reconciled, which makes this
    // column more useful under a lock, not less.
    await setup(
      page,
      [
        { ...project('pr-1', 'Artemis IV Lift', 'WATERFALL'), effective_methodology: 'HYBRID' },
        { ...project('pr-2', 'Launch Control Software', 'HYBRID'), effective_methodology: 'HYBRID' },
      ],
      { methodologyOverridePolicy: 'inherit' },
    );
    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    await expect(page.getByTestId('deviation-marker-methodology')).toHaveText(
      'Waterfall ≠ workspace (Hybrid)',
    );
    // Constraint before count.
    await expect(page.getByTestId('bulk-fields-header')).toContainText(
      'Methodology · read-only · 1 differ',
    );
    // A house SVG, never a Unicode emoji (rule 242).
    await expect(page.getByTestId('bulk-fields-header').locator('svg[aria-hidden="true"]')).toBeVisible();
    const lockedFilter = page.getByRole('radiogroup', { name: 'Filter by methodology' });
    await expect(
      lockedFilter.getByRole('radio', { name: 'Deviates from workspace, 1' }),
    ).toBeVisible();
    // Bucketing on `effective_methodology` here would read "Waterfall 0" directly
    // above a visible cell saying "Waterfall ≠ workspace (Hybrid)".
    await expect(lockedFilter.getByRole('radio', { name: 'Waterfall, 1' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  test('below 768px the read layer survives and the write layer does not', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, DEVIATING);
    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    // Markers, header count and the filter are all intact — checking a deviation
    // count from a phone is a real errand.
    await expect(page.getByTestId('deviation-marker-methodology')).toHaveCount(2);
    await expect(page.getByTestId('deviation-count')).toHaveText('· 2 differ');
    const filter = page.getByRole('radiogroup', { name: 'Filter by methodology' });
    // Collapsed to the one comparison worth a 44px target.
    await expect(filter.getByRole('radio')).toHaveCount(2);
    await expect(filter.getByRole('radio', { name: 'Deviates from default, 2' })).toBeVisible();

    // Bulk editing on a phone is not an errand.
    await expect(page.getByTestId('bulk-fields-action-bar')).toHaveCount(0);
    await expect(page.getByLabel('Select Artemis IV Lift')).toHaveCount(0);
    await expect(page.getByLabel('Select all rows')).toHaveCount(0);
    await expect(page.getByTestId('bulk-fields-narrow-wall')).toHaveText(
      'Bulk edits need a wider screen.',
    );
  });
});
