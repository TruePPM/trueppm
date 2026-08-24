/**
 * The three insert affordances (#2957), asserted by WHERE THE ROW ENDS UP.
 *
 * That is the only assertion worth making here. Before this issue all three
 * routes into "add a row" fired a request — the defect was never a missing
 * call, it was that a control at the foot of the plan quietly inserted after
 * whatever row happened to be selected. A spec that asserts a POST fired would
 * have passed against the bug.
 *
 * `setupTaskStore` is therefore mandatory: it places a create the way the
 * server does (append within the requested parent, WBS derived from that
 * parent) and serves it back on the refetch the app's own `onSuccess` fires.
 * The stateless `setupApiMocks` list route would re-serve the original fixture
 * and erase the new row — passing locally and failing only under CI load
 * (#2752).
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

const FIXTURE_PROJECT_ID = 'e2e-ins-00000000-0000-0000-0000-000000002957';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Insert Affordances Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const baseRow = {
  early_start: '2026-04-05',
  early_finish: '2026-04-09',
  planned_start: '2026-04-05',
  duration: 5,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

/**
 * A phase with two children plus a root sibling. The cursor is parked on the
 * FIRST child in the toolbar test on purpose — a phase whose only child is the
 * selected one cannot tell "after the selection" apart from "at the end".
 */
const FIXTURE_TASKS = [
  { ...baseRow, id: 'ph', wbs_path: '1', name: 'Mobilization', is_summary: true, parent_id: null },
  { ...baseRow, id: 'c1', wbs_path: '1.1', name: 'Survey the site', is_summary: false, parent_id: 'ph' },
  { ...baseRow, id: 'c2', wbs_path: '1.2', name: 'Clear access road', is_summary: false, parent_id: 'ph' },
  { ...baseRow, id: 'r2', wbs_path: '2', name: 'Documentation', is_summary: false, parent_id: null },
];

