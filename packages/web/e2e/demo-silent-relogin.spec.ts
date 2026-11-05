/**
 * The read-only demo survives a reload and a pasted deep link (#4500).
 *
 * "Explore the demo" signs in session-only (ADR-1197 Amendment 2026-09-26), so the
 * refresh cookie dies with the tab. On a demo host the route guard re-submits the
 * published credential instead of showing the signed-out modal; on any other host the
 * existing behavior is unchanged.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import type { Page } from '@playwright/test';

const PROJECT_ID = 'e2e-demo-00000000-0000-0000-0000-000000004500';
const DEMO_HINT = { username: 'demo@trueppm.com', password: 'trueppm-demo' };
const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Photon Cell',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

/** Something only the signed-in shell around the target project renders. */
async function expectShellRendered(page: Page) {
  await expect(page.getByRole('navigation').getByText('Photon Cell').first()).toBeVisible();
}

async function setup(page: Page, opts: { demo: boolean; loginOk?: boolean; hadSession: boolean }) {
  const tokenPosts: unknown[] = [];
  if (opts.hadSession) {
    // A reload: the persisted hint says authenticated, but no access token in memory.
    await setupAuth(page, { accessToken: null });
  }
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: PROJECTS,
    projectId: PROJECT_ID,
    demoReadOnly: opts.demo,
    demoLoginHint: opts.demo ? DEMO_HINT : null,
  });
  // The session-only cookie is gone, so the refresh is refused.
  await page.route('**/api/v1/auth/token/refresh/', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/v1/auth/token/', async (route) => {
    tokenPosts.push(route.request().postDataJSON());
    if (opts.loginOk === false) {
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access: 'silent-demo-token' }),
    });
  });
  return tokenPosts;
}

test.describe('Demo silent re-login (#4500)', () => {
  test('a reload keeps the view and shows no signed-out modal', async ({ page }) => {
    const posts = await setup(page, { demo: true, hadSession: true });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);

    // Wait for the silent login to land before asserting absence, or the modal check
    // would pass vacuously in the window before the guard has decided.
    await expect.poll(() => posts.length).toBe(1);
    await expectShellRendered(page);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/schedule$`));
    await expect(page.getByRole('dialog', { name: /You've been signed out/ })).toHaveCount(0);
    expect(posts).toEqual([{ ...DEMO_HINT, remember_me: false }]);
  });

  test('a deep link for a fresh visitor opens the target view, not /login', async ({ page }) => {
    const posts = await setup(page, { demo: true, hadSession: false });
    await page.goto(`/projects/${PROJECT_ID}/sprints`);

    await expectShellRendered(page);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/sprints$`));
    await expect(page.getByRole('dialog', { name: /You've been signed out/ })).toHaveCount(0);
    expect(posts).toHaveLength(1);
  });

  test('a refused silent login falls back to the modal, once', async ({ page }) => {
    const posts = await setup(page, { demo: true, hadSession: true, loginOk: false });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);

    await expect(page.getByRole('dialog', { name: /You've been signed out/ })).toBeVisible();
    // Settle past any slower second attempt before counting: the cap is per page load.
    await page.waitForTimeout(1000);
    expect(posts).toHaveLength(1);
  });

  test('a non-demo host still shows the modal and never posts a credential', async ({ page }) => {
    const posts = await setup(page, { demo: false, hadSession: true });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);

    await expect(page.getByRole('dialog', { name: /You've been signed out/ })).toBeVisible();
    expect(posts).toHaveLength(0);
  });

  test('a non-demo deep link for a visitor with no session redirects to /login', async ({
    page,
  }) => {
    const posts = await setup(page, { demo: false, hadSession: false });
    await page.goto(`/projects/${PROJECT_ID}/sprints`);

    await expect(page).toHaveURL(/\/login\?next=/);
    expect(posts).toHaveLength(0);
  });
});
