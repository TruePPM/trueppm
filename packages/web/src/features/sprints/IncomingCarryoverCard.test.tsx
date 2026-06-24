import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IncomingCarryoverCard } from './IncomingCarryoverCard';
import { useIncomingCarryover, type IncomingCarryover } from '@/hooks/useSprints';

vi.mock('@/hooks/useSprints', () => ({
  useIncomingCarryover: vi.fn(),
}));

const mockHook = vi.mocked(useIncomingCarryover);

function setData(data: IncomingCarryover | undefined, isLoading = false) {
  mockHook.mockReturnValue({ data, isLoading } as ReturnType<typeof useIncomingCarryover>);
}

const priorSprint = {
  id: 'prev',
  short_id_display: 'SP-PREV',
  name: 'Sprint 11',
  start_date: '2026-03-18',
  finish_date: '2026-03-31',
};

beforeEach(() => {
  mockHook.mockReset();
});

describe('IncomingCarryoverCard', () => {
  it('renders nothing while loading or with no carryover', () => {
    setData(undefined, true);
    const { container } = render(
      <IncomingCarryoverCard sprintId="sp-1" currentSprintShortId="SP-NEXT" />,
    );
    expect(container).toBeEmptyDOMElement();

    setData({ prior_sprint: priorSprint, tasks: [] });
    const { container: c2 } = render(
      <IncomingCarryoverCard sprintId="sp-1" currentSprintShortId="SP-NEXT" />,
    );
    expect(c2).toBeEmptyDOMElement();
  });

  it('lists prior unfinished tasks, pre-checks pulled rows, and sums only pulled points', () => {
    setData({
      prior_sprint: priorSprint,
      tasks: [
        { id: 't1', short_id: 'T-1', name: 'Pulled in', story_points: 3, pulled_in_to_current: true },
        { id: 't2', short_id: 'T-2', name: 'Also pulled', story_points: 5, pulled_in_to_current: true },
        { id: null, short_id: 'T-3', name: 'Left behind', story_points: 8, pulled_in_to_current: false },
      ],
    });
    render(<IncomingCarryoverCard sprintId="sp-1" currentSprintShortId="SP-NEXT" />);

    expect(screen.getByText(/Carry over from SP-PREV/)).toBeInTheDocument();
    expect(screen.getByText('3 tasks')).toBeInTheDocument();
    // Two pulled rows are checked, one is not.
    expect(screen.getAllByLabelText('Rolled into this sprint')).toHaveLength(2);
    expect(screen.getAllByLabelText('Not rolled into this sprint')).toHaveLength(1);
    // Footer sums only the pulled points (3 + 5), not the left-behind 8.
    const footer = screen.getByText(/rolled into/);
    expect(footer.textContent).toMatch(/8\s*pts rolled into\s*SP-NEXT/);
  });
});
