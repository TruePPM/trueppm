import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MoveToDialog } from './MoveToDialog';
import type { OutlineDragRow } from './outlineDrag';

const ROWS: OutlineDragRow[] = [
  { id: 'phase', name: 'Mobilization', wbs: '1', parentId: null, isMilestone: false, hasChildren: true },
  { id: 'a', name: 'Survey', wbs: '1.1', parentId: 'phase', isMilestone: false, hasChildren: false },
  { id: 'kid', name: 'Sub-survey', wbs: '1.1.1', parentId: 'a', isMilestone: false, hasChildren: false },
  { id: 'gate', name: 'NTP', wbs: '2', parentId: null, isMilestone: true, hasChildren: false },
  { id: 'tail', name: 'Closeout', wbs: '3', parentId: null, isMilestone: false, hasChildren: false },
];

function setup(taskId = 'a') {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <MoveToDialog
      taskId={taskId}
      taskName={ROWS.find((r) => r.id === taskId)?.name ?? ''}
      rows={ROWS}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onCancel, onConfirm };
}

describe('MoveToDialog — the drag’s twin for anyone not holding a pointer', () => {
  it('offers the top level and every legal phase', () => {
    setup();
    const options = screen.getAllByRole('radio').map((el) => el.textContent);
    expect(options[0]).toContain('Top level');
    expect(options.join(' ')).toContain('Mobilization');
    expect(options.join(' ')).toContain('Closeout');
  });

  it('omits a milestone — a gate cannot hold work', () => {
    setup();
    expect(screen.queryByRole('radio', { name: /NTP/ })).not.toBeInTheDocument();
  });

  it('omits the row itself and its own subtree', () => {
    setup('a');
    expect(screen.queryByRole('radio', { name: /Survey/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Sub-survey/ })).not.toBeInTheDocument();
  });

  it('marks the destination that would gain its first child', () => {
    setup();
    expect(screen.getByRole('radio', { name: /Closeout/ })).toHaveTextContent('becomes a phase');
  });
});

describe('MoveToDialog — committing', () => {
  it('produces the same plan shape a drop does', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByRole('radio', { name: /Closeout/ }));
    await user.click(screen.getByRole('button', { name: 'Move' }));

    expect(onConfirm).toHaveBeenCalledWith({
      taskId: 'a',
      newParentId: 'tail',
      beforeSiblingId: null,
      destinationName: 'Closeout',
      becomesPhase: true,
    });
  });

  it('sends null for the top level', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByRole('radio', { name: /Top level/ }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ newParentId: null, destinationName: null });
  });

  it('cannot commit before a destination is picked', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();
  });

  it('cannot commit a move to where the row already lives', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByRole('radio', { name: /Mobilization/ }));
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels on Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('MoveToDialog — a11y', () => {
  it('is a modal dialog with an accessible name', () => {
    setup();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('dialog', { name: /Move “Survey”/ })).toBeInTheDocument();
  });

  it('is a single-choice group, so picking one un-picks the rest', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByRole('radiogroup', { name: 'New parent' })).toBeInTheDocument();
    const closeout = screen.getByRole('radio', { name: /Closeout/ });
    expect(closeout).toHaveAttribute('aria-checked', 'false');
    await user.click(closeout);
    expect(closeout).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Top level/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('gives every destination a 44px touch target', () => {
    setup();
    for (const option of screen.getAllByRole('radio')) {
      expect(option.className).toContain('min-h-[44px]');
    }
  });
});
