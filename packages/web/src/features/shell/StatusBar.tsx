import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjectUnavailable } from '@/hooks/useProjectUnavailable';
import { useProjects } from '@/hooks/useProjects';
import { useProjectPresence } from '@/hooks/useProjectPresence';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';
import { useWsConnectionStore, type WsConnectionState } from '@/stores/wsConnectionStore';

declare const __BUILD_SHA__: string;

/**
 * Dot color, short label, and accessible/tooltip text for each connection
 * state. The dot color is never the sole signal — the label and `aria` text
 * always name the state (WCAG 1.4.1 / web rule 6). Only `reconnecting` animates,
 * and only under `motion-safe`. `live` appends the viewing count at render time.
 */
const CONNECTION_PRESENTATION: Record<
  WsConnectionState,
  { dot: string; label: string; aria: string; pulse?: boolean }
> = {
  connecting: {
    dot: 'bg-neutral-text-disabled',
    label: 'Connecting…',
    aria: 'Connecting to live updates…',
  },
  live: {
    dot: 'bg-semantic-on-track',
    label: 'Live',
    aria: 'Live — connected',
  },
  reconnecting: {
    dot: 'bg-semantic-at-risk',
    label: 'Reconnecting…',
    aria: 'Reconnecting to live updates…',
    pulse: true,
  },
  stale: {
    dot: 'bg-semantic-at-risk',
    label: 'Connection lost',
    aria: "Connection lost. Changes you make now won't be saved until the connection is restored.",
  },
  failed: {
    dot: 'bg-semantic-critical',
    label: 'Disconnected',
    aria: 'Disconnected — your session expired. Sign in again to reconnect.',
  },
};

/**
 * Global app-shell status bar — 24px, pinned to the bottom of every desktop
 * project view. Shows live presence, build provenance, and the active context.
 * Hidden on Login (no AppShell) and on viewports < 768px (bottom nav takes over).
 */
