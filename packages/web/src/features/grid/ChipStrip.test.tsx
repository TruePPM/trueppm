import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { TaskStatus } from '@/types';
import { ChipStrip } from './ChipStrip';

describe('ChipStrip', () => {
  it('renders nothing when no filters are set', () => {
    const { container } = render(
      <ChipStrip search="" ownerFilter="" statusFilter="" overdue={false} onRemove={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a search chip when search is set', () => {
    render(<ChipStrip search="design" ownerFilter="" statusFilter="" overdue={false} onRemove={vi.fn()} />);
    expect(screen.getByText('"design"')).toBeInTheDocument();
  });

  it('renders an owner chip when owner is set', () => {
    render(<ChipStrip search="" ownerFilter="Alice" statusFilter="" overdue={false} onRemove={vi.fn()} />);
    expect(screen.getByText('Owner: Alice')).toBeInTheDocument();
  });

  it('renders a status chip when status is set, mapping to friendly label', () => {
    render(<ChipStrip search="" ownerFilter="" statusFilter="IN_PROGRESS" overdue={false} onRemove={vi.fn()} />);
    expect(screen.getByText('Status: In progress')).toBeInTheDocument();
  });

  it('clicking ✕ on a chip invokes onRemove with that key', () => {
    const onRemove = vi.fn();
    render(
      <ChipStrip
        search="design"
        ownerFilter="Alice"
        statusFilter="COMPLETE"
        overdue={false}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByLabelText('Remove "design" filter'));
    expect(onRemove).toHaveBeenCalledWith('search');
    fireEvent.click(screen.getByLabelText('Remove Owner: Alice filter'));
    expect(onRemove).toHaveBeenCalledWith('owner');
    fireEvent.click(screen.getByLabelText('Remove Status: Done filter'));
    expect(onRemove).toHaveBeenCalledWith('status');
  });

  it('falls back to the raw status string when the status is unknown', () => {
    // Forces the `STATUS_LABEL[statusFilter] ?? statusFilter` fallback branch.
    render(
      <ChipStrip
        search=""
        ownerFilter=""
        statusFilter={'UNKNOWN' as unknown as TaskStatus}
        overdue={false}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText('Status: UNKNOWN')).toBeInTheDocument();
  });
});

describe('ChipStrip — label chips (#2383)', () => {
  const chips = [
    { id: 'l1', name: 'Needs review', color: 'teal', count: 18 },
    { id: 'l2', name: 'Blocked', color: 'rose', count: 4 },
  ];

  it('renders a chip per selected label with its name and count', () => {
    render(
      <ChipStrip
        search=""
        ownerFilter=""
        statusFilter=""
        overdue={false}
        labelChips={chips}
        onRemove={vi.fn()}
        onRemoveLabel={vi.fn()}
      />,
    );
    // Name is always present next to the swatch — colour is never the only cue.
    expect(screen.getByText(/Needs review/)).toBeInTheDocument();
    expect(screen.getByText(/Blocked/)).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('mounts the strip for a label filter even with no other facet set', () => {
    const { container } = render(
      <ChipStrip
        search=""
        ownerFilter=""
        statusFilter=""
        overdue={false}
        labelChips={chips}
        onRemove={vi.fn()}
      />,
    );
    expect(container.firstChild).not.toBeNull();
  });

  it('each ✕ removes only its own label', () => {
    const onRemoveLabel = vi.fn();
    render(
      <ChipStrip
        search=""
        ownerFilter=""
        statusFilter=""
        overdue={false}
        labelChips={chips}
        onRemove={vi.fn()}
        onRemoveLabel={onRemoveLabel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: label Blocked' }));
    expect(onRemoveLabel).toHaveBeenCalledWith('l2');
    expect(onRemoveLabel).toHaveBeenCalledTimes(1);
  });

  it('Delete on a focused ✕ removes too', () => {
    const onRemoveLabel = vi.fn();
    render(
      <ChipStrip
        search=""
        ownerFilter=""
        statusFilter=""
        overdue={false}
        labelChips={chips}
        onRemove={vi.fn()}
        onRemoveLabel={onRemoveLabel}
      />,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Remove filter: label Needs review' }), {
      key: 'Delete',
    });
    expect(onRemoveLabel).toHaveBeenCalledWith('l1');
  });

  it('re-seats focus on the next chip after a removal', () => {
    render(
      <ChipStrip
        search=""
        ownerFilter=""
        statusFilter=""
        overdue={false}
        labelChips={chips}
        onRemove={vi.fn()}
        onRemoveLabel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: label Needs review' }));
    expect(screen.getByRole('button', { name: 'Remove filter: label Blocked' })).toHaveFocus();
  });

  it('returns focus to the facet trigger when the last chip goes', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    render(
      <ChipStrip
        search=""
        ownerFilter=""
        statusFilter=""
        overdue={false}
        labelChips={[chips[0]]}
        onRemove={vi.fn()}
        onRemoveLabel={vi.fn()}
        labelTriggerRef={{ current: trigger }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: label Needs review' }));
    expect(trigger).toHaveFocus();
  });

  it('renders the offline note ahead of the chips', () => {
    render(
      <ChipStrip
        search=""
        ownerFilter=""
        statusFilter=""
        overdue={false}
        labelChips={chips}
        note="Offline — filtering the 214 rows already loaded"
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Offline — filtering the 214 rows already loaded'),
    ).toBeInTheDocument();
  });
});
