import type { CSSProperties } from 'react';
import { NavLink, useLocation, useParams } from 'react-router';
import type { Project, HealthState } from '@/types';

const HEALTH_LABELS: Record<HealthState, string> = {
  'on-track': 'On track',
  'at-risk': 'At risk',
  critical: 'Critical',
  unknown: 'Unknown',
};

// 7px health dot. Known states fill with the semantic color + a 2px halo at 20%
// alpha (#200). Unknown renders as a hollow ring instead of a filled gray dot —
// the cleanup that removes the "Unknown" text noise (#959, Direction C): an empty
// state reads as "no signal yet" without a word repeated on every row.
// CSS custom properties resolve at paint time so dark-mode color flips are free.
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
    backgroundColor: 'transparent',
    border: '1.5px solid rgb(var(--neutral-text-disabled))',
  },
};

interface Props {
  project: Project;
  collapsed: boolean;
}

/**
 * A single one-line project row in the sidebar (#959, Direction C): a health
 * dot + the project name. The owning program is no longer shown per-row — in
 * "All programs" scope projects are grouped under their program header, and in
 * a scoped view the program is implied by the scope, so a per-row tag is
 * redundant. (Per-project open-task count is deferred to #960.)
 */
export function ProjectListItem({ project, collapsed }: Props) {
  // Determine active project from URL path param (ADR-0030).
  const { projectId: currentProjectId } = useParams<{ projectId: string }>();
  const isThisProject = currentProjectId === project.id;
  const location = useLocation();

  // Preserve the active tab when switching projects (#160).
  // Extract the path suffix after the current project segment (e.g. "/schedule", "/resources/roster").
  // Fall back to "/board" (canonical planning surface) when not inside a project route.
  const viewSuffix = currentProjectId
    ? location.pathname.replace(`/projects/${currentProjectId}`, '') || '/board'
    : '/board';

  // Health is conveyed in the accessible name because the dot is decorative
  // (rule 6) and the row no longer renders a visible health text label.
  const healthSuffix =
    project.healthState === 'unknown' ? '' : ` — ${HEALTH_LABELS[project.healthState]}`;

  return (
    <li>
      <NavLink
        to={`/projects/${project.id}${viewSuffix}`}
        title={collapsed ? project.name : undefined}
        className={() =>
          [
            'flex items-center gap-2 px-3 rounded text-sm transition-colors',
            collapsed ? 'py-2' : 'min-h-8 py-1.5',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
            // Active: fill + 2px left border (rule 37 — border is primary non-color signal)
            isThisProject
              ? 'bg-brand-primary/10 border-l-2 border-brand-primary'
              : 'hover:bg-neutral-text-primary/5 border-l-2 border-transparent',
          ].join(' ')
        }
        aria-label={`${project.name}${healthSuffix}`}
        aria-current={isThisProject ? 'page' : undefined}
      >
        {/* 7px health dot — color (or hollow ring) encodes health state (#200/#959).
            aria-hidden; state is conveyed by the row aria-label. */}
        <span
          className="rounded-full flex-shrink-0 box-border"
          style={{ width: '7px', height: '7px', ...HEALTH_DOT_STYLE[project.healthState] }}
          aria-hidden="true"
        />
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate text-chrome-text-primary">{project.name}</span>
        )}
      </NavLink>
    </li>
  );
}
