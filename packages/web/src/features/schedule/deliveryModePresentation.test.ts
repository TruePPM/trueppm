import { describe, it, expect } from 'vitest';
import type { DeliveryMode, Task } from '@/types';
import {
  computeRowModes,
  gutterBackground,
  isModeVisible,
  modePresentation,
} from './deliveryModePresentation';

function task(
  id: string,
  parentId: string | null,
  deliveryMode?: DeliveryMode,
  isMilestone = false,
): Task {
  return {
    id,
    wbs: id,
    name: id,
    parentId,
    isSummary: false,
    isMilestone,
    deliveryMode,
    duration: 1,
    progress: 0,
    assignees: [],
    status: 'NOT_STARTED',
  } as unknown as Task;
}

describe('computeRowModes', () => {
  it('resolves a leaf from its own delivery mode', () => {
    const modes = computeRowModes([task('a', null, 'scrum')]);
    expect(modes.get('a')).toEqual({ kind: 'scrum', parts: ['scrum'] });
  });

  it('treats waterfall and an absent mode identically as the gated baseline', () => {
    const modes = computeRowModes([task('a', null, 'waterfall'), task('b', null)]);
    expect(modes.get('a')?.kind).toBe('gated');
    expect(modes.get('b')?.kind).toBe('gated');
  });

  it('rolls a uniform subtree up to the single mode its children share', () => {
    const modes = computeRowModes([
      task('p', null, 'waterfall'),
      task('c1', 'p', 'scrum'),
      task('c2', 'p', 'scrum'),
    ]);
    // The parent's OWN field says waterfall; the chip describes the subtree.
    expect(modes.get('p')).toEqual({ kind: 'scrum', parts: ['scrum'] });
  });

  it('reads MIXED when descendants disagree, listing the modes actually present', () => {
    const modes = computeRowModes([
      task('p', null, 'waterfall'),
      task('c1', 'p', 'waterfall'),
      task('c2', 'p', 'scrum'),
    ]);
    expect(modes.get('p')).toEqual({ kind: 'mixed', parts: ['gated', 'scrum'] });
  });

  it('distinguishes a scrum+kanban mix from a gated+scrum one', () => {
    const modes = computeRowModes([
      task('p', null),
      task('c1', 'p', 'scrum'),
      task('c2', 'p', 'kanban'),
    ]);
    expect(modes.get('p')).toEqual({ kind: 'mixed', parts: ['scrum', 'kanban'] });
  });

  it('does not let a milestone inside a uniform phase make it MIXED', () => {
    // The invariant that makes the signal usable: `is_milestone` is a gate, not
    // a delivery mode, so it contributes nothing to its ancestors' rollup.
    const modes = computeRowModes([
      task('p', null),
      task('c1', 'p', 'scrum'),
      task('gate', 'p', 'milestone', true),
    ]);
    expect(modes.get('p')).toEqual({ kind: 'scrum', parts: ['scrum'] });
  });

  it('falls back to a phase’s own mode when every descendant is a gate', () => {
    const modes = computeRowModes([
      task('p', null, 'kanban'),
      task('g1', 'p', 'milestone', true),
      task('g2', 'p', 'milestone', true),
    ]);
    expect(modes.get('p')).toEqual({ kind: 'kanban', parts: ['kanban'] });
  });

  it('rolls a mix up through more than one level', () => {
    const modes = computeRowModes([
      task('root', null),
      task('p1', 'root'),
      task('p2', 'root'),
      task('a', 'p1', 'scrum'),
      task('b', 'p2', 'waterfall'),
    ]);
    expect(modes.get('p1')?.kind).toBe('scrum');
    expect(modes.get('p2')?.kind).toBe('gated');
    expect(modes.get('root')).toEqual({ kind: 'mixed', parts: ['gated', 'scrum'] });
  });

  it('resolves a task whose parent is outside the loaded list', () => {
    // A filtered or paginated list can hand us an orphan; it must still get a
    // mode rather than dropping out of the map entirely.
    const modes = computeRowModes([task('orphan', 'not-loaded', 'kanban')]);
    expect(modes.get('orphan')?.kind).toBe('kanban');
  });

  it('walks a deep chain without recursing', () => {
    const rows: Task[] = [task('n0', null, 'scrum')];
    for (let i = 1; i < 5000; i++) rows.push(task(`n${i}`, `n${i - 1}`, 'scrum'));
    expect(computeRowModes(rows).get('n0')?.kind).toBe('scrum');
  });
});

describe('isModeVisible', () => {
  it('draws nothing for the gated baseline, matching the canvas convention', () => {
    expect(isModeVisible({ kind: 'gated', parts: ['gated'] })).toBe(false);
    expect(isModeVisible(undefined)).toBe(false);
  });

  it('draws for every non-baseline mode', () => {
    expect(isModeVisible({ kind: 'scrum', parts: ['scrum'] })).toBe(true);
    expect(isModeVisible({ kind: 'kanban', parts: ['kanban'] })).toBe(true);
    expect(isModeVisible({ kind: 'mixed', parts: ['gated', 'scrum'] })).toBe(true);
  });
});

describe('modePresentation', () => {
  it('labels a single mode with its own token', () => {
    expect(modePresentation({ kind: 'scrum', parts: ['scrum'] }).label).toBe('SCRUM');
  });

  it('names both halves of a mixed subtree in the description', () => {
    const p = modePresentation({ kind: 'mixed', parts: ['gated', 'scrum'] });
    expect(p.label).toBe('MIXED');
    expect(p.description).toContain('gated');
    expect(p.description).toContain('scrum');
    expect(p.colors).toHaveLength(2);
  });

  it('describes what a mode governs rather than repeating the token', () => {
    // The chip's accessible name is this sentence: "SCRUM" alone tells a screen
    // reader user which word is on screen and nothing about what it does.
    expect(modePresentation({ kind: 'kanban', parts: ['kanban'] }).description).toContain(
      'throughput',
    );
  });
});

describe('gutterBackground', () => {
  it('uses a flat color for a single mode', () => {
    expect(gutterBackground(['var(--agile)'])).toBe('var(--agile)');
  });

  it('splits evenly across the modes present', () => {
    expect(gutterBackground(['a', 'b'])).toBe('linear-gradient(180deg, a 0% 50%, b 50% 100%)');
  });
});
