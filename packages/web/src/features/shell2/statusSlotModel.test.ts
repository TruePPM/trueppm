import { describe, expect, it } from 'vitest';
import { resolveStatusSlot, type StatusSlotInput } from './statusSlotModel';

const base: StatusSlotInput = {
  online: true,
  sessionExpired: false,
  sessionReadOnly: false,
  demoReadOnly: false,
  rateLimitDisabled: false,
  sync: { kind: 'synced', lastSyncAt: null },
};

describe('resolveStatusSlot', () => {
  it('is a quiet "Synced" when nothing is wrong', () => {
    expect(resolveStatusSlot(base)).toEqual({
      kind: 'synced',
      label: 'Synced',
      tone: 'quiet',
      more: 0,
      folded: [],
    });
  });

  it('offline wins over everything and carries the pending count', () => {
    const m = resolveStatusSlot({
      ...base,
      online: false,
      sessionExpired: true,
      demoReadOnly: true,
      rateLimitDisabled: true,
      sync: { kind: 'offline', pending: 3, lastSyncAt: null },
    });
    expect(m.kind).toBe('offline');
    expect(m.label).toBe('Offline · 3 changes pending');
    expect(m.tone).toBe('warn');
    expect(m.more).toBe(3);
    expect(m.folded).toEqual(['Session expired', 'Demo · read-only', 'Rate limiting off']);
  });

  it('singularises one pending change', () => {
    expect(
      resolveStatusSlot({
        ...base,
        online: false,
        sync: { kind: 'offline', pending: 1, lastSyncAt: null },
      }).label,
    ).toBe('Offline · 1 change pending');
  });

  it('session outranks demo, and the read-only escape is named', () => {
    const m = resolveStatusSlot({
      ...base,
      sessionExpired: true,
      sessionReadOnly: true,
      demoReadOnly: true,
    });
    expect(m.kind).toBe('session');
    expect(m.label).toBe('Session expired · read-only');
    expect(m.more).toBe(1);
  });

  it('demo outranks rate-limit', () => {
    const m = resolveStatusSlot({ ...base, demoReadOnly: true, rateLimitDisabled: true });
    expect(m.kind).toBe('demo');
    expect(m.more).toBe(1);
  });

  it('a failed write surfaces when nothing above it is active, and folds under demo', () => {
    const sync = { kind: 'error', errorCount: 2, lastError: 'boom', lastSyncAt: null } as const;
    expect(resolveStatusSlot({ ...base, sync })).toMatchObject({
      kind: 'sync-error',
      label: '2 writes failed',
      more: 0,
    });
    expect(resolveStatusSlot({ ...base, demoReadOnly: true, sync })).toMatchObject({
      kind: 'demo',
      more: 1,
    });
  });

  it('stale live updates and syncing are reported, syncing quietly', () => {
    expect(resolveStatusSlot({ ...base, sync: { kind: 'stale', lastSyncAt: null } })).toMatchObject(
      {
        kind: 'sync-stale',
        tone: 'warn',
      },
    );
    expect(
      resolveStatusSlot({ ...base, sync: { kind: 'syncing', count: 4, lastSyncAt: null } }),
    ).toMatchObject({
      kind: 'syncing',
      label: 'Syncing 4…',
      tone: 'quiet',
    });
  });

  it('never double-counts offline through the sync machine', () => {
    // The sync status says offline too; that must not appear a second time in `more`.
    const m = resolveStatusSlot({
      ...base,
      online: false,
      sync: { kind: 'offline', pending: 0, lastSyncAt: null },
    });
    expect(m).toMatchObject({ kind: 'offline', label: 'Offline', more: 0 });
  });
});
