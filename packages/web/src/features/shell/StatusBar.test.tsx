import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { StatusBar } from './StatusBar';

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    data: [{ id: 'p1', name: 'Alpha Platform Upgrade', healthState: 'on-track', colorDot: '#1C6B3A' }],
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useProjectPresence', () => ({
  useProjectPresence: () => [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }],
}));

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'p1',
}));

describe('StatusBar', () => {
  it('renders the live dot and online count', () => {
    renderWithRouter(<StatusBar />);
    expect(screen.getByRole('contentinfo', { name: /application status/i })).toBeInTheDocument();
    expect(screen.getByText(/live · 2 online/i)).toBeInTheDocument();
  });

  it('renders the build hash', () => {
    renderWithRouter(<StatusBar />);
    expect(screen.getByText(/build test-sha/i)).toBeInTheDocument();
  });

  it('renders the project name and active view as the status note', () => {
    renderWithRouter(<StatusBar />, { initialEntries: ['/projects/p1/board'] });
    expect(screen.getByText('Alpha Platform Upgrade · Board')).toBeInTheDocument();
  });

  it('renders Schedule label for the schedule route', () => {
    renderWithRouter(<StatusBar />, { initialEntries: ['/projects/p1/schedule'] });
    expect(screen.getByText('Alpha Platform Upgrade · Schedule')).toBeInTheDocument();
  });
});
