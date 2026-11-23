import { afterEach, describe, expect, it } from 'vitest';
import type { StatusUpdate } from '@/api/types';
import { SNAPSHOT } from './statusUpdateFixtures';
import {
  NARRATIVE_MAX,
  clearDraft,
  currentComputedHealth,
  draftKey,
  firstLine,
  loadDraft,
  milestoneNow,
  saveDraft,
  snapshotRows,
} from './statusUpdateModel';

afterEach(() => window.localStorage.clear());

describe('draft model', () => {
  it('keys one draft per project per author', () => {
    expect(draftKey('p1', 'u1')).not.toBe(draftKey('p1', 'u2'));
    expect(draftKey('p1', 'u1')).not.toBe(draftKey('p2', 'u1'));
  });

  it('round-trips and survives a reload (storage, not memory)', () => {
    expect(
      saveDraft(
        'p1',
        'u1',
        { rag: 'amber', narrative: 'Vendor late' },
        new Date('2026-11-20T10:00:00Z'),
      ),
    ).toBe(true);
    expect(loadDraft('p1', 'u1')).toEqual({
      rag: 'amber',
      narrative: 'Vendor late',
      savedAt: '2026-11-20T10:00:00.000Z',
    });
    expect(loadDraft('p1', 'u2')).toBeNull();
  });

  it('an empty draft clears the key; clearDraft removes it', () => {
    saveDraft('p1', 'u1', { rag: 'red', narrative: '' });
    saveDraft('p1', 'u1', { rag: null, narrative: '' });
    expect(window.localStorage.getItem(draftKey('p1', 'u1'))).toBeNull();
    saveDraft('p1', 'u1', { rag: 'red', narrative: 'x' });
    clearDraft('p1', 'u1');
    expect(loadDraft('p1', 'u1')).toBeNull();
  });

  it('reads a malformed or oversized value safely', () => {
    window.localStorage.setItem(draftKey('p1', 'u1'), '{not json');
    expect(loadDraft('p1', 'u1')).toBeNull();
    window.localStorage.setItem(
      draftKey('p1', 'u1'),
      JSON.stringify({ rag: 'purple', narrative: 'a'.repeat(900) }),
    );
    const d = loadDraft('p1', 'u1');
    expect(d?.rag).toBeNull();
    expect(d?.narrative).toHaveLength(NARRATIVE_MAX);
  });

  it('first line is what history shows', () => {
    expect(firstLine('  Vendor slipped  \nmore')).toBe('Vendor slipped');
    expect(firstLine('')).toBe('');
  });
});

describe('diff tags', () => {
  it('adds a now tag only where the API live diff says the figure moved', () => {
    const rows = snapshotRows(SNAPSHOT, { 'forecast.p80': { value: '2026-12-14', as_of: null } });
    const p80 = rows.find((r) => r.id === 'forecast.p80')!;
    const p50 = rows.find((r) => r.id === 'forecast.p50')!;
    expect(p80.value).toMatch(/Dec 7, 2026|7 Dec 2026/);
    expect(p80.now).toMatch(/Dec 14, 2026|14 Dec 2026/);
    expect(p50.now).toBeUndefined();
    expect(rows.find((r) => r.id === 'forecast.baseline_finish_variance_days')!.value).toBe('-3d');
  });

  it('a moved figure that is now null reads not computable; a null frozen figure says why', () => {
    const rows = snapshotRows(SNAPSHOT, { 'forecast.p80': { value: null } });
    expect(rows.find((r) => r.id === 'forecast.p80')!.now).toBe('not computable');
    const completed = rows.find((r) => r.id === 'counts.completed_since_previous')!;
    expect(completed.value).toBeNull();
    expect(completed.notComputable).toBe('this is the first update');
  });

  it('names a removed or moved milestone from the diff', () => {
    expect(milestoneNow({ 'milestones.m1': { value: null, reason: 'removed' } }, 'm1')).toBe(
      'removed from the plan',
    );
    expect(milestoneNow({ 'milestones.m1.variance_days': { value: 4 } }, 'm1')).toBe('+4d');
    expect(milestoneNow({}, 'm1')).toBeUndefined();
  });

  it('the computed band now is the diff value when moved, else the frozen one', () => {
    const u = { computed_health: 'on_track', live_diff: {} } as unknown as StatusUpdate;
    expect(currentComputedHealth(u)).toBe('on_track');
    expect(
      currentComputedHealth({ ...u, live_diff: { computed_health: { value: 'critical' } } }),
    ).toBe('critical');
    expect(currentComputedHealth(undefined)).toBeNull();
  });
});
