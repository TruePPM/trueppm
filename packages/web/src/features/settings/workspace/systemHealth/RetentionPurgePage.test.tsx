/**
 * RetentionPurgePage — RunStateBadge unit tests.
 *
 * Focused on the "running" status dot's reduced-motion behavior (WCAG 2.3.3,
 * issue 1027): the pulse must be gated behind `motion-safe`, and a permanent
 * brand-colored ring must keep the running state perceivable when the user has
 * reduced-motion enabled. RunStateBadge is a pure presentational component, so
 * these tests render it directly with a minimal PurgeRun fixture — no hooks or
 * query client required.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunStateBadge } from './RetentionPurgePage';
import type { PurgeRun, PurgeRunState, PurgeRunTrigger } from '@/hooks/useRetention';

function makeRun(overrides: Partial<PurgeRun> = {}): PurgeRun {
  return {
    id: 'run-1',
    started_at: '2026-04-29T10:00:00Z',
    finished_at: null,
    trigger: 'manual' as PurgeRunTrigger,
    state: 'running' as PurgeRunState,
    tables: [],
    rows_deleted: 0,
    bytes_freed: null,
    error: '',
    duration_ms: null,
    ...overrides,
  };
}

describe('RetentionPurgePage / RunStateBadge', () => {
  it('gates the running-dot pulse behind motion-safe with a non-animated ring fallback', () => {
    const { container } = render(<RunStateBadge run={makeRun({ state: 'running' })} />);

    const dot = container.querySelector('[class*="motion-safe:animate-pulse"]');
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain('motion-safe:animate-pulse');
    expect(dot?.className).not.toMatch(/(?<!:)animate-pulse/);
    // Permanent indicator that survives reduced-motion suppression.
    expect(dot?.className).toContain('ring-2');
    expect(dot?.className).toContain('ring-brand-primary/40');
  });

  it('does not animate non-running states', () => {
    const { container } = render(<RunStateBadge run={makeRun({ state: 'ok' })} />);
    expect(container.querySelector('[class*="animate-pulse"]')).toBeNull();
  });
});
