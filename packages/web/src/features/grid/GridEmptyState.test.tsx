import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GridEmptyState, GridFilteredEmptyState, type EmptyStateFacet } from './GridEmptyState';

/** One active facet with sensible defaults, so each test states only what it exercises. */
function facet(overrides: Partial<EmptyStateFacet> = {}): EmptyStateFacet {
  return {
    key: 'owner',
    label: 'Owner: J. Park',
    standaloneCount: 4,
    recoveredCount: 4,
    onDrop: vi.fn(),
    ...overrides,
  };
}

describe('GridEmptyState', () => {
  it('renders the zero-task empty state without a CTA when no handler is given', () => {
    render(<GridEmptyState />);
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add task' })).not.toBeInTheDocument();
  });

  it('renders the add-task CTA and calls it', () => {
    const onAddTask = vi.fn();
    render(<GridEmptyState onAddTask={onAddTask} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add task' }));
    expect(onAddTask).toHaveBeenCalledOnce();
  });
});

describe('GridFilteredEmptyState', () => {
  it('does not diagnose with no facets — a bare reduce would throw here', () => {
    render(<GridFilteredEmptyState onClear={vi.fn()} />);
    expect(screen.getByText('No tasks match these filters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Drop / })).not.toBeInTheDocument();
  });

  it('does not diagnose a single facet — one empty facet is self-explanatory', () => {
    render(<GridFilteredEmptyState onClear={vi.fn()} facets={[facet()]} />);
    expect(screen.getByText('No tasks match these filters')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Drop / })).not.toBeInTheDocument();
  });

  it('diagnoses two facets, naming each standalone count', () => {
    render(
      <GridFilteredEmptyState
        onClear={vi.fn()}
        facets={[
          facet({ key: 'owner', label: 'Owner: J. Park', standaloneCount: 4 }),
          facet({ key: 'status', label: 'Status: Done', standaloneCount: 7 }),
        ]}
      />,
    );
    expect(screen.getByText('No tasks match both filters')).toBeInTheDocument();
    expect(screen.getByText('Owner: J. Park')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Status: Done')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('uses the count word for three and four facets, and falls back past four', () => {
    const { unmount } = render(
      <GridFilteredEmptyState
        onClear={vi.fn()}
        facets={[1, 2, 3].map((n) => facet({ key: `f${n}`, label: `F${n}` }))}
      />,
    );
    expect(screen.getByText('No tasks match all three filters')).toBeInTheDocument();
    unmount();

    render(
      <GridFilteredEmptyState
        onClear={vi.fn()}
        facets={[1, 2, 3, 4, 5].map((n) => facet({ key: `f${n}`, label: `F${n}` }))}
      />,
    );
    expect(screen.getByText('No tasks match all 5 filters')).toBeInTheDocument();
  });

  it('offers to drop the facet whose removal recovers the most rows', () => {
    const dropOwner = vi.fn();
    const dropStatus = vi.fn();
    render(
      <GridFilteredEmptyState
        onClear={vi.fn()}
        facets={[
          facet({ key: 'owner', label: 'Owner: J. Park', recoveredCount: 2, onDrop: dropOwner }),
          facet({ key: 'status', label: 'Status: Done', recoveredCount: 9, onDrop: dropStatus }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Drop Status: Done' }));
    expect(dropStatus).toHaveBeenCalledOnce();
    expect(dropOwner).not.toHaveBeenCalled();
  });

  it('keeps the first facet on a tie, so the fold is stable', () => {
    render(
      <GridFilteredEmptyState
        onClear={vi.fn()}
        facets={[
          facet({ key: 'owner', label: 'Owner: J. Park', recoveredCount: 3 }),
          facet({ key: 'status', label: 'Status: Done', recoveredCount: 3 }),
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Drop Owner: J. Park' })).toBeInTheDocument();
  });

  it('suppresses the drop button when no single facet recovers anything', () => {
    render(
      <GridFilteredEmptyState
        onClear={vi.fn()}
        facets={[
          facet({ key: 'owner', label: 'Owner: J. Park', recoveredCount: 0 }),
          facet({ key: 'status', label: 'Status: Done', recoveredCount: 0 }),
        ]}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Drop / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all filters' })).toBeInTheDocument();
  });

  it('clears every filter from the clear-all button', () => {
    const onClear = vi.fn();
    render(
      <GridFilteredEmptyState
        onClear={onClear}
        facets={[facet({ key: 'owner' }), facet({ key: 'status', label: 'Status: Done' })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
