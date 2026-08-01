import { describe, expect, it } from 'vitest';
import {
  defaultDeliveryModeFor,
  defaultGovernanceClassFor,
  deliveryModeGroups,
  governanceClassGroups,
} from './taskClassificationDefaults';

describe('defaultGovernanceClassFor', () => {
  it('WATERFALL defaults to gated', () => {
    expect(defaultGovernanceClassFor('WATERFALL')).toBe('gated');
  });

  it('AGILE defaults to flow', () => {
    expect(defaultGovernanceClassFor('AGILE')).toBe('flow');
  });

  it('HYBRID keeps the flow default (no behavior change)', () => {
    expect(defaultGovernanceClassFor('HYBRID')).toBe('flow');
  });
});

describe('defaultDeliveryModeFor', () => {
  it('WATERFALL defaults to waterfall regardless of board cadence', () => {
    expect(defaultDeliveryModeFor('WATERFALL', 'sprint')).toBe('waterfall');
    expect(defaultDeliveryModeFor('WATERFALL', 'continuous')).toBe('waterfall');
  });

  it('HYBRID keeps the waterfall default regardless of board cadence', () => {
    expect(defaultDeliveryModeFor('HYBRID', 'sprint')).toBe('waterfall');
    expect(defaultDeliveryModeFor('HYBRID', 'continuous')).toBe('waterfall');
  });

  it('AGILE with sprint cadence (or nothing configured yet) defaults to scrum', () => {
    expect(defaultDeliveryModeFor('AGILE', 'sprint')).toBe('scrum');
  });

  it('AGILE with a continuous-flow board defaults to kanban', () => {
    expect(defaultDeliveryModeFor('AGILE', 'continuous')).toBe('kanban');
  });
});

describe('governanceClassGroups', () => {
  it('WATERFALL puts gated first, flow/hybrid de-emphasized', () => {
    expect(governanceClassGroups('WATERFALL')).toEqual({
      primary: ['gated'],
      other: ['flow', 'hybrid'],
    });
  });

  it('AGILE puts flow first, gated/hybrid de-emphasized', () => {
    expect(governanceClassGroups('AGILE')).toEqual({
      primary: ['flow'],
      other: ['gated', 'hybrid'],
    });
  });

  it('HYBRID renders the flat, ungrouped list', () => {
    expect(governanceClassGroups('HYBRID')).toBeNull();
  });
});

describe('deliveryModeGroups', () => {
  it('WATERFALL puts waterfall first; scrum/kanban/milestone de-emphasized', () => {
    expect(deliveryModeGroups('WATERFALL')).toEqual({
      primary: ['waterfall'],
      other: ['scrum', 'kanban', 'milestone'],
    });
  });

  it('AGILE puts both scrum and kanban first (a board-cadence choice, not a mismatch)', () => {
    expect(deliveryModeGroups('AGILE')).toEqual({
      primary: ['scrum', 'kanban'],
      other: ['waterfall', 'milestone'],
    });
  });

  it('HYBRID renders the flat, ungrouped list', () => {
    expect(deliveryModeGroups('HYBRID')).toBeNull();
  });
});
