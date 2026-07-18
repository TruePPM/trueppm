import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Workspace Settings → System health E2E (#692 / #694, ADR-0086).
 *
 * Read-only operator surfaces backed by GET /api/v1/health/system/ (overview)
 * and GET /api/v1/admin/failed-tasks/ (dead-letter inspector). Covers:
 * - Overview golden path: 5 component cards, Retention-purge "unknown", beat
 *   panel, dead-letter summary + Open inspector link.
 * - Dead-letter inspector golden path: list → select row → detail (attempt
 *   summary, last error, payload viewer).
 * - Dead-letter inspector empty state (the healthy all-clear case).
 * - Write actions (#695, ADR-0210): requeue one with backoff, drop one with a
 *   note, and bulk requeue-all over the current filter set.
 */

const FIXTURE_ME = {
  id: 'user-admin',
  username: 'admin',
  display_name: 'Admin',
  initials: 'AD',
  email: 'admin@example.com',
};

const FIXTURE_HEALTH = {
  generated_at: '2026-05-25T12:00:00Z',
  components: [
    { key: 'outbox_dispatcher', label: 'Outbox dispatcher', status: 'ok', state_label: 'Healthy', meta: '0 dead, 0 stuck >10m' },
    { key: 'celery_beat', label: 'Celery Beat', status: 'ok', state_label: 'Live', meta: 'beat 8s ago' },
    { key: 'dead_letter', label: 'Dead-letter alerting', status: 'warn', state_label: '2 parked', meta: 'oldest 2h20m' },
    { key: 'notification_dispatcher', label: 'Notification dispatcher', status: 'ok', state_label: 'Draining', meta: '0 failed-pending' },
    { key: 'retention_purge', label: 'Retention purge', status: 'unknown', state_label: 'No telemetry', meta: 'purge-run history not recorded' },
  ],
  beat: { last_heartbeat: '2026-05-25T11:59:52Z', seconds_since: 8, stale: false, stale_threshold_seconds: 120 },
  scheduled_tasks: [
    { name: 'beat-heartbeat', task: 'beat.heartbeat', cadence: 'every 30s', category: 'heartbeat' },
    { name: 'webhook-deliveries-purge-nightly', task: 'webhooks.purge_old_deliveries', cadence: 'daily 03:30 UTC', category: 'purge' },
  ],
  dead_letter: { parked: 2, oldest_age_seconds: 8400, top_cause: 'ConnectionError', by_status: { dead: 2, pending_retry: 0, dismissed: 0, retried: 5 } },
  retention: [
    { key: 'TRUEPPM_WEBHOOK_RETENTION_DAYS', label: 'Webhook deliveries', unit: 'days', value: 7, disabled: false },
    { key: 'HISTORY_RETENTION_DAYS', label: 'Event history', unit: 'days', value: 90, disabled: false },
  ],
  telemetry: {
    enabled: true,
    endpoint: 'otel-collector.internal:4317',
    endpoint_configured: true,
    protocol: 'grpc',
    service_name: 'trueppm-api',
    service_version: '0.5.0',
    edition: 'community',
    traces_enabled: true,
    metrics_enabled: true,
    sampler: 'parentbased_always_on',
    sampler_arg: '',
  },
};

const TELEMETRY_UNCONFIGURED = {
  enabled: false,
  endpoint: '',
  endpoint_configured: false,
  protocol: 'grpc',
  service_name: 'trueppm-api',
  service_version: '0.5.0',
  edition: 'community',
  traces_enabled: true,
  metrics_enabled: true,
  sampler: 'parentbased_always_on',
  sampler_arg: '',
};

const TELEMETRY_TEST_SUCCESS = {
  mode: 'export',
  outcome: 'success',
  endpoint: 'otel-collector.internal:4317',
  protocol: 'grpc',
  duration_ms: 84,
  detail: 'Canary span accepted by the collector — the export path is working end to end.',
  checked_at: '2026-05-25T12:00:05Z',
};

const TELEMETRY_TEST_FAILURE = {
  mode: 'export',
  outcome: 'failure',
  endpoint: 'otel-collector.internal:4317',
  protocol: 'grpc',
  duration_ms: 5012,
  detail: 'The collector did not accept the canary span. Check that the collector is running.',
  checked_at: '2026-05-25T12:00:05Z',
};

const FIXTURE_TASK = {
  id: 'ft-1',
  task_name: 'scheduling.recalculate_schedule',
  task_id: 'celery-abc12345-6789',
  args: [1, 2],
  kwargs: { project: 'p1' },
  exception_type: 'ConnectionError',
  exception_message: 'Connection refused by broker',
  traceback: 'Traceback (most recent call last):\n  File "tasks.py", line 1\nConnectionError',
  failure_count: 4,
  first_failed_at: '2026-05-25T09:00:00Z',
  last_failed_at: '2026-05-25T11:40:00Z',
  status: 'dead',
};

type Page = import('@playwright/test').Page;

async function setup(
  page: Page,
  opts: {
    failedTasks?: unknown[];
    healthStatus?: number;
    telemetry?: unknown;
    testResult?: unknown;
  } = {},
) {
  const failedTasks = opts.failedTasks ?? [FIXTURE_TASK];
  const healthStatus = opts.healthStatus ?? 200;
  const health = opts.telemetry
    ? { ...FIXTURE_HEALTH, telemetry: opts.telemetry }
    : FIXTURE_HEALTH;
  const testResult = opts.testResult ?? TELEMETRY_TEST_SUCCESS;
  const pj = (data: unknown) => JSON.stringify(data);

  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Generic fallback first; specific routes registered later take priority.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  for (const path of ['**/api/v1/projects/', '**/api/v1/programs/']) {
    await page.route(path, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ results: [], count: 0, next: null, previous: null }),
      }),
    );
  }
  await page.route('**/api/v1/health/system/', (r) =>
    healthStatus === 200
      ? r.fulfill({ status: 200, contentType: 'application/json', body: pj(health) })
      : r.fulfill({
          status: healthStatus,
          contentType: 'application/json',
          body: pj({ detail: 'Internal server error.' }),
        }),
  );
  // Telemetry test-export probe (#2110): POST always 200 with the outcome in body.
  await page.route('**/api/v1/health/telemetry/test/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(testResult) }),
  );
  // List + detail + the four write actions share a prefix; branch on method +
  // path so each returns its real response shape (#695, ADR-0210). One handler
  // keeps the ordering unambiguous (Playwright glob edge cases around the query
  // string are avoided by matching on pathname, which excludes the query).
  await page.route('**/api/v1/admin/failed-tasks/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'POST') {
      if (path.endsWith('/requeue_all/')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ processed: failedTasks.length, matched: failedTasks.length, capped: false }),
        });
      }
      if (path.endsWith('/drop_all/')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ processed: failedTasks.length, matched: failedTasks.length, capped: false }),
        });
      }
      if (path.endsWith('/requeue/')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...FIXTURE_TASK, status: 'retried', workflow_id: 'wf-abc' }),
        });
      }
      if (path.endsWith('/drop/')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({
            ...FIXTURE_TASK,
            status: 'dismissed',
            resolution_note: 'vendor relay down',
            resolved_by_display: 'Admin',
            resolved_at: '2026-05-25T12:00:00Z',
          }),
        });
      }
    }
    if (path.endsWith('/ft-1/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_TASK) });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: failedTasks, count: failedTasks.length, next: null, previous: null }),
    });
  });
}

