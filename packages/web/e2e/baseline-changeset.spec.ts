import { test, expect, type Page, type WebSocketRoute } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * The committed plan's changeset and its two exits (#3150, ADR-1477, Pass 5
 * frames 3B–3D and 4A).
 *
 * Starts from the state a structural drop leaves behind: the act already
 * applied and the server holds one unreasoned entry. The changeset mock is
 * stateful — the reason PATCH and the decision POST mutate it and the GET the
 * app refetches serves the mutated state — so assertions after a write see the
 * write and not the fixture it started from.
 */

const PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const TASK = {
  id: 't1',
  wbs_path: '1',
  name: 'Structural repairs',
  early_start: '2026-10-05',
  early_finish: '2026-11-19',
  duration: 30,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
};

interface Entry {
  id: string;
  kind: 'add' | 'move' | 'delete';
  surface: string;
  author: number | null;
  author_name: string | null;
  agent_actor_id: string | null;
  task_ids: string[];
  task_names: string[];
  reason: string | null;
  reason_state: 'unreasoned' | 'reasoned';
  reason_by: number | null;
  reason_by_name: string | null;
  reason_at: string | null;
  finish_before: string | null;
  finish_after: string | null;
  opened_at: string;
  last_act_at: string;
  closed_at: string | null;
  resolved_decision: string | null;
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    kind: 'move',
    surface: 'grid',
    author: 1,
    author_name: 'wei',
    agent_actor_id: null,
    task_ids: ['t1'],
    task_names: ['Structural repairs'],
    reason: null,
    reason_state: 'unreasoned',
    reason_by: null,
    reason_by_name: null,
    reason_at: null,
    finish_before: '2026-11-14',
    finish_after: '2026-11-19',
    opened_at: '2026-11-12T10:05:00Z',
    last_act_at: '2026-11-12T10:05:00Z',
    closed_at: null,
    resolved_decision: null,
    ...over,
  };
}

interface Store {
  entries: Entry[];
  lastKeptAt: string | null;
  entriesSinceKept: number;
  posts: Record<string, unknown>[];
}

function changesetBody(store: Store) {
  const unreasoned = store.entries.filter((e) => e.reason === null).length;
  return {
    project_id: PROJECT_ID,
    open_count: store.entries.length,
    unreasoned_count: unreasoned,
    reasoned_count: store.entries.length - unreasoned,
    active_baseline: 'b1',
    active_baseline_name: 'Baseline v1',
    finish_baseline: '2026-11-14',
    finish_current: '2026-11-19',
    net_delta_days: 3,
    last_kept_at: store.lastKeptAt,
    entries_since_kept: store.entriesSinceKept,
    entries: [...store.entries].sort(
      (a, b) => Number(a.reason !== null) - Number(b.reason !== null),
    ),
    _provenance: { engine_version: 'e2e', input_hash: 'e2e', computed_at: '2026-11-24T15:22:00Z' },
  };
}

function decision(kind: 'taken' | 'kept', body: Record<string, unknown>) {
  return {
    id: 'd1',
    kind,
    from_baseline: 'b1',
    to_baseline: kind === 'taken' ? 'b2' : null,
    to_baseline_name: kind === 'taken' ? 'Baseline v2' : null,
    reason_code: kind === 'taken' ? body.reason_code : '',
    reason: typeof body.reason === 'string' ? body.reason : '',
    note: typeof body.note === 'string' ? body.note : '',
    commitment_moved: false,
    decision: null,
    entry_ids: [],
    finish_at_decision: '2026-11-19',
    actor: 1,
    actor_name: 'kelly',
    created_at: '2026-11-24T15:31:00Z',
  };
}

interface GotoOptions {
  /** The task list the schedule reads; one row by default. */
  tasks?: Record<string, unknown>[];
  /** Receives the project socket, so a test can push the server's board events. */
  onSocket?: (ws: WebSocketRoute) => void;
}

