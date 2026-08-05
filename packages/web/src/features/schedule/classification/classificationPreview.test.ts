import { describe, it, expect } from 'vitest';
import type { DeliveryMode, GovernanceClass, Task } from '@/types';
import {
  matchingPreset,
  previewClassification,
  resolveSubtree,
  type ClassificationSpec,
} from './classificationPreview';

interface Opts {
  deliveryMode?: DeliveryMode;
  governanceClass?: GovernanceClass;
  parentGovernanceInherited?: boolean;
  isMilestone?: boolean;
}

function task(id: string, parentId: string | null, opts: Opts = {}): Task {
  return {
    id,
    wbs: id,
    name: id,
    parentId,
    isSummary: false,
    isMilestone: opts.isMilestone ?? false,
    deliveryMode: opts.deliveryMode,
    governanceClass: opts.governanceClass,
    parentGovernanceInherited: opts.parentGovernanceInherited,
    duration: 1,
    progress: 0,
    assignees: [],
    status: 'NOT_STARTED',
  } as unknown as Task;
}

function spec(overrides: Partial<ClassificationSpec> = {}): ClassificationSpec {
  return {
    subtreeId: 'p',
    cascade: true,
    governanceClass: null,
    deliveryMode: null,
    preserveGovernanceOverrides: true,
    skipMilestones: true,
    ...overrides,
  };
}

describe('resolveSubtree', () => {
  const tree = [
    task('p', null),
    task('c1', 'p'),
    task('c2', 'p'),
    task('g1', 'c1'),
    task('other', null),
  ];

  it('returns the root alone when not cascading', () => {
    expect(resolveSubtree(tree, 'p', false).map((t) => t.id)).toEqual(['p']);
  });

  it('returns the root and every descendant, and nothing outside the subtree', () => {
    expect(resolveSubtree(tree, 'p', true).map((t) => t.id).sort()).toEqual([
      'c1',
      'c2',
      'g1',
      'p',
    ]);
  });

  it('returns nothing for a root that is not loaded', () => {
    expect(resolveSubtree(tree, 'missing', true)).toEqual([]);
  });
});

describe('previewClassification — the acceptance case from #2735', () => {
  // A subtree with 2 milestones and 1 explicit governance override: all three
  // must survive, reporting 1 override kept and 2 skipped.
  const tree = [
    task('p', null),
    task('c1', 'p', { governanceClass: 'gated', parentGovernanceInherited: false }),
    task('c2', 'p'),
    task('m1', 'p', { isMilestone: true, deliveryMode: 'milestone' }),
    task('m2', 'p', { isMilestone: true, deliveryMode: 'milestone' }),
  ];

  it('keeps the override, skips both milestones, and changes only the rest', () => {
    const result = previewClassification(
      tree,
      spec({ governanceClass: 'flow', deliveryMode: 'scrum' }),
    );
    expect(result.matched).toBe(5);
    expect(result.milestonesSkipped).toBe(2);
    expect(result.governance?.overridesKept).toBe(1);
    // p (root, both axes), c2 (both axes). c1's governance is preserved but its
    // delivery mode is not an override — nothing preserves that axis — so it
    // still changes.
    expect(result.tasksChanged).toBe(3);
  });

  it('overwrites the override when the caller turns preservation off', () => {
    const result = previewClassification(
      tree,
      spec({ governanceClass: 'flow', preserveGovernanceOverrides: false }),
    );
    expect(result.governance?.overridesKept).toBe(0);
    // p (its inherit bit flips to false — the root is the declaration point)
    // and c1 (whose 'gated' override is now overwritten). c2 already carries
    // the model defaults `flow` + inherited, which is exactly what a cascaded
    // descendant should hold, so it is a genuine no-op — no write, no version
    // bump, no history row.
    expect(result.governance?.applied).toBe(2);
    expect(result.governance?.unchanged).toBe(1);
  });
});

describe('previewClassification — axis independence', () => {
  const tree = [task('p', null), task('c', 'p')];

  it('reports null overridesKept on delivery mode, never zero', () => {
    // Zero would assert "there were none" — a claim about the data. Null states
    // the count is not computable on an axis with no inherit bit.
    const result = previewClassification(tree, spec({ deliveryMode: 'kanban' }));
    expect(result.deliveryMode?.overridesKept).toBeNull();
    expect(result.governance).toBeNull();
  });

  it('omits an axis the request did not name', () => {
    const result = previewClassification(tree, spec({ governanceClass: 'hybrid' }));
    expect(result.deliveryMode).toBeNull();
    expect(result.governance).not.toBeNull();
  });
});

describe('previewClassification — milestone invariant', () => {
  it('never writes a delivery mode to a milestone, whatever skip_milestones says', () => {
    const tree = [task('p', null), task('m', 'p', { isMilestone: true })];
    const result = previewClassification(
      tree,
      spec({ deliveryMode: 'scrum', skipMilestones: false }),
    );
    expect(result.milestonesSkipped).toBe(1);
    expect(result.deliveryMode?.applied).toBe(1); // only the root
  });

  it('does write a milestone’s governance when skip_milestones is off', () => {
    // Governance on a gate is invariant-safe — that is what an overlay is.
    const tree = [task('p', null), task('m', 'p', { isMilestone: true })];
    const result = previewClassification(
      tree,
      spec({ governanceClass: 'gated', skipMilestones: false }),
    );
    expect(result.milestonesSkipped).toBe(0);
    expect(result.governance?.applied).toBe(2);
  });
});

describe('previewClassification — the inherit bit', () => {
  it('breaks inheritance on the root and asserts it on descendants', () => {
    // Declaring a subtree's governance IS breaking inheritance from above it,
    // so a root already carrying the requested class still changes when its bit
    // says "inherited".
    const tree = [
      task('p', null, { governanceClass: 'flow', parentGovernanceInherited: true }),
      task('c', 'p', { governanceClass: 'flow', parentGovernanceInherited: true }),
    ];
    const result = previewClassification(tree, spec({ governanceClass: 'flow' }));
    expect(result.governance?.applied).toBe(1); // the root's bit flips to false
    expect(result.governance?.unchanged).toBe(1); // the child already agrees
    expect(result.tasksChanged).toBe(1);
  });

  it('counts a no-op cascade as zero changes', () => {
    const tree = [
      task('p', null, { deliveryMode: 'scrum' }),
      task('c', 'p', { deliveryMode: 'scrum' }),
    ];
    const result = previewClassification(tree, spec({ deliveryMode: 'scrum' }));
    expect(result.tasksChanged).toBe(0);
    expect(result.deliveryMode?.unchanged).toBe(2);
  });
});

describe('previewClassification — legacy payloads', () => {
  it('compares an absent field against the model default, not against undefined', () => {
    // `governance_class` defaults to flow and `delivery_mode` to waterfall
    // server-side, so a row missing both must predict "unchanged" for that pair.
    const tree = [task('p', null)];
    const result = previewClassification(
      tree,
      spec({ cascade: false, deliveryMode: 'waterfall' }),
    );
    expect(result.deliveryMode?.unchanged).toBe(1);
    expect(result.tasksChanged).toBe(0);
  });
});

describe('matchingPreset', () => {
  it('names the preset when both axes match one', () => {
    expect(matchingPreset('flow', 'scrum')).toBe('scrum');
    expect(matchingPreset('gated', 'waterfall')).toBe('gated');
  });

  it('returns null for a blend no preset names', () => {
    expect(matchingPreset('flow', 'waterfall')).toBeNull();
    expect(matchingPreset('hybrid', null)).toBeNull();
  });
});
