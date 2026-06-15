/**
 * Shared radio-card group for picking a default landing screen (ADR-0129).
 *
 * Reuses the `PulseRadioGroup` / `QuarterModeControl` roving-tabindex pattern
 * (rule 167): arrow keys move DOM focus across the options WITHOUT committing;
 * commit happens only on click/Enter/Space (native button activation). The
 * selected option is the single tab stop; when nothing is selected the first
 * option is the entry point.
 *
 * Accessibility:
 *   - Single `role="radiogroup"` wrapping every option including Auto (items 1+2).
 *   - `tabIndex={i === focusIdx ? 0 : -1}` roving tabindex on each card button.
 *   - `onKeyDown` on the container moves DOM focus on ArrowDown/Right/Up/Left,
 *     wrapping around, skipping disabled options (rule 167 / WCAG 2.1.1).
 *   - Arrow keys call `.focus()` only — activation (click/Enter/Space) commits.
 *   - Each button is `min-h-[44px]` per rule 5 / WCAG 2.5.5.
 *   - Portfolio gated card: rule-122 disabled recipe; no `title` tooltip (rule 121).
 *   - Filled/hollow glyph ensures selection is never color-only (rule 4 / WCAG 1.4.1).
 *
 * Auto option:
 *   Callers can pass an `autoOption` prop to splice a visually set-apart Auto
 *   card into the list (with a hairline divider before it). The card is still
 *   inside the same `role="radiogroup"` so AT can arrow between all options.
 *   The divider is `aria-hidden` (purely presentational). The settings page
 *   does NOT use `autoOption` — it passes Auto as a normal first entry in
 *   `options` instead.
 */
import { useRef, useState, useEffect, type KeyboardEvent, type ReactNode } from 'react';
import type { DefaultLanding } from '@/hooks/useCurrentUser';
import { useEdition } from '@/hooks/useEdition';
import { EnterpriseBadge } from '@/features/settings/components/EnterpriseBadge';

export interface LandingChoiceOption {
  value: DefaultLanding;
  label: string;
  description: string;
  /** Enterprise-reserved — gated in the community edition. */
  enterprise?: boolean;
}

/** The Auto option rendered below a hairline divider inside the same radiogroup. */
export interface AutoOptionProps {
  /** Whether Auto is currently checked. */
  checked: boolean;
  /** Helper text line for the Auto card (includes the live intent echo). */
  helperText: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

interface Props {
  options: ReadonlyArray<LandingChoiceOption>;
  value: DefaultLanding;
  onChange: (value: DefaultLanding) => void;
  /** Accessible name for the group. */
  label: string;
  /** Disable every card (e.g. while a save is in flight, or offline). */
  disabled?: boolean;
  /**
   * When provided, a hairline divider + Auto card are appended inside the same
   * radiogroup, making all options a single keyboard-navigable group.
   */
  autoOption?: AutoOptionProps;
}

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

export function LandingChoiceRadioGroup({
  options,
  value,
  onChange,
  label,
  disabled,
  autoOption,
}: Props) {
  const { edition } = useEdition();

  // Total navigable items = options + (1 if autoOption present)
  const totalCount = options.length + (autoOption ? 1 : 0);

  // Determine the index of the currently selected option.
  const selectedIdx = (() => {
    const concreteIdx = options.findIndex((o) => o.value === value);
    if (concreteIdx >= 0) return concreteIdx;
    // Auto is the last item when present
    if (autoOption?.checked) return options.length;
    return -1;
  })();

  // Roving focus index — tracks selection; falls back to first option.
  const [focusIdx, setFocusIdx] = useState(selectedIdx >= 0 ? selectedIdx : 0);
  useEffect(() => {
    if (selectedIdx >= 0) setFocusIdx(selectedIdx);
  }, [selectedIdx]);

  // Refs for all button elements (concrete options + optional Auto).
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

    // Find the next non-disabled index, wrapping around.
    const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    let next = focusIdx;
    for (let attempt = 0; attempt < totalCount; attempt++) {
      next = (next + dir + totalCount) % totalCount;
      const btn = btnRefs.current[next];
      if (btn && !btn.disabled) break;
    }
    setFocusIdx(next);
    btnRefs.current[next]?.focus(); // move focus ONLY — do not commit (rule 167)
  }

  return (
    // tabIndex={-1}: the container is programmatically focusable (required by
    // jsx-a11y/interactive-supports-focus for role="radiogroup"); the roving
    // tabindex on child buttons is the real keyboard entry point (rule 167).
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-col gap-2 outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {options.map((opt, i) => {
        const checked = value === opt.value;
        // Portfolio is unreachable in the community edition — gate it.
        const gated = opt.enterprise === true && edition === 'community';
        const isDisabled = disabled === true || gated;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={isDisabled}
            // tabIndex: roving — only the focused option is in the tab order (rule 167).
            tabIndex={i === focusIdx ? 0 : -1}
            onClick={() => onChange(opt.value)}
            className={`flex min-h-[44px] items-start gap-3 rounded border p-3 text-left
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary
              disabled:border-neutral-border/55 disabled:cursor-not-allowed
              ${
                checked && !isDisabled
                  ? 'border-brand-primary bg-brand-primary/5'
                  : 'border-neutral-border hover:border-brand-primary/40'
              }`}
          >
            <RadioGlyph checked={checked} />
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center text-sm font-medium text-neutral-text-primary">
                {opt.label}
                {gated && <EnterpriseBadge />}
              </span>
              <span className="text-xs text-neutral-text-secondary">{opt.description}</span>
            </span>
          </button>
        );
      })}

      {/* Auto option — set apart with a purely presentational hairline divider,
          but INSIDE the same radiogroup so AT can arrow to it (item 2). */}
      {autoOption && (
        <>
          <div className="border-t border-neutral-border" aria-hidden="true" />
          <button
            ref={(el) => {
              btnRefs.current[options.length] = el;
            }}
            type="button"
            role="radio"
            aria-checked={autoOption.checked}
            disabled={autoOption.disabled === true || disabled === true}
            tabIndex={options.length === focusIdx ? 0 : -1}
            onClick={autoOption.onClick}
            className={`flex min-h-[44px] w-full items-start gap-3 rounded border p-3 text-left
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary
              disabled:border-neutral-border/55 disabled:cursor-not-allowed
              ${
                autoOption.checked && !(autoOption.disabled === true || disabled === true)
                  ? 'border-brand-primary bg-brand-primary/5'
                  : 'border-neutral-border hover:border-brand-primary/40'
              }`}
          >
            <RadioGlyph checked={autoOption.checked} />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-neutral-text-primary">
                Auto (recommended)
              </span>
              <span className="text-xs text-neutral-text-secondary">{autoOption.helperText}</span>
            </span>
          </button>
        </>
      )}
    </div>
  );
}
