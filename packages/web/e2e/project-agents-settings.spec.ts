import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Project Settings → Agents E2E (#2482, ADR-0678).
 *
 * The team's own consent switch over AI/MCP agent reads. Covers the golden path
 * (override to Blocked → one PATCH carrying `mcp_enabled: false`), the inherited
 * state, the read-only render below Admin, and the blocked-state explanation.
 *
 * The distinguishing behavior this spec pins, versus the other inheritable
 * settings pages: the control is driven by `effective_mcp_enabled` from the
 * server, which deliberately EXCLUDES the instance-wide kill switch — so the
 * blocked note reflects the *team's* decision, not the operator's.
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-project-00000000-0000-0000-0000-000000002482';

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
  name: 'Atlas Migration',
  description: '',
  start_date: '2026-04-01',
  status_date: null,
  calendar: 'cal-default',
  calendar_source: 'project',
  effective_calendar: {
    id: 'cal-default',
    name: 'Workspace standard',
    working_days: 31,
    hours_per_day: 8,
  },
  estimation_mode: 'open',
  agile_features: false,
  methodology: 'HYBRID',
  code: 'ATLAS',
  health: 'ON_TRACK',
  visibility: 'WORKSPACE',
  timezone: 'Europe/London',
  default_view: 'BOARD',
  public_sharing: null,
  allow_guests: null,
  effective_public_sharing: false,
  effective_allow_guests: true,
  inherited_public_sharing: false,
  inherited_allow_guests: true,
  // Agent read consent (ADR-0678). null = no opinion; inherited/effective both
  // true = nobody above has objected, so the team is currently open to agents.
  mcp_enabled: null,
  effective_mcp_enabled: true,
  inherited_mcp_enabled: true,
  program: null,
  program_detail: null,
};

type Page = import('@playwright/test').Page;
type Route = import('@playwright/test').Route;

interface Captures {
  patch?: Record<string, unknown>;
}

async function setup(
  page: Page,
  captures: Captures,
  opts: { selfRole?: number; project?: Record<string, unknown> } = {},
) {
  // Role ordinals (ADR-0072): VIEWER=1, MEMBER=100, SCHEDULER=200, ADMIN=300,
  // OWNER=400. The write affordance gates on role >= ADMIN.
  const selfRole = opts.selfRole ?? 300;
  const project = { ...FIXTURE_PROJECT, ...(opts.project ?? {}) };

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
  await page.route('**/api/v1/calendars/**', (r) =>
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
      body: pj({ results: [project], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      captures.patch = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...project, ...captures.patch }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: pj(project) });
  });
  // useCurrentUserRole reads the first row of this self-scoped list (a plain
  // array, not the paginated envelope). Without it the role resolves null and the
  // control renders read-only, which would make the Admin tests pass vacuously.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([{ id: 'membership-self', role: selfRole }]),
    }),
  );
}

test.describe('Project Settings → Agents', () => {
  test('starts inheriting and PATCHes mcp_enabled:false when blocked', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings#agents`);

    // Every section mounts at once on the consolidated settings page (ADR-0146),
    // so scope to this one — "Agents" also names a nav entry and a project tab.
    const section = page.locator('[data-settings-section="agents"]');
    await expect(section.getByRole('heading', { name: 'Agents' })).toBeVisible();
    await expect(section.getByText('Agent read access')).toBeVisible();

    // Inheriting, and nothing above objected → no blocked explanation yet.
    await expect(section.getByTestId('agent-access-blocked-note')).toHaveCount(0);

    const group = section.getByRole('radiogroup', { name: 'Agent read access' });
    await expect(group).toBeVisible();
    // Click the LABEL, not the radio: InheritableToggleField renders the input as
    // `sr-only` inside its label, so the label intercepts pointer events and a
    // click targeted at the zero-size input never lands.
    await group.locator('label', { hasText: 'Override' }).click();
    await expect(group.getByRole('radio', { name: /Override/ })).toBeChecked();

    // The switch seeds from the currently-effective value (Allowed), so flip it.
    await section.getByRole('switch', { name: 'Agent read access' }).click();
    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect.poll(() => captures.patch).toBeTruthy();
    expect(captures.patch).toMatchObject({ mcp_enabled: false });
  });

  test('explains the consequence when agent reads are blocked', async ({ page }) => {
    await setup(page, {}, { project: { mcp_enabled: false, effective_mcp_enabled: false } });
    await page.goto(`/projects/${PROJECT_ID}/settings#agents`);

    const section = page.locator('[data-settings-section="agents"]');
    await expect(section.getByTestId('agent-access-blocked-note')).toBeVisible();
    await expect(section.getByTestId('agent-access-blocked-note')).toContainText('blocked');
  });

  test('shows the blocked note when the block is INHERITED, not set here', async ({ page }) => {
    // The note keys off the RESOLVED value, so a program/workspace denial explains
    // itself on the project page too — the team can see it is blocked even though
    // this project holds no opinion of its own.
    await setup(
      page,
      {},
      {
        project: { mcp_enabled: null, inherited_mcp_enabled: false, effective_mcp_enabled: false },
      },
    );
    await page.goto(`/projects/${PROJECT_ID}/settings#agents`);

    const section = page.locator('[data-settings-section="agents"]');
    await expect(section.getByTestId('agent-access-blocked-note')).toBeVisible();
  });

  test('renders read-only below Admin', async ({ page }) => {
    await setup(page, {}, { selfRole: 200 }); // SCHEDULER
    await page.goto(`/projects/${PROJECT_ID}/settings#agents`);

    const section = page.locator('[data-settings-section="agents"]');
    await expect(section.getByText('Agent read access')).toBeVisible();
    // No write affordance — the server refuses the write too (the field sits
    // outside the serializer's Scheduler-writable allowlist), so this only
    // spares a doomed save.
    await expect(section.getByRole('radiogroup', { name: 'Agent read access' })).toHaveCount(0);
  });
});
