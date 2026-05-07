import { describe, it, expect } from 'vitest';
import { getPhase } from './getPhase';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'wbs'>): Task {
  return {
    name: overrides.id,
    start: '2026-01-01',
    finish: '2026-01-05',
    duration: 4,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

describe('getPhase', () => {
  it('returns the closest summary ancestor name (not the topmost)', () => {
    // Two summaries on the chain — closest wins.
    const phase = makeTask({ id: 'p', wbs: '1', name: 'Discovery', isSummary: true });
    const sub = makeTask({ id: 's', wbs: '1.1', name: 'Stakeholders', isSummary: true, parentId: 'p' });
    const leaf = makeTask({ id: 'l', wbs: '1.1.1', parentId: 's' });
    const byId = new Map([phase, sub, leaf].map((t) => [t.id, t]));
    expect(getPhase(leaf, byId)).toBe('Stakeholders');
  });

  it("returns the task's own name when the task itself is a summary at root", () => {
    const root = makeTask({ id: 'r', wbs: '1', name: 'Plan', isSummary: true });
    const byId = new Map([[root.id, root]]);
    expect(getPhase(root, byId)).toBe('Plan');
  });

  it('returns "—" for an orphan leaf with no parent', () => {
    const orphan = makeTask({ id: 'o', wbs: '1' });
    const byId = new Map([[orphan.id, orphan]]);
    expect(getPhase(orphan, byId)).toBe('—');
  });

  it('terminates safely when parentId references a missing task', () => {
    const orphan = makeTask({ id: 'o', wbs: '1.1', parentId: 'missing' });
    const byId = new Map([[orphan.id, orphan]]);
    expect(getPhase(orphan, byId)).toBe('—');
  });

  it('walks past non-summary parents until finding a summary ancestor', () => {
    const phase = makeTask({ id: 'p', wbs: '1', name: 'Build', isSummary: true });
    const middle = makeTask({ id: 'm', wbs: '1.1', parentId: 'p' });
    const leaf = makeTask({ id: 'l', wbs: '1.1.1', parentId: 'm' });
    const byId = new Map([phase, middle, leaf].map((t) => [t.id, t]));
    expect(getPhase(leaf, byId)).toBe('Build');
  });
});
