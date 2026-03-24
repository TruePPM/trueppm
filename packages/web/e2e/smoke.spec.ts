import { test, expect } from '@playwright/test';

/**
 * Smoke tests — verify the app shell loads and key structural elements are present.
 * These run against the production build (vite preview) with fixture data.
 */

test('page title is TruePPM', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('TruePPM');
});

test('top bar renders with logo and nav', async ({ page }) => {
  await page.goto('/');
  // TopBar is the page header landmark
  const header = page.getByRole('banner');
  await expect(header).toBeVisible();
  // Sidebar open/collapsed toggle is present (desktop — hamburger is md:hidden)
  await expect(page.getByRole('navigation', { name: 'Project list' })).toBeVisible();
});

test('sidebar shows PROJECTS section header', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'PROJECTS' })).toBeVisible();
});

test('status bar shows task count from fixture', async ({ page }) => {
  await page.goto('/');
  // Fixture has 42 tasks
  const footer = page.getByRole('contentinfo', { name: 'Project status' });
  await expect(footer).toBeVisible();
  await expect(footer.getByText('42 tasks')).toBeVisible();
});

test('no console errors on load', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto('/');
  // Allow React DevTools message but no real errors
  const realErrors = errors.filter(
    (e) => !e.includes('Download the React DevTools'),
  );
  expect(realErrors).toHaveLength(0);
});
