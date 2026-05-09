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
