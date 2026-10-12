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
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { fetchWsTicket } from '@/api/wsTicket';
import { WS_CLOSE_FORBIDDEN, WS_CLOSE_UNAUTHENTICATED } from '@/stores/wsConnectionStore';

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
  // #3770: the aggregated form POST /tasks/bulk/ emits for a batch of applied
  // edges — never a per-edge dependency_created for a bulk request.
  'dependencies_bulk_created',
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
  /** True once this project's socket refused the caller (4003) on this page. */
  isRefused: (projectId: string) => boolean;
  /** Record a 4003 so no later effect run (e.g. a token refresh) re-dials it. */
  onRefused: (projectId: string) => void;
}

/** One socket to a single member project's channel; invalidates the program schedule. */
function MemberProjectScheduleChannel({
  programId,
  projectId,
  isRefused,
  onRefused,
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
    // A 4001 since the last socket that delivered a frame — see the close handler.
    let authRejected = false;

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
      // Only a socket that actually delivered a frame earns back the 4001 re-mint
      // allowance: a refusal is accept-then-close (#4375), so `open` fires for a
      // refused socket too, and resetting there would re-mint forever.
      ws.addEventListener(
        'message',
        () => {
          authRejected = false;
        },
        { once: true },
      );
      ws.addEventListener('open', () => {
        backoffMs = 1_000;
      });
      ws.addEventListener('close', (closeEvent) => {
        if (!mountedRef.current) return;
        // 4003: the caller's role on THIS member project does not get live
        // updates (a Viewer, or not a member). Terminal — every retry is refused
        // again, so stop rather than re-minting a ticket on a 30 s backoff for as
        // long as the page is open (#4375). The program schedule query still
        // refreshes from the other member projects' channels and on remount.
        if (closeEvent.code === WS_CLOSE_FORBIDDEN) {
          onRefused(projectId);
          return;
        }
        // 4001: the ticket did not resolve. The first one re-mints once — a ticket
        // lives 30 s and is single-use, so an aged ticket is not an expired session.
        // A second in a row is a real auth failure: stop, and let the apiClient
        // refresh path (and the project socket) drive re-auth.
        if (closeEvent.code === WS_CLOSE_UNAUTHENTICATED) {
          if (authRejected) return;
          authRejected = true;
          connect();
          return;
        }
        scheduleReconnect();
      });
    };

    const connect = () => {
      if (!mountedRef.current || !accessToken) return;
      // A refusal outlives this effect: the effect re-runs on every access-token
      // refresh (~15 min), and without this guard each run would re-mint a ticket
      // and re-handshake a project that already said no (#4375).
      if (isRefused(projectId)) return;
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
  }, [programId, projectId, accessToken, queryClient, isRefused, onRefused]);

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
  const queryClient = useQueryClient();
  // Projects whose socket refused this caller (4003) during this page's life. Held
  // here, above the per-project channels, so it survives both a channel's effect
  // re-run and a channel remount when the lane list changes (#4375).
  const refusedRef = useRef<Set<string>>(new Set());
  const isRefused = useCallback((projectId: string) => refusedRef.current.has(projectId), []);
  const onRefused = useCallback(
    (projectId: string) => {
      refusedRef.current.add(projectId);
      // Re-read the lanes: a member demoted or removed mid-session comes back with
      // `can_subscribe_live: false`, and the page then stops mounting the channel.
      void queryClient.invalidateQueries({ queryKey: ['programs', programId, 'schedule'] });
    },
    [queryClient, programId],
  );
  return (
    <>
      {projectIds.map((projectId) => (
        <MemberProjectScheduleChannel
          key={projectId}
          programId={programId}
          projectId={projectId}
          isRefused={isRefused}
          onRefused={onRefused}
        />
      ))}
    </>
  );
}
