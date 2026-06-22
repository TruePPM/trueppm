import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BoardActivityFilters } from './BoardActivityFilters';
import { DEFAULT_FILTERS, type BoardActivityFilterState } from './useBoardActivity';

const actors = [
  { id: 'u-priya', name: 'Priya' },
  { id: 'u-alex', name: 'Alex' },
];

function renderFilters(over: Partial<BoardActivityFilterState> = {}) {
  const onChange = vi.fn();
  render(
    <BoardActivityFilters
      filters={{ ...DEFAULT_FILTERS, ...over }}
      actors={actors}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe('BoardActivityFilters', () => {
  it('selects an event-type group', async () => {
    const user = userEvent.setup();
    const onChange = renderFilters();
    await user.click(screen.getByRole('button', { name: 'Cards', pressed: false }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ typeGroup: 'cards' }));
  });

  it('selects a time range', async () => {
    const user = userEvent.setup();
    const onChange = renderFilters();
    await user.click(screen.getByRole('button', { name: '7d' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ range: '7d' }));
  });

  it('filters by an actor via the person select', async () => {
    const user = userEvent.setup();
    const onChange = renderFilters();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by person' }), 'u-alex');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'u-alex' }));
  });

  it('hides Clear when unfiltered and shows it (resetting) when filtered', async () => {
    const user = userEvent.setup();
    // Unfiltered default → no Clear.
    const onChange = renderFilters();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    // Filtered → Clear resets to defaults.
    render(
      <BoardActivityFilters
        filters={{ ...DEFAULT_FILTERS, typeGroup: 'sprint' }}
        actors={actors}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_FILTERS);
  });
});
