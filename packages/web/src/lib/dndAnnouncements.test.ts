import { describe, it, expect } from 'vitest';
import type { Active, Over } from '@dnd-kit/core';
import { taskDndAnnouncements } from './dndAnnouncements';

const TASKS = [
  { id: 't1', name: 'Wire OAuth callback' },
  { id: 't2', name: 'Ship the beta' },
];

/** Minimal Active/Over stubs — only `id` is read by the announcer. */
const active = (id: string) => ({ id }) as unknown as Active;
const over = (id: string) => ({ id }) as unknown as Over;

describe('taskDndAnnouncements (#2203)', () => {
  it('names the dragged task on pickup instead of speaking the raw UUID', () => {
    const a = taskDndAnnouncements(TASKS);
    expect(a.onDragStart({ active: active('t1') })).toMatch(/Wire OAuth callback/);
    expect(a.onDragStart({ active: active('t1') })).not.toMatch(/t1/);
  });

  it('names the dragged task on cancel', () => {
    const a = taskDndAnnouncements(TASKS);
    expect(a.onDragCancel({ active: active('t2'), over: null })).toMatch(/Ship the beta/);
  });

  it('defers over/end to the caller\'s own live region (returns undefined)', () => {
    const a = taskDndAnnouncements(TASKS);
    expect(a.onDragOver({ active: active('t1'), over: over('t2') })).toBeUndefined();
    expect(a.onDragEnd({ active: active('t1'), over: over('t2') })).toBeUndefined();
  });

  it('falls back to "task" for an unknown id or missing task list', () => {
    expect(taskDndAnnouncements(TASKS).onDragStart({ active: active('nope') })).toMatch(/task/);
    expect(taskDndAnnouncements(undefined).onDragStart({ active: active('t1') })).toMatch(/task/);
  });
});
