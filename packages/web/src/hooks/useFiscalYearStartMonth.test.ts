/**
 * useFiscalYearStartMonth unit tests (#784 coverage backfill).
 *
 * Thin selector over the workspace settings query: returns the configured
 * fiscal-year start month (1–12) for fiscal-quarter labelling on the schedule
 * timeline, defaulting to January (1) while the query is loading/errored or the
 * value is absent — so the quarter math always has a usable anchor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFiscalYearStartMonth } from './useFiscalYearStartMonth';
import { useWorkspaceSettings } from '@/features/settings/hooks/useWorkspaceSettings';

vi.mock('@/features/settings/hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: vi.fn(),
}));

const mockUseWorkspaceSettings = vi.mocked(useWorkspaceSettings);

function setData(data: { fiscalYearStartMonth?: number } | undefined) {
  mockUseWorkspaceSettings.mockReturnValue({
    data,
  } as unknown as ReturnType<typeof useWorkspaceSettings>);
}

beforeEach(() => {
  mockUseWorkspaceSettings.mockReset();
});

describe('useFiscalYearStartMonth', () => {
  it('returns the configured fiscal-year start month', () => {
    setData({ fiscalYearStartMonth: 4 });
    const { result } = renderHook(() => useFiscalYearStartMonth());
    expect(result.current).toBe(4);
  });

  it('returns 1 (January) while the workspace settings query is loading/errored', () => {
    setData(undefined);
    const { result } = renderHook(() => useFiscalYearStartMonth());
    expect(result.current).toBe(1);
  });

  it('returns 1 when the setting is absent from the loaded data', () => {
    setData({});
    const { result } = renderHook(() => useFiscalYearStartMonth());
    expect(result.current).toBe(1);
  });

  it('passes through January (1) unchanged when explicitly configured', () => {
    setData({ fiscalYearStartMonth: 1 });
    const { result } = renderHook(() => useFiscalYearStartMonth());
    expect(result.current).toBe(1);
  });
});
