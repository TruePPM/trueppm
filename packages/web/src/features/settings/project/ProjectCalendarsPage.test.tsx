import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectCalendarsPage } from './ProjectCalendarsPage';
import type {
  Calendar,
  ProjectCalendars,
  CalendarPreview,
} from '@/hooks/useProjectCalendars';
import { ROLE_ADMIN, ROLE_VIEWER } from '@/lib/roles';

const useProjectId = vi.fn();
const useProject = vi.fn();
const useCurrentUserRole = vi.fn();
const useBreakpoint = vi.fn(() => 'lg');
const useProjectCalendars = vi.fn();
const useCalendarLibrary = vi.fn();
const useCalendarPreview = vi.fn();
const useUpdateProjectCalendars = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));
// The base-calendar breadcrumb reads the project (#2009) only when the base is
// null (inherited); mocked so the page makes no real project fetch.
vi.mock('@/hooks/useProject', () => ({
  useProject: (id: string | null | undefined) => useProject(id) as unknown,
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: (id: string | undefined) => useCurrentUserRole(id) as unknown,
}));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => useBreakpoint() as unknown,
}));
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'community', isLoading: false }),
}));
// Partial-mock the calendar hooks module — keep the real `buildUpdatePayload`
// pure helper (exercised by the remove flow) and mock only the query hooks.
vi.mock('@/hooks/useProjectCalendars', async () => {
  const actual =
    await vi.importActual<typeof import('@/hooks/useProjectCalendars')>('@/hooks/useProjectCalendars');
  return {
    ...actual,
    useProjectCalendars: (id: string | null | undefined) => useProjectCalendars(id) as unknown,
    useCalendarLibrary: () => useCalendarLibrary() as unknown,
    useCalendarPreview: (id: string | null | undefined, s: string, e: string) =>
      useCalendarPreview(id, s, e) as unknown,
    useUpdateProjectCalendars: (id: string | null | undefined) =>
      useUpdateProjectCalendars(id) as unknown,
  };
});

function cal(id: string, name: string, exceptionCount = 0): Calendar {
  return {
    id,
    server_version: 1,
    name,
    working_days: 31,
    hours_per_day: 8,
    timezone: 'UTC',
    exceptions: Array.from({ length: exceptionCount }, (_, i) => ({
      id: `${id}-x${i}`,
      exc_start: '2026-11-11',
      exc_end: '2026-11-11',
      description: 'Holiday',
    })),
  };
}

const BASE = cal('base', 'Project calendar');
const HOL = cal('hol', 'US Federal Holidays 2026', 11);
// A second base-eligible library calendar so a base swap targets a distinct id.
const ALT = cal('alt', 'Night shift');

const APPLIED: ProjectCalendars = {
  base: BASE,
  overlays: [{ layer_id: 'L1', role: 'holidays', sort_order: 1, calendar: HOL }],
  applied: [
    { layer_id: null, role: 'project', sort_order: 0, calendar: BASE },
    { layer_id: 'L1', role: 'holidays', sort_order: 1, calendar: HOL },
  ],
};

