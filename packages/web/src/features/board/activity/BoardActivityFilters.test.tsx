import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BoardActivityFilters } from './BoardActivityFilters';
import { DEFAULT_FILTERS, type BoardActivityFilterState } from './useBoardActivity';

const actors = [
  { id: 'u-priya', name: 'Priya' },
  { id: 'u-alex', name: 'Alex' },
];

function renderFilters(
  over: Partial<BoardActivityFilterState> = {},
  { hasSprintScope = false }: { hasSprintScope?: boolean } = {},
) {
  const onChange = vi.fn();
  render(
    <BoardActivityFilters
      filters={{ ...DEFAULT_FILTERS, ...over }}
      actors={actors}
      onChange={onChange}
      hasSprintScope={hasSprintScope}
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

  it('exposes the sprint-transition group as "Scope changes" mapped to typeGroup sprint', async () => {
    const user = userEvent.setup();
    const onChange = renderFilters();
    await user.click(screen.getByRole('button', { name: 'Scope changes' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ typeGroup: 'sprint' }));
    // The old "Sprint" label is gone.
    expect(screen.queryByRole('button', { name: 'Sprint' })).not.toBeInTheDocument();
  });

  it('hides the scope toggle when no sprint is available', () => {
    renderFilters();
    expect(screen.queryByRole('group', { name: 'Activity scope' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'This sprint' })).not.toBeInTheDocument();
  });

  it('shows the scope toggle and switches This-sprint ↔ Whole-board', async () => {
    const user = userEvent.setup();
    const onChange = renderFilters({ scope: 'sprint' }, { hasSprintScope: true });
    expect(screen.getByRole('group', { name: 'Activity scope' })).toBeInTheDocument();
    // Currently "This sprint" — switch to whole board.
    await user.click(screen.getByRole('button', { name: 'Whole board' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scope: 'board' }));
  });

  it('preserves scope when clearing type/actor/time filters', async () => {
    const user = userEvent.setup();
    const onChange = renderFilters({ scope: 'sprint', typeGroup: 'sprint' }, { hasSprintScope: true });
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scope: 'sprint', typeGroup: 'all' }));
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