test.describe('Workspace Settings → System health', () => {
  test('overview shows the five components, retention-purge unknown, and beat panel', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/health');

    await expect(page.getByRole('heading', { name: 'System health' })).toBeVisible();

    // One representative component card renders from the payload (the full
    // list-render is a map over the same array — asserting every label was
    // fixture-echo, not client logic).
    await expect(page.getByText('Outbox dispatcher', { exact: true })).toBeVisible();
    // Retention purge degrades to "No telemetry" (unknown), not an error — this
    // is a real client mapping (status 'unknown' → the hollow-dot state_label).
    await expect(page.getByText('No telemetry')).toBeVisible();

    // Beat heartbeat panel + scheduled-task reference table.
    await expect(page.getByRole('heading', { name: 'Celery Beat heartbeat' })).toBeVisible();
    await expect(page.getByText('beat-heartbeat')).toBeVisible();

    // Dead-letter summary + drill-in link.
    await expect(page.getByRole('link', { name: /Open inspector/i })).toBeVisible();
    // Retention config row.
    await expect(page.getByText('Webhook deliveries')).toBeVisible();

    // Telemetry card (#2110): exporting, with endpoint surfaced + Test export.
    await expect(page.getByRole('heading', { name: 'Telemetry' })).toBeVisible();
    await expect(page.getByText('Exporting')).toBeVisible();
    await expect(page.getByText('otel-collector.internal:4317')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Test export' })).toBeVisible();
  });

  test('telemetry card offers guided setup when export is unconfigured', async ({ page }) => {
    await setup(page, { telemetry: TELEMETRY_UNCONFIGURED });
    await page.goto('/settings/health');

    // Gate on the page having rendered before asserting card chrome.
    await expect(page.getByRole('heading', { name: 'System health' })).toBeVisible();

    await expect(page.getByText('Not configured')).toBeVisible();
    await expect(page.getByText('Export is off — no collector endpoint set')).toBeVisible();
    // Backend picker + env snippet.
    await expect(page.getByRole('button', { name: 'Grafana Tempo' })).toBeVisible();
    await expect(page.getByText(/OTEL_EXPORTER_OTLP_ENDPOINT=/)).toBeVisible();

    // Toggle to the Helm-values snippet.
    await page.getByRole('button', { name: 'Helm values' }).click();
    await expect(page.getByText(/helm upgrade trueppm/)).toBeVisible();
  });

  test('Test export golden path reports a collector ACK', async ({ page }) => {
    await setup(page, { testResult: TELEMETRY_TEST_SUCCESS });
    await page.goto('/settings/health');

    await expect(page.getByRole('heading', { name: 'System health' })).toBeVisible();
    await page.getByRole('button', { name: 'Test export' }).click();

    await expect(page.getByText('Collector accepted the canary span')).toBeVisible();
    await expect(page.getByText(/working end to end/i)).toBeVisible();
  });

  test('Test export surfaces a failure outcome', async ({ page }) => {
    await setup(page, { testResult: TELEMETRY_TEST_FAILURE });
    await page.goto('/settings/health');

    await expect(page.getByRole('heading', { name: 'System health' })).toBeVisible();
    await page.getByRole('button', { name: 'Test export' }).click();

    await expect(page.getByText('Export could not reach the collector')).toBeVisible();
  });

  test('overview shows an error state with Retry when the health API 500s', async ({ page }) => {
    await setup(page, { healthStatus: 500 });
    await page.goto('/settings/health');

    // The hook is retry:false, so a 500 surfaces the error UI immediately
    // (not the fixture, not a stuck skeleton).
    await expect(
      page.getByText("Couldn't load system health — the API may be unreachable."),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    // No component data leaks through in the error state.
    await expect(page.getByText('Outbox dispatcher', { exact: true })).toHaveCount(0);
  });

  test('dead-letter inspector lists tasks and opens detail on selection', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/health/dead-letters');

    // List row.
    await expect(
      page.getByText('scheduling.recalculate_schedule', { exact: true }).first(),
    ).toBeVisible();

    // Select the row → detail pane loads from the {id} endpoint.
    await page.getByRole('button', { name: /scheduling\.recalculate_schedule/ }).click();

    await expect(page.getByRole('heading', { name: 'Attempt summary' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Last error' })).toBeVisible();
    await expect(page.getByText('Connection refused by broker')).toBeVisible();
    // Payload viewer renders the pretty-printed args/kwargs.
    await expect(page.getByText(/"project": "p1"/)).toBeVisible();
    // #695: the detail pane now exposes per-task Requeue + Drop actions.
    await expect(page.getByRole('button', { name: 'Requeue', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Drop', exact: true })).toBeVisible();
  });

  test('dead-letter inspector shows the all-clear empty state', async ({ page }) => {
    await setup(page, { failedTasks: [] });
    await page.goto('/settings/health/dead-letters');

    await expect(page.getByText('No dead-lettered tasks')).toBeVisible();
    await expect(page.getByText('Background processing is clean.')).toBeVisible();
  });

  test('requeue one with a backoff confirms and toasts', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/health/dead-letters?selected=ft-1');

    // Gate on the detail pane having rendered before touching the action bar.
    await expect(page.getByRole('heading', { name: 'Attempt summary' })).toBeVisible();

    await page.getByRole('button', { name: 'Requeue', exact: true }).click();

    // Confirm dialog with the backoff select.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Backoff').selectOption('300');
    await dialog.getByRole('button', { name: 'Requeue', exact: true }).click();

    // Success toast; dialog closes.
    await expect(page.getByText(/Requeued scheduling\.recalculate_schedule/)).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('drop one with a note confirms and toasts', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/health/dead-letters?selected=ft-1');
    await expect(page.getByRole('heading', { name: 'Attempt summary' })).toBeVisible();

    await page.getByRole('button', { name: 'Drop', exact: true }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/Note/).fill('vendor relay down');
    await dialog.getByRole('button', { name: 'Drop', exact: true }).click();

    await expect(page.getByText(/Dropped scheduling\.recalculate_schedule/)).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('bulk requeue-all over the current filter set confirms and toasts', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/health/dead-letters');

    // The bulk bar advertises the current filter count.
    await expect(page.getByText('scheduling.recalculate_schedule', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /Requeue all \(1\)/ }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Requeue 1/ }).click();

    await expect(page.getByText(/Requeued 1 task\./)).toBeVisible();
  });
});
