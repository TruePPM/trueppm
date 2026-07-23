import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceCalendarPage } from './WorkspaceCalendarPage';
import { useSettingsSaveStore } from '../hooks/useSettingsSaveStore';
import type { WorkspaceSettings } from '@/api/types';

const useWorkspaceSettings = vi.fn();
const mutateAsync = vi.fn();
const useCalendars = vi.fn();

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => useWorkspaceSettings() as { data: WorkspaceSettings | undefined },
}));

vi.mock('../hooks/useUpdateWorkspaceSettings', () => ({
  useUpdateWorkspaceSettings: () => ({ mutateAsync }),
}));

vi.mock('@/hooks/useCalendars', () => ({
  useCalendars: () => useCalendars() as ReturnType<typeof import('@/hooks/useCalendars').useCalendars>,
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
  publicSharingOverridePolicy: 'suggest',
  iterationLabel: 'Sprint',
  iterationLabelOverridePolicy: 'suggest',
  mcHistoryEnabled: true,
  mcHistoryRetentionCap: 100,
  mcHistoryAttributionAudience: 'ADMIN_OWNER',
  mcHistoryOverridePolicy: 'suggest',
  taskDurationChangePercentPolicy: 'keep',
  taskDurationChangePercentOverridePolicy: 'suggest',
  estimationScale: 'fibonacci',
  methodology: 'WATERFALL',
  methodologyOverridePolicy: 'suggest',
  attachmentsEnabled: true,
  allowedAttachmentTypes: ['application/pdf'],
  attachmentsOverridePolicy: 'suggest',
  calendar: null,
  calendarOverridePolicy: 'suggest',
  logoUrl: null,
};

const CALENDARS = [
  { id: 'cal-eu', name: 'EU Holidays', working_days: 31, hours_per_day: 8 },
  { id: 'cal-us', name: 'US Holidays', working_days: 31, hours_per_day: 8 },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WorkspaceCalendarPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('WorkspaceCalendarPage', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(undefined);
    useWorkspaceSettings.mockReturnValue({ data: WS });
    useCalendars.mockReturnValue({ calendars: CALENDARS, isLoading: false, error: null });
    useSettingsSaveStore.getState().reset();
  });

  it('seeds the system default calendar and SUGGEST policy from the workspace settings', () => {
    renderPage();
    // null calendar → system-default option is selected on the picker.
    expect(screen.getByRole('combobox', { name: /Default working calendar/i })).toHaveValue('');
    expect(
      screen.getByRole('radio', { name: /Suggest \(recommended\)/i, checked: true }),
    ).toBeInTheDocument();
  });

  it('saves the chosen calendar and override policy via PATCH', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(
      screen.getByRole('combobox', { name: /Default working calendar/i }),
      'cal-eu',
    );
    await user.click(screen.getByRole('radio', { name: /^Inherit/i }));
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith({
      calendar: 'cal-eu',
      calendarOverridePolicy: 'inherit',
    });
  });

  it('renders FieldHelp ⓘ triggers on the calendar sections (web-rule 263 / #2266)', () => {
    renderPage();
    expect(
      screen.getByRole('button', { name: 'About the Default calendar options' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'About the Override policy options' }),
    ).toBeInTheDocument();
  });

  it('disables the Enterprise-only Enforce policy and never selects it', async () => {
    const user = userEvent.setup();
    renderPage();

    const enforce = screen.getByRole('radio', { name: /Enforce/i });
    expect(enforce).toBeDisabled();
    expect(enforce).toHaveAttribute('aria-describedby', 'calendar-enforce-enterprise-hint');

    await user.click(enforce);
    // The click is a no-op — policy stays on the seeded SUGGEST, form stays clean.
    expect(useSettingsSaveStore.getState().dirty).toBe(false);
    expect(
      screen.getByRole('radio', { name: /Suggest \(recommended\)/i, checked: true }),
    ).toBeInTheDocument();
  });
});
