import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * CSV / Excel import wizard E2E (#746, ADR-0632).
 *
 * Golden path: open the wizard from the project actions menu, upload a file,
 * confirm the detected mapping, commit, and land on the terminal result.
 * Error path: a required field left unmapped blocks Next with a reason, which
 * is the guard that stops a spreadsheet with no name column importing zero
 * tasks.
 */

const PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

type Page = import('@playwright/test').Page;

const PREVIEW_BODY = {
  filename: 'plan.csv',
  headers: ['Title', 'Days', 'Notes'],
  // `confidence` is the server's enum, not a score, and an unmatched column
  // comes back with `field: null` — mirroring the real shape here is what keeps
  // the wizard's null-folding honest.
  columns: [
    { index: 0, header: 'Title', field: 'name', confidence: 'exact' },
    { index: 1, header: 'Days', field: 'duration', confidence: 'fuzzy' },
    { index: 2, header: 'Notes', field: null, confidence: 'none' },
  ],
  sample_rows: [['Foundation pour', '5', 'concrete']],
  row_count: 12,
  truncated_rows: 0,
  task_count: 12,
  resource_count: 3,
  row_errors: [{ row: 4, message: 'Duration is not a number' }],
  error_count: 1,
  warning_count: 2,
  warnings: [],
  available_fields: [
    { field: 'name', label: 'Task name', required: true, multi: false },
    { field: 'duration', label: 'Duration', required: false, multi: false },
  ],
};

const DONE_STATUS = {
  id: 'imp-1',
  status: 'done',
  filename: 'plan.csv',
  summary: {
    tasks_created: 11,
    row_errors: [{ row: 4, message: 'Duration is not a number' }],
  },
  requested_at: '2026-07-27T00:00:00Z',
};

async function gotoSchedule(
  page: Page,
  opts: { search?: string; role?: number } = {},
) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  const pj = (d: unknown) => JSON.stringify(d);
  const emptyList = { count: 0, next: null, previous: null, results: [] };

  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: PROJECT_ID,
            name: 'Alpha Platform Upgrade',
            description: '',
            start_date: '2026-01-01',
            calendar: 'default',
          },
        ],
      }),
    }),
  );
  // Object-shaped, not the catch-all list: ProjectShell gates every project
  // route on this read and a list shape crashes the app (#1190).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        id: PROJECT_ID,
        name: 'Alpha Platform Upgrade',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        estimation_mode: 'OPEN',
        agile_features: false,
        methodology: 'WATERFALL',
        code: '',
        health: 'AUTO',
        visibility: 'WORKSPACE',
        timezone: '',
        default_view: 'SCHEDULE',
        lead: null,
        lead_detail: null,
        iteration_label: 'Sprint',
        is_archived: false,
        archived_at: null,
        archived_by: null,
        recalculated_at: null,
        is_sample: false,
        program_detail: null,
        server_version: 1,
      }),
    }),
  );
  // Scheduler (200) — the CSV wizard's own server floor, one rung below the
  // Admin gate the MS Project import uses.
  await page.route('**/api/v1/projects/*/members/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([{ role: opts.role ?? 200 }]),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 't1',
            wbs_path: '1',
            name: 'Alpha Platform Upgrade',
            early_start: '2026-10-05',
            early_finish: '2026-11-14',
            duration: 30,
            percent_complete: 40,
            is_critical: false,
            is_milestone: false,
          },
        ],
      }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(emptyList) }),
  );
  await page.routeWebSocket('**/ws/v1/projects/**', () => {
    /* accept and hold open */
  });
  await page.goto(`/projects/${PROJECT_ID}/schedule${opts.search ?? ''}`);
}

/**
 * Register the import routes.
 *
 * MUST run AFTER `gotoSchedule` (and therefore after `setupCatchAll`):
 * Playwright matches routes in REVERSE registration order, so the catch-all
 * would otherwise swallow these and answer with its "unmocked" stub.
 */
