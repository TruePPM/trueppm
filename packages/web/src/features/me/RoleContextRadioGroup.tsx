/**
 * Radio-card group for picking the role-context lens on the settings page
 * (issue 1263, ADR-0162).
 *
 * Mirrors `LandingChoiceRadioGroup`'s roving-tabindex pattern (rule 167) but is
 * typed to `RoleContext` and carries none of the landing-specific Auto /
 * Enterprise machinery:
 *   - single `role="radiogroup"`; each option a `role="radio"` button.
 *   - roving `tabIndex` (only the selected/focused option is the tab stop).
 *   - arrow keys move DOM focus WITHOUT committing; click/Enter/Space commits.
 *   - each card `min-h-[44px]` (rule 5); filled/hollow glyph carries selection
 *     beyond color (rule 4).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { RoleContext } from '@/hooks/useCurrentUser';
import { ROLE_CONTEXT_CHOICES } from '@/features/me/roleContext';

/** Filled / hollow radio glyph — carries selection state beyond color (rule 4). */
function RadioGlyph({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
        checked ? 'border-brand-primary' : 'border-neutral-border'
      }`}
    >
      {checked && <span className="h-2 w-2 rounded-full bg-brand-primary" />}
    </span>
  );
}

interface Props {
  value: RoleContext;
  onChange: (value: RoleContext) => void;
  /** Accessible name for the group. */
  label: string;
  /** Disable every card (e.g. while offline). */
  disabled?: boolean;
}

export function RoleContextRadioGroup({ value, onChange, label, disabled }: Props) {
  const selectedIdx = Math.max(
    0,
    ROLE_CONTEXT_CHOICES.findIndex((o) => o.value === value),
  );
  const [focusIdx, setFocusIdx] = useState(selectedIdx);
  useEffect(() => {
    setFocusIdx(selectedIdx);
  }, [selectedIdx]);

  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (
      e.key !== 'ArrowDown' &&
      e.key !== 'ArrowRight' &&
      e.key !== 'ArrowUp' &&
      e.key !== 'ArrowLeft'
    )
      return;
    e.preventDefault();
    const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    const count = ROLE_CONTEXT_CHOICES.length;
    const next = (focusIdx + dir + count) % count;
    setFocusIdx(next);
    btnRefs.current[next]?.focus(); // move focus ONLY — do not commit (rule 167)
  }

  return (
    // tabIndex={-1}: the container is programmatically focusable (jsx-a11y for
    // role="radiogroup"); the roving tabindex on children is the real entry point.
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-col gap-2 outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {ROLE_CONTEXT_CHOICES.map((opt, i) => {
        const checked = value === opt.value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            tabIndex={i === focusIdx ? 0 : -1}
            onClick={() => onChange(opt.value)}
            className={`flex min-h-[44px] items-start gap-3 rounded border p-3 text-left
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary
              ${
                checked
                  ? 'border-brand-primary bg-brand-primary/5'
                  : 'border-neutral-border hover:border-brand-primary/40'
              }`}
          >
            <RadioGlyph checked={checked} />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-neutral-text-primary">{opt.label}</span>
              <span className="text-xs text-neutral-text-secondary">{opt.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
