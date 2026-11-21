import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, type UserFixture } from './fixtures';

/**
 * A first project opens with a starter rail (#3713).
 *
 * The server seeds the creator's per-user `hidden_views` when their first project is
 * created; the web's only job is to refetch `/auth/me/` afterwards so the rail shows it
 * (`useCreateProject` invalidates `['current-user']`). The `/auth/me/` mock is therefore
 * STATEFUL — it serves the seeded set only after `POST /projects/` has happened, like the
 * real server — so a regression that drops the refetch leaves the full 14-view rail and
 * fails the first test. The server-side seed rules are covered by pytest.
 */

const PROJECT_ID = 'e2e-starter-rail-0000-0000-0000-000000003713';
const SEEDED = [
  'calendar',
  'product-backlog',
  'sprints',
  'risk',
  'reports',
  'activity',
  'assets',
  'resources',
];

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function user(hidden: string[]): UserFixture {
  return {
    id: 'e2e-user',
    username: 'e2euser',
    display_name: 'E2E User',
    initials: 'EU',
    email: 'e2e@example.com',
    default_landing: 'my_work',
    landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
    hidden_views: hidden,
  };
}

const PROJECT = {
  id: PROJECT_ID,
  name: 'First Project',
  description: '',
  start_date: '2026-09-01',
  calendar: 'default',
  can_author: true,
};

async function setup(page: Page, opts: { seededOnCreate: string[] }) {
  let created = false;
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projectId: PROJECT_ID, projects: [PROJECT], selfRole: 300 });

  // Registered after setupApiMocks so they win (reverse registration order).
  await page.route('**/api/v1/auth/me/', (route: Route) =>
    route.fulfill(json(user(created ? opts.seededOnCreate : []))),
  );
  await page.route(/\/api\/v1\/projects\/(\?.*)?$/, async (route: Route) => {
    if (route.request().method() === 'POST') {
      created = true;
      await route.fulfill(json({ id: PROJECT_ID, name: 'First Project' }, 201));
      return;
    }
    await route.fulfill(json({ count: 1, next: null, previous: null, results: [PROJECT] }));
  });
}

async function createFirstProject(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Browse projects and programs' }).click();
  await page.getByRole('button', { name: '+ New project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /^name/i }).fill('First Project');
  await dialog.getByRole('button', { name: /^create project$/i }).click();
}

test.describe('First project starter rail (#3713)', () => {
  test('creating a first project shows the seeded, reduced rail', async ({ page }) => {
    await setup(page, { seededOnCreate: SEEDED });
    await createFirstProject(page);

    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Schedule', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Board', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Calendar', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Sprints', exact: true })).toHaveCount(0);
  });

  test('a user whose rail is not seeded keeps the full rail after creating a project', async ({
    page,
  }) => {
    // Not a first project / already customized: the server leaves hidden_views empty.
    await setup(page, { seededOnCreate: [] });
    await createFirstProject(page);

    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Schedule', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible();
  });
});
