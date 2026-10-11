/**
 * E2E for the shared `useFocusTrap` migration (#2148 / #2193 / #4085).
 *
 * A generation of aria-modal dialogs hand-rolled (or omitted) focus handling, so
 * Tab walked out behind the scrim and focus was never restored to the trigger on
 * close (WCAG 2.4.3 / 2.1.2). Those surfaces now share `useFocusTrap`. The hook
 * itself is unit-tested (`hooks/useFocusTrap.test.tsx`) and each dialog has its
 * own component test; this spec is the integration foothold the issue asks for —
 * it drives one representative migrated dialog (the ⌘K command palette) end to
 * end and asserts the three things a real trap must do: seat focus inside on
 * open, keep Tab from escaping, and restore focus to the trigger on close.
 *
 * #4085 (the #2193 class recurring, 14 fresh instances) adds two more
 * representative dialogs below, per #2211's keyboard-journey ask: a
 * single-state confirm (`MoveProgramDialog`, trap container = the scrim) and
 * a multi-state dialog whose body swaps entirely (`PersonalAccessTokensPage`'s
 * create → one-time-reveal dialog), covering both of #4085's migration shapes.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, setupTaskStore } from './fixtures';

/**
 * Walk the whole trap in one direction and assert focus never leaves it (#3208).
 *
 * Deliberately a bounded press-loop rather than "query the tab stops, focus the
 * last one, press Tab once": the query would mean hand-copying
 * `FOCUSABLE_SELECTOR` into this spec, which is the exact duplication #3208
 * exists to delete — and a spec carrying its own copy would keep passing after
 * the shared one regressed. Pressing past the end of the real tab order is what
 * surfaces the bug, and `steps` is sized to exceed either dialog's stop count.
 *
 * **The BACKWARD direction is the load-bearing one.** When the roving members
 * trail the dialog (the CommandPalette shape), a forward-only walk can look
 * clean while the trap's `last` points at an element the tab order never
 * reaches — which is how this regression shipped twice.
 */
async function expectFocusStaysInside(
  page: import('@playwright/test').Page,
  dialog: import('@playwright/test').Locator,
  { steps = 14 }: { steps?: number } = {},
) {
  for (const key of ['Tab', 'Shift+Tab'] as const) {
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press(key);
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `focus escaped the dialog after ${i + 1} x ${key}`).toBe(true);
    }
  }
}

const PROJECT_ID = 'e2e-trap-0000-0000-0000-000000002148';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Focus Trap Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    program_detail: { id: 'trap-prog-1', name: 'Trap Program' },
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
}

test.describe('focus-trap migration (#2148/#2193)', () => {
  test('command palette traps focus and restores it to the trigger on close', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    // Gate on the shell painting before driving keyboard chrome.
    await expect(
      page.getByRole('complementary', { name: 'Primary navigation' }),
    ).toBeVisible({ timeout: 10_000 });

    // Put focus on a stable, identifiable trigger. The skip link is the shell's
    // first focusable element and is always present, so it is a deterministic
    // "previously focused" anchor for the restore assertion.
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await skipLink.focus();
    await expect(skipLink).toBeFocused();

    // Open the palette. The trap captures the trigger (skip link) as the element
    // to restore to, synchronously, before the palette's own input-focus fires.
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();

    // Seat: focus moved into the dialog (onto the search combobox).
    const search = palette.getByRole('combobox');
    await expect(search).toBeFocused();

    // Trap: Tab must not walk focus out behind the scrim — it stays in the dialog.
    await page.keyboard.press('Tab');
    const focusStillInside = await palette.evaluate(
      (el) => el.contains(document.activeElement),
    );
    expect(focusStillInside).toBe(true);

    // Restore: Escape closes and returns focus to the trigger, not <body>.
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
    await expect(skipLink).toBeFocused();
  });

  // #3208. The palette's result rows are `<button role="option" tabIndex={-1}>`
  // roving members and they TRAIL the dialog, so the old selector — which only
  // applied `:not([tabindex="-1"])` to its generic `[tabindex]` branch — counted
  // the last row as the trap's `last`. Nobody can ever be focused there, so the
  // forward wrap branch never fired from the real last stop and Tab walked out.
  test('Tab and Shift+Tab both stay inside the palette despite roving option rows', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    await expect(
      page.getByRole('complementary', { name: 'Primary navigation' }),
    ).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    // Gate on the rows actually being rendered — the roving members are the
    // whole premise, and an empty listbox would make this vacuous.
    await expect(palette.getByRole('option').first()).toBeVisible();

    await expectFocusStaysInside(page, palette);
  });
});

