/**
 * The row-edge insert-below `+` must clear the NEXT row's indent/outdent nudge
 * icons by a readable margin on a mouse (#3077).
 *
 * The disc straddles the row boundary, half over the next row, so its left edge
 * is what the next row's nudge lane sees. A first-level child has no
 * `(level - 1) * 12` depth offset to add, so it had the least clearance of any
 * row: `INSERT_LANE_GAP` alone, which was 4px — technically non-overlapping and
 * visually touching. jsdom lays out nothing, so this is measured in a browser.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-insgap-0000-0000-0000-000000003077';

function row(over: Record<string, unknown>) {
  return {
    early_start: '2026-04-06',
    early_finish: '2026-04-17',
    planned_start: '2026-04-06',
    duration: 10,
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
    ...over,
  };
}

const TASKS = [
  row({ id: 'p1', wbs_path: '1', name: 'Phase One', is_summary: true }),
  row({ id: 'c1', wbs_path: '1.1', name: 'First Child', parent_id: 'p1' }),
  row({ id: 'c2', wbs_path: '1.2', name: 'Second Child', parent_id: 'p1' }),
  row({ id: 'g1', wbs_path: '1.2.1', name: 'Grandchild', parent_id: 'c2' }),
];

const outlineRow = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('row').filter({ hasText: name }).first();

test.describe('Schedule insert "+" lane gap on a mouse (#3077)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [
        { id: PROJECT_ID, name: 'Gap Project', description: '', start_date: '2026-04-01', calendar: 'default' },
      ],
      projectId: PROJECT_ID,
      tasks: TASKS,
    });
    await page.route('**/api/v1/projects/*/baselines/', (route) =>
      route.fulfill({ json: { count: 0, next: null, previous: null, results: [] } }),
    );
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByText('First Child').first()).toBeVisible();
  });

  for (const [above, below] of [
    ['First Child', 'Second Child'], // level-2 row: no depth term — the tight case
    ['Phase One', 'First Child'],
  ] as const) {
    test(`the "+" under ${above} clears ${below}'s nudges by at least 8px`, async ({ page }) => {
      const insert = outlineRow(page, above).getByRole('button', {
        name: new RegExp(`Insert an item below ${above}`),
      });
      const disc = await insert.boundingBox();
      expect(disc, 'insert disc has a box').not.toBeNull();
      if (!disc) return;

      const nextRow = outlineRow(page, below);
      const nudges = nextRow.getByRole('button', {
        name: new RegExp(`^(Outdent|Indent|Milestone — ) ?${below}`),
      });
      const n = await nudges.count();
      expect(n, 'the next row renders its nudge controls').toBeGreaterThan(0);

      for (let i = 0; i < n; i++) {
        const b = await nudges.nth(i).boundingBox();
        if (!b) continue;
        // Only a nudge the disc could actually touch matters: they must share some
        // vertical extent, because the disc straddles the row boundary.
        const verticallyShared = disc.y < b.y + b.height && disc.y + disc.height > b.y;
        if (!verticallyShared) continue;
        const gap = disc.x - (b.x + b.width);
        expect(gap, `gap from nudge #${i} to the disc (disc x=${disc.x}, nudge right=${b.x + b.width})`)
          .toBeGreaterThanOrEqual(8);
      }
    });
  }
});
