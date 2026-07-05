import { test, expect, type Page } from '@playwright/test';
import { setupAuth } from './fixtures/auth';
import { setupApiMocks, setupCatchAll } from './fixtures/api-mocks';

/**
 * E2E for the weekly cross-project timesheet grid (#1435, ADR-0224).
 *
 * Golden path + key states: the grid renders with row/day/week totals, a daily total over
 * 8h is flagged amber, typing hours into an empty cell creates an entry and moves the
 * totals, the week stepper re-reads a different week, and `Submit week` toggles the marker.
 *
 * The mock is **stateful and week-relative**: `GET /me/time-entries/` synthesizes the seed
 * onto whichever Monday the page requests (so the spec is independent of the real current
 * date), and create/patch/delete/submit mutate that state so a refetch reflects the write
 * (avoids the stateless-mock flake class).
 */

const TASK_A = { id: 'task-aaaa', short_id: 'RIV-1', name: 'Foundation pour', project_id: 'proj-1', project_name: 'Riverside' };
const TASK_B = { id: 'task-bbbb', short_id: 'RIV-2', name: 'Framing', project_id: 'proj-1', project_name: 'Riverside' };
const TASK_C = { id: 'task-cccc', short_id: 'RIV-3', name: 'Roofing', project_id: 'proj-1', project_name: 'Riverside' };
const TASKS = [TASK_A, TASK_B, TASK_C];

// Seed as (task, day-offset-from-Monday, minutes): Mon = 5h(A) + 4h(B) = 9h (over 8h),
// Tue = 2h(A). Week total = 11h.
const SEED = [
  { id: 'ts-a-mon', task: TASK_A, offset: 0, minutes: 300 },
  { id: 'ts-b-mon', task: TASK_B, offset: 0, minutes: 240 },
  { id: 'ts-a-tue', task: TASK_A, offset: 1, minutes: 120 },
];

function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return addDaysIso(iso, -((dt.getUTCDay() + 6) % 7));
}

interface MockEntry {
  id: string;
  task: string;
  task_short_id: string;
  task_name: string;
  project: string;
  project_code: string;
  project_name: string;
  minutes: number;
  entry_date: string;
}

function seedFor(monday: string): MockEntry[] {
  return SEED.map((s) => ({
    id: s.id,
    task: s.task.id,
    task_short_id: s.task.short_id,
    task_name: s.task.name,
    project: s.task.project_id,
    project_code: 'RIV',
    project_name: s.task.project_name,
    minutes: s.minutes,
    entry_date: addDaysIso(monday, s.offset),
  }));
}

async function setupTimesheet(page: Page): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: [{ id: 'proj-1', name: 'Riverside' }] });

  // Stateful, week-relative store.
  const state = { from: '', entries: [] as MockEntry[], submitted: new Set<string>() };
  let idSeq = 0;

  function ensureWeek(from: string) {
    if (state.from !== from) {
      state.from = from;
      state.entries = seedFor(from);
    }
  }

  // /me/work/ — candidate tasks for the add-row (stubbed so it doesn't 404).
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: TASKS.map((t) => ({
          ...t,
          status: 'IN_PROGRESS',
          group: 'today',
          is_critical: false,
          is_blocked: false,
          blocked_reason: '',
          due: null,
          due_source: null,
          server_version: 1,
        })),
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
      }),
    }),
  );

  // Weekly rollup + per-cell writes + submit marker.
  await page.route('**/api/v1/me/time-entries/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();

    if (method === 'GET') {
      const from = url.searchParams.get('from') ?? mondayOf(new Date().toISOString().slice(0, 10));
      ensureWeek(from);
      const by_day: Record<string, number> = {};
      const by_cell: Record<string, number> = {};
      let week = 0;
      for (const e of state.entries) {
        by_day[e.entry_date] = (by_day[e.entry_date] ?? 0) + e.minutes;
        by_cell[`${e.task}|${e.entry_date}`] = (by_cell[`${e.task}|${e.entry_date}`] ?? 0) + e.minutes;
        week += e.minutes;
      }
      const results = state.entries.map((e) => ({ ...e, note: '', source: 'manual', server_version: 1, created_at: '2026-01-01T00:00:00Z' }));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results,
          totals: { by_day, by_cell, today_minutes: 0, week_minutes: week },
          submission: { week_start: from, submitted: state.submitted.has(from), submitted_at: state.submitted.has(from) ? '2026-01-01T00:00:00Z' : null },
        }),
      });
      return;
    }

    // PATCH / DELETE /me/time-entries/{id}/
    const id = url.pathname.replace(/\/$/, '').split('/').pop() ?? '';
    if (method === 'PATCH') {
      const body = JSON.parse(req.postData() ?? '{}');
      const e = state.entries.find((x) => x.id === id);
      if (e && typeof body.minutes === 'number') e.minutes = body.minutes;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(e ?? {}) });
      return;
    }
    if (method === 'DELETE') {
      state.entries = state.entries.filter((x) => x.id !== id);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.continue();
  });

  // POST /tasks/{taskId}/time-entries/ — create.
  await page.route('**/api/v1/tasks/*/time-entries/', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    const taskId = new URL(req.url()).pathname.split('/').filter(Boolean).at(-2) ?? '';
    const task = TASKS.find((t) => t.id === taskId) ?? TASK_A;
    const body = JSON.parse(req.postData() ?? '{}');
    const entry: MockEntry = {
      id: `new-${idSeq++}`,
      task: task.id,
      task_short_id: task.short_id,
      task_name: task.name,
      project: task.project_id,
      project_code: 'RIV',
      project_name: task.project_name,
      minutes: body.minutes,
      entry_date: body.entry_date,
    };
    state.entries.push(entry);
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(entry) });
  });

  // POST / DELETE /me/timesheets/{week}/submit — the marker.
  await page.route('**/api/v1/me/timesheets/*/submit', async (route) => {
    const req = route.request();
    const week = new URL(req.url()).pathname.split('/').filter(Boolean).at(-2) ?? '';
    const monday = mondayOf(week);
    if (req.method() === 'POST') {
      state.submitted.add(monday);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ week_start: monday, submitted_at: '2026-01-01T00:00:00Z' }) });
    } else {
      state.submitted.delete(monday);
      await route.fulfill({ status: 204, body: '' });
    }
  });
}

