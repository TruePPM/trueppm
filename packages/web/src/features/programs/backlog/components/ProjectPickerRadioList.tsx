/**
 * Single-select project picker used by the pull flow (desktop pane + mobile
 * sheet). A real radiogroup: ↑/↓ move the selection, clicking a row selects it,
 * and the whole row is the target. `tall` bumps the row height for touch.
 */

import type { KeyboardEvent } from 'react';
import type { MemberProject } from '../types';
import { FOCUS_RING } from './styles';

interface ProjectPickerRadioListProps {
  projects: MemberProject[];
  value: string | null;
  onChange: (projectId: string) => void;
  /** Submit (↵) handler so the picker can drive the form's primary action. */
  onSubmit?: () => void;
  tall?: boolean;
}

export function ProjectPickerRadioList({
  projects,
  value,
  onChange,
  onSubmit,
  tall = false,
}: ProjectPickerRadioListProps) {
  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const index = projects.findIndex((p) => p.id === value);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = projects[Math.min(index + 1, projects.length - 1)] ?? projects[0];
      if (next) onChange(next.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = projects[Math.max(index - 1, 0)] ?? projects[0];
      if (prev) onChange(prev.id);
    } else if (e.key === 'Enter' && value) {
      e.preventDefault();
      onSubmit?.();
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Target project"
      className="overflow-hidden rounded-md border border-neutral-border"
    >
      {projects.map((project, index) => {
        const selected = project.id === value;
        return (
          <button
            key={project.id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (value === null && index === 0) ? 0 : -1}
            onClick={() => onChange(project.id)}
            onKeyDown={handleKeyDown}
            className={`flex w-full items-center gap-3 px-3 text-left ${tall ? 'py-3' : 'py-2'}
              ${index > 0 ? 'border-t border-neutral-border' : ''}
              ${selected ? 'bg-brand-primary-light' : 'bg-neutral-surface hover:bg-neutral-surface-raised'}
              ${FOCUS_RING}`}
          >
            <span
              aria-hidden="true"
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                selected ? 'border-brand-primary' : 'border-neutral-border'
              }`}
            >
              {selected && <span className="h-2 w-2 rounded-full bg-brand-primary" />}
            </span>
            <span
              aria-hidden="true"
              className="h-6 w-1.5 shrink-0 rounded-full bg-neutral-border"
              style={project.color ? { backgroundColor: project.color } : undefined}
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-neutral-text-primary">
                {project.name}
              </span>
              {(project.code || project.backlogCount !== undefined) && (
                <span className="tppm-mono block text-[10px] text-neutral-text-secondary">
                  {project.code}
                  {project.code && project.backlogCount !== undefined ? ' · ' : ''}
                  {project.backlogCount !== undefined ? `${project.backlogCount} backlog` : ''}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
