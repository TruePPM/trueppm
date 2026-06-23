/**
 * Connects to the project WebSocket channel and dispatches incoming events.
 *
 * Events handled:
 *   task_run_started  → taskRunStore.addRun(); for scheduling tasks also setRecalculating(true)
 *   task_run_progress → taskRunStore.updateProgress()
 *   task_run_completed → taskRunStore.completeRun(); for scheduling tasks also setCpmComplete()
 *   task_run_failed   → taskRunStore.failRun(); for scheduling tasks also setCpmError()
 *   task_run_cancelled → taskRunStore.cancelRun()
 *   cpm_complete      → schedulerStore.setCpmComplete() + shellStats (compat broadcast; tasks cache owned by task_dates_updated)
 *   task_dates_updated → splice per-task CPM date deltas into the tasks cache; truncated payload → invalidate (ADR-0091)
 *   cpm_error         → schedulerStore.setCpmError(), setRecalculating(false)
 *   task_created / task_deleted → invalidate tasks
 *   task_updated → invalidate tasks, unless self-echo (actor_id === current user) or a
 *                  duplicate/replayed version (ADR-0152, #327)
 *   tasks_reordered / tasks_restructured / tasks_bulk_mutated → invalidate tasks
 *   dependency_created / dependency_updated / dependency_deleted → invalidate dependencies + tasks
 *   baseline_created / baseline_activated / baseline_deleted → invalidate baselines + tasks
 *   risk_created / risk_updated / risk_deleted → invalidate risks
 *   comment_created → invalidate riskComments (risk comments only — task comments use task_comment_*)
 *   task_comment_created / task_comment_updated / task_comment_deleted / task_comment_reaction_added / task_comment_reaction_removed / task_comment_ack_changed → invalidate task-comments[taskId]
 *   task_attachment_created / task_attachment_deleted → invalidate task-attachments[taskId]
 *   task_note_created / task_note_updated / task_note_deleted / task_note_pinned → invalidate task-notes[taskId] + tasks (latest_note_at freshness chip)
 *   sprint_created / sprint_updated / sprint_deleted / sprint_activated / sprint_cancelled / sprint_closed → invalidate sprints
 *   retro_item_created / retro_item_updated / retro_item_deleted / retro_item_moved → invalidate retro-board (ADR-0117)
 *   assignment_created / assignment_updated / assignment_deleted / roster_changed → invalidate tasks
 *   member_added / member_role_changed / member_removed → invalidate members
 *   team_member_changed → invalidate team-members[teamId] (facet/role reassign, ADR-0078)
 *   board_config_updated → invalidate boardConfig
 *   board_view_created / board_view_updated / board_view_deleted → invalidate boardViews
 *   project_created / project_updated / project_deleted → invalidate project + projects
 *   phases_reordered → invalidate tasks
 *   board activity feed → the card-sync events above (task_created / task_updated /
 *     task_deleted, sprint_scope_changed, task_comment_created) also invalidate
 *     ['board-activity', projectId] so the activity panel refetches its head page live,
 *     through the already role-gated read API — no new WS event (ADR-0160 Amendment B1, issue 1264)
 *
 * Reconnects with exponential backoff (1s → 2s → 4s → … up to 30s).
 * Stops reconnecting when `projectId` is null/undefined or the token is absent.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSchedulerStore } from '@/stores/schedulerStore';
import { useTaskRunStore } from '@/stores/taskRunStore';
import { useWsConnectionStore } from '@/stores/wsConnectionStore';
import { applyTaskDatesDelta, type TaskDatesDelta } from '@/hooks/useScheduleTasks';
import { fetchWsTicket } from '@/api/wsTicket';
import type { Task } from '@/types';
import type { CpmError } from '@/stores/schedulerStore';

interface WsEnvelope {
  event_type: string;
  payload: Record<string, unknown>;
}

const WS_BASE = (() => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
})();

const MAX_BACKOFF_MS = 30_000;

/**
 * Trailing-debounce window for coalescing a burst of Gantt-data invalidations
 * (`tasks`, `dependencies`). A sync batch broadcasts one mutation event per
 * row, and each event would otherwise trigger an independent multi-page refetch
 * of the tasks/dependencies queries. Collapsing a burst into a single trailing
 * invalidation turns N refetches into 1 while keeping live latency imperceptible
 * (the trailing call still fires ~300 ms after the last event in the burst).
 */
