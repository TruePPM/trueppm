import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * #1179 — context-aware "+ New" in the v2 unified shell bar (ADR-0131). Golden path:
 * create from two distinct contexts — the menu context (Schedule → New ▾ → Milestone,
 * opening the task/milestone modal) and a single-button context on a different create
 * flow (Program → New project, opening the project modal). The per-route Task/Story
 * dispatch + RBAC gating are covered exhaustively in the CreateMenu vitest spec.
 */

const PID = 'e2e-1179-0000-0000-0000-000000000001';
const GID = 'e2e-1179-0000-0000-0000-0000000000aa';
const BASE = `/projects/${PID}`;

const PROJECT_DETAIL = {
  id: PID, name: 'Create Affordance Project', description: '', start_date: '2026-01-01',
  calendar: 'default', estimation_mode: 'OPEN', agile_features: true, methodology: 'HYBRID',
  code: '', health: 'AUTO', visibility: 'WORKSPACE', timezone: '', default_view: 'BOARD',
  lead: null, lead_detail: null, iteration_label: 'Sprint', is_archived: false, archived_at: null,
  archived_by: null, recalculated_at: null, is_sample: false, program_detail: null, server_version: 1,
  // The Schedule's authoring gate since #3034 (ADR-0773 §(d)) — this spec builds
  // its own project route, so it carries the field itself.
  can_author: true,
};

const pj = (b: unknown) => JSON.stringify(b);
const page200 = { count: 0, next: null, previous: null, results: [] };

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({ state: { accessToken: 'e2e', refreshToken: 'r', isAuthenticated: true }, version: 0 }),
    );
  });
  // Catch-all FIRST (Playwright: later routes win) so no unmocked /api request 401s —
  // a 401 trips the session-expired modal in this preview env. Auth endpoints get
  // explicit success shapes so the bootstrap never declares the session expired.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200 body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/token/refresh/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj({ access: 'e2e-access' }) }));
  await page.route('**/api/v1/auth/me/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj({ id: 1, username: 'e2e', email: 'e2e@example.com', workspace_role: 300 }) }));
  await page.route('**/api/v1/me/notifications/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj({ count: 0, next: null, previous: null, results: [] }) }));

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }) }),
  );
  await page.route(`**/api/v1/projects/${PID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(PROJECT_DETAIL) }),
  );
  // useCurrentUserRole reads members/?self=true → [{ role }]; ADMIN (300) so create gates pass.
  await page.route(`**/api/v1/projects/${PID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([{ id: 'm1', role: 300 }]) }),
  );
  await page.route(`**/api/v1/projects/${PID}/overview/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }) }),
  );
  await page.route(`**/api/v1/projects/${PID}/board-config/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ columns: [
      { status: 'BACKLOG', label: 'Backlog', visible: true },
      { status: 'NOT_STARTED', label: 'To Do', visible: true },
      { status: 'IN_PROGRESS', label: 'In Progress', visible: true },
      { status: 'REVIEW', label: 'Review', visible: true },
      { status: 'COMPLETE', label: 'Done', visible: true },
    ] }) }),
  );
  // Broad empty stubs so the views (and the TaskFormModal's dependent queries) don't
  // hit the live network. The "+ New" lives in the chrome, independent of view data.
  for (const path of ['tasks', 'dependencies', 'sprints', 'risks', 'attention', 'my-tasks', 'resource-allocation', 'status-summary', 'presence', 'velocity', 'monte-carlo/latest']) {
    await page.route(`**/api/v1/projects/${PID}/${path}/**`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) }),
    );
  }
  await page.route('**/api/v1/projects/*/presence/', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }));
  await page.route('**/api/v1/tasks/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) }));
  await page.route('**/api/v1/dependencies/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) }));

  // Program detail — my_role ADMIN (300) so the program "New project" target is allowed.
  // Registered after the catch-all so this specific shape (with my_role) wins.
  await page.route(`**/api/v1/programs/${GID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ id: GID, name: 'Delivery Program', description: '', my_role: 300, project_count: 1, color: null, code: '', server_version: 1 }) }),
  );
  // Program list — feeds NewProjectModal's step-1 program picker (#2673). Same ADMIN
  // role as the detail route above, and open (not closed), so `Delivery Program` is a
  // legal picker option per the RBAC filter (ADR-0070).
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        count: 1,
        next: null,
        previous: null,
        results: [
          { id: GID, name: 'Delivery Program', code: '', my_role: 300, is_closed: false },
        ],
      }),
    }),
  );
  // Program rollup — ProgramOverviewPage reads this and does `Object.entries(rollup.kpis)`.
  // Without an explicit mock the catch-all returns the list shape `{count, results}` (truthy,
  // but no `kpis`), so `Object.entries(undefined)` throws and the root error boundary replaces
  // the whole shell — detaching the shell-bar button mid-click. That was the #1190 flake.
  await page.route(`**/api/v1/programs/${GID}/rollup/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ aggregation_policy: 'worst', policy_available: true, project_count: 1, program_health: 'unknown', kpis: {} }) }),
  );
}

