/**
 * Read-only demo: the announcement, the refusal, and the preview that outlives it
 * (ADR-1197 D3/D4, #3926).
 *
 * Three surfaces, one deployment fact (`demo_read_only` on `/edition/`):
 *  - the login screen announces the mode and publishes the shared credential;
 *  - the shell carries a persistent indicator;
 *  - a refused write gets the mode's own affordance, and a refused *date* write
 *    leaves the bar where the visitor put it.
 *
 * The commit gesture driven here is the **keyboard** reschedule (`r` → arrow →
 * Enter), for the reason `schedule-preview-overlay.spec.ts` gives: a
 * canvas-coordinate mouse drag is not a stable e2e gesture. The popover's own
 * terminal state is covered branch-by-branch in `ScheduleCommitPopover.test.tsx`
 * and `useScheduleCommit.test.tsx`; what only an e2e can prove is that the dropped
 * date survives the app's own refetch loop, which is what this spec asserts.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

const FIXTURE_PROJECT_ID = 'e2e-demo-00000000-0000-0000-0000-000000003926';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const DEMO_HINT = { username: 'demo@trueppm.com', password: 'trueppm-demo' };

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Read-only Demo Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

/** The one task the refusal path nudges. Starts Apr 6; `ArrowRight` moves it to Apr 7. */
const FIXTURE_TASKS = [
  {
    id: 'demo-tk1',
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    planned_start: '2026-04-06',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

const DEMO_403 = {
  status: 403,
  contentType: 'application/json',
  body: JSON.stringify({
    detail: 'This is a read-only demo. Your change was not saved.',
    code: 'demo_read_only',
  }),
};

const PLAIN_403 = {
  status: 403,
  contentType: 'application/json',
  body: JSON.stringify({ detail: 'You do not have permission to perform this action.' }),
};

/**
 * Refuse every task PATCH with `body`, leaving every other task request to the
 * stateful store registered before this. Playwright matches routes in reverse
 * registration order, so this must be registered LAST.
 */
async function refuseTaskWrites(
  page: import('@playwright/test').Page,
  body: typeof DEMO_403,
): Promise<{ count: () => number }> {
  let count = 0;
  await page.route(/\/api\/v1\/tasks\/[^/]+\/$/, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    count += 1;
    return route.fulfill(body);
  });
  return { count: () => count };
}

/** Focus the bar, enter reschedule mode, nudge one day, commit. */
async function keyboardNudge(page: import('@playwright/test').Page): Promise<void> {
  // Focus, don't click: the ARIA overlay is pointer-events-none by design (rule 27).
  await page.getByRole('option', { name: /Foundation/ }).focus();
  await page.keyboard.press('r');
  await expect(page.getByTestId('preview-overlay')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
}

test.describe('Read-only demo — login announcement (ADR-1197 D3)', () => {
  test.beforeEach(async ({ page }) => {
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
      demoReadOnly: true,
      demoLoginHint: DEMO_HINT,
    });
  });

  test('announces the mode, publishes the credential, and fills without submitting', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/login');

    // The marketing-panel note (md and up). The heading pairs the decorative ◆ with
    // the words in one node, so it is matched as that whole line.
    await expect(page.getByText(/^◆\s*Read-only demo$/)).toBeVisible();
    await expect(
      page.getByText(
        'The Schedule is the only interactive part of this demo — drag a task and watch the critical path recompute live in your browser. Nothing you do here is saved.',
      ),
    ).toBeVisible();
    // One shared login, so no collaboration to see — and where to go instead (#3998).
    await expect(page.getByText(/Everyone shares this one login/)).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Installation guide (opens in a new tab)' }),
    ).toHaveAttribute('href', 'https://docs.trueppm.com/getting-started/installation/');
    await expect(page.getByText(/Rate limits are lifted for this demo account/)).toBeVisible();

    // The credential block inside the form.
    await expect(
      page.getByText(
        'Read-only demo — sign in with the shared account below. Nothing you change is saved.',
      ),
    ).toBeVisible();
    await expect(page.getByText(DEMO_HINT.username)).toBeVisible();
    await expect(page.getByText(DEMO_HINT.password)).toBeVisible();

    await page.getByRole('button', { name: 'Fill in the demo email and password' }).click();

    // `getByRole('textbox')` and not `getByLabel`: the Fill button's accessible name
    // also carries the word "email".
    await expect(page.getByRole('textbox', { name: 'Email' })).toHaveValue(DEMO_HINT.username);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(DEMO_HINT.password);
    // Fill must never sign the visitor in — the decision to proceed stays theirs.
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByText('Demo credentials filled in. Select Sign in to continue.'),
    ).toBeVisible();
  });

  test('renders no credential block on a normal install', async ({ page }) => {
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText(/^◆\s*Read-only demo$/)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Fill in the demo email and password' }),
    ).toHaveCount(0);
  });
});