const DEP_PROJECT_ID = 'e2e-trap-dep-0000-0000-000000003208';

function depTaskRow(id: string, wbs: string, name: string) {
  return {
    id,
    wbs_path: wbs,
    name,
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
    linked_risks_count: 0,
    linked_risks_biggest: null,
    linked_risks_max_severity: null,
  };
}

const DEP_TASKS = [depTaskRow('dt1', '1', 'Cutover'), depTaskRow('dt2', '2', 'Power drop')];

/**
 * The picker's scope tabs render only when the project belongs to a program
 * (`canCrossProject = Boolean(programId)`), so this fixture carries one — a
 * program-less project would render no ScopeTabs and make the spec vacuous.
 */
const DEP_PROJECT = {
  id: DEP_PROJECT_ID,
  name: 'Trap Depot',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  program: 'trap-prog-3208',
  program_detail: { id: 'trap-prog-3208', name: 'Trap Program' },
};

const MOVE_PROGRAM_PROJECT_ID = 'e2e-trap-move-0000-0000-000000004085';

const MOVE_PROGRAM_PROJECT = {
  id: MOVE_PROGRAM_PROJECT_ID,
  server_version: 1,
  name: 'Keyboard Trap Migration',
  description: '',
  start_date: '2026-04-01',
  status_date: null,
  prioritization_model: 'none',
  stale_task_threshold_days: 14,
  end_date_shift_threshold_days: 3,
  calendar: 'cal-default',
  calendar_source: 'project',
  effective_calendar: { id: 'cal-default', name: 'Workspace standard', working_days: 31, hours_per_day: 8 },
  estimation_mode: 'open',
  agile_features: false,
  methodology: 'HYBRID',
  code: 'TRAP',
  health: 'ON_TRACK',
  visibility: 'WORKSPACE',
  timezone: 'Europe/London',
  default_view: 'BOARD',
  public_sharing: null,
  allow_guests: null,
  effective_public_sharing: false,
  effective_allow_guests: true,
  inherited_public_sharing: false,
  inherited_allow_guests: true,
  program: null,
  program_detail: null,
};

const MOVE_PROGRAM_PROGRAMS = [
  { id: 'prog-beacon', name: 'Beacon', my_role: 300, is_closed: false },
];

/**
 * Representative dialog #1 of #4085's migration: a confirm-style modal whose
 * trap container IS the full-viewport scrim (`MoveProgramDialog.tsx`) — the
 * common idiom rule 419 describes, safe here because Cancel is never
 * disabled.
 */
