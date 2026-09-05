import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { Task } from '@/types';
import {
  useClassificationPopover,
  type ClassificationAnnouncement,
} from './useClassificationPopover';

/**
 * The refusal path, driven end to end (#3302).
 *
 * These tests exist because the component-level ones could not catch the bug:
 * they pass a finished string in as a prop, which exercises the error slot and
 * says nothing about what a real server refusal turns into on its way there.
 * Every case below rejects the mutation with an actual `AxiosError` carrying the
 * body the endpoint really sends.
 */

const { patchMock, postMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock, post: postMock } }));

const TASKS = [{ id: 'p', name: 'Phase 4', parentId: null } as unknown as Task];

/** An axios rejection carrying a DRF error body — what the interceptor rethrows. */
function refusal(status: number, data: Record<string, unknown>): AxiosError {
  const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  return new AxiosError('Request failed', String(status), config, undefined, {
    data,
    status,
    statusText: '',
    headers: new AxiosHeaders(),
    config,
  });
}

function wrapper(queryClient: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Wrapper;
}

async function applyAndFail(queryClient: QueryClient, error: unknown) {
  patchMock.mockRejectedValueOnce(error);
  const { result } = renderHook(
    () =>
      useClassificationPopover({
        projectId: 'proj-1',
        tasks: TASKS,
        readOnly: false,
        announce: vi.fn(),
      }),
    { wrapper: wrapper(queryClient) },
  );
  result.current.apply({
    subtree: 'p',
    cascade: true,
    governance_class: 'flow',
    delivery_mode: 'scrum',
    preserve_governance_overrides: true,
    skip_milestones: true,
  });
  await waitFor(() => expect(result.current.error).not.toBeNull());
  return result;
}

