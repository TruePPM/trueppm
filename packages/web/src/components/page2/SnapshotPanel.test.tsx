import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SnapshotPanel } from './SnapshotPanel';

const rows = [
  { id: 'forecast.p80', label: 'P80', value: 'Dec 7, 2026', now: 'Dec 14, 2026' },
  { id: 'forecast.p50', label: 'P50', value: null, notComputable: 'no forecast has run' },
];

describe('SnapshotPanel', () => {
  it('frozen mode keeps the posted value and adds a now tag', () => {
    render(<SnapshotPanel mode="frozen" rows={rows} asOf="Nov 20" />);
    expect(screen.getByText('Frozen when posted · as of Nov 20')).toBeInTheDocument();
    expect(screen.getByTestId('snapshot-row-forecast.p80')).toHaveTextContent('Dec 7, 2026');
    expect(screen.getByTestId('snapshot-now-forecast.p80')).toHaveTextContent('now Dec 14, 2026');
    expect(screen.getByTestId('snapshot-row-forecast.p50')).toHaveTextContent(
      'Not computable: no forecast has run',
    );
  });

  it('live mode says it freezes on post and never prints now tags', () => {
    render(<SnapshotPanel mode="live" rows={rows} />);
    expect(screen.getByText('Freezes when you post')).toBeInTheDocument();
    expect(screen.queryByTestId('snapshot-now-forecast.p80')).toBeNull();
  });
});
