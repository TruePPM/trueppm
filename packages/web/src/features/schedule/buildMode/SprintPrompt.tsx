import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { useProject } from '@/hooks/useProject';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useSprintsByState } from '@/hooks/useSprints';

interface Props {
  open: boolean;
  /** Project ID — required so the component can check agile_features and fetch sprints. */
  projectId: string | null;
  /** Called with sprint UUID (or null for Backlog) and optional story points. */
  onSelect: (sprintId: string | null, storyPoints: number | null) => void;
  onDismiss: () => void;
}

/**
 * Sprint-assignment + estimate prompt for newly committed tasks (#346 #468).
 *
 * Step 1 — which sprint? 1·current, 2·next planned, 3·Backlog, Esc·later.
 * Step 2 — story points? type a number + Enter to set, Enter/Esc to skip.
 *
 * Per ADR-0418 (#1961/#1968) the estimate step is decoupled from the agile gate:
 * the **sprint** step is agile-only, but the **story-point** step is available on
 * every methodology. On a non-agile project the prompt skips step 1 and opens
 * directly on the estimate step (with no sprint assignment), so a PM can set a
 * point estimate from build-mode quick-add just as they can from the board form.
 */
export function SprintPrompt({ open, projectId, onSelect, onDismiss }: Props) {
  const { data: project } = useProject(projectId);
  const itl = useIterationLabel(projectId);
  const { active, planned } = useSprintsByState(projectId);
  const panelRef = useRef<HTMLDivElement>(null);
  const ptsInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<'sprint' | 'points'>('sprint');
  const [pendingSprintId, setPendingSprintId] = useState<string | null>(null);
  const [ptsValue, setPtsValue] = useState('');

  const isAgile = project?.agile_features === true;

  // Reset whenever the prompt opens (or once the project's methodology resolves).
  // Agile projects start on the sprint step; non-agile projects skip straight to
  // the estimate step with no sprint assignment (ADR-0418).
  useEffect(() => {
    if (open) {
      setStep(isAgile ? 'sprint' : 'points');
      setPendingSprintId(null);
      setPtsValue('');
    }
  }, [open, isAgile]);

  // Focus the pts input when we transition to step 2.
  useEffect(() => {
    if (step === 'points') {
      ptsInputRef.current?.focus();
    }
  }, [step]);

  function selectSprint(sprintId: string | null) {
    setPendingSprintId(sprintId);
    setStep('points');
  }

  function commitPoints() {
    const pts = ptsValue.trim() === '' ? null : Math.max(0, Math.round(Number(ptsValue)));
    onSelect(pendingSprintId, pts);
  }

  // Dismiss on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onDismiss]);

  // Escape: on the estimate step of an agile project, step back to the sprint
  // step; otherwise (sprint step, or the estimate-only non-agile flow) dismiss.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (step === 'points' && isAgile) {
          setStep('sprint');
        } else {
          onDismiss();
        }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [open, isAgile, step, onDismiss]);

  // Number-key shortcuts (1, 2, 3) — sprint step only
  useEffect(() => {
    if (!open || !isAgile || step !== 'sprint') return;
    const sprintIds: (string | null)[] = [
      active?.id ?? null,
      planned[0]?.id ?? null,
      null,
    ];
    const handler = (e: KeyboardEvent) => {
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < sprintIds.length) {
        e.preventDefault();
        selectSprint(sprintIds[idx]);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [open, isAgile, step, active, planned]);

  // Wait for the project to load before rendering: `isAgile` is derived from it,
  // and showing the estimate-only (non-agile) step before the methodology is known
  // would flash the wrong step and re-seat once `agile_features` resolves.
  if (!open || !project) return null;

  const sprintOptions = (
    [
      { label: active ? `Current ${itl.lower}: ${active.name}` : null, sprintId: active?.id ?? null },
      { label: planned[0] ? `Next ${itl.lower}: ${planned[0].name}` : null, sprintId: planned[0]?.id ?? null },
      { label: 'Backlog', sprintId: null as string | null },
    ] as { label: string | null; sprintId: string | null }[]
  ).filter((o): o is { label: string; sprintId: string | null } => o.label !== null);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label={step === 'sprint' ? `Assign to ${itl.lower}` : 'Story points'}
      className="absolute top-full left-0 z-50 w-[260px] mt-0.5 rounded-card border border-chrome-border
        bg-chrome-surface-raised p-2 space-y-0.5"
    >
      {step === 'sprint' ? (
        <>
          <p className="text-xs text-chrome-text-secondary px-1 pb-1 font-medium">Add to {itl.lower}?</p>
          {sprintOptions.map((opt, i) => (
            <button
              key={opt.sprintId ?? 'backlog'}
              type="button"
              className="w-full text-left text-xs px-2 py-1.5 rounded-control
                hover:bg-brand-primary/10 text-chrome-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                focus-visible:ring-offset-1"
              onClick={() => selectSprint(opt.sprintId)}
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
        </>
      ) : (
        <>
          <p className="text-xs text-chrome-text-secondary px-1 pb-1 font-medium">Story points?</p>
          <div className="flex items-center gap-2 px-1">
            <input
              ref={ptsInputRef}
              type="number"
              min={0}
              step={1}
              placeholder="—"
              value={ptsValue}
              onChange={(e) => setPtsValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitPoints(); }
              }}
              className="w-20 h-8 px-2 text-sm tppm-mono text-neutral-text-primary bg-neutral-surface
                border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary
                focus-visible:outline-none placeholder:text-neutral-text-disabled"
              aria-label="Story points (optional)"
            />
            <Button
              variant="primary"
              size="md"
              onClick={commitPoints}
            >
              Done
            </Button>
          </div>
          <p className="text-xs text-neutral-text-disabled px-1 pt-0.5">
            {isAgile ? 'Enter to confirm · Esc to go back' : 'Enter to confirm · Esc to skip'}
          </p>
        </>
      )}
    </div>
  );
}
