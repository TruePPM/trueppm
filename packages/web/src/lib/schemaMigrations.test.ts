import { describe, it, expect } from 'vitest';
import {
  SURFACE_BOARD_SAVED_VIEW,
  currentVersion,
  storedVersion,
  migratePayload,
  registerSurface,
  registerMigration,
} from './schemaMigrations';

describe('schemaMigrations registry', () => {
  it('reports the current version for a registered surface', () => {
    expect(currentVersion(SURFACE_BOARD_SAVED_VIEW)).toBe(2);
  });

  it('defaults an unregistered surface to version 1', () => {
    expect(currentVersion('does_not_exist')).toBe(1);
  });

  it('treats a payload with no schema_version as version 0', () => {
    expect(storedVersion({ sort: 'priority' })).toBe(0);
    expect(storedVersion(null)).toBe(0);
    expect(storedVersion({ schema_version: 2 })).toBe(2);
  });

  describe('board_saved_view surface', () => {
    it('backfills the six canonical keys plus empty filter facets on a stale (v0) payload', () => {
      const { payload, version } = migratePayload(SURFACE_BOARD_SAVED_VIEW, {
        sort: 'start_date',
      });
      expect(version).toBe(2);
      expect(payload).toEqual({
        schema_version: 2,
        sort: 'start_date', // existing value preserved
        show_wip: true,
        show_col_tints: true,
        evm_mode: 'off',
        show_cost: false,
        risk_linked_only: false,
        filter_assignees: [],
        filter_priority: [],
        filter_due: [],
      });
    });

    it('backfills empty filter facets on a v1 payload (pre-#1918)', () => {
      const v1 = {
        schema_version: 1,
        sort: 'priority',
        show_wip: false,
        show_col_tints: false,
        evm_mode: 'both',
        show_cost: true,
        risk_linked_only: true,
      };
      const { payload, version } = migratePayload(SURFACE_BOARD_SAVED_VIEW, v1);
      expect(version).toBe(2);
      expect(payload).toEqual({
        ...v1,
        schema_version: 2,
        filter_assignees: [],
        filter_priority: [],
        filter_due: [],
      });
    });

    it('leaves an already-current (v2) payload untouched except stamping the version', () => {
      const current = {
        schema_version: 2,
        sort: 'priority',
        show_wip: false,
        show_col_tints: false,
        evm_mode: 'both',
        show_cost: true,
        risk_linked_only: true,
        filter_assignees: ['res-1'],
        filter_priority: ['high'],
        filter_due: ['overdue'],
      };
      const { payload, version } = migratePayload(SURFACE_BOARD_SAVED_VIEW, current);
      expect(version).toBe(2);
      expect(payload).toEqual(current);
    });
  });

  describe('generic chaining (throwaway surface)', () => {
    const SURFACE = 'test_surface_chain';
    registerSurface(SURFACE, 3);
    registerMigration(SURFACE, 0, (p) => ({ ...p, a: 1 }));
    registerMigration(SURFACE, 1, (p) => ({ ...p, b: 2 }));
    registerMigration(SURFACE, 2, (p) => ({ ...p, c: 3 }));

    it('applies v0 -> v1 -> v2 -> v3 in order', () => {
      const { payload, version } = migratePayload(SURFACE, {});
      expect(version).toBe(3);
      expect(payload).toEqual({ schema_version: 3, a: 1, b: 2, c: 3 });
    });

    it('starts from an explicit fromVersion, skipping earlier steps', () => {
      const { payload } = migratePayload(SURFACE, { b: 2 }, 1);
      expect(payload).toEqual({ schema_version: 3, b: 2, c: 3 });
    });

    it('throws on a payload newer than the code supports', () => {
      expect(() => migratePayload(SURFACE, { schema_version: 4 })).toThrow(/only supports up to 3/);
    });

    it('throws when a step is missing from the chain', () => {
      const GAP = 'test_surface_gap';
      registerSurface(GAP, 2);
      registerMigration(GAP, 0, (p) => ({ ...p, x: 1 }));
      // No 1 -> 2 registered.
      expect(() => migratePayload(GAP, {})).toThrow(/No migration registered/);
    });
  });
});
