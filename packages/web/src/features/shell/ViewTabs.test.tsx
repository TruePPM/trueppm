import { screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ViewTabs } from './ViewTabs';

// Default: has a project ID
vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: vi.fn(() => 'proj-1'),
}));

// Default: SCHEDULER role so the Team tab is visible.
// Tests that exercise role gating can override with mockReturnValue.
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: vi.fn(() => ({ role: 200, isLoading: false })),
}));

// Default: HYBRID methodology (all tabs visible). Methodology-filter tests
// override via mockReturnValue. ViewTabs reads the SERVER-RESOLVED
// `effective_methodology` (ADR-0107, issue 955), so seed both — they match here
// because no workspace lock is in play.
vi.mock('@/hooks/useProject', () => ({
  useProject: vi.fn(() => ({
    data: { id: 'proj-1', methodology: 'HYBRID', effective_methodology: 'HYBRID' },
    isLoading: false,
    error: null,
  })),
}));

// Default: no personally-hidden views (ADR-0139). The customize-views tests
// override `hidden_views` via mockReturnValue.
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(() => ({ user: { hidden_views: [] }, isLoading: false })),
}));

import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useCurrentUser } from '@/hooks/useCurrentUser';
const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;
const mockUseProject = useProject as ReturnType<typeof vi.fn>;
const mockUseRole = useCurrentUserRole as ReturnType<typeof vi.fn>;
const mockUseCurrentUser = useCurrentUser as ReturnType<typeof vi.fn>;

