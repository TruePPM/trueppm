/**
 * E2E for the public, read-only status-update render (#4805) at
 * `/share/status-update/:token`: the golden path in light and dark, the phone layout
 * that truncates the narrative, and the one "not available" state every unavailable
 * token gets. The page's only request is the anonymous share read; the spec asserts
 * that no authenticated endpoint is called.
 */
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';
import { expectNoA11yViolationsBothThemes } from './fixtures/a11y';

const SHARE_URL = '**/api/v1/share/status-update/**';

const metric = (value: string | number | null, reason?: string) => ({
  value,
  as_of: '2026-11-20T09:12:00Z',
  definition: 'Server sentence.',
  ...(reason ? { reason } : {}),
});

const SHARE = {
  content_kind: 'status_update',
  project: { name: 'Riverside Renovation', short_id: 'RIV' },
  seq: 4,
  rag: 'amber',
  narrative: 'Vendor slipped the API drop.\n\nWe re-sequenced testing.\n\nNext call Friday.',
  posted_at: '2026-11-20T09:12:00Z',
  author: null,
  computed_health: 'at_risk',
  as_of: '2026-11-20T09:12:00Z',
  forecast: {
    p50: metric('2026-12-01'),
    p80: metric('2026-12-07'),
    cpm_finish: metric('2026-11-28'),
    baseline_finish: null,
    baseline_finish_variance_days: metric(null, 'no_baseline'),
  },
  counts: {
    completed_since_previous: metric(3),
    slipped_since_previous: metric(1),
  },
  milestones: [
    { name: 'Beta', cpm_finish: '2026-12-01', baseline_finish: null, variance_days: null },
  ],
  risks: null,
  decisions: null,
  show_assignees: false,
  show_milestone_dates: true,
  show_risks: false,
  show_decisions: false,
};

test.describe('Public status update share', () => {
  test('golden path: the frozen update, read-only, light and dark', async ({ page }, testInfo) => {
    await setupCatchAll(page);
    // The app root reads `/edition/`, which is anonymous on the server (the role-route
    // matrix pins it `+++++++`); every other API call would be an authenticated one.
    const authed: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (!url.includes('/api/v1/')) return;
      const isPublic =
        url.includes('/api/v1/share/status-update/') || url.endsWith('/api/v1/edition/');
      if (!isPublic || req.headers()['authorization']) authed.push(url);
    });
    await page.route(SHARE_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SHARE) }),
    );
    await page.goto('/share/status-update/tok123');

    await expect(page.getByRole('heading', { name: 'Riverside Renovation' })).toBeVisible();
    await expect(page.getByTestId('share-read-only-chip')).toHaveText('Read-only');
    await expect(page.getByTestId('share-call')).toContainText('At risk');
    await expect(page.getByText('Next call Friday.')).toBeVisible();
    await expect(page.getByTestId('share-milestones')).toContainText('Beta');
    await expect(page.getByTestId('share-frozen-note')).toContainText('frozen when update 4');
    // No app chrome and no way into the workspace.
    await expect(page.locator('a')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expectNoA11yViolationsBothThemes(page, testInfo);
    expect(authed).toEqual([]);
  });

  test('phone: the narrative truncates and expands', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await setupCatchAll(page);
    await page.route(SHARE_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SHARE) }),
    );
    await page.goto('/share/status-update/tok123');
    await expect(page.getByText('Vendor slipped the API drop.')).toBeVisible();
    await expect(page.getByText('Next call Friday.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Read all 3 paragraphs' }).click();
    await expect(page.getByText('Next call Friday.')).toBeVisible();
  });

  test('an invalid, revoked or expired token shows the not-available page', async ({ page }) => {
    await setupCatchAll(page);
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'This share link is not available.' }),
      }),
    );
    await page.goto('/share/status-update/nope');
    await expect(page.getByRole('heading', { name: 'This link isn’t available' })).toBeVisible();
    await expect(page.getByTestId('status-update-share')).toHaveCount(0);
  });
});
