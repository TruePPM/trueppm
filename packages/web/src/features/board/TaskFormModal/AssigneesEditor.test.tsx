import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectResource } from '@/types';
import { AssigneesEditor, type AssigneeWorkingRow } from './AssigneesEditor';

function makePool(
  entries: Array<{ id: string; name: string; roleTitle?: string }>,
): ProjectResource[] {
  return entries.map((e) => ({
    resource: { id: e.id, name: e.name } as ProjectResource['resource'],
    roleTitle: e.roleTitle ?? '',
  })) as ProjectResource[];
}

describe('AssigneesEditor', () => {
  it('renders empty state with placeholder for the search input', () => {
    render(
      <AssigneesEditor
        rows={[]}
        pool={makePool([])}
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText('Search people…')).toBeInTheDocument();
  });

  it('renders existing rows with initials, percent value, and remove button', () => {
    const rows: AssigneeWorkingRow[] = [
      { resourceId: 'r1', resourceName: 'Maya Patel', units: 0.6 },
    ];
    render(
      <AssigneesEditor
        rows={rows}
        pool={makePool([])}
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>(
      'Allocation percent for Maya Patel',
    );
    expect(input.value).toBe('60');
    expect(screen.getByRole('button', { name: 'Remove Maya Patel' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Add another…')).toBeInTheDocument();
  });

  it('renders a single-letter initial when the resource name has only one word', () => {
    const rows: AssigneeWorkingRow[] = [
      { resourceId: 'r1', resourceName: 'Maya', units: 1 },
    ];
    render(
      <AssigneesEditor
        rows={rows}
        pool={makePool([])}
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    // The initials span is aria-hidden but its text content is "M".
    expect(screen.getByText('M')).toBeInTheDocument();
  });

  it('renders a "?" initial when the resource name is empty whitespace', () => {
    const rows: AssigneeWorkingRow[] = [
      { resourceId: 'r1', resourceName: '   ', units: 1 },
    ];
    render(
      <AssigneesEditor
        rows={rows}
        pool={makePool([])}
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('calls onUpdateUnits with parsed decimal value when the input changes', () => {
    const onUpdateUnits = vi.fn();
    const rows: AssigneeWorkingRow[] = [
      { resourceId: 'r1', resourceName: 'Maya', units: 0.5 },
    ];
    render(
      <AssigneesEditor
        rows={rows}
        pool={makePool([])}
        onAdd={vi.fn()}
        onUpdateUnits={onUpdateUnits}
        onRemove={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('Allocation percent for Maya');
    fireEvent.change(input, { target: { value: '80' } });
    expect(onUpdateUnits).toHaveBeenCalledWith(0, 0.8);
  });

  it('treats an empty input as zero so the user can clear before retyping', () => {
    const onUpdateUnits = vi.fn();
    const rows: AssigneeWorkingRow[] = [
      { resourceId: 'r1', resourceName: 'Maya', units: 0.5 },
    ];
    render(
      <AssigneesEditor
        rows={rows}
        pool={makePool([])}
        onAdd={vi.fn()}
        onUpdateUnits={onUpdateUnits}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Allocation percent for Maya'), {
      target: { value: '' },
    });
    expect(onUpdateUnits).toHaveBeenCalledWith(0, 0);
  });

  it('filters the picker by case-insensitive substring match and excludes already-assigned resources', () => {
    const onAdd = vi.fn();
    const pool = makePool([
      { id: 'r1', name: 'Maya Patel', roleTitle: 'PM' },
      { id: 'r2', name: 'David Kim' },
      { id: 'r3', name: 'maya johnson' },
    ]);
    const rows: AssigneeWorkingRow[] = [
      { resourceId: 'r3', resourceName: 'maya johnson', units: 1 },
    ];
    render(
      <AssigneesEditor
        rows={rows}
        pool={pool}
        onAdd={onAdd}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const search = screen.getByPlaceholderText('Add another…');
    fireEvent.change(search, { target: { value: 'maya' } });
    // r3 is already assigned and must be excluded; r1 must remain.
    const listbox = screen.getByRole('listbox', { name: 'People matching search' });
    expect(listbox).toBeInTheDocument();
    expect(screen.getByText('Maya Patel')).toBeInTheDocument();
    expect(screen.getByText('PM')).toBeInTheDocument();
    expect(screen.queryByText('David Kim')).not.toBeInTheDocument();
  });

  it('renders no listbox when the search box is empty', () => {
    render(
      <AssigneesEditor
        rows={[]}
        pool={makePool([{ id: 'r1', name: 'Maya' }])}
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('clears the search and calls onAdd when a picker option is clicked', () => {
    const onAdd = vi.fn();
    const pool = makePool([{ id: 'r1', name: 'Maya' }]);
    render(
      <AssigneesEditor
        rows={[]}
        pool={pool}
        onAdd={onAdd}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const search = screen.getByPlaceholderText('Search people…');
    fireEvent.change(search, { target: { value: 'maya' } });
    fireEvent.click(screen.getByRole('button', { name: /Maya/ }));
    expect(onAdd).toHaveBeenCalledWith({ id: 'r1', name: 'Maya' });
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('shows the role title in the picker option only when present', () => {
    const pool = makePool([
      { id: 'r1', name: 'Maya', roleTitle: 'PM' },
      { id: 'r2', name: 'David', roleTitle: '' },
    ]);
    render(
      <AssigneesEditor
        rows={[]}
        pool={pool}
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const search = screen.getByPlaceholderText('Search people…');
    fireEvent.change(search, { target: { value: 'a' } });
    expect(screen.getByText('PM')).toBeInTheDocument();
  });

  it('Σ total turns at-risk when total exceeds 1.00 and remains neutral otherwise', () => {
    const overRows: AssigneeWorkingRow[] = [
      { resourceId: 'r1', resourceName: 'Maya', units: 0.8 },
      { resourceId: 'r2', resourceName: 'David', units: 0.6 },
    ];
    const { rerender } = render(
      <AssigneesEditor
        rows={overRows}
        pool={makePool([])}
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Total allocation 1.40')).toHaveClass(
      'text-semantic-at-risk',
    );

    const okRows: AssigneeWorkingRow[] = [
      { resourceId: 'r1', resourceName: 'Maya', units: 0.4 },
    ];
    rerender(
      <AssigneesEditor
        rows={okRows}
        pool={makePool([])}
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Total allocation 0.40')).toHaveClass(
      'text-neutral-text-secondary',
    );
  });

  it('disables row inputs and remove buttons when disabled is true', () => {
    const rows: AssigneeWorkingRow[] = [
      { resourceId: 'r1', resourceName: 'Maya', units: 1 },
    ];
    render(
      <AssigneesEditor
        rows={rows}
        pool={makePool([{ id: 'r2', name: 'David' }])}
        disabled
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Allocation percent for Maya')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Maya' })).toBeDisabled();
    expect(screen.getByPlaceholderText('Add another…')).toBeDisabled();
    // Even with a search match, the listbox is suppressed when disabled.
    fireEvent.change(screen.getByPlaceholderText('Add another…'), {
      target: { value: 'david' },
    });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('caps the picker results at 8 matches', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      name: `Person ${i}`,
    }));
    render(
      <AssigneesEditor
        rows={[]}
        pool={makePool(many)}
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('Search people…'), {
      target: { value: 'person' },
    });
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(8);
  });

  it('calls onRemove with the row index when × is clicked', () => {
    const onRemove = vi.fn();
    const rows: AssigneeWorkingRow[] = [
      { resourceId: 'r1', resourceName: 'A', units: 0.5 },
      { resourceId: 'r2', resourceName: 'B', units: 0.5 },
    ];
    render(
      <AssigneesEditor
        rows={rows}
        pool={makePool([])}
        onAdd={vi.fn()}
        onUpdateUnits={vi.fn()}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove B' }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
