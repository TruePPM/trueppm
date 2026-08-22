import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Project · Settings · Templates → publish (#2909 screen, #2970 card preview).
 *
 * The publish flow shipped with unit coverage only. This is the end-to-end
 * check that the screen the gallery's empty state promises is reachable, that
 * the two steps write nothing until the second one is confirmed, and that the
 * preview a publisher judges the name by is the *gallery's own card* rather
 * than a mock-up of it — the assertion that would fail if the two ever drift.
 */

const PROJECT_ID = 'e2e-tplpub-0000-0000-0000-000000002970';
const ME_ID = 'user-alice';
const pj = (b: unknown) => JSON.stringify(b);

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Vega Platform',
  description: 'Original description.',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
  board_cadence: 'sprint',
};

const PREVIEW = {
  task_count: 82,
  phase_count: 6,
  gate_count: 4,
  milestone_count: 5,
  dependency_count: 14,
  methodology: 'AGILE',
  carries: ['structure', 'dependencies', 'durations'],
  name_taken: false,
  next_version: 1,
  existing_template: null,
};

const ADMIN_MEMBERSHIP = {
  id: 'mem-self',
  server_version: 1,
  project: PROJECT_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 300,
  role_label: 'Project Admin',
};

type Page = import('@playwright/test').Page;

interface Captures {
  publish?: Record<string, unknown>;
}

async function setup(page: Page, captures: Captures, opts: { role?: number } = {}) {
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
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ id: ME_ID, username: 'alice', email: 'alice@example.com', display_name: 'Alice' }),
    }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
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
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([{ ...ADMIN_MEMBERSHIP, role: opts.role ?? 300 }]),
    }),
  );
  await page.route('**/api/v1/project-templates/publish-preview/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(PREVIEW) }),
  );
  await page.route('**/api/v1/project-templates/from-project/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/project-templates/publish/', async (route) => {
    captures.publish = (await route.request().postDataJSON()) as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: pj({
        id: 'tpl-new',
        name: captures.publish?.name ?? 'x',
        description: '',
        source_kind: 'workspace',
        provenance: 'Yours',
        carries: PREVIEW.carries,
        methodology: 'AGILE',
        task_count: PREVIEW.task_count,
        version: 1,
        program: null,
        published_at: '2026-08-22T00:00:00Z',
      }),
    });
  });
}

/** The publish sheet, opened from the Templates settings section. */
async function openSheet(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/settings#templates`);
  // Gate on the counts having landed: the button is disabled until the dry run
  // resolves, so clicking on the heading alone races the preview fetch.
  await expect(page.getByText('What would be published today')).toBeVisible();
  await expect(page.getByText('82', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Publish as template…' }).click();
  return page.getByRole('dialog');
}

test.describe('publishing a project as a template', () => {
  test('the card preview is the gallery card, and tracks what is typed', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    const dialog = await openSheet(page);

    const card = dialog.getByTestId('template-card-preview');
    await expect(card).toBeVisible();
    // Seeded from the project name, chipped as the publisher's own, and
    // carrying the same server counts the gallery would show.
    await expect(card).toContainText('Vega Platform delivery shape');
    await expect(card).toContainText('Yours');
    await expect(card).toContainText('carries 6 phases · 4 gates · 14 deps');
    await expect(card).toContainText('never owners, dates, or progress');

    const name = dialog.getByLabel(/Template name/);
    await name.fill('House scrum shape');
    await expect(card).toContainText('House scrum shape');

    await dialog.getByLabel(/Description/).fill('For a feature team of six');
    await expect(card).toContainText('For a feature team of six');
  });

  test('the preview advertises no choice — it is inert', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    const dialog = await openSheet(page);
    const card = dialog.getByTestId('template-card-preview');
    await expect(card.locator('button, a, input, [tabindex]')).toHaveCount(0);
  });

  test('step 1 writes nothing — only the second screen publishes', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    const dialog = await openSheet(page);

    await dialog.getByLabel(/Template name/).fill('House scrum shape');
    await dialog.getByRole('button', { name: 'Review and publish' }).click();
    // Crossing to step 2 is still not a write.
    expect(captures.publish).toBeUndefined();

    await dialog.getByRole('button', { name: /^Publish v1$/ }).click();
    await expect.poll(() => captures.publish?.name).toBe('House scrum shape');
  });

  test('a Member is told the rule, not shown a control they cannot press', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures, { role: 100 });
    await page.goto(`/projects/${PROJECT_ID}/settings#templates`);
    await expect(
      page.getByText('Publishing a template needs Project Manager role'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish as template…' })).toHaveCount(0);
  });
});
