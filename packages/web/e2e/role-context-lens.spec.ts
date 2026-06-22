import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll, type UserFixture } from './fixtures';

/**
 * Role-context lens — "View focus" (issue 1263, ADR-0161).
 *
 * The lens is a presentation-only per-user preference. Two behaviors are covered
 * end-to-end: the settings switcher writes `role_context` and the choice survives
 * a reload (the AC), and the project index lands on the lens's default view
 * (PM → Schedule, Scrum Master → Board, Unified → Overview).
 */

const PROJECT_ID = 'e2e-rolectx-0000-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Apollo Platform', description: '', start_date: '2026-01-01', calendar: 'default' },
];

function userWithLens(lens: string): UserFixture {
  return {
    id: 'e2e-user',
    username: 'e2euser',
    display_name: 'E2E User',
    initials: 'EU',
    email: 'e2e@example.com',
    default_landing: 'my_work',
    landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
    hidden_views: [],
    role_context: lens,
  };
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function setup(page: Page, lens: string) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    user: userWithLens(lens),
  });
}

test.describe('Role-context lens (ADR-0161)', () => {
  test('the View focus switcher writes the lens and it persists across reload', async ({ page }) => {
    await setup(page, 'unified');

    // Stateful /auth/me/ + profile PATCH (registered after setup → take precedence)
    // so the new lens is reflected on refetch and survives a reload.
    let lens = 'unified';
    await page.route('**/api/v1/auth/me/', (route) => route.fulfill(json(userWithLens(lens))));
    await page.route('**/api/v1/auth/me/profile/', (route) => {
      const body = route.request().postDataJSON() as { role_context?: string };
      if (body.role_context) lens = body.role_context;
      route.fulfill(json({ default_landing: 'my_work', hidden_views: [], role_context: lens }));
    });

    await page.goto('/me/settings/general');

    const group = page.getByRole('radiogroup', { name: 'View focus' });
    await expect(group.getByRole('radio', { name: /Unified Today/ })).toHaveAttribute('aria-checked', 'true');

    // Switch to PM — optimistic + persisted (the PATCH updates the stateful mock).
    await group.getByRole('radio', { name: /^PM/ }).click();
    await expect(group.getByRole('radio', { name: /^PM/ })).toHaveAttribute('aria-checked', 'true');

    // Reload — the lens is re-read from /auth/me/ and stays PM.
    await page.reload();
    await expect(
      page.getByRole('radiogroup', { name: 'View focus' }).getByRole('radio', { name: /^PM/ }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  for (const { lens, view } of [
    { lens: 'pm', view: 'schedule' },
    { lens: 'scrum_master', view: 'board' },
    { lens: 'unified', view: 'overview' },
  ]) {
    test(`the ${lens} lens lands the project index on ${view}`, async ({ page }) => {
      await setup(page, lens);
      await page.goto(`/projects/${PROJECT_ID}`);
      await page.waitForURL(`**/projects/${PROJECT_ID}/${view}`);
      expect(page.url()).toContain(`/projects/${PROJECT_ID}/${view}`);
    });
  }
});
