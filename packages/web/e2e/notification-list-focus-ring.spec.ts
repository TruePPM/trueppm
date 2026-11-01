import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Focus ring on the full-page notification filter rows (#4775).
 *
 * Both rows are `overflow-x-auto` scrollers, and `overflow-x: auto` clips on BOTH
 * axes — so a `ring-2 ring-offset-1` (3px of box-shadow outside the button) was
 * cut off: the read-state tabs lost the ring's top edge, the category chips lost
 * top and bottom. jsdom has no layout, so only a real browser can see the ring
 * leave its clip box. The assertion is geometric: every item's ring extent must
 * sit inside its scroller's padding box.
 */

const FIXTURE_ME = {
  id: 'user-priya',
  username: 'priya',
  display_name: 'Priya',
  initials: 'PR',
  email: 'priya@example.com',
  max_project_role: 100,
  workspace_role: 100,
  can_access_admin_settings: false,
  default_landing: 'auto',
  landing: { intent: 'my_work', path: '/me/work', resolved_by: 'fallback' },
  hidden_views: [],
  role_context: 'unified',
  dnd_enabled: false,
};

/** ring-2 + ring-offset-1. */
const RING_EXTENT = 3;

type Page = import('@playwright/test').Page;

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  const pj = (d: unknown) => JSON.stringify(d);
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/me/notifications/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/me/notification-settings/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ dnd_enabled: false }) }),
  );
}

/** How far (px) the ring would extend past the scroller's clip box on any side; <= 0 means it fits. */
async function ringOverflow(
  page: Page,
  scrollerName: string,
  itemRole: 'tab' | 'radio',
  itemName: string,
) {
  const scroller = page.getByLabel(scrollerName, { exact: true });
  const item = scroller.getByRole(itemRole, { name: itemName, exact: true });
  const s = await scroller.boundingBox();
  const b = await item.boundingBox();
  if (!s || !b) throw new Error(`no box for ${scrollerName} / ${itemName}`);
  return Math.max(
    s.x - (b.x - RING_EXTENT),
    b.x + b.width + RING_EXTENT - (s.x + s.width),
    s.y - (b.y - RING_EXTENT),
    b.y + b.height + RING_EXTENT - (s.y + s.height),
  );
}

test.describe('Notification list focus ring (#4775)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto('/me/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  });

  test('the ring fits inside both scrollers on every edge item', async ({ page }) => {
    for (const [scroller, role, names] of [
      ['Filter notifications', 'tab', ['All', 'Snoozed']],
      ['Filter by category', 'radio', ['All', 'Project']],
    ] as const) {
      for (const name of names) {
        expect(
          await ringOverflow(page, scroller, role, name),
          `${scroller} / ${name}`,
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  test('the ring shows on keyboard focus and not on a mouse click', async ({ page }) => {
    const chip = page.getByRole('radio', { name: 'Mentions', exact: true });
    const shadow = () => chip.evaluate((el) => getComputedStyle(el).boxShadow);

    await chip.click();
    expect(await shadow()).toBe('none');

    // Move focus away and back by keyboard so :focus-visible applies.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(chip).toBeFocused();
    expect(await shadow()).not.toBe('none');
  });
});
