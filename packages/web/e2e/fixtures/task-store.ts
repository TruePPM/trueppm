import type { Page, Route } from '@playwright/test';

/**
 * A **stateful** task store for specs that assert on the DOM *after* a write.
 *
 * The default `setupApiMocks` task route is stateless: every `GET /tasks/` re-serves
 * the same fixture array. That is fine for a spec that only reads, and a silent race
 * for a spec that writes — because `useUpdateTask` patches the cache optimistically in
 * `onMutate` and then **invalidates `['tasks', projectId]` in `onSuccess`**. The refetch
 * that the app's own success handler triggers re-serves the *original* fixture, so the
 * committed value survives only the few tens of milliseconds between the optimistic
 * render and the refetch landing. Under CI worker contention Playwright's poll misses
 * that window and the spec fails — nondeterministically, and only ever on a loaded
 * runner (#2752). `useScheduleTasks`' 2 s `refetchInterval` closes the same window a
 * second time even where nothing invalidates.
 *
 * Raising the assertion timeout does not help: after the refetch the value is gone
 * permanently, so a 5 s and a 60 s `toBeVisible` fail identically. The fix is to make
 * the read endpoint echo the write, which is what a real server does.
 *
 * Register AFTER `setupApiMocks` — Playwright matches routes in reverse registration
 * order, so the last registration wins. Requests this store does not own
 * (`POST`, `DELETE`, nested paths like `/tasks/{id}/notes/`) fall through via
 * `route.fallback()`, leaving existing mocks untouched.
 *
 * ```ts
 * const store = await setupTaskStore(page, { tasks: FIXTURE_TASKS });
 * // ... commit an edit ...
 * await expect.poll(() => store.patches.length).toBeGreaterThan(0);
 * await expect(page.getByText('the committed name')).toBeVisible(); // stable, not a race
 * ```
 */

/** A task row as the API serializes it. Specs supply whichever fields they assert on. */
export type TaskRow = Record<string, unknown>;

export interface TaskStoreOptions {
  /** The rows the store starts with — what `GET /tasks/` returns before any write. */
  tasks: TaskRow[];
  /**
   * Project a PATCH body onto the stored row. Defaults to a shallow merge.
   *
   * Supply this whenever a write field is **write-only** on the serializer and reads
   * back under a different name — `owners` (write) → `assignments` (read), for example.
   * A shallow merge would otherwise put a field on the row that the real API never
   * returns, and the spec would be asserting against a shape the server cannot produce.
   */
  applyPatch?: (body: Record<string, unknown>, current: TaskRow) => TaskRow;
  /**
   * The `can_undo` the classification cascade's 200 reports (#3304). Defaults to
   * `true` — the Admin/Owner case every existing spec was written against.
   *
   * Set `false` to drive the Member case: applying is `IsProjectPlanAuthor` but
   * `/cascade-classification-operations/{id}/undo/` is Admin+, so the server tells
   * the client not to offer an Undo it would refuse. This is an option rather than
   * a derived value because the store has no role of its own to derive it from.
   */
  canUndoBatchOperations?: boolean;
}

export interface TaskStoreHandle {
  /** PATCH bodies the app sent, in order — the request-side contract to assert on. */
  patches: Record<string, unknown>[];
  /** POST bodies the app sent, in order (#2957 — which parent an insert asked for). */
  creates: Record<string, unknown>[];
  /** The store's current rows: exactly what the next refetch will return. */
  rows: () => TaskRow[];
  /** Classification-cascade bodies the app sent, in order (#2736). */
  classifications: Record<string, unknown>[];
}

/** A row's WBS path, narrowed off the `unknown`-valued `TaskRow` map. */
function wbsOf(row: TaskRow): string {
  return typeof row.wbs_path === 'string' ? row.wbs_path : '';
}

/** `/api/v1/tasks/<id>/` and nothing deeper — a nested path is not this store's. */
const DETAIL_PATH = /\/api\/v1\/tasks\/([^/]+)\/$/;

