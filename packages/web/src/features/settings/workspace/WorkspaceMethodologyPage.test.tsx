import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceMethodologyPage } from './WorkspaceMethodologyPage';
import { useSettingsSaveStore } from '../hooks/useSettingsSaveStore';
import type { WorkspaceSettings } from '@/api/types';

const useWorkspaceSettings = vi.fn();
const mutateAsync = vi.fn();

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => useWorkspaceSettings() as { data: WorkspaceSettings | undefined },
}));

vi.mock('../hooks/useUpdateWorkspaceSettings', () => ({
  useUpdateWorkspaceSettings: () => ({ mutateAsync }),
}));

const WS: WorkspaceSettings = {
  name: 'Acme',
  subdomain: 'acme',
  timezone: 'UTC',
  fiscalYearStartMonth: 1,
  fiscalYearStartDay: 1,
  fiscalYearStartDisplay: 'January 1',
  workWeek: [true, true, true, true, true, false, false],
  defaultProjectView: 'Overview',
  allowGuests: false,
  publicSharing: false,
  iterationLabel: 'Sprint',
  iterationLabelOverridePolicy: 'suggest',
  mcHistoryEnabled: true,
  mcHistoryRetentionCap: 100,
  mcHistoryAttributionAudience: 'ADMIN_OWNER',
  mcHistoryOverridePolicy: 'suggest',
  taskDurationChangePercentPolicy: 'keep',
  taskDurationChangePercentOverridePolicy: 'suggest',
  methodology: 'WATERFALL',
  methodologyOverridePolicy: 'suggest',
  attachmentsEnabled: true,
  allowedAttachmentTypes: ['application/pdf'],
  attachmentsOverridePolicy: 'suggest',
  calendar: null,
  calendarOverridePolicy: 'suggest',
  logoUrl: null,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WorkspaceMethodologyPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('WorkspaceMethodologyPage', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(undefined);
    useWorkspaceSettings.mockReturnValue({ data: WS });
    useSettingsSaveStore.getState().reset();
  });

  it('seeds the selected method and override policy from the workspace settings', () => {
    renderPage();
    expect(screen.getByRole('radio', { name: /Waterfall/i, checked: true })).toBeInTheDocument();
    // SUGGEST is the seeded override policy.
    expect(
      screen.getByRole('radio', { name: /Suggest \(recommended\)/i, checked: true }),
    ).toBeInTheDocument();
  });

  it('saves the chosen method and policy via PATCH', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('radio', { name: /Agile/i }));
    await user.click(screen.getByRole('radio', { name: /^Inherit/i }));
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith({
      methodology: 'AGILE',
      methodologyOverridePolicy: 'inherit',
    });
  });

  it('disables the Enterprise-only Enforce policy and never selects it', async () => {
    const user = userEvent.setup();
    renderPage();

    const enforce = screen.getByRole('radio', { name: /Enforce/i });
    expect(enforce).toBeDisabled();

    // The Enterprise gate must reach screen readers, not just the visual badge
    // (web-rule 265 / #2001): the disabled radio points at an sr-only hint node.
    const hintId = enforce.getAttribute('aria-describedby');
    expect(hintId).toBe('methodology-enforce-enterprise-hint');
    expect(document.getElementById(hintId as string)?.textContent).toMatch(
      /requires TruePPM Enterprise/i,
    );

    await user.click(enforce);
    // The click is a no-op — policy stays on the seeded SUGGEST, form stays clean.
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
    expect(
      screen.getByRole('radio', { name: /Suggest \(recommended\)/i, checked: true }),
    ).toBeInTheDocument();
  });
});
