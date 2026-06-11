import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/Button';
import { useIterationLabel } from '@/hooks/useIterationLabel';

/**
 * Pull-to-commit popover anchored above a task bar on the Schedule canvas (ADR-0067).
 *
 * Mounted after the user releases a drag or resize. Holds the pending change
 * until Confirm fires the PATCH or Cancel/Esc/click-outside reverts. Desktop-only
 * (rendered with `hidden lg:block` per ADR-0064); touch is deferred to #481.
 *
 * Esc inside this popover takes priority over the hover-chain reset (ADR-0066)
 * and build-mode focus rollback (ADR-0054) — the listener captures at the
 * window level and stops propagation.
 */

export type CommitAction =
  | {
      kind: 'reschedule';
      oldStartIso: string;
      newStartIso: string;
    }
  | {
      kind: 'resize';
      oldDurationDays: number;
      newDurationDays: number;
    };

export interface ScheduleCommitPopoverProps {
  /** Viewport-coordinate anchor — center-x and top-y of the pending bar. */
  anchor: { x: number; y: number };
  /** Sprint name to surface when the task is committed to an ACTIVE sprint. */
  activeSprintName: string | null;
  action: CommitAction;
  /** Drives the Confirm button spinner + disabled state during the in-flight PATCH. */
  isPending: boolean;
  /** Inline error after a failed mutation; switches Confirm to "Retry". */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** Fired when the user clicks outside the popover; the host surfaces the toast. */
  onDismissByOutsideClick: () => void;
}

const POPOVER_WIDTH = 288;
const VIEWPORT_PAD = 8;
const POINTER_TRIANGLE_HEIGHT = 6;

function formatShortDate(iso: string): string {
  // Parse as UTC midnight to match the canvas's date arithmetic (rule 56).
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function ScheduleCommitPopover({
  anchor,
  activeSprintName,
  action,
  isPending,
  error,
  onConfirm,
  onCancel,
  onDismissByOutsideClick,
}: ScheduleCommitPopoverProps) {
  const itl = useIterationLabel();
  const popoverRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Place popover at a sensible spot before the first paint to avoid flicker.
  const [position, setPosition] = useState<{ top: number; left: number; flipped: boolean }>(() => ({
    top: anchor.y - POINTER_TRIANGLE_HEIGHT - 80,
    left: anchor.x - POPOVER_WIDTH / 2,
    flipped: false,
  }));

  // Measure the popover and clamp/flip to keep it inside the viewport.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchor.x - rect.width / 2;
    let flipped = false;
    let top = anchor.y - rect.height - POINTER_TRIANGLE_HEIGHT;

    if (top < VIEWPORT_PAD) {
      // Flip to below the bar — assume bar height ~18 (rule 14) when anchor.y is the bar top.
      top = anchor.y + 18 + POINTER_TRIANGLE_HEIGHT;
      flipped = true;
    }

    if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
    if (left + rect.width > vw - VIEWPORT_PAD) left = vw - VIEWPORT_PAD - rect.width;
    if (top + rect.height > vh - VIEWPORT_PAD) top = vh - VIEWPORT_PAD - rect.height;

    setPosition({ top, left, flipped });
  }, [anchor.x, anchor.y]);

  // Initial focus to Confirm — Sarah's MS Project muscle memory expects the
  // primary action to be ready under Enter (ADR-0067 ux-design spec).
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  // Esc cancels regardless of focus location. Capture at the window level so
  // we take priority over the hover-chain Esc (ADR-0066) and the build-mode
  // focus rollback (ADR-0054).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter') {
        // Only intercept Enter when our own elements are focused; otherwise
        // unrelated text inputs (e.g. inline rename) would lose Enter handling.
        const target = e.target as HTMLElement | null;
        if (popoverRef.current?.contains(target)) {
          e.preventDefault();
          e.stopPropagation();
          if (!isPending) onConfirm();
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onCancel, onConfirm, isPending]);

  // Click-outside cancels with a discoverable toast.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        onDismissByOutsideClick();
      }
    };
    // Listen on mousedown so we fire before any inner click registers.
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onDismissByOutsideClick]);

  // Focus trap — Tab cycles Cancel ↔ Confirm only.
  useEffect(() => {
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const c = cancelRef.current;
      const k = confirmRef.current;
      if (!c || !k) return;
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === c) {
          e.preventDefault();
          k.focus();
        } else if (active === k) {
          e.preventDefault();
          c.focus();
        }
      } else {
        if (active === c) {
          e.preventDefault();
          k.focus();
        } else if (active === k) {
          e.preventDefault();
          c.focus();
        }
      }
    };
    window.addEventListener('keydown', trap);
    return () => window.removeEventListener('keydown', trap);
  }, []);

  const title = action.kind === 'reschedule' ? 'Reschedule task?' : 'Resize task?';
  const verb = action.kind === 'reschedule' ? 'Reschedule' : 'Resize';

  const changeText =
    action.kind === 'reschedule'
      ? `${formatShortDate(action.oldStartIso)} → ${formatShortDate(action.newStartIso)}`
      : `${action.oldDurationDays}d → ${action.newDurationDays}d`;

  const triangleStyle: CSSProperties = position.flipped
    ? {
        top: -POINTER_TRIANGLE_HEIGHT,
        left: Math.max(12, Math.min(POPOVER_WIDTH - 12, anchor.x - position.left)),
        borderBottom: `${POINTER_TRIANGLE_HEIGHT}px solid var(--color-neutral-surface, #ffffff)`,
        borderLeft: '6px solid transparent',
        borderRight: '6px solid transparent',
      }
    : {
        bottom: -POINTER_TRIANGLE_HEIGHT,
        left: Math.max(12, Math.min(POPOVER_WIDTH - 12, anchor.x - position.left)),
        borderTop: `${POINTER_TRIANGLE_HEIGHT}px solid var(--color-neutral-surface, #ffffff)`,
        borderLeft: '6px solid transparent',
        borderRight: '6px solid transparent',
      };

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="schedule-commit-title"
      aria-describedby="schedule-commit-change"
      // ADR-0064 — Schedule canvas overlays are desktop-only.
      className="fixed z-[70] hidden lg:block bg-neutral-surface border border-neutral-border rounded-lg p-3"
      style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
    >
      <div id="schedule-commit-title" className="text-sm font-semibold text-neutral-text-primary">
        {title}
      </div>

      <div
        id="schedule-commit-change"
        className="mt-1 text-xs text-neutral-text-secondary tppm-mono"
      >
        {changeText}
      </div>

      {activeSprintName !== null && (
        <div
          className="mt-2 border-l-2 border-semantic-at-risk bg-semantic-at-risk-bg text-semantic-at-risk pl-2 py-1 pr-2 text-xs truncate"
          data-testid="commit-popover-active-sprint-notice"
          title={`Committed in ${itl.singular} ${activeSprintName}`}
        >
          Committed in {itl.singular} <span className="font-medium">{activeSprintName}</span>
        </div>
      )}

      {error !== null && (
        <div
          role="alert"
          className="mt-2 text-xs text-semantic-critical"
          data-testid="commit-popover-error"
        >
          {error}
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="border border-neutral-border text-neutral-text-primary px-3 h-8 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Cancel
        </button>
        <Button ref={confirmRef} variant="primary" onClick={onConfirm} disabled={isPending}>
          {isPending ? 'Saving…' : error !== null ? 'Retry' : verb}
        </Button>
      </div>

      {/* Triangle pointer to the new bar */}
      <span aria-hidden="true" className="absolute w-0 h-0" style={triangleStyle} />
    </div>,
    document.body,
  );
}
