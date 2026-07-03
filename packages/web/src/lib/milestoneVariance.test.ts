import { describe, it, expect } from 'vitest';
import {
  milestoneVarianceAnnotation,
  varianceToneTextClass,
  varianceToneChipClass,
} from './milestoneVariance';

describe('milestoneVarianceAnnotation', () => {
  it('overrides to critical + "critical path" when on the critical path, regardless of slip', () => {
    for (const varianceDays of [-4, 0, 2, 20]) {
      const a = milestoneVarianceAnnotation({
        varianceDays,
        totalFloatDays: 12, // float present but ignored when critical
        onCriticalPath: true,
      });
      expect(a.tone).toBe('critical');
      expect(a.annotation).toBe('critical path');
      expect(a.ariaAnnotation).toBe('on the critical path');
    }
  });

  it('is red when the slip exceeds available float', () => {
    const a = milestoneVarianceAnnotation({
      varianceDays: 6,
      totalFloatDays: 3,
      onCriticalPath: false,
    });
    expect(a.tone).toBe('critical');
    expect(a.annotation).toBe('3d float');
    expect(a.ariaAnnotation).toBe('3 days of float remaining');
  });

  it('is amber when the slip is within available float', () => {
    const a = milestoneVarianceAnnotation({
      varianceDays: 3,
      totalFloatDays: 8,
      onCriticalPath: false,
    });
    expect(a.tone).toBe('at-risk');
    expect(a.annotation).toBe('8d float');
  });

  it('treats slip exactly equal to float as within (amber)', () => {
    const a = milestoneVarianceAnnotation({
      varianceDays: 5,
      totalFloatDays: 5,
      onCriticalPath: false,
    });
    expect(a.tone).toBe('at-risk');
  });

  it('is green when ahead of the milestone, regardless of float', () => {
    const a = milestoneVarianceAnnotation({
      varianceDays: -2,
      totalFloatDays: 4,
      onCriticalPath: false,
    });
    expect(a.tone).toBe('on-track');
    expect(a.annotation).toBe('4d float');
  });

  it('singularizes the float aria phrase at 1 day', () => {
    const a = milestoneVarianceAnnotation({
      varianceDays: 3,
      totalFloatDays: 1,
      onCriticalPath: false,
    });
    expect(a.ariaAnnotation).toBe('1 day of float remaining');
  });

  it('falls back to the magnitude band with no suffix when float is unknown', () => {
    const within = milestoneVarianceAnnotation({
      varianceDays: 4,
      totalFloatDays: null,
      onCriticalPath: false,
    });
    expect(within.tone).toBe('at-risk');
    expect(within.annotation).toBeNull();
    expect(within.ariaAnnotation).toBeNull();

    const over = milestoneVarianceAnnotation({
      varianceDays: 9,
      totalFloatDays: undefined,
      onCriticalPath: false,
    });
    expect(over.tone).toBe('critical');
    expect(over.annotation).toBeNull();
  });

  it('is neutral on-time / unknown variance with no float', () => {
    expect(
      milestoneVarianceAnnotation({ varianceDays: 0, totalFloatDays: null, onCriticalPath: false })
        .tone,
    ).toBe('neutral');
    expect(
      milestoneVarianceAnnotation({ varianceDays: null, totalFloatDays: null, onCriticalPath: false })
        .tone,
    ).toBe('neutral');
  });
});

describe('tone class mappers', () => {
  it('maps each tone to a text color class', () => {
    expect(varianceToneTextClass('critical')).toContain('semantic-critical');
    expect(varianceToneTextClass('at-risk')).toContain('semantic-at-risk');
    expect(varianceToneTextClass('on-track')).toContain('semantic-on-track');
    expect(varianceToneTextClass('neutral')).toContain('neutral-text');
  });

  it('maps each tone to a bordered-pill class', () => {
    expect(varianceToneChipClass('critical')).toContain('border-semantic-critical');
    expect(varianceToneChipClass('at-risk')).toContain('border-semantic-at-risk');
    expect(varianceToneChipClass('on-track')).toContain('border-semantic-on-track');
    expect(varianceToneChipClass('neutral')).toContain('border-neutral-border');
  });
});
