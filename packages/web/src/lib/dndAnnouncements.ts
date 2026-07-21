import type { Announcements } from '@dnd-kit/core';

/**
 * dnd-kit screen-reader announcements that resolve the dragged item's id to
 * its task name (WCAG 4.1.2, #2203).
 *
 * dnd-kit's default announcer speaks the raw draggable id — "Picked up
 * draggable item 3f2c8e…" — because our sortable ids are task UUIDs. This
 * override names the task on pickup and cancel instead.
 *
 * `onDragOver` / `onDragEnd` deliberately return `undefined`: the Board
 * (`ariaLiveRef`) and Outline (`liveAnnouncement`) already push a semantic
 * outcome message ("moved to In Progress", "moved under Phase 2") through
 * their own live regions, so speaking here too would double-announce.
 */
export function taskDndAnnouncements(
  tasks: ReadonlyArray<{ id: string; name: string }> | undefined,
): Announcements {
  const nameOf = (id: string | number): string =>
    tasks?.find((t) => t.id === String(id))?.name ?? 'task';
  return {
    onDragStart: ({ active }) =>
      `Picked up ${nameOf(active.id)}. Use the arrow keys to move it, space to drop.`,
    onDragOver: () => undefined,
    onDragEnd: () => undefined,
    onDragCancel: ({ active }) => `Movement cancelled. ${nameOf(active.id)} was returned.`,
  };
}
