/**
 * E2E for project status updates on the shell v2 Project Overview (#4804) behind
 * `?ff=shell_v2`: compose and post (the new row appears in history), the empty and
 * the failed-post states, and the offline draft that survives a reload. The
 * status-updates list is a stateful store: the POST appends and the refetch the
 * mutation's success handler fires serves it back (see `setupTaskStore`'s rule).
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { expectNoA11yViolationsBothThemes } from './fixtures/a11y';

const PID = 'e2e-status-upd-0000-0000-0000-000000004804';

const metric = (value: string | number | null, reason?: string) => ({
  value,
  as_of: '2026-11-20T09:12:00Z',
  definition: 'Server sentence.',
  ...(reason ? { reason } : {}),
});

function snapshot() {
  return {
    schema_version: 1,
    as_of: '2026-11-20T09:12:00Z',
    previous_seq: null,
    forecast: {
      p50: metric('2026-12-01'),
      p80: metric('2026-12-07'),
      cpm_finish: metric('2026-11-28'),
      cpm_finish_at_day_start: false,
      baseline_finish: null,
      baseline_finish_variance_days: metric(null, 'no_baseline'),
    },
    milestones: [],
    milestones_truncated: false,
    counts: {
      completed_since_previous: metric(null, 'no_previous_update'),
      slipped_since_previous: metric(null, 'no_previous_update'),
    },
    risks: [],
    decisions: [],
  };
}

function update(
  seq: number,
  rag: string,
  narrative: string,
  liveDiff: Record<string, unknown> = {},
) {
  return {
    id: `00000000-0000-0000-0000-00000000000${seq}`,
    project: PID,
    seq,
    rag,
    narrative,
    author: 1,
    author_name: 'Pat Manager',
    posted_at: '2026-11-20T09:12:00Z',
    computed_health: 'on_track',
    snapshot: snapshot(),
    snapshot_sha256: 'a'.repeat(64),
    snapshot_verified: true,
    live_diff: liveDiff,
  };
}

/** The `size` of every PDF request the page made, in order (#4805). */
let pdfRequests: string[] = [];

async function open(page: Page, opts: { initial: unknown[]; postStatus?: number }) {
  const store = [...opts.initial];
  pdfRequests = [];
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page);
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route(`**/api/v1/projects/${PID}/`, (r) =>
    r.fulfill(
      json({
        id: PID,
        name: 'Status Update Project',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        health: 'AUTO',
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PID}/members/**`, (r) =>
    r.fulfill(json([{ id: 'self', role: 300 }])),
  );
  await page.route(`**/api/v1/projects/${PID}/overview/`, (r) =>
    r.fulfill(
      json({
        schedule_health: 'on_track',
        critical_task_count: 1,
        total_tasks: 4,
        complete_tasks: 1,
        next_milestone: null,
        open_risk_count: 0,
        high_risk_count: 0,
        as_of: '2026-11-20T09:12:00Z',
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PID}/monte-carlo/latest/`, (r) =>
    r.fulfill(json({ detail: 'No simulation result available.' }, 404)),
  );
  await page.route(`**/api/v1/projects/${PID}/status-updates/**`, async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith('/pdf/')) {
      pdfRequests.push(url.searchParams.get('size') ?? '');
      await r.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF\n' });
      return;
    }
    if (r.request().method() === 'POST') {
      if (opts.postStatus && opts.postStatus >= 400) {
        await r.fulfill(json({ detail: 'boom' }, opts.postStatus));
        return;
      }
      const body = r.request().postDataJSON() as { rag: string; narrative: string };
      const created = update(store.length + 1, body.rag, body.narrative);
      store.unshift(created);
      await r.fulfill(json(created, 201));
      return;
    }
    await r.fulfill(json({ count: store.length, next: null, previous: null, results: store }));
  });
  await page.goto(`/projects/${PID}/overview?ff=shell_v2`);
  await expect(page.getByTestId('status-updates')).toBeVisible({ timeout: 10_000 });
}

