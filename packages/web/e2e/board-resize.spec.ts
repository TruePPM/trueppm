/**
 * Board column + phase resize E2E (#285).
 *
 * Golden path: drag a column header's right edge to widen the column, and a
 * phase lane's bottom edge to make it taller. Both preferences persist to
 * localStorage and survive a reload.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-resize0-0000-0000-0000-000000000285';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const COLUMN_WIDTHS_KEY = 'trueppm.board.columnWidths.v1';
const PHASE_HEIGHTS_KEY = 'trueppm.board.phaseHeights.v1';

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Resize Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'r1', wbs_path: '1', name: 'Alpha Phase', early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 50, is_critical: false, is_milestone: false, is_summary: true,
    parent_id: null, status: 'IN_PROGRESS', assignees: [], total_float: null, predecessor_count: 0,
    is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'r2', wbs_path: '1.1', name: 'Design the thing', early_start: '2026-01-05', early_finish: '2026-01-16',
    planned_start: '2026-01-05', duration: 10, percent_complete: 40, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'r1', status: 'IN_PROGRESS', assignees: [],
    total_float: null, predecessor_count: 0, is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

async function setup(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 1 },
  });
}

/** Read the parsed localStorage map for a resize key (or {} when unset). */
async function readMap(page: Page, key: string): Promise<Record<string, number>> {
  const raw = await page.evaluate((k) => localStorage.getItem(k), key);
  return raw ? (JSON.parse(raw) as Record<string, number>) : {};
}

test.describe('Board resize (#285)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Design the thing')).toBeVisible({ timeout: 10_000 });
  });

  test('drag a column header right edge to widen the column, persisted across reload', async ({
    page,
  }) => {
    const handle = page.getByRole('separator', { name: /Resize .* column/ }).first();
    await expect(handle).toBeVisible();

    // Current rendered width of the header cell the handle belongs to.
    const startWidth = await handle.evaluate(
      (el) => (el.parentElement as HTMLElement).getBoundingClientRect().width,
    );

    const box = await handle.boundingBox();
    if (!box) throw new Error('resize handle has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();

    // Persisted: one column now carries an explicit width, widened past its
    // start and above the 200px floor.
    const stored = await readMap(page, COLUMN_WIDTHS_KEY);
    const values = Object.values(stored);
    expect(values.length).toBeGreaterThanOrEqual(1);
    const w = values[0];
    expect(w).toBeGreaterThan(startWidth + 100);
    expect(w).toBeGreaterThanOrEqual(200);

    // Survives a reload — the persisted width is reapplied to the header cell.
    await page.reload();
    await expect(page.getByText('Design the thing')).toBeVisible({ timeout: 10_000 });
    expect(await readMap(page, COLUMN_WIDTHS_KEY)).toEqual(stored);

    const handleAfter = page.getByRole('separator', { name: /Resize .* column/ }).first();
    const widthAfter = await handleAfter.evaluate(
      (el) => (el.parentElement as HTMLElement).getBoundingClientRect().width,
    );
    expect(Math.abs(widthAfter - w)).toBeLessThan(3);
  });

  test('drag a phase lane bottom edge to grow its height, persisted across reload', async ({
    page,
  }) => {
    const handle = page.getByRole('separator', { name: /Resize .* height/ }).first();
    await expect(handle).toBeVisible();

    const box = await handle.boundingBox();
    if (!box) throw new Error('phase resize handle has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 140, { steps: 12 });
    await page.mouse.up();

    const stored = await readMap(page, PHASE_HEIGHTS_KEY);
    const values = Object.values(stored);
    expect(values.length).toBeGreaterThanOrEqual(1);
    expect(values[0]).toBeGreaterThanOrEqual(120);

    await page.reload();
    await expect(page.getByText('Design the thing')).toBeVisible({ timeout: 10_000 });
    expect(await readMap(page, PHASE_HEIGHTS_KEY)).toEqual(stored);
  });

  test('keyboard arrow nudges a focused column resizer and clamps at the floor', async ({
    page,
  }) => {
    const handle = page.getByRole('separator', { name: /Resize .* column/ }).first();
    await handle.focus();

    // Many ArrowLeft presses drive the width down; it must clamp at 200, never below.
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('ArrowLeft');
    }
    const stored = await readMap(page, COLUMN_WIDTHS_KEY);
    const w = Object.values(stored)[0];
    expect(w).toBe(200);
  });
});
