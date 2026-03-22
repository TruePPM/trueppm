import type { Task } from '@/types';
import type { ITask } from '@svar-ui/gantt-store';

/**
 * Maps a TruePPM Task to SVAR's ITask shape.
 *
 * Bar type mapping (Design System v1.0 §2.2):
 * - isMilestone → type: 'milestone'
 * - isSummary   → type: 'summary'
 * - otherwise   → type: 'task'
 *
 * Critical and complete state are passed as custom fields ($critical, $complete)
 * for use in gantt.css custom styling and taskTemplate. SVAR does not have a
 * built-in 'critical' or 'complete' type — the visual distinction is applied via CSS
 * custom properties scoped to the bar element.
 *
 * Baseline data maps to base_start / base_end (SVAR's built-in baseline fields).
 */
export function toSvarTask(task: Task): ITask {
  const type: ITask['type'] = task.isMilestone
    ? 'milestone'
    : task.isSummary
      ? 'summary'
      : 'task';

  const svarTask: ITask = {
    id: task.id,
    text: task.name,
    start: new Date(task.start),
    end: new Date(task.finish),
    duration: task.duration,
    progress: task.progress / 100, // SVAR expects 0–1
    parent: task.parentId ?? 0,
    type,
    // Custom fields consumed by taskTemplate / gantt.css
    $critical: task.isCritical,
    $complete: task.isComplete,
    $wbs: task.wbs,
  };

  if (task.baselineStart && task.baselineFinish) {
    svarTask.base_start = new Date(task.baselineStart);
    svarTask.base_end = new Date(task.baselineFinish);
  }

  return svarTask;
}

export function toSvarTasks(tasks: Task[]): ITask[] {
  return tasks.map(toSvarTask);
}
