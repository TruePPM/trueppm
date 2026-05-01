import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { StatusBar } from './StatusBar';

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    data: [{ id: 'p1', name: 'Alpha Platform Upgrade', healthState: 'on-track', colorDot: '#1C6B3A', methodology: 'HYBRID' }],
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useProjectPresence', () => ({
  useProjectPresence: () => [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }],
}));

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: vi.fn(() => 'p1'),
}));

import { useProjectId } from '@/hooks/useProjectId';
const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;

describe('StatusBar', () => {
  it('renders the live dot and online count', () => {
    mockUseProjectId.mockReturnValue('p1');
    renderWithRouter(<StatusBar />);
    expect(screen.getByRole('contentinfo', { name: /application status/i })).toBeInTheDocument();
    expect(screen.getByText(/live · 2 online/i)).toBeInTheDocument();
  });

  it('renders the build hash', () => {
    mockUseProjectId.mockReturnValue('p1');
    renderWithRouter(<StatusBar />);
    expect(screen.getByText(/build test-sha/i)).toBeInTheDocument();
  });

  it('renders the project name and active view as the status note', () => {
    mockUseProjectId.mockReturnValue('p1');
    renderWithRouter(<StatusBar />, { initialEntries: ['/projects/p1/board'] });
    expect(screen.getByText('Alpha Platform Upgrade · Board')).toBeInTheDocument();
  });

  it('renders Schedule label for the schedule route', () => {
    mockUseProjectId.mockReturnValue('p1');
    renderWithRouter(<StatusBar />, { initialEntries: ['/projects/p1/schedule'] });
    expect(screen.getByText('Alpha Platform Upgrade · Schedule')).toBeInTheDocument();
  });

  it('renders no status note when projectId is null (not inside a project route)', () => {
    // useProjectId returns undefined → projectId = null → project = undefined → statusNote = ''
    mockUseProjectId.mockReturnValue(undefined);
    renderWithRouter(<StatusBar />, { initialEntries: ['/'] });
    // The status note span should not appear (empty string is falsy)
    expect(screen.queryByText(/Alpha Platform/)).not.toBeInTheDocument();
  });

  it('renders raw viewSlug when slug is not in VIEW_LABELS', () => {
    mockUseProjectId.mockReturnValue('p1');
    // Navigate to a route with an unknown view slug
    renderWithRouter(<StatusBar />, { initialEntries: ['/projects/p1/unknown-view'] });
    // viewLabel falls back to viewSlug itself
    expect(screen.getByText('Alpha Platform Upgrade · unknown-view')).toBeInTheDocument();
  });
});
