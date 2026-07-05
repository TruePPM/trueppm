/**
 * Tests for the sync-conflict helper (ADR-0217, #322): narrowing a 409 to a
 * structured SyncConflict and surfacing the Reload toast.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { asSyncConflict, isSyncConflict, handleSyncConflict } from './conflict';

const actionMock = vi.fn();
vi.mock('@/components/Toast', () => ({
  toast: {
    action: (...args: unknown[]) => actionMock(...args),
  },
}));

function makeConflictError(overrides: Record<string, unknown> = {}): AxiosError {
  const err = new AxiosError('Conflict');
  err.response = {
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: {
      code: 'sync_conflict',
      detail: 'Someone else changed this. Reload to see their changes.',
      conflict_fields: ['name'],
      server_value: { name: 'Their name' },
      client_value: { name: 'My name' },
      server_version: 7,
      ...overrides,
    },
  };
  return err;
}

describe('asSyncConflict', () => {
  it('narrows a structured 409 to a SyncConflict', () => {
    const conflict = asSyncConflict(makeConflictError());
    expect(conflict).not.toBeNull();
    expect(conflict?.conflict_fields).toEqual(['name']);
    expect(conflict?.server_version).toBe(7);
  });

  it('returns null for a 409 without the sync_conflict code', () => {
    expect(asSyncConflict(makeConflictError({ code: 'other' }))).toBeNull();
  });

  it('returns null for a non-409 error', () => {
    const err = new AxiosError('Server error');
    err.response = {
      status: 500,
      statusText: 'err',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: {},
    };
    expect(asSyncConflict(err)).toBeNull();
  });

  it('returns null for a plain Error', () => {
    expect(asSyncConflict(new Error('boom'))).toBeNull();
  });
});

describe('isSyncConflict', () => {
  it('is true for a conflict and false otherwise', () => {
    expect(isSyncConflict(makeConflictError())).toBe(true);
    expect(isSyncConflict(new Error('x'))).toBe(false);
  });
});

describe('handleSyncConflict', () => {
  beforeEach(() => {
    actionMock.mockClear();
  });

  it('shows the Reload toast and returns true on a conflict', () => {
    const onReload = vi.fn();
    const handled = handleSyncConflict(makeConflictError(), onReload);
    expect(handled).toBe(true);
    expect(actionMock).toHaveBeenCalledTimes(1);
    const [message, action] = actionMock.mock.calls[0];
    expect(message).toContain('Someone else changed this');
    expect(action.label).toBe('Reload');
    // Invoking the action triggers the caller's refetch.
    action.onClick();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('does nothing and returns false on a non-conflict error', () => {
    const onReload = vi.fn();
    expect(handleSyncConflict(new Error('boom'), onReload)).toBe(false);
    expect(actionMock).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
  });
});
