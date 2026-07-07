import { screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ViewsMenu } from './ViewsMenu';

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: vi.fn(() => 'proj-1') }));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: vi.fn(() => ({ role: 200, isLoading: false })),
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: vi.fn(() => ({
    data: { id: 'proj-1', methodology: 'HYBRID', effective_methodology: 'HYBRID' },
    isLoading: false,
  })),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(() => ({ user: { hidden_views: [] }, isLoading: false })),
}));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: vi.fn(() => ({ singular: 'Sprint', plural: 'Sprints' })),
}));

const mutate = vi.fn();
vi.mock('@/hooks/useUpdateHiddenViews', () => ({
  useUpdateHiddenViews: vi.fn(() => ({ mutate })),
}));

const mutateSchedule = vi.fn();
vi.mock('@/hooks/useUpdateScheduleInDeliver', () => ({
  useUpdateScheduleInDeliver: vi.fn(() => ({ mutate: mutateSchedule })),
}));

import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useProject } from '@/hooks/useProject';
const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;
const mockUseCurrentUser = useCurrentUser as ReturnType<typeof vi.fn>;
const mockUseProject = useProject as ReturnType<typeof vi.fn>;

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Customize views' }));
}

describe('ViewsMenu (ADR-0139)', () => {
  beforeEach(() => {
    mutate.mockClear();
    mutateSchedule.mockClear();
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseCurrentUser.mockReturnValue({ user: { hidden_views: [] }, isLoading: false });
    mockUseProject.mockReturnValue({
      data: { id: 'proj-1', methodology: 'HYBRID', effective_methodology: 'HYBRID' },
      isLoading: false,
    });
  });

  it('renders nothing off a project route', () => {
    mockUseProjectId.mockReturnValue(undefined);
    const { container } = renderWithRouter(<ViewsMenu />, { initialEntries: ['/me/work'] });
    expect(container.firstChild).toBeNull();
  });

  it('opens a menu listing the always-on Overview and toggleable views', () => {
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    const menu = screen.getByRole('menu', { name: 'Customize views' });
    // Overview is present but NOT a toggle.
    expect(within(menu).getByText('Overview')).toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitemcheckbox', { name: /Overview/i }),
    ).not.toBeInTheDocument();
    // Hideable views are menuitemcheckbox rows, checked (visible) by default.
    const schedule = within(menu).getByRole('menuitemcheckbox', { name: 'Schedule' });
    expect(schedule).toHaveAttribute('aria-checked', 'true');
  });

  it('toggling a visible view PATCHes it into the hidden set', () => {
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Schedule' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual(['schedule']);
  });

  it('un-toggling an already-hidden view removes it from the set', () => {
    mockUseCurrentUser.mockReturnValue({
      user: { hidden_views: ['schedule', 'calendar'] },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    const schedule = screen.getByRole('menuitemcheckbox', { name: 'Schedule' });
    expect(schedule).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(schedule);
    expect(mutate.mock.calls[0][0]).toEqual(['calendar']);
  });

  it('Reset clears the methodology-visible hidden views and is disabled when none are hidden', () => {
    mockUseCurrentUser.mockReturnValue({
      user: { hidden_views: ['schedule'] },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    const reset = screen.getByRole('menuitem', { name: /Reset to Hybrid default/i });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(mutate.mock.calls[0][0]).toEqual([]);
  });

  it('Reset is disabled when nothing is hidden', () => {
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    expect(screen.getByRole('menuitem', { name: /Reset to Hybrid default/i })).toBeDisabled();
  });

  it('only lists methodology-visible views as toggles (AGILE hides Schedule/Calendar)', () => {
    mockUseProject.mockReturnValue({
      data: { id: 'proj-1', methodology: 'AGILE', effective_methodology: 'AGILE' },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /Sprints/i })).toBeInTheDocument();
  });

  // --- Schedule-in-Deliver placement opt-in (#1645) ------------------------

  it('offers the Schedule-in-Deliver placement toggle on HYBRID, off by default', () => {
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    const placement = screen.getByRole('menuitemcheckbox', {
      name: /Also show Schedule under Deliver/i,
    });
    expect(placement).toHaveAttribute('aria-checked', 'false');
  });

  it('toggling the placement opt-in PATCHes schedule_in_deliver = true', () => {
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: /Also show Schedule under Deliver/i }),
    );
    expect(mutateSchedule).toHaveBeenCalledTimes(1);
    expect(mutateSchedule.mock.calls[0][0]).toBe(true);
    // The hidden-views mutation is untouched — placement is not a visibility change.
    expect(mutate).not.toHaveBeenCalled();
  });

  it('reflects an already-on placement opt-in as checked', () => {
    mockUseCurrentUser.mockReturnValue({
      user: { hidden_views: [], schedule_in_deliver: true },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    expect(
      screen.getByRole('menuitemcheckbox', { name: /Also show Schedule under Deliver/i }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('does NOT offer the placement toggle on WATERFALL (no Deliver group)', () => {
    mockUseProject.mockReturnValue({
      data: { id: 'proj-1', methodology: 'WATERFALL', effective_methodology: 'WATERFALL' },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    expect(
      screen.queryByRole('menuitemcheckbox', { name: /Also show Schedule under Deliver/i }),
    ).not.toBeInTheDocument();
  });

  it('does NOT offer the placement toggle on AGILE (Schedule methodology-hidden)', () => {
    mockUseProject.mockReturnValue({
      data: { id: 'proj-1', methodology: 'AGILE', effective_methodology: 'AGILE' },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    expect(
      screen.queryByRole('menuitemcheckbox', { name: /Also show Schedule under Deliver/i }),
    ).not.toBeInTheDocument();
  });

  it('hides the placement toggle when Schedule is personally hidden (no dead toggle)', () => {
    mockUseCurrentUser.mockReturnValue({
      user: { hidden_views: ['schedule'], schedule_in_deliver: false },
      isLoading: false,
    });
    renderWithRouter(<ViewsMenu />, { initialEntries: ['/projects/proj-1/board'] });
    open();
    expect(
      screen.queryByRole('menuitemcheckbox', { name: /Also show Schedule under Deliver/i }),
    ).not.toBeInTheDocument();
  });
});