async function gotoCommittedSchedule(page: Page, store: Store, role = 300, opts: GotoOptions = {}) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill(
      json({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: PROJECT_ID,
            name: 'Hangar Retrofit',
            description: '',
            start_date: '2026-01-01',
            calendar: 'default',
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill(
      json({
        id: PROJECT_ID,
        name: 'Hangar Retrofit',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        estimation_mode: 'open',
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
        lifecycle: 'active',
        // The authoring gate (ADR-0773): the row's structure controls need it.
        can_author: true,
        server_version: 1,
      }),
    ),
  );
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill(json([{ id: 'm1', role, user_detail: { id: 'u1', username: 'kelly' } }])),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) => route.fulfill(json([])));
  const tasks = opts.tasks ?? [TASK];
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill(json({ count: tasks.length, next: null, previous: null, results: tasks })),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/projects/*/baselines/', (route) =>
    route.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/projects/*/changeset/', (route) =>
    route.fulfill(json(changesetBody(store))),
  );
  await page.route('**/api/v1/projects/*/changeset/entries/*/', async (route) => {
    const id = route.request().url().split('/').filter(Boolean).pop();
    const body = route.request().postDataJSON() as { reason: string };
    const target = store.entries.find((e) => e.id === id);
    if (!target) return route.fulfill(json({ detail: 'Not found.' }, 404));
    Object.assign(target, {
      reason: body.reason,
      reason_state: 'reasoned',
      reason_by: 1,
      reason_by_name: 'kelly',
      reason_at: '2026-11-24T15:25:00Z',
      closed_at: '2026-11-24T15:25:00Z',
    });
    return route.fulfill(json(target));
  });
  await page.route('**/api/v1/projects/*/baseline-decisions/', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill(json([]));
    const body = route.request().postDataJSON() as Record<string, unknown>;
    store.posts.push(body);
    if (body.kind === 'taken') {
      if (store.entries.some((e) => e.reason === null)) {
        return route.fulfill(json({ code: 'changeset_unreasoned', entries: [] }, 409));
      }
      store.entries = [];
      store.entriesSinceKept = 0;
    } else {
      store.lastKeptAt = '2026-11-24T15:31:00Z';
      store.entriesSinceKept = 0;
    }
    return route.fulfill(json(decision(body.kind as 'taken' | 'kept', body), 201));
  });
  // The socket mints a single-use ticket first (ADR-0141); without it no socket opens.
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill(json({ ticket: 'e2e-ticket', expires_in: 30 })),
  );
  await page.routeWebSocket('**/ws/v1/projects/**', (ws) => {
    // Accept and hold open; hand the socket to a test that pushes events.
    opts.onSocket?.(ws);
  });
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
}

function freshStore(entries: Entry[]): Store {
  return { entries, lastKeptAt: null, entriesSinceKept: entries.length, posts: [] };
}

test.beforeEach(async ({ page }) => {
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'u1', email: 'pm@example.com' }),
    }),
  );
});

