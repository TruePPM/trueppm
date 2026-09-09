import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program backlog E2E (#742).
 *
 * Drives the real UI against mocked ADR-0069 endpoints (#737): the backlog-item
 * list, the program's projects (pull targets), and the pull action. Covers the
 * golden path (search → select → pull → confirmation) and the no-results state.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000742';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Artemis Program',
  description: 'Crewed lift program',
  code: 'ARTM',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400, // Owner (ROLE_OWNER) — can create / pull / delete
  my_role_label: 'Program Admin',
  project_count: 3,
  member_count: 4,
};

const PROJECTS = [
  { id: 'proj-lift', name: 'Artemis IV Lift' },
  { id: 'proj-avionics', name: 'Avionics' },
  { id: 'proj-ground', name: 'Ground Ops' },
];

function apiItem(
  i: number,
  title: string,
  item_type: string,
  status: 'proposed' | 'pulled' = 'proposed',
) {
  return {
    id: `item-${String(i).padStart(3, '0')}`,
    server_version: 1,
    program: PROGRAM_ID,
    title,
    description: '',
    item_type,
    status,
    tags: [],
    priority_rank: i,
    story_points: null,
    pulled_task: status === 'pulled' ? `task-${i}` : null,
    pulled_task_project_id: status === 'pulled' ? PROJECTS[0].id : null,
    pulled_task_project_name: status === 'pulled' ? PROJECTS[0].name : null,
    pulled_at: status === 'pulled' ? '2026-05-23T00:00:00Z' : null,
    pulled_by: null,
    created_by: ME_ID,
    created_at: '2026-05-10T00:00:00Z',
    updated_at: '2026-05-20T00:00:00Z',
  };
}

// 9 items total: 7 proposed, 2 pulled — drives "All 9 · Proposed 7 · Pulled 2".
const BACKLOG_ITEMS = [
  apiItem(1, 'Crew safety review', 'epic'),
  apiItem(2, 'Range licensing coordination', 'story'),
  apiItem(3, 'Telemetry channel B', 'story'),
  apiItem(4, 'FAT prep harness', 'spike'),
  apiItem(5, 'Decommission legacy console', 'chore'),
  apiItem(6, 'Valve telemetry dropout', 'bug'),
  apiItem(7, 'Weather-hold automation', 'story'),
  apiItem(8, 'Pad water-deluge study', 'spike', 'pulled'),
  apiItem(9, 'Bench power supply upgrade', 'chore', 'pulled'),
];

type Page = import('@playwright/test').Page;

/**
 * Overrides for the methodology cases (#3644). The program's preset drives the
 * authoring vocabulary; each project's own preset drives the pull preview, and
 * the two are deliberately independent — a HYBRID program can hold a WATERFALL
 * project, which is exactly the case that used to be described wrongly.
 */
interface SetupOptions {
  program?: Record<string, unknown>;
  projects?: Record<string, unknown>[];
}

async function setup(
  page: Page,
  items: unknown[] = BACKLOG_ITEMS,
  options: SetupOptions = {},
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

  const pj = (data: unknown) => JSON.stringify(data);

  // Catch-all first; specific routes registered after win (last-match wins).
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ ...FIXTURE_PROGRAM, ...options.program }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(options.projects ?? PROJECTS),
    }),
  );
  // Method-aware: GET lists `items`; POST (create) echoes the posted item back
  // so the create flow can resolve and select the new item; PATCH merges the
  // posted fields onto the matching seed row and echoes the merged item back,
  // so an edit-and-save round-trip re-baselines the drawer's dirty state.
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/backlog-items/**`, (r) => {
    if (r.request().method() === 'POST') {
      const posted = (r.request().postDataJSON() ?? {}) as {
        title?: string;
        item_type?: string;
        description?: string;
        tags?: string[];
        story_points?: number | null;
      };
      return r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: pj({
          id: 'item-new-001',
          server_version: 1,
          program: PROGRAM_ID,
          title: posted.title ?? 'Untitled',
          description: posted.description ?? '',
          item_type: posted.item_type ?? 'story',
          status: 'proposed',
          tags: posted.tags ?? [],
          priority_rank: 1,
          story_points: posted.story_points ?? null,
          pulled_task: null,
          pulled_at: null,
          pulled_by: null,
          created_by: ME_ID,
          created_at: '2026-05-24T00:00:00Z',
          updated_at: '2026-05-24T00:00:00Z',
        }),
      });
    }
    if (r.request().method() === 'PATCH') {
      const url = new URL(r.request().url());
      const segments = url.pathname.split('/').filter(Boolean);
      const itemId = segments[segments.length - 1];
      const current = items.find((i) => (i as { id: string }).id === itemId) as
        | Record<string, unknown>
        | undefined;
      const patch = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...current, ...patch }),
      });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: pj(items) });
  });
  // Pull action (registered last so it wins over the list route for this path).
  await page.route('**/api/v1/programs/*/backlog-items/*/pull/', (r) =>
    r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: pj({ task: { id: 'task-new' } }),
    }),
  );

  await page.goto(`/programs/${PROGRAM_ID}/backlog`);
}