test.describe('aria-modal pairing migration — settings MoveProgramDialog (#4085, #2211)', () => {
  test('Tab and Shift+Tab both stay inside the dialog', async ({ page }) => {
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
    await setupCatchAll(page);
    await page.route('**/api/v1/auth/me/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ id: 'u-alice', username: 'alice', display_name: 'Alice', initials: 'AL', email: 'alice@example.com' }),
      }),
    );
    await page.route('**/api/v1/edition/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
    );
    await page.route('**/api/v1/programs/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ results: MOVE_PROGRAM_PROGRAMS, count: MOVE_PROGRAM_PROGRAMS.length, next: null, previous: null }),
      }),
    );
    await page.route('**/api/v1/projects/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ results: [MOVE_PROGRAM_PROJECT], count: 1, next: null, previous: null }),
      }),
    );
    await page.route(`**/api/v1/projects/${MOVE_PROGRAM_PROJECT_ID}/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(MOVE_PROGRAM_PROJECT) }),
    );
    await page.route(`**/api/v1/projects/${MOVE_PROGRAM_PROJECT_ID}/members/**`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj([{ id: 'membership-self', role: 300 }]) }),
    );

    await page.goto(`/projects/${MOVE_PROGRAM_PROJECT_ID}/settings/general`);
    const section = page.locator('[data-settings-section="general"]');
    await expect(section.getByRole('heading', { name: 'General' })).toBeVisible({ timeout: 10_000 });
    await section.getByRole('button', { name: /add to program/i }).click();

    const dialog = page.getByRole('dialog', { name: 'Move to a program' });
    await expect(dialog).toBeVisible();
    // Seat: Cancel is first in DOM order and gets initial focus.
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await expectFocusStaysInside(page, dialog);
  });
});

const PAT_ME = {
  id: 'u-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

/**
 * Representative dialog #2 of #4085's migration: a multi-state dialog
 * (`PersonalAccessTokensPage.tsx`'s `CreateTokenDialog`) that swaps its whole
 * body from a create form to a one-time reveal — the `focusKey` re-seat case
 * rule 245/362 describe, distinct from dialog #1's single-state shape above.
 */
test.describe('aria-modal pairing migration — PersonalAccessTokensPage create dialog (#4085, #2211)', () => {
  test('Tab and Shift+Tab both stay inside the dialog, across the create→reveal state swap', async ({
    page,
  }) => {
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
    await setupCatchAll(page);
    await page.route('**/api/v1/auth/me/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(PAT_ME) }),
    );
    await page.route('**/api/v1/me/work/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj({ count: 0, next: null, previous: null, results: [] }) }),
    );
    await page.route('**/api/v1/me/api-tokens/', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: pj({
            id: 'tok-new',
            name: 'CI token',
            token: 'tppm_the_only_reveal_0123456789abcdef',
            token_prefix: 'tppm_abc',
            scopes: ['legacy:full'],
            created_at: '2026-06-01T00:00:00Z',
            last_used_at: null,
            expires_at: null,
            revoked_at: null,
            is_revoked: false,
            is_expired: false,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ count: 0, next: null, previous: null, results: [] }),
      });
    });

    await page.goto('/me/settings/api-tokens');
    await expect(page.getByRole('heading', { name: 'Personal access tokens' })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Create token' }).click();

    const dialog = page.getByRole('dialog', { name: /Create personal access token/i });
    await expect(dialog).toBeVisible();
    // Seat: the Name field is first in DOM order and gets initial focus.
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await expectFocusStaysInside(page, dialog, { steps: 6 });

    // Swap state: create → one-time reveal. The trap's `focusKey` must
    // re-seat into the new content, and the trap must still hold.
    await dialog.getByLabel('Name').fill('CI token');
    await dialog.getByRole('button', { name: 'Create token' }).click();
    await expect(page.getByText(/only time you.*see this token/i)).toBeVisible();
    // The reveal swaps the dialog's accessible name too (#4085's
    // `aria-labelledby` fix keeps it POINTING at a real heading across the
    // swap, but that heading's own text is now "Token created…", not
    // "Create personal access token") — re-locate by role alone; only one
    // dialog is ever on the page.
    const revealedDialog = page.getByRole('dialog');
    await expectFocusStaysInside(page, revealedDialog, { steps: 4 });
  });
});

test.describe('dependency picker focus trap (#3208)', () => {
  // A LATENT-instance guard, not a reproduction — and the distinction is
  // measured, not assumed. #3208 listed this dialog as a live Shift+Tab escape;
  // it is not. The header's Close button is a real tab stop and precedes the
  // tablist, so the roving ScopeTabs are never the trap's `first` and this spec
  // passes on the broken selector too (negative-control verified). What saves it
  // is DOM order alone, which is exactly what #3130 proved expires on the next
  // reorder, so the walk stays. The live instance is the palette case above.
  test('Shift+Tab stays inside the dialog despite roving scope tabs', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [DEP_PROJECT],
      projectId: DEP_PROJECT_ID,
      tasks: DEP_TASKS,
    });
    await setupTaskStore(page, { tasks: DEP_TASKS });

    await page.goto(`/projects/${DEP_PROJECT_ID}/schedule`);
    await expect(page.getByText('Cutover')).toBeVisible({ timeout: 10_000 });
    await page.getByText('Cutover').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Row actions' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /Add dependency/ }).click();

    const dialog = page.getByRole('dialog', { name: /Add dependency/ });
    await expect(dialog).toBeVisible();
    // Gate on the roving tabs existing — they are the premise of this spec.
    await expect(dialog.getByRole('tab')).toHaveCount(2);

    await expectFocusStaysInside(page, dialog);
  });
});
