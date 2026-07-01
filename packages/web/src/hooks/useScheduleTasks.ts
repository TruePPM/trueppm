import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProjectId } from '@/hooks/useProjectId';
import { apiClient } from '@/api/client';
import type {
  Task,
  TaskAssignee,
  TaskLink,
  TaskStatus,
  LinkType,
  TaskReadiness,
  TaskType,
  GovernanceClass,
  DeliveryMode,
  DorState,
} from '@/types';
import type { PaginatedResponse } from '@/api/types';
import type { ExternalLinkStatus } from '@/lib/linkStatus';
import { computeWbsCodes } from '@/utils/computeWbsCodes';
import { useWsConnectionStore } from '@/stores/wsConnectionStore';

export interface UseScheduleTasksResult {
  tasks: Task[] | undefined;
  links: TaskLink[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

export interface ApiTask {
  id: string;
  wbs_path: string | null;
  name: string;
  early_start: string | null;
  early_finish: string | null;
  planned_start: string | null;
  duration: number;
  percent_complete: number;
  is_critical: boolean;
  status: TaskStatus;
  is_milestone: boolean;
  is_summary: boolean;
  parent_id: string | null;
  // Server-derived edit capabilities (ADR-0133, 1144). Optional: absent on
  // pre-field WebSocket deltas and on nested serializations without a request.
  can_edit?: boolean;
  can_delete?: boolean;
  actual_start: string | null;
  actual_finish: string | null;
  schedule_variance_days: number | null;
  // Server-owned per-task SPI + verdict (#990) and stalled verdict + dwell fact (#992).
  spi?: number | null;
  spi_band?: 'on_track' | 'at_risk' | 'behind' | null;
  is_stalled?: boolean;
  dwell_days?: number | null;
  baseline_start: string | null;
  baseline_finish: string | null;
  // CPM late finish (issue #1493) — surfaced so the drag-preview worker can
  // compute the CP-flip badge against real float instead of a baseline/finish
  // proxy. Null until the first CPM run.
  late_finish: string | null;
  /** Freshness signal (ADR-0143, issue 740) — annotated on the list/board queryset. */
  latest_note_at?: string | null;
  optimistic_duration: number | null;
  most_likely_duration: number | null;
  pessimistic_duration: number | null;
  estimate_status: 'pending' | 'accepted' | null;
  total_float: number | null;
  // Board batch 3 (ADR-0035) — PPM signal annotations.
  predecessor_count?: number;
  is_blocked?: boolean;
  // Human blocker flag (ADR-0124). Distinct from is_blocked above
  // (dependency-readiness). blocked_reason is the flag of record (non-empty ⇒
  // flagged) and is READ-GATED server-side (assignee + @-mentioned only), so it
  // is absent for other viewers; blocker_type/since/by/age/detail are team-visible.
  blocked_reason?: string;
  blocker_type?: string;
  blocking_task?: string | null;
  blocking_task_detail?: { id: string; short_id: string; title: string } | null;
  blocked_since?: string | null;
  blocked_by?: { id: string; username: string } | null;
  blocked_age_seconds?: number | null;
  linked_risks_count?: number;
  linked_risks_max_severity?: number | null;
  // At-a-glance external-link summary (issue 767, ADR-0155). worst_status is null when
  // count is 0. snake_case on the wire (TaskSerializer does not camelCase).
  external_link_summary?: { count: number; worst_status: ExternalLinkStatus | null };
  // Board batch 5 (issue #105) — entry stamps, priority rank, readiness.
  status_changed_at?: string | null;
  priority_rank?: number | null;
  readiness?: string | null;
  // Wave 3 (#210) — passive overalloc indicator in task drawer.
  assignee_is_overallocated?: boolean;
  server_version?: number;
  // Sprint membership (issue #317) — null/absent when not in a sprint.
  sprint?: string | null;
  // Sprint scope-injection pending flag (ADR-0102 §5) — snake_case on the wire
  // (TaskSerializer does not camelCase). Read-only; true ⇔ injected post-activation
  // and not yet accepted into the commitment.
  sprint_pending?: boolean;
  // Agile estimate (ADR-0037) — original commitment. Null for non-agile tasks.
  story_points?: number | null;
  // Live burndown signal (issue #366) — remaining effort; null = fall back to story_points.
  remaining_points?: number | null;
  // Long-form description (issue #305) — Task.notes field on the model.
  notes?: string;
  // Subtask discriminator (ADR-0060 #308) — true for tasks created via the drawer subtask action.
  is_subtask?: boolean;
  // Sprint scope-change audit rows (ADR-0060 #308) — non-empty when subtasks were added after sprint start.
  sprint_scope_changes?: Array<{
    // ADR-0102 — scope-change row id; targets the single accept/reject endpoints.
    id?: string;
    subtask_name: string;
    item_name?: string;
    added_by_name: string | null;
    added_at: string;
    goal_impact?: boolean;
    // ADR-0102 §5 — decision status; lowercase wire string. Absent on legacy rows.
    status?: 'pending' | 'accepted' | 'rejected';
  }>;
  // Sprint→milestone rollup payload (ADR-0074) — non-null only on milestone tasks with linked sprints.
  milestone_rollup?: {
    percent_complete: number | null;
    rollup_basis: 'points' | 'tasks' | 'none';
    variance_days: number | null;
    sprint_scope_changed: boolean;
    scope_change_sprint_id?: string | null;
    sprint_count: number;
  } | null;
  // 8-hex-digit project-scoped ID (ADR-0016 / issue #50).
  short_id?: string;
  assignments?: Array<{
    resource_id: string;
    resource_name: string;
    units: number;
  }>;
  // Product backlog & scoring (ADR-0105) — snake_case on the wire.
  type?: TaskType;
  governance_class?: GovernanceClass;
  delivery_mode?: DeliveryMode;
  parent_epic?: string | null;
  dor?: DorState;
  sprint_rank?: number | null;
  acceptance_criteria?: Array<{
    id: string;
    text: string;
    given?: string;
    when?: string;
    then?: string;
    met: boolean;
    position: number;
    met_by_name?: string | null;
    met_at?: string | null;
  }>;
  prioritization_score?: number | null;
  criteria_met_count?: number;
  criteria_total?: number;
  dor_blockers?: string[];
  // Scoring-model raw inputs (ADR-0105 / #922) — snake_case on the wire. Editable
  // via the grooming drawer (#1043); the server derives prioritization_score from them.
  business_value?: number | null;
  time_criticality?: number | null;
  risk_reduction?: number | null;
  job_size?: number | null;
  reach?: number | null;
  impact?: number | null;
  confidence?: number | null;
  effort?: number | null;
  value?: number | null;
  effort_estimate?: number | null;
}

interface ApiDependency {
  id: string;
  predecessor: string;
  successor: string;
  dep_type: 'FS' | 'SS' | 'FF' | 'SF';
  lag: number;
  // NOTE: there is no `is_critical` on the dependency model/serializer —
  // criticality is a property of the two endpoint tasks. Link criticality is
  // derived in useScheduleTasks (both endpoints on the critical path).
}

/**
 * Derive the Gantt bar geometry (start, finish, display duration) from a task's
 * raw date fields. Shared by {@link mapTask} (full API task) and
 * {@link applyTaskDatesDelta} (per-task WebSocket CPM delta, ADR-0091) so the
 * bar-positioning rules stay single-sourced and the two paths can never drift.
 */
export function deriveBarGeometry(opts: {
  plannedStart: string | null;
  earlyStart: string | null;
  earlyFinish: string | null;
  duration: number;
  isSummary: boolean;
}): { start: string; finish: string; displayDuration: number } {
  const { plannedStart: p, earlyStart: e, earlyFinish: ef, duration, isSummary } = opts;

  // Use the later of planned_start (SNET constraint) and early_start (CPM result).
  //
  // CPM guarantees early_start = max(forward-pass result, planned_start), so after
  // CPM runs, early_start ≥ planned_start. Taking max() here means:
  //   • Right after a drag (planned_start updated, CPM pending): planned_start wins ✓
  //   • After CPM with a new dependency pushing the task later: early_start wins ✓
  //   • No SNET constraint (planned_start = null): early_start is used directly ✓
  const start = p && e ? (p >= e ? p : e) : (p ?? e ?? '');

  // Summary tasks: start/finish always come from the CPM rollup (early_start /
  // early_finish). Without CPM there's no meaningful finish — the stored
  // duration is rolled up from children, not stored on the row.
  //
  // Leaf tasks: prefer early_finish (CPM result, working-day-correct against the
  // project calendar) once CPM has produced it. Fall back to a calendar-day
  // estimate (start + duration) only when early_finish is missing — e.g.
  // immediately after a duration drag, before CPM has had a chance to run.
  // Without this preference the leaf bar used a calendar-day span while the
  // summary used the working-day span, so every weekend inside a leaf widened
  // the summary visibly past its widest child (#314: rollup looked 4 days
  // "longer" than its longest child).
  const finish = isSummary
    ? (ef ?? '')
    : ef
      ?? ((start && duration > 0)
        ? new Date(
            new Date(start + 'T00:00:00Z').getTime() + duration * 86_400_000,
          ).toISOString().slice(0, 10)
        : '');

  // For summary tasks that have CPM dates, compute a display duration as the
  // calendar-day span. This matches what the backend writes back during CPM so
  // both representations stay consistent.
  const displayDuration =
    isSummary && e && ef
      ? Math.max(
          1,
          Math.round((new Date(ef).getTime() - new Date(e).getTime()) / 86_400_000),
        )
      : duration;

  return { start, finish, displayDuration };
}

export function mapTask(t: ApiTask): Task {
  const { start, finish, displayDuration } = deriveBarGeometry({
    plannedStart: t.planned_start,
    earlyStart: t.early_start,
    earlyFinish: t.early_finish,
    duration: t.duration,
    isSummary: t.is_summary,
  });

  return {
    id: t.id,
    wbs: t.wbs_path ?? '',
    name: t.name,
    start,
    finish,
    duration: displayDuration,
    progress: t.percent_complete,
    parentId: t.parent_id,
    isCritical: t.is_critical,
    isComplete: t.percent_complete >= 100,
    isSummary: t.is_summary,
    isMilestone: t.is_milestone,
    status: t.status,
    // Server-derived edit capabilities (ADR-0133). Preserve `undefined` when the
    // payload omits them (pre-field synced rows) so the drawer's
    // `canEdit ?? canEditTask(role)` fallback engages instead of forcing read-only.
    canEdit: t.can_edit,
    canDelete: t.can_delete,
    actualStart: t.actual_start ?? undefined,
    actualFinish: t.actual_finish ?? undefined,
    scheduleVarianceDays: t.schedule_variance_days,
    spi: t.spi ?? null,
    spiBand: t.spi_band ?? null,
    isStalled: t.is_stalled ?? false,
    dwellDays: t.dwell_days ?? null,
    baselineStart: t.baseline_start ?? undefined,
    baselineFinish: t.baseline_finish ?? undefined,
    lateFinish: t.late_finish ?? undefined,
    latestNoteAt: t.latest_note_at ?? null,
    assignees: (t.assignments ?? []).map(
      (a): TaskAssignee => ({
        resourceId: a.resource_id,
        name: a.resource_name,
        units: a.units,
      }),
    ),
    optimisticDuration: t.optimistic_duration,
    mostLikelyDuration: t.most_likely_duration,
    pessimisticDuration: t.pessimistic_duration,
    estimateStatus: t.estimate_status,
    totalFloat: t.total_float,
    predecessorCount: t.predecessor_count ?? 0,
    isBlocked: t.is_blocked ?? false,
    // Human blocker flag (ADR-0124). blockedReason stays `undefined` when the
    // server gated it out (the privacy signal the section reads); never default
    // it to '' or a non-assignee would look like they can read an empty reason.
    blockedReason: t.blocked_reason,
    blockerType: t.blocker_type ?? '',
    blockingTask: t.blocking_task ?? null,
    blockingTaskDetail: t.blocking_task_detail
      ? {
          id: t.blocking_task_detail.id,
          shortId: t.blocking_task_detail.short_id,
          title: t.blocking_task_detail.title,
        }
      : null,
    blockedSince: t.blocked_since ?? null,
    blockedBy: t.blocked_by ?? null,
    blockedAgeSeconds: t.blocked_age_seconds ?? null,
    linkedRisksCount: t.linked_risks_count ?? 0,
    linkedRisksMaxSeverity: t.linked_risks_max_severity ?? null,
    externalLinkSummary: t.external_link_summary
      ? {
          count: t.external_link_summary.count ?? 0,
          worstStatus: t.external_link_summary.worst_status ?? null,
        }
      : undefined,
    statusEnteredAt: t.status_changed_at ?? undefined,
    priorityRank: t.priority_rank ?? undefined,
    readiness: (t.readiness as TaskReadiness | undefined) ?? undefined,
    assigneeIsOverallocated: t.assignee_is_overallocated ?? false,
    serverVersion: t.server_version,
    sprintId: t.sprint ?? null,
    sprintPending: t.sprint_pending ?? false,
    storyPoints: t.story_points ?? null,
    remainingPoints: t.remaining_points ?? null,
    plannedStart: t.planned_start,
    notes: t.notes ?? '',
    isSubtask: t.is_subtask ?? false,
    sprintScopeChanges: t.sprint_scope_changes?.map((s) => ({
      id: s.id,
      subtaskName: s.subtask_name,
      itemName: s.item_name ?? s.subtask_name,
      addedByName: s.added_by_name,
      addedAt: s.added_at,
      goalImpact: s.goal_impact ?? false,
      // Legacy rows (pre-ADR-0102) carry no status; treat them as accepted so
      // they never resurface as a pending-review item.
      status: s.status ?? 'accepted',
    })),
    milestoneRollup: t.milestone_rollup ?? null,
    shortId: t.short_id,
    // Product backlog & scoring (ADR-0105). Absent on legacy/non-agile payloads.
    taskType: t.type ?? undefined,
    governanceClass: t.governance_class ?? undefined,
    deliveryMode: t.delivery_mode ?? undefined,
    parentEpic: t.parent_epic ?? null,
    dor: t.dor ?? undefined,
    sprintRank: t.sprint_rank ?? null,
    acceptanceCriteria: t.acceptance_criteria?.map((c) => ({
      id: c.id,
      text: c.text,
      given: c.given,
      when: c.when,
      then: c.then,
      met: c.met,
      position: c.position,
      metByName: c.met_by_name ?? null,
      metAt: c.met_at ?? null,
    })),
    score: t.prioritization_score ?? null,
    acMet: t.criteria_met_count ?? undefined,
    acTotal: t.criteria_total ?? undefined,
    dorBlockers: t.dor_blockers ?? undefined,
    businessValue: t.business_value ?? null,
    timeCriticality: t.time_criticality ?? null,
    riskReduction: t.risk_reduction ?? null,
    jobSize: t.job_size ?? null,
    reach: t.reach ?? null,
    impact: t.impact ?? null,
    confidence: t.confidence ?? null,
    effort: t.effort ?? null,
    value: t.value ?? null,
    effortEstimate: t.effort_estimate ?? null,
  };
}

/**
 * One task's CPM date delta, as carried in the batched `task_dates_updated`
 * WebSocket event (ADR-0091). Field names mirror the API serializer so the
 * payload can be spliced straight into the tasks cache. `late_start` and
 * `free_float` are part of the wire contract (and used by mobile) but are
 * not surfaced on the web {@link Task}, so the web splice ignores them.
 * `late_finish` **is** surfaced (issue #1493, drag-preview CP-flip fix) — see
 * {@link applyTaskDatesDelta}.
 */
export interface TaskDatesDelta {
  id: string;
  early_start: string | null;
  early_finish: string | null;
  late_start: string | null;
  late_finish: string | null;
  total_float: number | null;
  free_float: number | null;
  is_critical: boolean;
  planned_start: string | null;
  duration: number;
}

/**
 * Splice a CPM date delta into an existing cached {@link Task} (ADR-0091),
 * returning a new Task with only the CPM-derived fields updated (bar geometry,
 * criticality, total float, planned_start) and every other field preserved.
 *
 * The `task_dates_updated` WebSocket handler uses this so a collaborator's bar
 * slides the instant the originator's CPM run completes, with no re-fetch. Bar
 * geometry comes from {@link deriveBarGeometry} — the same rules as
 * {@link mapTask} — so a spliced task is byte-for-byte what a full re-fetch
 * would have produced.
 */
export function applyTaskDatesDelta(existing: Task, delta: TaskDatesDelta): Task {
  const { start, finish, displayDuration } = deriveBarGeometry({
    plannedStart: delta.planned_start,
    earlyStart: delta.early_start,
    earlyFinish: delta.early_finish,
    duration: delta.duration,
    isSummary: existing.isSummary,
  });
  return {
    ...existing,
    start,
    finish,
    duration: displayDuration,
    isCritical: delta.is_critical,
    totalFloat: delta.total_float,
    lateFinish: delta.late_finish ?? undefined,
    plannedStart: delta.planned_start,
  };
}

function mapDependency(d: ApiDependency): TaskLink {
  return {
    id: d.id,
    sourceId: d.predecessor,
    targetId: d.successor,
    type: d.dep_type as LinkType,
    lag: d.lag,
    // Placeholder — the real value is derived from endpoint-task criticality in
    // useScheduleTasks once both the tasks and dependencies queries resolve.
    isCritical: false,
  };
}

/**
 * Fetch tasks and dependency links for the Gantt view.
 *
 * Reads projectId from the `:projectId` path param (ADR-0030).
 * An explicit `projectId` argument overrides the URL param for cases
 * where the hook is used outside the project route (e.g. tests).
 */
export function useScheduleTasks(projectId?: string): UseScheduleTasksResult {
  const paramId = useProjectId();
  const resolvedId = projectId ?? paramId;

  // Fallback polling is only needed when the live-update WebSocket is NOT
  // delivering events. When the socket is `live`, useProjectWebSocket
  // invalidates the tasks/dependencies caches on every mutation, so a 30 s
  // poll is pure waste (a full multi-page refetch at 0.5 Hz). Gate the
  // interval on the connection state: poll only while the socket is down
  // (`reconnecting`/`stale`/`failed`) or before it has opened (`connecting`).
  const wsState = useWsConnectionStore((s) => s.state);
  const wsHealthy = wsState === 'live';
  const fallbackInterval = wsHealthy ? (false as const) : 30_000;

  const tasksQuery = useQuery({
    queryKey: ['tasks', resolvedId],
    queryFn: async () => {
      // Fetch all pages — PAGE_SIZE=50 would otherwise silently cap the Gantt
      // at 50 tasks. Follow the DRF `next` cursor until exhausted.
      const allApiTasks: ApiTask[] = [];
      let nextUrl: string | null = '/tasks/';
      let isFirstPage = true;
      while (nextUrl) {
        const params = isFirstPage ? { project: resolvedId } : undefined;
        const currentUrl: string = nextUrl;
        isFirstPage = false;
        const { data: pageData } = await apiClient.get<PaginatedResponse<ApiTask>>(currentUrl, {
          params,
        });
        allApiTasks.push(...pageData.results);
        // Strip the origin from the next URL so apiClient uses its baseURL.
        nextUrl = pageData.next
          ? pageData.next.replace(/^https?:\/\/[^/]+/, '')
          : null;
      }
      // Pass all tasks to the engine — _paintTaskAt skips bars for unscheduled
      // tasks (empty start/finish), and _updateProjectRange defaults to today
      // ±30 days when no task has dates yet.
      const rawTasks = allApiTasks.map(mapTask);
      // Compute WBS display codes from tree position (parentId + sibling order)
      // rather than passing through wbs_path directly. This ensures codes are
      // always sequential and correct — including for tasks created in the UI
      // before wbs_path is assigned, or after indent/outdent operations.
      const wbsCodes = computeWbsCodes(rawTasks);
      return rawTasks.map((t) => ({ ...t, wbs: wbsCodes.get(t.id) ?? t.wbs }));
    },
    enabled: !!resolvedId,
    // WebSocket invalidations (useProjectWebSocket) handle live updates while
    // the socket is healthy. The 30 s fallback only runs when the socket is
    // down, so it catches missed events without hammering the API when the
    // live channel is already doing the job.
    refetchInterval: fallbackInterval,
  });

  const linksQuery = useQuery({
    queryKey: ['dependencies', resolvedId],
    queryFn: async () => {
      // Fetch all pages — a single GET would cap at PAGE_SIZE=50 dependencies,
      // silently dropping arrows and CPM edges on projects with >50 deps. Mirror
      // the tasks-query loop above: follow the DRF `next` cursor until exhausted.
      const allDeps: ApiDependency[] = [];
      let nextUrl: string | null = '/dependencies/';
      let isFirstPage = true;
      while (nextUrl) {
        const params = isFirstPage ? { project: resolvedId } : undefined;
        const currentUrl: string = nextUrl;
        isFirstPage = false;
        const { data: pageData } = await apiClient.get<PaginatedResponse<ApiDependency>>(
          currentUrl,
          { params },
        );
        allDeps.push(...pageData.results);
        // Strip the origin from the next URL so apiClient uses its baseURL.
        nextUrl = pageData.next
          ? pageData.next.replace(/^https?:\/\/[^/]+/, '')
          : null;
      }
      return allDeps.map(mapDependency);
    },
    enabled: !!resolvedId,
  });

  // Derive link criticality from the endpoint tasks: a dependency edge is on the
  // critical path when both its predecessor and successor are critical tasks.
  // (The API has no per-dependency is_critical field — criticality lives on the
  // task. Without this the Gantt rendered every critical-path arrow as
  // non-critical, since the old code read a field that never existed.)
  const tasks = tasksQuery.data;
  const links = useMemo(() => {
    const rawLinks = linksQuery.data;
    if (!rawLinks) return undefined;
    if (!tasks) return rawLinks;
    const criticalTaskIds = new Set(
      tasks.filter((t) => t.isCritical).map((t) => t.id),
    );
    return rawLinks.map((l) => ({
      ...l,
      isCritical: criticalTaskIds.has(l.sourceId) && criticalTaskIds.has(l.targetId),
    }));
  }, [linksQuery.data, tasks]);

  return {
    tasks,
    links,
    isLoading: tasksQuery.isLoading || linksQuery.isLoading,
    error: tasksQuery.error ?? linksQuery.error,
  };
}
