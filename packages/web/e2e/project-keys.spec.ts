import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/**
 * Project keys in URLs and on the create sheet (ADR-1237 §7, UX §1 and §3, #4148).
 *
 * The route segment of `/projects/:projectId/…` is a key (`PLAT`), a retired key or a
 * UUID. The boundary resolves it, renders the page against the UUID, and rewrites the
 * address bar to the current key with `history.replace`. Every case here asserts the
 * URL the user ends up on AND that the page itself rendered, because a rewrite to the
 * right URL over a not-found body would pass a URL-only check.
 *
 * The resolver is mocked with the real response shape and the real, byte-identical
 * 404 body. These routes register after `setupCatchAll`'s identity resolver, so they
 * win. The project uses a real UUID so the UUID-URL case exercises the no-resolver
 * path the app takes in production.
 */

const PROJECT_ID = '6f1c2b1e-9a57-4c1e-8d4f-2a0b7c9e1d33';
const KEY = 'PLAT';
const NAME = 'Platform Launch';

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

interface State {
  resolveRefs: string[];
  keyChecks: string[];
  createPayloads: Array<Record<string, unknown>>;
}

async function setupRoutes(page: Page): Promise<State> {
  const state: State = { resolveRefs: [], keyChecks: [], createPayloads: [] };
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projectId: PROJECT_ID,
    projects: [
      {
        id: PROJECT_ID,
        name: NAME,
        description: '',
        start_date: '2026-09-01',
        calendar: 'default',
        code: KEY,
        health: 'AUTO',
        open_task_count: 0,
      },
    ],
  });

  // GET /resolve/ — the current key, a retired key, and the UUID resolve; anything
  // else is the one 404 body the server returns for "missing" and "not yours" alike.
  await page.route(/\/api\/v1\/resolve\/(\?|$)/, async (route: Route) => {
    const url = new URL(route.request().url());
    const ref = url.searchParams.get('ref') ?? '';
    state.resolveRefs.push(ref);
    const known = ref.toUpperCase() === KEY || ref === 'OLDKEY' || ref === PROJECT_ID;
    if (known) {
      await route.fulfill(
        json({
          type: 'project',
          id: PROJECT_ID,
          project_id: PROJECT_ID,
          program_id: null,
          key: KEY,
          canonical_ref: KEY,
        }),
      );
      return;
    }
    await route.fulfill(json({ detail: 'Not found.' }, 404));
  });

  // GET /keys/ — a name derives initials; `PLAT` is taken (by this very project).
  await page.route(/\/api\/v1\/keys\/(\?|$)/, async (route: Route) => {
    const url = new URL(route.request().url());
    const key = url.searchParams.get('key');
    if (key !== null) {
      state.keyChecks.push(key);
      await route.fulfill(
        json(
          key === KEY
            ? { available: false, reason: 'taken', suggestion: `${KEY}2` }
            : { available: true, reason: null, suggestion: key },
        ),
      );
      return;
    }
    const name = url.searchParams.get('name') ?? '';
    const initials = name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
    await route.fulfill(json({ suggestion: initials }));
  });

  // Capture the create; the list GET keeps serving the one project.
  await page.route(/\/api\/v1\/projects\/(\?.*)?$/, async (route: Route) => {
    if (route.request().method() === 'POST') {
      state.createPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill(
        json({ id: 'e2e-created-4148', name: 'Platform Migration', code: 'PM' }, 201),
      );
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
            name: NAME,
            description: '',
            start_date: '2026-09-01',
            calendar: 'default',
            code: KEY,
            health: 'AUTO',
            open_task_count: 0,
          },
        ],
      }),
    );
  });

  return state;
}

/** The Overview rendered for THIS project — not the not-found body. */
async function expectOverviewRendered(page: Page) {
  await expect(page.getByText(/This project isn.t available/)).toHaveCount(0);
  // The location switcher names the project and the view; on an unavailable project it
  // says "Project unavailable" instead (#3469), so this cannot pass on the 404 body.
  const location = page.getByRole('navigation', { name: 'Location' });
  await expect(location).toContainText(NAME);
  await expect(location).toContainText('Dashboard');
}

test.describe('Project key URLs (ADR-1237 UX §3)', () => {
  test('a key URL opens the project and stays on the key', async ({ page }) => {
    const state = await setupRoutes(page);
    await page.goto(`/projects/${KEY}/overview`);
    await expectOverviewRendered(page);
    await expect(page).toHaveURL(new RegExp(`/projects/${KEY}/overview$`));
    expect(state.resolveRefs).toContain(KEY);
  });

  test('a UUID URL is rewritten to the key form without a resolver call', async ({ page }) => {
    const state = await setupRoutes(page);
    await page.goto(`/projects/${PROJECT_ID}/overview?tab=kpi#top`);
    await expect(page).toHaveURL(new RegExp(`/projects/${KEY}/overview\\?tab=kpi#top$`));
    await expectOverviewRendered(page);
    // The UUID is already the id; the key came from the project detail.
    expect(state.resolveRefs).not.toContain(PROJECT_ID);
  });

  test('a retired key is rewritten to the current key', async ({ page }) => {
    const state = await setupRoutes(page);
    await page.goto('/projects/OLDKEY/overview');
    await expect(page).toHaveURL(new RegExp(`/projects/${KEY}/overview$`));
    await expectOverviewRendered(page);
    expect(state.resolveRefs[0]).toBe('OLDKEY');
  });

  test('an unknown key renders the same not-found state as an invisible project', async ({
    page,
  }) => {
    await setupRoutes(page);
    await page.goto('/projects/NOPE/overview');
    await expect(page.getByRole('heading', { name: /This project isn.t available/ })).toBeVisible();
    // No rewrite: there is nothing to rewrite to.
    await expect(page).toHaveURL(/\/projects\/NOPE\/overview$/);
  });
});

test.describe('Key field on the create sheet (ADR-1237 UX §1)', () => {
  async function openSheet(page: Page) {
    await page.goto('/');
    await page.getByRole('button', { name: 'Browse projects and programs' }).click();
    await page.getByRole('button', { name: '+ New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('the key follows Name, and the suggestion is sent on create', async ({ page }) => {
    const state = await setupRoutes(page);
    const dialog = await openSheet(page);
    await dialog.getByRole('textbox', { name: /^name/i }).fill('Platform Migration');
    const key = dialog.getByRole('textbox', { name: 'Key' });
    await expect(key).toHaveValue('PM');
    await expect(dialog.getByRole('status').filter({ hasText: 'Available' })).toBeVisible();
    await dialog.getByRole('button', { name: /^create project$/i }).click();
    await expect.poll(() => state.createPayloads.length).toBeGreaterThan(0);
    expect(state.createPayloads[0]).toMatchObject({ name: 'Platform Migration', code: 'PM' });
  });

  test('a taken key blocks create and offers the free suggestion', async ({ page }) => {
    const state = await setupRoutes(page);
    const dialog = await openSheet(page);
    await dialog.getByRole('textbox', { name: /^name/i }).fill('Platform Migration');
    const key = dialog.getByRole('textbox', { name: 'Key' });
    await expect(key).toHaveValue('PM');
    await key.fill('plat');
    await expect(key).toHaveValue(KEY);
    await expect(dialog.getByText('Already in use — try')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^create project$/i })).toBeDisabled();
    expect(state.keyChecks).toContain(KEY);

    await dialog.getByRole('button', { name: `Use ${KEY}2` }).click();
    await expect(key).toHaveValue(`${KEY}2`);
    await expect(dialog.getByRole('status').filter({ hasText: 'Available' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^create project$/i })).toBeEnabled();
  });
});
