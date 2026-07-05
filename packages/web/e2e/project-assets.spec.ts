/**
 * Project Assets surface E2E (ADR-0212, #971).
 *
 * Golden path: navigate to the Assets tab → the unified feed lists a file row and
 * a link row (reusing the #970 primitives) → a kind chip re-queries the server.
 * Plus the empty state. The `/assets/` read API is mocked; rows render in a real
 * browser. Auth + shell endpoints come from the shared fixtures, and the
 * catch-all 401-guard is installed so no unmocked request trips the
 * session-expired modal.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-assets-0000-0000-0000-000000000971';
const BASE_URL = `/projects/${PROJECT_ID}`;

const FEED = {
  results: [
    {
      kind: 'link',
      id: 'l1',
      title: 'PR 7',
      url: 'https://github.com/acme/api/pull/7',
      download_url: null,
      provider: 'github',
      status: 'open',
      preview_type: null,
      labels: ['spec'],
      task: { id: 't1', name: 'Foundation' },
      added_by: null,
      added_at: '2026-03-01T12:05:00Z',
    },
    {
      kind: 'file',
      id: 'f1',
      title: 'requirements.pdf',
      url: null,
      download_url: `/api/v1/projects/${PROJECT_ID}/tasks/t1/attachments/f1/signed-url/`,
      provider: null,
      status: null,
      preview_type: null,
      labels: [],
      task: { id: 't1', name: 'Foundation' },
      added_by: { id: 'u1', display_name: 'Alice' },
      added_at: '2026-03-01T12:00:00Z',
    },
  ],
  next_cursor: null,
};

const EMPTY_FEED = { results: [], next_cursor: null };

async function setup(
  page: import('@playwright/test').Page,
  body: unknown = FEED,
): Promise<string[]> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Assets Project',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
      },
    ],
    projectId: PROJECT_ID,
  });
  const assetUrls: string[] = [];
  // Registered last → takes precedence over the catch-all for the assets read.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/assets/**`, (route) => {
    assetUrls.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return assetUrls;
}

test.describe('Project Assets surface', () => {
  test('lists a file row and a link row', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/assets`);

    // "Page rendered" signal — the Assets heading only appears once the feed read
    // resolves and the page mounts (gate before asserting rows).
    await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible({ timeout: 10_000 });

    // Link row: title as an external anchor, plus its label pill.
    const link = page.getByRole('link', { name: /PR 7/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://github.com/acme/api/pull/7');
    await expect(page.getByText('spec', { exact: true })).toBeVisible();

    // File row: title + the neutral "File" kind chip.
    await expect(page.getByText('requirements.pdf')).toBeVisible();
    await expect(page.getByText('File', { exact: true })).toBeVisible();
  });

  test('a kind chip re-queries the server', async ({ page }) => {
    const assetUrls = await setup(page);
    await page.goto(`${BASE_URL}/assets`);
    await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('requirements.pdf')).toBeVisible();

    await page.getByRole('radio', { name: 'Files' }).click();
    await expect
      .poll(() => assetUrls.some((u) => /kind=file/.test(decodeURIComponent(u))))
      .toBe(true);
  });

  test('shows the empty state when there are no assets', async ({ page }) => {
    await setup(page, EMPTY_FEED);
    await page.goto(`${BASE_URL}/assets`);
    await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('No assets yet')).toBeVisible();
  });
});
