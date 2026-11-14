import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { ProjectCalendarsPage } from './ProjectCalendarsPage';
import type {
  Calendar,
  ProjectCalendars,
  CalendarPreview,
} from '@/hooks/useProjectCalendars';
import { ROLE_ADMIN, ROLE_VIEWER } from '@/lib/roles';
import { localTodayIso } from '@/lib/localDate';
import {
  buildMonthGrids,
  formatFullDate,
  monthWindow,
  shiftAnchor,
  spanWindow,
} from './calendarDisplay';

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

// ── Additional branch coverage (#2459) ───────────────────────────────────────
// Everything below drives a conditional in the page that the suite above never
// reached: the mobile layout, the pager, library load/error states, the empty
// nudge, the in-flight (saving) state, and each day-cell classification.

// Local calendar day, not `toISOString().slice(0, 10)` (UTC) — the component
// under test now rings the viewer's local day (#2479), so the fixture and the
// assertion below must agree on the same day the component actually computes.
// Using the UTC day here would make this constant, and the assertion built on
// it, pass in CI (which runs in UTC) while still describing the pre-fix
// behavior — see the dedicated TZ-pinned boundary test further down for the
// case where local and UTC actually disagree.
const TODAY_ISO_NOW = localTodayIso();

/** A month six months out — guaranteed not to be the current month, so the
 *  "today" ring assertions below can't collide with the rich-day fixtures. */