test.describe('#1179 context-aware "+ New" (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('Schedule context → the "New" menu offers Milestone, which opens the milestone modal', async ({ page }) => {
    await page.goto(`${BASE}/schedule`);
    await page.getByRole('button', { name: 'Create new' }).click();
    // force: the menu is correctly open; the Schedule canvas repaints underneath it,
    // so Playwright's animation-stability gate never settles. The click is valid.
    await page.getByRole('menuitem', { name: 'milestone' }).click({ force: true });
    await expect(page.getByRole('dialog', { name: /new milestone/i })).toBeVisible();
  });

  test('Program context → a single "New project" button opens the project create modal', async ({ page }) => {
    await page.goto(`/programs/${GID}/overview`);
    // Wait for the overview to finish rendering before clicking the shell-bar control.
    // The program <h1> renders only after /programs/:id/ (+ its rollup) resolve, so it is a
    // reliable "page loaded without crashing" signal — clicking before then races the
    // bootstrap and was the #1190 detach flake.
    await expect(page.getByRole('heading', { name: 'Delivery Program' })).toBeVisible();
    // exact:true so this matches the shell-bar control, not the Sidebar's "+ New project".
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /new project/i });
    await expect(dialog).toBeVisible();
    // #2666: this entry point used to silently drop the resolved program's name — the
    // dialog gave no clue which program the project would attach to. #2673 turned that
    // static field into a picker (a native <select>) preselected to the route-inferred
    // program — assert its value/selected option rather than visible text, since an
    // <option>'s text is present in the DOM but not "visible" while the select is closed.
    const programPicker = dialog.getByRole('combobox', { name: /^program$/i });
    await expect(programPicker).toHaveValue(GID);
    await expect(programPicker.locator('option:checked')).toHaveText('Delivery Program');
  });

  test('Start sheet → the way in leads, the working calendar and the commit note sit in the footer (#3130)', async ({
    page,
  }) => {
    await page.goto(`/programs/${GID}/overview`);
    await expect(page.getByRole('heading', { name: 'Delivery Program' })).toBeVisible();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /new project/i });
    await expect(dialog).toBeVisible();

    // Laid out top-to-bottom, not just present in the DOM — the defect this fixes
    // was purely one of *position*, so a presence assertion could not have caught
    // it. Compare rendered y positions, which is what the reader actually sees.
    const ways = dialog.getByRole('radiogroup', { name: /start from/i });
    const nameField = dialog.getByRole('textbox', { name: /^name/i });
    const calendar = dialog.getByRole('combobox', { name: /working calendar/i });
    await expect(ways).toBeVisible();
    await expect(calendar).toBeVisible();

    const [waysBox, nameBox, calendarBox] = await Promise.all([
      ways.boundingBox(),
      nameField.boundingBox(),
      calendar.boundingBox(),
    ]);
    expect(waysBox).not.toBeNull();
    expect(nameBox).not.toBeNull();
    expect(calendarBox).not.toBeNull();
    expect(waysBox!.y).toBeLessThan(nameBox!.y);
    expect(nameBox!.y).toBeLessThan(calendarBox!.y);

    // The commit note states create-on-submit, which is what this sheet does — the
    // design handoff's "Nothing is created until you open the designer" describes a
    // draft lifecycle the web app cannot leave until #3129, so it must not ship.
    const submit = dialog.getByRole('button', { name: /^create project$/i });
    await expect(
      dialog.getByText(/nothing is created until you press create project\./i),
    ).toBeVisible();
    await expect(dialog.getByText(/open the designer/i)).toHaveCount(0);
    // The note is the button's description, never part of its accessible name.
    const noteId = await submit.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    await expect(dialog.locator(`#${noteId!}`)).toContainText(/nothing is created/i);

    // Switching the way renames the commit, and the note follows it.
    await dialog.getByRole('radio', { name: /^import/i }).click();
    await expect(
      dialog.getByText(/nothing is created until you press create & import spreadsheet\./i),
    ).toBeVisible();
  });

  test('Start sheet → Enter submits from the relocated calendar field (#3130)', async ({ page }) => {
    // The calendar now sits outside the <form> subtree, in the pinned footer, and
    // is held in the form by `form="new-project-form"`. Implicit submission is a
    // browser behavior jsdom does not implement for a <select>, so this is the
    // only layer that can prove the wiring works rather than merely being present.
    await page.route('**/api/v1/projects/', (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: pj({ detail: 'Internal server error' }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }),
      });
    });

    await page.goto(`/programs/${GID}/overview`);
    await expect(page.getByRole('heading', { name: 'Delivery Program' })).toBeVisible();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /new project/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: /^name/i }).fill('Enter from the calendar');

    const post = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().includes('/api/v1/projects/'),
    );
    await dialog.getByRole('combobox', { name: /working calendar/i }).focus();
    await page.keyboard.press('Enter');
    await post;
    // The 500 keeps the sheet open, so the assertion is about the submit having
    // happened at all rather than about where it navigated.
    await expect(dialog.getByRole('alert')).toHaveText(/failed to create project/i);
  });

  test('Program context → the picker can be changed to standalone, creating a project with no program (#2673)', async ({ page }) => {
    let capturedBody: Record<string, unknown> | null = null;
    const NEW_PROJECT_ID = 'e2e-2673-new-standalone-0001';

    await page.route('**/api/v1/projects/', (r) => {
      if (r.request().method() === 'POST') {
        capturedBody = r.request().postDataJSON() as Record<string, unknown>;
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: pj({
            id: NEW_PROJECT_ID,
            server_version: 1,
            name: capturedBody.name,
            description: capturedBody.description ?? '',
            start_date: capturedBody.start_date,
            calendar: null,
            methodology: capturedBody.methodology ?? 'HYBRID',
            program: capturedBody.program ?? null,
          }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }),
      });
    });
    await page.route(`**/api/v1/projects/${NEW_PROJECT_ID}/**`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...PROJECT_DETAIL, id: NEW_PROJECT_ID, name: 'Now Standalone', program_detail: null }),
      }),
    );
    await page.route(`**/api/v1/projects/${NEW_PROJECT_ID}/overview/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }),
      }),
    );

    await page.goto(`/programs/${GID}/overview`);
    await expect(page.getByRole('heading', { name: 'Delivery Program' })).toBeVisible();
    await page.getByRole('button', { name: 'New project', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: /new project/i });
    await expect(dialog).toBeVisible();
    const programPicker = dialog.getByRole('combobox', { name: /^program$/i });
    await expect(programPicker).toHaveValue(GID);

    // Change the inferred program to standalone.
    await programPicker.selectOption('');
    await expect(programPicker).toHaveValue('');

    // One screen (#2728) — name, then straight to Create, no step navigation.
    await dialog.getByRole('textbox', { name: /name/i }).fill('Now Standalone');
    await dialog.getByRole('button', { name: /create project/i }).click();

    // Blank is the default way, and a blank create lands on the Schedule outline
    // the Start sheet's Blank card names (#3311) — not Overview.
    await expect(page).toHaveURL(`/projects/${NEW_PROJECT_ID}/schedule`);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody).not.toHaveProperty('program');
  });

  test('Program context → a failed create surfaces the inline error and keeps the dialog open after switching the picker (error state)', async ({ page }) => {
    await page.route('**/api/v1/projects/', (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: pj({ detail: 'Internal server error' }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }),
      });
    });

    await page.goto(`/programs/${GID}/overview`);
    await expect(page.getByRole('heading', { name: 'Delivery Program' })).toBeVisible();
    await page.getByRole('button', { name: 'New project', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: /new project/i });
    await expect(dialog).toBeVisible();
    // Switch away from the route-inferred program before submitting, so the
    // failure path is exercised through the new picker, not just the pre-existing
    // inferred-program create flow.
    await dialog.getByRole('combobox', { name: /^program$/i }).selectOption('');
    await dialog.getByRole('textbox', { name: /name/i }).fill('Will Fail');
    await dialog.getByRole('button', { name: /create project/i }).click();

    await expect(dialog.getByRole('alert')).toHaveText(/failed to create project/i);
    // Dialog stays open — no optimistic navigation on a create that never succeeded.
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/programs/${GID}/overview`));
  });
});
