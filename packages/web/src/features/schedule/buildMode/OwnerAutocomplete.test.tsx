import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerAutocomplete } from './OwnerAutocomplete';
import type { ProjectResource } from '@/types';

function member(name: string, roleTitle = ''): ProjectResource {
  const id = name.toLowerCase().replace(/\s+/g, '-');
  return {
    id: `pr-${id}`,
    projectId: 'p1',
    resourceId: `r-${id}`,
    resource: { id: `r-${id}`, name, jobRole: '', maxUnits: 1, calendarId: null, skills: [] },
    roleTitle,
    unitsOverride: null,
    effectiveMaxUnits: 1,
    notes: '',
  };
}

const POOL = [
  member('Alex Rivera', 'Lead'),
  member('Alicia Stone'),
  member('Bao Tran'),
  member('Casey Quinn'),
  member('Dana Lee'),
  member('Eli Park'),
  member('Fatima Noor'),
  member('Gus Alonso'),
];

const STYLE = { position: 'fixed', top: 10, left: 20, width: 240 } as const;
const onSelect = vi.fn<(resource: ProjectResource) => void>();
const onDismiss = vi.fn();

function renderPicker(props: Partial<Parameters<typeof OwnerAutocomplete>[0]> = {}) {
  const panelRef = createRef<HTMLUListElement>();
  return render(
    <OwnerAutocomplete
      query=""
      pool={POOL}
      onSelect={onSelect}
      onDismiss={onDismiss}
      style={STYLE}
      panelRef={panelRef}
      {...props}
    />,
  );
}

beforeEach(() => {
  onSelect.mockReset();
  onDismiss.mockReset();
});

describe('OwnerAutocomplete', () => {
  it('lists at most six roster members for an empty query, with role titles', () => {
    renderPicker();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(6);
    expect(options[0]).toHaveTextContent('Alex Rivera');
    expect(options[0]).toHaveTextContent('Lead');
    expect(screen.queryByText('Gus Alonso')).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Assign owner' })).toBeInTheDocument();
  });

  it('filters case-insensitively on the roster name', () => {
    renderPicker({ query: '  ALI ' });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Alicia Stone']);
  });

  it('renders nothing when no member matches or when the caller has no position yet', () => {
    const { container, rerender } = render(
      <OwnerAutocomplete
        query="zzz"
        pool={POOL}
        onSelect={onSelect}
        onDismiss={onDismiss}
        style={STYLE}
        panelRef={createRef<HTMLUListElement>()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('listbox')).toBeNull();

    rerender(
      <OwnerAutocomplete
        query=""
        pool={POOL}
        onSelect={onSelect}
        onDismiss={onDismiss}
        style={null}
        panelRef={createRef<HTMLUListElement>()}
      />,
    );
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('moves the active row with the arrow keys, clamps at both ends, and commits on Enter', () => {
    renderPicker({ query: 'a' });
    const options = () => screen.getAllByRole('option');
    // Nothing active until the user arrows down.
    expect(options().every((o) => o.getAttribute('aria-selected') === 'false')).toBe(true);
    // Enter with no active row is not a commit.
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    // Two ups from row 1 lands on "none", not below it.
    expect(options().every((o) => o.getAttribute('aria-selected') === 'false')).toBe(true);
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(options()[0].textContent).toContain(onSelect.mock.calls[0][0].resource.name);
  });

  it('never moves past the last match', () => {
    renderPicker({ query: 'bao' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  });

  it('dismisses on Escape', () => {
    renderPicker();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('selects on mousedown so the pick lands before the cell blurs', () => {
    renderPicker({ query: 'dana' });
    const option = screen.getByRole('option');
    const notPrevented = fireEvent.mouseDown(option);
    expect(notPrevented).toBe(false);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'r-dana-lee' }));
  });

  it('resets the active row when the match set changes', () => {
    const { rerender } = renderPicker({ query: 'a' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    rerender(
      <OwnerAutocomplete
        query="ali"
        pool={POOL}
        onSelect={onSelect}
        onDismiss={onDismiss}
        style={STYLE}
        panelRef={createRef<HTMLUListElement>()}
      />,
    );
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'false');
  });
});
