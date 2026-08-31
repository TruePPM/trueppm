import type { Page, Route, Request } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/**
 * Create-as-draft, and the Draft -> Commit round trip it makes reachable (#3233).
 *
 * Until this, the entire draft apparatus guarded a state no user could enter.
 * `Project.lifecycle` defaults to ACTIVE and every `DRAFT` assignment in the repository
 * was inside a test fixture, so `POST /projects/{id}/commit/` answered
 * `409 already_committed` for every project that existed — while the Draft pill, the
 * Commit button, `CommitPlanConfirmDialog`, `commitRefusal`, `canCommitPlan`,
 * `draftExclusion` and 14 server-side exclusion call sites were all built, secured and
 * tested against it. `e2e/commit-plan.spec.ts` covers the commit moment itself, but it
 * has to *fixture* a draft into being; this spec is the half that proves a user can
 * produce one, and then walks the round trip.
 *
 * **The project-detail mock is stateful, for the reason commit-plan.spec.ts documents.**
 * `useCommitProject` invalidates `['project', id]` in `onSuccess`, so a stateless mock
 * re-serves `lifecycle: 'draft'` and the committed state exists only in the window
 * before the refetch lands — green on a quiet machine, red on a loaded runner, and
 * unfixable by raising the timeout (#2752).
 *
 * Built on `setupApiMocks` rather than a hand-rolled route table: the Overview is a
 * data-driven page whose hooks read several OBJECT-shaped endpoints, and the catch-all
 * serves a list shape (`{count:0,results:[]}`) for anything unmocked — truthy but
 * malformed, so the component destructuring it throws into the root error boundary and
 * the failure surfaces as an unrelated flaky click rather than a missing mock.
 */

const PROJECT_ID = 'e2e-draft-000000-0000-0000-0000-000000003233';
const CREATED_ID = 'e2e-newdraft-000-0000-0000-0000-000000003233';

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

interface State {
  lifecycle: 'draft' | 'active';
  createPayloads: Array<Record<string, unknown>>;
}

async function setupRoutes(page: Page): Promise<State> {
  const state: State = { lifecycle: 'draft', createPayloads: [] };

  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projectId: PROJECT_ID,
    projects: [
      {
        id: PROJECT_ID,
        name: 'Unagreed Plan',
        description: '',
        start_date: '2026-09-01',
        calendar: 'default',
        health: 'AUTO',
        open_task_count: 3,
        // The field #3233 restored to `mapProject` — dropped before, so every list,
        // sidebar row and card rendered a draft identically to a committed project.
        lifecycle: 'draft',
      },
    ],
    selfRole: 300,
  });

  // Registered AFTER setupApiMocks so these win — Playwright resolves routes in
  // reverse registration order.

  // Capture what the sheet actually sends: the request-side contract is the half no
  // DOM assertion can see on a forgiving mock.
  //
  // A REGEX, not a glob. `setupApiMocks` registers the glob `**/api/v1/projects/`,
  // which does not match the query-string form (`/projects/?page_size=200`) the rail
  // actually requests — so the list fell through to the catch-all and the Projects
  // section rendered its error "Retry" instead of any rows. This matches both the bare
  // and the query form, and serves the list itself rather than falling back.
  await page.route(/\/api\/v1\/projects\/(\?.*)?$/, async (route: Route) => {
    const req: Request = route.request();
    if (req.method() === 'POST') {
      state.createPayloads.push(req.postDataJSON() as Record<string, unknown>);
      await route.fulfill(json({ id: CREATED_ID, name: 'Unagreed Plan', lifecycle: 'draft' }, 201));
      return;
    }
    await route.fulfill(
      json({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: PROJECT_ID,
            name: 'Unagreed Plan',
            description: '',
            start_date: '2026-09-01',
            calendar: 'default',
            health: 'AUTO',
            open_task_count: 3,
            can_author: true,
            lifecycle: state.lifecycle,
          },
        ],
      }),
    );
  });

  // Stateful detail — serves whatever /commit/ last wrote.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill(
      json({
        id: PROJECT_ID,
        name: 'Unagreed Plan',
        description: '',
        start_date: '2026-09-01',
        calendar: 'default',
        health: 'AUTO',
        can_author: true,
        lifecycle: state.lifecycle,
      }),
    );
  });

  await page.route(`**/api/v1/projects/${PROJECT_ID}/commit/`, async (route: Route) => {
    if (state.lifecycle === 'active') {
      await route.fulfill(
        json({ detail: 'This plan has already been committed.', code: 'already_committed' }, 409),
      );
      return;
    }
    state.lifecycle = 'active';
    await route.fulfill(
      json({ baseline_id: 'b-3233', baseline_name: 'Baseline v1', task_count: 3 }),
    );
  });

  return state;
}

