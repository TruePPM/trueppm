import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HeatGrid13 } from './HeatGrid13';
import { HEAT_SEAT_MARK, HEAT_START_MARK } from './heatGridMarks';

const WEEKS = Array.from({ length: 13 }, (_, i) =>
  new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10),
);
const loads = (first: (number | null)[]) => [
  ...first,
  ...Array<number>(13 - first.length).fill(50),
];

describe('HeatGrid13', () => {
  it('bins cells with the shared load bands and states over and no-data in words', () => {
    render(
      <HeatGrid13
        label="Team load"
        weeks={WEEKS}
        rows={[{ id: 'a', name: 'Ana Lee', loads: loads([100, 101, null]) }]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Team load' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(14);
    const cells = within(table).getAllByRole('cell');
    expect(cells).toHaveLength(13);
    expect(cells[0]).toHaveAttribute('data-band', '80-100');
    expect(cells[1]).toHaveAttribute('data-band', '101-115');
    expect(cells[1]).toHaveTextContent('▲ 101% over-allocated');
    expect(cells[2]).toHaveTextContent('no working time');
    expect(screen.getByRole('list', { name: 'Load legend' })).toBeInTheDocument();
  });

  it('outlines the modeled seat and marks the start week', () => {
    render(
      <HeatGrid13
        label="Team load"
        weeks={WEEKS}
        startWeek={WEEKS[2]}
        rows={[{ id: 'a', name: 'Ana Lee', loads: loads([]) }]}
        modeledSeat={{ id: 'seat', name: 'Backend engineer', loads: loads([0]) }}
      />,
    );
    const seat = screen.getByRole('row', { name: /Backend engineer \(modeled seat\)/ });
    expect(seat).toHaveAttribute('data-modeled', 'true');
    const cells = within(seat).getAllByRole('cell');
    expect(cells[2]).toHaveAttribute('data-start', 'true');
    expect(cells[2].querySelector('[data-mark="start"]')).toHaveClass(
      ...HEAT_START_MARK.split(' '),
    );
    for (const cell of cells) {
      expect(cell.querySelector('[data-mark="seat"]')).toHaveClass(...HEAT_SEAT_MARK.split(' '));
    }
    expect(
      screen.getByRole('row', { name: /Ana Lee/ }).querySelector('[data-mark="seat"]'),
    ).toBeNull();
    expect(screen.getByRole('columnheader', { name: /Starts/ })).toBeInTheDocument();
  });

  it('prints the definition and as-of line when given them', () => {
    render(
      <HeatGrid13
        label="Team load"
        weeks={WEEKS}
        rows={[{ id: 'a', name: 'Ana Lee', loads: loads([]) }]}
        definition="Booked over working hours."
        asOf="2026-01-05T00:00:00Z"
      />,
    );
    expect(screen.getByText(/Booked over working hours\./)).toHaveTextContent(/· as of \S+/);
  });

  it('says so instead of drawing an empty table', () => {
    render(<HeatGrid13 label="Team load" weeks={WEEKS} rows={[]} />);
    expect(screen.getByText('No one to show in these weeks.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
