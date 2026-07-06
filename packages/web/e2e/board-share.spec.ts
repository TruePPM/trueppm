import { test, expect } from '@playwright/test';

/**
 * Public read-only board share viewer E2E (#283, ADR-0245).
 *
 * The viewer is a public (no-auth) standalone page whose only network call on load
 * is a single GET to /api/v1/share/board/<token>/. Each state is driven by mocking
 * that one endpoint with its real response shape (never the catch-all): a 200 board
 * snapshot, a 410 (revoked), and a 404 (invalid/disabled). Read-only is asserted by
 * the absence of any create/edit affordance.
 */

// `**` (not `*`) so the glob spans the token's trailing slash (/board/<token>/).
const SHARE_URL = '**/api/v1/share/board/**';

const BOARD = {
  content_kind: 'board',
  project: { name: 'Riverside Renovation', short_id: 'RIV' },
  columns: [
    {
      key: 'IN_PROGRESS',
      label: 'In Progress',
      cards: [
        {
          short_id: 'RIV-8',
          name: 'Frame the walls',
          status: 'IN_PROGRESS',
          is_milestone: false,
          percent_complete: 40,
          due_date: '2026-08-01',
          assignee: null,
        },
      ],
    },
    { key: 'REVIEW', label: 'Review', cards: [] },
  ],
  show_assignees: false,
  truncated: false,
};

test.describe('Public board share viewer', () => {
  test('golden path: renders the read-only board', async ({ page }) => {
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(BOARD),
      }),
    );

    await page.goto('/share/board/tok123');

    await expect(page.getByRole('heading', { name: 'Riverside Renovation' })).toBeVisible();
    await expect(page.getByText('Read-only shared view')).toBeVisible();
    await expect(page.getByText('Frame the walls')).toBeVisible();
    await expect(page.getByText('RIV-8')).toBeVisible();
    // Read-only: no create/edit affordances anywhere on the page.
    await expect(page.getByRole('button', { name: /add|create|new task/i })).toHaveCount(0);
  });

  test('revoked link shows the branded 410 page', async ({ page }) => {
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'This share link has been revoked.' }),
      }),
    );

    await page.goto('/share/board/tok123');
    await expect(page.getByText('This link has been revoked')).toBeVisible();
    await expect(page.getByText('Ask the project owner for a new share link.')).toBeVisible();
  });

  test('invalid/disabled link shows the not-available page on a 404', async ({ page }) => {
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: "This share link isn't available." }),
      }),
    );

    await page.goto('/share/board/nope');
    await expect(page.getByText("This share link isn't available")).toBeVisible();
  });
});
