import { describe, it, expect } from 'vitest';
import { formatDueLabel } from './dueLabel';

describe('formatDueLabel', () => {
  it('renders the actual-finish source as a Done label', () => {
    const out = formatDueLabel('2026-05-30', 'actual');
    expect(out.text).toBe('Done May 30');
    expect(out.sr).toContain('Completed on');
  });

  it('renders the planned source with the planned suffix', () => {
    const out = formatDueLabel('2026-05-30', 'planned');
    expect(out.text).toBe('Due May 30 (planned)');
    expect(out.sr).toContain('planned commitment');
  });

  it('renders the estimated source with the estimated suffix', () => {
    const out = formatDueLabel('2026-10-14', 'estimated');
    expect(out.text).toBe('Due Oct 14 (estimated)');
    expect(out.sr).toContain('estimated from schedule');
  });

  it('renders the sprint fallback as Ends with sprint, not a date', () => {
    const out = formatDueLabel('2026-06-14', 'sprint');
    expect(out.text).toBe('Ends with sprint');
    expect(out.sr).toContain('Ends with the current sprint');
  });

  it('renders null/null as No due date', () => {
    const out = formatDueLabel(null, null);
    expect(out.text).toBe('No due date');
    expect(out.sr).toBe('No due date set');
  });

  it('passes a malformed iso through cleanly', () => {
    const out = formatDueLabel('not-a-date', 'planned');
    expect(out.text).toContain('Due');
    expect(out.text).toContain('not-a-date');
  });
});
