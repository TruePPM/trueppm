import { useLocation } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjects } from '@/hooks/useProjects';
import { useProjectPresence } from '@/hooks/useProjectPresence';

declare const __BUILD_SHA__: string;

const VIEW_LABELS: Record<string, string> = {
  board:     'Board',
  gantt:     'Schedule',
  wbs:       'WBS',
  list:      'Table',
  calendar:  'Calendar',
  overview:  'Overview',
  resources: 'Team',
  risk:      'Risks',
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

  const project = projects?.find((p) => p.id === projectId);

  const pathSegments = location.pathname.split('/').filter(Boolean);
  const viewSlug = pathSegments[pathSegments.length - 1] ?? '';
  const viewLabel = VIEW_LABELS[viewSlug] ?? viewSlug;
  const statusNote = project ? `${project.name} · ${viewLabel}` : '';

  return (
    <footer
      role="contentinfo"
      aria-label="Application status"
      className="hidden md:flex items-center h-6 px-4 gap-4 text-[11px] text-neutral-text-secondary
        bg-neutral-surface-sunken border-t border-neutral-border overflow-hidden"
    >
      {/* Live presence indicator */}
      <span className="flex items-center gap-1.5">
        <span
          className="w-1.5 h-1.5 rounded-full bg-semantic-on-track flex-shrink-0"
          aria-hidden="true"
        />
        <span>Live · {onlineUsers.length} online</span>
      </span>

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
