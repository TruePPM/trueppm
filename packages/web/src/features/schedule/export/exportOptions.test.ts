import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXPORT_OPTIONS,
  estimateRenderMs,
  formatBytes,
  formatEstimate,
  formatPageCount,
} from './exportOptions';

describe('estimateRenderMs', () => {
  it('floors small schedules at 400ms', () => {
    expect(estimateRenderMs(0)).toBe(400);
    expect(estimateRenderMs(5)).toBe(400);
  });

  it('scales with activity count above the floor', () => {
    expect(estimateRenderMs(100)).toBe(1400);
    expect(estimateRenderMs(200)).toBe(2800);
  });

  it('never returns a negative estimate for a negative count', () => {
    expect(estimateRenderMs(-10)).toBe(400);
  });
});

describe('formatEstimate', () => {
  it('renders whole seconds with a ~ prefix, min 1s', () => {
    expect(formatEstimate(400)).toBe('~1s');
    expect(formatEstimate(2800)).toBe('~3s');
  });
});

describe('formatBytes', () => {
  it('renders B / KB / MB and an em dash for zero', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(84_000)).toBe('82 KB');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
  });

  it('renders an em dash for a non-finite size', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatPageCount', () => {
  it('pluralizes', () => {
    expect(formatPageCount(1)).toBe('1 page');
    expect(formatPageCount(3)).toBe('3 pages');
  });
});

describe('DEFAULT_EXPORT_OPTIONS', () => {
  it('defaults to Layout A, Letter, full schedule, arrows on, non-critical off', () => {
    expect(DEFAULT_EXPORT_OPTIONS).toMatchObject({
      layout: 'gantt',
      paper: 'letter',
      range: 'full',
      includeArrows: true,
      includeNonCritical: false,
      includeCpSummary: true,
      includeOwnerColumn: true,
    });
  });
});