test.describe('Timesheet — weekly grid (#1435, ADR-0224)', () => {
  test('renders the grid with row/day/week totals and flags a day over 8h', async ({ page }) => {
    await setupTimesheet(page);
    await page.goto('/me/timesheet');

    await expect(page.getByRole('heading', { level: 1, name: 'Timesheet' })).toBeVisible();
    const grid = page.getByRole('grid', { name: 'Weekly timesheet' });
    await expect(grid).toBeVisible();

    // Both task rows render with their labels.
    await expect(grid.getByText('Foundation pour')).toBeVisible();
    await expect(grid.getByText('Framing')).toBeVisible();

    // Monday total is 9h → flagged amber (asserted via the accessible label, not styling).
    await expect(page.getByLabel(/Mon total 9:00, over 8 hours/)).toBeVisible();

    // Week total 11:00 in the footer.
    await expect(page.getByLabel('Week total 11:00')).toBeVisible();
  });

  test('typing hours into an empty cell creates an entry and updates the totals', async ({ page }) => {
    await setupTimesheet(page);
    await page.goto('/me/timesheet');

    const grid = page.getByRole('grid', { name: 'Weekly timesheet' });
    await expect(grid).toBeVisible();
    await expect(page.getByLabel('Week total 11:00')).toBeVisible();

    // Foundation pour row: Wednesday (3rd day cell) is empty → type 3 hours.
    const row = grid.getByRole('row').filter({ hasText: 'Foundation pour' });
    const wedCell = row.getByRole('gridcell').nth(2);
    const input = wedCell.locator('input');
    await input.click();
    await input.fill('3');
    await input.press('Enter');

    // POST create fired, refetch reflects it: week total 11:00 → 14:00.
    await expect(page.getByLabel('Week total 14:00')).toBeVisible();
  });

  test('the week stepper re-reads a different week', async ({ page }) => {
    await setupTimesheet(page);
    await page.goto('/me/timesheet');

    const grid = page.getByRole('grid', { name: 'Weekly timesheet' });
    await expect(grid).toBeVisible();

    const stepper = page.locator('span', { hasText: /,\s*20\d\d$/ }).first();
    const before = (await stepper.textContent())?.trim();
    await page.getByRole('button', { name: 'Next week' }).click();
    await expect
      .poll(async () => (await stepper.textContent())?.trim())
      .not.toBe(before);
  });

  test('Submit week toggles the submission marker', async ({ page }) => {
    await setupTimesheet(page);
    await page.goto('/me/timesheet');

    await expect(page.getByRole('grid', { name: 'Weekly timesheet' })).toBeVisible();

    const submit = page.getByRole('button', { name: 'Submit week' });
    await expect(submit).toBeEnabled();
    await submit.click();

    // Marker flips: the action becomes Reopen and a Submitted chip appears.
    await expect(page.getByRole('button', { name: 'Reopen week' })).toBeVisible();
    await expect(page.getByText('Submitted', { exact: true })).toBeVisible();
  });
});
