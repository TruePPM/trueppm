import { useLocation } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjects } from '@/hooks/useProjects';
import { useProjectPresence } from '@/hooks/useProjectPresence';
import { useWsConnectionStore, type WsConnectionState } from '@/stores/wsConnectionStore';

declare const __BUILD_SHA__: string;

const VIEW_LABELS: Record<string, string> = {
  board:     'Board',
  schedule:  'Schedule',
  wbs:       'WBS',
  list:      'Table',
  calendar:  'Calendar',
  overview:  'Overview',
  resources: 'Team',
  risk:      'Risks',
};

/**
 * Dot color, short label, and accessible/tooltip text for each connection
 * state. The dot color is never the sole signal — the label and `aria` text
 * always name the state (WCAG 1.4.1 / web rule 6). Only `reconnecting` animates,
 * and only under `motion-safe`. `live` appends the online count at render time.
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
  const { data: projects } = useProjects();
  const onlineUsers = useProjectPresence(projectId);
  const connectionState = useWsConnectionStore((s) => s.state);

  const project = projects?.find((p) => p.id === projectId);

  const pathSegments = location.pathname.split('/').filter(Boolean);
  const viewSlug = pathSegments[pathSegments.length - 1] ?? '';
  const viewLabel = VIEW_LABELS[viewSlug] ?? viewSlug;
  const statusNote = project ? `${project.name} · ${viewLabel}` : '';

  // The connection pill reflects the project WebSocket, which only runs inside
  // a project (ProjectShell). Off a project there is no live channel to report.
  const conn = CONNECTION_PRESENTATION[connectionState];
  const connLabel =
    connectionState === 'live' ? `Live · ${onlineUsers.length} online` : conn.label;
  const connAria =
    connectionState === 'live'
      ? `Live — connected, ${onlineUsers.length} online`
      : conn.aria;

  return (
    <footer
      role="contentinfo"
      aria-label="Application status"
      className="hidden md:flex items-center h-6 px-4 gap-4 text-[11px] text-neutral-text-secondary
        bg-neutral-surface-sunken border-t border-neutral-border overflow-hidden"
    >
      {/* Connection status indicator (#643) — project WebSocket only */}
      {projectId && (
        <span className="flex items-center gap-1.5" aria-label={connAria} title={connAria}>
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${conn.dot}${
              conn.pulse ? ' motion-safe:animate-pulse' : ''
            }`}
            aria-hidden="true"
          />
          <span>{connLabel}</span>
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
