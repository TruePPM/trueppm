import { describe, it, expect } from 'vitest';
import {
  LINK_STATUS_DOT_CLASS,
  LINK_STATUS_LABEL,
  LINK_STATUS_RANK,
  LINK_STATUS_TEXT_CLASS,
  worstLinkStatus,
  type ExternalLinkStatus,
} from './linkStatus';

describe('LINK_STATUS_RANK', () => {
  // Pins the canonical precedence so it can't drift from the Python
  // LINK_STATUS_RANK in apps/integrations/registry.py (#767, ADR-0153).
  it('is most-attention-first: closed < draft < open < merged < unknown', () => {
    expect(LINK_STATUS_RANK.closed).toBeLessThan(LINK_STATUS_RANK.draft);
    expect(LINK_STATUS_RANK.draft).toBeLessThan(LINK_STATUS_RANK.open);
    expect(LINK_STATUS_RANK.open).toBeLessThan(LINK_STATUS_RANK.merged);
    expect(LINK_STATUS_RANK.merged).toBeLessThan(LINK_STATUS_RANK.unknown);
  });

  it('assigns a unique rank to every status', () => {
    const ranks = Object.values(LINK_STATUS_RANK);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe('worstLinkStatus', () => {
  it('returns null for an empty set', () => {
    expect(worstLinkStatus([])).toBeNull();
  });

  it('returns the single status when there is one', () => {
    expect(worstLinkStatus(['merged'])).toBe('merged');
  });

  it('picks the most-attention status across a mix', () => {
    expect(worstLinkStatus(['open', 'closed'])).toBe('closed');
    expect(worstLinkStatus(['merged', 'draft'])).toBe('draft');
    expect(worstLinkStatus(['merged', 'open'])).toBe('open');
    expect(worstLinkStatus(['merged', 'unknown'])).toBe('merged');
    expect(worstLinkStatus(['closed', 'draft', 'open', 'merged', 'unknown'])).toBe('closed');
  });

  it('is order-independent', () => {
    expect(worstLinkStatus(['closed', 'open'])).toBe(worstLinkStatus(['open', 'closed']));
  });
});

describe('status token maps', () => {
  const ALL: ExternalLinkStatus[] = ['open', 'draft', 'merged', 'closed', 'unknown'];

  it('has a label, text class, and dot class for every status', () => {
    for (const status of ALL) {
      expect(LINK_STATUS_LABEL[status]).toBeTruthy();
      expect(LINK_STATUS_TEXT_CLASS[status]).toMatch(/^text-/);
      expect(LINK_STATUS_DOT_CLASS[status]).toBeTruthy();
    }
  });

  it('maps closed→critical, draft→at-risk, open→on-track, merged→brand', () => {
    expect(LINK_STATUS_TEXT_CLASS.closed).toContain('critical');
    expect(LINK_STATUS_TEXT_CLASS.draft).toContain('at-risk');
    expect(LINK_STATUS_TEXT_CLASS.open).toContain('on-track');
    expect(LINK_STATUS_TEXT_CLASS.merged).toContain('brand');
  });
});