/**
 * The rail's project rows and its "+ New project" control both live inside the Tier-3
 * "Browse" disclosure, which is closed by default off a project (`switchOpen`). Opening
 * it is part of reaching either, not incidental setup.
 */
async function openBrowse(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Browse projects and programs' }).click();
}

test.describe('Create as draft (#3233)', () => {
  test('the sheet offers draft, off by default, and omits the flag when unticked', async ({
    page,
  }) => {
    const state = await setupRoutes(page);
    await openBrowse(page);
    await page.getByRole('button', { name: '+ New project' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const box = dialog.getByRole('checkbox', { name: /create as a draft/i });
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();

    await dialog.getByRole('textbox', { name: /^name/i }).fill('Ordinary Project');
    await dialog.getByRole('button', { name: /^create project$/i }).click();

    await expect.poll(() => state.createPayloads.length).toBeGreaterThan(0);
    // Omitted entirely, not sent as false — an ordinary create's payload is
    // byte-identical to what it was before this feature existed.
    expect(state.createPayloads[0]).not.toHaveProperty('start_as_draft');
  });

  test('ticking the box sends start_as_draft and states the consequence', async ({ page }) => {
    const state = await setupRoutes(page);
    await openBrowse(page);
    await page.getByRole('button', { name: '+ New project' }).click();
    const dialog = page.getByRole('dialog');
    const box = dialog.getByRole('checkbox', { name: /create as a draft/i });

    // The consequence is stated where the choice is made, in the phrase that owns it
    // (rule 328) — the header line and the commit sheet render the same string.
    await expect(
      dialog.getByText(/held out of program rollup, portfolio health, search and My Work/i),
    ).toBeVisible();

    await dialog.getByRole('textbox', { name: /^name/i }).fill('Unagreed Plan');
    await box.click();
    await expect(box).toBeChecked();
    await dialog.getByRole('button', { name: /^create project$/i }).click();

    await expect.poll(() => state.createPayloads.length).toBeGreaterThan(0);
    expect(state.createPayloads[0]).toMatchObject({ start_as_draft: true });
    // `lifecycle` is never client-set — #3127 is not reopened by this feature.
    expect(state.createPayloads[0]).not.toHaveProperty('lifecycle');
  });

  test('a draft is legible in the sidebar, not only on the Overview header', async ({ page }) => {
    await setupRoutes(page);
    await openBrowse(page);

    // `mapProject` dropped `lifecycle` before #3233, so a draft rendered here
    // identically to a committed project. The accessible name is the assertion that
    // matters: the visible chip is aria-hidden, so this is the only channel a screen
    // reader has, and "Draft" leads because it qualifies the health word after it.
    await expect(
      page.getByRole('button', { name: 'Draft, Unagreed Plan, health unknown, 3 open tasks' }),
    ).toBeVisible();
  });

  test('draft → commit is reachable end to end, and the anchor does not move', async ({
    page,
  }) => {
    await setupRoutes(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    await expect(page.getByLabel(/Project lifecycle: Draft/i)).toBeVisible();

    const commit = page.getByRole('button', { name: /commit plan/i });
    await expect(commit).toBeVisible();
    await commit.click();

    const confirm = page.getByRole('dialog');
    await confirm.getByRole('button', { name: /commit/i }).last().click();

    // The detail refetch echoes the write, so the Draft pill and the Commit button
    // both go — the state the product actually reaches, not a pre-refetch flash.
    await expect(page.getByLabel(/Project lifecycle: Draft/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /commit plan/i })).toHaveCount(0);
  });
});
