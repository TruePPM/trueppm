import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLE_ADMIN, ROLE_MEMBER } from '@/lib/roles';
import type { Program, WorkspaceSettings } from '@/api/types';
import { ProgramCalendarPage } from './ProgramCalendarPage';
import { useSettingsSaveStore } from '../hooks/useSettingsSaveStore';

vi.mock('react-router', () => ({ useParams: () => ({ programId: 'p1' }) }));
vi.mock('@/hooks/useProgram', () => ({ useProgram: vi.fn() }));
vi.mock('@/hooks/useProgramMutations', () => ({ useUpdateProgram: vi.fn() }));
vi.mock('../hooks/useWorkspaceSettings', () => ({ useWorkspaceSettings: vi.fn() }));
vi.mock('@/hooks/useCalendars', () => ({ useCalendars: vi.fn() }));

import { useProgram } from '@/hooks/useProgram';
import { useUpdateProgram } from '@/hooks/useProgramMutations';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useCalendars } from '@/hooks/useCalendars';

const mutateAsync = vi.fn();

const CALENDARS = [
  { id: 'cal-eu', name: 'EU Holidays', working_days: 31, hours_per_day: 8 },
  { id: 'cal-us', name: 'US Holidays', working_days: 31, hours_per_day: 8 },
];

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p1',
    name: 'Apollo',
    my_role: ROLE_ADMIN,
    calendar: null,
    effective_calendar: null,
    inherited_calendar: null,
    calendar_source: 'system_default',
    ...overrides,
  } as unknown as Program;
}

function setWorkspacePolicy(policy: WorkspaceSettings['calendarOverridePolicy']) {
  vi.mocked(useWorkspaceSettings).mockReturnValue({
    data: { calendarOverridePolicy: policy },
  } as unknown as ReturnType<typeof useWorkspaceSettings>);
}

function renderPage() {
  return render(<ProgramCalendarPage />);
}

describe('ProgramCalendarPage', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(undefined);
    vi.mocked(useUpdateProgram).mockReturnValue({
      mutateAsync,
    } as unknown as ReturnType<typeof useUpdateProgram>);
    vi.mocked(useProgram).mockReturnValue({
      data: makeProgram(),
      isLoading: false,
    } as unknown as ReturnType<typeof useProgram>);
    vi.mocked(useCalendars).mockReturnValue({
      calendars: CALENDARS,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useCalendars>);
    setWorkspacePolicy('suggest');
    useSettingsSaveStore.getState().reset();
  });

  it('shows the inheriting-from-workspace banner and an editable picker for an admin', () => {
    renderPage();
    expect(screen.getByText(/Inherited from the workspace default/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Working calendar override/i })).toBeEnabled();
  });

  it('saves a calendar override via PATCH', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(
      screen.getByRole('combobox', { name: /Working calendar override/i }),
      'cal-us',
    );
    expect(useSettingsSaveStore.getState().dirty).toBe(true);

    await act(async () => {
      await useSettingsSaveStore.getState().triggerSave();
    });

    expect(mutateAsync).toHaveBeenCalledWith({ programId: 'p1', patch: { calendar: 'cal-us' } });
  });

  it('locks the picker read-only when the workspace policy is INHERIT', () => {
    setWorkspacePolicy('inherit');
    vi.mocked(useProgram).mockReturnValue({
      data: makeProgram({
        effective_calendar: {
          id: 'cal-eu',
          name: 'EU Holidays',
          working_days: 31,
          hours_per_day: 8,
          timezone: 'UTC',
          holiday_count: 3,
        },
        calendar_source: 'workspace',
      }),
      isLoading: false,
    } as unknown as ReturnType<typeof useProgram>);

    renderPage();

    expect(screen.getByText(/requires every program and project to use its default/i)).toBeInTheDocument();
    // No interactive picker — the effective calendar is shown read-only, locked by policy.
    expect(screen.queryByRole('combobox', { name: /Working calendar override/i })).toBeNull();
    expect(
      screen.getByLabelText('Working calendar: EU Holidays, locked by workspace policy. View only.'),
    ).toBeInTheDocument();
  });

  it('renders the picker read-only for a non-admin member', () => {
    vi.mocked(useProgram).mockReturnValue({
      data: makeProgram({ my_role: ROLE_MEMBER }),
      isLoading: false,
    } as unknown as ReturnType<typeof useProgram>);

    renderPage();
    expect(screen.queryByRole('combobox', { name: /Working calendar override/i })).toBeNull();
    expect(
      screen.getByLabelText(
        'Working calendar: Inherited from workspace, managed by the program admin. View only.',
      ),
    ).toBeInTheDocument();
  });
});
