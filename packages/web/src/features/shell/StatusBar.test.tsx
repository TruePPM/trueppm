import { screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { StatusBar } from './StatusBar';
import { useWsConnectionStore } from '@/stores/wsConnectionStore';

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    data: [{ id: 'p1', name: 'Alpha Platform Upgrade', healthState: 'on-track', colorDot: '#3E8C6D', methodology: 'HYBRID' }],
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
  it('renders the live dot and viewing count when connected', () => {
    renderWithRouter(<StatusBar />);
    expect(screen.getByRole('contentinfo', { name: /application status/i })).toBeInTheDocument();
    expect(screen.getByText(/live · 2 viewing/i)).toBeInTheDocument();
  });

  it('surfaces the anonymity contract as a tooltip and accessible description when live', () => {
    renderWithRouter(<StatusBar />);
    // The contract copy is visible on hover (title) and announced to screen
    // readers via aria-describedby (#1560).
    expect(screen.getByText(/never who's editing what/i)).toBeInTheDocument();
    const pill = screen.getByLabelText(/Live — connected, 2 viewing/i);
    expect(pill).toHaveAttribute('title', expect.stringContaining("never who's editing what"));
    expect(pill).toHaveAttribute('aria-describedby', 'statusbar-presence-contract');
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

  it('derives the view label from the segment after the projectId on a nested route (#1556)', () => {
    // /board/<cardId> — the last segment is the card id; the label must still be "Board".
    renderWithRouter(<StatusBar />, {
      initialEntries: ['/projects/p1/board/card-abc-123'],
    });
    expect(screen.getByText('Alpha Platform Upgrade · Board')).toBeInTheDocument();
    expect(screen.queryByText(/card-abc-123/)).not.toBeInTheDocument();
  });

  it('renders no status note when projectId is null (not inside a project route)', () => {
    mockUseProjectId.mockReturnValue(undefined);
    renderWithRouter(<StatusBar />, { initialEntries: ['/'] });
    expect(screen.queryByText(/Alpha Platform/)).not.toBeInTheDocument();
  });

  it('renders raw viewSlug when the slug is not in VIEW_TAB_META', () => {
    renderWithRouter(<StatusBar />, { initialEntries: ['/projects/p1/unknown-view'] });
    expect(screen.getByText('Alpha Platform Upgrade · unknown-view')).toBeInTheDocument();
  });

  it('derives labels from the shared VIEW_TAB_META source (rule 215) — including slugs the old hand-rolled map missed', () => {
    // These slugs were absent from the previous hand-rolled VIEW_LABELS map and
    // fell through to the raw slug ("Alpha Launch · product-backlog"). They must
    // now resolve to the same labels ViewTabs/BottomNav show.
    for (const [slug, label] of [
      ['product-backlog', 'Backlog'],
      ['today', 'Today'],
      ['grid', 'Grid'],
      ['reports', 'Reports'],
      ['activity', 'Activity'],
      ['assets', 'Assets'],
      ['settings', 'Settings'],
    ] as const) {
      const { unmount } = renderWithRouter(<StatusBar />, {
        initialEntries: [`/projects/p1/${slug}`],
      });
      expect(screen.getByText(`Alpha Platform Upgrade · ${label}`)).toBeInTheDocument();
      unmount();
    }
  });

  it('shows the iteration label (default "Sprints") for the sprints slug', () => {
    // Resolved through useIterationLabel — falls back to the "Sprint" default here
    // since the project-detail query is not mocked (rule 215b).
    renderWithRouter(<StatusBar />, { initialEntries: ['/projects/p1/sprints'] });
    expect(screen.getByText('Alpha Platform Upgrade · Sprints')).toBeInTheDocument();
  });

  describe('connection pill (#643)', () => {
    it('hides the connection pill when there is no active project channel', () => {
      mockUseProjectId.mockReturnValue(undefined);
      renderWithRouter(<StatusBar />, { initialEntries: ['/'] });
      // No project → no live channel → pill omitted (rather than a misleading "Live · 0 viewing").
      expect(
        screen.queryByText(/viewing|Connecting|Reconnecting|Connection lost|Disconnected/),
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

    it('does not show the viewing count (or its anonymity contract) outside the live state', () => {
      useWsConnectionStore.setState({ state: 'stale', reconnectAttempts: 3 });
      renderWithRouter(<StatusBar />);
      expect(screen.queryByText(/viewing/)).not.toBeInTheDocument();
      // The contract copy only renders alongside the live viewing count.
      expect(screen.queryByText(/never who's editing what/i)).not.toBeInTheDocument();
    });
  });
});
