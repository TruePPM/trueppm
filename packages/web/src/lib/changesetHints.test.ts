import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InternalAxiosRequestConfig } from 'axios';
import { apiClient } from '@/api/client';
import { useAuthStore } from '@/stores/authStore';
import {
  closeChangesetGroup,
  isStructuralWrite,
  resetChangesetHintsForTest,
  setChangesetSurface,
} from './changesetHints';

/**
 * The request bodies the real `apiClient` sends (ADR-1477 §3, #3150). A custom
 * adapter captures each request after every interceptor and transform has run,
 * so these assert the wire body, not the helper's return value.
 */
const sent: Array<{ method?: string; url?: string; body: unknown }> = [];
const originalAdapter = apiClient.defaults.adapter;

beforeEach(() => {
  sent.length = 0;
  resetChangesetHintsForTest();
  useAuthStore.setState({ sessionExpired: false });
  apiClient.defaults.adapter = (config: InternalAxiosRequestConfig) => {
    sent.push({
      method: config.method,
      url: config.url,
      body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
    });
    return Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config });
  };
});

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
});

const last = () => sent[sent.length - 1].body as Record<string, unknown>;

describe('changeset hints on structural writes', () => {
  it('a fresh page session opens a new group on its first write, then batches', async () => {
    setChangesetSurface('grid', 'flat');
    await apiClient.post('/projects/p1/tasks/t1/indent/', {});
    expect(last()).toEqual({ surface: 'grid', amend_group: 'new' });
    await apiClient.post('/projects/p1/tasks/t2/indent/', {});
    expect(last()).toEqual({ surface: 'grid' });
  });

  it('carries the surface so a Board drag never groups with a Grid restructure', async () => {
    setChangesetSurface('board');
    await apiClient.post('/projects/p1/tasks/reorder/', { ordered_ids: ['a'] });
    expect(last()).toMatchObject({ surface: 'board', ordered_ids: ['a'] });
  });

  it('a surface change closes the group on the next write', async () => {
    setChangesetSurface('grid', 'grid');
    await apiClient.post('/projects/p1/tasks/bulk/', { operations: [] });
    await apiClient.post('/projects/p1/tasks/bulk/', { operations: [] });
    expect(last()).not.toHaveProperty('amend_group');
    setChangesetSurface('gantt', 'timeline');
    await apiClient.post('/projects/p1/tasks/bulk/', { operations: [] });
    expect(last()).toMatchObject({ surface: 'gantt', amend_group: 'new' });
  });

  it('a mode change on the same surface closes the group', async () => {
    setChangesetSurface('grid', 'flat');
    await apiClient.post('/tasks/t1/split/', {});
    setChangesetSurface('grid', 'grouped');
    await apiClient.post('/tasks/t1/split/', {});
    expect(last()).toMatchObject({ surface: 'grid', amend_group: 'new' });
  });

  it('opening Review closes the group', async () => {
    setChangesetSurface('outline', 'outline');
    await apiClient.post('/projects/p1/tasks/', { name: 'A' });
    closeChangesetGroup();
    await apiClient.post('/projects/p1/tasks/', { name: 'B' });
    expect(last()).toEqual({ name: 'B', surface: 'outline', amend_group: 'new' });
  });

  it('pagehide closes the group', async () => {
    setChangesetSurface('grid', 'flat');
    await apiClient.post('/projects/p1/tasks/t1/outdent/', {});
    window.dispatchEvent(new Event('pagehide'));
    await apiClient.delete('/tasks/t1/');
    expect(last()).toEqual({ surface: 'grid', amend_group: 'new' });
  });

  it('leaves non-structural writes, undo and the caller’s own hints alone', async () => {
    setChangesetSurface('grid', 'flat');
    await apiClient.patch('/tasks/t1/', { name: 'x' });
    expect(last()).toEqual({ name: 'x' });
    await apiClient.post('/tasks/t1/restore/');
    expect(sent[sent.length - 1].body).toBeUndefined();
    await apiClient.post('/projects/p1/tasks/group/', { surface: 'api', amend_group: 'keep' });
    expect(last()).toEqual({ surface: 'api', amend_group: 'keep' });
  });

  it('matches every structural route and nothing else', () => {
    expect(isStructuralWrite('post', '/projects/p/tasks/ungroup/')).toBe(true);
    expect(isStructuralWrite('post', '/projects/p/tasks/t/reparent/')).toBe(true);
    expect(isStructuralWrite('post', '/projects/p/phases/')).toBe(true);
    expect(isStructuralWrite('delete', '/projects/p/phases/x/')).toBe(true);
    expect(isStructuralWrite('get', '/projects/p/tasks/')).toBe(false);
    expect(isStructuralWrite('post', '/projects/p/phases/reorder/')).toBe(false);
    expect(isStructuralWrite('post', '/tasks/t/restore/')).toBe(false);
  });
});
