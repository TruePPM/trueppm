import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

import { readLastTask } from '@/lib/lastTask';
import { useLastTaskStore } from '@/stores/lastTaskStore';
import { LastTaskRecorder } from './LastTaskRecorder';

let userId: string | undefined = 'u1';
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: userId ? { id: userId } : undefined }),
}));

const TASK = { taskId: 't1', projectId: 'p1', name: 'Wire OAuth', ref: 'T-8' };

afterEach(() => {
  userId = 'u1';
  window.localStorage.clear();
  useLastTaskStore.setState({ opened: null });
});

describe('LastTaskRecorder', () => {
  it('persists a drawer-opened task for the signed-in user', () => {
    render(<LastTaskRecorder />);
    act(() => useLastTaskStore.getState().setOpened(TASK));
    expect(readLastTask('u1')).toEqual(TASK);
  });

  it('records nothing before the user is known', () => {
    userId = undefined;
    render(<LastTaskRecorder />);
    act(() => useLastTaskStore.getState().setOpened(TASK));
    expect(readLastTask('u1')).toBeNull();
  });
});
