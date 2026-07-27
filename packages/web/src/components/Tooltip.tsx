import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';

/**
 * Grace period before a pointer-leave closes the tooltip. Long enough that
 * crossing a 1px gap between the trigger and the panel does not flicker it shut,
 * short enough that it never feels stuck open.
 */
const CLOSE_GRACE_MS = 120;

/** Max panel width. The box shrinks to its text; this only bounds a long line. */
const MAX_WIDTH = 260;

/**
 * A focus landing within this long after a pointer-down on the same trigger is
 * treated as pointer-driven, not keyboard-driven. Comfortably longer than the
 * gap a browser leaves between `pointerdown` and `focus`, and far shorter than
 * any real interval between clicking something and tabbing to it.
 */
const POINTER_FOCUS_WINDOW_MS = 300;

export interface TooltipProps {
  /**
   * The explanation, in plain English. **Text only** — the moment this needs a
   * link or a control it is a `FieldHelp`-style `role="dialog"` popover instead
   * (web-rule 121), because an `aria-describedby` tooltip's link is unreachable.
   */
  content: string;
  /**
   * Whether to wire `aria-describedby` from the trigger to the panel.
   *
   * Default `true` — the tooltip adds information the accessible name does not
   * already carry. Pass `false` when the trigger's own `aria-label` already says
   * the same thing (the `WF` → "Waterfall workspace" case): the panel then
   * renders `aria-hidden`, so assistive tech hears the explanation once from the
   * label instead of twice. That is not a downgrade — it is the entire point of
   * the affordance, which exists to give *sighted* users the string screen-reader
   * users already had.
   */
  describe?: boolean;
  /**
   * The trigger. A single element that can hold a ref and event handlers.
   * A non-focusable element (a `<span>` chip) is given `tabIndex={0}` so the
   * keyboard path works; a native `<button>` keeps its own tab stop.
   */
  children: ReactElement<Record<string, unknown>>;
}

type ChildProps = Record<string, unknown> & { ref?: Ref<HTMLElement> };

/** Elements that already take focus without help — everything else needs tabIndex. */
const NATIVELY_FOCUSABLE = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);

/**
 * The shared hover/focus/touch explanation affordance (web-rule 287).
 *
 * Reach for it when a token on screen cannot be decoded from what is visible: a
 * two-letter code (`WF`), a percentile (`P80`), a domain abbreviation (`WBS`,
 * `CPI`), or an icon-only control. Do **not** reach for it to restate a visible
 * label — a tooltip on "Save" is noise.
 *
 * Why it exists at all: the codebase repeatedly added an `aria-label` to satisfy
 * WCAG 1.4.1 and stopped there, so a screen-reader user heard "Waterfall
 * workspace" and a sighted mouse user got nothing at all from the same chip
 * (#2389). This closes that half of the gap, and it deliberately does **not**
 * replace the `aria-label` — it supplements it.
 *
 * Five invariants a call site must preserve:
 *
 * 1. **Three input paths, not one.** Hover, keyboard focus, and touch all open
 *    it. `group-hover` never fires on a touch device, which is why a Tailwind
 *    hover class is not an acceptable substitute (the `PinToggle` bug class).
 * 2. **Text only.** `content` is typed `string` on purpose. Interactive content
 *    inside an `aria-describedby` target is unreachable (rule 121) — that case
 *    is a `FieldHelp` popover.
 * 3. **Never the sole carrier of meaning.** A tooltip is not exposed on a touch
 *    device's screen reader in every combination, and a `title` is worse. The
 *    trigger keeps its own accessible name; this adds the sighted channel.
 * 4. **Positioning is delegated** to `useAnchoredPopover` (rule 260) — no
 *    hand-rolled flip/clamp math, and the panel is portaled so it escapes any
 *    `overflow-hidden` ancestor (rule 253).
 * 5. **Escape peels one layer.** A capture-phase document listener closes the
 *    tooltip and stops the event, so Escape inside a modal dismisses the tooltip
 *    without also closing the modal (the rule-263f pattern).
 */
