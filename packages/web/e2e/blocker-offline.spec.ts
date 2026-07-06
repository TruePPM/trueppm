/**
 * Offline blocker-flag write path (#1159, ADR-0247).
 *
 * Golden path: offline, flag a task blocked → the write is queued (pending badge,
 * no live PATCH) → reconnect → the queued write replays as the identical
 * `PATCH /tasks/{id}/` carrying `X-Base-Version` (ADR-0217 field merge), and the
 * pending badge clears. Edge: an offline unblock queues and replays `blocked_reason:''`.
 *
 * As in board-offline.spec.ts, route mocks intercept before the network, so
 * `context.setOffline(true)` drives `navigator.onLine` (what the app branches on)
 * rather than failing requests — exactly how a real dead zone behaves: the app
 * declines to send rather than the socket erroring.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-blkoff-0000-0000-0000-000000001159';
const TASK_ID = 'blkoff1';

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Offline Blocker Project', description: '', start_date: '2026-04-01', calendar: 'default' },
];

/** Not-flagged task at server_version 5 (the base the flush replays as X-Base-Version). */
function task(flagged: boolean) {
  return {
    id: TASK_ID,
    wbs_path: '1',
    name: 'Foundation',
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
    blocked_reason: flagged ? 'stuck' : '',
    blocker_type: flagged ? 'vendor' : '',
    blocked_age_seconds: flagged ? 3600 : null,
    blocked_since: flagged ? '2026-04-05T00:00:00Z' : null,
    blocked_by: flagged ? { id: 'u1', username: 'alex' } : null,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    server_version: 5,
  };
}

async function openBlockerSection(page: Page): Promise<Locator> {
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  const grid = page.getByRole('grid', { name: 'Task list' });
  await grid.getByText('Foundation', { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /Foundation/ }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  const header = drawer.getByRole('button', { name: 'Blocker' });
  await expect(header).toBeVisible();
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  const section = drawer.getByRole('region', { name: 'Blocker' });
  await expect(section).toBeVisible();
  return section;
}

/** Capture the replayed PATCH (method, body, X-Base-Version) once the app reconnects. */
async function capturePatch(page: Page) {
  const captured: { body: Record<string, unknown> | null; baseVersion: string | undefined } = {
    body: null,
    baseVersion: undefined,
  };
  await page.route(`**/api/v1/tasks/${TASK_ID}/`, (route) => {
    if (route.request().method() === 'PATCH') {
      captured.body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      captured.baseVersion = route.request().headers()['x-base-version'];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: TASK_ID, name: 'Foundation', project: PROJECT_ID, wbs_path: '1', duration: 5, status: 'NOT_STARTED', percent_complete: 0, server_version: 6 }),
      });
    }
    return route.fallback();
  });
  return captured;
}

test.describe('Offline blocker flag (ADR-0247)', () => {
  test('queues a flag offline and replays it with X-Base-Version on reconnect', async ({ page, context }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID, tasks: [task(false)] });
    const captured = await capturePatch(page);

    const section = await openBlockerSection(page);
    await expect(section.getByText('Not blocked')).toBeVisible();

    // Go offline — the dead zone.
    await context.setOffline(true);

    await section.getByRole('button', { name: /flag as blocked/i }).click();
    await section.getByLabel('Reason').fill('Inspector no-show');
    await section.getByLabel(/Type/).selectOption('vendor');
    // The control tells the user this will be saved and synced later.
    await expect(section.getByText(/saved and synced when you reconnect/i)).toBeVisible();
    await section.getByRole('button', { name: 'Flag blocked' }).click();

    // Queued, not sent: the pending affordance shows and no PATCH has fired.
    await expect(section.getByRole('status', { name: /Blocker flag queued/i })).toBeVisible();
    await expect(section.getByText('queued', { exact: true })).toBeVisible();
    expect(captured.body).toBeNull();

    // Reconnect → the shell-mounted flush replays the write.
    await context.setOffline(false);
    await expect.poll(() => captured.body).not.toBeNull();
    expect(captured.body).toMatchObject({ blocked_reason: 'Inspector no-show', blocker_type: 'vendor' });
    // ADR-0217 field merge: the base version we flagged against rides the replay.
    expect(captured.baseVersion).toBe('5');
    // The pending affordance clears once flushed.
    await expect(section.getByRole('status', { name: /Blocker flag queued/i })).toHaveCount(0);
  });

  test('queues an unblock offline and replays blocked_reason:"" on reconnect', async ({ page, context }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID, tasks: [task(true)] });
    const captured = await capturePatch(page);

    const section = await openBlockerSection(page);
    await expect(section.getByText('Blocked', { exact: true })).toBeVisible();

    await context.setOffline(true);
    await section.getByRole('button', { name: 'Unblock' }).click();

    // Optimistically cleared, queued unblock shown on the flag affordance.
    await expect(section.getByRole('status', { name: /Unblock queued/i })).toBeVisible();
    expect(captured.body).toBeNull();

    await context.setOffline(false);
    await expect.poll(() => captured.body).not.toBeNull();
    expect(captured.body).toMatchObject({ blocked_reason: '' });
  });
});
