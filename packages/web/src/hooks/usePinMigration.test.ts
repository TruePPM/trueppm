/**
 * Legacy-pin migration (#2390, ADR-0627).
 *
 * `uploadLegacyPins` takes its ids as arguments and reports what happened, so
 * the interesting rules — never lose a pin to a transient failure, never retry a
 * genuinely stale one forever — are testable without touching storage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { uploadLegacyPins, usePinMigration } from './usePinMigration';
import { PINNED_KEY } from './usePins';

// Hoisted fn — `expect(postMock)` would trip
// @typescript-eslint/unbound-method on the bare object method.
const postMock = vi.fn();
const getMock = vi.fn();
const deleteMock = vi.fn();
vi.mock('@/api/client', () => ({
  apiClient: {
    post: (...a: unknown[]) => postMock(...a) as Promise<unknown>,
    get: (...a: unknown[]) => getMock(...a) as Promise<unknown>,
    delete: (...a: unknown[]) => deleteMock(...a) as Promise<unknown>,
  },
}));

const toastError = vi.fn();
vi.mock('@/components/Toast', () => ({
  toast: {
    info: vi.fn(),
    error: (...a: unknown[]) => {
      toastError(...a);
    },
    action: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const LEGACY_PROJECTS_KEY = 'trueppm.rail.pinned';
const LEGACY_PROGRAMS_KEY = 'trueppm.rail.pinnedPrograms';
const SENTINEL_KEY = 'trueppm.rail.pinsMigrated';

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('uploadLegacyPins', () => {
  it('POSTs every local id, projects and programs alike', async () => {
    postMock.mockResolvedValue({ data: {} });
    const result = await uploadLegacyPins(['p1', 'p2'], ['g1']);

    expect(postMock).toHaveBeenCalledWith('/projects/p1/pin/');
    expect(postMock).toHaveBeenCalledWith('/projects/p2/pin/');
    expect(postMock).toHaveBeenCalledWith('/programs/g1/pin/');
    expect(result).toMatchObject({ migrated: 3, failed: false, capped: false });
  });

  it('treats 403/404 as migrated — the pin is stale, not failing', async () => {
    // The project was deleted or access was lost while the device sat idle.
    // Reporting `failed` would keep the sentinel unstamped and retry these two
    // dead ids on every single app load, forever.
    postMock
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockRejectedValueOnce({ response: { status: 403 } });

    const result = await uploadLegacyPins(['gone', 'forbidden'], []);
    expect(result.failed).toBe(false);
  });

  it('reports `failed` for a transient error so the keys are NOT cleared', async () => {
    postMock.mockRejectedValue({ response: { status: 500 } });
    const result = await uploadLegacyPins(['p1'], []);
    expect(result.failed).toBe(true);
    expect(result.migrated).toBe(0);
  });

  it('reports `capped` separately and keeps going', async () => {
    // Hitting the cap is not a failure of the run — the remaining ids should
    // still be attempted, and the user gets one explanatory toast.
    postMock
      .mockRejectedValueOnce({
        response: { status: 400, data: { code: 'pin_limit_reached' } },
      })
      .mockResolvedValueOnce({ data: {} });

    const result = await uploadLegacyPins(['over', 'under'], []);
    expect(result.capped).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.migrated).toBe(1);
  });

  it('is a no-op with no ids', async () => {
    const result = await uploadLegacyPins([], []);
    expect(postMock).not.toHaveBeenCalled();
    expect(result.migrated).toBe(0);
  });
});

describe('usePinMigration — when it runs at all', () => {
  it('does nothing while auth has not resolved (enabled=false)', async () => {
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(['p1']));
    renderHook(() => usePinMigration(false), { wrapper: makeWrapper(newClient()) });

    await waitFor(() => expect(postMock).not.toHaveBeenCalled());
    // The keys must survive — a later, enabled mount is what migrates them.
    expect(localStorage.getItem(LEGACY_PROJECTS_KEY)).not.toBeNull();
    expect(localStorage.getItem(SENTINEL_KEY)).toBeNull();
  });

  it('does nothing once the device sentinel is stamped', async () => {
    localStorage.setItem(SENTINEL_KEY, '1');
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(['p1']));
    renderHook(() => usePinMigration(true), { wrapper: makeWrapper(newClient()) });

    await waitFor(() => expect(postMock).not.toHaveBeenCalled());
  });

  it('stamps the sentinel without any POST when there is nothing to carry over', async () => {
    renderHook(() => usePinMigration(true), { wrapper: makeWrapper(newClient()) });

    await waitFor(() => expect(localStorage.getItem(SENTINEL_KEY)).toBe('1'));
    expect(postMock).not.toHaveBeenCalled();
  });

  it('does not restart a run that is already in flight', async () => {
    // A transient failure leaves the sentinel unstamped and the keys in place,
    // so only the in-memory guard can stop a re-render from double-POSTing.
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(['p1']));
    postMock.mockRejectedValue({ response: { status: 500 } });

    const { rerender } = renderHook(({ on }: { on: boolean }) => usePinMigration(on), {
      wrapper: makeWrapper(newClient()),
      initialProps: { on: true },
    });
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

    rerender({ on: false });
    rerender({ on: true });
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
  });
});

describe('usePinMigration — reading the legacy keys', () => {
  it('migrates both legacy keys and clears them on full success', async () => {
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(['p1', 'p2']));
    localStorage.setItem(LEGACY_PROGRAMS_KEY, JSON.stringify(['g1']));
    postMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    renderHook(() => usePinMigration(true), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(localStorage.getItem(SENTINEL_KEY)).toBe('1'));
    expect(localStorage.getItem(LEGACY_PROJECTS_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_PROGRAMS_KEY)).toBeNull();
    // The rail reads the server list, so it has to be told the list changed.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: PINNED_KEY });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('ignores a hand-edited or truncated value rather than failing app boot', async () => {
    localStorage.setItem(LEGACY_PROJECTS_KEY, '{not json');
    localStorage.setItem(LEGACY_PROGRAMS_KEY, JSON.stringify(['g1']));
    postMock.mockResolvedValue({ data: {} });

    renderHook(() => usePinMigration(true), { wrapper: makeWrapper(newClient()) });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/programs/g1/pin/');
  });

  it('ignores a value that parses to something other than an array', async () => {
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify({ p1: true }));
    localStorage.setItem(LEGACY_PROGRAMS_KEY, JSON.stringify(['g1']));
    postMock.mockResolvedValue({ data: {} });

    renderHook(() => usePinMigration(true), { wrapper: makeWrapper(newClient()) });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/programs/g1/pin/');
  });

  it('drops non-string entries from an otherwise usable array', async () => {
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(['p1', 42, null, 'p2']));
    postMock.mockResolvedValue({ data: {} });

    renderHook(() => usePinMigration(true), { wrapper: makeWrapper(newClient()) });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock).toHaveBeenCalledWith('/projects/p1/pin/');
    expect(postMock).toHaveBeenCalledWith('/projects/p2/pin/');
  });

  it('treats an empty-array key as nothing to carry over', async () => {
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify([]));
    localStorage.setItem(LEGACY_PROGRAMS_KEY, JSON.stringify([]));

    renderHook(() => usePinMigration(true), { wrapper: makeWrapper(newClient()) });

    await waitFor(() => expect(localStorage.getItem(SENTINEL_KEY)).toBe('1'));
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('usePinMigration — what the user sees when it goes wrong', () => {
  it('keeps the keys and leaves the sentinel unstamped after a transient failure', async () => {
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(['p1']));
    postMock.mockRejectedValue({ response: { status: 500 } });

    renderHook(() => usePinMigration(true), { wrapper: makeWrapper(newClient()) });

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    // Give the post-run bookkeeping a chance to (wrongly) fire before asserting.
    await waitFor(() => expect(localStorage.getItem(LEGACY_PROJECTS_KEY)).not.toBeNull());
    expect(localStorage.getItem(SENTINEL_KEY)).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('explains the cap with a toast — the rail would otherwise look fine', async () => {
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(['over']));
    postMock.mockRejectedValue({
      response: { status: 400, data: { code: 'pin_limit_reached' } },
    });

    renderHook(() => usePinMigration(true), { wrapper: makeWrapper(newClient()) });

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0][0]).toMatch(/100-pin limit/);
    // The cap is not a failure of the run — it must not retry forever.
    expect(localStorage.getItem(SENTINEL_KEY)).toBe('1');
  });

  it('does not invalidate the pinned list when every id turned out to be stale', async () => {
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(['gone']));
    postMock.mockRejectedValue({ response: { status: 404 } });
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    renderHook(() => usePinMigration(true), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(localStorage.getItem(SENTINEL_KEY)).toBe('1'));
    expect(invalidate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
