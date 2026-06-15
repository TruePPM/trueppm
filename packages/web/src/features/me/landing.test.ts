import { describe, it, expect } from 'vitest';
import { safeLandingPath, humanizeIntent, LANDING_FALLBACK_PATH } from './landing';

describe('safeLandingPath — landing allowlist guard (ADR-0129, #1181)', () => {
  it('passes through an allowlisted My Work path', () => {
    expect(safeLandingPath('/me/work')).toBe('/me/work');
  });

  it('passes through an allowlisted project path', () => {
    expect(safeLandingPath('/projects/abc-123/overview')).toBe('/projects/abc-123/overview');
  });

  it('falls back for an off-allowlist path (e.g. unreachable portfolio)', () => {
    expect(safeLandingPath('/portfolio')).toBe(LANDING_FALLBACK_PATH);
    expect(safeLandingPath('/programs/abc')).toBe(LANDING_FALLBACK_PATH);
  });

  it('falls back for a protocol-relative URL', () => {
    expect(safeLandingPath('//evil.com')).toBe(LANDING_FALLBACK_PATH);
  });

  it('falls back for a backslash-smuggled URL', () => {
    expect(safeLandingPath('/\\evil.com')).toBe(LANDING_FALLBACK_PATH);
  });

  it('falls back for an absolute off-origin URL', () => {
    expect(safeLandingPath('https://evil.com/me/work')).toBe(LANDING_FALLBACK_PATH);
  });

  it('falls back for an empty / undefined / null path', () => {
    expect(safeLandingPath('')).toBe(LANDING_FALLBACK_PATH);
    expect(safeLandingPath(undefined)).toBe(LANDING_FALLBACK_PATH);
    expect(safeLandingPath(null)).toBe(LANDING_FALLBACK_PATH);
  });
});

describe('humanizeIntent', () => {
  it('maps each intent to a human label', () => {
    expect(humanizeIntent('my_work')).toBe('My Work');
    expect(humanizeIntent('project_overview')).toBe("a project's Overview");
    expect(humanizeIntent('portfolio')).toBe('Portfolio');
  });
});
