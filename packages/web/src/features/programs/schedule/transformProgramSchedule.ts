import type { Task, TaskLink } from '@/types';
import type {
  ProgramSchedule,
  ProgramScheduleLane,
  ProgramScheduleTask,
} from '../hooks/useProgramSchedule';

/**
 * Transform the `GET /programs/{id}/schedule/` payload into the flat
 * `Task[]`/`TaskLink[]` the canvas Gantt engine consumes (ADR-0182).
 *
 * Project lanes are realized as **synthetic per-project summary rows**: each
 * lane becomes a top-level `isSummary` task (`id = "lane:{projectId}"`) and
 * every member-project task is reparented under it. The engine renders tasks in
 * array order, so emitting `[lane, ...its tasks, nextLane, ...]` yields the lane
 * grouping with the engine's existing summary/indent rendering — no engine
 * row-model change (ADR-0030 "constrained mode, not a new library").
 *
 * Render-don't-derive (ADR-0115): criticality (`isCritical`), cross-project-ness
 * (`crossProject`), and external redaction (`isExternal`) all come straight from
 * the server — nothing is recomputed in the browser.
 */

/** Prefix marking a synthetic project-lane summary row (no backing entity). */
export const LANE_ID_PREFIX = 'lane:';

/** True for the synthetic lane summary rows this transform emits. */
export function isLaneId(taskId: string): boolean {
  return taskId.startsWith(LANE_ID_PREFIX);
}

/** Lane summary id for a member project. */
export function laneIdFor(projectId: string): string {
  return `${LANE_ID_PREFIX}${projectId}`;
}

/** The member-project id a lane summary id refers to. */
export function projectIdFromLaneId(laneId: string): string {
  return laneId.slice(LANE_ID_PREFIX.length);
}

/** Inclusive calendar-day span between two ISO `YYYY-MM-DD` dates (≥1). */
function inclusiveDays(startIso: string, finishIso: string): number {
  const start = Date.parse(`${startIso}T00:00:00Z`);
  const finish = Date.parse(`${finishIso}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(finish) || finish < start) return 1;
  return Math.round((finish - start) / 86_400_000) + 1;
}

function minIso(values: string[]): string {
  return values.reduce((acc, v) => (acc === '' || v < acc ? v : acc), '');
}

function maxIso(values: string[]): string {
  return values.reduce((acc, v) => (v > acc ? v : acc), '');
}

function laneSummaryTask(lane: ProgramScheduleLane, laneTasks: ProgramScheduleTask[]): Task {
  const starts = laneTasks.map((t) => t.early_start).filter((d): d is string => !!d);
  const finishes = laneTasks.map((t) => t.early_finish).filter((d): d is string => !!d);
  const start = minIso(starts);
  const finish = maxIso(finishes) || start;
  return {
    id: laneIdFor(lane.id),
    wbs: '',
    name: lane.name,
    start,
    finish,
    duration: start && finish ? inclusiveDays(start, finish) : 0,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: true,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
  };
}

function leafTask(task: ProgramScheduleTask, laneId: string): Task {
  const name = task.is_external ? task.title : task.name;
  const earlyStart = task.early_start;
  const earlyFinish = task.early_finish;
  const start = earlyStart ?? '';
  const finish = earlyFinish ?? start;
  return {
    id: task.id,
    wbs: '',
    name,
    start,
    finish,
    // The engine only anchors a non-summary task's dependency arrows when it has
    // a committed start (`plannedStart`) or sprint (GanttRenderer gate). Program
    // tasks carry CPM dates but no `planned_start`, so seed `plannedStart` from
    // `early_start` (render-only, never persisted) — otherwise cross-project
    // arrows would have no endpoints to draw to. A task with no `early_start`
    // stays unscheduled (null → the gutter), matching the single-project view.
    plannedStart: earlyStart,
    duration: earlyStart && earlyFinish ? inclusiveDays(earlyStart, earlyFinish) : 1,
    progress: 0,
    parentId: laneId,
    isCritical: task.is_critical,
    isComplete: false,
    isSummary: false,
    isMilestone: task.is_milestone,
    isExternal: task.is_external,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
  };
}

export interface ProgramScheduleEngineData {
  tasks: Task[];
  links: TaskLink[];
}

/**
 * Build the engine `tasks`/`links` arrays from a program schedule payload.
 *
 * Tasks are emitted lane-by-lane in payload order (lanes are pre-sorted by
 * `start_date`, `name` server-side); each lane summary precedes its own tasks.
 */
export function transformProgramSchedule(schedule: ProgramSchedule): ProgramScheduleEngineData {
  const tasksByProject = new Map<string, ProgramScheduleTask[]>();
  for (const task of schedule.tasks) {
    const bucket = tasksByProject.get(task.project_id);
    if (bucket) bucket.push(task);
    else tasksByProject.set(task.project_id, [task]);
  }

  const tasks: Task[] = [];
  for (const lane of schedule.projects) {
    const laneTasks = tasksByProject.get(lane.id) ?? [];
    tasks.push(laneSummaryTask(lane, laneTasks));
    const laneId = laneIdFor(lane.id);
    for (const task of laneTasks) {
      tasks.push(leafTask(task, laneId));
    }
  }

  // A link is critical when both endpoints sit on the program-true critical
  // path (mirrors the single-project post-join in useScheduleTasks). The engine
  // does not color arrows by criticality (rule 73), but the flag stays on the
  // wire contract.
  const criticalIds = new Set(schedule.critical_path);
  const links: TaskLink[] = schedule.links.map((link) => ({
    // The payload has no link id (edges are anonymous leaf-level pairs); a
    // composite key is stable across re-fetches and unique per (pair, type).
    id: `${link.predecessor_id}-${link.dep_type}->${link.successor_id}`,
    sourceId: link.predecessor_id,
    targetId: link.successor_id,
    type: link.dep_type,
    lag: link.lag_days,
    isCritical: criticalIds.has(link.predecessor_id) && criticalIds.has(link.successor_id),
    crossProject: link.is_cross_project,
  }));

  return { tasks, links };
}
