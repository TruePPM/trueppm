/**
 * Tests for OSS drawer section registrations (ADR-0058).
 *
 * Verifies that EstimatesSection is hidden for milestone tasks via its
 * canRender predicate, while other sections remain visible.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Task } from '@/types';

// Import registration side-effect. Re-importing after reset is not
// straightforward with vitest module isolation, so we test the predicate
// logic directly by reading the registered canRender function.
import { registry } from '@/lib/widget-registry';
import { registerOssDrawerSections } from '.';

// Ensure sections are registered before assertions.
beforeEach(() => {
  registerOssDrawerSections();
});

const regularTask = {
  id: 't1',
  isMilestone: false,
  isSummary: false,
} as unknown as Task;

const milestoneTask = {
  id: 't2',
  isMilestone: true,
  isSummary: false,
} as unknown as Task;

const summaryTask = {
  id: 't3',
  isMilestone: false,
  isSummary: true,
} as unknown as Task;

describe('registerOssDrawerSections — Estimates canRender', () => {
  it('Estimates section renders for regular tasks', () => {
    const sections = registry.get('task_detail.section');
    const estimates = sections.find((s) => s.id === 'estimates');
    expect(estimates).toBeDefined();
    const ctx = { user: null, task: regularTask };
    expect(estimates!.canRender!(ctx)).toBe(true);
  });

  it('Estimates section is hidden for milestone tasks', () => {
    const sections = registry.get('task_detail.section');
    const estimates = sections.find((s) => s.id === 'estimates');
    expect(estimates).toBeDefined();
    const ctx = { user: null, task: milestoneTask };
    expect(estimates!.canRender!(ctx)).toBe(false);
  });

  it('Overview section has no canRender gate (visible for all tasks)', () => {
    const sections = registry.get('task_detail.section');
    const overview = sections.find((s) => s.id === 'overview');
    expect(overview).toBeDefined();
    expect(overview!.canRender).toBeUndefined();
  });
});

describe('registerOssDrawerSections — Activity section', () => {
  it('Activity section is registered at priority 600', () => {
    const sections = registry.get('task_detail.section');
    const activity = sections.find((s) => s.id === 'activity');
    expect(activity).toBeDefined();
    expect(activity!.priority).toBe(600);
  });

  it('Activity section has no canRender gate (visible for all task types)', () => {
    const sections = registry.get('task_detail.section');
    const activity = sections.find((s) => s.id === 'activity');
    expect(activity!.canRender).toBeUndefined();
  });

  it('Activity section renders before Estimates (600 < 800)', () => {
    const sections = registry.get('task_detail.section');
    const activity = sections.find((s) => s.id === 'activity');
    const estimates = sections.find((s) => s.id === 'estimates');
    expect(activity!.priority).toBeLessThan(estimates!.priority);
  });
});

describe('registerOssDrawerSections — Attachments & Comments (ADR-0075, #310 #311)', () => {
  it('Attachments section registers at priority 400', () => {
    const sections = registry.get('task_detail.section');
    const attachments = sections.find((s) => s.id === 'attachments');
    expect(attachments).toBeDefined();
    expect(attachments!.priority).toBe(400);
    expect(attachments!.title).toBe('Attachments');
  });

  it('Comments section registers at priority 500', () => {
    const sections = registry.get('task_detail.section');
    const comments = sections.find((s) => s.id === 'comments');
    expect(comments).toBeDefined();
    expect(comments!.priority).toBe(500);
    expect(comments!.title).toBe('Comments');
  });

  it('Attachments and Comments have no canRender gate (visible for every task type)', () => {
    const sections = registry.get('task_detail.section');
    expect(sections.find((s) => s.id === 'attachments')!.canRender).toBeUndefined();
    expect(sections.find((s) => s.id === 'comments')!.canRender).toBeUndefined();
  });

  it('Attachments precedes Comments precedes Activity (400 < 500 < 600)', () => {
    const sections = registry.get('task_detail.section');
    const attachments = sections.find((s) => s.id === 'attachments');
    const comments = sections.find((s) => s.id === 'comments');
    const activity = sections.find((s) => s.id === 'activity');
    expect(attachments!.priority).toBeLessThan(comments!.priority);
    expect(comments!.priority).toBeLessThan(activity!.priority);
  });
});

describe('registerOssDrawerSections — Related links (#2068)', () => {
  it('registers at priority 225 in the details tab, just after Dependencies', () => {
    const sections = registry.get('task_detail.section');
    const related = sections.find((s) => s.id === 'related-links');
    const dependencies = sections.find((s) => s.id === 'dependencies');
    expect(related).toBeDefined();
    expect(related!.priority).toBe(225);
    expect(related!.tab).toBe('details');
    expect(related!.priority).toBeGreaterThan(dependencies!.priority);
  });

  it('has no canRender gate (visible for every task type)', () => {
    const sections = registry.get('task_detail.section');
    expect(sections.find((s) => s.id === 'related-links')!.canRender).toBeUndefined();
  });
});

describe('registerOssDrawerSections — Sprint canRender', () => {
  it('Sprint section renders for regular leaf tasks', () => {
    const sections = registry.get('task_detail.section');
    const sprint = sections.find((s) => s.id === 'sprint');
    expect(sprint).toBeDefined();
    expect(sprint!.canRender!({ task: regularTask })).toBe(true);
  });

  it('Sprint section is hidden for milestone tasks', () => {
    const sections = registry.get('task_detail.section');
    const sprint = sections.find((s) => s.id === 'sprint');
    expect(sprint!.canRender!({ task: milestoneTask })).toBe(false);
  });

  it('Sprint section is hidden for summary tasks', () => {
    const sections = registry.get('task_detail.section');
    const sprint = sections.find((s) => s.id === 'sprint');
    expect(sprint!.canRender!({ task: summaryTask })).toBe(false);
  });

  it('Sprint section is registered at priority 150 (between Overview and Dependencies)', () => {
    const sections = registry.get('task_detail.section');
    const sprint = sections.find((s) => s.id === 'sprint');
    const overview = sections.find((s) => s.id === 'overview');
    const dependencies = sections.find((s) => s.id === 'dependencies');
    expect(sprint!.priority).toBeGreaterThan(overview!.priority);
    expect(sprint!.priority).toBeLessThan(dependencies!.priority);
  });
});

describe('registerOssDrawerSections — isPopulated (progressive disclosure, ADR-0605)', () => {
  const find = (id: string) => registry.get('task_detail.section').find((s) => s.id === id)!;

  it('sprint is populated only when the task is assigned to a sprint', () => {
    const sprint = find('sprint');
    expect(sprint.isPopulated!({ task: { ...regularTask, sprintId: 's1' } })).toBe(true);
    expect(sprint.isPopulated!({ task: { ...regularTask, sprintId: null } })).toBe(false);
    expect(sprint.isPopulated!({ task: { ...regularTask } })).toBe(false);
  });

  it('blocker is populated from blockedAgeSeconds, not the privacy-gated reason', () => {
    const blocker = find('blocker');
    expect(blocker.isPopulated!({ task: { ...regularTask, blockedAgeSeconds: 120 } })).toBe(true);
    // A flagged task whose reason is privacy-gated to undefined still counts.
    expect(
      blocker.isPopulated!({ task: { ...regularTask, blockedAgeSeconds: 5, blockedReason: undefined } }),
    ).toBe(true);
    expect(blocker.isPopulated!({ task: { ...regularTask, blockedAgeSeconds: null } })).toBe(false);
  });

  it('dependencies is populated when any link edge touches the task (either direction)', () => {
    const dependencies = find('dependencies');
    const links = [
      { id: 'l1', sourceId: 't9', targetId: 't1', type: 'FS' },
      { id: 'l2', sourceId: 't2', targetId: 't3', type: 'FS' },
    ];
    // Incoming edge (t1 is a target).
    expect(dependencies.isPopulated!({ task: regularTask, links })).toBe(true);
    // Outgoing-only edge (t1 is a source) — the case predecessorCount misses.
    expect(
      dependencies.isPopulated!({
        task: regularTask,
        links: [{ id: 'l3', sourceId: 't1', targetId: 't4', type: 'FS' }],
      }),
    ).toBe(true);
    // No edge touches t1.
    expect(dependencies.isPopulated!({ task: regularTask, links: [links[1]] })).toBe(false);
    // Falls back to predecessorCount when the links cache is not threaded.
    expect(dependencies.isPopulated!({ task: { ...regularTask, predecessorCount: 2 } })).toBe(true);
    expect(dependencies.isPopulated!({ task: { ...regularTask, predecessorCount: 0 } })).toBe(false);
  });

  it('estimates is populated from a leaf PERT triple, or any descendant PERT on a summary', () => {
    const estimates = find('estimates');
    // Leaf with any PERT field set.
    expect(estimates.isPopulated!({ task: { ...regularTask, optimisticDuration: 3 } })).toBe(true);
    expect(estimates.isPopulated!({ task: regularTask })).toBe(false);
    // Summary: populated iff a descendant carries PERT (walked via parentId).
    const tasks = [
      summaryTask, // t3
      { ...regularTask, id: 'child', parentId: 't3', mostLikelyDuration: 5 } as unknown as Task,
    ];
    expect(estimates.isPopulated!({ task: summaryTask, tasks })).toBe(true);
    expect(estimates.isPopulated!({ task: summaryTask, tasks: [summaryTask] })).toBe(false);
  });

  it('related-links and recurring have NO isPopulated predicate (stay always-shown)', () => {
    // No task-level signal exists for these, so they must not collapse — they
    // omit the predicate and render as always-shown headers until a server
    // annotation lands (ADR-0605 follow-up).
    expect(find('related-links').isPopulated).toBeUndefined();
    expect(find('recurring').isPopulated).toBeUndefined();
  });
});
