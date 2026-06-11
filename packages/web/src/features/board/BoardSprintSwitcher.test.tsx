import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BoardSprintSwitcher } from './BoardSprintSwitcher';
import type { ApiSprint, SprintState } from '@/types';

function sprint(id: string, name: string, state: SprintState): ApiSprint {
  return {
    id,
    name,
    state,
    start_date: '2026-06-01',
    finish_date: '2026-06-14',
  } as ApiSprint;
}

const SPRINTS = [
  sprint('s-active', 'Atlas 4', 'ACTIVE'),
  sprint('s-planned', 'Atlas 5', 'PLANNED'),
  sprint('s-done', 'Atlas 3', 'COMPLETED'),
  sprint('s-cancelled', 'Atlas X', 'CANCELLED'),
];

describe('BoardSprintSwitcher (#429)', () => {
  const onSelectSprint = vi.fn();
  beforeEach(() => onSelectSprint.mockReset());

  function open(selectedSprintId: string | null = null) {
    render(
      <BoardSprintSwitcher
        sprints={SPRINTS}
        selectedSprintId={selectedSprintId}
        onSelectSprint={onSelectSprint}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
  }

  it('defaults the button label to "Project" when no sprint is selected', () => {
    render(
      <BoardSprintSwitcher sprints={SPRINTS} selectedSprintId={null} onSelectSprint={onSelectSprint} />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Project');
  });

  it('lists ACTIVE, PLANNED, COMPLETED sprints but NOT CANCELLED', () => {
    open();
    expect(screen.getByRole('menuitemradio', { name: /All tasks/ })).toBeInTheDocument();
    expect(screen.getByText('Atlas 4')).toBeInTheDocument();
    expect(screen.getByText('Atlas 5')).toBeInTheDocument();
    expect(screen.getByText('Atlas 3')).toBeInTheDocument();
    expect(screen.queryByText('Atlas X')).toBeNull();
  });

  it('orders sprints active → planned → completed', () => {
    open();
    const items = screen.getAllByRole('menuitemradio').slice(1); // skip "All tasks"
    expect(items.map((el) => el.textContent)).toEqual([
      expect.stringContaining('Atlas 4'),
      expect.stringContaining('Atlas 5'),
      expect.stringContaining('Atlas 3'),
    ]);
  });

  it('selecting a sprint calls onSelectSprint with its id', () => {
    open();
    fireEvent.click(screen.getByText('Atlas 4'));
    expect(onSelectSprint).toHaveBeenCalledWith('s-active');
  });

  it('selecting "All tasks (project)" clears the sprint (null)', () => {
    open('s-active');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /All tasks/ }));
    expect(onSelectSprint).toHaveBeenCalledWith(null);
  });

  it('shows the selected sprint name on the button', () => {
    render(
      <BoardSprintSwitcher
        sprints={SPRINTS}
        selectedSprintId="s-active"
        onSelectSprint={onSelectSprint}
      />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Atlas 4');
  });
});
