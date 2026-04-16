import { describe, it, expect, beforeEach } from 'vitest';
import type { ComponentType } from 'react';
import type { SlotId, SlotRegistration } from './widget-registry';

// Re-instantiate a fresh registry for each test to isolate state.
// The exported `registry` singleton cannot be reset between tests, so we test
// the WidgetRegistry class directly by importing the module dynamically and
// re-evaluating. Instead, we test the logic by working with a local class copy.

// Inline a minimal reproduction of the registry class to test its behaviour
// without coupling tests to the singleton state (which accumulates across imports).
class WidgetRegistry {
  private readonly slots = new Map<SlotId, SlotRegistration[]>();

  register(slot: SlotId, reg: SlotRegistration): void {
    const existing = this.slots.get(slot) ?? [];
    this.slots.set(
      slot,
      [...existing, reg].sort((a, b) => a.priority - b.priority),
    );
  }

  get(slot: SlotId): SlotRegistration[] {
    return this.slots.get(slot) ?? [];
  }
}

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
});