export function StatusBar() {
  const location = useLocation();
  const projectId = useProjectId() ?? null;
  // `ProjectShell` suppresses the project WebSocket on an unavailable project, so
  // the store never leaves `connecting` — and the pill reported "Connecting…" for
  // the rest of the session on a project the caller cannot open (#3469). There is
  // no channel to report on, so the pill's empty form is absence.
  const projectUnavailable = useProjectUnavailable(projectId);
  const { data: projects } = useProjects();
  const onlineUsers = useProjectPresence(projectId);
  const connectionState = useWsConnectionStore((s) => s.state);
  // Resolve the Sprints/Cycles label through the shared inheritance chokepoint
  // (ADR-0116, web rule 215b) so the bar shows the same iteration label as
  // ViewTabs/BottomNav even when it's inherited from the program or workspace.
  const sprintsLabel = useIterationLabel(projectId).plural;

  const project = projects?.find((p) => p.id === projectId);

  // Derive the active view from the segment immediately after the projectId —
  // identical to ViewTabs / BottomNav (ADR-0030). The last segment would misfire
  // on nested routes (e.g. /board/<cardId>), showing the raw card id instead of
  // "Board" (issue 1556).
  const pathSegments = location.pathname.split('/');
  const projectIdIndex = projectId ? pathSegments.indexOf(projectId) : -1;
  const viewSlug = (projectIdIndex >= 0 ? pathSegments[projectIdIndex + 1] : undefined) ?? '';
  // Derive the label from the SAME shared source ViewTabs/BottomNav read
  // (`VIEW_TAB_META`, web rule 215) so the three never drift; `sprints` takes the
  // inherited iteration label. Unknown segments fall back to the raw slug.
  const viewLabel =
    viewSlug === 'sprints' ? sprintsLabel : (VIEW_TAB_META[viewSlug]?.label ?? viewSlug);
  const statusNote = project ? `${project.name} · ${viewLabel}` : '';

  // The connection pill reflects the project WebSocket, which only runs inside
  // a project (ProjectShell). Off a project — or on one that is unavailable, where
  // ProjectShell deliberately holds the socket closed — there is no live channel
  // to report.
  const showConnection = Boolean(projectId) && !projectUnavailable;
  const conn = CONNECTION_PRESENTATION[connectionState];
  const isLive = connectionState === 'live';
  // "viewing" (not "online") so the count can't be misread as availability/load
  // by resource managers — it reports who has the project open, nothing more.
  const connLabel = isLive ? `Live · ${onlineUsers.length} viewing` : conn.label;
  const connAria = isLive
    ? `Live — connected, ${onlineUsers.length} viewing`
    : conn.aria;
  // Anonymity contract (#1560): presence is deliberately coarse — it names how
  // many people have the project open, never who is editing which task. Surfaced
  // as a native tooltip + an accessible description so the guarantee is visible
  // to sighted and screen-reader users alike.
  const presenceContract = "Shows who's online, never who's editing what.";

  // Announce genuine WebSocket state *transitions* through a persistent polite
  // region (#2203). The visible pill was a silent text/color swap — invisible
  // to SR users. Dedupe on state only (not presence-count churn) and skip the
  // initial mount so the app doesn't announce "Connecting…" on every load.
  const [connTransition, setConnTransition] = useState('');
  const prevConnRef = useRef<WsConnectionState | null>(null);
  useEffect(() => {
    if (!showConnection) {
      // Clear anything already announced. The socket runs for a moment before the
      // project detail read 404s, so a genuine transition can land and then outlive
      // the channel it described — leaving the bar's live region asserting a
      // connection state on a project that is not there (#3469). Resetting the
      // previous-state ref too means re-entering a real project announces from a
      // clean slate rather than diffing against a stale value.
      prevConnRef.current = null;
      setConnTransition('');
      return;
    }
    if (prevConnRef.current === null) {
      prevConnRef.current = connectionState;
      return;
    }
    if (prevConnRef.current === connectionState) return;
    prevConnRef.current = connectionState;
    setConnTransition(conn.aria);
  }, [connectionState, showConnection, conn.aria]);

  // The bar sits on the *raised* paper, not the sunken well: neutral-text-secondary
  // (#6B6965) is 4.63:1 on white / 5.16:1 on raised paper but only 4.35:1 on the
  // sunken surface (#EAE5D9) — a WCAG 1.4.3 fail for the chrome text (#1689).
  // Raising the surface keeps the quiet muted-text chrome look while clearing AA;
  // the recessed feel is still carried by the top border.
  //
  // The bar's type is `text-xs`, the rule-50 floor. It ran at `text-[11px]` under a
  // named gate carve-out until #3475 retired it: the exception bought one pixel of
  // chrome quietness and cost a WCAG 1.4.4 risk on the app's most persistent
  // surface. The bar keeps `h-6`: `text-xs` has a 16px line box, so 12px type sits
  // inside 24px with room to spare and no shell geometry moves.
  return (
    <footer
      role="contentinfo"
      aria-label="Application status"
      className="hidden md:flex items-center h-6 px-4 gap-4 text-xs text-neutral-text-secondary
        bg-neutral-surface-raised border-t border-neutral-border overflow-hidden"
    >
      {/* Persistent polite region for WS state transitions (#2203) — always
          mounted so the transition message lands in an existing live node. */}
      <span role="status" aria-live="polite" className="sr-only">
        {connTransition}
      </span>

      {/* Connection status indicator (#643) — project WebSocket only. The pill
          is NOT a live region: its aria-label carries the viewing count, which
          would announce on every presence change and double-speak transitions
          the persistent region above already handles (#2203). */}
      {showConnection && (
        <span
          className="flex items-center gap-1.5"
          aria-label={connAria}
          aria-describedby={isLive ? 'statusbar-presence-contract' : undefined}
          title={isLive ? `${connAria}. ${presenceContract}` : connAria}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${conn.dot}${
              conn.pulse ? ' motion-safe:animate-pulse' : ''
            }`}
            aria-hidden="true"
          />
          <span>{connLabel}</span>
          {isLive && (
            <span id="statusbar-presence-contract" className="sr-only">
              {presenceContract}
            </span>
          )}
        </span>
      )}

      {/* Build hash */}
      <span className="tppm-mono" aria-label={`Build ${__BUILD_SHA__}`}>
        build {__BUILD_SHA__}
      </span>

      <span className="flex-1" aria-hidden="true" />

      {/* Active project + view */}
      {statusNote && (
        <span className="tppm-mono truncate max-w-xs">{statusNote}</span>
      )}
    </footer>
  );
}