test.describe('Program backlog', () => {
  test('golden path — search, select, pull', async ({ page }) => {
    await setup(page);

    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();
    const row = page.getByRole('button', { name: 'Telemetry channel B', exact: true });
    await expect(row).toBeVisible();

    // Search narrows the match counter. Use "Telemetry channel" (unique to the
    // target row) rather than bare "Telemetry", which also matches "Valve
    // telemetry dropout" and would make the counter "2 of 9".
    await page.getByRole('searchbox', { name: 'Search backlog' }).fill('Telemetry channel');
    await expect(page.getByText('1 of 9')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();

    // Select → detail pane.
    await row.click();
    await expect(page.getByRole('heading', { name: 'Telemetry channel B' })).toBeVisible();

    // Enter the pull flow and confirm to Avionics.
    await page.getByRole('button', { name: 'Pull to project…' }).click();
    // "Target project" also appears in the sr-only announcement and the
    // explainer copy; match the section label exactly.
    await expect(page.getByText('Target project', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: /Avionics/ }).click();
    await page.getByRole('button', { name: 'Pull to Avionics' }).click();

    // Confirmation toast, with a deep-link to the created task (#1994).
    await expect(page.getByText('Pulled to Avionics.')).toBeVisible();
    const goToTask = page.getByRole('link', { name: 'Go to task' });
    await expect(goToTask).toBeVisible();
    await expect(goToTask).toHaveAttribute('href', '/projects/proj-avionics/tasks/task-new');
  });

  // #2668: the drawer used to render two independent "Save changes" buttons
  // for the same edit, and dismiss a dirty draft (via the ✕) with no warning.
  test('edit drawer: exactly one Save button, saves the edit, and guards a dirty close', async ({
    page,
  }) => {
    await setup(page);

    const row = page.getByRole('button', { name: 'Telemetry channel B', exact: true });
    await row.click();
    await expect(page.getByRole('heading', { name: 'Telemetry channel B' })).toBeVisible();

    const description = page.getByPlaceholder('No description yet. Click to add one.');
    await description.fill('Investigate channel B dropout.');

    // Finding 1 — one commit affordance, not two.
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);

    // Finding 5 — a second, unsaved edit is guarded on close instead of
    // discarded silently.
    await description.fill('Second, unsaved edit.');
    await page.getByRole('button', { name: 'Close details' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeVisible();

    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByRole('alertdialog')).not.toBeVisible();
    await expect(description).toHaveValue('Second, unsaved edit.');

    await page.getByRole('button', { name: 'Close details' }).click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByRole('alertdialog')).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Telemetry channel B' })).not.toBeVisible();
  });

  // #2668 finding 4 — an item with no assigned rank renders a dash, not a
  // meaning-nothing bare "#".
  test('an unranked item shows a dash for priority, not a bare "#"', async ({ page }) => {
    const unranked = { ...apiItem(10, 'Unranked spike', 'spike'), priority_rank: null };
    await setup(page, [...BACKLOG_ITEMS, unranked]);

    await page.getByRole('button', { name: 'Unranked spike', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Unranked spike' })).toBeVisible();
    // The "Priority" label's value cell — scoped so this doesn't also match the
    // (also-dashed) empty Story points option elsewhere on the pane.
    const priorityValue = page
      .getByText('Priority', { exact: true })
      .locator('xpath=following-sibling::span[1]');
    await expect(priorityValue).toHaveText('—');
  });

  test('no-results state offers recovery', async ({ page }) => {
    await setup(page);

    await page.getByRole('searchbox', { name: 'Search backlog' }).fill('quasar');
    await expect(page.getByText('Nothing matches "quasar"')).toBeVisible();
    // Two controls share the accessible name "Clear search" while the no-results
    // panel is up (the search field's icon button via aria-label, and this
    // recovery button). Target the recovery button by its visible text — the
    // icon button has none — to avoid a strict-mode match on both.
    await expect(page.getByText('Clear search')).toBeVisible();
  });

  // Regression for #1990: on an EMPTY backlog the desktop layout rendered the
  // full-page empty state instead of the pane that hosts the create form, so
  // clicking either create button set ?new=1 with nothing mounted to show it.
  test('empty state — "Create your first item" opens the create form and creates', async ({
    page,
  }) => {
    await setup(page, []);

    await expect(page.getByText('The program backlog is empty')).toBeVisible();
    await page.getByRole('button', { name: 'Create your first item' }).click();

    // The create form now has a home (the bug: it never appeared).
    await expect(page.getByRole('heading', { name: 'New backlog item' })).toBeVisible();

    await page.getByLabel('Title').fill('First epic');
    // Story points are groomable at create time (#1991) — the pull dialog's
    // promise that the estimate carries across is now real. The input is a scale-aware
    // <select> (ADR-0510, #2027), Fibonacci by default — pick, don't fill.
    await page.getByLabel('Story points').selectOption('5');
    await page.getByRole('button', { name: 'Create item' }).click();

    // On success the new item is selected and its detail view renders, carrying
    // the estimate through the create round-trip.
    await expect(page.getByRole('heading', { name: 'First epic' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Story points' })).toHaveValue('5');
  });

  test('empty state — header "New item" opens the create form', async ({ page }) => {
    await setup(page, []);

    await expect(page.getByText('The program backlog is empty')).toBeVisible();
    await page.getByRole('button', { name: 'New item' }).click();

    await expect(page.getByRole('heading', { name: 'New backlog item' })).toBeVisible();
  });

  // #2026: story points are relevant only to estimable leaf work — Epics and
  // Features are containers and hide the field.
  test('create form hides story points for container types (Epic/Feature)', async ({ page }) => {
    await setup(page, []);
    await page.getByRole('button', { name: 'New item' }).click();
    await expect(page.getByRole('heading', { name: 'New backlog item' })).toBeVisible();

    // Default type is Story → points visible.
    await expect(page.getByLabel('Story points')).toBeVisible();

    await page.getByLabel('Type').selectOption('epic');
    await expect(page.getByLabel('Story points')).toHaveCount(0);

    await page.getByLabel('Type').selectOption('feature');
    await expect(page.getByLabel('Story points')).toHaveCount(0);

    // Back to a leaf type → the field returns.
    await page.getByLabel('Type').selectOption('task');
    await expect(page.getByLabel('Story points')).toBeVisible();
  });

  // #2026: tags are entered through a searchable combobox that offers a
  // "Create …" row for text that isn't already a tag.
  test('tag combobox creates a new tag from typed text', async ({ page }) => {
    await setup(page, []);
    await page.getByRole('button', { name: 'New item' }).click();
    await expect(page.getByRole('heading', { name: 'New backlog item' })).toBeVisible();

    const tagInput = page.getByRole('combobox', { name: 'Add a tag' });
    await tagInput.click();
    await tagInput.fill('backend');
    await page.getByRole('option', { name: 'Create "backend"' }).click();

    // The tag is now a removable chip on the form.
    await expect(page.getByRole('button', { name: 'Remove tag backend' })).toBeVisible();
    // The input cleared and stays ready for the next tag.
    await expect(tagInput).toHaveValue('');
  });
});

/**
 * #3644 — the surface read `Program.methodology` nowhere at all, so a waterfall
 * program met Scrum vocabulary it could not turn off and a pull into a waterfall
 * project promised a Backlog tab `methodologyTabs` hides there.
 *
 * These assert the *rendered* vocabulary rather than the helper's return value —
 * the unit tests pin the helpers, and a correct helper wired to nothing would
 * pass them while the page still said "Story points".
 */
test.describe('Program backlog — methodology vocabulary (#3644)', () => {
  test('a WATERFALL program authors in Estimate/Task, not Story points/Story', async ({
    page,
  }) => {
    await setup(page, [], {
      program: { methodology: 'WATERFALL', effective_methodology: 'WATERFALL' },
    });

    await page.getByRole('button', { name: 'New item' }).click();
    await expect(page.getByRole('heading', { name: 'New backlog item' })).toBeVisible();

    // The accessible name, not just the visible text — `getByLabel` resolves
    // through it, so this proves `ariaLabel` moved with the `<label>` (WCAG
    // 2.5.3). A visible-only assertion passes on the half-fix.
    await expect(page.getByLabel('Estimate')).toBeVisible();
    await expect(page.getByLabel('Story points')).toHaveCount(0);
    await expect(page.getByLabel('Type')).toHaveValue('task');
  });

  test('an AGILE program keeps Story points and starts on Story', async ({ page }) => {
    await setup(page, [], {
      program: { methodology: 'AGILE', effective_methodology: 'AGILE' },
    });

    await page.getByRole('button', { name: 'New item' }).click();
    await expect(page.getByRole('heading', { name: 'New backlog item' })).toBeVisible();
    await expect(page.getByLabel('Story points')).toBeVisible();
    await expect(page.getByLabel('Type')).toHaveValue('story');
  });

  test('the tags field says what tags are and what they become', async ({ page }) => {
    await setup(page, []);

    await page.getByRole('button', { name: 'New item' }).click();
    await expect(
      page.getByText('Program-wide free text. On pull, each tag becomes a project label.'),
    ).toBeVisible();
  });

  test('pulling into a WATERFALL project names Schedule, not the hidden Backlog tab', async ({
    page,
  }) => {
    // A HYBRID program holding one WATERFALL project — the case where reading
    // the program's preset instead of the project's would describe the wrong
    // destination for the one reader who most needs it right.
    await setup(page, BACKLOG_ITEMS, {
      projects: [
        // `effective_methodology` is the field the picker must read (web-rule
        // 196): a project that never set its own preset still inherits one. The
        // Avionics row sets the two DIFFERENTLY on purpose, so a regression that
        // reads the raw override would render "Waterfall" here and fail.
        {
          id: 'proj-pad',
          name: 'Pad 39B Refit',
          methodology: 'WATERFALL',
          effective_methodology: 'WATERFALL',
        },
        {
          id: 'proj-avionics',
          name: 'Avionics',
          methodology: 'WATERFALL',
          effective_methodology: 'AGILE',
        },
      ],
    });

    await page.getByRole('button', { name: 'Telemetry channel B', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Telemetry channel B' })).toBeVisible();
    await page.getByRole('button', { name: 'Pull to project…' }).click();

    const picker = page.getByRole('radiogroup', { name: 'Target project' });
    await expect(picker).toBeVisible();
    // The preset is visible on the row itself, before the choice is committed —
    // there is no un-pull endpoint, so this is the last moment it can matter.
    await expect(picker.getByRole('radio', { name: /Pad 39B Refit.*Waterfall/s })).toBeVisible();

    await picker.getByRole('radio', { name: /Pad 39B Refit/ }).click();
    await expect(page.getByText(/on Schedule, under Unscheduled/)).toBeVisible();
    await expect(page.getByText(/New undated task in Pad 39B Refit/)).toBeVisible();
    // The pane's own standing paragraph used to end "…in the target project's
    // backlog" — the same claim, in larger prose, six lines above the corrected
    // bullet, so the pane named two destinations at once and the wrong one was
    // the louder. Asserting the bullet is right does not catch that; this does.
    // The apostrophe is a character class on purpose: the paragraph renders
    // `&rsquo;` (U+2019), so an ASCII `'` here matches nothing and the
    // `toHaveCount(0)` passes on the broken build.
    await expect(page.getByText(/target project['\u2019]s backlog/)).toHaveCount(0);

    // Switching to the agile sibling switches the destination back.
    await picker.getByRole('radio', { name: /Avionics/ }).click();
    await expect(page.getByText(/New task in Avionics's backlog/)).toBeVisible();
    await expect(page.getByText(/on Schedule, under Unscheduled/)).toHaveCount(0);
  });

  test('the pull preview says tags are converted to labels, never copied', async ({ page }) => {
    await setup(page);

    await page.getByRole('button', { name: 'Telemetry channel B', exact: true }).click();
    await page.getByRole('button', { name: 'Pull to project…' }).click();

    await expect(page.getByText(/Each tag matches a label in/)).toBeVisible();
    // Conditional, not a promise — the server silently skips coining a new label
    // once the project is at its label soft cap. Stated as its own clause: the
    // character clamp and the label-count ceiling are different limits that only
    // happen to share the number 50, and the count is configurable.
    await expect(page.getByText(/takes no new ones/)).toBeVisible();
    await expect(page.getByText(/tags, and type are copied over/)).toHaveCount(0);
  });
});
