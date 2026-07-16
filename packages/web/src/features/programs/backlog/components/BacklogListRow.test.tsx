import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../types';
import { BacklogListRow } from './BacklogListRow';

function row(overrides: Partial<BacklogItem> = {}) {
  const item: BacklogItem = {
    id: 'BI-003',
    programId: 'p',
    title: 'Telemetry channel B',
    itemType: 'story',
    status: 'PROPOSED',
    tags: ['architecture'],
    priorityRank: 3,
    serverVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
  const onSelect = vi.fn();
  const onPull = vi.fn();
  render(
    <BacklogListRow
      item={item}
      selected={false}
      dim={false}
      query=""
      canEdit
      pending={false}
      draggable={false}
      isDropTarget={false}
      onSelect={onSelect}
      onPull={onPull}
    />,
  );
  return { onSelect, onPull };
}

describe('BacklogListRow', () => {
  it('renders the title, type, and a Pull action for proposed items', () => {
    row();
    expect(screen.getByText('Telemetry channel B')).toBeInTheDocument();
    expect(screen.getByText('Story')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pull Telemetry channel B/ })).toBeInTheDocument();
  });

  it('selecting the row does not also trigger Pull, and Pull does not select', () => {
    const { onSelect, onPull } = row();
    fireEvent.click(screen.getByRole('button', { name: /Pull Telemetry channel B/ }));
    expect(onPull).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Alt+ArrowUp/Down invoke the keyboard reorder handlers, plain arrows do not (#1996)', () => {
    const item: BacklogItem = {
      id: 'BI-003',
      programId: 'p',
      title: 'Telemetry channel B',
      itemType: 'story',
      status: 'PROPOSED',
      tags: [],
      priorityRank: 3,
      serverVersion: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    render(
      <BacklogListRow
        item={item}
        selected={false}
        dim={false}
        query=""
        canEdit
        pending={false}
        draggable
        isDropTarget={false}
        onSelect={vi.fn()}
        onPull={vi.fn()}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
      />,
    );
    const rowEl = screen.getByRole('button', { name: 'Telemetry channel B' });
    expect(rowEl).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');

    fireEvent.keyDown(rowEl, { key: 'ArrowUp', altKey: true });
    expect(onMoveUp).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(rowEl, { key: 'ArrowDown', altKey: true });
    expect(onMoveDown).toHaveBeenCalledTimes(1);

    // A bare arrow (no Alt) must not reorder — it is page/scroll navigation.
    fireEvent.keyDown(rowEl, { key: 'ArrowUp' });
    expect(onMoveUp).toHaveBeenCalledTimes(1);
  });

  it('shows the destination project instead of a Pull action when PULLED', () => {
    row({
      status: 'PULLED',
      pulledTo: {
        projectId: 'p-3',
        projectName: 'Avionics',
        taskId: 't',
        at: '2026-05-25T10:00:00Z',
      },
    });
    expect(screen.getByText('Avionics')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pull/ })).not.toBeInTheDocument();
  });
});