test.describe('Baseline changeset on a committed plan', () => {
  test('golden path: answer the reason inline, then take v2', async ({ page }) => {
    const store = freshStore([entry()]);
    await gotoCommittedSchedule(page, store);

    const line = page.getByTestId('changeset-reason-line');
    await expect(line.getByRole('status')).toHaveText(
      'Structural repairs moved · finish 2026-11-14 → 2026-11-19',
    );
    await expect(page.getByTestId('changeset-counts')).toHaveText(
      '◷ 1 change open · 1 needs a reason',
    );

    // ⌥W reaches the field; the line never took focus on its own.
    await page.keyboard.press('Alt+KeyW');
    const why = page.getByRole('textbox', { name: /^Why\?/ });
    await expect(why).toBeFocused();
    await why.fill('Repairs wait for the crane lift plan');
    await why.press('Enter');
    await expect(page.getByText('✓ reasons up to date')).toBeVisible();

    await page.getByRole('button', { name: 'Review 1 change' }).click();
    const sheet = page.getByRole('dialog', { name: '1 change since Baseline v1' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('“Repairs wait for the crane lift plan”')).toBeVisible();
    await sheet.getByLabel('Reason · required').selectOption('approved_scope_change');
    await sheet.getByLabel(/Why re-baseline/).fill('Customer approved the revised handover date');
    await sheet.getByRole('button', { name: 'Take baseline v2' }).click();

    await expect(page.getByText('New baseline taken.')).toBeVisible();
    await expect(sheet).toBeHidden();
    expect(store.posts[0]).toMatchObject({
      kind: 'taken',
      expected_open_count: 1,
      reason_code: 'approved_scope_change',
    });
    await expect(page.getByTestId('changeset-review-trigger')).toHaveCount(0);
  });

  test('a structural gesture sends the hints and its entry appears', async ({ page }) => {
    // Drives the act itself rather than seeding its entry: the Indent control
    // sends the write, the mock records the body the interceptor shaped, the
    // server's entry joins the store, and the counts-only `changeset_updated`
    // board event is what makes the app refetch it (ADR-1477 §3, §5).
    const store = freshStore([]);
    const rows = [
      { ...TASK, id: 'umob', wbs_path: '1', name: 'Mobilization' },
      { ...TASK, id: 'usurvey', wbs_path: '2', name: 'Survey' },
    ];
    let socket: WebSocketRoute | null = null;
    const bodies: Record<string, unknown>[] = [];
    await page.route('**/api/v1/projects/*/tasks/*/indent/', async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      bodies.push(body);
      store.entries.push(
        entry({
          id: 'e2',
          surface: typeof body.surface === 'string' ? body.surface : 'api',
          task_ids: ['usurvey'],
          task_names: ['Survey'],
        }),
      );
      store.entriesSinceKept += 1;
      await route.fulfill({
        json: { updated: [{ id: 'usurvey', wbs_path: '1.1' }], warning: null, operation_id: 'op1' },
      });
      void socket?.send(
        JSON.stringify({
          protocol_version: 1,
          event_type: 'changeset_updated',
          payload: { id: PROJECT_ID, project_id: PROJECT_ID, open_count: 1, unreasoned_count: 1 },
          seq: 1,
        }),
      );
    });
    await gotoCommittedSchedule(page, store, 300, {
      tasks: rows,
      onSocket: (ws) => {
        socket = ws;
      },
    });

    const row = page.getByRole('row').filter({ hasText: 'Survey' }).first();
    await expect(row).toBeVisible();
    await expect(page.getByTestId('changeset-counts')).toHaveCount(0);
    await row.hover();
    await row.getByRole('button', { name: /^Indent Survey/ }).click();

    await expect.poll(() => bodies.length, { timeout: 10_000 }).toBe(1);
    // The first structural write of a fresh page session opens a new group, and
    // the Schedule names its own surface rather than letting it read as `api`.
    expect(bodies[0]).toMatchObject({ amend_group: 'new' });
    expect(['grid', 'gantt']).toContain(bodies[0].surface);
    await expect(page.getByTestId('changeset-counts')).toHaveText(
      '◷ 1 change open · 1 needs a reason',
    );
    await expect(page.getByTestId('changeset-reason-line').getByRole('status')).toHaveText(
      'Survey moved · finish 2026-11-14 → 2026-11-19',
    );
  });

  test('Take v2 is blocked while a change needs a reason; Keep v1 is not', async ({ page }) => {
    await gotoCommittedSchedule(page, freshStore([entry()]));
    await page.getByRole('button', { name: 'Review 1 change' }).click();
    const sheet = page.getByRole('dialog', { name: '1 change since Baseline v1' });
    await sheet.getByLabel('Reason · required').selectOption('external_delay');
    await sheet.getByLabel(/Why re-baseline/).fill('Vendor slipped');
    await expect(sheet.getByRole('button', { name: 'Take baseline v2' })).toBeDisabled();
    await expect(sheet.getByText(/1 change needs a reason before this plan/)).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Keep v1 · let variance stand' })).toBeEnabled();

    // Esc closes without deciding; the changeset stays open.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('button', { name: 'Review 1 change' })).toBeVisible();
  });

  test('Keep v1 records the decision and demotes Review', async ({ page }) => {
    const store = freshStore([entry()]);
    await gotoCommittedSchedule(page, store);
    await page.getByRole('button', { name: 'Review 1 change' }).click();
    const sheet = page.getByRole('dialog', { name: '1 change since Baseline v1' });
    await sheet.getByLabel(/Note for the trail/).fill('Reporting the slip on Thursday');
    await sheet.getByRole('button', { name: 'Keep v1 · let variance stand' }).click();

    await expect(page.getByText('Baseline v1 kept. Variance stands.')).toBeVisible();
    expect(store.posts[0]).toMatchObject({ kind: 'kept', note: 'Reporting the slip on Thursday' });
    await expect(page.getByRole('button', { name: '1 change · v1 kept' })).toBeVisible();
  });
});

