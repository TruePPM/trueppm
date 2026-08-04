import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * #2729 / ADR-0789 — the template gallery in the Start sheet.
 *
 * Golden path: pick a template, create the project, and confirm the apply is fired
 * with the new project's id (the wizard needs a project to seed *into*, so the flow
 * creates one and hands it in). Plus the two states that decide whether the gallery
 * is trustworthy — the provenance chip being legible **before** adoption, and a
 * failed gallery fetch still leaving the blank path open.
 */

const NEW_PID = 'e2e-2729-0000-0000-0000-000000000042';

const pj = (b: unknown) => JSON.stringify(b);
const page200 = { count: 0, next: null, previous: null, results: [] };

const TEMPLATE = {
  id: 'tpl-0000-0000-0000-000000000001',
  name: 'Delivery skeleton',
  description: 'Phases and gates',
  source_kind: 'workspace',
  provenance: 'Workspace',
  carries: ['structure', 'dependencies'],
  task_count: 12,
  version: 1,
  program: null,
  published_at: '2026-08-01T00:00:00Z',
};

async function setup(
  page: import('@playwright/test').Page,
  opts: { templatesStatus?: number } = {},
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
          ? { count: 1, next: null, previous: null, results: [TEMPLATE] }
          : { detail: 'boom' },
      ),
    }),
  );
  await page.goto('/me/work');
}

/** Drive the 3-step Start sheet to its final step, where the gallery lives. */
async function openStartSheetAtStep3(page: import('@playwright/test').Page) {
  // Gate on the empty state having rendered before touching its CTA — clicking
  // before the reads resolve races the bootstrap (the #1190 detach flake class).
  await expect(page.getByRole('heading', { name: /get you started/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Create your first project' }).click();
  const dialog = page.getByRole('dialog', { name: /new project/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: /name/i }).fill('From template');
  await dialog.getByRole('button', { name: /^next$/i }).click();
  await dialog.getByRole('button', { name: /^next$/i }).click();
  return dialog;
}

test.describe('Project template gallery (#2729)', () => {
  test('the provenance chip and row count are legible before adoption', async ({ page }) => {
    // Who published a skeleton is the first thing a delivery lead judges it by, so
    // it has to be readable *before* committing, not discovered after seeding.
    await setup(page);
    const dialog = await openStartSheetAtStep3(page);

    const option = dialog.getByRole('radio', { name: /Delivery skeleton/i });
    await expect(option).toBeVisible();
    await expect(option).toContainText('Workspace');
    await expect(option).toContainText('12 rows');
    await expect(option).toContainText(/never owners, dates, or progress/i);
  });

  test('picking a template applies it to the project that was just created', async ({ page }) => {
    await setup(page);
    const dialog = await openStartSheetAtStep3(page);

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

  test('blank project is selected by default and fires no apply', async ({ page }) => {
    // Starting from nothing must stay a first-class choice, not an escape hatch.
    await setup(page);
    const dialog = await openStartSheetAtStep3(page);
    await expect(dialog.getByRole('radio', { name: /blank project/i })).toBeChecked();

    let applyCalled = false;
    await page.route('**/api/v1/project-templates/*/apply/', (r) => {
      applyCalled = true;
      return r.fulfill({ status: 202, contentType: 'application/json', body: pj({ queued: true }) });
    });
    await dialog.getByRole('button', { name: /create project/i }).click();
    await page.waitForTimeout(300);
    expect(applyCalled).toBe(false);
  });

  test('a failed gallery fetch still leaves the blank path open', async ({ page }) => {
    // The user is mid-flow on their most important commitment; a gallery error must
    // degrade to "you can still start", never strand them.
    await setup(page, { templatesStatus: 500 });
    const dialog = await openStartSheetAtStep3(page);

    await expect(dialog.getByText(/still start from a blank project/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /create project/i })).toBeEnabled();
  });
});
