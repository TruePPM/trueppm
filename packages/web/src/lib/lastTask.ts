/**
 * Client-side "last task I opened" signal for the ⌘K "Log time on <last task>"
 * quick action (#1211).
 *
 * No server-side last-touched-task signal exists (`/me/recent-projects/` tracks
 * projects only), so the task drawer records the task here. Keyed by user id so a
 * shared browser never offers one person's last task to the next. Every storage
 * access is wrapped: private windows and blocked site data throw, and the palette
 * must simply omit the action rather than fail.
 */

export interface LastTask {
  taskId: string;
  projectId: string;
  /** Task name. */
  name: string;
  /** Display reference (qualified id, else WBS code), or null when unknown. */
  ref: string | null;
}

const KEY_PREFIX = 'trueppm:last-task:';

/** Record `task` as the user's last-opened task. Silent on storage failure. */
export function recordLastTask(userId: string, task: LastTask): void {
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${userId}`, JSON.stringify(task));
  } catch {
    // Storage unavailable — the quick action just won't appear.
  }
}

/** Read the user's last-opened task, or null when absent, malformed or unreadable. */
export function readLastTask(userId: string | undefined): LastTask | null {
  if (!userId) return null;
  try {
    const raw = window.localStorage.getItem(`${KEY_PREFIX}${userId}`);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    if (
      typeof r.taskId !== 'string' ||
      typeof r.projectId !== 'string' ||
      typeof r.name !== 'string' ||
      (r.ref !== null && typeof r.ref !== 'string')
    ) {
      return null;
    }
    return { taskId: r.taskId, projectId: r.projectId, name: r.name, ref: r.ref };
  } catch {
    return null;
  }
}

/** Forget the stored last task, but only if it is still `taskId` — a newer open
 *  must not be erased by a late failure on an older one. */
export function clearLastTask(userId: string, taskId: string): void {
  try {
    if (readLastTask(userId)?.taskId === taskId) {
      window.localStorage.removeItem(`${KEY_PREFIX}${userId}`);
    }
  } catch {
    // Storage unavailable — nothing was stored to clear.
  }
}
