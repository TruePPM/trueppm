/**
 * At-a-glance external-link status on the schedule task-list row (#767, ADR-0153).
 *
 * The row glyph + count is tinted by the worst external-link status and is hidden
 * for summary/milestone tasks and tasks with no live links. Backed by the
 * `external_link_summary` field on the task-list serializer.
 *
 * Golden path: a leaf task with links shows the glyph with the right count and an
 * accessible "worst status" label. Empty state: a task with zero links shows no
 * glyph. Edge: a summary task with links still shows no glyph (gated in the row).
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-links-00000000-0000-0000-0000-000000000767';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Link Status Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function leaf(
  id: string,
  wbs: string,
  name: string,
  summary: { count: number; worst_status: string | null } | undefined,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    external_link_summary: summary,
    ...extra,
  };
}

const FIXTURE_TASKS = [
  // Golden path — two links, worst status closed.
  leaf('lk1', '1', 'Foundation', { count: 2, worst_status: 'closed' }),
  // Single merged link.
  leaf('lk2', '2', 'Framing', { count: 1, worst_status: 'merged' }),
  // Empty state — no links, no glyph.
  leaf('lk3', '3', 'Roofing', { count: 0, worst_status: null }),
  // Edge — a summary task with links still shows no glyph (gated in the row).
  leaf('lk4', '4', 'Sitework Phase', { count: 3, worst_status: 'closed' }, { is_summary: true }),
];

test.describe('Schedule task-list external-link status (#767)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('shows a link glyph with count + worst-status label on tasks with links', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    // Gate on the list having rendered before asserting the chips.
    await expect(page.getByText('Foundation')).toBeVisible();

    // Golden path: count 2, worst status closed.
    const closedChip = page.getByLabel('2 external links, worst status: closed');
    await expect(closedChip).toBeVisible();
    await expect(closedChip).toContainText('2');

    // Single merged link: singular "link".
    const mergedChip = page.getByLabel('1 external link, worst status: merged');
    await expect(mergedChip).toBeVisible();
    await expect(mergedChip).toContainText('1');
  });

  test('hides the glyph for tasks with no links and for summary tasks', async ({ page }) => {
    await page.goto(BASE_URL);
    // Both rows render...
    await expect(page.getByText('Roofing')).toBeVisible();
    await expect(page.getByText('Sitework Phase')).toBeVisible();

    // ...but only the two link-bearing leaf tasks show a chip.
    await expect(page.getByTestId('link-status-chip')).toHaveCount(2);
  });
});
