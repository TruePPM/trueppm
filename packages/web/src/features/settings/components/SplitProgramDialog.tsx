/**
 * Split-program redistribution dialog (issue #967, ADR-0156).
 *
 * The last unwired lifecycle action on `ProgramArchivePage`: divide a program
 * into independent sub-programs the caller owns. The Owner names one or more
 * sub-programs and assigns each of the program's projects to at most one of them
 * (or leaves it on the original). Anything left unassigned stays on the original
 * program, which the server closes after the split — a consequence surfaced
 * prominently because it is not obvious from "split".
 *
 * The client model is project -> single target, which is then grouped into the
 * server's `splits: [{ name, project_ids }]` shape at submit. Because each
 * project maps to exactly one target by construction, the server's
 * "claimed by two sub-programs" validation can never trip from this UI.
 *
 * Assignment uses a native `<select>` per project rather than drag-and-drop:
 * it is keyboard-accessible for free (no rule-105/167 a11y gap) and trivial to
 * render for any project count. The dialog never mutates directly — the caller
 * passes `onConfirm` so the page owns cache invalidation, navigation, and the
 * error surface (mirrors `TransferOwnershipDialog`).
 */

import { WarningIcon } from '@/components/Icons';
import { useEffect, useRef, useState } from 'react';
import { useProgramProjects } from '@/hooks/useProgramProjects';

interface SplitProgramDialogProps {
  programId: string | undefined;
  /** The program being split — named in the heading and the "stays on" copy. */
  programName: string;
  /** Server error message to surface inline, or null. */
  error?: string | null;
  busy?: boolean;
  onCancel: () => void;
  /** Fires the wired mutation with the grouped server payload. */
  onConfirm: (splits: { name: string; project_ids: string[] }[]) => void;
}

interface SubProgramDraft {
  /** Stable local id — the `<select>` option value, so duplicate display names
   *  stay unambiguous and a rename never re-points an assignment. */
  localId: string;
  name: string;
}

/** Backend cap on sub-programs created in one split (mirrors `_MAX_SPLITS`). */
const MAX_SUBS = 50;