test.describe('Baseline changeset on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('full-height sheet with two equal sticky exits; Take v2… opens the reason step', async ({
    page,
  }) => {
    await gotoCommittedSchedule(
      page,
      freshStore([entry({ reason: 'Crane on site after Apr 24', reason_state: 'reasoned' })]),
    );
    await page.getByRole('button', { name: 'Review 1 change' }).click();
    const sheet = page.getByRole('dialog', { name: '1 change since Baseline v1' });
    await expect(sheet).toBeVisible();

    const footer = sheet.getByTestId('changeset-sheet-footer');
    const take = footer.getByRole('button', { name: 'Take v2…' });
    const keep = footer.getByRole('button', { name: 'Keep v1' });
    const [tb, kb] = [await take.boundingBox(), await keep.boundingBox()];
    expect(tb && kb && Math.abs(tb.width - kb.width) < 1).toBe(true);
    expect(tb && tb.height >= 44).toBe(true);

    await take.click();
    await expect(sheet.getByRole('button', { name: 'Take baseline v2' })).toBeDisabled();
    await expect(sheet.getByRole('button', { name: 'Keep v1 instead' })).toBeEnabled();
  });

  test('the Plan card: count, since, finish against v1 as of the run, and Review', async ({
    page,
  }) => {
    await gotoCommittedSchedule(page, freshStore([entry()]));
    const card = page.getByTestId('changeset-phone-card');
    const summary = card.getByRole('region', { name: 'Open changeset' });
    await expect(summary).toContainText(/◷ 1 change open since v1 · \S/);
    await expect(summary).toContainText(/Finish .+ → .+ · \+3 wd vs v1 · as of \S/);
    // The desktop header row is not rendered on a phone: one surface, not two.
    await expect(page.getByTestId('changeset-reason-line')).toHaveCount(0);

    // Pin 2: no dead end. Says what is desktop-only and hands off two ways;
    // the email goes to the signed-in user's own address only.
    const note = card.getByRole('note', { name: 'Desktop-only edits' });
    await expect(note).toContainText('Adding, moving or deleting tasks is on desktop');
    await expect(note.getByRole('button', { name: 'Copy link' })).toBeVisible();
    const email = note.getByRole('link', { name: 'Email it to me' });
    await expect(email).toHaveAttribute('href', /^mailto:pm%40example\.com\?/);

    await summary.getByRole('button', { name: 'Review 1 change' }).click();
    await expect(page.getByRole('dialog', { name: '1 change since Baseline v1' })).toBeVisible();
  });

  test('answers a missing reason inline in the sheet', async ({ page }) => {
    const store = freshStore([entry()]);
    await gotoCommittedSchedule(page, store);
    await page.getByRole('button', { name: 'Review 1 change' }).click();
    const sheet = page.getByRole('dialog', { name: '1 change since Baseline v1' });
    const why = sheet.getByRole('textbox', { name: '◌ Needs a reason' });
    await why.fill('Crane on site after Apr 24');
    await sheet.getByRole('button', { name: 'Save' }).click();
    // The stateful mock serves the answered entry back on the refetch.
    await expect(sheet.getByText('“Crane on site after Apr 24”')).toBeVisible();
    expect(store.entries[0].reason).toBe('Crane on site after Apr 24');
  });

  test('offline: both exits read "Reconnect to decide" and the reason stays on the device', async ({
    page,
    context,
  }) => {
    await gotoCommittedSchedule(
      page,
      freshStore([entry({ reason: 'Crane on site after Apr 24', reason_state: 'reasoned' })]),
    );
    await page.getByRole('button', { name: 'Review 1 change' }).click();
    const sheet = page.getByRole('dialog', { name: '1 change since Baseline v1' });
    await sheet
      .getByTestId('changeset-sheet-footer')
      .getByRole('button', { name: 'Take v2…' })
      .click();
    await sheet.getByLabel(/Why re-baseline/).fill('Customer approved the new date');

    await context.setOffline(true);
    const footer = sheet.getByTestId('changeset-sheet-footer');
    const exits = footer.getByRole('button', { name: 'Reconnect to decide' });
    await expect(exits).toHaveCount(2);
    for (const b of await exits.all()) await expect(b).toBeDisabled();
    await expect(
      sheet.getByText('Reconnect to decide. Your reason is kept on this device.'),
    ).toBeVisible();

    // Close and reopen: the typed reason survived on this device.
    await sheet.getByRole('button', { name: 'Close without deciding' }).click();
    await page.getByRole('button', { name: 'Review 1 change' }).click();
    await expect(
      page
        .getByTestId('changeset-sheet-footer')
        .getByRole('button', { name: 'Reconnect to decide' }),
    ).toHaveCount(2);
    await context.setOffline(false);
    await page
      .getByTestId('changeset-sheet-footer')
      .getByRole('button', { name: 'Take v2…' })
      .click();
    await expect(page.getByLabel(/Why re-baseline/)).toHaveValue('Customer approved the new date');
  });
});
