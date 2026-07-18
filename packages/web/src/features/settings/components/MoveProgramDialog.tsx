/**
 * Move-project-between-programs picker dialog (#2089, ADR-0070).
 *
 * The seventh API-writable Project field, `program`, is the one genuinely novel
 * interaction split out of #2018: assigning or moving a project to a program (or
 * making it standalone) is program-shaping — it changes rollup ownership and
 * visibility — and it carries a dual-Admin gate (`validate_program`). So it does
 * NOT ride the General page's shared save bar; it gets this dedicated confirm
 * modal with its own mutate, so a program 400 can never sink an unrelated
 * name/health/timezone save.
 *
 * The picker marks targets the caller cannot administer (`my_role < ADMIN`) and
 * closed programs as disabled with a reason, but the server stays the sole
 * authority: the dual-Admin gate (project ADMIN + target-program ADMIN + old-
 * program ADMIN when moving away) is enforced in `validate_program`, and its
 * actionable 400 is surfaced verbatim via `error`. The dialog never mutates
 * directly — the caller passes `onConfirm`, so the page owns cache invalidation
 * and error surfacing (mirrors TransferOwnershipDialog).
 *
 * `role="dialog" aria-modal="true"` with focus on Cancel (the safe control) on
 * open — a move is deliberate and only reversible by moving back, so the Confirm
 * is never autofocused.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePrograms } from '@/hooks/usePrograms';
import { ROLE_ADMIN } from '@/lib/roles';

/** Sentinel for the "Standalone (no program)" radio value — distinct from a UUID. */
const STANDALONE = '__standalone__';

interface MoveProgramDialogProps {
  /** UUID of the project's current program, or null when it is standalone. */
  currentProgramId: string | null;
  /** Display name of the current program, or null when standalone. */
  currentProgramName: string | null;
  /** Server error message to surface verbatim, or null. */
  error?: string | null;
  busy?: boolean;
  onCancel: () => void;
  /** Fires the wired mutation. `null` = make the project standalone. */
  onConfirm: (targetProgramId: string | null) => void;
}

interface ProgramOption {
  value: string;
  label: string;
  disabled: boolean;
  /** Why the option is disabled, shown as a muted suffix. */
  reason: string | null;
}

export function MoveProgramDialog({
  currentProgramId,
  currentProgramName,
  error,
  busy,
  onCancel,
  onConfirm,
}: MoveProgramDialogProps) {
  const { data: programs, isLoading } = usePrograms();
  // null = nothing chosen yet; STANDALONE or a UUID once the user picks.
  const [selected, setSelected] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape cancels; stopPropagation so it does not bubble to a parent handler
  // (e.g. the settings discard guard) that would also react to the key.
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

  const options = useMemo<ProgramOption[]>(() => {
    const list = [...(programs ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    return list.map((p) => {
      const isCurrent = p.id === currentProgramId;
      const notAdmin = p.my_role === null || p.my_role < ROLE_ADMIN;
      return {
        value: p.id,
        label: p.name,
        // Current program and closed programs are dead-ends; a program the caller
        // does not administer is dimmed because the server's dual-Admin gate would
        // reject it — the reason spares the round-trip, the server still decides.
        disabled: isCurrent || p.is_closed || notAdmin,
        reason: isCurrent
          ? 'Current'
          : p.is_closed
            ? 'Closed'
            : notAdmin
              ? 'Manager role required'
              : null,
      };
    });
  }, [programs, currentProgramId]);

  const target = selected === STANDALONE ? null : selected;
  const canConfirm = selected !== null && !busy;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-program-dialog-title"
      aria-describedby="move-program-dialog-body"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="mx-4 w-full max-w-md rounded-card border border-neutral-border bg-neutral-surface p-5 motion-safe:animate-modal-scale-in">
        <h2
          id="move-program-dialog-title"
          className="mb-2 text-sm font-semibold text-neutral-text-primary"
        >
          Move to a program
        </h2>
        <p id="move-program-dialog-body" className="mb-3 text-xs text-neutral-text-secondary">
          {currentProgramName
            ? `This project is part of ${currentProgramName}. Choose where it should live.`
            : 'This project is standalone. Choose a program to add it to.'}
        </p>

        {/* Moving a project is program-shaping — it reassigns rollup ownership and
            re-scopes visibility to the target program's members. Warn before the move. */}
        <p className="mb-4 rounded-control border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-[11px] leading-snug text-neutral-text-secondary">
          Moving this project changes which program rolls it up and who can see it. Its dependencies
          on sibling projects in the old program are cleared.
        </p>

        {isLoading ? (
          <p className="mb-4 text-[12px] text-neutral-text-secondary">Loading programs…</p>
        ) : (
          <fieldset className="mb-4 max-h-64 space-y-1 overflow-y-auto">
            <legend className="sr-only">Destination program</legend>

            {/* Standalone is always offered (except when already standalone) so a
                project can be detached — the server gates the old-program ADMIN. */}
            <RadioOption
              name="move-program-target"
              value={STANDALONE}
              label="Standalone (no program)"
              reason={currentProgramId === null ? 'Current' : null}
              disabled={currentProgramId === null}
              checked={selected === STANDALONE}
              onSelect={setSelected}
            />

            {options.length === 0 ? (
              <p className="px-1 py-2 text-[12px] text-neutral-text-secondary">
                No programs yet. Create a program to move this project into one.
              </p>
            ) : (
              options.map((opt) => (
                <RadioOption
                  key={opt.value}
                  name="move-program-target"
                  value={opt.value}
                  label={opt.label}
                  reason={opt.reason}
                  disabled={opt.disabled}
                  checked={selected === opt.value}
                  onSelect={setSelected}
                />
              ))
            )}
          </fieldset>
        )}

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
            onClick={() => {
              if (selected === null) return;
              onConfirm(target);
            }}
            className={[
              'h-8 rounded border-none px-3 text-[13px] font-medium text-white transition-opacity',
              'bg-brand-primary hover:bg-brand-primary-dark',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary',
              'disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary',
            ].join(' ')}
          >
            {busy ? 'Moving…' : 'Move project'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface RadioOptionProps {
  name: string;
  value: string;
  label: string;
  reason: string | null;
  disabled: boolean;
  checked: boolean;
  onSelect: (value: string) => void;
}

function RadioOption({ name, value, label, reason, disabled, checked, onSelect }: RadioOptionProps) {
  return (
    <label
      className={[
        'flex items-center gap-2.5 rounded-control px-2 py-1.5 text-[13px]',
        disabled
          ? 'cursor-not-allowed text-neutral-text-disabled'
          : 'cursor-pointer text-neutral-text-primary hover:bg-neutral-surface-sunken',
      ].join(' ')}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className="h-3.5 w-3.5 shrink-0 accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      {reason ? (
        <span className="shrink-0 text-[11px] font-normal text-neutral-text-secondary">
          · {reason}
        </span>
      ) : null}
    </label>
  );
}
