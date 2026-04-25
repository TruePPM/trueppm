import { NavLink, useLocation, useParams } from 'react-router';
import type { Project, HealthState } from '@/types';

const HEALTH_LABELS: Record<HealthState, string> = {
  'on-track': 'On track',
  'at-risk': 'At risk',
  critical: 'Critical',
  unknown: 'Unknown',
};

// Dark-surface variants required — standard semantic-* tokens fail WCAG 1.4.3
// on bg-gantt-surface (#0F1117). See rule 41.
const HEALTH_COLORS: Record<HealthState, string> = {
  'on-track': 'text-gantt-semantic-on-track',
  'at-risk': 'text-gantt-semantic-at-risk',
  critical: 'text-gantt-semantic-critical',
  unknown: 'text-neutral-text-disabled',
};

interface Props {
  project: Project;
  collapsed: boolean;
}

export function ProjectListItem({ project, collapsed }: Props) {
  // Determine active project from URL path param (ADR-0030).
  const { projectId: currentProjectId } = useParams<{ projectId: string }>();
  const isThisProject = currentProjectId === project.id;
  const location = useLocation();

  // Preserve the active tab when switching projects (#160).
  // Extract the path suffix after the current project segment (e.g. "/gantt", "/resources/roster").
  // Fall back to "/overview" when not currently inside a project route.
  const viewSuffix = currentProjectId
    ? (location.pathname.replace(`/projects/${currentProjectId}`, '') || '/overview')
    : '/overview';

  return (
    <li>
      <NavLink
        to={`/projects/${project.id}${viewSuffix}`}
        title={collapsed ? project.name : undefined}
        className={() =>
          [
            'flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-gantt-surface',
            // Active: fill + 2px left border (rule 37 — border is primary non-color signal)
            isThisProject ? 'bg-white/10 border-l-2 border-brand-primary' : 'hover:bg-white/5',
          ].join(' ')
        }
        aria-label={collapsed ? `${project.name} — ${HEALTH_LABELS[project.healthState]}` : undefined}
        aria-current={isThisProject ? 'page' : undefined}
      >
        {/* 8px color dot — aria-hidden; health conveyed via label or text below */}
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: project.colorDot }}
          aria-hidden="true"
        />
        {!collapsed && (
          <span className="flex-1 truncate">
            <span className="text-gantt-text-primary">{project.name}</span>
            <span className={`block text-xs ${HEALTH_COLORS[project.healthState]}`}>
              {HEALTH_LABELS[project.healthState]}
            </span>
          </span>
        )}
      </NavLink>
    </li>
  );
}
