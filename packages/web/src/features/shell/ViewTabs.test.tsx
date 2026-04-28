import { screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ViewTabs } from './ViewTabs';

// Default: has a project ID
vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: vi.fn(() => 'proj-1'),
}));

import { useProjectId } from '@/hooks/useProjectId';
const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;

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

  it('renders all canonical tabs', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    renderWithRouter(<ViewTabs />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.getByRole('link', { name: /Board/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Schedule/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /WBS/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Table/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Calendar/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Overview/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Team/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Risks/i })).toBeInTheDocument();
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
