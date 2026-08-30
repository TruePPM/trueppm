import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

/**
 * The commit moment (#3129) — `draft ──Commit plan──▶ baseline v1`.
 *
 * Covers the golden path and the 409 double-commit path, which is not an exotic
 * error case here: `POST /commit/` is the only legal `draft -> active` transition
 * (#3127 made `lifecycle` read-only), and two admins on the same project is the
 * ordinary way a second click happens.
 *
 * **The project-detail mock is stateful on purpose.** `useCommitProject` invalidates
 * `['project', id]` in `onSuccess`, so the app refetches the detail immediately after
 * committing. A stateless mock would re-serve `lifecycle: 'draft'` and the Commit
 * button would reappear — and the spec would then be asserting against a state the
 * product never actually reaches. This is the same defect class as the stateless task
 * list mock that made `schedule-owner-token.spec.ts` flake (#2752): the write exists
 * only in the window before the refetch lands, so a loaded runner fails and a quiet one
 * passes. Raising the timeout would not fix it — after the refetch the state is gone.
 */

const PROJECT_ID = 'e2e-commit-00000000-0000-0000-0000-000000003129';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Commit Test Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  health: 'AUTO',
};

const FIXTURE_OVERVIEW = {
  schedule_health: 'on_track',
  spi: 0.97,
  tasks_late_count: 0,
  critical_task_count: 3,
  total_tasks: 12,
  complete_tasks: 4,
  next_milestone: null,
  team_utilization_pct: 78,
  owner_name: 'Alice Smith',
  start_date: '2026-01-01',
  open_risk_count: 0,
  high_risk_count: 0,
  risk_premium_state: 'none',
  risk_premium_days: null,
  risk_premium_ratio: null,
  risk_premium_band: null,
  risk_premium_as_of: null,
  risk_premium_reason: null,
  risk_premium_cpm_finish: null,
  risk_premium_p80: null,
};

interface CommitState {
  /** Flipped by the /commit/ route so the detail refetch echoes the write. */
  lifecycle: 'draft' | 'active';
  commitCalls: number;
  /** When set, /commit/ answers this instead of succeeding. */
  refuse409: boolean;
  /** When set, /commit/ answers 500 — the path that leaves the sheet OPEN. */
  fail500: boolean;
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function setupRoutes(
  page: Page,
  opts: { role: number; refuse409?: boolean; fail500?: boolean },
) {
  const state: CommitState = {
    lifecycle: 'draft',
    commitCalls: 0,
    refuse409: opts.refuse409 ?? false,
    fail500: opts.fail500 ?? false,
  };

  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Catch-all FIRST so an unmocked endpoint returns a typed 404 instead of falling
  // through and 401ing, which trips the token-refresh session teardown and races the
  // page render (#2366). Playwright resolves routes in reverse registration order, so
  // everything registered below wins over this.
  await setupCatchAll(page);

  // Anchor the auth paths: any unmocked 401 → refresh → second 401 → expireSession()
  // overlays a "session expired" modal, and these tests are interactive enough to lose
  // that race.
  await page.route('**/api/v1/auth/me/', (route: Route) =>
    route.fulfill(
      json({
        id: 'e2e-user',
        email: 'e2e@trueppm.local',
        username: 'e2e',
        first_name: 'E2E',
        last_name: 'User',
        is_active: true,
      }),
    ),
  );
  await page.route('**/api/v1/auth/token/refresh/', (route: Route) =>
    route.fulfill(json({ access: 'e2e-token-refreshed' })),
  );

  // Stateful project detail — serves whatever the commit route last wrote.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route: Route) =>
    route.fulfill(json({ ...FIXTURE_PROJECT, lifecycle: state.lifecycle })),
  );

