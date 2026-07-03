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
  iteration_label: 'Sprint',
  iteration_label_override_policy: 'suggest',
  mc_history_enabled: true,
  mc_history_retention_cap: 100,
  mc_history_attribution_audience: 'ADMIN_OWNER',
  mc_history_override_policy: 'allow',
  task_duration_change_percent_policy: 'prorate',
  task_duration_change_percent_override_policy: 'suggest',
  methodology: 'HYBRID',
  methodology_override_policy: 'suggest',
  attachments_enabled: true,
  allowed_attachment_types: ['application/pdf', 'image/png'],
  attachments_override_policy: 'suggest',
  logo_url: '/api/v1/workspace/logo/?v=1700000000',
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
  iterationLabel: 'Sprint',
  iterationLabelOverridePolicy: 'suggest',
  mcHistoryEnabled: true,
  mcHistoryRetentionCap: 100,
  mcHistoryAttributionAudience: 'ADMIN_OWNER',
  mcHistoryOverridePolicy: 'allow',
  taskDurationChangePercentPolicy: 'prorate',
  taskDurationChangePercentOverridePolicy: 'suggest',
  methodology: 'HYBRID',
  methodologyOverridePolicy: 'suggest',
  attachmentsEnabled: true,
  allowedAttachmentTypes: ['application/pdf', 'image/png'],
  attachmentsOverridePolicy: 'suggest',
  logoUrl: '/api/v1/workspace/logo/?v=1700000000',
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
