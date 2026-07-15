/**
 * My Assets personal surface E2E (#1980, ADR-0428).
 *
 * Golden path: navigate to /me/assets → the personal cross-project feed lists a
 * file row and a link row, each with its owning-project breadcrumb → the request
 * carries `mine=true` → a kind chip re-queries with `mine=true` preserved. Plus
 * the personal empty state. The workspace `GET /assets/` read is mocked; the
 * shell + auth come from the shared fixtures, and the catch-all 401-guard keeps
 * no unmocked request from tripping the session-expired modal.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

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
      task: { id: 't1', name: 'Login redesign' },
      project: { id: 'proj-pay', name: 'Payments' },
      program: { id: 'prog-plat', name: 'Platform' },
      added_by: null,
      added_at: '2026-03-01T12:05:00Z',
    },
    {
      kind: 'file',
      id: 'f1',
      title: 'requirements.pdf',
      url: null,
      download_url: '/api/v1/projects/proj-alpha/tasks/t2/attachments/f1/signed-url/',
      provider: null,
      status: null,
      preview_type: null,
      labels: [],
      task: { id: 't2', name: 'Foundation' },
      project: { id: 'proj-alpha', name: 'Alpha' },
      program: { id: 'prog-ga', name: 'GA Launch' },
      added_by: { id: 'u1', display_name: 'Alice' },
      added_at: '2026-03-01T12:00:00Z',
    },
  ],
  next_cursor: null,
};

const EMPTY_FEED = { results: [], next_cursor: null };

async function setup(page: Page, body: unknown = FEED): Promise<string[]> {
  await setupAuth(page);
  await setupApiMocks(page);
  await setupCatchAll(page);
  const assetUrls: string[] = [];
  // Registered last → wins over the catch-all for the workspace assets read.
  await page.route('**/api/v1/assets/**', (route) => {
    assetUrls.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return assetUrls;
}

test.describe('My Assets — personal surface (#1980, ADR-0428)', () => {
  test('lists my assets across projects, each with its project breadcrumb, and requests mine=true', async ({
    page,
  }) => {
    const assetUrls = await setup(page);
    await page.goto('/me/assets');

    // "Page rendered" signal — the heading only appears after the feed read resolves.
    await expect(page.getByRole('heading', { name: 'My Assets' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Files and links on tasks assigned to you.')).toBeVisible();

    // Link row: external anchor + label pill.
    const link = page.getByRole('link', { name: /PR 7/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://github.com/acme/api/pull/7');

    // Cross-project context: each row carries its own project name.
    await expect(page.getByText('Payments', { exact: true })).toBeVisible();
    await expect(page.getByText('Alpha', { exact: true })).toBeVisible();
    await expect(page.getByText('requirements.pdf')).toBeVisible();

    // The workspace endpoint is always scoped to the caller — mine=true is baked in.
    await expect
      .poll(() => assetUrls.some((u) => /mine=true/.test(decodeURIComponent(u))))
      .toBe(true);
  });

  test('a kind chip re-queries with mine=true preserved', async ({ page }) => {
    const assetUrls = await setup(page);
    await page.goto('/me/assets');
    await expect(page.getByRole('heading', { name: 'My Assets' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('requirements.pdf')).toBeVisible();

    await page.getByRole('radio', { name: 'Files' }).click();
    await expect
      .poll(() =>
        assetUrls.some((u) => {
          const d = decodeURIComponent(u);
          return /kind=file/.test(d) && /mine=true/.test(d);
        }),
      )
      .toBe(true);
  });

  test('shows the personal empty state when I have no assets', async ({ page }) => {
    await setup(page, EMPTY_FEED);
    await page.goto('/me/assets');
    await expect(page.getByRole('heading', { name: 'My Assets' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('No assets on your tasks yet')).toBeVisible();
  });
});