const PREVIEW: CalendarPreview = {
  start: '2026-11-01',
  end: '2027-01-31',
  days: [
    { date: '2026-11-02', working: true, sources: [] },
    { date: '2026-11-07', working: false, sources: [{ role: 'project', calendar_id: 'base', name: 'Project calendar' }] },
    { date: '2026-11-11', working: false, sources: [{ role: 'holidays', calendar_id: 'hol', name: 'US Federal Holidays 2026' }] },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/p-1/settings/calendars']}>
        <ProjectCalendarsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function loadedHooks(role: number, mutate = vi.fn()) {
  useCurrentUserRole.mockReturnValue({ role, isLoading: false });
  // Base override set → source 'project'; no inherited breadcrumb shown.
  useProject.mockReturnValue({
    data: { calendar: 'base', calendar_source: 'project', effective_calendar: null },
  });
  useProjectCalendars.mockReturnValue({
    data: APPLIED,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  useCalendarLibrary.mockReturnValue({ data: [BASE, HOL, ALT], isLoading: false });
  useCalendarPreview.mockReturnValue({
    data: PREVIEW,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  });
  useUpdateProjectCalendars.mockReturnValue({ mutate, isPending: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectId.mockReturnValue('p-1');
  useBreakpoint.mockReturnValue('lg');
  // Unconditional default so the loading/error tests (which don't call
  // loadedHooks) don't crash destructuring the base-breadcrumb project read.
  useProject.mockReturnValue({ data: undefined });
});

describe('ProjectCalendarsPage', () => {
  it('renders the applied stack and the effective-working-time preview when loaded', () => {
    loadedHooks(ROLE_ADMIN);
    renderPage();

    // Applied stack shows the editable base row and the holiday overlay. The base
    // name is the selected option of the base picker; the holiday name appears both
    // as the overlay row and a base-picker option, so assert the overlay via its
    // Remove control (below) rather than by text.
    expect(screen.getByText('Base')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Working calendar override' })).toHaveValue('base');

    // The preview strip + its data-backed summary render.
    expect(screen.getByText('Effective working time')).toBeInTheDocument();
    // One of the three preview days (Nov 11) is an overlay-blocked working day.
    expect(screen.getByText(/loses/)).toHaveTextContent(/loses\s+1\s+working day\b/);

    // Scheduler+ sees the edit affordances.
    expect(screen.getByRole('button', { name: 'Add calendar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove US Federal Holidays 2026/ })).toBeInTheDocument();
  });

  it('removing an overlay calls the update mutation with the base preserved and the layer dropped', () => {
    const mutate = vi.fn();
    loadedHooks(ROLE_ADMIN, mutate);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Remove US Federal Holidays 2026/ }));
    expect(mutate).toHaveBeenCalledTimes(1);
    // buildUpdatePayload (real) drops L1 and keeps the base.
    expect(mutate.mock.calls[0][0]).toEqual({ base_calendar_id: 'base', overlays: [] });
  });

  it('opens the add-calendar picker for a Scheduler+', () => {
    loadedHooks(ROLE_ADMIN);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    expect(screen.getByRole('dialog', { name: 'Add calendars to this project' })).toBeInTheDocument();
  });

  it('renders read-only for a Viewer: view-only note, no add/remove controls', () => {
    loadedHooks(ROLE_VIEWER);
    renderPage();

    expect(screen.getByText(/You have view-only access/)).toBeInTheDocument();
    expect(screen.getByText(/Ask a Scheduler or Admin/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add calendar' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Remove US Federal Holidays 2026/ }),
    ).not.toBeInTheDocument();
  });

  // ── Base calendar editor (#2009, ADR-0441) ──────────────────────────────
  // The base FK is now written only here; the General page is a read-only summary.

  it('changing the base calendar PUTs base_calendar_id with overlays preserved (#2009)', () => {
    const mutate = vi.fn();
    loadedHooks(ROLE_ADMIN, mutate);
    renderPage();

    const picker = screen.getByRole('combobox', { name: 'Working calendar override' });
    fireEvent.change(picker, { target: { value: 'alt' } });

    expect(mutate).toHaveBeenCalledTimes(1);
    // buildBaseUpdatePayload (real): new base, existing holiday overlay kept.
    expect(mutate.mock.calls[0][0]).toEqual({
      base_calendar_id: 'alt',
      overlays: [{ calendar_id: 'hol', role: 'holidays' }],
    });
  });

  it('Inherit clears the base to null, preserving overlays (#2009)', () => {
    const mutate = vi.fn();
    loadedHooks(ROLE_ADMIN, mutate);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Inherit from workspace' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      base_calendar_id: null,
      overlays: [{ calendar_id: 'hol', role: 'holidays' }],
    });
  });

  it('re-selecting the current base does not fire a redundant PUT (#2009)', () => {
    const mutate = vi.fn();
    loadedHooks(ROLE_ADMIN, mutate);
    renderPage();

    // The base is already 'base' — selecting it again is a no-op.
    fireEvent.change(screen.getByRole('combobox', { name: 'Working calendar override' }), {
      target: { value: 'base' },
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows the inherited-base breadcrumb (read-only summary) when the base is null (#2009)', () => {
    loadedHooks(ROLE_ADMIN);
    // No own base override → inherited from the workspace.
    useProjectCalendars.mockReturnValue({
      data: { ...APPLIED, base: null },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useProject.mockReturnValue({
      data: {
        calendar: null,
        calendar_source: 'workspace',
        effective_calendar: { id: 'ws', name: 'Workspace default', working_days: 31, hours_per_day: 8 },
      },
    });
    renderPage();

    // Inherit is the pressed state; the breadcrumb names the resolving scope.
    expect(screen.getByRole('button', { name: 'Inherit from workspace' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText(/Inherited from workspace \(Workspace default\)/i)).toBeInTheDocument();
  });

  it('renders the base as a read-only summary for a Viewer — no picker or toggle (#2009)', () => {
    loadedHooks(ROLE_VIEWER);
    renderPage();

    expect(
      screen.queryByRole('combobox', { name: 'Working calendar override' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Inherit from workspace' }),
    ).not.toBeInTheDocument();
    // The base name still shows read-only.
    expect(screen.getByText('Project calendar')).toBeInTheDocument();
  });

  it('shows the loading skeleton while the applied set is loading', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN, isLoading: false });
    useProjectCalendars.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: vi.fn() });
    useCalendarLibrary.mockReturnValue({ data: [], isLoading: true });
    useCalendarPreview.mockReturnValue({ data: undefined, isFetching: true, error: null, refetch: vi.fn() });
    useUpdateProjectCalendars.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderPage();
    expect(screen.getByText('Loading calendars…')).toBeInTheDocument();
  });

  it('shows the branded error surface with a retry when the applied load fails', () => {
    const refetch = vi.fn();
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN, isLoading: false });
    useProjectCalendars.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
      refetch,
    });
    useCalendarLibrary.mockReturnValue({ data: [], isLoading: false });
    useCalendarPreview.mockReturnValue({ data: undefined, isFetching: false, error: null, refetch: vi.fn() });
    useUpdateProjectCalendars.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderPage();

    expect(screen.getByText("Couldn't load working calendars")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces an inline preview error without tearing down the applied stack', () => {
    const refetch = vi.fn();
    useCurrentUserRole.mockReturnValue({ role: ROLE_ADMIN, isLoading: false });
    useProjectCalendars.mockReturnValue({ data: APPLIED, isLoading: false, error: null, refetch: vi.fn() });
    useCalendarLibrary.mockReturnValue({ data: [BASE, HOL], isLoading: false });
    useCalendarPreview.mockReturnValue({
      data: undefined,
      isFetching: false,
      error: new Error('preview boom'),
      refetch,
    });
    useUpdateProjectCalendars.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderPage();

    // Applied stack still renders; the preview pane shows its own retry.
    expect(screen.getByText('Project calendar')).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load the working-time preview/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('alert').querySelector('button') as HTMLButtonElement);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
