/**
 * Single-select project picker used by the pull flow (desktop pane + mobile
 * sheet). A real radiogroup: ↑/↓ move the selection, clicking a row selects it,
 * and the whole row is the target. `tall` bumps the row height for touch.
 */

import { useRef, type KeyboardEvent } from 'react';
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
  // Roving-tabindex: arrow keys must move DOM focus onto the newly-selected
  // radio, not merely flip `aria-checked`/`tabIndex` — otherwise the next Tab
  // escapes the group (web-rule 167, WCAG 2.1.1). We hold a ref per option and
  // focus it on arrow nav; arrow = focus move + select, never a side effect
  // beyond selection.
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function moveTo(nextIndex: number) {
    const next = projects[nextIndex];
    if (!next) return;
    onChange(next.id);
    btnRefs.current[nextIndex]?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const index = projects.findIndex((p) => p.id === value);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveTo(index < 0 ? 0 : Math.min(index + 1, projects.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveTo(index < 0 ? 0 : Math.max(index - 1, 0));
    } else if (e.key === 'Enter' && value) {
      e.preventDefault();
      onSubmit?.();
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Target project"
      className="overflow-hidden rounded-card border border-neutral-border"
    >
      {projects.map((project, index) => {
        const selected = project.id === value;
        return (
          <button
            key={project.id}
            ref={(el) => {
              btnRefs.current[index] = el;
            }}
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
                <span className="tppm-mono block text-xs text-neutral-text-secondary">
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
