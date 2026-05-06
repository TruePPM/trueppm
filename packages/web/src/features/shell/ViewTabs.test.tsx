import { screen } from '@testing-library/react';
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
  useCurrentUserRole: vi.fn(() => ({ role: 2, isLoading: false })),
}));

// Default: HYBRID methodology (all tabs visible). Methodology-filter tests
// override via mockReturnValue.
vi.mock('@/hooks/useProject', () => ({
  useProject: vi.fn(() => ({
    data: { id: 'proj-1', methodology: 'HYBRID' },
    isLoading: false,
    error: null,
  })),
}));

import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;
const mockUseProject = useProject as ReturnType<typeof vi.fn>;

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

  // ADR-0041 — methodology preset filtering
  it('hides Sprints when methodology is WATERFALL', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUseProject.mockReturnValueOnce({
      data: { id: 'proj-1', methodology: 'WATERFALL' },
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
      data: { id: 'proj-1', methodology: 'AGILE' },
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
});
