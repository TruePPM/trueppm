import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * #2729 / ADR-0789, superseded layout per #2728 — the template list as the Start
 * sheet's Template-way detail panel (no longer a nested gallery that also folds in
 * "Blank project"; Blank is now its own peer way-in card).
 *
 * Golden path: pick a template, create the project, and confirm the apply is fired
 * with the new project's id (the wizard needs a project to seed *into*, so the flow
 * creates one and hands it in). Plus the states that decide whether the list is
 * trustworthy — the provenance chip being legible **before** adoption, and a failed
 * fetch still leaving Blank/Import open.
 */

const NEW_PID = 'e2e-2729-0000-0000-0000-000000000042';

const pj = (b: unknown) => JSON.stringify(b);
const page200 = { count: 0, next: null, previous: null, results: [] };

/** A bundled starter — `community` provenance, which the gallery labels Bundled. */
const BUNDLED = {
  id: 'tpl-0000-0000-0000-000000000002',
  name: 'Scrum product team',
  description: 'Discovery, then two sprints.',
  source_kind: 'community',
  provenance: 'Community',
  carries: ['structure', 'dependencies'],
  methodology: 'AGILE',
  task_count: 13,
  version: 1,
  program: null,
  published_at: '2026-08-01T00:00:00Z',
};

const TEMPLATE = {
  id: 'tpl-0000-0000-0000-000000000001',
  name: 'Delivery skeleton',
  description: 'Phases and gates',
  source_kind: 'workspace',
  provenance: 'Workspace',
  carries: ['structure', 'dependencies'],
  methodology: 'HYBRID',
  task_count: 12,
  version: 1,
  program: null,
  published_at: '2026-08-01T00:00:00Z',
};

async function setup(
  page: import('@playwright/test').Page,
  opts: { templatesStatus?: number; templatesEmpty?: boolean; templatesMulti?: boolean } = {},
) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e', refreshToken: 'r', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/token/refresh/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ access: 'e2e' }) }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ id: 1, username: 'e2e', email: 'e2e@example.com', workspace_role: 300 }),
    }),
  );
  await page.route('**/api/v1/me/notifications/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) }),
  );
  await page.route('**/api/v1/projects/', (r) => {
    if (r.request().method() === 'POST') {
      return r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: pj({ id: NEW_PID, name: 'From template', server_version: 1 }),
      });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) });
  });
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  // The My Work empty state is the entry point: it renders "Create your first
  // project", which opens the same Start sheet. Chosen over the program overview
  // deliberately — that page reads object-shaped endpoints (/rollup/) that a
  // list-shaped catch-all would crash on, taking the whole app down behind an
  // error boundary and surfacing as an unrelated click timeout (#1190).
  await page.route('**/api/v1/me/work/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
      }),
    }),
  );
  await page.route('**/api/v1/project-templates/**', (r) =>
    r.fulfill({
      status: opts.templatesStatus ?? 200,
      contentType: 'application/json',
      body: pj(
        (opts.templatesStatus ?? 200) === 200
          ? {
              count: opts.templatesEmpty ? 0 : opts.templatesMulti ? 2 : 1,
              next: null,
              previous: null,
              results: opts.templatesEmpty
                ? []
                : opts.templatesMulti
                  ? [TEMPLATE, BUNDLED]
                  : [TEMPLATE],
            }
          : { detail: 'boom' },
      ),
    }),
  );
  await page.goto('/me/work');
}