export function Tooltip({ content, describe = true, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerDownAt = useRef(0);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const closeNow = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);

  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<HTMLElement, HTMLDivElement>({
    open,
    width: MAX_WIDTH,
    // One or two lines of text at this width; the hook refines the flip decision
    // from the panel's real height once it has mounted.
    estimatedHeight: 44,
    onDismiss: closeNow,
  });

  // Clear a pending close on unmount so a timer never fires into a dead tree.
  useEffect(() => cancelClose, [cancelClose]);

  // Escape dismisses. Capture phase + stopPropagation so a tooltip open inside a
  // modal peels off on its own without the modal's focus trap also closing.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeNow();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, closeNow]);

  if (!isValidElement(children)) return children;

  const childProps = children.props as ChildProps;
  const childType = typeof children.type === 'string' ? children.type : '';
  const needsTabStop =
    !NATIVELY_FOCUSABLE.has(childType) && childProps.tabIndex === undefined;

  function handlePointerEnter(e: PointerEvent<HTMLElement>) {
    // A touch "hover" is synthesized on tap and would double-fire with the
    // pointer-down path below, so touch is handled there and only there.
    if (e.pointerType === 'touch') return;
    cancelClose();
    setOpen(true);
  }

  function handlePointerLeave() {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
  }

  function handlePointerDown(e: PointerEvent<HTMLElement>) {
    // Remember that this focus, if one follows, came from a pointer — see
    // `handleFocus`. Recorded for every pointer type, not just touch.
    pointerDownAt.current = Date.now();
    // Touch: tap toggles. This is the path `group-hover` can never serve, and
    // it is why the affordance is a component rather than a utility class.
    if (e.pointerType !== 'touch') return;
    cancelClose();
    setOpen((v) => !v);
  }

  function handleFocus() {
    // Keyboard focus opens; the focus a mouse click incidentally moves onto a
    // button does not, so clicking a control does not strand an explanation over
    // it after the pointer leaves.
    //
    // This deliberately does NOT test `:focus-visible`. That pseudo-class is the
    // obvious tool and the wrong one here: jsdom answers `false` for it under
    // every condition, so the keyboard path — the entire point of this component
    // — would silently regress with a green test suite. Pointer recency answers
    // the actual question ("did a pointer put focus here?") in both environments.
    if (Date.now() - pointerDownAt.current < POINTER_FOCUS_WINDOW_MS) return;
    cancelClose();
    setOpen(true);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLElement>) {
    // Escape from the trigger itself, before the document listener sees it —
    // covers the case where the panel has not opened yet.
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      closeNow();
    }
  }

  const childRef = childProps.ref;

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      if (typeof childRef === 'function') childRef(node);
      else if (childRef && typeof childRef === 'object') {
        (childRef as { current: HTMLElement | null }).current = node;
      }
    },
    tabIndex: needsTabStop ? 0 : childProps.tabIndex,
    'aria-describedby': describe && open ? panelId : childProps['aria-describedby'],
    onPointerEnter: handlePointerEnter,
    onPointerLeave: handlePointerLeave,
    onPointerDown: handlePointerDown,
    onFocus: handleFocus,
    onBlur: closeNow,
    onKeyDown: handleKeyDown,
  } as Partial<ChildProps>);

  return (
    <>
      {trigger}
      {popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            id={panelId}
            role="tooltip"
            // Redundant with the trigger's own accessible name — see `describe`.
            aria-hidden={describe ? undefined : true}
            style={{
              ...popoverStyle,
              // The hook sizes the panel to MAX_WIDTH so its flip/clamp math has
              // a width to work with; a tooltip should hug its text, so the box
              // shrinks and keeps that figure as a ceiling. Worst case a short
              // tooltip sits slightly further from a clamped viewport edge than
              // it strictly needs to — invisible, and cheaper than re-deriving
              // the positioning this hook already owns (rule 260).
              width: 'auto',
              maxWidth: popoverStyle.width,
            }}
            className="pointer-events-none z-50 rounded-control border border-neutral-border bg-neutral-surface-raised px-2 py-1 text-xs leading-snug text-neutral-text-primary shadow-pop motion-safe:animate-empty-state-in"
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