describe('useClassificationPopover — server refusals', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it('surfaces the 403 sentence naming how many rows the role cannot author', async () => {
    const result = await applyAndFail(
      queryClient,
      refusal(403, { detail: 'Your role cannot author 3 of the 12 tasks in this subtree.' }),
    );
    expect(result.current.error?.message).toBe(
      'Your role cannot author 3 of the 12 tasks in this subtree.',
    );
    // The whole point of the finding: the generic string is what a PM used to get.
    expect(result.current.error?.message).not.toBe("Couldn't apply the classification.");
  });

  it('never offers a retry for a 403 — the server already decided', async () => {
    const result = await applyAndFail(queryClient, refusal(403, { detail: 'Nope.' }));
    expect(result.current.error?.retryable).toBe(false);
  });

  it('reads matched and max off the subtree_too_large body, not out of its prose', async () => {
    // `detail` deliberately carries no numbers here. If the counts still reach
    // the popover they can only have come from the structured fields — which is
    // what makes this test non-vacuous.
    const result = await applyAndFail(
      queryClient,
      refusal(400, {
        code: 'subtree_too_large',
        detail: 'Subtree is above the cap.',
        matched: '2500',
        max: '2000',
      }),
    );
    expect(result.current.error?.message).toBe('Subtree is above the cap.');
    expect(result.current.error?.detail).toContain('2500');
    expect(result.current.error?.detail).toContain('2000');
    expect(result.current.error?.retryable).toBe(false);
  });

  it('does not restate counts the server sentence already carries', async () => {
    // The real 400: `detail` names both numbers as prose, and the structured
    // fields exist so a client can branch — not so it can narrate them twice.
    const result = await applyAndFail(
      queryClient,
      refusal(400, {
        code: 'subtree_too_large',
        detail: 'Subtree resolves 2500 tasks, above the 2000-task cap.',
        matched: '2500',
        max: '2000',
      }),
    );
    expect(result.current.error?.detail).toBe(
      'Classify a smaller branch, or turn off “Cascade to descendants”.',
    );
  });

  it('tolerates JSON numbers where DRF sends strings', async () => {
    const result = await applyAndFail(
      queryClient,
      refusal(400, { code: 'subtree_too_large', detail: 'Too big.', matched: 2500, max: 2000 }),
    );
    expect(result.current.error?.detail).toContain('2500');
  });

  it('surfaces the graph guard 400 and adds no structured line it has no fields for', async () => {
    const result = await applyAndFail(
      queryClient,
      refusal(400, {
        code: 'cycle_detected',
        detail: 'The schedule graph contains a cycle.',
        offending: ['t1', 't2'],
      }),
    );
    expect(result.current.error?.message).toBe('The schedule graph contains a cycle.');
    expect(result.current.error?.detail).toBeNull();
    expect(result.current.error?.retryable).toBe(false);
  });

  it('keeps the generic sentence and the retry for a failure a retry can clear', async () => {
    // No response at all — the request never reached a server that could decide.
    const result = await applyAndFail(queryClient, new AxiosError('Network Error'));
    expect(result.current.error?.message).toBe("Couldn't apply the classification.");
    expect(result.current.error?.detail).toBeNull();
    expect(result.current.error?.retryable).toBe(true);
  });

  it('still offers a retry on the two 4xx that refuse timing, not content', async () => {
    // 429 and 408 are the exception to "a 4xx is a decision already made" — the
    // same bytes sent later do succeed.
    const throttled = await applyAndFail(
      queryClient,
      refusal(429, { detail: 'Request was throttled. Expected available in 30 seconds.' }),
    );
    expect(throttled.current.error?.retryable).toBe(true);

    vi.clearAllMocks();
    const timedOut = await applyAndFail(queryClient, refusal(408, { detail: 'Request timeout.' }));
    expect(timedOut.current.error?.retryable).toBe(true);
  });

  it('falls back rather than pasting an HTML error page into the popover', async () => {
    // A genuine crash never reaches DRF's JSON renderer: Django serves an HTML
    // 500 page and axios hands the whole document over as the body.
    patchMock.mockRejectedValueOnce(
      new AxiosError('Request failed', '500', undefined, undefined, {
        data: '<!doctype html><html><body><h1>Server Error (500)</h1></body></html>',
        status: 500,
        statusText: '',
        headers: new AxiosHeaders(),
        config: { headers: new AxiosHeaders() } as InternalAxiosRequestConfig,
      }),
    );
    const { result } = renderHook(
      () =>
        useClassificationPopover({
          projectId: 'proj-1',
          tasks: TASKS,
          readOnly: false,
          announce: vi.fn(),
        }),
      { wrapper: wrapper(queryClient) },
    );
    result.current.apply({
      subtree: 'p',
      cascade: true,
      governance_class: 'flow',
      delivery_mode: null,
      preserve_governance_overrides: true,
      skip_milestones: true,
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe("Couldn't apply the classification.");
    expect(result.current.error?.retryable).toBe(true);
  });

  it('TRUNCATES an over-long sentence rather than spilling it into the popover', async () => {
    // The three real refusals are short and bounded, but nothing on the server
    // caps `detail` — a sentence that outgrows the slot is the #3302 symptom
    // returning by a different route. #3332 changed the remedy from substitution
    // to truncation: substituting the fallback produces exactly the output that
    // means "the server sent nothing readable", so the planner cannot tell a
    // reason is being withheld.
    const result = await applyAndFail(queryClient, refusal(400, { detail: 'x'.repeat(301) }));
    expect(result.current.error?.message).toBe(`${'x'.repeat(300)}…`);
    expect(result.current.error?.message).not.toBe("Couldn't apply the classification.");

    vi.clearAllMocks();
    const kept = await applyAndFail(queryClient, refusal(400, { detail: 'y'.repeat(300) }));
    expect(kept.current.error?.message).toBe('y'.repeat(300));
  });

  it('reports no error before anything has been applied', () => {
    const { result } = renderHook(
      () =>
        useClassificationPopover({
          projectId: 'proj-1',
          tasks: TASKS,
          readOnly: false,
          announce: vi.fn(),
        }),
      { wrapper: wrapper(queryClient) },
    );
    expect(result.current.error).toBeNull();
  });
});

/**
 * The Undo affordance, at the toast (#3304).
 *
 * Asserted on the announcement the hook emits, not on the endpoint: the bug was
 * never that the undo endpoint let a Member through — it correctly 403s — but
 * that the client offered the control anyway, inside an 8-second window with no
 * second route to it. A pytest on the 403 passes on the broken build, so the
 * coverage that means anything has to be here.
 */
describe('useClassificationPopover — the Undo the server says you may use', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  /** A 200 body as the cascade endpoint sends it, with the two undo fields varied. */
  function report(overrides: {
    operation_id: string | null;
    can_undo: boolean;
    rows_written?: number;
    matched?: number;
    governance?: {
      requested: string;
      applied: number;
      unchanged: number;
      overrides_kept: number | null;
      has_inherit_bit: boolean;
    };
  }) {
    return {
      subtree: 'p',
      matched: 3,
      rows_written: 3,
      delivery_mode: {
        requested: 'scrum',
        applied: 3,
        unchanged: 0,
        overrides_kept: null,
        has_inherit_bit: false,
      },
      skipped: [],
      ...overrides,
    };
  }

  /** Apply a cascade that succeeds with `body`, and return the announcement it raised. */
  async function applyAndAnnounce(body: ReturnType<typeof report>) {
    patchMock.mockResolvedValueOnce({ data: body });
    // Typed rather than a bare `vi.fn()`: the announcement IS the assertion target
    // here, so reading `.action` off an `any` would make every expectation below
    // unchecked — and an `action` that changed shape would still pass.
    const announce = vi.fn<(announcement: ClassificationAnnouncement) => void>();
    const { result } = renderHook(
      () =>
        useClassificationPopover({
          projectId: 'proj-1',
          tasks: TASKS,
          readOnly: false,
          announce,
        }),
      { wrapper: wrapper(queryClient) },
    );
    result.current.apply({
      subtree: 'p',
      cascade: true,
      governance_class: null,
      delivery_mode: 'scrum',
      preserve_governance_overrides: true,
      skip_milestones: true,
    });
    await waitFor(() => expect(announce).toHaveBeenCalled());
    return { announcement: announce.mock.calls[0][0], announce };
  }

  it('offers Undo to a caller the server says may undo (Admin+)', async () => {
    const { announcement } = await applyAndAnnounce(
      report({ operation_id: 'op-1', can_undo: true }),
    );
    expect(announcement.message).toContain('Classified:');
    expect(announcement.action?.label).toBe('Undo');
    expect(typeof announcement.action?.onClick).toBe('function');
  });

  it('withholds Undo from a Member — apply cleared its floor, undo would 403', async () => {
    // The exact shape the bug produced: a real ledger row exists, so the OLD
    // `operation_id ? …` test attached the action; only `can_undo` distinguishes
    // this from the Admin case above.
    const { announcement } = await applyAndAnnounce(
      report({ operation_id: 'op-1', can_undo: false }),
    );
    // The receipt itself is unchanged — the cascade did happen and still says so.
    expect(announcement.message).toContain('Classified:');
    expect(announcement.action).toBeUndefined();
    // And nothing reaches the Admin-only undo route. Asserted alongside, because
    // "no action" and "an action that quietly no-ops" look the same in the
    // announcement alone and are not the same thing.
    expect(postMock).not.toHaveBeenCalled();
  });

  it('still withholds Undo on a no-op cascade even for an Admin', async () => {
    // `can_undo` is pure authority and says nothing about whether a ledger row
    // exists; `operation_id` is null when the cascade wrote nothing. Both are
    // required, so an Admin's no-op gets no Undo either.
    const { announcement } = await applyAndAnnounce(
      report({ operation_id: null, can_undo: true }),
    );
    expect(announcement.action).toBeUndefined();
  });

  it('counts rows, not the axis-rows the two applied tallies sum to (#3306)', async () => {
    // The shape the bug produced: a both-axes cascade over the same 3 rows. The old
    // copy summed `applied` per axis and called the result fields — "6 fields
    // written across 3 rows" for 3 rows and 9 model columns. Both numbers here are
    // things the planner can count on the grid.
    const { announcement } = await applyAndAnnounce(
      report({
        operation_id: 'op-1',
        can_undo: true,
        governance: {
          requested: 'gated',
          applied: 3,
          unchanged: 0,
          overrides_kept: 0,
          has_inherit_bit: true,
        },
      }),
    );
    expect(announcement.message).toContain('3 rows reclassified');
    expect(announcement.message).not.toContain('field');
    expect(announcement.message).not.toContain('6');
  });

  it('names both counts when the cascade left some of the subtree alone', async () => {
    const { announcement } = await applyAndAnnounce(
      report({ operation_id: 'op-1', can_undo: true, matched: 10, rows_written: 9 }),
    );
    expect(announcement.message).toContain('9 of 10 rows reclassified');
  });

  it('says so out loud when a cascade wrote nothing', async () => {
    // A whole-subtree no-op still raises a receipt, and "0 of 10" is the honest
    // reading of it — the old copy said "0 fields written across 10 rows", which
    // invited the planner to wonder which 10 rows had been touched.
    const { announcement } = await applyAndAnnounce(
      report({ operation_id: null, can_undo: true, matched: 10, rows_written: 0 }),
    );
    expect(announcement.message).toContain('0 of 10 rows reclassified');
  });

  it('keeps the grammar right on a single-row no-op', async () => {
    // `cascade: false` resolves the root alone, so `matched: 1` is routine and
    // `rows_written: 0` against it is what re-declaring a class the root already
    // holds produces. The fallback branch pluralizes off `matched`, not off a
    // "this can only happen above 2" assumption.
    const { announcement } = await applyAndAnnounce(
      report({ operation_id: null, can_undo: true, matched: 1, rows_written: 0 }),
    );
    expect(announcement.message).toContain('0 of 1 row reclassified');
    expect(announcement.message).not.toContain('1 rows');
  });

  it('drops the redundant total when every matched row was written', async () => {
    const { announcement } = await applyAndAnnounce(
      report({ operation_id: 'op-1', can_undo: true, matched: 1, rows_written: 1 }),
    );
    expect(announcement.message).toContain('1 row reclassified');
    expect(announcement.message).not.toContain('1 of 1');
  });

  it('clicking the offered Undo POSTs to the cascade operation route', async () => {
    postMock.mockResolvedValueOnce({ data: { undo: { reverted: 3, kept: 0 } } });
    const { announcement, announce } = await applyAndAnnounce(
      report({ operation_id: 'op-1', can_undo: true }),
    );
    announcement.action?.onClick();
    await waitFor(() => expect(announce).toHaveBeenCalledTimes(2));
    expect(postMock).toHaveBeenCalledWith('/cascade-classification-operations/op-1/undo/', {});
    expect(announce.mock.calls[1][0].message).toBe('Undone — reverted 3 rows.');
  });
});
