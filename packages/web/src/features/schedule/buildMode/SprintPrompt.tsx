import { useEffect, useRef } from 'react';
import { useProject } from '@/hooks/useProject';
import { useSprintsByState } from '@/hooks/useSprints';

interface Props {
  open: boolean;
  /** Project ID — required so the component can check agile_features and fetch sprints. */
  projectId: string | null;
  /** Called with sprint UUID to assign, or null for Backlog. */
  onSelect: (sprintId: string | null) => void;
  onDismiss: () => void;
}

/**
 * Numbered sprint-assignment prompt for newly committed tasks (#346).
 *
 * Shown after a task name is confirmed in build mode when the project has
 * agile_features=true. Lists 1·current sprint, 2·next planned sprint,
 * 3·Backlog, and Esc·later (dismiss without assigning).
 *
 * Self-dismisses on outside click or Escape. Fetches project + sprint data
 * via the already-cached project query (no extra network request in practice).
 */
export function SprintPrompt({ open, projectId, onSelect, onDismiss }: Props) {
  const { data: project } = useProject(projectId);
  const { active, planned } = useSprintsByState(projectId);
  const panelRef = useRef<HTMLDivElement>(null);

  const isAgile = project?.agile_features === true;

  // Dismiss on outside click
  useEffect(() => {
    if (!open || !isAgile) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, isAgile, onDismiss]);

  // Dismiss on Escape
  useEffect(() => {
    if (!open || !isAgile) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [open, isAgile, onDismiss]);

  // Number-key shortcuts (1, 2, 3)
  useEffect(() => {
    if (!open || !isAgile) return;
    const sprintIds: (string | null)[] = [
      active?.id ?? null,
      planned[0]?.id ?? null,
      null, // Backlog
    ];
    const handler = (e: KeyboardEvent) => {
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < sprintIds.length) {
        e.preventDefault();
        onSelect(sprintIds[idx]);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [open, isAgile, active, planned, onSelect]);

  if (!open || !isAgile) return null;

  const options = (
    [
      { label: active ? `Current sprint: ${active.name}` : null, sprintId: active?.id ?? null },
      {
        label: planned[0] ? `Next sprint: ${planned[0].name}` : null,
        sprintId: planned[0]?.id ?? null,
      },
      { label: 'Backlog', sprintId: null as string | null },
    ] as { label: string | null; sprintId: string | null }[]
  ).filter((o): o is { label: string; sprintId: string | null } => o.label !== null);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label="Assign to sprint"
      className="absolute top-full left-0 z-50 w-[260px] mt-0.5 rounded border border-chrome-border
        bg-chrome-surface-raised p-2 space-y-0.5"
    >
      <p className="text-xs text-chrome-text-secondary px-1 pb-1 font-medium">Add to sprint?</p>
      {options.map((opt, i) => (
        <button
          key={opt.sprintId ?? 'backlog'}
          type="button"
          className="w-full text-left text-xs px-2 py-1.5 rounded
            hover:bg-brand-primary/10 text-chrome-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
          onClick={() => onSelect(opt.sprintId)}
        >
          <span className="text-chrome-text-secondary mr-1">{i + 1}.</span>
          {opt.label}
        </button>
      ))}
      <button
        type="button"
        className="w-full text-left text-xs px-2 py-1 text-neutral-text-secondary
          hover:text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1"
        onClick={onDismiss}
      >
        <span className="text-chrome-text-secondary mr-1">Esc.</span>
        Later
      </button>
    </div>
  );
}