const TASKS_INVALIDATE_DEBOUNCE_MS = 300;

export function useProjectWebSocket(projectId: string | null | undefined): void {
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((s) => s.accessToken);
  const setRecalculating = useSchedulerStore((s) => s.setRecalculating);
  const setCpmError = useSchedulerStore((s) => s.setCpmError);
  const setCpmComplete = useSchedulerStore((s) => s.setCpmComplete);
  const addRun = useTaskRunStore((s) => s.addRun);
  const updateProgress = useTaskRunStore((s) => s.updateProgress);
  const completeRun = useTaskRunStore((s) => s.completeRun);
  const failRun = useTaskRunStore((s) => s.failRun);
  const cancelRun = useTaskRunStore((s) => s.cancelRun);
  const addPresenceUser = usePresenceStore((s) => s.addUser);
  const removePresenceUser = usePresenceStore((s) => s.removeUser);

  // Stable refs so the reconnect loop doesn't capture stale closures.
  const projectIdRef = useRef(projectId);
  const tokenRef = useRef(accessToken);
  projectIdRef.current = projectId;
  tokenRef.current = accessToken;

  // Track whether the component is still mounted so we don't reconnect after unmount.
  const mountedRef = useRef(true);

  // Trailing-debounce state for coalescing burst-prone invalidations (tasks,
  // dependencies, and the board activity feed). The set accumulates which query
  // keys a burst touched; the timer flushes them as a single invalidation per key
  // once the burst goes quiet (#773).
  const pendingInvalidationsRef = useRef<
    Set<'tasks' | 'dependencies' | 'board-activity' | 'standup'>
  >(new Set());
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ADR-0152 (#327): highest task_updated server_version observed per task, so a
  // duplicate or out-of-order replayed delta is ignored rather than triggering a
  // redundant refetch.
  const seenTaskVersionsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (invalidateTimerRef.current !== null) {
        clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    // Re-arm mountedRef so connect() doesn't exit early after the previous
    // cleanup set it false on a projectId/token change.
    mountedRef.current = true;

    if (!projectId || !accessToken) return;

    let ws: WebSocket | null = null;
    let backoffMs = 1_000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Coalesce a burst of invalidations into a single trailing refetch per query
    // key. High-frequency mutation events (task_*, dependency_*, cpm_complete,
    // bulk/reorder, assignment_*, sprint/rollup, board-activity) route through
    // here instead of invalidating immediately, so a sync batch of N row events
    // produces 1 refetch rather than N. Low-frequency, narrowly-scoped
    // invalidations (per-task comments, members, board config, project-level)
    // stay immediate — they are not part of a burst.
    function scheduleInvalidate(
      ...keys: Array<'tasks' | 'dependencies' | 'board-activity' | 'standup'>
    ) {
      for (const key of keys) pendingInvalidationsRef.current.add(key);
      if (invalidateTimerRef.current !== null) return;
      invalidateTimerRef.current = setTimeout(() => {
        invalidateTimerRef.current = null;
        const pending = pendingInvalidationsRef.current;
        pendingInvalidationsRef.current = new Set();
        for (const key of pending) {
          void queryClient.invalidateQueries({ queryKey: [key, projectIdRef.current] });
        }
      }, TASKS_INVALIDATE_DEBOUNCE_MS);
    }

    function handleMessage(event: MessageEvent<string>) {
      let envelope: WsEnvelope;
      try {
        envelope = JSON.parse(event.data) as WsEnvelope;
      } catch {
        return;
      }

      const { event_type, payload } = envelope;

      // --- Task run progress events ---
      if (event_type === 'task_run_started') {
        const taskRunId = payload.task_run_id as string;
        const taskName = payload.task_name as string;
        const pid = (payload.project_id as string | null) ?? null;
        addRun({ taskRunId, taskName, projectId: pid, pct: 0, msg: '', status: 'running' });
        // Scheduling integration: signal CPM is running.
        if (taskName === 'scheduling.recalculate') {
          setRecalculating(true);
        }
      } else if (event_type === 'task_run_progress') {
        const taskRunId = payload.task_run_id as string;
        const pct = typeof payload.pct === 'number' ? payload.pct : 0;
        const msg = typeof payload.msg === 'string' ? payload.msg : '';
        updateProgress(taskRunId, pct, msg);
      } else if (event_type === 'task_run_completed') {
        const taskRunId = payload.task_run_id as string;
        const resultSummary = (payload.result_summary as Record<string, unknown> | null) ?? null;
        completeRun(taskRunId, resultSummary);
        // task_run_completed from the scheduler carries result_summary with project_finish.
        // cpm_complete is still also broadcast for compatibility; this handles the task_run path.
        if (resultSummary && typeof resultSummary.project_finish === 'string') {
          setCpmComplete(resultSummary.project_finish);
          // Task-date freshness is owned by the task_dates_updated delta event
          // (ADR-0091) — we no longer invalidate the tasks query here. We still
          // refresh the project-finish pill and the shell health stats.
          void queryClient.invalidateQueries({ queryKey: ['shellStats', projectIdRef.current] });
        }
      } else if (event_type === 'task_run_failed') {
        const taskRunId = payload.task_run_id as string;
        const errorDetail = typeof payload.error_detail === 'string' ? payload.error_detail : '';
        failRun(taskRunId, errorDetail);
        // Scheduling integration: if this was the CPM task, set error state.
        const run = useTaskRunStore.getState().runs[taskRunId];
        if (run?.taskName === 'scheduling.recalculate') {
          setCpmError({ error: 'internal_error', cycle: [] } as CpmError);
        }
      } else if (event_type === 'task_run_cancelled') {
        const taskRunId = payload.task_run_id as string;
        cancelRun(taskRunId);
      }

      // --- Presence events ---
      else if (event_type === 'presence_join') {
        const userId = payload.user_id as string;
        const displayName = (payload.display_name as string | undefined) ?? userId;
        addPresenceUser({ user_id: userId, display_name: displayName });
      } else if (event_type === 'presence_leave') {
        removePresenceUser(payload.user_id as string);
      }

      // --- CPM error (timeout / hard failure) ---
      else if (event_type === 'cpm_error') {
        setCpmError({
          error: (payload.error as string | undefined) ?? 'timeout',
          cycle: [],
        } as CpmError);
        setRecalculating(false);
      }

      // --- Legacy CPM compat broadcast ---
      else if (event_type === 'cpm_complete') {
        // cpm_complete is still emitted by the scheduler for any client that hasn't
        // migrated to task_run_completed. Handle it here so nothing breaks during
        // the transition period.
        const projectFinish =
          typeof payload.project_finish === 'string'
            ? payload.project_finish
            : new Date().toISOString();
        setCpmComplete(projectFinish);
        // The tasks cache is maintained by task_dates_updated (ADR-0091); the
        // coarse compat event no longer invalidates it. Pill + stats only.
        void queryClient.invalidateQueries({ queryKey: ['shellStats', projectIdRef.current] });
      }

      // --- Per-task CPM date deltas (ADR-0091) ---
      else if (event_type === 'task_dates_updated') {
        // Batched per-task CPM deltas, broadcast at the end of recalculate_schedule.
        // This handler is the sole maintainer of CPM freshness in the tasks cache:
        // it splices the moved tasks in place so a collaborator's bars slide
        // instantly, with no full re-fetch. The coarse task_run_completed /
        // cpm_complete events above intentionally no longer invalidate tasks.
        if (payload.truncated === true) {
          // Too many tasks moved to ship economically — fall back to a re-fetch.
          scheduleInvalidate('tasks');
        } else if (Array.isArray(payload.tasks)) {
          const deltas = payload.tasks as unknown as TaskDatesDelta[];
          if (deltas.length > 0) {
            const byId = new Map(deltas.map((d) => [d.id, d]));
            queryClient.setQueryData<Task[]>(['tasks', projectIdRef.current], (old) =>
              old?.map((t) => {
                const delta = byId.get(t.id);
                return delta ? applyTaskDatesDelta(t, delta) : t;
              }),
            );
          }
        }
      }

      // --- Mutation events ---
      else if (event_type === 'task_updated') {
        // ADR-0152 (#327): the enriched task_updated delta lets us avoid two
        // wasteful refetches.
        //  1. Self-echo: the originating client already applied its optimistic
        //     update; re-fetching here would clobber an in-flight edit and flicker.
        //  2. Duplicate/replayed events: ignore a version we've already observed
        //     for this task.
        // Either way the values themselves are role-gated (ADR-0104), so a genuine
        // remote change still goes through the coalesced list invalidate, which
        // re-reads via the serializer and keeps gating intact.
        const taskId = typeof payload.id === 'string' ? payload.id : null;
        const actorId = typeof payload.actor_id === 'string' ? payload.actor_id : null;
        const version = typeof payload.version === 'number' ? payload.version : null;
        const currentUserId =
          queryClient.getQueryData<{ id: string }>(['current-user'])?.id ?? null;

        const isSelfEcho = actorId !== null && actorId === currentUserId;
        let isDuplicate = false;
        if (taskId !== null && version !== null) {
          const seen = seenTaskVersionsRef.current.get(taskId);
          if (seen !== undefined && version <= seen) {
            isDuplicate = true;
          } else {
            seenTaskVersionsRef.current.set(taskId, version);
          }
        }

        if (!isSelfEcho && !isDuplicate) {
          scheduleInvalidate('tasks');
        }
        // The board activity feed is an append-only audit log, so it refetches
        // even for the originating client's own edit (you want your action to land
        // in the feed) — only a true duplicate/replay at an already-seen version is
        // skipped. No-op while the panel is closed: an inactive infinite query is
        // marked stale, not refetched, until the panel remounts (ADR-0160 B1, issue 1264).
        if (!isDuplicate) {
          // The standup walk's done/in-progress/blocker buckets are derived from the
          // same card state, so a status/assignee/blocker move refetches it too
          // (inactive → marked stale while standup mode is closed; ADR-0166).
          scheduleInvalidate('board-activity', 'standup');
        }
      } else if (event_type === 'task_created' || event_type === 'task_deleted') {
        scheduleInvalidate('tasks', 'board-activity', 'standup');
      } else if (
        event_type === 'dependency_created' ||
        event_type === 'dependency_updated' ||
        event_type === 'dependency_deleted'
      ) {
        // Collaborators see new/edited dependency edges shortly after the event
        // rather than waiting for the next fallback poll. The follow-up
        // cpm_complete event refreshes computed dates; the edge itself becomes
        // visible on the next coalesced flush.
        scheduleInvalidate('dependencies', 'tasks');
      } else if (
        event_type === 'baseline_created' ||
        event_type === 'baseline_activated' ||
        event_type === 'baseline_deleted'
      ) {
        void queryClient.invalidateQueries({ queryKey: ['baselines', projectIdRef.current] });
        // Active baseline change affects the task overlay annotation.
        if (event_type === 'baseline_activated' || event_type === 'baseline_deleted') {
          scheduleInvalidate('tasks');
        }
      }

      // --- Bulk task mutations (reorder, indent/outdent, bulk ops) ---
      else if (
        event_type === 'tasks_reordered' ||
        event_type === 'tasks_restructured' ||
        event_type === 'tasks_bulk_mutated' ||
        event_type === 'phases_reordered'
      ) {
        scheduleInvalidate('tasks');
      }

      // --- Product-backlog priority_rank change (ADR-0105 auto-rank / ADR-0110 reorder) ---
      else if (event_type === 'backlog_reranked') {
        // A collaborator reordered or auto-ranked the backlog. Refresh the grooming view
        // and the tasks cache (the board/schedule may order by priority_rank).
        void queryClient.invalidateQueries({
          queryKey: ['product-backlog', projectIdRef.current],
        });
        scheduleInvalidate('tasks');
      }

      // --- Risk events ---
      // `risks_imported` is the single batched event from a CSV import (issue 223) —
      // one refetch covers the whole batch rather than one per created risk.
      else if (
        event_type === 'risk_created' ||
        event_type === 'risk_updated' ||
        event_type === 'risk_deleted' ||
        event_type === 'risks_imported'
      ) {
        void queryClient.invalidateQueries({ queryKey: ['risks', projectIdRef.current] });
      }

      // --- Risk comment events ---
      else if (event_type === 'comment_created') {
        void queryClient.invalidateQueries({ queryKey: ['riskComments', projectIdRef.current] });
      }

      // --- Task collaboration events (ADR-0075) ---
      // Disambiguated from risk comments with the `task_` prefix so peers see
      // task-thread updates without falsely invalidating the riskComments cache.
      // Reactions (#837) and acknowledgements render inline on the comment, so
      // they refetch the same task-comments cache. The ack ping is body-less
      // (no acker identity) — the gated ack list is refetched via REST.
      else if (
        event_type === 'task_comment_created' ||
        event_type === 'task_comment_updated' ||
        event_type === 'task_comment_deleted' ||
        event_type === 'task_comment_reaction_added' ||
        event_type === 'task_comment_reaction_removed' ||
        event_type === 'task_comment_ack_changed'
      ) {
        const taskId = payload?.task_id;
        if (typeof taskId === 'string') {
          void queryClient.invalidateQueries({ queryKey: ['task-comments', taskId] });
        }
        // Only a brand-new comment is a `comment_added` row in the board activity
        // feed; edits/deletes/reactions/acks don't add feed rows (ADR-0160 B1, issue 1264).
        if (event_type === 'task_comment_created') {
          scheduleInvalidate('board-activity');
        }
      } else if (
        event_type === 'task_attachment_created' ||
        event_type === 'task_attachment_deleted'
      ) {
        const taskId = payload?.task_id;
        if (typeof taskId === 'string') {
          void queryClient.invalidateQueries({ queryKey: ['task-attachments', taskId] });
        }
      }

      // --- Task note events (ADR-0143, issue 740; decision toggle ADR-0167, issue 748) ---
      // A note create/edit/pin/delete invalidates the per-task notes list AND the
      // task list/board (the `latest_note_at` freshness chip is annotated on the
      // task serializer, so peers' cards re-fetch to show the new timestamp). A
      // `task_note_decision_toggled` additionally invalidates the project Decisions
      // list so an open Decisions view reflects a peer's flag without a reload.
      else if (
        event_type === 'task_note_created' ||
        event_type === 'task_note_updated' ||
        event_type === 'task_note_deleted' ||
        event_type === 'task_note_pinned' ||
        event_type === 'task_note_decision_toggled'
      ) {
        const taskId = payload?.task_id;
        if (typeof taskId === 'string') {
          void queryClient.invalidateQueries({ queryKey: ['task-notes', taskId] });
        }
        void queryClient.invalidateQueries({ queryKey: ['tasks', projectIdRef.current] });
        if (event_type === 'task_note_decision_toggled') {
          void queryClient.invalidateQueries({ queryKey: ['decisions', projectIdRef.current] });
        }
      }

      // --- Task external-link events (integrations) ---
      // The backend emits these on TaskLink create/refresh/delete; without a
      // handler peers keep a stale link list until reload.
      else if (
        event_type === 'task_link_created' ||
        event_type === 'task_link_updated' ||
        event_type === 'task_link_deleted'
      ) {
        const taskId = payload?.task_id;
        if (typeof taskId === 'string') {
          void queryClient.invalidateQueries({ queryKey: ['task-links', taskId] });
        }
      }

      // --- Retro action-item promotion ---
      // A promoted action item creates a TaskSuggestedAssignee; refresh the task
      // feed and the suggested user's My Work queue (same keys as
      // useSuggestionAction) so the suggestion surfaces for connected peers.
      else if (event_type === 'suggestion_created') {
        scheduleInvalidate('tasks');
        void queryClient.invalidateQueries({ queryKey: ['me', 'work'] });
      }

      // --- Project API token events ---
      // Key must match useApiTokens' tokensKey: ['api-tokens', scope.kind, id].
      else if (event_type === 'api_token_minted' || event_type === 'api_token_revoked') {
        void queryClient.invalidateQueries({
          queryKey: ['api-tokens', 'project', projectIdRef.current],
        });
      }

      // --- Project custom-field schema events ---
      else if (event_type === 'project_custom_fields_updated') {
        void queryClient.invalidateQueries({ queryKey: ['customFields', projectIdRef.current] });
      }

      // --- Sprint events ---
      else if (
        event_type === 'sprint_created' ||
        event_type === 'sprint_updated' ||
        event_type === 'sprint_deleted' ||
        event_type === 'sprint_activated' ||
        event_type === 'sprint_cancelled' ||
        event_type === 'sprint_closed'
      ) {
        void queryClient.invalidateQueries({ queryKey: ['sprints', projectIdRef.current] });
        // Sprint state changes drive milestone rollup recompute (ADR-0074);
        // refresh task data so the Gantt milestone reflects the new value
        // even if the milestone_rollup_updated event lands first.
        scheduleInvalidate('tasks');
        // A sprint's velocity contribution changes on these events — close adds
        // a data point, exclude_from_velocity (ADR-0113) drops one, activate /
        // cancel move committed scope — so a peer's velocity band and delivery
        // forecast must refetch live, matching the local mutation in useSprints.
        // Without this, collaborators see stale velocity/forecast until a manual
        // refetch.
        void queryClient.invalidateQueries({
          queryKey: ['project', projectIdRef.current, 'velocity'],
        });
        void queryClient.invalidateQueries({
          queryKey: ['project', projectIdRef.current, 'forecast'],
        });
      }

      // --- Live retro board events (ADR-0117 §4) ---
      // A peer created/edited/moved/deleted a sticky on the multi-writer retro
      // board. The board cache is keyed by sprint id, but the broadcast carries
      // the retro_id (the board is project-scoped, sprint-derived), so we
      // invalidate every open retro-board query rather than one key. Stale data
      // is the only failure mode of the best-effort channel; a blanket refetch
      // of the (at most one or two) open retro boards is cheap and reconciles
      // LWW collisions deterministically.
      else if (
        event_type === 'retro_item_created' ||
        event_type === 'retro_item_updated' ||
        event_type === 'retro_item_deleted' ||
        event_type === 'retro_item_moved'
      ) {
        void queryClient.invalidateQueries({
          predicate: (q) => q.queryKey[0] === 'sprint' && q.queryKey[2] === 'retro-board',
        });
      }

      // --- Scope-injection accept/reject events (ADR-0102) ---
      // A peer accepting/rejecting a pending injection (or rejecting on close)
      // flips task.sprint_pending and the sprint's pending_count. Without this
      // handler, other clients kept showing the stale "Pending acceptance" chip
      // and the "accepted scope only" forecast caveat until a manual refetch.
      else if (event_type === 'sprint_scope_changed') {
        // Accept/reject flips a task's sprint membership → an entered/exited_sprint
        // row in the board activity feed (ADR-0160 B1, issue 1264) and changes which
        // cards the standup walk groups (ADR-0166).
        scheduleInvalidate('tasks', 'board-activity', 'standup');
        void queryClient.invalidateQueries({ queryKey: ['sprints', projectIdRef.current] });
        // The accepted/rejected task's points enter or leave the committed-scope
        // line, so an open burndown for that sprint must refetch too — it is a
        // separate query key (['sprint', id, 'burndown']) from the sprint list.
        // The broadcast carries the sprint id; fall back to all burndown queries.
        const scopeSprintId = payload?.sprint_id;
        if (typeof scopeSprintId === 'string') {
          void queryClient.invalidateQueries({
            queryKey: ['sprint', scopeSprintId, 'burndown'],
          });
        } else {
          void queryClient.invalidateQueries({
            predicate: (q) => q.queryKey[0] === 'sprint' && q.queryKey[2] === 'burndown',
          });
        }
      }

      // --- Sprint Review curation events (ADR-0118 amend, #1130/#1131/#1132) ---
      // A peer reordered the demo list, set a presenter or contributor note, or
      // flagged a not-shipped story for the backlog. All four mutate the
      // consolidated Sprint Review read (['sprint', id, 'outcome']). demo_toggled
      // (#924) shares the same key and had no handler, so co-viewers' review
      // surfaces drifted until a manual refetch — fold it in here. The broadcast
      // carries sprint_id; fall back to every open outcome query when absent.
      // (flag-for-backlog also emits task_created, handled above, which refreshes
      // the task/backlog feed — so the new backlog item reaches peers too.)
      else if (
        event_type === 'demo_toggled' ||
        event_type === 'demo_reordered' ||
        event_type === 'demo_presenter_set' ||
        event_type === 'review_note_set' ||
        event_type === 'flagged_for_backlog'
      ) {
        const reviewSprintId = payload?.sprint_id;
        if (typeof reviewSprintId === 'string') {
          void queryClient.invalidateQueries({
            queryKey: ['sprint', reviewSprintId, 'outcome'],
          });
        } else {
          void queryClient.invalidateQueries({
            predicate: (q) => q.queryKey[0] === 'sprint' && q.queryKey[2] === 'outcome',
          });
        }
      }

      // --- Milestone rollup events (ADR-0074) ---
      else if (event_type === 'milestone_rollup_updated') {
        // Aggregated rollup payload arrives independent of the task feed.
        // Invalidate both tasks (Gantt + drawer) and sprints (the rollup
        // mirrors onto SprintTargetMilestone.rollup).
        scheduleInvalidate('tasks');
        void queryClient.invalidateQueries({ queryKey: ['sprints', projectIdRef.current] });
      }

      // --- Milestone forecast events (ADR-0106 §3.4, #1007) ---
      else if (event_type === 'milestone_forecast_updated') {
        // A sprint close or (re)bind reforecast a bound milestone and persisted a
        // new ForecastSnapshot. The per-milestone snapshot is served by the
        // project forecast read, and the promote dialog's live preview shares the
        // same CPM spine — refresh both (plus the slim milestone list, whose
        // early_finish may have shifted) so a peer viewing the forecast or promote
        // surfaces on another tab sees the new range without reloading. The
        // forecast read is project-scoped, so the payload's milestone_id is not
        // needed to target it.
        void queryClient.invalidateQueries({
          queryKey: ['project', projectIdRef.current, 'forecast'],
        });
        void queryClient.invalidateQueries({
          queryKey: ['project-milestones', projectIdRef.current],
        });
        void queryClient.invalidateQueries({
          predicate: (q) => q.queryKey[0] === 'reforecast-preview',
        });
      }

      // --- Resource assignment events ---
      else if (
        event_type === 'assignment_created' ||
        event_type === 'assignment_updated' ||
        event_type === 'assignment_deleted' ||
        event_type === 'roster_changed'
      ) {
        // Assignments are surfaced on task rows (assignee chips, overalloc flag).
        scheduleInvalidate('tasks');
      }

      // --- Membership events ---
      else if (
        event_type === 'member_added' ||
        event_type === 'member_role_changed' ||
        event_type === 'member_removed'
      ) {
        void queryClient.invalidateQueries({ queryKey: ['members', projectIdRef.current] });
      }

      // --- Team facet / role events (ADR-0078) ---
      // A peer flipping a Scrum Master / Product Owner facet or a team role on
      // the Project Settings → Team tab broadcasts team_member_changed. A facet
      // reassign is a soft-singleton, so the prior holder's row changed too; the
      // payload carries team_id (not project_id), so invalidate that team's
      // whole roster and let a second admin viewing the same tab see it live.
      else if (event_type === 'team_member_changed') {
        const teamId = payload?.team_id;
        if (typeof teamId === 'string') {
          void queryClient.invalidateQueries({ queryKey: ['team-members', teamId] });
        }
      }

      // --- Board config and saved-view events ---
      else if (event_type === 'board_config_updated') {
        void queryClient.invalidateQueries({ queryKey: ['boardConfig', projectIdRef.current] });
      } else if (
        event_type === 'board_view_created' ||
        event_type === 'board_view_updated' ||
        event_type === 'board_view_deleted'
      ) {
        void queryClient.invalidateQueries({ queryKey: ['boardViews', projectIdRef.current] });
      }

      // --- Project-level events ---
      // The backend emits archive/unarchive/transfer/hard-delete lifecycle
      // events, but the client had no handler — a user watching a project that
      // was archived or transferred under them saw no update until a refetch.
      else if (
        event_type === 'project_created' ||
        event_type === 'project_updated' ||
        event_type === 'project_deleted' ||
        event_type === 'project_hard_deleted' ||
        event_type === 'project_archived' ||
        event_type === 'project_unarchived' ||
        event_type === 'project_transferred'
      ) {
        void queryClient.invalidateQueries({ queryKey: ['project', projectIdRef.current] });
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
      }
    }

    function scheduleReconnect() {
      retryTimer = setTimeout(() => {
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        connect();
      }, backoffMs);
    }

    function connect() {
      if (!mountedRef.current) return;

      const pid = projectIdRef.current;
      const token = tokenRef.current;
      if (!pid || !token) return;

      // Mint a single-use ticket, then open the socket with ?ticket= (ADR-0141)
      // so no JWT ever appears in a WebSocket URL / access log. Tickets are
      // single-use, so this runs on every (re)connect.
      void fetchWsTicket()
        .then((ticket) => {
          // The component may have unmounted, or projectId changed, during the
          // ticket round-trip — bail rather than open a stale socket.
          if (!mountedRef.current || projectIdRef.current !== pid) return;
          openSocket(pid, ticket);
        })
        .catch(() => {
          if (!mountedRef.current) return;
          // A failed mint usually means the session expired (apiClient already
          // ran refresh-and-retry). Treat it like the 4001 auth-reject close so
          // we don't retry into a void; otherwise back off and try again.
          if (useAuthStore.getState().sessionExpired) {
            useWsConnectionStore.getState().markFailed();
            return;
          }
          useWsConnectionStore.getState().markDisconnected();
          scheduleReconnect();
        });
    }

    function openSocket(pid: string, ticket: string) {
      const url = `${WS_BASE}/ws/v1/projects/${pid}/?ticket=${encodeURIComponent(ticket)}`;
      ws = new WebSocket(url);

      ws.addEventListener('message', handleMessage);

      ws.addEventListener('close', (event) => {
        if (!mountedRef.current) return;
        // Server-side auth rejection (Channels closes with 4001 when the
        // token in the connect URL is invalid/expired). Without this branch
        // the socket would silently retry forever while the cache stayed
        // alive and the user kept editing into a void (#352).
        if (event.code === 4001) {
          useWsConnectionStore.getState().markFailed();
          useAuthStore.getState().markSessionExpired();
          window.dispatchEvent(new CustomEvent('auth:sessionExpired'));
          return;
        }
        // Retryable close (network drop, server restart, idle timeout):
        // escalate the connection state (reconnecting → stale after a few
        // attempts) and schedule an exponential-backoff reconnect.
        useWsConnectionStore.getState().markDisconnected();
        scheduleReconnect();
      });

      ws.addEventListener('open', () => {
        backoffMs = 1_000; // reset on successful connection
        useWsConnectionStore.getState().markLive();
      });
    }

    // Initial handshake. Retries are driven from the close handler and must not
    // reset the connection state back to `connecting`.
    useWsConnectionStore.getState().markConnecting();
    connect();

    return () => {
      mountedRef.current = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      // Drop any pending coalesced invalidation — the project/token changed, so
      // the new effect run will refetch the correct project's caches on its own.
      if (invalidateTimerRef.current !== null) {
        clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = null;
        pendingInvalidationsRef.current = new Set();
      }
      if (ws) {
        ws.removeEventListener('message', handleMessage);
        ws.close();
      }
      // Reset to idle so a stale `live`/`failed` does not linger after leaving
      // the project (StatusBar also gates the pill on projectId).
      useWsConnectionStore.getState().markConnecting();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, accessToken]);
}
