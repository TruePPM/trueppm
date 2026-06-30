import { describe, it, expect } from 'vitest';
import { classifyCardSignal, cardSignalToneClass, type CardSignalInput } from './cardSignal';

/** An on-track card: every signal off. Spread + override per case. */
const ON_TRACK: CardSignalInput = {
  isBlocked: false,
  predecessorCount: 0,
  isAging: false,
  isStalled: false,
  isPastTwiceSla: false,
  daysAgo: null,
  showCriticalState: false,
  floatDays: 3,
  spiBand: 'on_track',
  cpi: 1.0,
};

describe('classifyCardSignal (#1305)', () => {
  it('returns null for an on-track card (no badge)', () => {
    expect(classifyCardSignal(ON_TRACK)).toBeNull();
  });

  it('classifies a blocked card with a non-lossy dependency count', () => {
    const sig = classifyCardSignal({ ...ON_TRACK, isBlocked: true, predecessorCount: 2 });
    expect(sig).toMatchObject({ tier: 'blocked', tone: 'critical' });
    expect(sig?.label).toBe('Blocked · 2 deps');
    expect(sig?.srText).toContain('2 dependencies');
  });

  it('singularizes the dependency count', () => {
    const sig = classifyCardSignal({ ...ON_TRACK, isBlocked: true, predecessorCount: 1 });
    expect(sig?.label).toBe('Blocked · 1 dep');
    expect(sig?.srText).toContain('1 dependency');
  });

  it('omits the count when a blocked card has no predecessors', () => {
    const sig = classifyCardSignal({ ...ON_TRACK, isBlocked: true, predecessorCount: 0 });
    expect(sig?.label).toBe('Blocked');
  });

  it('classifies a stale card as at-risk under twice the SLA', () => {
    const sig = classifyCardSignal({
      ...ON_TRACK,
      isAging: true,
      isStalled: true,
      isPastTwiceSla: false,
      daysAgo: 6,
    });
    expect(sig).toMatchObject({ tier: 'stale', tone: 'at-risk' });
    expect(sig?.label).toBe('Stale 6d');
  });

  it('escalates a stale card to critical past twice the SLA', () => {
    const sig = classifyCardSignal({
      ...ON_TRACK,
      isAging: true,
      isStalled: true,
      isPastTwiceSla: true,
      daysAgo: 14,
    });
    expect(sig).toMatchObject({ tier: 'stale', tone: 'critical' });
    // Escalation is in the label, not color alone (rule 12).
    expect(sig?.label).toBe('Very stale 14d');
    expect(sig?.srText).toContain('over twice the limit');
  });

  it('classifies a critical-path card', () => {
    const sig = classifyCardSignal({ ...ON_TRACK, showCriticalState: true });
    expect(sig).toMatchObject({ tier: 'critical', tone: 'critical', label: 'Critical path' });
  });

  it('classifies negative float as "Nd late"', () => {
    const sig = classifyCardSignal({ ...ON_TRACK, floatDays: -3 });
    expect(sig).toMatchObject({ tier: 'critical', tone: 'critical', label: '3d late' });
    expect(sig?.srText).toContain('negative float');
  });

  it('classifies a behind-EVM card as critical', () => {
    const sig = classifyCardSignal({ ...ON_TRACK, spiBand: 'behind' });
    expect(sig).toMatchObject({ tier: 'behind', tone: 'critical', label: 'Behind' });
  });

  it('classifies an at-risk-EVM card as at-risk', () => {
    const sig = classifyCardSignal({ ...ON_TRACK, spiBand: 'at_risk' });
    expect(sig).toMatchObject({ tier: 'behind', tone: 'at-risk', label: 'At risk' });
  });

  it('treats low CPI as behind even when SPI is on track', () => {
    const sig = classifyCardSignal({ ...ON_TRACK, spiBand: 'on_track', cpi: 0.8 });
    expect(sig).toMatchObject({ tier: 'behind', tone: 'critical', label: 'Behind' });
  });

  describe('tie-breaks — strict severity order', () => {
    it('blocked outranks critical path and stale', () => {
      const sig = classifyCardSignal({
        ...ON_TRACK,
        isBlocked: true,
        predecessorCount: 1,
        showCriticalState: true,
        isAging: true,
        isStalled: true,
        daysAgo: 9,
      });
      expect(sig?.tier).toBe('blocked');
    });

    it('stale outranks critical path', () => {
      const sig = classifyCardSignal({
        ...ON_TRACK,
        isAging: true,
        isStalled: true,
        daysAgo: 9,
        showCriticalState: true,
      });
      expect(sig?.tier).toBe('stale');
    });

    it('critical path outranks behind-EVM', () => {
      const sig = classifyCardSignal({ ...ON_TRACK, showCriticalState: true, spiBand: 'behind' });
      expect(sig?.tier).toBe('critical');
    });

    it('ignores aging without staleness or 2x-SLA (no stale badge)', () => {
      // isAging alone (past SLA but not stalled and not 2x) is not yet a primary
      // signal — it shows in the peek, not the worst-offender badge.
      const sig = classifyCardSignal({
        ...ON_TRACK,
        isAging: true,
        isStalled: false,
        isPastTwiceSla: false,
        daysAgo: 4,
      });
      expect(sig).toBeNull();
    });
  });

  it('maps tone to the rule-8b -bg token pairing', () => {
    expect(cardSignalToneClass('critical')).toContain('bg-semantic-critical-bg');
    expect(cardSignalToneClass('critical')).toContain('text-semantic-critical');
    expect(cardSignalToneClass('at-risk')).toContain('bg-semantic-at-risk-bg');
    expect(cardSignalToneClass('at-risk')).toContain('text-semantic-at-risk');
  });
});
