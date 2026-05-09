import { describe, it, expect, beforeEach } from 'vitest';
import type { ComponentType } from 'react';
import { WidgetRegistry } from './widget-registry';

// Tests instantiate a fresh WidgetRegistry per test to isolate state from the
// exported `registry` singleton (which accumulates across imports). This used
// to be a local copy of the class definition — drift between the copy and the
// real implementation is exactly how the duplicate-section bug shipped.

const stubComponent: ComponentType = () => null;

describe('WidgetRegistry', () => {
  let registry: WidgetRegistry;

  beforeEach(() => {
    registry = new WidgetRegistry();
  });

  it('returns empty array for unregistered slot', () => {
    expect(registry.get('project_overview.kpi_row')).toEqual([]);
  });

  it('registers a component and retrieves it', () => {
    registry.register('project_overview.kpi_row', {
      id: 'enterprise.kpi',
      component: stubComponent,
      priority: 10,
    });

    const result = registry.get('project_overview.kpi_row');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('enterprise.kpi');
  });

  it('sorts registrations by priority ascending', () => {
    registry.register('project_overview.kpi_row', {
      id: 'low-priority',
      component: stubComponent,
      priority: 20,
    });
    registry.register('project_overview.kpi_row', {
      id: 'high-priority',
      component: stubComponent,
      priority: 5,
    });
    registry.register('project_overview.kpi_row', {
      id: 'mid-priority',
      component: stubComponent,
      priority: 10,
    });

    const ids = registry.get('project_overview.kpi_row').map((r) => r.id);
    expect(ids).toEqual(['high-priority', 'mid-priority', 'low-priority']);
  });

  it('slots are independent — registering in one does not affect another', () => {
    registry.register('project_overview.kpi_row', {
      id: 'kpi-widget',
      component: stubComponent,
      priority: 10,
    });

    expect(registry.get('nav.portfolio_section')).toHaveLength(0);
    expect(registry.get('routes')).toHaveLength(0);
  });

  it('supports multiple registrations in the same slot', () => {
    registry.register('project_overview.below_hero', {
      id: 'widget-a',
      component: stubComponent,
      priority: 1,
    });
    registry.register('project_overview.below_hero', {
      id: 'widget-b',
      component: stubComponent,
      priority: 2,
    });

    expect(registry.get('project_overview.below_hero')).toHaveLength(2);
  });

  // --- task_detail.section slot (ADR-0050) -----------------------------------

  it('preserves optional title and canRender on drawer-section registrations', () => {
    const canRender = (ctx: unknown) => ctx !== null;
    registry.register('task_detail.section', {
      id: 'overview',
      title: 'Overview',
      component: stubComponent,
      priority: 100,
      canRender,
    });

    const result = registry.get('task_detail.section');
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('Overview');
    expect(result[0]?.canRender).toBe(canRender);
  });

  it('orders drawer sections by priority — OSS multiples of 100 + Enterprise in between', () => {
    // OSS sections register at 100, 200, 300...
    registry.register('task_detail.section', {
      id: 'overview',
      title: 'Overview',
      component: stubComponent,
      priority: 100,
    });
    registry.register('task_detail.section', {
      id: 'dependencies',
      title: 'Dependencies',
      component: stubComponent,
      priority: 200,
    });
    registry.register('task_detail.section', {
      id: 'subtasks',
      title: 'Subtasks',
      component: stubComponent,
      priority: 300,
    });
    // Enterprise registers Custom Fields at 250 (between Dependencies and Subtasks)
    registry.register('task_detail.section', {
      id: 'custom-fields',
      title: 'Custom fields',
      component: stubComponent,
      priority: 250,
    });

    const ids = registry
      .get('task_detail.section')
      .map((r) => r.id);
    expect(ids).toEqual(['overview', 'dependencies', 'custom-fields', 'subtasks']);
  });

  // --- idempotency (regression: doubled drawer sections) ---------------------

  it('re-registering the same (slot, id) replaces the prior entry instead of appending', () => {
    // Vite HMR / module re-import / React StrictMode all fire init code twice.
    // Without dedupe every section was rendered twice in the task detail
    // drawer (OVERVIEW × 2, DEPENDENCIES × 2, etc.).
    const componentV1: ComponentType = () => null;
    const componentV2: ComponentType = () => null;

    registry.register('task_detail.section', {
      id: 'overview',
      title: 'Overview',
      component: componentV1,
      priority: 100,
    });
    registry.register('task_detail.section', {
      id: 'overview',
      title: 'Overview (HMR update)',
      component: componentV2,
      priority: 100,
    });

    const result = registry.get('task_detail.section');
    expect(result).toHaveLength(1);
    // Replacement takes the latest definition so HMR picks up edits mid-session.
    expect(result[0]?.title).toBe('Overview (HMR update)');
    expect(result[0]?.component).toBe(componentV2);
  });

  it('dedupe is per (slot, id) — different slots with the same id are independent', () => {
    registry.register('project_overview.kpi_row', {
      id: 'shared-id',
      component: stubComponent,
      priority: 10,
    });
    registry.register('nav.portfolio_section', {
      id: 'shared-id',
      component: stubComponent,
      priority: 10,
    });

    expect(registry.get('project_overview.kpi_row')).toHaveLength(1);
    expect(registry.get('nav.portfolio_section')).toHaveLength(1);
  });

  it('dedupe preserves priority ordering across replacements', () => {
    registry.register('task_detail.section', {
      id: 'a',
      title: 'A',
      component: stubComponent,
      priority: 100,
    });
    registry.register('task_detail.section', {
      id: 'b',
      title: 'B',
      component: stubComponent,
      priority: 200,
    });
    // Replace 'a' with a new priority — final order should be by new priorities.
    registry.register('task_detail.section', {
      id: 'a',
      title: 'A (re-prioritised)',
      component: stubComponent,
      priority: 300,
    });

    const ids = registry.get('task_detail.section').map((r) => r.id);
    expect(ids).toEqual(['b', 'a']);
  });
});
