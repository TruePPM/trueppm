import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BacklogItem } from '../../types';
import { MobilePullSheet } from './MobilePullSheet';

const ITEM: BacklogItem = {
  id: 'bi-1',
  programId: 'pg-1',
  title: 'Ship the radar module',
  itemType: 'story',
  status: 'PROPOSED',
  tags: [],
  priorityRank: 1,
  serverVersion: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('MobilePullSheet', () => {
  it('Cancel pull button meets the 44px touch floor (h-11 w-11)', () => {
    render(
      <MobilePullSheet
        open
        item={ITEM}
        projects={[{ id: 'pr-1', name: 'Avionics' }]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Cancel pull' });
    expect(btn).toHaveClass('h-11', 'w-11');
    expect(btn).not.toHaveClass('h-9');
  });
});