export function SplitProgramDialog({
  programId,
  programName,
  error,
  busy,
  onCancel,
  onConfirm,
}: SplitProgramDialogProps) {
  const { data: projects, isLoading } = useProgramProjects(programId);

  const nextId = useRef(1);
  const makeId = () => `sub-${nextId.current++}`;

  const [subs, setSubs] = useState<SubProgramDraft[]>(() => [{ localId: 'sub-0', name: '' }]);
  // projectId -> sub localId, or null when the project stays on the original.
  const [assignment, setAssignment] = useState<Record<string, string | null>>({});

  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape cancels; stopPropagation so a parent discard guard does not also react.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const addSub = () => {
    if (subs.length >= MAX_SUBS) return;
    setSubs((prev) => [...prev, { localId: makeId(), name: '' }]);
  };

  const removeSub = (localId: string) => {
    setSubs((prev) => prev.filter((s) => s.localId !== localId));
    // Projects assigned to the removed sub fall back to the original.
    setAssignment((prev) => {
      const next: Record<string, string | null> = {};
      for (const [pid, target] of Object.entries(prev)) {
        next[pid] = target === localId ? null : target;
      }
      return next;
    });
  };

  const renameSub = (localId: string, name: string) => {
    setSubs((prev) => prev.map((s) => (s.localId === localId ? { ...s, name } : s)));
  };

  const projectList = projects ?? [];
  const assignedCount = projectList.filter((p) => (assignment[p.id] ?? null) !== null).length;
  const staysCount = projectList.length - assignedCount;

  const allNamed = subs.length > 0 && subs.every((s) => s.name.trim() !== '');
  const canConfirm = allNamed && !busy;

  const handleConfirm = () => {
    if (!canConfirm) return;
    const splits = subs.map((s) => ({
      name: s.name.trim(),
      project_ids: projectList.filter((p) => assignment[p.id] === s.localId).map((p) => p.id),
    }));
    onConfirm(splits);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="split-dialog-title"
      aria-describedby="split-dialog-body"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="mx-4 flex max-h-[85vh] w-full max-w-lg flex-col rounded-card border border-neutral-border bg-neutral-surface motion-safe:animate-modal-scale-in">
        <div className="shrink-0 p-5 pb-3">
          <h2
            id="split-dialog-title"
            className="mb-2 text-sm font-semibold text-neutral-text-primary"
          >
            Split into sub-programs
          </h2>
          <p id="split-dialog-body" className="text-xs text-neutral-text-secondary">
            Divide <span className="font-medium text-neutral-text-primary">{programName}</span> into
            independent programs you own. Projects you don&rsquo;t assign stay on{' '}
            <span className="font-medium text-neutral-text-primary">{programName}</span>, which is
            closed (read-only) after the split.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5">
          {/* New sub-programs */}
          <div className="mb-4">
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-widest text-neutral-text-secondary">
                New sub-programs
              </h3>
              <span className="text-[10px] tabular-nums text-neutral-text-secondary">
                {subs.length} of {MAX_SUBS}
              </span>
            </div>
            <div className="space-y-2">
              {subs.map((s, i) => (
                <div key={s.localId} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={s.name}
                    onChange={(e) => renameSub(s.localId, e.target.value)}
                    placeholder={`Sub-program ${i + 1} name`}
                    aria-label={`Sub-program ${i + 1} name`}
                    aria-invalid={s.name.trim() === '' ? true : undefined}
                    className={[
                      'h-7 flex-1 rounded border bg-neutral-surface-raised px-2 text-[12px] text-neutral-text-primary',
                      'placeholder:text-neutral-text-disabled',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                      s.name.trim() === ''
                        ? 'border-semantic-critical/60'
                        : 'border-neutral-border',
                    ].join(' ')}
                  />
                  <button
                    type="button"
                    onClick={() => removeSub(s.localId)}
                    disabled={subs.length <= 1}
                    aria-label={`Remove sub-program ${i + 1}`}
                    title={subs.length <= 1 ? 'At least one sub-program is required' : 'Remove'}
                    className={[
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded border border-neutral-border text-[13px] text-neutral-text-secondary',
                      'hover:bg-neutral-surface-sunken',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                      'disabled:cursor-not-allowed disabled:text-neutral-text-disabled disabled:hover:bg-transparent',
                    ].join(' ')}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addSub}
              disabled={subs.length >= MAX_SUBS}
              className={[
                'mt-2 h-7 rounded border border-neutral-border bg-transparent px-2.5 text-[11px] font-medium text-neutral-text-primary',
                'hover:bg-neutral-surface-sunken',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                'disabled:cursor-not-allowed disabled:text-neutral-text-disabled',
              ].join(' ')}
            >
              + Add sub-program
            </button>
          </div>

          {/* Assign projects */}
          <div className="mb-4">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-neutral-text-secondary">
              Assign projects
            </h3>
            {isLoading ? (
              <p className="text-[11px] text-neutral-text-secondary">Loading projects…</p>
            ) : projectList.length === 0 ? (
              <p role="note" className="text-[11px] text-neutral-text-secondary">
                This program has no projects — the sub-programs are created as empty shells.
              </p>
            ) : (
              <>
                <ul className="divide-y divide-neutral-border rounded border border-neutral-border">
                  {projectList.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-3 px-2.5 py-1.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-text-primary">
                        {p.name}
                      </span>
                      <select
                        value={assignment[p.id] ?? ''}
                        onChange={(e) =>
                          setAssignment((prev) => ({
                            ...prev,
                            [p.id]: e.target.value === '' ? null : e.target.value,
                          }))
                        }
                        aria-label={`Assign project ${p.name} to`}
                        className={[
                          'h-7 max-w-[12rem] shrink-0 rounded border border-neutral-border bg-neutral-surface-raised px-1.5 text-[11px] text-neutral-text-primary',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                        ].join(' ')}
                      >
                        <option value="">Stays on {programName} (closed)</option>
                        {subs.map((s, i) => (
                          <option key={s.localId} value={s.localId}>
                            {s.name.trim() || `Sub-program ${i + 1}`}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
                <p
                  role="status"
                  aria-live="polite"
                  className="mt-1.5 text-[11px] text-neutral-text-secondary"
                >
                  {assignedCount} of {projectList.length} project
                  {projectList.length === 1 ? '' : 's'} assigned
                  {staysCount > 0 ? ` · ${staysCount} stays on ${programName}` : ''}
                </p>
              </>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-neutral-border p-5 pt-3">
          <p className="mb-3 text-[11px] text-semantic-at-risk">
            <WarningIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />
            {programName} will be closed after the split. It keeps any projects you leave unassigned
            and can be reopened later.
          </p>
          {error ? (
            <p className="mb-3 text-[11px] text-semantic-critical" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              className="h-8 rounded border border-neutral-border bg-transparent px-3 text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={handleConfirm}
              className={[
                'h-8 rounded border-none px-3 text-[13px] font-medium text-white transition-opacity',
                'bg-brand-primary hover:bg-brand-primary-dark',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary',
                'disabled:cursor-not-allowed disabled:opacity-50',
              ].join(' ')}
            >
              {busy ? 'Splitting…' : 'Split program'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
