/**
 * Milestone conversion and its reverse (#3256, #3258).
 *
 * The shipped act sent a bare `duration: 0`. The serializer's coupling is
 * one-directional — `is_milestone: true` zeroes duration and sets `delivery_mode`,
 * but a bare duration write infers **neither** flag — so the act produced a
 * zero-duration *work* row while the session trail announced a milestone. The trail
 * is the surface this design leans on instead of a per-row Save, so a log that can be
 * wrong about the thing it stands in for is the part that made this more than a
 * display bug.
 *
 * The store is deliberately **stateful** (`setupTaskStore`). `useUpdateTask`
 * invalidates `['tasks', projectId]` in `onSuccess`, so a stateless list mock
 * re-serves the pre-write fixture and erases the committed value a few tens of
 * milliseconds after the optimistic render — green locally, red on a loaded runner
 * (#2752). Asserting DOM state after a write requires the read to echo it.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore, type TaskRow } from './fixtures/task-store';

const PROJECT_ID = 'e2e-conv-00000000-0000-0000-0000-000000003256';

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Milestone Conversion Project',
    description: '',
    start_date: '2026-05-04',
    calendar: 'default',
  },
];

const TASKS = [
  {
    id: 'c-phase',
    wbs_path: '1',
    name: 'Mobilization',
    early_start: '2026-05-04',
    early_finish: '2026-05-15',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    // A phase: its dates roll up from the work inside it, so it cannot be a gate.
    is_summary: true,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
  },
  {
    id: 'c-work',
    wbs_path: '1.1',
    name: 'FAT review',
    early_start: '2026-05-04',
    early_finish: '2026-05-08',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'c-phase',
    status: 'NOT_STARTED',
    assignees: [],
  },
];

/**
 * Reproduce the serializer's one-directional coupling in the mock.
 *
 * This is the whole point of the spec: a bare `duration: 0` must NOT produce a
 * milestone here either, or the fixture would quietly make the old client code pass.
 */
function applyPatch(body: Record<string, unknown>, current: TaskRow): TaskRow {
  const next: TaskRow = { ...current, ...body };
  if (body.is_milestone === true) {
    next.is_milestone = true;
    next.delivery_mode = 'milestone';
    next.duration = 0;
    next.early_finish = current.early_start;
  } else if (body.is_milestone === false) {
    next.is_milestone = false;
    next.delivery_mode = 'waterfall';
  }
  return next;
}

async function gotoSchedule(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
  const store = await setupTaskStore(page, { tasks: TASKS, applyPatch });
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({ timeout: 10_000 });
  return store;
}

test.describe('Milestone conversion (#3256)', () => {
  test('converting sends is_milestone, renders the diamond, and states zero duration', async ({
    page,
  }) => {
    const store = await gotoSchedule(page);
    const row = page.locator('[data-row-id="c-work"]');
    await expect(row).toBeVisible();

    await row.click({ button: 'right' });
    await page.getByRole('menuitemcheckbox', { name: /Convert to milestone/ }).click();

    await expect.poll(() => store.patches.length).toBeGreaterThan(0);
    // The request-side contract. A bare `duration: 0` is the defect, and it is not
    // distinguishable from the fix by any DOM assertion on a forgiving server.
    expect(store.patches[0]).toEqual({ is_milestone: true });
    expect(store.patches[0]).not.toHaveProperty('duration');

    // #3273 — `toBeVisible`, not presence. The glyph is the only channel that asserts
    // the row TYPE (everything else on the row states a consequence), and it is
    // `aria-hidden`, so a zero-width render leaves nobody — sighted or not — with the
    // type. `toBeVisible()` is what distinguishes "rendered" from "rendered at 0px";
    // `toHaveCount(1)` passed throughout the defect. This is the only e2e guarding it.
    await expect(row.getByTestId('milestone-glyph')).toBeVisible();
    // #3258 — Dur states the zero. An em-dash would read as "unknown", which is the
    // wrong thing to say about the one row type defined by having no duration. This
    // is also the assertion a user can actually perceive today.
    await expect(row.getByLabel('0 days — milestone')).toHaveText('0d');
    await expect(row.getByLabel(/milestone — single date in Start column/)).toHaveText('—');
  });

  test('the trail records the act only once the write lands', async ({ page }) => {
    const store = await gotoSchedule(page);
    const row = page.locator('[data-row-id="c-work"]');
    await row.click({ button: 'right' });
    await page.getByRole('menuitemcheckbox', { name: /Convert to milestone/ }).click();
    await expect.poll(() => store.patches.length).toBeGreaterThan(0);

    await expect(
      page.getByText(
        'FAT review is a milestone — zero duration, so it marks a date rather than taking time.',
      ),
    ).toBeVisible();
  });

  test('converting back restores the estimate the row had before', async ({ page }) => {
    const store = await gotoSchedule(page);
    const row = page.locator('[data-row-id="c-work"]');

    await row.click({ button: 'right' });
    await page.getByRole('menuitemcheckbox', { name: /Convert to milestone/ }).click();
    await expect.poll(() => store.patches.length).toBe(1);
    await expect(row.getByLabel('0 days — milestone')).toHaveText('0d');

    // The reverse did not exist at all before #3256 — the UI said so out loud, which
    // made a one-way trip out of an act the spec defines as a toggle.
    await row.click({ button: 'right' });
    await page.getByRole('menuitemcheckbox', { name: 'Milestone' }).click();
    await expect.poll(() => store.patches.length).toBe(2);

    expect(store.patches[1]).toEqual({ is_milestone: false, duration: 5 });
    await expect(row.getByTestId('milestone-glyph')).toHaveCount(0);
    await expect(row.getByLabel('5 days')).toHaveText('5d');
    await expect(page.getByText('FAT review is an item again, at 5 days.')).toBeVisible();
  });

  test('a phase refuses the conversion and says why', async ({ page }) => {
    const store = await gotoSchedule(page);
    const phase = page.locator('[data-row-id="c-phase"]');
    await expect(phase).toBeVisible();

    await phase.click({ button: 'right' });
    const item = page.getByRole('menuitemcheckbox', { name: /Convert to milestone/ });
    await expect(item).toBeDisabled();
    // The reason is on screen, not only in the accessible name: a greyed item with no
    // reason cannot be told apart from a missing permission. Before #3256 the item was
    // disabled only when the row was ALREADY a milestone, so a phase was offered the
    // act outright and it did nothing recognisable.
    await expect(
      page.getByText('A phase cannot be a milestone — its dates roll up from the work inside it.'),
    ).toBeVisible();
    expect(store.patches).toHaveLength(0);
  });
});
