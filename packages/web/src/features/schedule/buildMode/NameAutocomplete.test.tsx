import { createRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NameAutocomplete } from './NameAutocomplete';

const SUGGESTIONS = [
  'Foundation',
  'Framing',
  'Final inspection',
  'Roofing',
  'Electrical',
  'Plumbing',
  'HVAC',
];

// A caller's useAnchoredPopover result (#3664) — a fixture style is enough here
// since positioning math itself is the hook's own test's job; this file only
// needs to prove the panel still renders and behaves once portaled.
const POPOVER_STYLE = { position: 'fixed' as const, top: 0, left: 0, width: 280, maxHeight: 240 };
const panelRef = () => createRef<HTMLUListElement>();

describe('NameAutocomplete', () => {
  it('renders nothing when query is empty', () => {
    const { container } = render(
      <NameAutocomplete
        query=""
        suggestions={SUGGESTIONS}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        style={POPOVER_STYLE}
        panelRef={panelRef()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('filters suggestions by query (case-insensitive)', () => {
    render(
      <NameAutocomplete
        query="fr"
        suggestions={SUGGESTIONS}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        style={POPOVER_STYLE}
        panelRef={panelRef()}
      />,
    );
    expect(screen.getByText('Framing')).toBeInTheDocument();
    expect(screen.queryByText('Foundation')).toBeNull();
  });

  it('caps at 6 suggestions', () => {
    const many = Array.from({ length: 10 }, (_, i) => `Task ${i}`);
    render(
      <NameAutocomplete
        query="task"
        suggestions={many}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        style={POPOVER_STYLE}
        panelRef={panelRef()}
      />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(6);
  });

  it('calls onSelect when item is clicked (mousedown)', () => {
    const onSelect = vi.fn();
    render(
      <NameAutocomplete
        query="fr"
        suggestions={SUGGESTIONS}
        onSelect={onSelect}
        onDismiss={vi.fn()}
        style={POPOVER_STYLE}
        panelRef={panelRef()}
      />,
    );
    fireEvent.mouseDown(screen.getByText('Framing'));
    expect(onSelect).toHaveBeenCalledWith('Framing');
  });

  it('renders nothing when no suggestions match query', () => {
    const { container } = render(
      <NameAutocomplete
        query="zzz"
        suggestions={SUGGESTIONS}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        style={POPOVER_STYLE}
        panelRef={panelRef()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a listbox role', () => {
    render(
      <NameAutocomplete
        query="fo"
        suggestions={SUGGESTIONS}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        style={POPOVER_STYLE}
        panelRef={panelRef()}
      />,
    );
    expect(screen.getByRole('listbox', { name: 'Task name suggestions' })).toBeInTheDocument();
  });

  it('renders OUTSIDE the caller subtree, so no clipping ancestor can clip it (#3664)', () => {
    // The panel used to be an in-flow `absolute top-full left-0 w-[280px]` inside
    // the name cell, which renders inside TaskListPanel's `overflow-x-hidden`
    // virtualized scroll wrapper — a panel wider than the ~268px Timeline outline
    // column had no way to escape that clip. jsdom has no layout and cannot
    // measure the clip itself (the E2E spec asserts the box), but it CAN assert
    // the property that makes the clip impossible: only leaving the subtree
    // escapes a clipping ancestor, a z-index never does.
    const { container } = render(
      <NameAutocomplete
        query="fr"
        suggestions={SUGGESTIONS}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        style={POPOVER_STYLE}
        panelRef={panelRef()}
      />,
    );
    const panel = screen.getByRole('listbox', { name: 'Task name suggestions' });
    expect(container.contains(panel)).toBe(false);
  });

  it('renders nothing while unmeasured (style is null), matching the hook contract', () => {
    // useAnchoredPopover returns `null` for popoverStyle before the caller is
    // open/measured — the leaf must not portal a panel with no position yet.
    const { container } = render(
      <NameAutocomplete
        query="fr"
        suggestions={SUGGESTIONS}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        style={null}
        panelRef={panelRef()}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
