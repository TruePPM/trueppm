/**
 * E2E for shell v2 (Pass 1 redesign) behind the `shell_v2` client flag.
 *
 * Golden path: inside a project the 5-item rail, the single breadcrumb, the
 * context header with its ≤5-tab row, and a quiet status slot all render, and
 * the Plan tab lands on the schedule. Then the three states the v1 shell got
 * wrong: a phone home with navigation on it (the v1 BottomNav returned null off
 * a project), a 1024px laptop with a visible route to every project (the Work
 * flyout), and offline folding into the one status pill instead of a banner.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { expectNoA11yViolations, setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-shell2-0000-0000-0000-000000000001';
const PROGRAM_ID = 'e2e-shell2-prog-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Atlas Migration',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    program_detail: { id: PROGRAM_ID, name: 'Platform Modernization' },
  },
];

const PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Platform Modernization',
  description: '',
  code: 'platform-modernization',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: null,
  lead_detail: null,
  created_by: 1,
  created_at: '2026-01-01T00:00:00Z',
};

async function setup(page: Page) {
  // The flag is a localStorage preference, read before React mounts.
  await page.addInitScript(() => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
  });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    statusSummary: { health_band: 'at_risk' },
  });
  // The breadcrumb's program segment and the Work flyout both read the member-scoped
  // program list; without it the program crumb is (correctly) omitted (#3469).
  await page.route('**/api/v1/programs/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [PROGRAM] }),
    }),
  );
}

const rail = (page: Page) => page.getByRole('complementary', { name: 'Primary navigation' });
const destinations = (page: Page) => page.getByRole('navigation', { name: 'Destinations' });
const views = (page: Page) => page.getByRole('navigation', { name: 'Views' });
const statusSlot = (page: Page) => page.getByTestId('shell2-status-slot');

