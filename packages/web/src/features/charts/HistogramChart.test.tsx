import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HistogramChart } from './HistogramChart';

const BUCKETS = [
  { weekStart: '2026-06-01', count: 4 },
  { weekStart: '2026-06-08', count: 9 },
  { weekStart: '2026-06-15', count: 2 },
];

describe('HistogramChart', () => {
  it('draws one bar per server bucket and names the week holding each marker', () => {
    const { container } = render(
      <HistogramChart
        title="Finish by week"
        definition="Server sentence."
        buckets={BUCKETS}
        markers={[
          { key: 'p80', label: 'P80', date: '2026-06-10' },
          { key: 'p95', label: 'P95', date: '2026-06-17' },
        ]}
      />,
    );
    expect(container.querySelectorAll('svg[role="img"] rect')).toHaveLength(3);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.lastElementChild?.textContent)).toEqual(['', 'P80', 'P95']);
    expect(screen.getByRole('button', { name: 'What is Finish by week?' })).toBeInTheDocument();
  });

  it('renders an empty distribution without throwing', () => {
    render(<HistogramChart title="Finish by week" buckets={[]} />);
    expect(screen.getByText('No finish-date distribution.')).toBeInTheDocument();
  });
});