test.describe('Read-only demo — the refusal and the preview (ADR-1197 D3/D4)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
      demoReadOnly: true,
      demoLoginHint: DEMO_HINT,
    });
    // Stateful reads (web CLAUDE.md): the server never accepted the write, so every
    // refetch must keep serving the ORIGINAL dates. A stateless list mock would serve
    // them too — but this one proves it can't be an accident of ordering.
    await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('the shell carries the persistent indicator', async ({ page }) => {
    await page.goto(BASE_URL);
    const bar = page.getByRole('complementary', { name: 'Demo mode' });
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Read-only demo — nothing you change here is saved.');
  });

  test('a refused write gets the mode toast, and the dropped date outlives the refetch', async ({
    page,
  }) => {
    const refusals = await refuseTaskWrites(page, DEMO_403);
    await page.goto(BASE_URL);
    await expect(page.getByRole('option', { name: /Foundation/ })).toBeVisible();

    await keyboardNudge(page);
    await expect.poll(() => refusals.count()).toBeGreaterThan(0);

    // Tier 2 affordance: an info toast, not a red error.
    await expect(page.getByTestId('toast-pill')).toContainText(
      "Read-only demo — that change wasn't saved.",
    );

    // D4 — the load-bearing assertion. `expect.poll` across several seconds spans the
    // 30 s fallback refetch window's early ticks AND the mutation's own rollback; a
    // single `toBeVisible()` would pass on the optimistic frame alone, whether or not
    // the overlay exists at all.
    const option = page.getByRole('option', { name: /Foundation/ });
    await expect
      .poll(async () => option.getAttribute('aria-label'), { timeout: 8000, intervals: [500] })
      .toContain('starts Apr 7');
    // …and it is still there a moment later, not a frame that happened to be caught.
    await page.waitForTimeout(1500);
    await expect(option).toHaveAttribute('aria-label', /starts Apr 7/);

    // A full page reload is the mode's own reset: nothing was persisted, so the
    // server's original date comes back.
    await page.reload();
    await expect(page.getByRole('option', { name: /Foundation/ })).toHaveAttribute(
      'aria-label',
      /starts Apr 6/,
    );
  });

  test('a second refusal replaces the pill rather than stacking a new one', async ({ page }) => {
    await refuseTaskWrites(page, DEMO_403);
    await page.goto(BASE_URL);
    await expect(page.getByRole('option', { name: /Foundation/ })).toBeVisible();

    await keyboardNudge(page);
    await expect(page.getByTestId('toast-pill')).toHaveCount(1);
    await keyboardNudge(page);

    // The transient slot is structural (#3149): a repeat refusal can only ever
    // occupy the one pill, never open a second.
    await expect(page.getByTestId('toast-pill')).toHaveCount(1);
    await expect(page.getByTestId('toast-pill')).toContainText(
      "Read-only demo — that change wasn't saved.",
    );
  });
});

test.describe('Read-only demo — sample project indicator hides its link (#4049)', () => {
  // Self-contained: its own fixture project and its own beforeEach, so this block
  // stays a small, isolated addition alongside the other demo-read-only cases.
  const SAMPLE_PROJECT_ID = 'e2e-demo-00000000-0000-0000-0000-000000004049';
  const SAMPLE_PROJECTS = [
    {
      id: SAMPLE_PROJECT_ID,
      name: 'Sample Demo Project',
      description: '',
      start_date: '2026-04-01',
      calendar: 'default',
      is_sample: true,
      program_detail: { id: 'prog-4049', name: 'Atlas Platform Launch', sample_days_stale: null },
    },
  ];

  test('the "Manage demo data" link is hidden, not just inert, for the read-only visitor', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: SAMPLE_PROJECTS,
      projectId: SAMPLE_PROJECT_ID,
      tasks: [],
      demoReadOnly: true,
      demoLoginHint: DEMO_HINT,
    });
    await setupTaskStore(page, { tasks: [] });
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`/projects/${SAMPLE_PROJECT_ID}/schedule`);
    const sampleBar = page.getByRole('note', { name: 'This is sample data' });
    await expect(sampleBar).toBeVisible();
    await expect(sampleBar).toContainText('Atlas Platform Launch');
    await expect(sampleBar.getByRole('link', { name: /manage demo data/i })).toHaveCount(0);
  });
});

test.describe('Read-only demo — negative control', () => {
  test('an ordinary 403 on a normal install shows the usual refusal, not the demo one', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
      // demoReadOnly defaults to false — this is a real install.
    });
    await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    await page.setViewportSize({ width: 1280, height: 800 });

    const refusals = await refuseTaskWrites(page, PLAIN_403);
    await page.goto(BASE_URL);
    await expect(page.getByRole('option', { name: /Foundation/ })).toBeVisible();

    // No mode indicator anywhere.
    await expect(page.getByRole('complementary', { name: 'Demo mode' })).toHaveCount(0);

    await keyboardNudge(page);
    await expect.poll(() => refusals.count()).toBeGreaterThan(0);

    // The server's own sentence, through the ordinary refusal path…
    await expect(
      page.getByText('You do not have permission to perform this action.').first(),
    ).toBeVisible();
    // …and never the demo copy.
    await expect(page.getByText("Read-only demo — that change wasn't saved.")).toHaveCount(0);
    // The bar snaps back to the server's date: no overlay is written on a real install.
    await expect(page.getByRole('option', { name: /Foundation/ })).toHaveAttribute(
      'aria-label',
      /starts Apr 6/,
    );
  });
});
