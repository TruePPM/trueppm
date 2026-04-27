import type { CSSProperties } from 'react';
import { NavLink, useLocation, useParams } from 'react-router';
import type { Project, HealthState } from '@/types';

const HEALTH_LABELS: Record<HealthState, string> = {
  'on-track': 'On track',
  'at-risk': 'At risk',
  critical: 'Critical',
  unknown: 'Unknown',
};

const HEALTH_COLORS: Record<HealthState, string> = {
  'on-track': 'text-semantic-on-track',
  'at-risk': 'text-semantic-at-risk',
  critical: 'text-semantic-critical',
  unknown: 'text-neutral-text-disabled',
};

// 7px health dot with 2px halo at 20% alpha — design spec (#200).
// CSS custom properties in boxShadow resolve at paint time, so dark-mode
// semantic color flips are picked up automatically.
const HEALTH_DOT_STYLE: Record<HealthState, CSSProperties> = {
  'on-track': {
    backgroundColor: 'rgb(var(--semantic-on-track))',
    boxShadow: '0 0 0 2px rgb(var(--semantic-on-track) / 0.20)',
  },
  'at-risk': {
    backgroundColor: 'rgb(var(--semantic-at-risk))',
    boxShadow: '0 0 0 2px rgb(var(--semantic-at-risk) / 0.20)',
  },
  critical: {
    backgroundColor: 'rgb(var(--semantic-critical))',
    boxShadow: '0 0 0 2px rgb(var(--semantic-critical) / 0.20)',
  },
  unknown: {
    backgroundColor: 'rgb(var(--neutral-text-disabled))',
  },
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
  // Fall back to "/board" (canonical planning surface) when not inside a project route.
  const viewSuffix = currentProjectId
    ? (location.pathname.replace(`/projects/${currentProjectId}`, '') || '/board')
    : '/board';

  return (
    <li>
      <NavLink
        to={`/projects/${project.id}${viewSuffix}`}
        title={collapsed ? project.name : undefined}
        className={() =>
          [
            'flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
            // Active: fill + 2px left border (rule 37 — border is primary non-color signal)
            isThisProject
              ? 'bg-brand-primary/10 border-l-2 border-brand-primary'
              : 'hover:bg-neutral-text-primary/5 border-l-2 border-transparent',
          ].join(' ')
        }
        aria-label={collapsed ? `${project.name} — ${HEALTH_LABELS[project.healthState]}` : undefined}
        aria-current={isThisProject ? 'page' : undefined}
      >
        {/* 7px health dot with 2px halo — color encodes health state (#200).
            aria-hidden; state is conveyed by label text below or aria-label. */}
        <span
          className="rounded-full flex-shrink-0"
          style={{ width: '7px', height: '7px', ...HEALTH_DOT_STYLE[project.healthState] }}
          aria-hidden="true"
        />
        {!collapsed && (
          <span className="flex-1 truncate">
            <span className="text-chrome-text-primary">{project.name}</span>
            <span className={`block text-xs ${HEALTH_COLORS[project.healthState]}`}>
              {HEALTH_LABELS[project.healthState]}
            </span>
          </span>
        )}
      </NavLink>
    </li>
  );
}
