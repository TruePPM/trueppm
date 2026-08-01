/**
 * DetailView — the program-backlog edit drawer (#2668).
 *
 * Regression coverage for the four contradictions the drawer used to show at
 * once: two independent "Save changes" buttons for the same action, a bare
 * `#` for a null priorityRank, and a silent discard on a dirty close. (The
 * false "No tags yet" empty state and the popover z-order are covered in
 * `TagInput.test.tsx`, since they live entirely in that component.)
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../types';
import { DetailView, type DetailViewProps } from './DetailView';

function makeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'bi-00000001',
    programId: 'pg-1',
    title: 'Ship the radar module',
    description: 'Radar spike first',
    itemType: 'story',
    status: 'PROPOSED',
    tags: ['rf'],
    priorityRank: 3,
    serverVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function makeProps(over: Partial<DetailViewProps> = {}): DetailViewProps {
  return {
    item: makeItem(),
    tagSuggestions: ['rf', 'urgent'],
    estimationScale: 'fibonacci',
    canEdit: true,
    canDelete: true,
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onDelete: vi.fn(),
    onSendBack: vi.fn(),
    onPull: vi.fn(),
    onOpenLinkedTask: vi.fn(),
    ...over,
  };
}

function makeDirty() {
  fireEvent.change(screen.getByPlaceholderText(/No description yet/), {
    target: { value: 'Radar spike, revised' },
  });
}

describe('DetailView — single commit affordance (#2668 finding 1)', () => {
  it('renders exactly one "Save changes" button while the draft is dirty', () => {
    render(<DetailView {...makeProps()} />);
    makeDirty();
    expect(screen.getAllByRole('button', { name: 'Save changes' })).toHaveLength(1);
  });

  it('shows no commit affordance at all while the draft is clean', () => {
    render(<DetailView {...makeProps()} />);
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('the PROPOSED footer keeps its status actions but no Save button of its own', () => {
    render(<DetailView {...makeProps()} />);
    makeDirty();
    // Archive and Pull are the footer's own actions; Save lives only in the
    // deferred bar above — asserted by the single-button count above.
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pull to project…' })).toBeInTheDocument();
  });

  it('renders no status-action footer for a PULLED item outside the send-back window', () => {
    const item = makeItem({
      status: 'PULLED',
      pulledTo: { taskId: 't-1', at: '2020-01-01T00:00:00Z' },
    });
    render(<DetailView {...makeProps({ item })} />);
    expect(screen.queryByRole('button', { name: 'Send back to proposed' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
  });
});

describe('DetailView — priority rank rendering (#2668 finding 4)', () => {
  function priorityCell() {
    // The Priority row is a `<label>`/value pair in a CSS grid, not a labeled
    // form control — walk to the value that follows the "Priority" text node.
    return screen.getByText('Priority').nextElementSibling as HTMLElement;
  }

  it('renders a null priorityRank as a dash, never a bare "#"', () => {
    render(<DetailView {...makeProps({ item: makeItem({ priorityRank: null }) })} />);
    expect(priorityCell()).toHaveTextContent('—');
    expect(priorityCell()).not.toHaveTextContent('#');
  });

  it('renders a numeric priorityRank as "#N"', () => {
    render(<DetailView {...makeProps({ item: makeItem({ priorityRank: 7 }) })} />);
    expect(priorityCell()).toHaveTextContent('#7');
  });
});

describe('DetailView — dirty-close guard (#2668 finding 5)', () => {
  it('closes immediately with no guard when the draft is clean', () => {
    const onClose = vi.fn();
    render(<DetailView {...makeProps({ onClose })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards a dirty draft on the ✕ button instead of discarding silently', () => {
    const onClose = vi.fn();
    render(<DetailView {...makeProps({ onClose })} />);
    makeDirty();

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"Keep editing" dismisses the guard without closing or losing the draft', () => {
    const onClose = vi.fn();
    render(<DetailView {...makeProps({ onClose })} />);
    makeDirty();

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/No description yet/)).toHaveValue('Radar spike, revised');
  });
});

describe('DetailView — save round-trip', () => {
  it('saves the staged patch and re-baselines (the bar disappears) on success', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<DetailView {...makeProps({ onSave })} />);
    makeDirty();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Radar spike, revised' }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument(),
    );
  });

  it('keeps the draft dirty and shows an inline error when the save rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('network'));
    render(<DetailView {...makeProps({ onSave })} />);
    makeDirty();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save'));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('Discard reverts the draft to the last-saved values and clears the bar', () => {
    render(<DetailView {...makeProps()} />);
    makeDirty();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.getByPlaceholderText(/No description yet/)).toHaveValue('Radar spike first');
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });
});
