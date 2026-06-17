import { expect, test, type Page } from '@playwright/test';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

/**
 * E2E coverage for the Task Notes feature (#740, ADR-0143).
 *
 * Notes is a flat, pinned-first, immutable why/decision log registered as a
 * drawer section (priority 480, activity tab) just above Comments. The section
 * is exercised here via the task **detail page** (`/projects/:id/tasks/:taskId`,
 * TaskDetailPage), which renders the same registry-driven sections in a single
 * column. That surface is DOM-routed and deterministic — unlike opening the
 * drawer by clicking a bar in the canvas-rendered schedule grid, which is flaky
 * to drive in `vite preview`. The freshness chip, which only lives on the grid
 * row, is covered by its own grid-level test that needs no drawer.
 *
 * The notes endpoint is mocked statefully so a created note round-trips through
 * the create hook's invalidate-and-refetch; all other endpoints come from the
 * shared fixtures harness (catch-all 404 guards against an unmocked 401).
 */

const FIXTURE_PROJECT_ID = 'e2e-notes-0000-0000-0000-0000-000000000740';

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Alpha Platform Upgrade',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    estimation_mode: 'open',
  },
];

const FIXTURE_API_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Discovery & Design',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    duration: 10,
    percent_complete: 50,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    // Freshness signal (ADR-0143): t1 has a recent note, t2 does not.
    latest_note_at: '2026-10-15T09:00:00Z',
    optimistic_duration: 7,
    most_likely_duration: 10,
    pessimistic_duration: 15,
    estimate_status: null,
    status: 'IN_PROGRESS',
    planned_start: null,
    assignments: [],
  },
  {
    id: 't2',
    wbs_path: '2',
    name: 'Backend Implementation',
    early_start: '2026-10-19',
    early_finish: '2026-10-30',
    duration: 10,
    percent_complete: 0,
    total_float: 0,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    latest_note_at: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    status: 'NOT_STARTED',
    planned_start: null,
    assignments: [],
  },
];

interface NoteRow {
  id: string;
  task: string;
  author: { id: string; username: string; display_name: string } | null;
  body: string;
  pinned: boolean;
  decision: boolean;
  edited_at: string | null;
  created_at: string;
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

function makeNote(body: string, overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    id: `srv-${Math.abs(hashCode(body))}`,
    task: 't1',
    author: { id: 'u-morgan', username: 'morgan', display_name: 'Morgan Lee' },
    body,
    pinned: false,
    decision: false,
    edited_at: null,
    created_at: '2026-10-15T09:00:00Z',
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  };
}

/**
 * Wire the shared harness + a stateful notes store, then (for the read-only
 * case) override the self-membership role. `role` defaults to ADMIN (300) so the
 * editor cases see every write affordance; pass 0 for the Viewer case.
 */
async function setup(
  page: Page,
  opts: { role?: number; seedNotes?: NoteRow[] } = {},
): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_API_TASKS,
  });

  // Stateful notes store: GET lists pinned-first then newest; POST appends and
  // returns the server row so the create hook's invalidate-and-refetch shows it.
  const notes: NoteRow[] = [...(opts.seedNotes ?? [])];
  await page.route('**/api/v1/projects/*/tasks/*/notes/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/').filter(Boolean);
    const notesIdx = parts.indexOf('notes');
    const trailing = parts.slice(notesIdx + 1); // [] = list, [id] = detail, [id,'pin'] = pin

    if (request.method() === 'POST' && trailing.length === 0) {
      const body = (request.postDataJSON() ?? {}) as { body?: string };
      const created = makeNote(body.body ?? '', { created_at: '2026-10-16T12:00:00Z' });
      notes.push(created);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(created),
      });
    }

    if (request.method() === 'POST' && trailing[1] === 'pin') {
      const target = notes.find((n) => n.id === trailing[0]);
      if (target) target.pinned = !target.pinned;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(target ?? {}),
      });
    }

    // GET list — pinned-first, then newest.
    const ordered = [...notes]
      .filter((n) => !n.is_deleted)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.created_at.localeCompare(a.created_at);
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: ordered.length, next: null, previous: null, results: ordered }),
    });
  });

  // Read-only Viewer: override the harness's self-membership (defaults to ADMIN).
  // useCurrentUserRole reads results[0].role from ?self=true; 0 = Viewer.
  if (opts.role !== undefined && opts.role !== 300) {
    await page.route('**/api/v1/projects/*/members/**', (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('self') === 'true') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ id: 'mem-self', role: opts.role, user_id: 'e2e-user' }]),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'mem-self', role: opts.role }]),
      });
    });
  }
}

/**
 * Navigate to the task detail page and expand the Notes section. On the detail
 * page Overview (priority 100) is the only section open by default; Notes (480)
 * starts collapsed, so we click its accordion header to reveal the composer/list.
 */
async function openNotesSection(page: Page) {
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/tasks/t1`);
  await expect(
    page.getByRole('heading', { name: 'Discovery & Design', level: 1 }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Notes' }).click();
}

test.describe('Task notes — detail page section (#740)', () => {
  test('an editor can add a note and it round-trips into the list', async ({ page }) => {
    await setup(page, { role: 300 });
    await openNotesSection(page);

    const composer = page.getByRole('textbox', { name: 'Note body' });
    await expect(composer).toBeVisible();

    await composer.fill('Spike showed Option B is cheaper — going with it.');
    await page.getByRole('button', { name: 'Add note' }).click();

    await expect(page.getByText('Spike showed Option B is cheaper — going with it.')).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText('Morgan Lee').first()).toBeVisible();
  });

  test('shows the empty state when the task has no notes', async ({ page }) => {
    await setup(page, { role: 300 });
    await openNotesSection(page);

    await expect(
      page.getByText('No notes yet — capture the first decision or why.'),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('a Viewer sees notes but no composer (read-only)', async ({ page }) => {
    await setup(page, {
      role: 0,
      seedNotes: [makeNote('Locked decision: ship behind a flag.')],
    });
    await openNotesSection(page);

    await expect(page.getByText('Locked decision: ship behind a flag.')).toBeVisible({
      timeout: 5_000,
    });
    // No write affordances for a read-only Viewer.
    await expect(page.getByRole('textbox', { name: 'Note body' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add note' })).toHaveCount(0);
  });
});

test.describe('Task notes — freshness chip on the schedule row (#740)', () => {
  test('a task with a recent note shows the 📝 freshness marker', async ({ page }) => {
    await setup(page, { role: 300 });
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);

    const grid = page.getByRole('grid', { name: 'Task list' });
    await expect(grid).toBeVisible({ timeout: 10_000 });
    // t1 has latest_note_at; t2 does not — exactly one row carries the chip.
    await expect(page.getByTestId('note-freshness-chip')).toHaveCount(1);
  });
});