test.describe('Schedule — each insert affordance lands where its position implies (#2957)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('the toolbar states where its insert will land, and lands it there', async ({ page }) => {
    const store = await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    await page.goto(BASE_URL);
    await expect(page.getByText('Survey the site')).toBeVisible();

    // Nothing focused: nothing to be "after", so the toolbar claims nothing
    // rather than borrowing the footer's behavior.
    const statement = page.getByTestId('schedule-insert-target');
    await expect(statement).toHaveCount(0);

    await page.getByText('Survey the site').click();
    // 1.1 is focused but 1.2 is the last sibling, and the create endpoint
    // appends within the parent — so the sentence names 1.2, which is where the
    // row actually goes. Naming 1.1 would be the more flattering claim and a
    // false one.
    // `toBeVisible`, not just `toHaveText`: a `truncate` span in the
    // `flex-nowrap` toolbar can collapse to zero width and still carry its full
    // text, so a text-only assertion passes on a sentence nobody can read
    // (web rule 316(c)).
    await expect(statement).toBeVisible();
    await expect(statement).toHaveText('⏎ adds a row after 1.2 · same level');
    await expect(statement).toHaveAttribute('data-target-kind', 'after');
    // The button describes itself with that same sentence, so a screen-reader
    // user hears it on focus rather than never.
    const addTask = page.getByRole('button', { name: 'Add item' });
    await expect(addTask).toHaveAttribute(
      'aria-describedby',
      'schedule-insert-target-statement',
    );

    await addTask.click();

    // Where it ended up: inside the phase, as a third child — not at the root,
    // and not under the row that merely happened to be selected. Exactly one —
    // a double-insert is the same class of defect as landing in the wrong place.
    await expect.poll(() => store.creates.length).toBe(1);
    expect(store.creates[0]).toMatchObject({ parent_id: 'ph' });
    await expect
      .poll(() => store.rows().find((r) => r.id === 'created-1')?.wbs_path)
      .toBe('1.3');
  });

  test('the toolbar create says "+ Item" in the text a sighted user reads (#3027)', async ({
    page,
  }) => {
    // Every other locator in this file resolves on `aria-label="Add item"`,
    // which SHADOWS the visible text in the accessible name — so `+ Task` could
    // come back and the whole suite would stay green. Its two peers are pinned
    // by their visible text (`schedule-render-parity.spec.ts` on Milestone,
    // `schedule-add-phase.spec.ts` on Phase); this is the third of the three.
    await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    await page.goto(BASE_URL);
    await expect(page.getByText('Survey the site')).toBeVisible();
    const create = page.getByRole('button', { name: 'Add item' });
    await expect(create).toContainText('Item');
    await expect(create).not.toContainText('Task');
  });

  test('the toolbar says ⏎ saves, not inserts, while the new row is unnamed — and refuses to add a second', async ({
    page,
  }) => {
    const store = await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    await page.goto(BASE_URL);
    await expect(page.getByText('Clear access road')).toBeVisible();

    await page.getByText('Clear access road').click();
    const addTask = page.getByRole('button', { name: 'Add item' });
    await addTask.click();
    await expect.poll(() => store.creates.length).toBe(1);

    // The row that just appeared has no name yet: `⏎` there commits the name,
    // and a second `⏎` on a blank one is a deliberate no-op. The toolbar has to
    // say that rather than keep promising another row.
    const statement = page.getByTestId('schedule-insert-target');
    await expect(statement).toHaveAttribute('data-target-kind', 'unnamed');
    await expect(statement).toContainText('name it to add the next');
    await expect(statement).not.toContainText('adds a row');

    // And the button agrees with the sentence: inert, not a click that blurs
    // the cell and produces nothing observable.
    await expect(addTask).toBeDisabled();
    await expect.poll(() => store.creates.length).toBe(1);
  });

  test('the sentence stays readable to a screen reader at a width too narrow to draw it', async ({
    page,
  }) => {
    // 900px: the desktop toolbar still renders (it goes down to 768) but has no
    // room for a sentence. `sr-only`, not `hidden` — the button's own
    // description must not vanish with the pixels, and the button still
    // branches three ways on focus state at this width.
    await page.setViewportSize({ width: 900, height: 800 });
    await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    await page.goto(BASE_URL);
    await expect(page.getByText('Survey the site')).toBeVisible();

    await page.getByText('Survey the site').click();
    const statement = page.getByTestId('schedule-insert-target');
    await expect(statement).toHaveText('⏎ adds a row after 1.2 · same level');
    await expect(page.getByRole('button', { name: 'Add item' })).toHaveAttribute(
      'aria-describedby',
      'schedule-insert-target-statement',
    );
  });

  test('the footer appends at the end, at the top level, with a child row selected', async ({
    page,
  }) => {
    const store = await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    await page.goto(BASE_URL);
    await expect(page.getByText('Survey the site')).toBeVisible();

    // Park the cursor deep inside the phase. The old single "Add item" button
    // would have honored this; the footer must not.
    await page.getByText('Survey the site').click();
    await expect(page.getByTestId('schedule-insert-target')).toBeVisible();

    const footer = page.getByTestId('schedule-append-task-footer');
    await footer.scrollIntoViewIfNeeded();
    await footer.getByRole('button', { name: 'Add an item at the end' }).click();

    await expect.poll(() => store.creates.length).toBe(1);
    // `?? null`, not `toMatchObject({ parent_id: null })`: the client drops a
    // null from the payload, so "root" reaches the wire as an ABSENT key. The
    // landing position below is the assertion that actually holds either way.
    expect(store.creates[0].parent_id ?? null).toBeNull();
    // Top level and last: WBS '3' follows the root rows 1 and 2.
    await expect
      .poll(() => store.rows().find((r) => r.id === 'created-1')?.wbs_path)
      .toBe('3');
    await expect
      .poll(() => store.rows().findIndex((r) => r.id === 'created-1'))
      .toBe(store.rows().length - 1);
  });

  test('an insert reaches the session trail, naming where each row landed (#3018)', async ({
    page,
  }) => {
    // Insert was the one structural act that announced nothing and left no
    // record: `insertSentence` existed and was imported by nothing. The trail is
    // the observable half of that contract — the live region is `sr-only` and
    // written through a DOM ref, so the popover is where a browser can see it.
    const store = await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    await page.goto(BASE_URL);
    await expect(page.getByText('Survey the site')).toBeVisible();

    // The region every structural sentence is spoken through carries its
    // declared role, which is the second half of #3018.
    await expect(page.getByTestId('schedule-act-live')).toHaveAttribute('role', 'status');

    // The trail button only exists once something has been recorded, so its
    // absence here is the pre-insert state rather than a missing mock.
    const trailButton = page.getByRole('button', { name: /structural change.* this session/i });
    await expect(trailButton).toHaveCount(0);

    await page.getByText('Survey the site').click();
    await expect(page.getByTestId('schedule-insert-target')).toBeVisible();
    await page.getByRole('button', { name: 'Add item' }).click();
    await expect.poll(() => store.creates.length).toBe(1);

    // One act, one entry — and the sentence names the neighbour the row landed
    // beside, which is the only part a user cannot read off the caret.
    await expect(trailButton).toBeVisible({ timeout: 15_000 });
    await trailButton.click();
    const trail = page.getByRole('dialog', { name: 'Structural changes this session' });
    await expect(trail).toBeVisible();
    await expect(
      trail.getByText('New item added below Clear access road, at the same level.'),
    ).toBeVisible();
  });

  test('the footer append names the LEVEL in the trail, having no anchor row (#3018)', async ({
    page,
  }) => {
    // The counterpart to the case above, and the reason the sentence is not one
    // shared string: the foot of the plan is not inside anything, so an entry
    // reading "below <whatever was selected>" would be a record that is wrong.
    const store = await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    await page.goto(BASE_URL);
    await expect(page.getByText('Survey the site')).toBeVisible();

    // Park the cursor deep inside the phase — the sentence must not borrow it.
    await page.getByText('Survey the site').click();
    await expect(page.getByTestId('schedule-insert-target')).toBeVisible();

    const footer = page.getByTestId('schedule-append-task-footer');
    await footer.scrollIntoViewIfNeeded();
    await footer.getByRole('button', { name: 'Add an item at the end' }).click();
    await expect.poll(() => store.creates.length).toBe(1);

    const trailButton = page.getByRole('button', { name: /structural change.* this session/i });
    await expect(trailButton).toBeVisible({ timeout: 15_000 });
    await trailButton.click();
    await expect(
      page
        .getByRole('dialog', { name: 'Structural changes this session' })
        .getByText('New item added at the end of the plan, at the top level.'),
    ).toBeVisible();
  });

  test('a refused create leaves no record claiming a row exists (#3018)', async ({ page }) => {
    // The error half of the flow, and the property the golden paths cannot prove: the
    // sentence is bound to the mutation's SUCCESS, not to the click. A trail entry for
    // a row the server rejected is worse than no entry — it is a record that is wrong,
    // and the trail's whole job is to be checkable against the outline.
    const store = await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    // Registered last, so it wins over the store's own POST handler.
    let refusedCreates = 0;
    await page.route('**/api/v1/tasks/', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      refusedCreates += 1;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ name: ['This field is required.'] }),
      });
    });

    await page.goto(BASE_URL);
    await expect(page.getByText('Survey the site')).toBeVisible();
    await page.getByText('Survey the site').click();
    await expect(page.getByTestId('schedule-insert-target')).toBeVisible();
    await page.getByRole('button', { name: 'Add item' }).click();

    await expect.poll(() => refusedCreates).toBe(1);
    expect(store.creates).toHaveLength(0);
    // The trail button only exists once something has been recorded, so its continued
    // absence IS the assertion. Given a beat to be wrong in.
    await expect(page.getByText(/Couldn’t add a new task|Couldn't add a new task/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: /structural change.* this session/i }),
    ).toHaveCount(0);
  });

  test('a viewer gets neither affordance — absent, not disabled', async ({ page }) => {
    // Viewer is ordinal 1, not 0 and not 100 (`lib/roles.ts` — every ordinal is
    // truthy on purpose, #2489). The whole authoring apparatus goes; a dimmed
    // "Add an item at the end" would teach a reader the product is broken
    // (rule 302).
    await page.route('**/api/v1/projects/*/members/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: route.request().url().includes('self=true')
          ? JSON.stringify([{ id: 'mem-self', role: 1, role_label: 'Viewer' }])
          : JSON.stringify({
              count: 1,
              next: null,
              previous: null,
              results: [{ id: 'mem-self', role: 1, role_label: 'Viewer' }],
            }),
      }),
    );
    await setupTaskStore(page, { tasks: FIXTURE_TASKS });
    await page.goto(BASE_URL);
    await expect(page.getByText('Survey the site')).toBeVisible();

    await expect(page.getByRole('button', { name: 'Add item' })).toHaveCount(0);
    await expect(page.getByTestId('schedule-append-task-footer')).toHaveCount(0);
    await page.getByText('Survey the site').click();
    await expect(page.getByTestId('schedule-insert-target')).toHaveCount(0);
  });
});
