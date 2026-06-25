/**
 * Inline pull-confirm pane (variation A — the v1 ship target; the popover
 * variation B is out of scope). Replaces the right pane: explainer → target
 * picker → "what will happen" preview → confirm. One project per pull
 * (ADR-0069). The actual mutation is optimistic and lives on the controller;
 * this component only collects the target and fires `onConfirm`.
 *
 * Esc cancels (handled here); ↵ in the picker submits.
 */

import { useEffect, useRef, useState } from 'react';
import { CloseIcon } from '@/components/Icons';
import type { BacklogItem, MemberProject } from '../types';
import { ProjectPickerRadioList } from './ProjectPickerRadioList';
import { BTN_GHOST, BTN_PRIMARY, FOCUS_RING } from './styles';

interface DetailPullConfirmProps {
  item: BacklogItem;
  projects: MemberProject[];
  onCancel: () => void;
  onConfirm: (project: MemberProject) => void;
  onAddProject: () => void;
}

export function DetailPullConfirm({
  item,
  projects,
  onCancel,
  onConfirm,
  onAddProject,
}: DetailPullConfirmProps) {
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const liveRef = useRef<HTMLParagraphElement>(null);

  // Announce entry to the pull flow for screen-reader users.
  useEffect(() => {
    if (liveRef.current) {
      liveRef.current.textContent = `Pulling ${item.title}. Choose a target project.`;
    }
  }, [item.title]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const selected = projects.find((p) => p.id === selectedId) ?? null;
  const hasProjects = projects.length > 0;

  function confirm() {
    if (selected) onConfirm(selected);
  }

  return (
    <div className="flex h-full flex-col bg-neutral-surface">
      <p ref={liveRef} aria-live="polite" className="sr-only" />

      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-neutral-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-[18px] items-center rounded-chip bg-brand-primary px-1.5 text-xs font-semibold uppercase text-white">
            Pull
          </span>
          <span className="truncate text-[13px] font-semibold text-neutral-text-primary">
            {item.title}
          </span>
          <span className="tppm-mono shrink-0 text-xs text-neutral-text-disabled">{item.id}</span>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel pull"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken ${FOCUS_RING}`}
        >
          <CloseIcon aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <p className="text-xs leading-relaxed text-neutral-text-secondary">
          Pulling moves this item to <b className="text-neutral-text-primary">Pulled</b> and creates
          a task in the target project&rsquo;s backlog (status Backlog, not assigned to a sprint).
        </p>

        {hasProjects ? (
          <>
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-neutral-text-secondary">
                Target project
              </div>
              <ProjectPickerRadioList
                projects={projects}
                value={selectedId}
                onChange={setSelectedId}
                onSubmit={confirm}
              />
            </div>

            <div className="rounded-card bg-neutral-surface-sunken p-3">
              <div className="text-[11px] font-semibold text-neutral-text-primary">
                What will happen
              </div>
              <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-neutral-text-secondary">
                <li>• This item becomes Pulled</li>
                <li>• New task in {selected ? `${selected.name}'s` : 'the project'} backlog</li>
                <li>• Title, description, tags, owner are copied over</li>
                <li>• Closing the task closes this item</li>
              </ul>
            </div>
          </>
        ) : (
          <div className="rounded-card border border-neutral-border bg-neutral-surface-sunken p-4 text-center">
            <p className="text-xs text-neutral-text-secondary">
              This program has no projects yet. Add a project to enable pulling.
            </p>
            <button type="button" className={`${BTN_PRIMARY} mt-3`} onClick={onAddProject}>
              Add a project →
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 border-t border-neutral-border bg-neutral-surface-raised px-5 py-3">
        <button type="button" className={BTN_GHOST} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={BTN_PRIMARY} onClick={confirm} disabled={!selected}>
          {selected ? `Pull to ${selected.name}` : 'Pull to project'}
        </button>
      </div>
    </div>
  );
}
