import { afterEach, describe, expect, it } from 'vitest';
import { useTaskDrawerStore } from './taskDrawerStore';
import type { Task } from '@/types';

const fakeTask = { id: 't1', name: 'Wire OAuth' } as unknown as Task;

afterEach(() => {
  useTaskDrawerStore.getState().close();
});

describe('taskDrawerStore', () => {
  it('starts closed', () => {
    const s = useTaskDrawerStore.getState();
    expect(s.task).toBeNull();
    expect(s.projectId).toBeNull();
  });

  it('openTask sets the task + project, close clears both', () => {
    useTaskDrawerStore.getState().openTask(fakeTask, 'p1');
    expect(useTaskDrawerStore.getState().task).toBe(fakeTask);
    expect(useTaskDrawerStore.getState().projectId).toBe('p1');

    useTaskDrawerStore.getState().close();
    expect(useTaskDrawerStore.getState().task).toBeNull();
    expect(useTaskDrawerStore.getState().projectId).toBeNull();
  });
});
