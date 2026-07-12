import { test, expect } from '@playwright/test';

/**
 * Public read-only schedule share viewer E2E (#1486, ADR-0265).
 *
 * The viewer is a public (no-auth) standalone page whose only network call on load
 * is a single GET to /api/v1/share/schedule/<token>/. Each state is driven by mocking
 * that one endpoint with its real projection shape (never the catch-all): a 200
 * schedule snapshot, a 410 (revoked/expired), a 404 (invalid/disabled), and a 429
 * (rate-limited). Read-only is asserted by the absence of any create/edit affordance.
 */

// `**` (not `*`) so the glob spans the token's trailing slash (/schedule/<token>/).
const SHARE_URL = '**/api/v1/share/schedule/**';

const SCHEDULE = {
  content_kind: 'schedule',
  project: { name: 'Atlas Rollout', short_id: 'ATLAS' },
  tasks: [
    {
      short_id: 'ATLAS-1',
      name: 'Discovery & scope',
      wbs_path: '1',
      duration: 10,
      planned_start: '2026-05-01',
      early_start: '2026-05-01',
      early_finish: '2026-05-14',
      is_milestone: false,
      is_critical: false,
      percent_complete: 100,
      status: 'COMPLETE',
      assignee: null,
    },
    {
      short_id: 'ATLAS-2',
      name: 'Requirements baseline',
      wbs_path: '1.2',
      duration: 8,
      planned_start: '2026-05-14',
      early_start: '2026-05-14',
      early_finish: '2026-05-25',
      is_milestone: false,
      is_critical: true,
      percent_complete: 70,
      status: 'IN_PROGRESS',
      assignee: null,
    },
    {
      short_id: 'ATLAS-3',
      name: 'Scope sign-off',
      wbs_path: '1.3',
      duration: 0,
      planned_start: '2026-05-25',
      early_start: '2026-05-25',
      early_finish: '2026-05-25',
      is_milestone: true,
      is_critical: false,
      percent_complete: 0,
      status: 'NOT_STARTED',
      assignee: null,
    },
  ],
  dependencies: [
    { predecessor_short_id: 'ATLAS-1', successor_short_id: 'ATLAS-2', dep_type: 'FS', lag: 0 },
  ],
  show_assignees: false,
  truncated: false,
};

test.describe('Public schedule share viewer', () => {
  test('golden path: renders the read-only schedule', async ({ page }) => {
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SCHEDULE),
      }),
    );

    await page.goto('/share/schedule/tok123');

    await expect(
      page.getByRole('heading', { name: 'Atlas Rollout — Schedule' }),
    ).toBeVisible();
    await expect(page.getByText('Read-only shared view')).toBeVisible();
    await expect(page.getByText('Requirements baseline')).toBeVisible();
    // The critical task carries the non-color "CP" signal (WCAG 1.4.1).
    await expect(page.getByText('CP').first()).toBeVisible();
    // #1684: the milestone renders (amber diamond) with its dated lane label and a
    // legend entry, and the FS dependency edge (ATLAS-1 → ATLAS-2) is an SVG connector.
    await expect(page.getByText(/Scope sign-off · \d+ May/)).toBeVisible();
    await expect(page.getByText('Milestone')).toBeVisible();
    await expect(page.getByText('Dependency')).toBeVisible();
    // At least one dependency connector path is present in the timeline overlay.
    await expect(page.locator('svg polygon').first()).toBeVisible();
    // #1847: the demo landing surfaces the curated MCP example prompts so a
    // Claude Desktop evaluator knows what to ask — a link, not a write control.
    await expect(page.getByRole('heading', { name: 'Ask this schedule anything' })).toBeVisible();
    await expect(
      page.getByText('What breaks if I slip the integration task 5 days?'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Connect an AI assistant/i })).toBeVisible();
    // Read-only: no create/edit affordances anywhere on the page.
    await expect(page.getByRole('button', { name: /add|create|new task|edit/i })).toHaveCount(0);
  });

  test('revoked/expired link shows the branded 410 page', async ({ page }) => {
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'This share link has expired.' }),
      }),
    );

    await page.goto('/share/schedule/tok123');
    await expect(page.getByText('This link is no longer active')).toBeVisible();
  });

  test('invalid/disabled link shows the not-available page on a 404', async ({ page }) => {
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: "This share link isn't available." }),
      }),
    );

    await page.goto('/share/schedule/nope');
    await expect(page.getByText("This share link isn't available")).toBeVisible();
  });

  test('rate-limited link shows the 429 page', async ({ page }) => {
    await page.route(SHARE_URL, (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Request was throttled.' }),
      }),
    );

    await page.goto('/share/schedule/tok123');
    await expect(page.getByText('Too many requests')).toBeVisible();
  });
});
