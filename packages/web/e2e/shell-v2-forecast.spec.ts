/**
 * Shell v2 Monte Carlo view at `/projects/:id/forecast`, behind `shell_v2`.
 *
 * Golden path: the server's P50/P80/P95 and "as of" render with the run action.
 * Empty state: a 404 from `/monte-carlo/latest/` reads as "Not run yet", not an
 * error. Stale: a server `forecast_staleness` other than `current` replaces the
 * "as of" claim (rule 415). With the flag off the route sends you to Overview.
 * Run: clicking **Run forecast** POSTs to `/monte-carlo/`, polls the task run and
 * refetches `latest`; a refused POST shows an inline error.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-forecast-0000-0000-0000-000000004755';
const TASK_RUN_ID = '00000000-0000-4000-8000-000000004755';

const MC_RESULT = {
  project_id: PROJECT_ID,
  runs: 500,
  p50: '2026-11-15',
  p80: '2026-12-10',
  p95: '2026-12-28',
  histogram_buckets: [
    { date: '2026-11-02', count: 90 },
    { date: '2026-11-09', count: 120 },
  ],
  confidence_curve: [
    { date: '2026-11-02', pct: 10 },
    { date: '2026-11-15', pct: 50 },
    { date: '2026-12-10', pct: 80 },
    { date: '2026-12-28', pct: 95 },
  ],
  forecast_staleness: 'current',
  plan_version: 1,
  plan_version_current: 1,
  last_run_at: '2026-05-12T10:00:00Z',
  cpm_finish: '2026-11-30',
  delta_vs_cpm: { p50: -15, p80: 10, p95: 28 },
};

async function setup(page: Page, latest: 'result' | 'none' | 'stale', flag = true) {
  if (flag) {
    await page.addInitScript(() => {
      localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
    });
  }
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Atlas',
        description: '',
        start_date: '2026-04-01',
        calendar: 'default',
      },
    ],
    projectId: PROJECT_ID,
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/latest/`, (route) =>
    latest === 'none'
      ? route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'No simulation has been run.' }),
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            latest === 'stale'
              ? { ...MC_RESULT, forecast_staleness: 'project_changed' }
              : MC_RESULT,
          ),
        }),
  );
}

test.describe('shell v2 forecast view', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('renders the server percentiles, "as of", and the run action', async ({ page }) => {
    await setup(page, 'result');
    await page.goto(`/projects/${PROJECT_ID}/forecast`);
    const main = page.getByRole('main');
    await expect(main.getByText('As of', { exact: false })).toBeVisible();
    for (const term of ['P50', 'P80', 'P95']) {
      await expect(main.getByText(term, { exact: true }).first()).toBeVisible();
    }
    await expect(main.getByRole('button', { name: 'Run forecast' })).toBeEnabled();
  });

  test('a project with no run reads "Not run yet"', async ({ page }) => {
    await setup(page, 'none');
    await page.goto(`/projects/${PROJECT_ID}/forecast`);
    await expect(page.getByRole('heading', { name: 'Not run yet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run forecast' })).toBeVisible();
  });

  test('a stale run replaces the "as of" claim', async ({ page }) => {
    await setup(page, 'stale');
    await page.goto(`/projects/${PROJECT_ID}/forecast`);
    const main = page.getByRole('main');
    await expect(main.getByText(/project has changed since this forecast ran/)).toBeVisible();
    await expect(main.getByText('As of', { exact: false })).toHaveCount(0);
  });

  test('Run forecast POSTs the run, polls it and refetches the result', async ({ page }) => {
    await setup(page, 'none');
    let posts = 0;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts++;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          queued: true,
          task_run_id: TASK_RUN_ID,
          status: 'pending',
          n_simulations: null,
        }),
      });
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/task-runs/${TASK_RUN_ID}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: TASK_RUN_ID,
          task_name: 'scheduling.monte_carlo',
          celery_task_id: 'celery-4755',
          project: PROJECT_ID,
          initiated_by_username: 'alice',
          status: 'success',
          progress_pct: 100,
          progress_msg: '',
          result_summary: { run_id: null, n_simulations: 500, last_run_at: MC_RESULT.last_run_at },
          error_detail: '',
          created_at: MC_RESULT.last_run_at,
          started_at: MC_RESULT.last_run_at,
          completed_at: MC_RESULT.last_run_at,
        }),
      }),
    );
    await page.goto(`/projects/${PROJECT_ID}/forecast`);
    await expect(page.getByRole('heading', { name: 'Not run yet' })).toBeVisible();

    // The run lands: from now on `latest` serves a result, so the refetch the hook
    // fires after the task run succeeds renders the percentiles.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/latest/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MC_RESULT),
      }),
    );
    await page.getByRole('button', { name: 'Run forecast' }).click();
    await expect(page.getByRole('main').getByText('As of', { exact: false })).toBeVisible();
    expect(posts).toBe(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a refused run shows the server refusal inline', async ({ page }) => {
    await setup(page, 'none');
    await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Too many forecast runs. Wait a minute.' }),
      });
    });
    await page.goto(`/projects/${PROJECT_ID}/forecast`);
    await page.getByRole('button', { name: 'Run forecast' }).click();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Too many forecast runs. Wait a minute. Try again.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run forecast' })).toBeEnabled();
  });

  test('a non-retryable refusal shows the reason and does not offer a retry', async ({ page }) => {
    await setup(page, 'none');
    await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'This project is archived.' }),
      });
    });
    await page.goto(`/projects/${PROJECT_ID}/forecast`);
    await page.getByRole('button', { name: 'Run forecast' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'This project is archived.' });
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('Try again');
  });

  test('with the flag off the route sends you to Overview', async ({ page }) => {
    await setup(page, 'result', false);
    await page.goto(`/projects/${PROJECT_ID}/forecast`);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/overview$`));
  });
});
