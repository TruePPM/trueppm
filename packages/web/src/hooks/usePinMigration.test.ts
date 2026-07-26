/**
 * Legacy-pin migration (#2390, ADR-0627).
 *
 * `uploadLegacyPins` takes its ids as arguments and reports what happened, so
 * the interesting rules — never lose a pin to a transient failure, never retry a
 * genuinely stale one forever — are testable without touching storage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadLegacyPins } from './usePinMigration';

// Hoisted fn — `expect(postMock)` would trip
// @typescript-eslint/unbound-method on the bare object method.
const postMock = vi.fn();
vi.mock('@/api/client', () => ({
  apiClient: { post: (...a: unknown[]) => postMock(...a) as Promise<unknown> },
}));

beforeEach(() => {
  vi.clearAllMocks();
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
