import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { docsUrl } from '@/lib/docsUrl';
import { ArrowRightIcon, CheckIcon, InfoIcon } from '@/components/Icons';

/**
 * One option in a {@link FieldHelp} chooser list.
 *
 * `desc` reuses the same server-enum description copy the field's inline hint
 * shows, so the popover never invents client-only vocabulary (issue #1975).
 */
export interface FieldHelpOption {
  label: string;
  desc: string;
  /** Marks the row the field currently holds (✓ + "Current" + `aria-current`). */
  selected?: boolean;
}

export interface FieldHelpProps {
  /**
   * Subject of the field, e.g. "Governance class". Drives both the trigger's
   * `aria-label` and the popover heading, so it must read as the field name.
   */
  label: string;
  /** Optional short sentence rendered above the option list. */
  intro?: string;
  /** The full option set. Provide this OR `body`, not both. */
  options?: FieldHelpOption[];
  /**
   * Free-form help content for a field with no enumerable options. Rendered in
   * place of `options`, keeping the same heading + "Learn more" chrome so the
   * affordance works on any field, not just enum selects.
   */
  body?: ReactNode;
  /**
   * Docs-site page slug + anchor, passed through {@link docsUrl} internally —
   * a slug like `features/task-classification/#governance-class-…`, never a
   * full URL and never a relative in-app docs path (web-rule 212).
   */
  docHref: string;
  /** Footer link text; a trailing " →" is appended. Defaults to "Learn more". */
  docLabel?: string;
}

/**
 * Reusable contextual-help affordance: a circled-`i` button in a field's label
 * row that opens a small anchored popover explaining every option for that
 * field, plus a "Learn more →" deep-link into the docs.
 *
 * The popover is a **non-modal** `role="dialog"` (it holds a link, so it cannot
 * be a `tooltip` — an `aria-describedby` tooltip's link is unreachable, web-rule
 * 121) portaled out of the modal's clipping/scroll region via
 * {@link useAnchoredPopover} (web-rules 253/260). It supplements — never
 * replaces — the field's always-visible inline hint: the hint answers "what
 * does my current pick mean", this answers "what are all my choices".
 */
export function FieldHelp({ label, intro, options, body, docHref, docLabel = 'Learn more' }: FieldHelpProps) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const popoverId = useId();
  const selectedRowRef = useRef<HTMLLIElement>(null);

  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>({
    open,
    width: 300,
    // Type has 6 options; the list caps at ~320px and scrolls, so this is a
    // sound flip-above estimate on the first open.
    estimatedHeight: 320,
    onDismiss: () => setOpen(false),
  });

  // On open, move focus into the dialog (keyboard/SR users land on the content
  // and can Tab to the link) and reveal the current row within the scroll list.
  useEffect(() => {
    if (!open) return;
    popoverRef.current?.focus();
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, popoverRef]);

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  // Escape closes the popover — and must NOT bubble to the parent modal's focus
  // trap, whose own `document` keydown listener would otherwise close the whole
  // modal. A capture-phase `document` listener runs before that bubble-phase
  // listener, and `stopPropagation()` in capture halts the bubble entirely, so
  // Escape peels one layer at a time (popover first, then the modal). This is
  // why a React `onKeyDown` on the body-portaled panel is not enough — it can't
  // reliably beat a native `document` listener registered by the trap.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeAndRestoreFocus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // closeAndRestoreFocus is stable across renders (only refs + setState).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`About the ${label} options`}
        title={`About the ${label} options`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`relative inline-flex h-5 w-5 items-center justify-center rounded before:absolute before:-inset-3 before:content-[''] hover:text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ${
          open ? 'text-brand-primary' : 'text-neutral-text-secondary'
        }`}
      >
        <InfoIcon className="h-4 w-4" aria-hidden="true" />
      </button>

      {popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="dialog"
            aria-modal="false"
            aria-labelledby={headingId}
            tabIndex={-1}
            style={popoverStyle}
            className="z-50 flex flex-col rounded-lg border border-neutral-border bg-neutral-surface-raised p-3 shadow-pop focus-visible:outline-none motion-safe:animate-empty-state-in"
          >
            <h2
              id={headingId}
              className="text-xs font-semibold uppercase tracking-[.06em] text-neutral-text-secondary"
            >
              {label}
            </h2>
            {intro && <p className="mt-1 text-xs text-neutral-text-secondary">{intro}</p>}

            {options ? (
              <ul className="mt-2 flex max-h-[min(60vh,320px)] flex-col gap-0.5 overflow-y-auto">
                {options.map((o) => (
                  <li
                    key={o.label}
                    ref={o.selected ? selectedRowRef : undefined}
                    aria-current={o.selected ? 'true' : undefined}
                    className={`rounded px-2 py-1.5 ${o.selected ? 'bg-brand-primary/5' : ''}`}
                  >
                    <div className="flex items-center gap-1.5">
                      {o.selected && (
                        <CheckIcon className="h-3.5 w-3.5 shrink-0 text-brand-primary" aria-hidden="true" />
                      )}
                      <span className="text-sm font-medium text-neutral-text-primary">{o.label}</span>
                      {o.selected && (
                        <span className="ml-auto text-xs font-medium text-brand-primary">Current</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-neutral-text-secondary">{o.desc}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-2 max-h-[min(60vh,320px)] overflow-y-auto text-sm text-neutral-text-primary">
                {body}
              </div>
            )}

            <div className="mt-2 flex items-center justify-between border-t border-neutral-border pt-2">
              {/* min-h-11 on mobile: FieldHelp renders inside the BottomSheet on
                  phones, so these are real touch targets (rule 5). */}
              <a
                href={docsUrl(docHref)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1 rounded px-1 text-sm font-medium text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 md:min-h-0"
              >
                {docLabel}
                <span className="sr-only"> (opens in a new tab)</span>
                <ArrowRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
              <button
                type="button"
                onClick={closeAndRestoreFocus}
                className="inline-flex min-h-11 items-center rounded px-2 text-sm text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 md:min-h-0"
              >
                Got it
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
