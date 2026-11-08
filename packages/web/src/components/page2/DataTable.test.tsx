import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable, type DataTableColumn } from './DataTable';

interface Row {
  id: string;
  name: string;
  days: number;
}
const ROWS: Row[] = [
  { id: 'a', name: 'Alpha', days: 3 },
  { id: 'b', name: 'Beta', days: 12 },
];
const COLS: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Task', cell: (r) => r.name },
  { key: 'days', header: 'Days', numeric: true, cell: (r) => r.days },
];

describe('DataTable (rule 439)', () => {
  it('is a named, focusable scroll region around a captioned table', () => {
    render(<DataTable caption="Tasks" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    const region = screen.getByRole('region', { name: 'Tasks' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(within(region).getByRole('table', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('has a 32px sticky header and 36px rows that grow to 44 on a coarse pointer or phone', () => {
    render(<DataTable caption="Tasks" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    const header = screen.getByRole('columnheader', { name: 'Task' });
    expect(header).toHaveClass('sticky', 'top-0', 'h-8');
    const row = screen.getAllByRole('row')[1];
    expect(row).toHaveClass('h-9', '[@media(pointer:coarse)]:h-11', 'max-md:h-11');
  });

  it.each([
    ['dense', 'h-8'],
    ['narrative', 'h-16'],
  ] as const)('%s density uses %s rows', (density, cls) => {
    render(
      <DataTable
        caption="Tasks"
        columns={COLS}
        rows={ROWS}
        rowKey={(r) => r.id}
        density={density}
      />,
    );
    expect(screen.getAllByRole('row')[1]).toHaveClass(cls);
  });

  it('does not zebra-stripe', () => {
    render(<DataTable caption="Tasks" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    for (const row of screen.getAllByRole('row')) expect(row.className).not.toMatch(/odd:|even:/);
  });

  it('right-aligns numbers in mono tabular figures', () => {
    render(<DataTable caption="Tasks" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    const cell = screen.getByRole('cell', { name: '12' });
    expect(cell).toHaveClass('text-right', 'font-mono', 'tabular-nums');
    expect(screen.getByRole('columnheader', { name: 'Days' })).toHaveClass('text-right');
  });

  it('freezes the identity column as a row header and edges it once scrolled', () => {
    render(<DataTable caption="Tasks" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    const identity = screen.getByRole('rowheader', { name: 'Alpha' });
    expect(identity).toHaveClass('sticky', 'left-0');
    expect(identity).not.toHaveClass('border-r');

    const region = screen.getByRole('region', { name: 'Tasks' });
    Object.defineProperty(region, 'scrollLeft', { value: 40, configurable: true });
    fireEvent.scroll(region);
    expect(region).toHaveAttribute('data-scrolled', 'true');
    expect(screen.getByRole('rowheader', { name: 'Alpha' })).toHaveClass('border-r');
  });

  it('wears the kit focus ring with offset, not an inset ring', () => {
    render(<DataTable caption="Tasks" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    const region = screen.getByRole('region', { name: 'Tasks' });
    expect(region).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-offset-2');
    expect(region.className).not.toContain('ring-inset');
  });
});