describe('ViewTabs', () => {
  it('renders null when there is no projectId', () => {
    mockUseProjectId.mockReturnValue(undefined);
    const { container } = renderWithRouter(<ViewTabs />);
    // Nothing rendered
    expect(container.firstChild).toBeNull();
  });

  it('renders the nav when projectId is present', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.getByRole('navigation', { name: /view/i })).toBeInTheDocument();
  });

  it('renders all canonical tabs (HYBRID methodology — default)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.getByRole('link', { name: /Board/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sprints/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Schedule/i })).toBeInTheDocument();
    // WBS + Table consolidated into a single Grid entry (issue #334).
    expect(screen.getByRole('link', { name: /Grid/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /WBS/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Table/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Calendar/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Overview/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Team/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Risks/i })).toBeInTheDocument();
  });

  it('shows the methodology-gated Backlog tab on HYBRID, linking to /product-backlog (#1096)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    const backlogLink = screen.getByRole('link', { name: /Backlog/i });
    expect(backlogLink).toBeInTheDocument();
    expect(backlogLink).toHaveAttribute('href', '/projects/proj-1/product-backlog');
  });

  it('hides the Backlog tab when methodology is WATERFALL (#1096)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseProject.mockReturnValueOnce({
      data: { id: 'proj-1', methodology: 'WATERFALL', effective_methodology: 'WATERFALL' },
      isLoading: false,
      error: null,
    });
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.queryByRole('link', { name: /Backlog/i })).not.toBeInTheDocument();
  });

  it('marks the Backlog tab active on the /product-backlog route (#1096)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/product-backlog'] });
    expect(screen.getByRole('link', { name: /Backlog/i })).toHaveAttribute('aria-current', 'page');
  });

  // ADR-0041 — methodology preset filtering
  it('hides Sprints when methodology is WATERFALL', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseProject.mockReturnValueOnce({
      data: { id: 'proj-1', methodology: 'WATERFALL', effective_methodology: 'WATERFALL' },
      isLoading: false,
      error: null,
    });
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.queryByRole('link', { name: /Sprints/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Schedule/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Grid/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Calendar/i })).toBeInTheDocument();
  });

  it('hides Schedule and Calendar when methodology is AGILE — Grid stays visible', () => {
    // ADR-0053 amendment: Grid replaces WBS+Table and is visible in all
    // methodologies. AGILE now shows Grid (defaults to Flat mode internally).
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseProject.mockReturnValueOnce({
      data: { id: 'proj-1', methodology: 'AGILE', effective_methodology: 'AGILE' },
      isLoading: false,
      error: null,
    });
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.getByRole('link', { name: /Sprints/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Schedule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Calendar/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Grid/i })).toBeInTheDocument();
  });

  it('shows all tabs while project is loading (HYBRID fallback)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseProject.mockReturnValueOnce({
      data: undefined,
      isLoading: true,
      error: null,
    });
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.getByRole('link', { name: /Sprints/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Schedule/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Grid/i })).toBeInTheDocument();
  });

  it('marks the board tab as active when on /board route', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    const boardLink = screen.getByRole('link', { name: /Board/i });
    expect(boardLink).toHaveAttribute('aria-current', 'page');
    const scheduleLink = screen.getByRole('link', { name: /Schedule/i });
    expect(scheduleLink).not.toHaveAttribute('aria-current');
  });

  it('marks the schedule tab as active when on /schedule route', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/schedule'] });
    const scheduleLink = screen.getByRole('link', { name: /Schedule/i });
    expect(scheduleLink).toHaveAttribute('aria-current', 'page');
    const boardLink = screen.getByRole('link', { name: /Board/i });
    expect(boardLink).not.toHaveAttribute('aria-current');
  });

  it('links use correct project-scoped paths', () => {
    mockUseProjectId.mockReturnValue('proj-abc');
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-abc/board'] });
    const boardLink = screen.getByRole('link', { name: /Board/i });
    expect(boardLink).toHaveAttribute('href', '/projects/proj-abc/board');
    const scheduleLink = screen.getByRole('link', { name: /Schedule/i });
    expect(scheduleLink).toHaveAttribute('href', '/projects/proj-abc/schedule');
  });

  // ADR-0128 §A / ADR-0195 / ADR-0203 — grouped PLAN / DELIVER / TRACK / PEOPLE structure (HYBRID)
  it('renders PLAN / DELIVER / TRACK / PEOPLE groups with accessible names', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.getByRole('group', { name: 'Plan views' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Deliver views' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Track views' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'People views' })).toBeInTheDocument();
  });

  it('co-locates Backlog · Sprints · Board in the DELIVER group on HYBRID (ADR-0195/0203, issue 1466)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    const sprint = screen.getByRole('group', { name: 'Deliver views' });
    expect(within(sprint).getByRole('link', { name: /Backlog/i })).toBeInTheDocument();
    expect(within(sprint).getByRole('link', { name: /Sprints/i })).toBeInTheDocument();
    expect(within(sprint).getByRole('link', { name: 'Board' })).toBeInTheDocument();
    // Board is no longer stranded in TRACK.
    const track = screen.getByRole('group', { name: 'Track views' });
    expect(within(track).queryByRole('link', { name: 'Board' })).not.toBeInTheDocument();
  });

  it('WATERFALL keeps Board in TRACK and shows no DELIVER group (zero regression, ADR-0195/0203)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseProject.mockReturnValueOnce({
      data: { id: 'proj-1', methodology: 'WATERFALL', effective_methodology: 'WATERFALL' },
      isLoading: false,
      error: null,
    });
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.queryByRole('group', { name: 'Deliver views' })).not.toBeInTheDocument();
    const track = screen.getByRole('group', { name: 'Track views' });
    expect(within(track).getByRole('link', { name: 'Board' })).toBeInTheDocument();
  });

  it('hides the PEOPLE group when the Team view is role-gated out', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseRole.mockReturnValueOnce({ role: 1, isLoading: false }); // MEMBER < SCHEDULER
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.queryByRole('group', { name: 'People views' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
  });

  // ADR-0139 — per-user nav visibility
  it('hides a personally-hidden view from the bar (ADR-0139)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseCurrentUser.mockReturnValueOnce({
      user: { hidden_views: ['schedule', 'calendar'] },
      isLoading: false,
    });
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.queryByRole('link', { name: /Schedule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Calendar/i })).not.toBeInTheDocument();
    // Other views and the always-on Overview remain.
    expect(screen.getByRole('link', { name: /Board/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Overview/i })).toBeInTheDocument();
  });

  it('never hides Overview even if the personal set somehow contains it (ADR-0139)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseCurrentUser.mockReturnValueOnce({
      user: { hidden_views: ['overview'] },
      isLoading: false,
    });
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    // overview is rendered standalone, outside the personal-hidden filter.
    expect(screen.getByRole('link', { name: /Overview/i })).toBeInTheDocument();
  });

  it('is suppressed on a project settings route (rule 123 / ADR-0128 §C)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    const { container } = renderWithRouter(<ViewTabs />, {
      initialEntries: ['/projects/proj-1/settings/general'],
    });
    expect(container.firstChild).toBeNull();
  });
});