const FAR = (() => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 6, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
})();
const far = (day: number) =>
  `${FAR.year}-${String(FAR.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const SRC_BASE = { role: 'project' as const, calendar_id: 'base', name: 'Project calendar' };
const SRC_HOL = { role: 'holidays' as const, calendar_id: 'hol', name: 'US Federal Holidays 2026' };
const SRC_WS = { role: 'workspace' as const, calendar_id: 'ws', name: 'Winter shutdown' };

/** One of every day classification the grid can render. */
const RICH_PREVIEW: CalendarPreview = {
  start: far(1),
  end: far(9),
  days: [
    { date: far(2), working: true, sources: [] },
    { date: far(3), working: false, sources: [SRC_BASE] },
    { date: far(4), working: false, sources: [SRC_HOL] },
    { date: far(5), working: false, sources: [SRC_WS] },
    { date: far(6), working: false, sources: [SRC_HOL, SRC_WS] },
  ],
};

function overrideCalendars(data: ProjectCalendars) {
  useProjectCalendars.mockReturnValue({ data, isLoading: false, error: null, refetch: vi.fn() });
}

describe('ProjectCalendarsPage — role gating', () => {
  it('shows neither the view-only note nor edit controls while the role is unknown', () => {
    loadedHooks(ROLE_ADMIN);
    useCurrentUserRole.mockReturnValue({ role: null, isLoading: true });
    renderPage();

    expect(screen.queryByText(/You have view-only access/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add calendar' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Working calendar override' }),
    ).not.toBeInTheDocument();
  });
});

describe('ProjectCalendarsPage — base picker library states', () => {
  it('disables the override picker with a loading placeholder while the library loads', () => {
    loadedHooks(ROLE_ADMIN);
    useCalendarLibrary.mockReturnValue({ data: undefined, isLoading: true });
    renderPage();

    const picker = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Working calendar override',
    });
    expect(picker).toBeDisabled();
    expect(within(picker).getByRole('option', { name: 'Loading calendars…' })).toBeInTheDocument();
  });

  it('disables the override picker and says so when the library fetch fails', () => {
    loadedHooks(ROLE_ADMIN);
    useCalendarLibrary.mockReturnValue({ data: [], isLoading: false, error: new Error('nope') });
    renderPage();

    const picker = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Working calendar override',
    });
    expect(picker).toBeDisabled();
    expect(
      within(picker).getByRole('option', { name: "Couldn't load calendars" }),
    ).toBeInTheDocument();
  });

  it('keeps the current override selectable when it is missing from the library list', () => {
    loadedHooks(ROLE_ADMIN);
    // The library no longer carries the project's base calendar.
    useCalendarLibrary.mockReturnValue({ data: [HOL, ALT], isLoading: false });
    renderPage();

    const picker = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Working calendar override',
    });
    expect(within(picker).getByRole('option', { name: 'Current override' })).toBeInTheDocument();
    expect(picker.value).toBe('base');
  });

  it('disables both base controls while a calendar write is in flight', () => {
    loadedHooks(ROLE_ADMIN);
    useUpdateProjectCalendars.mockReturnValue({ mutate: vi.fn(), isPending: true });
    renderPage();

    expect(screen.getByRole('button', { name: 'Inherit from workspace' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Working calendar override' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Remove US Federal Holidays 2026/ })).toBeDisabled();
  });

  it('omits the breadcrumb when the base is inherited but the project read has no source', () => {
    loadedHooks(ROLE_ADMIN);
    overrideCalendars({ ...APPLIED, base: null });
    useProject.mockReturnValue({ data: { calendar: null } });
    renderPage();

    expect(screen.getByRole('button', { name: 'Inherit from workspace' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText(/Inherited from/)).not.toBeInTheDocument();
  });

  it('falls back to generic inherit copy for a Viewer with no breadcrumb', () => {
    loadedHooks(ROLE_VIEWER);
    overrideCalendars({ ...APPLIED, base: null });
    useProject.mockReturnValue({ data: { calendar: null } });
    renderPage();

    expect(screen.getByText('Inherited calendar')).toBeInTheDocument();
    expect(screen.getByText('Inherits the program or workspace default.')).toBeInTheDocument();
  });

  it('shows the resolved inherited breadcrumb for a Viewer when the project names a source', () => {
    loadedHooks(ROLE_VIEWER);
    overrideCalendars({ ...APPLIED, base: null });
    useProject.mockReturnValue({
      data: {
        calendar: null,
        calendar_source: 'program',
        effective_calendar: {
          id: 'pg',
          name: 'Program calendar',
          working_days: 31,
          hours_per_day: 8,
        },
      },
    });
    renderPage();

    expect(screen.getByText(/Inherited from program \(Program calendar\)/)).toBeInTheDocument();
  });
});

describe('ProjectCalendarsPage — overlay stack', () => {
  it('adding calendars from the picker PUTs the new overlay alongside the existing stack', () => {
    const mutate = vi.fn();
    loadedHooks(ROLE_ADMIN, mutate);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    const picker = screen.getByRole('dialog', { name: 'Add calendars to this project' });
    fireEvent.click(within(picker).getByRole('option', { name: /Night shift/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Add 1 calendar' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      base_calendar_id: 'base',
      overlays: [
        { calendar_id: 'hol', role: 'holidays' },
        { calendar_id: 'alt', role: 'holidays' },
      ],
    });
  });

  it('already-applied library calendars are not re-addable from the picker', () => {
    loadedHooks(ROLE_ADMIN);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    const picker = screen.getByRole('dialog', { name: 'Add calendars to this project' });
    expect(within(picker).getByRole('option', { name: /US Federal Holidays 2026/ })).toBeDisabled();
    expect(within(picker).getByRole('option', { name: /Night shift/ })).toBeEnabled();
  });

  it('toggling the Add calendar button closes an open picker', () => {
    loadedHooks(ROLE_ADMIN);
    renderPage();

    const trigger = screen.getByRole('button', { name: 'Add calendar' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('dialog', { name: 'Add calendars to this project' }),
    ).not.toBeInTheDocument();
  });

  it('offers no remove control for an overlay the server sent without a layer id', () => {
    loadedHooks(ROLE_ADMIN);
    overrideCalendars({
      base: BASE,
      overlays: [{ layer_id: null, role: 'holidays', sort_order: 1, calendar: HOL }],
      applied: [
        { layer_id: null, role: 'project', sort_order: 0, calendar: BASE },
        { layer_id: null, role: 'holidays', sort_order: 1, calendar: HOL },
      ],
    });
    renderPage();

    expect(
      screen.queryByRole('button', { name: /Remove US Federal Holidays 2026/ }),
    ).not.toBeInTheDocument();
  });

  it('nudges a Scheduler to add a holiday calendar when only the base is applied', () => {
    loadedHooks(ROLE_ADMIN);
    overrideCalendars({
      base: BASE,
      overlays: [],
      applied: [{ layer_id: null, role: 'project', sort_order: 0, calendar: BASE }],
    });
    renderPage();

    // Singular noun for a one-calendar stack.
    expect(screen.getByText('1 calendar')).toBeInTheDocument();
    expect(screen.getByText('No holiday calendars applied')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Add a holidays calendar/ }));
    expect(
      screen.getByRole('dialog', { name: 'Add calendars to this project' }),
    ).toBeInTheDocument();
  });

  it('hides the empty nudge from a Viewer even with no holiday overlay', () => {
    loadedHooks(ROLE_VIEWER);
    overrideCalendars({
      base: BASE,
      overlays: [],
      applied: [{ layer_id: null, role: 'project', sort_order: 0, calendar: BASE }],
    });
    renderPage();

    expect(screen.queryByText('No holiday calendars applied')).not.toBeInTheDocument();
  });

  it('labels a workspace overlay with the shutdown chip', () => {
    loadedHooks(ROLE_ADMIN);
    const shutdown = cal('ws', 'Winter shutdown', 2);
    overrideCalendars({
      base: BASE,
      overlays: [{ layer_id: 'L9', role: 'workspace', sort_order: 1, calendar: shutdown }],
      applied: [
        { layer_id: null, role: 'project', sort_order: 0, calendar: BASE },
        { layer_id: 'L9', role: 'workspace', sort_order: 1, calendar: shutdown },
      ],
    });
    renderPage();

    expect(screen.getByText('workspace')).toBeInTheDocument();
    expect(screen.getByText('2 shutdowns')).toBeInTheDocument();
    expect(screen.getByText('2 calendars')).toBeInTheDocument();
  });
});

describe('ProjectCalendarsPage — preview strip', () => {
  it('pages the desktop preview a quarter at a time', () => {
    loadedHooks(ROLE_ADMIN);
    renderPage();

    const now = new Date();
    const start = { year: now.getUTCFullYear(), month: now.getUTCMonth() };
    const initial = spanWindow(start.year, start.month, 3);
    expect(useCalendarPreview).toHaveBeenLastCalledWith('p-1', initial.start, initial.end);

    fireEvent.click(screen.getByRole('button', { name: 'Next quarter' }));
    const next = shiftAnchor(start, 3);
    const nextWindow = spanWindow(next.year, next.month, 3);
    expect(useCalendarPreview).toHaveBeenLastCalledWith('p-1', nextWindow.start, nextWindow.end);

    fireEvent.click(screen.getByRole('button', { name: 'Previous quarter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous quarter' }));
    const prev = shiftAnchor(start, -3);
    const prevWindow = spanWindow(prev.year, prev.month, 3);
    expect(useCalendarPreview).toHaveBeenLastCalledWith('p-1', prevWindow.start, prevWindow.end);
  });

  it('disables both pager buttons while the preview is errored', () => {
    loadedHooks(ROLE_ADMIN);
    useCalendarPreview.mockReturnValue({
      data: undefined,
      isFetching: false,
      error: new Error('boom'),
      refetch: vi.fn(),
    });
    renderPage();

    expect(screen.getByRole('button', { name: 'Previous quarter' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next quarter' })).toBeDisabled();
  });

  it('shows a grid skeleton — no months, no loss summary — on the first preview fetch', () => {
    loadedHooks(ROLE_ADMIN);
    useCalendarPreview.mockReturnValue({
      data: undefined,
      isFetching: true,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();

    expect(screen.queryByText(/loses/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The header (range label + pager) stays put while the grid loads.
    expect(screen.getByRole('button', { name: 'Next quarter' })).toBeEnabled();
  });

  it('pluralizes the lost-working-days summary', () => {
    loadedHooks(ROLE_ADMIN);
    useCalendarPreview.mockReturnValue({
      data: {
        start: far(1),
        end: far(9),
        days: [
          { date: far(4), working: false, sources: [SRC_HOL] },
          { date: far(5), working: false, sources: [SRC_WS] },
        ],
      },
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();

    expect(screen.getByText(/loses/)).toHaveTextContent(/loses\s+2\s+working days\b/);
  });

  it('renders each day classification with its own glyph and accessible date label', () => {
    loadedHooks(ROLE_ADMIN);
    useCalendarPreview.mockReturnValue({
      data: RICH_PREVIEW,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();

    // Working day: plain day number, no aria-label (nothing to announce).
    const working = screen.getByTitle(formatFullDate(far(2)));
    expect(working).toHaveTextContent('2');
    expect(working).not.toHaveAttribute('aria-label');

    // Weekend (base calendar): keeps its day number but is announced.
    const weekend = screen.getByTitle(`${formatFullDate(far(3))} — Project calendar`);
    expect(weekend).toHaveTextContent('3');
    expect(weekend).toHaveAttribute('aria-label');

    // Holiday and shutdown swap the number for a color-blind-safe letter.
    expect(screen.getByTitle(`${formatFullDate(far(4))} — US Federal Holidays 2026`)).toHaveTextContent('H');
    expect(screen.getByTitle(`${formatFullDate(far(5))} — Winter shutdown`)).toHaveTextContent('S');

    // Two calendars block the same day — shutdown wins the glyph.
    const multi = screen.getByTitle(
      `${formatFullDate(far(6))} — US Federal Holidays 2026, Winter shutdown`,
    );
    expect(multi).toHaveTextContent('S');
  });

  it('rings only today in the preview grid', () => {
    loadedHooks(ROLE_ADMIN);
    const other = TODAY_ISO_NOW.endsWith('01')
      ? `${TODAY_ISO_NOW.slice(0, 8)}02`
      : `${TODAY_ISO_NOW.slice(0, 8)}01`;
    useCalendarPreview.mockReturnValue({
      data: {
        start: TODAY_ISO_NOW,
        end: TODAY_ISO_NOW,
        days: [
          { date: TODAY_ISO_NOW, working: true, sources: [] },
          { date: other, working: true, sources: [] },
        ],
      },
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();

    expect(screen.getByTitle(formatFullDate(TODAY_ISO_NOW)).className).toContain(
      'outline-brand-primary',
    );
    expect(screen.getByTitle(formatFullDate(other)).className).not.toContain(
      'outline-brand-primary',
    );
  });

  // ── UTC/local day-boundary regression (#2479) ─────────────────────────────
  // CI runs in UTC, so the test above (and the pre-fix `toISOString()`-derived
  // component code) can't distinguish "local day" from "UTC day" — they always
  // agree there. Pin a non-UTC system timezone AND a fixed instant where the
  // UTC calendar day and the local calendar day genuinely differ, then assert
  // the ring lands on the *local* day. Deriving the expected day from
  // `localTodayIso()`/local `Date` components (not `Date.UTC`/`toISOString()`)
  // is what makes this actually exercise the fix rather than re-encode the bug.
  describe('today ring — local vs UTC day boundary', () => {
    // eslint-disable-next-line no-undef -- `process` is available in the vitest (node) runtime; test files only load browser globals in eslint.
    const ORIGINAL_TZ = process.env.TZ;

    beforeAll(() => {
      // eslint-disable-next-line no-undef -- `process` is available in the vitest (node) runtime; test files only load browser globals in eslint.
      process.env.TZ = 'America/New_York';
    });

    afterAll(() => {
      // eslint-disable-next-line no-undef -- `process` is available in the vitest (node) runtime; test files only load browser globals in eslint.
      process.env.TZ = ORIGINAL_TZ;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rings the local calendar day, not the UTC day, when they disagree near midnight', () => {
      // 2026-01-15T04:30:00Z is 2026-01-14 23:30 in America/New_York (EST,
      // UTC-5 — plain winter standard time, no DST transition nearby).
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T04:30:00Z'));

      const localDay = localTodayIso();
      const utcDay = new Date().toISOString().slice(0, 10);
      // Sanity-check the fixture premise: if these ever agree, the test proves
      // nothing about UTC vs. local — fail loudly instead of passing vacuously.
      expect(localDay).not.toBe(utcDay);
      expect(localDay).toBe('2026-01-14');
      expect(utcDay).toBe('2026-01-15');

      loadedHooks(ROLE_ADMIN);
      useCalendarPreview.mockReturnValue({
        data: {
          start: localDay,
          end: utcDay,
          days: [
            { date: localDay, working: true, sources: [] },
            { date: utcDay, working: true, sources: [] },
          ],
        },
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      });
      renderPage();

      expect(screen.getByTitle(formatFullDate(localDay)).className).toContain(
        'outline-brand-primary',
      );
      expect(screen.getByTitle(formatFullDate(utcDay)).className).not.toContain(
        'outline-brand-primary',
      );
    });
  });
});

describe('ProjectCalendarsPage — mobile layout', () => {
  beforeEach(() => {
    useBreakpoint.mockReturnValue('sm');
  });

  it('previews a single month with a month pager and no month heading', () => {
    loadedHooks(ROLE_ADMIN);
    useCalendarPreview.mockReturnValue({
      data: RICH_PREVIEW,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();

    const now = new Date();
    const w = monthWindow(now.getUTCFullYear(), now.getUTCMonth());
    expect(useCalendarPreview).toHaveBeenLastCalledWith('p-1', w.start, w.end);

    expect(screen.getByRole('button', { name: 'Previous month' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next quarter' })).not.toBeInTheDocument();

    // The grid's own month caption is suppressed — the strip header carries it.
    const grids = buildMonthGrids(RICH_PREVIEW);
    expect(screen.queryByText(grids[0].label)).not.toBeInTheDocument();
  });

  it('pages a single month at a time', () => {
    loadedHooks(ROLE_ADMIN);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    const now = new Date();
    const next = shiftAnchor({ year: now.getUTCFullYear(), month: now.getUTCMonth() }, 1);
    const w = monthWindow(next.year, next.month);
    expect(useCalendarPreview).toHaveBeenLastCalledWith('p-1', w.start, w.end);
  });

  it('opens the add-calendar picker as a bottom sheet', () => {
    loadedHooks(ROLE_ADMIN);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    const sheet = screen.getByRole('dialog', { name: 'Add calendars to this project' });
    // The sheet variant is modal and carries its own header close control;
    // the desktop popover has neither.
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('never opens the sheet for a Viewer', () => {
    loadedHooks(ROLE_VIEWER);
    renderPage();
    expect(screen.queryByRole('button', { name: 'Add calendar' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('dialog', { name: 'Add calendars to this project' }),
    ).not.toBeInTheDocument();
  });
});

describe('ProjectCalendarsPage — remaining guards and dismissals', () => {
  it('renders the skeleton and asks for no project role before the route resolves', () => {
    loadedHooks(ROLE_ADMIN);
    useProjectId.mockReturnValue(null);
    useProjectCalendars.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();

    expect(screen.getByText('Loading calendars…')).toBeInTheDocument();
    expect(useCurrentUserRole).toHaveBeenCalledWith(undefined);
  });

  it('pressing Inherit while already inherited fires no redundant PUT', () => {
    const mutate = vi.fn();
    loadedHooks(ROLE_ADMIN, mutate);
    overrideCalendars({ ...APPLIED, base: null });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Inherit from workspace' }));
    expect(mutate).not.toHaveBeenCalled();
  });

  it('clearing the override select falls back to inheriting', () => {
    const mutate = vi.fn();
    loadedHooks(ROLE_ADMIN, mutate);
    renderPage();

    fireEvent.change(screen.getByRole('combobox', { name: 'Working calendar override' }), {
      target: { value: '' },
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      base_calendar_id: null,
      overlays: [{ calendar_id: 'hol', role: 'holidays' }],
    });
  });

  it('names the system default when nothing above the project sets a calendar', () => {
    loadedHooks(ROLE_ADMIN);
    overrideCalendars({ ...APPLIED, base: null });
    useProject.mockReturnValue({ data: { calendar: null, calendar_source: 'system_default' } });
    renderPage();

    expect(screen.getByText(/Inherited from the system default/)).toBeInTheDocument();
  });

  it('closes the picker once the add settles', () => {
    loadedHooks(ROLE_ADMIN);
    useUpdateProjectCalendars.mockReturnValue({
      mutate: (_payload: unknown, opts?: { onSettled?: () => void }) => opts?.onSettled?.(),
      isPending: false,
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    const picker = screen.getByRole('dialog', { name: 'Add calendars to this project' });
    fireEvent.click(within(picker).getByRole('option', { name: /Night shift/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Add 1 calendar' }));

    expect(
      screen.queryByRole('dialog', { name: 'Add calendars to this project' }),
    ).not.toBeInTheDocument();
  });

  it('cancelling the desktop popover closes it without a write', () => {
    const mutate = vi.fn();
    loadedHooks(ROLE_ADMIN, mutate);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Add calendars to this project' })).getByRole(
        'button',
        { name: 'Cancel' },
      ),
    );
    expect(
      screen.queryByRole('dialog', { name: 'Add calendars to this project' }),
    ).not.toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('the desktop popover shows the library loading row while the library resolves', () => {
    loadedHooks(ROLE_ADMIN);
    useCalendarLibrary.mockReturnValue({ data: undefined, isLoading: true });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    const picker = screen.getByRole('dialog', { name: 'Add calendars to this project' });
    expect(within(picker).getByText('Loading calendars…')).toBeInTheDocument();
    expect(within(picker).queryByRole('option')).not.toBeInTheDocument();
  });
});

describe('ProjectCalendarsPage — mobile dismissals and loading', () => {
  beforeEach(() => {
    useBreakpoint.mockReturnValue('sm');
  });

  it('closing the bottom sheet leaves the stack untouched', () => {
    const mutate = vi.fn();
    loadedHooks(ROLE_ADMIN, mutate);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    const sheet = screen.getByRole('dialog', { name: 'Add calendars to this project' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));

    expect(
      screen.queryByRole('dialog', { name: 'Add calendars to this project' }),
    ).not.toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('the bottom sheet shows the library loading row while the library resolves', () => {
    loadedHooks(ROLE_ADMIN);
    useCalendarLibrary.mockReturnValue({ data: undefined, isLoading: true });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    const sheet = screen.getByRole('dialog', { name: 'Add calendars to this project' });
    expect(within(sheet).getByText('Loading calendars…')).toBeInTheDocument();
  });

  it('renders a single-month skeleton while the mobile preview loads', () => {
    loadedHooks(ROLE_ADMIN);
    useCalendarPreview.mockReturnValue({
      data: undefined,
      isFetching: true,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();

    expect(screen.queryByText(/loses/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled();
  });
});
