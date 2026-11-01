import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLastTask, recordLastTask } from './lastTask';

const TASK = { taskId: 't1', projectId: 'p1', name: 'Wire OAuth', ref: 'T-8' };

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('lastTask', () => {
  it('round-trips a task per user', () => {
    recordLastTask('u1', TASK);
    expect(readLastTask('u1')).toEqual(TASK);
    expect(readLastTask('u2')).toBeNull();
  });

  it('returns null without a user id', () => {
    recordLastTask('u1', TASK);
    expect(readLastTask(undefined)).toBeNull();
  });

  it('returns null for malformed stored data', () => {
    window.localStorage.setItem('trueppm:last-task:u1', '{not json');
    expect(readLastTask('u1')).toBeNull();
    window.localStorage.setItem('trueppm:last-task:u1', JSON.stringify({ taskId: 1 }));
    expect(readLastTask('u1')).toBeNull();
  });

  it('swallows storage failures on read and write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => recordLastTask('u1', TASK)).not.toThrow();
    expect(readLastTask('u1')).toBeNull();
  });
});
