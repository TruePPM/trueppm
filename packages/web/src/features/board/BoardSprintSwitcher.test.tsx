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
      <BoardSprintSwitcher
        sprints={SPRINTS}
        selectedSprintId={null}
        onSelectSprint={onSelectSprint}
      />,
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

describe('BoardSprintSwitcher pruning (#1141)', () => {
  const onSelectSprint = vi.fn();
  beforeEach(() => onSelectSprint.mockReset());

  // 5 completed sprints (start_date desc) so the sort comfortably exceeds the
  // RECENT_LIMIT of 3 and the disclosure appears.
  const MANY: ApiSprint[] = [
    {
      ...sprint('s1', 'Atlas 1', 'COMPLETED'),
      start_date: '2026-01-01',
      finish_date: '2026-01-14',
    },
    {
      ...sprint('s2', 'Atlas 2', 'COMPLETED'),
      start_date: '2026-02-01',
      finish_date: '2026-02-14',
    },
    {
      ...sprint('s3', 'Atlas 3', 'COMPLETED'),
      start_date: '2026-03-01',
      finish_date: '2026-03-14',
    },
    {
      ...sprint('s4', 'Atlas 4', 'COMPLETED'),
      start_date: '2026-04-01',
      finish_date: '2026-04-14',
    },
    {
      ...sprint('s5', 'Atlas 5', 'COMPLETED'),
      start_date: '2026-05-01',
      finish_date: '2026-05-14',
    },
  ];

  function open(selectedSprintId: string | null = null) {
    render(
      <BoardSprintSwitcher
        sprints={MANY}
        selectedSprintId={selectedSprintId}
        onSelectSprint={onSelectSprint}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
  }

  it('Recent shows only the first 3 sprints; the rest hide behind a disclosure', () => {
    open();
    // Sort is start_date desc → Atlas 5, 4, 3 visible; 2, 1 hidden.
    expect(screen.getByText('Atlas 5')).toBeInTheDocument();
    expect(screen.getByText('Atlas 4')).toBeInTheDocument();
    expect(screen.getByText('Atlas 3')).toBeInTheDocument();
    expect(screen.queryByText('Atlas 2')).toBeNull();
    expect(screen.queryByText('Atlas 1')).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Show all sprints \(2\)/ })).toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('Show all expands the rest and toggles to Show fewer', () => {
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: /Show all sprints/ }));
    expect(screen.getByText('Atlas 2')).toBeInTheDocument();
    expect(screen.getByText('Atlas 1')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Show fewer/ })).toBeInTheDocument();
  });

  it('always pins the currently-selected sprint into Recent even when outside the top 3', () => {
    // s1 (Atlas 1) is the oldest → outside the top-3 window, but selected.
    open('s1');
    // Pinned into Recent → its menu item is present (checked radio).
    const menu = screen.getByRole('menu');
    expect(
      menu.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent,
    ).toContain('Atlas 1');
    // Atlas 2 (oldest-of-remaining) stays behind the disclosure (count 1).
    expect(screen.queryByText('Atlas 2')).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Show all sprints \(1\)/ })).toBeInTheDocument();
  });
});