/**
 * The classification cascade's PATCH body, as the popover sends it.
 *
 * A `type` and not an `interface` on purpose: only a type alias gets an implicit
 * index signature, which is what lets the parsed body go straight into the
 * `Record<string, unknown>[]` the handle exposes as `classifications`.
 */
type ClassificationRequest = {
  subtree?: string;
  cascade?: boolean;
  governance_class?: string | null;
  delivery_mode?: string | null;
  preserve_governance_overrides?: boolean;
  skip_milestones?: boolean;
};

/** What one row's classification pass wrote — the caller sums these into its report. */
interface ClassifyOutcome {
  /** Axes the milestone gate held back; a non-empty list puts the row in `skipped`. */
  withheld: string[];
  govApplied: number;
  govKept: number;
  deliveryApplied: number;
}

/**
 * The ids a cascade covers: `rootId` plus every descendant of it within `rows`.
 *
 * Repeats to depth because a child can appear before its parent in the array, so a
 * single pass would miss a grandchild whose parent is only added later in that pass.
 * Passing an empty `rows` yields the seed alone, which is the non-cascading request.
 */
function expandSubtree(rows: TaskRow[], rootId: string | undefined): Set<string> {
  const ids = new Set<string>(rootId ? [rootId] : []);
  for (let pass = 0; pass < rows.length; pass++) {
    for (const row of rows) {
      const parent = row.parent_id as string | null | undefined;
      if (parent && ids.has(parent)) ids.add(row.id as string);
    }
  }
  return ids;
}

/**
 * One row's half of the classification cascade — the mirror of the server's
 * `task_classification._classify_row`. Mutates `row` in place the way the endpoint
 * does and reports what it wrote, so the caller can sum the counters for its report.
 */
function classifyRow(row: TaskRow, body: ClassificationRequest, isRoot: boolean): ClassifyOutcome {
  const isMilestone = Boolean(row.is_milestone);
  const withheld: string[] = [];
  let govApplied = 0;
  let govKept = 0;
  let deliveryApplied = 0;

  if (body.governance_class != null) {
    const inherited = (row.parent_governance_inherited as boolean | undefined) ?? true;
    if (isMilestone && body.skip_milestones !== false) {
      withheld.push('governance_class');
    } else if (!isRoot && body.preserve_governance_overrides !== false && !inherited) {
      govKept += 1;
    } else {
      row.governance_class = body.governance_class;
      row.parent_governance_inherited = !isRoot;
      govApplied += 1;
    }
  }

  if (body.delivery_mode != null) {
    if (isMilestone) {
      withheld.push('delivery_mode');
    } else {
      row.delivery_mode = body.delivery_mode;
      deliveryApplied += 1;
    }
  }

  return { withheld, govApplied, govKept, deliveryApplied };
}

