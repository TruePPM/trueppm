import { describe, it, expect } from 'vitest';
import { forwardRelationLabel, relationLabel } from './relationLabel';

describe('relationLabel — forward (outgoing) vs inverse (incoming)', () => {
  it('relates_to is symmetric — "Relates to" in both directions', () => {
    expect(relationLabel('relates_to', 'outgoing')).toBe('Relates to');
    expect(relationLabel('relates_to', 'incoming')).toBe('Relates to');
  });

  it('blocks flips to "Blocked by" on the incoming side', () => {
    expect(relationLabel('blocks', 'outgoing')).toBe('Blocks');
    expect(relationLabel('blocks', 'incoming')).toBe('Blocked by');
  });

  it('duplicates flips to "Duplicated by" on the incoming side', () => {
    expect(relationLabel('duplicates', 'outgoing')).toBe('Duplicates');
    expect(relationLabel('duplicates', 'incoming')).toBe('Duplicated by');
  });
});

describe('forwardRelationLabel — the create-time (source) label', () => {
  it('always returns the forward label for every type', () => {
    expect(forwardRelationLabel('relates_to')).toBe('Relates to');
    expect(forwardRelationLabel('blocks')).toBe('Blocks');
    expect(forwardRelationLabel('duplicates')).toBe('Duplicates');
  });
});
