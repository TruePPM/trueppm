import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';

/**
 * Shared "anchored popover" positioning + dismissal mechanics (web-rule 253).
 *
 * A floating panel (menu / listbox / disclosure) that opens next to a trigger
 * must escape any `overflow-hidden` / `overflow-y-auto` ancestor and never spill
 * off a narrow (phone) viewport. The proven pattern — established inline in
 * `features/schedule/UnscheduledTaskRow.tsx` and
 * `features/board/PendingAcceptanceChip.tsx` — is:
 *
 *   1. Portal the panel to `document.body` (a `z-index` bump can NOT let a child
 *      escape an overflow-clipping ancestor; only leaving the subtree can).
 *   2. Position it `fixed`, computed from the trigger's `getBoundingClientRect()`:
 *      below the trigger, FLIPPING above when there is not enough room, and
 *      CLAMPED horizontally so it never leaves the viewport.
 *   3. Because a `fixed` panel cannot track its anchor, re-derive its coords on
 *      scroll (capture phase, so nested scroll containers count) and resize.
 *   4. Dismiss on an outside pointer-down that spans BOTH the trigger and the
 *      portaled panel — once portaled they are no longer DOM-nested, so a single
 *      `containerRef.contains` check would treat clicks inside the panel as
 *      "outside" and close it.
 *
 * This hook owns exactly those four concerns and nothing else. Each call site
 * keeps its own contents, keyboard model (roving `aria-activedescendant`,
 * two-stage Escape, etc.), and open-state ownership — the hook never renders the
 * portal, so the caller writes `popoverStyle && createPortal(<panel />, body)`.
 * Escape is intentionally NOT handled here: sites with a search box run a
 * two-stage Escape (clear query, then close) inside their own input handler, and
 * a duplicate document listener would double-fire (the rule-204 lesson).
 */
export interface AnchoredPopoverOptions {
  /** Whether the popover is currently open (the caller owns this state). */
  open: boolean;
  /**
   * Panel width in px, or `'trigger'` to match the anchor element's width
   * (for full-width dropdowns). Always clamped to the viewport width so a fixed
   * width wider than a phone still fits.
   */
  width: number | 'trigger';
  /**
   * Estimated panel height in px, used only to decide whether to flip above when
   * the trigger is near the viewport bottom. Once the panel has mounted its real
   * measured height refines the decision on the next reposition; an estimate is
   * enough because the vertical clamp keeps the panel on-screen either way.
   */
  estimatedHeight: number;
  /**
   * Which trigger edge the panel's horizontal position aligns to before
   * clamping. `'left'` (default) drops from the trigger's left; `'right'` aligns
   * the panel's right edge to the trigger's right (right-aligned menus). Ignored
   * when `width === 'trigger'` (the panel spans the anchor).
   */
  align?: 'left' | 'right';
  /** Gap in px between the trigger and the panel. Default 4. */
  gap?: number;
  /** Minimum gap in px to keep between the panel and every viewport edge. Default 8. */
  margin?: number;
  /**
   * Called on an outside pointer-down (spanning trigger + panel). The caller
   * closes and does any site-specific cleanup (e.g. clearing a search query).
   * Omit to keep the site's own dismissal (e.g. `onBlur`). Focus handling is the
   * caller's — an outside click means the user chose to look away, so the
   * references do NOT return focus to the trigger here.
   */
  onDismiss?: () => void;
}

export interface AnchoredPopover<T extends HTMLElement, P extends HTMLElement> {
  /** Attach to the element the panel anchors to (a button, or a wrapping row). */
  triggerRef: RefObject<T | null>;
  /** Attach to the portaled panel's root — required for the outside-dismiss span. */
  popoverRef: RefObject<P | null>;
  /**
   * Ready to spread onto the portaled panel: `{ position: 'fixed', top, left,
   * width }`. `null` while closed or before the first measure — render the portal
   * only when this is non-null.
   */
  popoverStyle: CSSProperties | null;
  /** Recompute coords now (rarely needed; scroll/resize are already wired). */
  reposition: () => void;
}

/**
 * Off-screen placeholder used for the single synchronous render between `open`
 * flipping true and the `useLayoutEffect` measuring real coords (which happens
 * before paint, so this position is never visible). Returning it — rather than
 * `null` — keeps the portal mounted from the FIRST render when open, so a panel
 * that focuses its own input on open (comboboxes) has that input in the DOM in
 * the same commit, not a frame later.
 */
const OFFSCREEN: CSSProperties = { position: 'fixed', top: -9999, left: -9999 };

export function useAnchoredPopover<
  T extends HTMLElement = HTMLElement,
  P extends HTMLElement = HTMLElement,
>({
  open,
  width,
  estimatedHeight,
  align = 'left',
  gap = 4,
  margin = 8,
  onDismiss,
}: AnchoredPopoverOptions): AnchoredPopover<T, P> {
  const triggerRef = useRef<T>(null);
  const popoverRef = useRef<P>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const reposition = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Never let a fixed width exceed the viewport (replaces the old
    // `max-w-[calc(100vw-2rem)]` cap so a 260px panel still fits a 375px phone).
    const desired = width === 'trigger' ? rect.width : width;
    const resolvedWidth = Math.min(desired, vw - margin * 2);

    // Prefer the mounted panel's real height; fall back to the estimate on the
    // first open (before it has rendered).
    const height = popoverRef.current?.offsetHeight || estimatedHeight;

    // Vertical: below the anchor, flipping above when there is not enough room.
    const below = rect.bottom + gap;
    const flipUp = below + height > vh - margin;
    const top = flipUp ? Math.max(margin, rect.top - height - gap) : below;

    // Horizontal: align to a trigger edge, then clamp inside the viewport.
    const rawLeft = align === 'right' ? rect.right - resolvedWidth : rect.left;
    const left = Math.max(margin, Math.min(rawLeft, vw - resolvedWidth - margin));

    setStyle({ position: 'fixed', top, left, width: resolvedWidth });
  }, [width, estimatedHeight, align, gap, margin]);

  // Measure when opening; clear when closed so the portal unmounts.
  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  // A fixed panel can't follow its anchor, so re-derive coords while open on any
  // scroll (capture phase catches nested scroll containers) or viewport resize.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  // Outside pointer-down dismissal spanning trigger + portaled panel.
  useEffect(() => {
    if (!open || !onDismiss) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      onDismiss?.();
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, onDismiss]);

  // Non-null from the first render when open (OFFSCREEN until measured), so the
  // portal mounts immediately; null when closed so it unmounts.
  return { triggerRef, popoverRef, popoverStyle: open ? (style ?? OFFSCREEN) : null, reposition };
}
