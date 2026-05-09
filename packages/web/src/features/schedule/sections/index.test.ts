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
} as unknown as Task;

const milestoneTask = {
  id: 't2',
  isMilestone: true,
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