test.describe('shell v2 project status updates', () => {
  test('golden path: compose, post, and the update appears in history', async ({
    page,
  }, testInfo) => {
    await open(page, {
      initial: [
        update(1, 'green', 'All good', { 'forecast.p80': { value: '2026-12-14', as_of: null } }),
      ],
    });
    const first = page.getByTestId('status-update-row');
    await expect(first).toHaveCount(1);
    await first.click();
    await expect(page.getByTestId('snapshot-now-forecast.p80')).toContainText('now');
    await page.getByRole('button', { name: 'Post update' }).click();
    const composer = page.getByTestId('status-composer');
    await composer.getByTestId('rag-amber').click();
    await composer
      .getByTestId('status-composer-narrative')
      .fill('Vendor slipped two weeks\nDetails follow.');
    await expect(composer.getByTestId('status-composer-first-line')).toContainText(
      'Vendor slipped two weeks',
    );
    await expectNoA11yViolationsBothThemes(page, testInfo);
    await composer.getByRole('button', { name: 'Post update' }).click();
    await expect(page.getByTestId('status-composer')).toHaveCount(0);
    await expect(page.getByTestId('status-update-row')).toHaveCount(2);
    await expect(page.getByTestId('status-update-row').first()).toContainText(
      'Vendor slipped two weeks',
    );
    await expect(page.getByTestId('status-update-row').first()).toContainText('At risk');
  });

  test('a history row downloads its PDF and mints a share link (#4805)', async ({ page }) => {
    await open(page, { initial: [update(1, 'green', 'All good')] });
    // After `open`: a route registered later wins over the catch-all.
    await page.route(`**/api/v1/projects/${PID}/share-links/`, async (r) => {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({
        content_kind: 'status_update',
        status_update: update(1, 'green', '').id,
      });
      await r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: '00000000-0000-0000-0000-0000000000aa',
          content_kind: 'status_update',
          token_prefix: 'tok12345',
          label: '',
          show_assignees: false,
          show_milestone_dates: true,
          status_update: update(1, 'green', '').id,
          show_risks: false,
          show_decisions: false,
          created_by: 1,
          created_by_name: 'Pat Manager',
          created_at: '2026-11-20T09:12:00Z',
          expires_at: '2026-12-20T09:12:00Z',
          revoked_at: null,
          access_count: 0,
          last_accessed_at: null,
          is_active: true,
          is_expired: false,
          token: 'e2e-share',
          share_path: '/share/status-update/e2e-share',
        }),
      });
    });
    await page.getByTestId('status-update-row').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('status-update-pdf-a4').click();
    expect((await download).suggestedFilename()).toBe('project-status-update-1-a4.pdf');
    expect(pdfRequests).toEqual(['a4']);

    await page.getByTestId('status-update-share').click();
    await page.getByRole('button', { name: 'Create link' }).click();
    await expect(page.getByTestId('status-update-share-reveal').getByRole('textbox')).toHaveValue(
      /\/share\/status-update\/e2e-share$/,
    );
  });

  test('empty state offers the one action', async ({ page }) => {
    await open(page, { initial: [] });
    await expect(page.getByTestId('status-updates-empty')).toContainText('No status updates yet');
    await expect(page.getByRole('button', { name: 'Post update' })).toBeVisible();
  });

  test('a failed post keeps the call and narrative as a draft', async ({ page }) => {
    await open(page, { initial: [update(1, 'green', 'All good')], postStatus: 500 });
    await page.getByRole('button', { name: 'Post update' }).click();
    const composer = page.getByTestId('status-composer');
    await composer.getByTestId('rag-red').click();
    await composer.getByTestId('status-composer-narrative').fill('Blocked on vendor');
    await composer.getByRole('button', { name: 'Post update' }).click();
    await expect(page.getByTestId('status-composer-error')).toHaveText(
      /Update 2 didn’t post; your call and narrative are kept as a draft\./,
    );
    await expect(composer.getByTestId('status-composer-narrative')).toHaveValue(
      'Blocked on vendor',
    );
  });

  test('offline draft: post waits for the network and the draft survives a reload', async ({
    page,
    context,
  }) => {
    await open(page, { initial: [] });
    await page.getByRole('button', { name: 'Post update' }).click();
    const composer = page.getByTestId('status-composer');
    await composer.getByTestId('rag-green').click();
    await composer.getByTestId('status-composer-narrative').fill('Draft while offline');
    await context.setOffline(true);
    await expect(composer.getByTestId('status-composer-offline')).toHaveText(
      'Posts when you reconnect; the snapshot freezes then.',
    );
    await expect(composer.getByRole('button', { name: 'Post update' })).toBeDisabled();
    await context.setOffline(false);
    await page.reload();
    await expect(page.getByTestId('status-updates')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Resume draft' }).click();
    await expect(page.getByTestId('status-composer-narrative')).toHaveValue('Draft while offline');
    await expect(page.getByRole('radio', { name: /On track/ })).toBeChecked();
  });

  test('a saved draft is still reachable when the history read fails', async ({ page }) => {
    await open(page, { initial: [update(1, 'green', 'All good')] });
    await page.getByRole('button', { name: 'Post update' }).click();
    const composer = page.getByTestId('status-composer');
    await composer.getByTestId('rag-amber').click();
    await composer.getByTestId('status-composer-narrative').fill('Kept locally');
    await composer.getByRole('button', { name: 'Save draft' }).click();
    // Same page, history now failing: a reload re-reads the list and gets a 500.
    await page.route(`**/api/v1/projects/${PID}/status-updates/**`, (r) =>
      r.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'boom' }),
      }),
    );
    await page.reload();
    // TanStack retries a failed read with backoff before the error state shows.
    await expect(page.getByText('Status updates didn’t load')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Resume draft' }).click();
    await expect(page.getByTestId('status-composer-narrative')).toHaveValue('Kept locally');
  });
});
