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

const refetchWs = vi.fn();
const refetchProgram = vi.fn();

function setWorkspacePolicy(policy: WorkspaceSettings['calendarOverridePolicy']) {
  vi.mocked(useWorkspaceSettings).mockReturnValue({
    data: { calendarOverridePolicy: policy },
    isError: false,
    refetch: refetchWs,
  } as unknown as ReturnType<typeof useWorkspaceSettings>);
}

/** The page reads isError/refetch off both queries (#3351) — keep the mock shape in parity. */
function setWorkspaceFailed() {
  vi.mocked(useWorkspaceSettings).mockReturnValue({
    data: undefined,
    isError: true,
    refetch: refetchWs,
  } as unknown as ReturnType<typeof useWorkspaceSettings>);
}

function setProgramFailed() {
  vi.mocked(useProgram).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    refetch: refetchProgram,
  } as unknown as ReturnType<typeof useProgram>);
}

function renderPage() {
  return render(<ProgramCalendarPage />);
}

describe('ProgramCalendarPage', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(undefined);
    refetchWs.mockReset();
    refetchProgram.mockReset();
    vi.mocked(useUpdateProgram).mockReturnValue({
      mutateAsync,
    } as unknown as ReturnType<typeof useUpdateProgram>);
    vi.mocked(useProgram).mockReturnValue({
      data: makeProgram(),
      isLoading: false,
      isError: false,
      refetch: refetchProgram,
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

  // #2549: ProgramViewSet.update/partial_update is gated by IsProgramNotClosed,
  // so an Admin on a closed program must not see a live, saveable picker.
  it('renders the picker read-only for an Admin on a closed program, and says why', () => {
    vi.mocked(useProgram).mockReturnValue({
      data: makeProgram({ is_closed: true }),
      isLoading: false,
    } as unknown as ReturnType<typeof useProgram>);

    renderPage();
    expect(screen.queryByRole('combobox', { name: /Working calendar override/i })).toBeNull();
    expect(
      screen.getByLabelText(
        'Working calendar: Inherited from workspace, program is closed — reopen it to change this. View only.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle('This program is closed and cannot be modified. Reopen it first.'),
    ).toHaveTextContent(/Read-only — program closed/i);
  });

  // #3351 — the page destructured only `data` off useWorkspaceSettings, so a failed
  // GET /workspace/ left `ws === undefined` forever and the skeleton guard never
  // cleared: two placeholders pulsing with no error and no retry. Same defect
  // #3298 fixed one scope down on ProjectMethodologyPage. The skeleton assertion is
  // load-bearing — "an error is shown" would also pass if BOTH branches rendered.
  it('renders an error with Retry, not a perpetual skeleton, when the workspace GET fails', () => {
    setWorkspaceFailed();

    const { container } = renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(
      screen.getByText("Couldn't load this program's working calendar."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(container.querySelector('[class*="animate-pulse"]')).toBeNull();
    // The section heading must survive the error branch — <SettingsSection
    // aria-labelledby> targets the id this strip mints (rule 246).
    expect(screen.getByRole('heading', { name: 'Working calendar' })).toBeInTheDocument();
  });

  // The other half of the same guard: `programLoading` settles to false on a 500 but
  // `!program` stays true, so a dead program GET stalled the page identically.
  it('renders an error with Retry, not a perpetual skeleton, when the program GET fails', () => {
    setProgramFailed();

    const { container } = renderPage();

    expect(
      screen.getByText("Couldn't load this program's working calendar."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(container.querySelector('[class*="animate-pulse"]')).toBeNull();
  });

  it('retries only the query that actually failed', async () => {
    const user = userEvent.setup();
    setWorkspaceFailed();

    renderPage();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(refetchWs).toHaveBeenCalledTimes(1);
    // Re-running the program GET would evict a warm cache entry for nothing.
    expect(refetchProgram).not.toHaveBeenCalled();
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
        'Working calendar: Inherited from workspace, managed by the program manager or above. View only.',
      ),
    ).toBeInTheDocument();
  });
});
