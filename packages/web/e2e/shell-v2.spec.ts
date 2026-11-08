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
    program: PROGRAM_ID,
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
        'true',
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
      await expect(page.getByTestId('shell2-context-title')).toHaveText('Atlas Migration');
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

    test('More is a keyboard menu: Enter seats focus on the first item, arrows move, Escape returns focus', async ({
      page,
    }) => {
      await setup(page);
      await page.goto(`/projects/${PROJECT_ID}/overview`);
      const more = views(page).getByRole('button', { name: 'More' });
      await expect(more).toBeVisible({ timeout: 10_000 });
      await more.focus();
      await page.keyboard.press('Enter');
      const menu = page.getByRole('menu', { name: 'More views' });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem')).toHaveText([
        'Today',
        'Reports',
        'Activity',
        'Assets',
        'Settings',
      ]);
      await expect(menu.getByRole('menuitem', { name: 'Today' })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(menu.getByRole('menuitem', { name: 'Reports' })).toBeFocused();
      await page.keyboard.press('End');
      await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(more).toBeFocused();
    });

    test('a failed health read shows a retryable error in the header, never an empty chip', async ({
      page,
    }) => {
      await setup(page);
      await page.route(`**/api/v1/projects/${PROJECT_ID}/status-summary/`, (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' }),
      );
      await page.goto(`/projects/${PROJECT_ID}/overview`);
      await expect(page.getByTestId('shell2-context-title')).toHaveText('Atlas Migration', {
        timeout: 10_000,
      });
      await expect(page.getByText('Health unavailable')).toBeVisible();
      await expect(page.getByTestId('shell2-health')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /retry/i }).first()).toBeVisible();
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

  test.describe('full-page Work list (#4756)', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    const mockPins = (page: Page, body: unknown[] = []) =>
      page.route('**/api/v1/auth/me/pinned/', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
      );

    test('rail Work lands on the tree; arrows move and expand, Enter opens a project', async ({
      page,
    }) => {
      await setup(page);
      await mockPins(page);
      await page.goto('/me/work');
      const work = destinations(page).getByRole('link', { name: 'Work' });
      await expect(work).toHaveAttribute('href', '/work');
      await work.click();
      await expect(page).toHaveURL(/\/work$/);
      await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
      const tree = page.getByRole('tree', { name: 'Programs' });
      const program = tree.getByRole('treeitem', { name: 'Platform Modernization' });
      const project = tree.getByRole('treeitem', { name: 'Atlas Migration' });
      await expect(program).toHaveAttribute('aria-expanded', 'true');
      await expect(project).toBeVisible();
      // Roving tabindex: one tab stop.
      await expect(tree.locator('[tabindex="0"]')).toHaveCount(1);
      await program.focus();
      await page.keyboard.press('ArrowLeft'); // collapse
      await expect(program).toHaveAttribute('aria-expanded', 'false');
      await expect(project).toHaveCount(0);
      await page.keyboard.press('ArrowRight'); // expand
      await page.keyboard.press('ArrowRight'); // into the first child
      await expect(project).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/overview$`));
    });

    test('search narrows the tree without losing focus in the box', async ({ page }) => {
      await setup(page);
      await mockPins(page);
      await page.goto('/work');
      const box = page.getByRole('searchbox', { name: 'Find a program or project' });
      await box.click();
      await page.keyboard.type('atl');
      await expect(box).toBeFocused();
      await expect(box).toHaveValue('atl');
      await expect(page.getByRole('treeitem', { name: 'Atlas Migration' })).toBeVisible();
    });

    test('empty state when the person has no programs or projects', async ({ page }) => {
      await setup(page);
      await mockPins(page);
      await page.route('**/api/v1/programs/', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
        }),
      );
      await page.route('**/api/v1/projects/', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
        }),
      );
      await page.goto('/work');
      await expect(page.getByText('No programs or projects yet')).toBeVisible();
      await expect(page.getByRole('tree')).toHaveCount(0);
    });
  });

  test.describe('laptop 1024', () => {
    test.use({ viewport: { width: 1024, height: 768 } });

    test('the rail is the 64px icon rail and Work opens a flyout by hover AND by keyboard', async ({
      page,
    }) => {
      await setup(page);
      await page.goto(`/projects/${PROJECT_ID}/overview`);
      await expect(rail(page)).toHaveAttribute('data-collapsed', 'true', { timeout: 10_000 });
      // The width collapsed it, not the person, so there is no Expand control to mislead.
      await expect(page.getByRole('button', { name: 'Expand navigation' })).toHaveCount(0);
      // Labels stay in the DOM for assistive tech even at icon width (rule 330(d)).
      const home = destinations(page).getByRole('link', { name: 'Home' });
      await expect(home).toBeVisible();
      await expect(home.getByText('Home')).toHaveClass(/sr-only/);

      const work = destinations(page).getByRole('link', { name: 'Work' });
      const flyout = page.getByRole('dialog', { name: 'Programs and projects' });

      // Keyboard: ArrowRight enters the panel, Escape closes it and hands focus back.
      await work.focus();
      await page.keyboard.press('ArrowRight');
      await expect(flyout).toBeVisible();
      await expect(flyout.getByRole('searchbox')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(flyout).toHaveCount(0);
      await expect(work).toBeFocused();
      await page.keyboard.press('Tab'); // leaving the trigger must not reopen it
      await expect(flyout).toHaveCount(0);

      // Pointer: hover, cross the gap into the panel, pick a project.
      await work.hover();
      await expect(flyout).toBeVisible();
      const target = flyout.getByRole('link', { name: 'Atlas Migration' });
      await expect(target).toBeVisible();
      await expect(flyout.getByRole('link', { name: 'All work' })).toHaveAttribute('href', '/work');
      await target.hover();
      await expect(flyout).toBeVisible();
      await target.click();
      await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/overview$`));
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
      await expect(bar.getByRole('link')).toHaveCount(3); // Home · Inbox · Work (Log time is a button)
      await expect(bar.getByRole('link', { name: /Work/ })).toHaveAttribute('href', '/work');
      for (const name of ['Home', 'Inbox', 'Work']) {
        await expect(bar.getByRole('link', { name: new RegExp(name) })).toBeVisible();
      }
      await expect(bar.getByRole('button', { name: 'Log time' })).toBeVisible();
      await expect(bar.getByRole('link', { name: /Home/ })).toHaveAttribute('aria-current', 'page');
      await expect(bar.getByRole('button', { name: 'Search' })).toBeVisible();
      // No rail on a phone, so the account menu rides in the top bar.
      await expect(page.getByRole('button', { name: /Account/ })).toBeVisible();
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
      // One row: a wrapped row would be at least two tab heights tall …
      expect(box!.height).toBeLessThan(60);
      // … and each tab is itself the 44px target (rule 5) — no clipped pseudo-element.
      const tab = await tabs.getByRole('link', { name: 'Plan' }).boundingBox();
      expect(tab!.height).toBeGreaterThanOrEqual(44);
      const overflow = await tabs.evaluate((el) => getComputedStyle(el).overflowX);
      expect(overflow).toBe('auto');
    });
  });
});
