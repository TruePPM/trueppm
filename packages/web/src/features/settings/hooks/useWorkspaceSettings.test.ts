import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
}));

// Mock apiClient before importing the hook so the module sees the mock.
vi.mock('@/api/client', () => ({
  apiClient: {
    get: getMock,
  },
}));

import { useWorkspaceSettings } from './useWorkspaceSettings';
import type { WorkspaceSettings } from '@/api/types';

const RAW_SETTINGS = {
  name: 'Acme Corp',
  subdomain: 'acme',
  timezone: 'America/Chicago',
  fiscal_year_start_month: 4,
  fiscal_year_start_day: 6,
  fiscal_year_start_display: 'April 6',
  work_week: [true, true, true, true, true, false, false],
  default_project_view: 'Board',
  allow_guests: true,
  public_sharing: false,
};

const EXPECTED: WorkspaceSettings = {
  name: 'Acme Corp',
  subdomain: 'acme',
  timezone: 'America/Chicago',
  fiscalYearStartMonth: 4,
  fiscalYearStartDay: 6,
  fiscalYearStartDisplay: 'April 6',
  workWeek: [true, true, true, true, true, false, false],
  defaultProjectView: 'Board',
  allowGuests: true,
  publicSharing: false,
};

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useWorkspaceSettings — snake→camel mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps snake_case fields to camelCase', async () => {
    getMock.mockResolvedValueOnce({
      data: RAW_SETTINGS,
    });

    const { result } = renderHook(() => useWorkspaceSettings(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(EXPECTED);
  });

  it('calls GET /workspace/', async () => {
    getMock.mockResolvedValueOnce({
      data: RAW_SETTINGS,
    });

    const { result } = renderHook(() => useWorkspaceSettings(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/workspace/');
  });
});
