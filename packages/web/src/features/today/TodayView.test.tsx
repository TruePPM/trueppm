import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TodayView } from './TodayView';

const useProjectId = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));
// BoardView is heavy + route-coupled; stub it. The contract under test is that
// TodayView embeds it unchanged below the schedule strip.
vi.mock('@/features/board/BoardView', () => ({
  BoardView: () => <div data-testid="board-view-embed" />,
}));
vi.mock('./SchedulePulse', () => ({
  SchedulePulse: ({ projectId }: { projectId: string }) => (
    <div data-testid="schedule-pulse-stub">{projectId}</div>
  ),
}));

describe('TodayView', () => {
  beforeEach(() => {
    useProjectId.mockReturnValue('proj-1');
  });

  it('composes the schedule strip above the embedded board', () => {
    render(<TodayView />);
    expect(screen.getByTestId('schedule-pulse-stub')).toHaveTextContent('proj-1');
    expect(screen.getByTestId('board-view-embed')).toBeInTheDocument();
    // The board is wrapped in its own labelled landmark for screen readers.
    expect(screen.getByRole('region', { name: 'Sprint board' })).toBeInTheDocument();
  });

  it('exposes a "Today" heading landmark', () => {
    render(<TodayView />);
    expect(screen.getByRole('heading', { name: 'Today', level: 1 })).toBeInTheDocument();
  });

  it('renders nothing until a project id resolves from the route', () => {
    useProjectId.mockReturnValue(undefined);
    const { container } = render(<TodayView />);
    expect(container).toBeEmptyDOMElement();
  });
});
