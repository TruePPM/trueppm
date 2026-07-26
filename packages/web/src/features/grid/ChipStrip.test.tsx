import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { ChipStrip } from './ChipStrip';

type Props = ComponentProps<typeof ChipStrip>;

/** Every required handler stubbed, so each test states only what it exercises. */
function renderStrip(overrides: Partial<Props> = {}) {
  const props: Props = {
    search: '',
    overdue: false,
    onRemoveSearch: vi.fn(),
    onRemoveOverdue: vi.fn(),
    ...overrides,
  };
  return render(<ChipStrip {...props} />);
}

describe('ChipStrip', () => {
  it('renders nothing when no filters are set', () => {
    const { container } = renderStrip();
    expect(container.firstChild).toBeNull();
  });

  it('renders a search chip when search is set', () => {
    renderStrip({ search: 'design' });
    expect(screen.getByText('"design"')).toBeInTheDocument();
  });

  it('renders one chip per selected owner', () => {
    renderStrip({
      ownerChips: [
        { id: 'r1', name: 'Alice' },
        { id: 'r2', name: 'Bob' },
      ],
    });
    expect(screen.getByText('Owner: Alice')).toBeInTheDocument();
    expect(screen.getByText('Owner: Bob')).toBeInTheDocument();
  });

  it('renders one chip per selected status', () => {
    renderStrip({
      statusChips: [
        { id: 'IN_PROGRESS', name: 'In progress' },
        { id: 'ON_HOLD', name: 'On hold' },
      ],
    });
    expect(screen.getByText('Status: In progress')).toBeInTheDocument();
    expect(screen.getByText('Status: On hold')).toBeInTheDocument();
  });

  it('each ✕ removes only its own value', () => {
    const onRemoveOwner = vi.fn();
    const onRemoveStatus = vi.fn();
    renderStrip({
      ownerChips: [
        { id: 'r1', name: 'Alice' },
        { id: 'r2', name: 'Bob' },
      ],
      statusChips: [{ id: 'COMPLETE', name: 'Done' }],
      onRemoveOwner,
      onRemoveStatus,
    });
    fireEvent.click(screen.getByLabelText('Remove Owner: Bob filter'));
    expect(onRemoveOwner).toHaveBeenCalledWith('r2');
    expect(onRemoveOwner).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Remove Status: Done filter'));
    expect(onRemoveStatus).toHaveBeenCalledWith('COMPLETE');
  });

  it('renders chips in toolbar order — search, owner, status, label, overdue', () => {
    renderStrip({
      search: 'slab',
      ownerChips: [{ id: 'r1', name: 'Alice' }],
      statusChips: [{ id: 'IN_PROGRESS', name: 'In progress' }],
      labelChips: [{ id: 'l1', name: 'Needs review', color: 'teal', count: 18 }],
      overdue: true,
      onRemoveLabel: vi.fn(),
    });
    // The strip is a restatement of the toolbar above it, so the reading order
    // has to match the control order — not the order state happens to update in.
    const order = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .filter((l): l is string => Boolean(l));
    expect(order).toEqual([
      'Remove "slab" filter',
      'Remove Owner: Alice filter',
      'Remove Status: In progress filter',
      'Remove filter: label Needs review',
      'Remove Overdue filter',
    ]);
  });

  it('offers Clear all when the host supplies a handler', () => {
    const onClearAll = vi.fn();
    renderStrip({ search: 'design', onClearAll });
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalled();
  });
});

describe('ChipStrip — label chips (#2383)', () => {
  const chips = [
    { id: 'l1', name: 'Needs review', color: 'teal', count: 18 },
    { id: 'l2', name: 'Blocked', color: 'rose', count: 4 },
  ];

  it('renders a chip per selected label with its name and count', () => {
    renderStrip({ labelChips: chips, onRemoveLabel: vi.fn() });
    // Name is always present next to the swatch — colour is never the only cue.
    expect(screen.getByText(/Needs review/)).toBeInTheDocument();
    expect(screen.getByText(/Blocked/)).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('mounts the strip for a label filter even with no other facet set', () => {
    const { container } = renderStrip({ labelChips: chips });
    expect(container.firstChild).not.toBeNull();
  });

  it('each ✕ removes only its own label', () => {
    const onRemoveLabel = vi.fn();
    renderStrip({ labelChips: chips, onRemoveLabel });
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: label Blocked' }));
    expect(onRemoveLabel).toHaveBeenCalledWith('l2');
    expect(onRemoveLabel).toHaveBeenCalledTimes(1);
  });

  it('Delete on a focused ✕ removes too', () => {
    const onRemoveLabel = vi.fn();
    renderStrip({ labelChips: chips, onRemoveLabel });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Remove filter: label Needs review' }), {
      key: 'Delete',
    });
    expect(onRemoveLabel).toHaveBeenCalledWith('l1');
  });

  it('re-seats focus on the next chip after a removal', () => {
    renderStrip({ labelChips: chips, onRemoveLabel: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: label Needs review' }));
    expect(screen.getByRole('button', { name: 'Remove filter: label Blocked' })).toHaveFocus();
  });

  it('returns focus to the facet trigger when the last chip of that facet goes', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    renderStrip({
      labelChips: [chips[0]],
      onRemoveLabel: vi.fn(),
      labelTriggerRef: { current: trigger },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: label Needs review' }));
    expect(trigger).toHaveFocus();
  });

  it('hands focus to the owning facet trigger per facet, not one shared fallback', () => {
    const ownerTrigger = document.createElement('button');
    const statusTrigger = document.createElement('button');
    document.body.append(ownerTrigger, statusTrigger);
    renderStrip({
      statusChips: [{ id: 'COMPLETE', name: 'Done' }],
      onRemoveStatus: vi.fn(),
      ownerTriggerRef: { current: ownerTrigger },
      statusTriggerRef: { current: statusTrigger },
    });
    // Removing the only Status chip must land on the *Status* trigger — with a
    // single shared fallback this would jump to Owner, two controls away.
    fireEvent.click(screen.getByLabelText('Remove Status: Done filter'));
    expect(statusTrigger).toHaveFocus();
  });

  it('renders the offline note ahead of the chips', () => {
    renderStrip({
      labelChips: chips,
      note: 'Offline — filtering the 214 rows already loaded',
    });
    expect(
      screen.getByText('Offline — filtering the 214 rows already loaded'),
    ).toBeInTheDocument();
  });
});
