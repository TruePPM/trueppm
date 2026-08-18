import { describe, expect, it, beforeEach } from 'vitest';
import { TRAIL_CAP, useTrailStore } from './trailStore';

describe('trail store', () => {
  beforeEach(() => useTrailStore.getState().clear());

  it('records acts in order', () => {
    const { record } = useTrailStore.getState();
    record('p1', 'first');
    record('p1', 'second');
    expect(useTrailStore.getState().entries.map((e) => e.text)).toEqual(['first', 'second']);
  });

  it('caps at TRAIL_CAP, dropping the oldest', () => {
    const { record } = useTrailStore.getState();
    for (let i = 0; i < TRAIL_CAP + 5; i++) record('p1', `act ${i}`);
    const entries = useTrailStore.getState().entries;
    expect(entries).toHaveLength(TRAIL_CAP);
    expect(entries[0].text).toBe('act 5');
    expect(entries[TRAIL_CAP - 1].text).toBe(`act ${TRAIL_CAP + 4}`);
  });

  it('resets when the project changes — "this session" must not count another plan', () => {
    const { record } = useTrailStore.getState();
    record('p1', 'on project one');
    record('p2', 'on project two');
    expect(useTrailStore.getState().entries.map((e) => e.text)).toEqual(['on project two']);
    expect(useTrailStore.getState().projectId).toBe('p2');
  });

  it('gives each entry a distinct id so the list has stable keys', () => {
    const { record } = useTrailStore.getState();
    record('p1', 'same text');
    record('p1', 'same text');
    const [a, b] = useTrailStore.getState().entries;
    expect(a.id).not.toBe(b.id);
  });
});
