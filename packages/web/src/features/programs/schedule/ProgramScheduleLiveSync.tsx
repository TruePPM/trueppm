/**
 * Live updates for the program schedule view (ADR-0182, ADR-0091).
 *
 * There is no program-level WebSocket channel in 0.3, so the program schedule
 * view subscribes to **each member project's** existing channel group and
 * refetches the compute-on-read `GET /programs/{id}/schedule/` whenever a
 * schedule-affecting event arrives. The merged program-true CPM is recomputed
 * on the server on read, so any per-project task/dependency/CPM change can move
 * the cross-project critical path.
 *
 * Why a purpose-built socket instead of {@link useProjectWebSocket}: that hook
 * writes the shared scheduler/task-run/presence stores, which drive the global
 * TaskRunIndicator and presence UI. Mounting it once per member project would
 * surface a spurious "tasks running" indicator on the program page from another
 * project's recalc. This subscriber touches no global store — it only invalidates
 * the program-schedule query — so the program page stays side-effect free.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { fetchWsTicket } from '@/api/wsTicket';

const WS_BASE = (() => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
})();

const MAX_BACKOFF_MS = 30_000;
const INVALIDATE_DEBOUNCE_MS = 300;

/**
 * WebSocket event types that can change the merged program schedule. Anything
 * touching a task's dates/structure, a dependency, a sprint window, or a member
 * project's lifecycle is included; collaboration noise (comments, reactions,
 * presence) is deliberately excluded so the program schedule only refetches when
 * the chart can actually change.
 */
const SCHEDULE_AFFECTING_EVENTS: ReadonlySet<string> = new Set([
  'task_dates_updated',
  'cpm_complete',
  'task_run_completed',
  'task_created',
  'task_updated',
  'task_deleted',
  'tasks_reordered',
  'tasks_restructured',
  'tasks_bulk_mutated',
  'phases_reordered',
  'dependency_created',
  'dependency_updated',
  'dependency_deleted',
  'sprint_created',
  'sprint_updated',
  'sprint_deleted',
  'sprint_activated',
  'sprint_cancelled',
  'sprint_closed',
  'sprint_scope_changed',
  'milestone_rollup_updated',
  'milestone_forecast_updated',
  'project_updated',
  'project_archived',
  'project_unarchived',
  'project_deleted',
]);

interface MemberProjectScheduleChannelProps {
  programId: string;
  projectId: string;
}

/** One socket to a single member project's channel; invalidates the program schedule. */
function MemberProjectScheduleChannel({
  programId,
  projectId,
}: MemberProjectScheduleChannelProps) {
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((s) => s.accessToken);
  const mountedRef = useRef(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    if (!accessToken) return;

    let ws: WebSocket | null = null;
    let backoffMs = 1_000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleInvalidate = () => {
      if (debounceRef.current !== null) return;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void queryClient.invalidateQueries({ queryKey: ['programs', programId, 'schedule'] });
      }, INVALIDATE_DEBOUNCE_MS);
    };

    const handleMessage = (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as { event_type?: string };
        if (envelope.event_type && SCHEDULE_AFFECTING_EVENTS.has(envelope.event_type)) {
          scheduleInvalidate();
        }
      } catch {
        // Ignore malformed frames.
      }
    };

    const scheduleReconnect = () => {
      retryTimer = setTimeout(() => {
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        connect();
      }, backoffMs);
    };

    const openSocket = (ticket: string) => {
      const url = `${WS_BASE}/ws/v1/projects/${projectId}/?ticket=${encodeURIComponent(ticket)}`;
      ws = new WebSocket(url);
      ws.addEventListener('message', handleMessage);
      ws.addEventListener('open', () => {
        backoffMs = 1_000;
      });
      ws.addEventListener('close', (closeEvent) => {
        if (!mountedRef.current) return;
        // 4001 = Channels auth reject (expired/invalid ticket). Don't retry into
        // a void — the apiClient refresh path drives re-auth; bail like the
        // project socket does.
        if (closeEvent.code === 4001) return;
        scheduleReconnect();
      });
    };

    const connect = () => {
      if (!mountedRef.current || !accessToken) return;
      void fetchWsTicket()
        .then((ticket) => {
          if (!mountedRef.current) return;
          openSocket(ticket);
        })
        .catch(() => {
          if (!mountedRef.current) return;
          // A failed mint usually means the session expired; the project page's
          // own socket surfaces that. Back off and retry unless expired.
          if (useAuthStore.getState().sessionExpired) return;
          scheduleReconnect();
        });
    };

    connect();

    return () => {
      mountedRef.current = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (ws) {
        ws.removeEventListener('message', handleMessage);
        ws.close();
      }
    };
  }, [programId, projectId, accessToken, queryClient]);

  return null;
}

export interface ProgramScheduleLiveSyncProps {
  programId: string;
  /** Member project ids to subscribe to (one socket each). */
  projectIds: string[];
}

/**
 * Mounts one {@link MemberProjectScheduleChannel} per member project. Rendered
 * by the program schedule page; renders nothing. Each child's socket lifecycle
 * is keyed by project id, so a project added to / removed from the program
 * cleanly opens / closes its subscription.
 */
export function ProgramScheduleLiveSync({ programId, projectIds }: ProgramScheduleLiveSyncProps) {
  return (
    <>
      {projectIds.map((projectId) => (
        <MemberProjectScheduleChannel
          key={projectId}
          programId={programId}
          projectId={projectId}
        />
      ))}
    </>
  );
}
