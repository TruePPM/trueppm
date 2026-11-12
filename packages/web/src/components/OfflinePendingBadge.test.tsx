import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OfflinePendingBadge } from './OfflinePendingBadge';

describe('OfflinePendingBadge', () => {
  it('exposes a status role named by the supplied label', () => {
    render(<OfflinePendingBadge label="Queued — saves on reconnect." />);
    const badge = screen.getByRole('status', { name: 'Queued — saves on reconnect.' });
    expect(badge).toHaveTextContent('Pending');
    expect(badge).toHaveAttribute('title', 'Queued — saves on reconnect.');
  });

  it('compact drops the visible text but keeps the accessible name', () => {
    render(<OfflinePendingBadge label="Queued" compact />);
    const badge = screen.getByRole('status', { name: 'Queued' });
    expect(badge).not.toHaveTextContent('Pending');
  });

  it('uses a distinct title when given and merges className', () => {
    render(<OfflinePendingBadge label="Name" title="Tip" className="extra" />);
    const badge = screen.getByRole('status', { name: 'Name' });
    expect(badge).toHaveAttribute('title', 'Tip');
    expect(badge).toHaveClass('extra');
  });
});