  await page.route(`**/api/v1/projects/${PROJECT_ID}/commit/`, async (route: Route) => {
    state.commitCalls += 1;
    if (state.fail500) {
      await route.fulfill(json({ detail: 'Server error.' }, 500));
      return;
    }
    if (state.refuse409 || state.lifecycle === 'active') {
      await route.fulfill(
        json({ detail: 'This plan has already been committed.', code: 'already_committed' }, 409),
      );
      return;
    }
    state.lifecycle = 'active';
    await route.fulfill(
      json({
        baseline_id: 'b-3129',
        baseline_name: 'Baseline v1',
        task_count: 12,
        assigned_resource_count: 4,
      }),
    );
  });

  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route: Route) =>
    route.fulfill(json([{ id: 'self', role: opts.role }])),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route: Route) =>
    route.fulfill(json(FIXTURE_OVERVIEW)),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route: Route) =>
    route.fulfill(json({ items: [] })),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route: Route) =>
    route.fulfill(json({ tasks: [] })),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprint-forecast/`, (route: Route) =>
    route.fulfill(json({ status: 'insufficient_data', remaining_points: 0, sample_count: 0 })),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route: Route) =>
    route.fulfill(
      json({
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
    ),
  );
  await page.route('**/api/v1/projects/*/presence/', (route: Route) => route.fulfill(json([])));
  await page.route('**/api/v1/projects/*/monte-carlo/latest/', (route: Route) =>
    route.fulfill(json({ detail: 'No simulation result available.' }, 404)),
  );
  await page.route('**/api/v1/projects/', (route: Route) =>
    route.fulfill(json({ count: 1, next: null, previous: null, results: [FIXTURE_PROJECT] })),
  );
  // Object-shaped and list endpoints the page's hooks read. Never lean on a catch-all
  // for these: a `{count:0,results:[]}` body served for an object endpoint is truthy
  // but malformed, and the component that destructures it throws into the root error
  // boundary — which surfaces later as an unrelated flaky click, not a missing mock.
  await page.route('**/api/v1/tasks/**', (route: Route) =>
    route.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/dependencies/**', (route: Route) =>
    route.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );

  return state;
}

/** Exact name — a substring match would also bind the dialog's confirm button. */
const commitButton = (page: Page) => page.getByRole('button', { name: 'Commit plan', exact: true });

async function gotoOverview(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/overview`);
  // Gate on a "page rendered" signal before touching header chrome — the header only
  // mounts once the overview query resolves, and clicking before that races a remount.
  await expect(
    page.getByRole('region', { name: /holding steady|needs attention|project health/i }).first(),
  ).toBeVisible({ timeout: 10_000 });
}

