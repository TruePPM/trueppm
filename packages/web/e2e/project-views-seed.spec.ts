import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/**
 * Role-seeded views in the shell v2 project header (ADR-1478, Redesign Pass 5 §1).
 *
 * The server resolves which views show and seeds them on the first open; the web only
 * renders `GET /projects/{id}/views/`. The mock is STATEFUL so a write's refetch echoes
 * it (CLAUDE.md: a stateless read mock erases the committed value).
 */

const PROJECT_ID = 'e2e-views-seed-0000-0000-0000-000000003715';
const KEYS = [
  'overview',
  'schedule',
  'grid',
  'calendar',
  'product-backlog',
  'sprints',
  'board',
  'today',
  'risk',
  'reports',
  'activity',
  'assets',
  'resources',
  'settings',
];
const ALWAYS = new Set(['overview', 'settings']);

type Hides = Record<string, 'seed' | 'user'>;

function viewSet(hides: Hides, extra: Record<string, unknown> = {}) {
  const seeded = Object.values(hides).filter((s) => s === 'seed').length;
  return {
    views: KEYS.map((key) => ({
      key,
      visible: ALWAYS.has(key) || !hides[key],
      source: ALWAYS.has(key) ? 'always' : (hides[key] ?? 'default'),
      binding: 'advisory',
      lens: hides[key] === 'seed' ? 'scrum_master' : null,
      at: null,
    })),
    lens: 'scrum_master',
    seeded_lens: seeded ? 'scrum_master' : null,
    seed_line: seeded ? { lens: 'scrum_master', hidden_count: seeded } : null,
    lens_offer: null,
    landing: 'board',
    last_layouts: {},
    ...extra,
  };
}

const SEEDED: Hides = { schedule: 'seed', calendar: 'seed', resources: 'seed' };

async function setup(page: Page, initial: () => Record<string, unknown> | null) {
  await page.addInitScript(() => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
  });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Atlas',
        description: '',
        start_date: '2026-04-01',
        calendar: 'default',
      },
    ],
    projectId: PROJECT_ID,
  });
  const state = { current: initial() };
  const writes: unknown[] = [];
  await page.route(`**/api/v1/projects/${PROJECT_ID}/views/`, async (route: Route) => {
    const req = route.request();
    if (state.current === null) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"detail":"boom"}',
      });
      return;
    }
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Record<string, unknown>;
      writes.push(body);
      if (body.clear_seed) state.current = viewSet({});
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(state.current),
    });
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/views/apply-seed/`, async (route: Route) => {
    const body = route.request().postDataJSON() as { dry_run: boolean };
    writes.push(body);
    if (!body.dry_run) state.current = viewSet(SEEDED);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        lens: 'scrum_master',
        will_hide: ['calendar', 'resources', 'schedule'],
        will_show: [],
        will_open_on: 'board',
        kept: [],
        change_count: 3,
        applied: !body.dry_run,
      }),
    });
  });
  return { writes };
}

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Views' });

test.describe('Role-seeded project views (ADR-1478)', () => {
  test('first open renders the seeded set and lists seeded views under More', async ({ page }) => {
    await setup(page, () => viewSet(SEEDED));
    await page.goto(`/projects/${PROJECT_ID}/grid`);
    await expect(page.getByTestId('views-seed-line')).toContainText(
      'Shown for Scrum Masters · 3 views hidden',
    );
    await expect(tabs(page).getByRole('link', { name: 'Plan' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Plan layout' })).toHaveCount(0);
    await tabs(page).getByRole('button', { name: 'More' }).click();
    const hidden = page.getByRole('group', { name: 'Hidden from your tabs' });
    await expect(hidden.getByRole('menuitem', { name: /Schedule/ })).toContainText(
      'Suggested for Scrum Master',
    );
  });

  test('Show all clears the seed hides and the line', async ({ page }) => {
    const { writes } = await setup(page, () => viewSet(SEEDED));
    await page.goto(`/projects/${PROJECT_ID}/grid`);
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(page.getByTestId('views-seed-line')).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Plan layout' }).getByRole('link', { name: 'Schedule' }),
    ).toBeVisible();
    expect(writes).toContainEqual({ clear_seed: true });
  });

  test('a lens change offers suggestions and applies only after the diff confirm', async ({
    page,
  }) => {
    const { writes } = await setup(page, () => viewSet({}, { lens_offer: 'scrum_master' }));
    await page.goto(`/projects/${PROJECT_ID}/grid`);
    await page.getByRole('button', { name: 'Apply Scrum Master suggestions…' }).click();
    await expect(page.getByRole('button', { name: 'Apply 3 changes' })).toBeVisible();
    expect(writes).toEqual([{ lens: 'scrum_master', dry_run: true }]);
    await page.getByRole('button', { name: 'Apply 3 changes' }).click();
    await expect(page.getByTestId('views-seed-line')).toBeVisible();
    expect(writes).toContainEqual({ lens: 'scrum_master', dry_run: false });
  });

  test('a seed error fails open to every view and shows no seed line', async ({ page }) => {
    await setup(page, () => null);
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(
      page.getByRole('navigation', { name: 'Plan layout' }).getByRole('link', { name: 'Schedule' }),
    ).toBeVisible();
    await expect(page.getByTestId('views-seed-line')).toHaveCount(0);
  });
});