/** Request content-types the wizard actually sent, captured by {@link routeImport} (#2777). */
interface CapturedTransport {
  previewContentType?: string;
  commitContentType?: string;
}

async function routeImport(
  page: Page,
  opts: {
    preview: { status: number; body: unknown };
    commit?: boolean;
    /** Terminal status payload; defaults to {@link DONE_STATUS}. */
    done?: unknown;
    /**
     * Out param: filled with the real Content-Type header of each intercepted
     * request. A Playwright route fulfills regardless of what the browser
     * actually sent, so nothing else here would notice the shared axios
     * client's `Content-Type: application/json` default silently turning a
     * `FormData` upload into an (empty) JSON body (#2777) — this is what
     * lets the golden path assert transport shape, not just app behavior.
     */
    captured?: CapturedTransport;
  },
) {
  await page.route(`**/api/v1/projects/${PROJECT_ID}/import/csv/preview/`, async (r) => {
    if (opts.captured) opts.captured.previewContentType = r.request().headers()['content-type'];
    await r.fulfill({
      status: opts.preview.status,
      contentType: 'application/json',
      body: JSON.stringify(opts.preview.body),
    });
  });
  if (opts.commit) {
    // Status route first; the commit glob would otherwise also match it.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/import/csv/imp-1/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(opts.done ?? DONE_STATUS),
      }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/import/csv/`, async (r) => {
      if (opts.captured) opts.captured.commitContentType = r.request().headers()['content-type'];
      await r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          detail: 'Import queued.',
          queued: true,
          import_request_id: 'imp-1',
        }),
      });
    });
  }
  // ADR-0810 (#2756).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/import/csv/imp-1/undo/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'imp-1', status: 'undone', undo: { deleted: 11, kept: 0 } }),
    }),
  );
}

async function openWizard(page: Page) {
  // Gate on the schedule having painted before touching toolbar chrome.
  await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: /Import from spreadsheet/ }).click();
  await expect(page.getByRole('dialog', { name: 'Import from a spreadsheet' })).toBeVisible();
}

async function pickFile(page: Page) {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'plan.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Title,Days,Notes\nFoundation pour,5,concrete\n'),
  });
}

test.describe('CSV/Excel import wizard (#746)', () => {
  test('upload → map → confirm → import lands on the result', async ({ page }) => {
    await gotoSchedule(page);
    const captured: CapturedTransport = {};
    await routeImport(page, {
      preview: { status: 200, body: PREVIEW_BODY },
      commit: true,
      captured,
    });
    await openWizard(page);

    const dialog = page.getByRole('dialog', { name: 'Import from a spreadsheet' });

    // Step 1 — upload.
    await pickFile(page);
    await dialog.getByRole('button', { name: 'Next' }).click();

    // Step 2 — the detected mapping, pre-selected.
    await expect(dialog.getByLabel('TruePPM field for column Title')).toHaveValue('name');
    // The preview request must actually leave the browser as multipart, not
    // JSON (#2777) — a wrong axios request config drops the File silently and
    // the wizard would still reach this line with a stale/mock-shaped body.
    expect(captured.previewContentType).toContain('multipart/form-data');
    await dialog.getByRole('button', { name: 'Next' }).click();

    // Step 3 — confirm, with the unmapped column named rather than silently dropped.
    await expect(dialog.getByText(/1 column will not be imported/)).toBeVisible();
    await dialog.getByRole('button', { name: /Import 12 tasks/ }).click();

    // Terminal — partial success is a RESULT: the valid rows landed and the
    // failed one is addressable by line number.
    await expect(dialog.getByText(/Imported 11 tasks/)).toBeVisible();
    await expect(dialog.getByText(/Row 4/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'View schedule' })).toBeVisible();
    expect(captured.commitContentType).toContain('multipart/form-data');
  });

  test('Undo import removes the result and hides View schedule (#2756)', async ({ page }) => {
    await gotoSchedule(page);
    await routeImport(page, { preview: { status: 200, body: PREVIEW_BODY }, commit: true });
    await openWizard(page);

    const dialog = page.getByRole('dialog', { name: 'Import from a spreadsheet' });
    await pickFile(page);
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: /Import 12 tasks/ }).click();

    await expect(dialog.getByText(/Imported 11 tasks/)).toBeVisible();
    // Matched by prefix (#3028): the button spells the chord for the browser's
    // platform, which the Node-side `formatChord` cannot be relied on to agree
    // with. `platform.test.ts` owns the spelling; this owns the flow.
    await dialog.getByRole('button', { name: /^Undo import/ }).click();

    await expect(dialog.getByText('Import undone — the rows it created were removed.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'View schedule' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /^Undo import/ })).toHaveCount(0);
  });

  test('unresolvable rows are parked in a review branch, not dropped (#2732)', async ({ page }) => {
    // The failure this replaces: a row with no name was counted in a summary
    // and then discarded. The operator's only record of it was a number on a
    // screen they had to be looking at when the import finished.
    await gotoSchedule(page);
    await routeImport(page, {
      preview: {
        status: 200,
        body: {
          ...PREVIEW_BODY,
          task_count: 10,
          parked_row_count: 2,
          review_branch_name: 'Import review',
          error_count: 2,
        },
      },
      commit: true,
      done: {
        id: 'imp-1',
        status: 'done',
        filename: 'plan.csv',
        summary: {
          tasks_created: 13,
          plan_tasks_created: 10,
          parked_row_count: 2,
          review_branch_name: 'Import review',
          row_errors: [
            { row: 7, column: 'Title', code: 'missing_name', message: 'Row has no task name.' },
            { row: 9, column: 'Title', code: 'missing_name', message: 'Row has no task name.' },
            { row: 4, column: 'Days', code: 'bad_duration', message: "Could not read 'x'." },
          ],
        },
        requested_at: '2026-08-05T00:00:00Z',
      },
    });
    await openWizard(page);

    const dialog = page.getByRole('dialog', { name: 'Import from a spreadsheet' });
    await pickFile(page);
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: 'Next' }).click();

    // Stated BEFORE the commit: the review branch must not be a surprise found
    // later at the bottom of the outline.
    await expect(dialog.getByText(/parked in an “Import review” branch/)).toBeVisible();
    await expect(dialog.getByText('Parked for review')).toBeVisible();
    await dialog.getByRole('button', { name: /Import 10 tasks/ }).click();

    // The plan count is the plan, not the plan plus the placeholders.
    await expect(dialog.getByText(/Imported 10 tasks/)).toBeVisible();
    await expect(dialog.getByText(/2 rows parked in the “Import review” branch/)).toBeVisible();
    await expect(dialog.getByText(/already in your outline/)).toBeVisible();

    // Grouped by cause, so one wrong column reads as one edit rather than as
    // N indistinguishable lines.
    const problems = dialog.getByRole('region', { name: 'Rows with problems' });
    await expect(problems).toContainText('No task name — 2 rows');
    await expect(problems).toContainText('Row 7, Row 9');
    await expect(problems).toContainText('Unreadable duration — 1 row');
  });

  test('offers the problem rows as a CSV download', async ({ page }) => {
    await gotoSchedule(page);
    await routeImport(page, {
      preview: { status: 200, body: PREVIEW_BODY },
      commit: true,
    });
    await openWizard(page);

    const dialog = page.getByRole('dialog', { name: 'Import from a spreadsheet' });
    await pickFile(page);
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: /^Import/ }).click();

    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download problem rows (CSV)' }).click();
    expect((await download).suggestedFilename()).toBe('trueppm-import-problems.csv');
  });

  test('offers a template download from step 1 over an authenticated request', async ({ page }) => {
    await gotoSchedule(page);
    await routeImport(page, { preview: { status: 200, body: PREVIEW_BODY } });

    // The endpoint is JWT-gated, so the wizard must reach it through the API
    // client rather than a plain anchor — assert the request actually carries
    // the bearer token.
    let authHeader: string | undefined;
    await page.route('**/api/v1/import-templates/csv/', async (r) => {
      authHeader = r.request().headers()['authorization'];
      await r.fulfill({
        status: 200,
        contentType: 'text/csv; charset=utf-8',
        headers: { 'content-disposition': 'attachment; filename="trueppm-import-template.csv"' },
        body: 'ID,WBS,Name,Duration\n1,1,Discovery,5\n',
      });
    });

    await openWizard(page);
    const dialog = page.getByRole('dialog', { name: 'Import from a spreadsheet' });

    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download a template' }).click();
    expect((await download).suggestedFilename()).toBe('trueppm-import-template.csv');
    expect(authHeader).toContain('Bearer');
  });

  test('surfaces whole-file parser decisions and the truncated row count', async ({ page }) => {
    await gotoSchedule(page);
    await routeImport(page, {
      preview: {
        status: 200,
        body: {
          ...PREVIEW_BODY,
          row_count: 5000,
          truncated_rows: 1000,
          warnings: [
            "Only the first sheet ('Sheet1') was imported. 2 other sheet(s) were ignored.",
            'Only the first 5,000 rows were imported; 1,000 were skipped.',
          ],
        },
      },
    });
    await openWizard(page);

    const dialog = page.getByRole('dialog', { name: 'Import from a spreadsheet' });
    await pickFile(page);
    await dialog.getByRole('button', { name: 'Next' }).click();

    // Step 2 — the notices sit above the mapping table, and the guessed column
    // is called out so the operator knows which one to check.
    const notices = dialog.getByRole('region', { name: 'How we read this file' });
    await expect(notices).toContainText('Only the first sheet');
    await expect(dialog.getByText('Guessed — check this')).toBeVisible();

    await dialog.getByRole('button', { name: 'Next' }).click();

    // Step 3 — "5,000" on its own would be a lie about a 6,000-row file. The
    // overflow itself is spelled out once, by the parser's own notice.
    await expect(dialog.getByText('5,000 of 6,000')).toBeVisible();
    await expect(notices).toContainText('1,000 were skipped');
  });

  test('an unmapped required field blocks Next with a reason', async ({ page }) => {
    await gotoSchedule(page);
    await routeImport(page, { preview: { status: 200, body: PREVIEW_BODY } });
    await openWizard(page);

    const dialog = page.getByRole('dialog', { name: 'Import from a spreadsheet' });
    await pickFile(page);
    await dialog.getByRole('button', { name: 'Next' }).click();

    // Clearing the only name column would import zero tasks — the wizard must
    // say so rather than letting the operator commit a no-op.
    await dialog.getByLabel('TruePPM field for column Title').selectOption('');

    await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toContainText('Task name');
  });

  test('a preview failure surfaces the server reason', async ({ page }) => {
    await gotoSchedule(page);
    await routeImport(page, {
      preview: { status: 400, body: { detail: 'No readable header row.' } },
    });
    await openWizard(page);

    const dialog = page.getByRole('dialog', { name: 'Import from a spreadsheet' });
    await pickFile(page);
    await dialog.getByRole('button', { name: 'Next' }).click();

    await expect(dialog.getByRole('alert')).toContainText('No readable header row.');
  });

  // ------------------------------------------------------------------
  // `?import=csv` deep link (#2710)
  // ------------------------------------------------------------------

  test('?import=csv opens the wizard on arrival', async ({ page }) => {
    // This is the landing half of "Create & import spreadsheet": the new-project
    // flow creates the project, then navigates here. Before #2710 the wizard had
    // one mount site reachable only through an overflow menu inside an existing
    // project, so an evaluator with a spreadsheet met the wall before the import.
    await gotoSchedule(page, { search: '?import=csv' });
    await routeImport(page, { preview: { status: 200, body: PREVIEW_BODY } });

    await expect(page.getByRole('dialog', { name: 'Import from a spreadsheet' })).toBeVisible({
      timeout: 10_000,
    });
    // The param is consumed, so a refresh or a back-navigation after the import
    // finishes does not reopen the wizard.
    await expect(page).toHaveURL(/\/schedule(?!.*import=csv)/);
  });

  test('?import=csv does not let a Viewer past the Scheduler gate', async ({ page }) => {
    // The deep link is a shortcut through the navigation, never through the
    // authorization — a pasted link must not open a wizard the toolbar would not
    // offer, and whose server (IsProjectScheduler, ADR-0632) would reject anyway.
    await gotoSchedule(page, { search: '?import=csv', role: 1 });

    await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole('dialog', { name: 'Import from a spreadsheet' }),
    ).toBeHidden();
  });
});

/**
 * #2926 — the date-order override on the map step.
 *
 * The preview route here is **stateful in the request**: it reads `date_order`
 * off the multipart body and answers with that reading. A stateless mock that
 * always returned the same dates would let the spec pass while the control sent
 * nothing at all, which is the exact defect the ticket describes — a form field
 * that persists and is echoed while nothing reads it.
 */
const AMBIGUOUS_COLUMNS = [
  { index: 0, header: 'Task', field: 'name', confidence: 'exact' },
  { index: 1, header: 'Start', field: 'planned_start', confidence: 'exact' },
  { index: 2, header: 'Finish', field: 'planned_finish', confidence: 'exact' },
];

/** The issue's own example: valid under both conventions, 3 days or 62. */
function ambiguousPreview(order: string) {
  const dmy = order === 'dmy';
  return {
    ...PREVIEW_BODY,
    headers: ['Task', 'Start', 'Finish'],
    columns: AMBIGUOUS_COLUMNS,
    sample_rows: [['Design', '03/04/2026', '05/04/2026']],
    row_count: 1,
    task_count: 1,
    row_errors: [],
    error_count: 0,
    warning_count: 0,
    available_fields: [
      { field: 'name', label: 'Task name', required: true, multi: false },
      { field: 'planned_start', label: 'Start date', required: false, multi: false },
      { field: 'planned_finish', label: 'Finish date', required: false, multi: false },
    ],
    date_order: order,
    date_order_resolved: dmy ? 'dmy' : 'mdy',
    date_order_auto: 'mdy',
    date_order_ambiguous: order === 'auto',
    date_order_evidence: null,
    date_order_has_columns: true,
    date_order_readings:
      order === 'auto'
        ? [
            {
              order: 'mdy',
              sample_row: 2,
              sample_name: 'Design',
              sample_raw_start: '03/04/2026',
              start: '2026-03-04',
              finish: '2026-05-04',
              duration_days: 62,
              values_matched: 2,
              values_failed: 0,
              rows_unparseable: 0,
            },
            {
              order: 'dmy',
              sample_row: 2,
              sample_name: 'Design',
              sample_raw_start: '03/04/2026',
              start: '2026-04-03',
              finish: '2026-04-05',
              duration_days: 3,
              values_matched: 2,
              values_failed: 0,
              rows_unparseable: 0,
            },
          ]
        : [],
    values_matched: 2,
    values_failed: 0,
    date_preview: [
      {
        row: 2,
        name: 'Design',
        raw_start: '03/04/2026',
        raw_finish: '05/04/2026',
        start: dmy ? '2026-04-03' : '2026-03-04',
        finish: dmy ? '2026-04-05' : '2026-05-04',
        duration_days: dmy ? 3 : 62,
        unreadable: false,
      },
    ],
  };
}

/** Captures what each preview asked for, so the spec can assert the wire too. */
async function routeAmbiguousPreview(page: Page, sent: string[]) {
  await page.route(`**/api/v1/projects/${PROJECT_ID}/import/csv/preview/`, async (r) => {
    // Read the multipart body directly: `postDataJSON()` cannot parse a
    // FormData upload, and the point of this route is to prove the control's
    // value reached the wire rather than to trust the component's own state.
    const body = r.request().postData() ?? '';
    const order = /name="date_order"\r?\n\r?\n([a-z]+)/.exec(body)?.[1] ?? 'auto';
    sent.push(order);
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ambiguousPreview(order)),
    });
  });
}

test.describe('CSV import — date order (#2926)', () => {
  test('an ambiguous file states both readings and the override changes the preview', async ({
    page,
  }) => {
    await gotoSchedule(page);
    const sent: string[] = [];
    await routeAmbiguousPreview(page, sent);
    await openWizard(page);

    const dialog = page.getByRole('dialog', { name: 'Import from a spreadsheet' });
    await page.locator('input[type="file"]').setInputFiles({
      name: 'eu-programme.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Task,Start,Finish\nDesign,03/04/2026,05/04/2026\n'),
    });
    await dialog.getByRole('button', { name: 'Next' }).click();

    // The block announces the coin flip in words, not colour.
    await expect(dialog.getByText('Needs a decision')).toBeVisible();
    await expect(dialog.getByText(/Auto cannot tell/)).toBeVisible();

    // Both readings, with the 59-day difference that makes the choice decidable.
    const readings = dialog.getByRole('table', { name: /read under each convention/i });
    await expect(readings.getByText('62 days')).toBeVisible();
    await expect(readings.getByText('3 days')).toBeVisible();

    // The primary action names the convention it would accept.
    await expect(
      dialog.getByRole('button', { name: 'Confirm M/D/Y and continue' }),
    ).toBeVisible();

    // Scoped to the preview table: the readings table above it carries the same
    // numbers, and an unscoped match is a strict-mode collision between the two.
    const rows = dialog.getByRole('table', { name: /How the first rows/i });
    // Under auto the preview shows the wrong-but-plausible 62-day reading.
    await expect(rows.getByRole('cell', { name: '62 d', exact: true })).toBeVisible();

    // Choose D/M/Y — this is the act the whole ticket adds.
    await dialog.getByRole('radio', { name: 'D/M/Y' }).click();

    await expect(rows.getByRole('cell', { name: '2026-04-03' })).toBeVisible();
    await expect(rows.getByRole('cell', { name: '3 d', exact: true })).toBeVisible();
    await expect(dialog.getByText(/Set by you: D\/M\/Y \(day first\)/)).toBeVisible();
    // The decision is gone from the footer once it has been made.
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeVisible();

    // And the request actually carried it — a field nothing reads is the bug.
    expect(sent).toEqual(['auto', 'dmy']);
  });

  test('a file that identifies itself quotes the value that settled it', async ({ page }) => {
    await gotoSchedule(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/import/csv/preview/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...ambiguousPreview('auto'),
          date_order_resolved: 'dmy',
          date_order_auto: 'dmy',
          date_order_ambiguous: false,
          date_order_readings: [],
          date_order_evidence: {
            row: 14,
            column: 'Start',
            value: '13/04/2026',
            reason: 'no_thirteenth_month',
          },
        }),
      }),
    );
    await openWizard(page);
    await pickFile(page);
    await page
      .getByRole('dialog', { name: 'Import from a spreadsheet' })
      .getByRole('button', { name: 'Next' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Import from a spreadsheet' });
    // Checkable against the file — the whole difference from the notice it replaces.
    await expect(dialog.getByText(/Row 14 is “13\/04\/2026”/)).toBeVisible();
    await expect(dialog.getByText(/there is no 13th month/)).toBeVisible();
    // No decision is demanded of an operator whose file answered the question.
    await expect(dialog.getByText('Needs a decision')).toBeHidden();
  });
});