/** Open the one-screen Start sheet and fill the required Name field (#2728). */
async function openStartSheet(page: import('@playwright/test').Page) {
  // Gate on the empty state having rendered before touching its CTA — clicking
  // before the reads resolve races the bootstrap (the #1190 detach flake class).
  await expect(page.getByRole('heading', { name: /get you started/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Create your first project' }).click();
  const dialog = page.getByRole('dialog', { name: /new project/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: /name/i }).fill('From template');
  return dialog;
}

test.describe('Project template list — the Start sheet Template way (#2729, #2728)', () => {
  test('the provenance chip and row count are legible before adoption', async ({ page }) => {
    // Who published a skeleton is the first thing a delivery lead judges it by, so
    // it has to be readable *before* committing, not discovered after seeding.
    await setup(page);
    const dialog = await openStartSheet(page);
    await dialog.getByRole('radio', { name: /^template/i }).click();

    const option = dialog.getByRole('radio', { name: /Delivery skeleton/i });
    await expect(option).toBeVisible();
    await expect(option).toContainText('Workspace');
    await expect(option).toContainText('12 rows');
    await expect(option).toContainText(/never owners, dates, or progress/i);
  });

  test('picking a template applies it to the project that was just created', async ({ page }) => {
    await setup(page);
    const dialog = await openStartSheet(page);
    await dialog.getByRole('radio', { name: /^template/i }).click();

    const applyRequest = page.waitForRequest(
      (req) => req.url().includes(`/project-templates/${TEMPLATE.id}/apply/`) && req.method() === 'POST',
    );

    await dialog.getByRole('radio', { name: /Delivery skeleton/i }).click();
    await dialog.getByRole('button', { name: /create project/i }).click();

    // The apply must carry the id of the project the create just returned — the
    // template needs a project to seed into, and handing it the wrong one (or none)
    // is the failure this assertion exists to catch.
    const req = await applyRequest;
    expect(req.postDataJSON()).toEqual({ project: NEW_PID });
  });

  test('Blank is the default way and fires no apply', async ({ page }) => {
    // Starting from nothing must stay a first-class choice, not an escape hatch —
    // #2728 promoted it to a peer way-in card, same size and row as Template.
    await setup(page);
    const dialog = await openStartSheet(page);
    await expect(dialog.getByRole('radio', { name: /^blank/i })).toHaveAttribute('aria-checked', 'true');

    let applyCalled = false;
    await page.route('**/api/v1/project-templates/*/apply/', (r) => {
      applyCalled = true;
      return r.fulfill({ status: 202, contentType: 'application/json', body: pj({ queued: true }) });
    });
    await dialog.getByRole('button', { name: /create project/i }).click();
    await page.waitForTimeout(300);
    expect(applyCalled).toBe(false);
  });

  test('a failed template fetch still leaves Blank/Import open', async ({ page }) => {
    // The user is mid-flow on their most important commitment; a fetch error must
    // degrade to "pick another way", never strand them.
    await setup(page, { templatesStatus: 500 });
    const dialog = await openStartSheet(page);
    await dialog.getByRole('radio', { name: /^template/i }).click();

    // #2909 restates this: a list failure is not a creation failure, and says so.
    await expect(dialog.getByText(/Blank.*Import.*still work/i)).toBeVisible();
    // Create is disabled on Template with nothing to select — but the user can
    // still pick a sibling way and proceed.
    await dialog.getByRole('radio', { name: /^blank/i }).click();
    await expect(dialog.getByRole('button', { name: /create project/i })).toBeEnabled();
  });
});


test.describe('Template way-in is never empty (#2909)', () => {
  test('the empty state names a screen that exists, and links to it', async ({ page }) => {
    // The whole ticket: the old copy said "publish one from a project's Settings"
    // when that page had never been built, so the way in was a dead end.
    await setup(page, { templatesEmpty: true });
    const dialog = await openStartSheet(page);
    await dialog.getByRole('radio', { name: /^template/i }).click();

    await expect(dialog.getByText('No templates yet')).toBeVisible();
    // This fixture is a genuinely fresh workspace — "Create your first project"
    // means there is nothing to publish *from* yet, so the prose variant is the
    // correct state and a link would point at nothing. The route variant is
    // covered in TemplateGallery.test.tsx, where a project exists.
    await expect(dialog.getByText(/Settings → Templates/)).toBeVisible();
    await expect(dialog.getByText(/Project Manager role on it/)).toBeVisible();

    // And the other two ways are still offered rather than implied.
    await expect(dialog.getByText(/Blank.*Import.*are ready to use now/i)).toBeVisible();
  });

  test('bundled starters are legible as bundled and sort after local shapes', async ({
    page,
  }) => {
    await setup(page, { templatesMulti: true });
    const dialog = await openStartSheet(page);
    await dialog.getByRole('radio', { name: /^template/i }).click();

    const rows = dialog.getByRole('radio', { name: /skeleton|Scrum product team/ });
    await expect(rows.first()).toContainText('Delivery skeleton');
    // On a workspace with its own published shape, the bundled starter reads
    // second — order is a nudge, and the chip carries the information.
    await expect(rows.nth(1)).toContainText('Scrum product team');
    await expect(rows.nth(1)).toContainText('Community');
  });
});
