import { screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { StatusBar } from './StatusBar';
import { useWsConnectionStore } from '@/stores/wsConnectionStore';

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

beforeEach(() => {
  mockUseProjectId.mockReturnValue('p1');
  // Default to a live connection so the pre-existing presence assertions hold.
  useWsConnectionStore.setState({ state: 'live', reconnectAttempts: 0 });
});

describe('StatusBar', () => {
  it('renders the live dot and online count when connected', () => {
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

  it('renders no status note when projectId is null (not inside a project route)', () => {
    mockUseProjectId.mockReturnValue(undefined);
    renderWithRouter(<StatusBar />, { initialEntries: ['/'] });
    expect(screen.queryByText(/Alpha Platform/)).not.toBeInTheDocument();
  });

  it('renders raw viewSlug when slug is not in VIEW_LABELS', () => {
    renderWithRouter(<StatusBar />, { initialEntries: ['/projects/p1/unknown-view'] });
    expect(screen.getByText('Alpha Platform Upgrade · unknown-view')).toBeInTheDocument();
  });

  describe('connection pill (#643)', () => {
    it('hides the connection pill when there is no active project channel', () => {
      mockUseProjectId.mockReturnValue(undefined);
      renderWithRouter(<StatusBar />, { initialEntries: ['/'] });
      // No project → no live channel → pill omitted (rather than a misleading "Live · 0 online").
      expect(
        screen.queryByText(/online|Connecting|Reconnecting|Connection lost|Disconnected/),
      ).not.toBeInTheDocument();
    });

    it('shows "Connecting…" before the socket opens', () => {
      useWsConnectionStore.setState({ state: 'connecting', reconnectAttempts: 0 });
      renderWithRouter(<StatusBar />);
      expect(screen.getByText('Connecting…')).toBeInTheDocument();
    });

    it('shows "Reconnecting…" with an accessible label on a recent drop', () => {
      useWsConnectionStore.setState({ state: 'reconnecting', reconnectAttempts: 1 });
      renderWithRouter(<StatusBar />);
      expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
      expect(screen.getByLabelText(/Reconnecting to live updates/i)).toBeInTheDocument();
    });

    it('shows "Connection lost" with a durability warning when stale', () => {
      useWsConnectionStore.setState({ state: 'stale', reconnectAttempts: 3 });
      renderWithRouter(<StatusBar />);
      expect(screen.getByText('Connection lost')).toBeInTheDocument();
      expect(screen.getByLabelText(/won't be saved/i)).toBeInTheDocument();
    });

    it('shows "Disconnected" with a re-auth hint when the session failed', () => {
      useWsConnectionStore.setState({ state: 'failed', reconnectAttempts: 0 });
      renderWithRouter(<StatusBar />);
      expect(screen.getByText('Disconnected')).toBeInTheDocument();
      expect(screen.getByLabelText(/session expired/i)).toBeInTheDocument();
    });

    it('does not show the online count outside the live state', () => {
      useWsConnectionStore.setState({ state: 'stale', reconnectAttempts: 3 });
      renderWithRouter(<StatusBar />);
      expect(screen.queryByText(/online/)).not.toBeInTheDocument();
    });
  });
});
