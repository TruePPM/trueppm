import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { Task } from '@/types';
import { useClassificationPopover } from './useClassificationPopover';

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
