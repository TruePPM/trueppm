import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { BoardFilterControl, BoardFilterChips } from './BoardFilterControl';
import { EMPTY_FACETS, UNASSIGNED, type FacetFilters } from './boardFacets';

const ASSIGNEES = [
  { resourceId: 'r1', name: 'Alice' },
  { resourceId: 'r2', name: 'Bob' },
];

const LABELS = [
  { id: 'lab-1', name: 'tech-debt', color: 'amber' },
  { id: 'lab-2', name: 'blocked', color: 'rose' },
];

function renderControl(filters: FacetFilters, open = true, labelOptions = LABELS) {
  const onChange = vi.fn();
  const onClearAll = vi.fn();
  const onOpenChange = vi.fn();
  const triggerRef = createRef<HTMLButtonElement>();
  render(
    <BoardFilterControl
      filters={filters}
      assigneeOptions={ASSIGNEES}
      labelOptions={labelOptions}
      onChange={onChange}
      onClearAll={onClearAll}
      open={open}
      onOpenChange={onOpenChange}
      triggerRef={triggerRef}
    />,
  );
  return { onChange, onClearAll, onOpenChange };
}

describe('BoardFilterControl', () => {
  it('shows no count badge when no facet is active', () => {
    renderControl(EMPTY_FACETS, false);
    expect(screen.queryByTestId('board-filter-count')).toBeNull();
    expect(screen.getByTestId('board-filter-trigger')).toHaveAttribute('aria-label', 'Filters');
  });

  it('shows the active count on the trigger badge + aria-label', () => {
    renderControl({ assignees: ['r1'], priority: ['high'], due: [], labels: [] }, false);
    expect(screen.getByTestId('board-filter-count')).toHaveTextContent('2');
    expect(screen.getByTestId('board-filter-trigger')).toHaveAttribute('aria-label', 'Filters, 2 active');
  });

  it('renders assignee options plus the pinned Unassigned option', () => {
    renderControl(EMPTY_FACETS);
    expect(screen.getByTestId('facet-assignee-unassigned')).toBeInTheDocument();
    expect(screen.getByTestId('facet-assignee-r1')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('toggling a facet checkbox calls onChange with the updated set', () => {
    const { onChange } = renderControl(EMPTY_FACETS);
    fireEvent.click(screen.getByTestId('facet-priority-high'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ priority: ['high'] }));
  });

  it('Unassigned option is checked when the sentinel is active', () => {
    renderControl({ ...EMPTY_FACETS, assignees: [UNASSIGNED] });
    expect(screen.getByTestId('facet-assignee-unassigned')).toBeChecked();
  });

  it('Clear all is disabled with no active facets and enabled otherwise', () => {
    renderControl(EMPTY_FACETS);
    expect(screen.getByTestId('board-filter-clear-all')).toBeDisabled();
  });

  it('Clear all fires onClearAll', () => {
    const { onClearAll } = renderControl({ ...EMPTY_FACETS, priority: ['low'] });
    fireEvent.click(screen.getByTestId('board-filter-clear-all'));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it('renders the Label facet with a checkbox per label option (ADR-0400)', () => {
    renderControl(EMPTY_FACETS);
    expect(screen.getByTestId('facet-label-lab-1')).toBeInTheDocument();
    expect(screen.getByText('tech-debt')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
  });

  it('hides the Label facet when the board has no labeled cards', () => {
    renderControl(EMPTY_FACETS, true, []);
    expect(screen.queryByTestId('facet-label-lab-1')).toBeNull();
  });

  it('toggling a label checkbox calls onChange with the label id', () => {
    const { onChange } = renderControl(EMPTY_FACETS);
    fireEvent.click(screen.getByTestId('facet-label-lab-1'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ labels: ['lab-1'] }));
  });
});

describe('BoardFilterChips', () => {
  const nameById = new Map([
    ['r1', 'Alice'],
    ['r2', 'Bob'],
  ]);
  const labelNameById = new Map([
    ['lab-1', 'tech-debt'],
    ['lab-2', 'blocked'],
  ]);

  it('renders nothing when no facet is active', () => {
    const { container } = render(
      <BoardFilterChips
        filters={EMPTY_FACETS}
        assigneeNameById={nameById}
        labelNameById={labelNameById}
        matchCount={0}
        onChange={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a chip per active value, with Unassigned and priority/due labels', () => {
    render(
      <BoardFilterChips
        filters={{ assignees: ['r1', UNASSIGNED], priority: ['high'], due: ['overdue'], labels: ['lab-1'] }}
        assigneeNameById={nameById}
        labelNameById={labelNameById}
        matchCount={4}
        onChange={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('Priority: High')).toBeInTheDocument();
    expect(screen.getByText('Due: Overdue')).toBeInTheDocument();
    expect(screen.getByTestId('board-filter-chips')).toHaveTextContent('4 matches');
  });

  it('removing a chip calls onChange without that value', () => {
    const onChange = vi.fn();
    render(
      <BoardFilterChips
        filters={{ ...EMPTY_FACETS, priority: ['high'] }}
        assigneeNameById={nameById}
        labelNameById={labelNameById}
        matchCount={1}
        onChange={onChange}
        onClearAll={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: priority High' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ priority: [] }));
  });
});
