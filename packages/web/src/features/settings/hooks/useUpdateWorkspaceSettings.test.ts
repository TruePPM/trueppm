/**
 * useUpdateWorkspaceSettings unit tests (#784 coverage backfill).
 *
 * The PATCH /workspace/ body is built from a Partial<WorkspaceSettings> by
 * `toRaw`, which is the only non-trivial logic worth pinning: every field is
 * guarded by an explicit `!== undefined` check and remapped camelCase →
 * snake_case. The two regressions that must not slip through are (1) a field
 * leaking into the body as `null`/`undefined` when the caller did not set it —
 * the PATCH is partial, so an unset field must be ABSENT, not nulled — and
 * (2) a wrong snake_case key, which the server would silently ignore. The
 * onSuccess invalidate keeps the cached workspace-settings query authoritative.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useUpdateWorkspaceSettings } from './useUpdateWorkspaceSettings';

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  patchMock.mockResolvedValue({ data: {} });
});

describe('useUpdateWorkspaceSettings', () => {
  it('PATCHes /workspace/ with only the defined fields, remapped to snake_case', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useUpdateWorkspaceSettings(), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({
      name: 'Acme',
      fiscalYearStartMonth: 4,
      workWeek: [true, true, true, true, true, false, false],
    });

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith('/workspace/', {
      name: 'Acme',
      fiscal_year_start_month: 4,
      work_week: [true, true, true, true, true, false, false],
    });
  });

  it('omits unset fields entirely — absent, never null/undefined', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useUpdateWorkspaceSettings(), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ timezone: 'America/New_York' });

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const body = patchMock.mock.calls[0][1] as Record<string, unknown>;
    // Exactly one key — the single defined field.
    expect(Object.keys(body)).toEqual(['timezone']);
    // The unset fields are absent (not present-with-null), so the server's
    // partial-update contract leaves them untouched.
    expect('name' in body).toBe(false);
    expect('fiscal_year_start_month' in body).toBe(false);
    expect('methodology' in body).toBe(false);
  });

  it('maps the policy-override fields to their snake_case keys', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useUpdateWorkspaceSettings(), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({
      methodologyOverridePolicy: 'enforce',
      mcHistoryOverridePolicy: 'lock',
      attachmentsOverridePolicy: 'suggest',
      iterationLabelOverridePolicy: 'inherit',
      taskDurationChangePercentPolicy: 'prorate',
      taskDurationChangePercentOverridePolicy: 'enforce',
    });

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith('/workspace/', {
      methodology_override_policy: 'enforce',
      mc_history_override_policy: 'lock',
      attachments_override_policy: 'suggest',
      iteration_label_override_policy: 'inherit',
      task_duration_change_percent_policy: 'prorate',
      task_duration_change_percent_override_policy: 'enforce',
    });
  });

  it('serializes a falsy-but-defined boolean (false) rather than dropping it', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useUpdateWorkspaceSettings(), {
      wrapper: makeWrapper(qc),
    });

    // The guard is `!== undefined`, so `false` MUST be sent — a naive `if
    // (patch.allowGuests)` would silently drop a "turn guests off" edit.
    result.current.mutate({ allowGuests: false, mcHistoryEnabled: false });

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith('/workspace/', {
      allow_guests: false,
      mc_history_enabled: false,
    });
  });

  it('sends an empty body when called with no fields', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useUpdateWorkspaceSettings(), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({});

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith('/workspace/', {});
  });

  it('invalidates the workspace-settings query on success', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateWorkspaceSettings(), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ name: 'Acme' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspace-settings'] });
  });

  it('does NOT invalidate when the PATCH fails', async () => {
    patchMock.mockRejectedValueOnce({ response: { status: 500 } });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateWorkspaceSettings(), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ name: 'Acme' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