test.describe('Commit plan (#3129)', () => {
  test('admin commits a draft: confirm sheet states the Amend change, then the plan goes active', async ({
    page,
  }) => {
    const state = await setupRoutes(page, { role: 300 });
    await gotoOverview(page);

    const pill = page.getByLabel('Project lifecycle: Draft');
    await expect(pill).toBeVisible();
    // Rendered text, never the attribute alone (rule 328b) — and the consequence line
    // must carry the whole list, My Work included; it lived only in a bare `title`
    // until this review, which is unreachable on touch and to keyboard focus (287).
    await expect(pill).toHaveText('Draft');
    await expect(
      page.getByText(/A draft is held out of .*My Work until the plan is committed\./),
    ).toBeVisible();
    await expect(pill).not.toHaveAttribute('title', /./);
    await commitButton(page).click();

    const dialog = page.getByRole('dialog', { name: /commit this plan/i });
    await expect(dialog).toBeVisible();
    // Both halves UX-REVIEW §4 requires: what commit does, AND that Author becomes
    // Amend — the half that explains why this is a one-way door rather than a save.
    await expect(dialog.getByText(/Baseline v1/)).toBeVisible();
    await expect(dialog.getByText(/amending/i)).toBeVisible();
    await expect(dialog.getByText(/cannot un-commit/i)).toBeVisible();
    // Assert the capability, not the retired wording (rule 308d): nothing here may
    // promise a reason prompt (`amend_reason` has no client sender; #3150 owns it) or
    // a notification on commit (`commit_project()` writes no notification row).
    await expect(dialog.getByText(/carries a reason|reason for the change/i)).toHaveCount(0);
    await expect(dialog.getByText(/notif|the team is told/i)).toHaveCount(0);
    // #3150 owns the second exit; offering only a re-baseline here teaches slip laundering.
    await expect(dialog.getByText(/re-baseline|keep v1|let variance stand/i)).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Commit plan' }).click();

    await expect(page.getByText(/Plan committed — Baseline v1 captured/)).toBeVisible();
    await expect(dialog).toBeHidden();
    expect(state.commitCalls).toBe(1);

    // The stateful detail mock now serves `active`, so the draft affordances must be
    // gone after the invalidation refetch — not merely gone for a moment.
    await expect(page.getByLabel('Project lifecycle: Draft')).toHaveCount(0);
    await expect(commitButton(page)).toHaveCount(0);

    // The focus trap restores its trigger — but that trigger just unmounted with the
    // draft state, so the restore lands on a detached node and focus falls to <body>,
    // the top of the document, immediately after the one action the user came for
    // (rule 206's unmounting-trigger clause, WCAG 2.4.3). It must be seated on the
    // neighbour that survives the flip instead.
    await expect(page.getByRole('button', { name: 'Update Status' })).toBeFocused();
  });

  test('a 409 double-commit says so and retires the button instead of offering a retry', async ({
    page,
  }) => {
    // Someone else committed while this sheet was open. Retrying can never succeed —
    // commit_project() refuses a non-draft project by design — so the copy must not
    // say "try again", and the affordance must not survive.
    const state = await setupRoutes(page, { role: 300, refuse409: true });
    await gotoOverview(page);

    await commitButton(page).click();
    const dialog = page.getByRole('dialog', { name: /commit this plan/i });
    await dialog.getByRole('button', { name: 'Commit plan' }).click();

    await expect(page.getByText('This plan has already been committed.')).toBeVisible();
    await expect(page.getByText(/try again/i)).toHaveCount(0);
    await expect(dialog).toBeHidden();
    expect(state.commitCalls).toBe(1);
  });

  test('a failed commit leaves the sheet open WITH focus still trapped inside it', async ({
    page,
  }) => {
    // The one error path that keeps the sheet mounted, and therefore the one where a
    // focus leak is reachable. While the POST is in flight both buttons go `disabled`,
    // so `useFocusTrap`'s focusable set is momentarily empty and the browser drops
    // focus to <body>. Nothing re-seats it unless the pending state is passed as the
    // trap's `focusKey` — and once focus is outside, `document.activeElement` is
    // neither the first nor the last focusable, so the Tab handler stops intercepting
    // and Tab walks into the page behind the scrim. That is an `aria-modal="true"`
    // surface the keyboard can leave (rule 245a, WCAG 2.4.3 / 2.1.2).
    await setupRoutes(page, { role: 300, fail500: true });
    await gotoOverview(page);

    await commitButton(page).click();
    const dialog = page.getByRole('dialog', { name: /commit this plan/i });
    await dialog.getByRole('button', { name: 'Commit plan' }).click();

    await expect(page.getByText(/Couldn't commit the plan/)).toBeVisible();
    await expect(dialog).toBeVisible();

    // Focus survived the disabled phase, and Tab keeps it inside.
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Commit plan' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  });

  test('a Scheduler sees the Draft state but is not offered the act', async ({ page }) => {
    // The boundary #3129 moved: ADR-0773 excludes Scheduler from "Publish / commit the
    // plan", and the endpoint enforced one band lower until this issue. The pill still
    // renders — knowing the plan is not agreed to is not a privileged fact.
    await setupRoutes(page, { role: 200 });
    await gotoOverview(page);

    await expect(page.getByLabel('Project lifecycle: Draft')).toBeVisible();
    await expect(commitButton(page)).toHaveCount(0);
  });
});