test.describe('shell v2 (shell_v2 flag)', () => {
  test.describe('desktop 1440', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('project route: rail, one breadcrumb, context header with tabs, quiet status', async ({
      page,
    }, testInfo) => {
      await setup(page);
      await page.goto(`/projects/${PROJECT_ID}/overview`);

      await expect(page.getByTestId('shell2')).toBeVisible({ timeout: 10_000 });
      await expect(rail(page)).toHaveAttribute('data-collapsed', 'false');

      // Exactly the five destinations, Work lit because we are inside the work tree.
      const links = destinations(page).getByRole('link');
      await expect(links).toHaveText([/Home/, /Inbox/, /Work/, /People/, /Agents/]);
      await expect(destinations(page).getByRole('link', { name: 'Work' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(destinations(page).getByRole('link', { name: 'Agents' })).toHaveAttribute(
        'href',
        `/programs/${PROGRAM_ID}/agents`,
      );

      // One location: program / project / leaf. No eyebrow, no status-bar echo.
      const crumbs = page.getByRole('navigation', { name: 'Location' });
      await expect(crumbs.getByRole('link', { name: 'Platform Modernization' })).toBeVisible();
      await expect(crumbs.getByRole('link', { name: 'Atlas Migration' })).toBeVisible();
      await expect(page.getByText('Atlas Migration')).toHaveCount(2); // breadcrumb link + context title

      // Context header: title, the SERVER's health band once, and the tab row.
      await expect(page.getByRole('heading', { level: 1, name: 'Atlas Migration' })).toBeVisible();
      await expect(page.getByTestId('shell2-health')).toHaveCount(1);
      await expect(page.getByTestId('shell2-health')).toHaveText(/At risk/);
      const tabs = views(page);
      await expect(tabs.getByRole('link')).toHaveText([
        'Overview',
        'Plan',
        'Deliver',
        'Risks',
        'People',
      ]);
      await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(tabs.getByRole('button', { name: 'More' })).toBeVisible();

      // Nothing is wrong, so the one status slot is a quiet "Synced".
      await expect(statusSlot(page)).toHaveAttribute('data-kind', 'synced');

      // The four v1 banners never render under shell v2.
      await expect(
        page.getByText(/This is sample data|Working offline|Rate limiting is disabled/),
      ).toHaveCount(0);

      await expectNoA11yViolations(page, testInfo);

      // Plan goes to the schedule; the layout toggle appears for the active tab.
      await tabs.getByRole('link', { name: 'Plan' }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/schedule$`));
      await expect(tabs.getByRole('link', { name: 'Plan' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      const layout = page.getByRole('navigation', { name: 'Plan layout' });
      await expect(layout.getByRole('link')).toHaveText(['Schedule', 'Grid', 'Calendar']);
      await expect(layout.getByRole('link', { name: 'Schedule' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });

    test('More opens a menu of the remaining views and Escape returns focus to the trigger', async ({
      page,
    }) => {
      await setup(page);
      await page.goto(`/projects/${PROJECT_ID}/overview`);
      const more = views(page).getByRole('button', { name: 'More' });
      await expect(more).toBeVisible({ timeout: 10_000 });
      await more.click();
      const menu = page.getByRole('menu', { name: 'More views' });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem')).toHaveText([
        'Today',
        'Reports',
        'Activity',
        'Assets',
        'Settings',
      ]);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(more).toBeFocused();
    });

    test('offline folds into the status slot instead of a banner', async ({ page, context }) => {
      await setup(page);
      await page.goto(`/projects/${PROJECT_ID}/overview`);
      await expect(statusSlot(page)).toHaveAttribute('data-kind', 'synced', { timeout: 10_000 });
      await context.setOffline(true);
      await expect(statusSlot(page)).toHaveAttribute('data-kind', 'offline');
      await expect(statusSlot(page)).toContainText('Offline');
      // No in-flow banner appeared above the content.
      await expect(page.getByText(/Working offline/)).toHaveCount(0);
      await context.setOffline(false);
      await expect(statusSlot(page)).toHaveAttribute('data-kind', 'synced');
    });
  });

  test.describe('laptop 1024', () => {
    test.use({ viewport: { width: 1024, height: 768 } });

    test('the rail is the 64px icon rail and Work opens a flyout listing programs and projects', async ({
      page,
    }) => {
      await setup(page);
      await page.goto(`/projects/${PROJECT_ID}/overview`);
      await expect(rail(page)).toHaveAttribute('data-collapsed', 'true', { timeout: 10_000 });
      // Labels stay in the DOM for assistive tech even at icon width (rule 330(d)).
      const home = destinations(page).getByRole('link', { name: 'Home' });
      await expect(home).toBeVisible();
      await expect(home.getByText('Home')).toHaveClass(/sr-only/);

      const work = destinations(page).getByRole('link', { name: 'Work' });
      await work.hover();
      const flyout = page.getByRole('dialog', { name: 'Programs and projects' });
      await expect(flyout).toBeVisible();
      await expect(flyout.getByRole('link', { name: 'Atlas Migration' })).toBeVisible();
      await expect(flyout.getByRole('link', { name: 'All work' })).toHaveAttribute(
        'href',
        '/programs',
      );
    });
  });

  test.describe('phone 390', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('My Work has a global bottom bar — the route the v1 shell left with no navigation', async ({
      page,
    }) => {
      await setup(page);
      await page.goto('/me/work');
      await expect(page.getByTestId('shell2')).toBeVisible({ timeout: 10_000 });
      await expect(rail(page)).toHaveCount(0);
      const bar = page.getByRole('navigation', { name: 'Primary navigation' });
      await expect(bar).toBeVisible();
      await expect(bar.getByRole('link')).toHaveText([/Home/, /Inbox/, /Work/]);
      await expect(bar.getByRole('link', { name: /Home/ })).toHaveAttribute('aria-current', 'page');
      await expect(bar.getByRole('button', { name: 'Log time' })).toBeVisible();
      await expect(bar.getByRole('button', { name: 'Search' })).toBeVisible();
    });

    test('inside a project the tab row is the lens switcher and scrolls rather than wrapping', async ({
      page,
    }) => {
      await setup(page);
      await page.goto(`/projects/${PROJECT_ID}/overview`);
      const tabs = views(page);
      await expect(tabs).toBeVisible({ timeout: 10_000 });
      const box = await tabs.boundingBox();
      expect(box).not.toBeNull();
      // One row: a wrapped tab row would be at least two tab heights tall.
      expect(box!.height).toBeLessThan(48);
      const overflow = await tabs.evaluate((el) => getComputedStyle(el).overflowX);
      expect(overflow).toBe('auto');
    });
  });
});
