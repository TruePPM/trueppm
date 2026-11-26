import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TrailTimeline } from './TrailTimeline';

describe('TrailTimeline', () => {
  it('lists who, when, reason, words and deltas in order with no controls', () => {
    render(
      <TrailTimeline
        label="Change trail"
        entries={[
          {
            id: '1',
            who: 'Ana Lee',
            when: '12 Mar 2026',
            dateTime: '2026-03-12',
            reason: 'Scope added',
            words: 'Vendor added a step.',
            deltas: ['Finish 12 Mar → 19 Mar', 'Float 3 → 0'],
          },
          { id: '2', who: 'Ben Ito', when: '13 Mar 2026' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Change trail' });
    expect(list.children).toHaveLength(2);
    expect(list.children[0]).toHaveTextContent('Ana Lee');
    expect(list.children[0]).toHaveTextContent('Scope added');
    expect(screen.getByText('Float 3 → 0')).toBeInTheDocument();
    expect(screen.getByText('12 Mar 2026')).toHaveAttribute('datetime', '2026-03-12');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says so instead of drawing an empty list', () => {
    render(<TrailTimeline label="Change trail" entries={[]} />);
    expect(screen.getByText('No changes recorded yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
