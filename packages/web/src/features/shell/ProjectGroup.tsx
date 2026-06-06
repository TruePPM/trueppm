import type { Project } from '@/types';
import { ProjectListItem } from './ProjectListItem';

interface Props {
  /** Program name, or "No program" for the orphan group. */
  name: string;
  projects: Project[];
  collapsed: boolean;
  onToggle: () => void;
}

/**
 * A collapsible program group in the "All programs" sidebar scope (#959,
 * Direction C "grouped"). The header carries the program name + its project
 * count; the nested projects render as one-line rows indented under it. In a
 * single-program scope the sidebar renders a flat list instead, so this is only
 * used when scope is "All programs".
 */
export function ProjectGroup({ name, projects, collapsed, onToggle }: Props) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left
          text-chrome-text-secondary hover:bg-neutral-text-primary/5
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="shrink-0 transition-transform"
          style={{ transform: collapsed ? 'none' : 'rotate(90deg)' }}
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-chrome-text-primary">
          {name}
        </span>
        <span className="tppm-mono shrink-0 text-xs text-chrome-text-secondary">
          {projects.length}
        </span>
      </button>
      {!collapsed && (
        <ul className="ml-2 space-y-0.5 border-l border-chrome-border/10 pl-1.5">
          {projects.map((project) => (
            <ProjectListItem key={project.id} project={project} collapsed={false} />
          ))}
        </ul>
      )}
    </li>
  );
}