export async function setupTaskStore(page: Page, opts: TaskStoreOptions): Promise<TaskStoreHandle> {
  const rows: TaskRow[] = opts.tasks.map((t) => ({ ...t }));
  const patches: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  let createSeq = 0;
  const classifications: Record<string, unknown>[] = [];
  // ADR-0810 (#2756): the pre-cascade snapshot `/cascade-classification-operations/
  // {id}/undo/` restores — captured before the classification route's own mutation
  // loop runs, mirroring the real server's before/after snapshot.
  let lastCascadeUndo: Record<string, unknown>[] | null = null;
  // ADR-0810 (#2756): the ids `/paste-many-operations/{id}/undo/` removes —
  // exactly what the most recent `tasks/bulk/` create batch wrote.
  let lastPasteManyUndo: string[] | null = null;
  const applyPatch =
    opts.applyPatch ??
    ((body: Record<string, unknown>, current: TaskRow) => ({ ...current, ...body }));

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  // The methods this store owns, lifted out of the route callback below so the
  // dispatch stays readable. Each keeps the same `rows` / `json` / `applyPatch`
  // closure, and each fulfils the route itself.
  const handleGet = async (route: Route, id: string | undefined) => {
    if (id === undefined) {
      return route.fulfill(json({ count: rows.length, next: null, previous: null, results: rows }));
    }
    const row = rows.find((r) => r.id === id);
    return row ? route.fulfill(json(row)) : route.fulfill(json({ detail: 'Not found.' }, 404));
  };

  // `POST /tasks/` (#2957). The three insert affordances are only testable
  // through *where the row ends up*, so the store has to place a create the
  // way the server does: append within the requested parent, derive the WBS
  // path from that parent's, and promote the parent to a summary. Asserting
  // that a request fired proves nothing here — a request firing is exactly
  // what the three affordances already had in common while landing in the
  // wrong place.
  const handleCreate = async (route: Route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    creates.push(body);
    const parentId = (body.parent_id ?? null) as string | null;
    const parent = parentId === null ? undefined : rows.find((r) => r.id === parentId);
    const parentWbs = parent ? wbsOf(parent) : '';
    const siblings = rows.filter((r) => (r.parent_id ?? null) === parentId);
    createSeq += 1;
    const created: TaskRow = {
      early_start: '2026-04-05',
      early_finish: '2026-04-09',
      planned_start: '2026-04-05',
      duration: 1,
      percent_complete: 0,
      is_critical: false,
      is_milestone: false,
      is_summary: false,
      status: 'NOT_STARTED',
      assignees: [],
      total_float: null,
      predecessor_count: 0,
      is_blocked: false,
      linked_risks_count: 0,
      linked_risks_max_severity: null,
      ...body,
      id: `created-${createSeq}`,
      parent_id: parentId,
      wbs_path: parentWbs ? `${parentWbs}.${siblings.length + 1}` : `${siblings.length + 1}`,
    };
    // The server appends within the parent's subtree; at the root that is the
    // end of the whole list, which is what the footer affordance relies on.
    const lastOfSubtree = parentWbs
      ? rows.reduce((acc, r, i) => {
          const w = wbsOf(r);
          return w === parentWbs || w.startsWith(`${parentWbs}.`) ? i : acc;
        }, -1)
      : rows.length - 1;
    rows.splice(lastOfSubtree + 1, 0, created);
    if (parent) parent.is_summary = true;
    return route.fulfill(json(created, 201));
  };

  const handlePatch = async (route: Route, id: string) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    patches.push(body);
    const index = rows.findIndex((r) => r.id === id);
    if (index < 0) return route.fulfill(json({ detail: 'Not found.' }, 404));
    // The write lands in the store BEFORE the response resolves, so the refetch the
    // app fires from `onSuccess` can only ever observe the committed state.
    rows[index] = applyPatch(body, rows[index]);
    return route.fulfill(json(rows[index]));
  };

  await page.route('**/api/v1/tasks/**', async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const id = DETAIL_PATH.exec(new URL(request.url()).pathname)?.[1];

    if (method === 'GET') return handleGet(route, id);

    // The LIST path only. `id === undefined` would also be true for every
    // nested action (`tasks/{id}/restore/`, `/indent/`, `/comments/`, …),
    // because `DETAIL_PATH` matches the detail path and nothing deeper — so a
    // looser guard would fulfil a fabricated 201 task row where those calls
    // used to `route.fallback()` to their own mock, and the spec would present
    // as "a nonsense row appeared" rather than "a mock is missing".
    if (method === 'POST' && new URL(request.url()).pathname.endsWith('/api/v1/tasks/')) {
      return handleCreate(route);
    }

    if (method === 'PATCH' && id !== undefined) return handlePatch(route, id);

    return route.fallback();
  });

  // `tasks/bulk/` (#2724) lives under a different path (`projects/{pk}/tasks/bulk/`,
  // not `tasks/{id}/`), so the route above never sees it — a separate registration,
  // sharing the same `rows` closure. Covers `create` (client-minted `id`, per
  // ADR-0772) and `delete` for paste-many (#2724), plus `update` for the ⌘⇧K
  // bulk-edit sheet (#2756 pt.2).
  await page.route(/\/api\/v1\/projects\/[^/]+\/tasks\/bulk\/$/, async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const body = (request.postDataJSON() ?? {}) as {
      operations?: { op: string; id?: string; data?: Record<string, unknown> }[];
    };
    const applied: Record<string, unknown>[] = [];
    const rejected: Record<string, unknown>[] = [];
    const createdIds: string[] = [];
    (body.operations ?? []).forEach((op, index) => {
      if (op.op === 'create') {
        const id = op.id ?? `bulk-${rows.length}-${index}`;
        rows.push({ id, ...op.data });
        applied.push({ index, id, op: 'create', outcome: 'created' });
        createdIds.push(id);
        return;
      }
      if (op.op === 'delete') {
        const idx = rows.findIndex((r) => r.id === op.id);
        if (idx < 0) {
          rejected.push({ index, id: op.id ?? null, code: 'not_found', message: 'No such task.' });
          return;
        }
        rows.splice(idx, 1);
        applied.push({ index, id: op.id, op: 'delete', outcome: 'deleted' });
        return;
      }
      // `update` (#2756 pt.2, the ⌘⇧K bulk-edit sheet). Faithful in the two ways
      // a spec can observe: the row's read shape reflects the write, and a row
      // the user may not edit comes back in `rejected` rather than failing the
      // whole batch — which is the partial-success path the sheet exists to
      // report. `owners` is write-only and reads back as `assignments`, same
      // asymmetry `applyPatch` exists for on the PATCH route.
      if (op.op === 'update') {
        const idx = rows.findIndex((r) => r.id === op.id);
        if (idx < 0) {
          rejected.push({ index, id: op.id ?? null, code: 'not_found', message: 'No such task.' });
          return;
        }
        if (rows[idx].can_edit === false) {
          rejected.push({
            index,
            id: op.id ?? null,
            code: 'forbidden',
            message: 'You may not edit this task.',
          });
          return;
        }
        rows[idx] = applyPatch(op.data ?? {}, rows[idx]);
        applied.push({ index, id: op.id, op: 'update', outcome: 'updated' });
        return;
      }
      rejected.push({
        index,
        id: op.id ?? null,
        code: 'invalid',
        message: `Unknown op '${op.op}'.`,
      });
    });
    // ADR-0810 (#2756): the ⌘Z undo ledger id — a fixed fixture id whenever the
    // batch created at least one row, matching the real server's "any create
    // through this endpoint is undoable" behavior. `/paste-many-operations/
    // {id}/undo/` below deletes exactly this batch's created ids.
    const operationId = createdIds.length > 0 ? 'e2e-paste-many-op-1' : null;
    if (createdIds.length > 0) lastPasteManyUndo = createdIds;
    return route.fulfill(
      json(
        // `capabilities_denied` is always present on the real 207 (#3037) — a mock
        // that omits it hands the next reader `undefined` where the server sends `[]`.
        { applied, rejected, skipped: [], capabilities_denied: [], operation_id: operationId },
        207,
      ),
    );
  });

  // ADR-0810 (#2756): reverses the most recent paste-many batch by removing
  // exactly the ids that same batch created — good enough for a frontend
  // wiring test (skip-if-touched-since is pytest's job, not e2e's).
  await page.route(/\/api\/v1\/paste-many-operations\/[^/]+\/undo\/$/, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const ids = lastPasteManyUndo ?? [];
    for (const id of ids) {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx >= 0) rows.splice(idx, 1);
    }
    lastPasteManyUndo = null;
    return route.fulfill(json({ undo: { deleted: ids.length, kept: 0 } }));
  });

  // `projects/{pk}/tasks/classification/` (#2735/#2736) — the two-axis subtree
  // cascade. Same reason as `tasks/bulk/` above: a different path, the same
  // `rows` closure, because the popover invalidates `['tasks', projectId]` on
  // success and the refetch has to show what the cascade wrote. A stateless
  // mock here would make the mode chip appear and then vanish.
  //
  // Faithful to `task_classification._classify_row` in the three ways a spec can
  // actually observe: milestones keep their delivery mode, explicit governance
  // overrides survive, and the root breaks inheritance while descendants assert it.
  await page.route(/\/api\/v1\/projects\/[^/]+\/tasks\/classification\/$/, async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'PATCH') return route.fallback();
    const body = (request.postDataJSON() ?? {}) as ClassificationRequest;
    classifications.push(body);

    // `cascade: false` classifies the root alone — walking no rows finds no
    // descendants, which leaves the seed and nothing else.
    const subtreeIds = expandSubtree(body.cascade === false ? [] : rows, body.subtree);

    const matched = rows.filter((r) => subtreeIds.has(r.id as string));
    // ADR-0810 (#2756): snapshot before the mutation loop below — this is what
    // `/cascade-classification-operations/{id}/undo/` restores.
    const beforeSnapshot = matched.map((row) => ({
      id: row.id,
      governance_class: row.governance_class,
      parent_governance_inherited: row.parent_governance_inherited,
      delivery_mode: row.delivery_mode,
    }));
    const skipped: Record<string, unknown>[] = [];
    let govApplied = 0;
    let govKept = 0;
    let deliveryApplied = 0;

    for (const row of matched) {
      const { withheld, ...counters } = classifyRow(row, body, row.id === body.subtree);
      govApplied += counters.govApplied;
      govKept += counters.govKept;
      deliveryApplied += counters.deliveryApplied;

      if (withheld.length) {
        skipped.push({
          id: row.id,
          code: 'milestone_gate',
          axes: withheld,
          message: `Milestone left unclassified on ${withheld.join(' and ')}.`,
        });
      }
    }

    // ADR-0810 (#2756): the ⌘Z undo ledger id — null on a no-op cascade (nothing
    // written), a fixed fixture id otherwise. `/cascade-classification-operations/
    // {id}/undo/` below reverts the exact fields this same request just wrote.
    const wroteAnything = govApplied > 0 || deliveryApplied > 0;
    const operationId = wroteAnything ? 'e2e-cascade-op-1' : null;
    if (wroteAnything) lastCascadeUndo = beforeSnapshot;

    const report: Record<string, unknown> = {
      subtree: body.subtree,
      matched: matched.length,
      skipped,
      capabilities_denied: [],
      operation_id: operationId,
      // #3304: the caller's undo authority, which is a HIGHER floor than the one
      // that let this cascade through. Independent of `operation_id` on the wire,
      // exactly as the server sends it — the client requires both.
      can_undo: opts.canUndoBatchOperations ?? true,
    };
    if (body.governance_class != null) {
      report.governance = {
        requested: body.governance_class,
        applied: govApplied,
        unchanged: matched.length - govApplied - govKept - skipped.length,
        overrides_kept: govKept,
        has_inherit_bit: true,
      };
    }
    if (body.delivery_mode != null) {
      report.delivery_mode = {
        requested: body.delivery_mode,
        applied: deliveryApplied,
        unchanged: matched.length - deliveryApplied,
        // null, not 0 — this axis carries no inherit bit.
        overrides_kept: null,
        has_inherit_bit: false,
      };
    }
    return route.fulfill(json(report));
  });

  // ADR-0810 (#2756): reverses the most recent cascade — restores the
  // pre-cascade snapshot captured above. Good enough for a frontend wiring
  // test (the skip-if-touched-since logic itself is pytest's job, not e2e's).
  await page.route(
    /\/api\/v1\/cascade-classification-operations\/[^/]+\/undo\/$/,
    async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const snapshot = lastCascadeUndo ?? [];
      for (const before of snapshot) {
        const row = rows.find((r) => r.id === before.id);
        if (!row) continue;
        row.governance_class = before.governance_class;
        row.parent_governance_inherited = before.parent_governance_inherited;
        row.delivery_mode = before.delivery_mode;
      }
      lastCascadeUndo = null;
      return route.fulfill(json({ undo: { reverted: snapshot.length, kept: 0 } }));
    },
  );

  return { patches, creates, classifications, rows: () => rows.map((r) => ({ ...r })) };
}
