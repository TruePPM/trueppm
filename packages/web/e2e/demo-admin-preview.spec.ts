/**
 * Read-only demo: static admin-screens preview (#3973).
 *
 * The visitor is a Member and stays one. The page must render the admin screens
 * from literals with the invite control inert, make no write request, and
 * withdraw itself on a normal install.
 */
import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-adm-00000000-0000-0000-0000-000000003973';

async function setup(page: import('@playwright/test').Page, demoReadOnly: boolean) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      { id: PROJECT_ID, name: 'Admin Preview', description: '', start_date: '2026-04-01', calendar: 'default' },
    ],
    projectId: PROJECT_ID,
    demoReadOnly,
  });
}

test.describe('Demo admin preview (#3973)', () => {
  test('golden path: bar link opens a read-only preview that sends no writes', async ({ page }) => {
    const writes: string[] = [];
    page.on('request', (r) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method())) writes.push(`${r.method()} ${r.url()}`);
    });
    await setup(page, true);
    await page.goto('/');
    await page.getByTestId('demo-admin-preview-link').click();

    await expect(page).toHaveURL(/\/demo\/admin-preview$/);
    await expect(page.getByTestId('demo-admin-preview-banner')).toContainText('Static preview');
    await expect(page.getByRole('table', { name: 'Sample workspace members' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite member' })).toBeDisabled();
    await expect(page.getByTestId('roles-matrix')).toBeVisible();
    expect(writes).toEqual([]);
  });

  test('refusal: a normal install is redirected away, not shown the preview', async ({ page }) => {
    await setup(page, false);
    await page.goto('/demo/admin-preview');
    await expect(page).not.toHaveURL(/admin-preview/);
    await expect(page.getByTestId('demo-admin-preview')).toHaveCount(0);
  });
});
