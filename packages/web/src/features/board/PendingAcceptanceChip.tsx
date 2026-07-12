import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Pending-acceptance chip for mid-sprint scope-injection (ADR-0102 §6, #882 rule).
 *
 * A task injected into an active sprint after activation is visible but NOT yet
 * part of the commitment (excluded from burndown) until a team-owned actor
 * accepts or rejects it. This chip is the read-state badge for that condition.
 *
 * IMPORTANT (frontend/CLAUDE.md rule 149): pending is a NEUTRAL read-state, not
 * a warning. It uses the neutral/gray surface + a hollow ○ glyph — NEVER amber
 * or red. It must never read as an error, a notification, or a guardrail notice.
 * This single component is the shared source for both the planning board and
 * the contributor "My Work" row, so the two surfaces can never drift in tone.
 *
 * It is a passive label: it carries no accept/reject controls of its own. The
 * decision affordances live on the board card / review panel (planning
 * surfaces, role-gated) and never in the me tree.
 *
 * When {@link Props.explainer} is supplied (#1472) the chip becomes an
 * interactive *disclosure*: tapping it opens a neutral popover with a
 * plain-language explanation plus a "Got it" close button. This exists so a
 * plain Member — who sees the pending signal but has no reachable accept/reject
 * — can understand it instead of staring at a control she can't touch. The
 * explainer is *close-only and ephemeral*: it grants NO accept/reject capability
 * and persists nothing. Pending is a server-owned transient (ADR-0102); the chip
 * stays until the server clears it on accept/reject.
 */
interface Props {
  /** Compact variant drops the text label, keeping only the glyph + a11y name.
   *  Used in dense board-card contexts where the banner already explains scope. */
  compact?: boolean;
  className?: string;
  /**
   * Plain-language, role-neutral explanation sentence (#1472). When present the
   * chip renders as an interactive disclosure trigger; when absent it stays the
   * passive read-state label (its original form), preserving the passivity
   * contract on read-only surfaces and all existing snapshot expectations.
   *
   * Build it with {@link pendingAcceptanceExplainer} so board and My Work never
   * drift; the board passes the configured iteration label, My Work the default.
   */
  explainer?: string;
}

/**
 * Compose the neutral, role-neutral pending-acceptance explanation sentence.
 *
 * Role-neutral by design (#1472): acceptance authority is *any* Admin/Scrum
 * Master/Product Owner holder, not one deterministic person — so the copy names
 * the outcome ("someone on the team accepts it"), never a specific role, which
 * would be wrong on a PO-run board or in cross-project My Work. The "sprint"
 * default is a lib-level fallback (not JSX copy — the iteration-label lint gate
 * targets JSX text/display attributes, not helper strings); board callers pass
 * `useIterationLabel().lower` so the noun follows the project configuration.
 *
 * @param iterationLabelLower Lowercase iteration-container noun (e.g. "sprint",
 *   "iteration"). Defaults to "sprint" for surfaces with no single project
 *   context (My Work is cross-project).
 * @returns One plain-language sentence, outcome-only, no state-machine jargon.
 */
export function pendingAcceptanceExplainer(iterationLabelLower = 'sprint'): string {
  return (
    `Added after the ${iterationLabelLower} started — it won't count toward the ` +
    'committed plan until someone on the team accepts it.'
  );
}

/** Shared neutral chip surface — identical tokens for the passive span and the
 *  interactive trigger, so the two forms are visually indistinguishable at rest
 *  (rule 149: never amber/red). */
const CHIP_SURFACE =
  'inline-flex items-center gap-0.5 rounded-chip px-1 py-px text-xs font-medium ' +
  'bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-border';

export function PendingAcceptanceChip({ compact = false, className, explainer }: Props) {
  // No explainer → the original passive label. Kept a hook-free early return so
  // read-only surfaces mount zero disclosure state and the passivity tests
  // (queryByRole('button') absent) stay green.
  if (explainer === undefined) {
    return (
      <span
        className={[CHIP_SURFACE, className ?? ''].join(' ')}
        title={
          // This shared chip also renders in cross-project "My Work" (features/me),
          // where no single project's iteration label applies — so the generic
          // "sprint" wording is intentional rather than read from useIterationLabel().
          // eslint-disable-next-line no-restricted-syntax -- see comment above
          'Added after the sprint started — awaiting acceptance. Not yet counted in the commitment.'
        }
        aria-label="Pending acceptance"
      >
        <span aria-hidden="true" className="leading-none">
          ○
        </span>
        {!compact && <span>Pending acceptance</span>}
      </span>
    );
  }

  return <InteractivePendingChip compact={compact} className={className} explainer={explainer} />;
}

/** Popover geometry. Estimated height is a constant (the copy is fixed-length)
 *  used only to decide whether to flip above — the same approach as the
 *  schedule row's portaled menu (UnscheduledTaskRow). */
const POPOVER_WIDTH = 240;
const POPOVER_EST_HEIGHT = 120;
const VIEWPORT_MARGIN = 8;

/**
 * Interactive disclosure variant (#1472). Reuses the issue-1305 worst-offender
 * "peek" interaction contract established on the board card: a real `<button>`
 * toggling an `aria-expanded` popover, Escape / "Got it" close and return focus
 * to the trigger, click-outside closes without stealing focus, and
 * `stopPropagation` so opening the explainer never selects, drags, or opens the
 * card. Tap/keyboard only — no hover path, so `aria-expanded` can never desync
 * from what is visible.
 *
 * The popover is PORTALED to `document.body` with fixed positioning (web-rule
 * 253). The chip lives inside a board column whose card stack is
 * `overflow-y-auto`; a plain in-flow `absolute` popover would be clipped by that
 * scroll container (the narrowest column, 208px, is narrower than the popover
 * itself), and `z-index` does not let a child escape an overflow-clipping
 * ancestor. Portaling escapes the clip; it also sidesteps the `<p>` phrasing
 * constraint on My Work, since the popover no longer nests inside the chip.
 */
function InteractivePendingChip({
  compact,
  className,
  explainer,
}: {
  compact: boolean;
  className?: string;
  explainer: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const noteId = useId();

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Compute the portaled popover's fixed coords from the trigger's rect: below
  // it, flipping above when there isn't room, clamped horizontally so it never
  // leaves the viewport.
  const reposition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const below = rect.bottom + 4;
    const flipUp = below + POPOVER_EST_HEIGHT > window.innerHeight - VIEWPORT_MARGIN;
    setPos({
      top: flipUp ? Math.max(VIEWPORT_MARGIN, rect.top - POPOVER_EST_HEIGHT - 4) : below,
      left: Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN),
      ),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  // Escape closes and restores focus to the trigger (mirrors the 1305 peek).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Click-outside closes without stealing focus (the user pointed elsewhere).
  // The check spans both the trigger and the portaled popover, since the popover
  // is no longer a DOM descendant of the trigger's wrapper.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // A fixed popover can't track its anchor on its own, so re-derive its coords
  // when the column/page scrolls or the viewport resizes. Repositioning (rather
  // than closing) keeps the explainer readable while the user scrolls.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  return (
    // Wrapper is a `<span>` (phrasing content) so the chip stays valid inside the
    // My Work `<p>`; the popover itself is portaled out (see the note above).
    <span className={['inline-flex', className ?? ''].join(' ')}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Pending acceptance. What does this mean?"
        aria-expanded={open}
        aria-controls={noteId}
        // Discrete tap only — keep the drag sensors and card-open handler from
        // firing when the user reaches for the explainer.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={[
          'relative',
          CHIP_SURFACE,
          // Invisible ≥44px touch target without visually enlarging the chip.
          "before:absolute before:inset-[-12px] before:content-['']",
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        ].join(' ')}
      >
        <span aria-hidden="true" className="leading-none">
          ○
        </span>
        {!compact && <span>Pending acceptance</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            role="note"
            id={noteId}
            aria-label="Pending acceptance — explanation"
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
            className="z-50 block w-max max-w-[240px] rounded-card border border-neutral-border
              bg-neutral-surface-raised px-3 py-2 text-left shadow-pop"
          >
            <span className="block text-xs leading-relaxed text-neutral-text-primary">
              {explainer}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                close(true);
              }}
              className="mt-2 inline-flex items-center rounded-control border border-neutral-border
                px-2 py-1 text-xs font-medium text-neutral-text-secondary
                hover:bg-neutral-surface-sunken hover:text-neutral-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                focus-visible:ring-offset-1"
            >
              Got it
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}
