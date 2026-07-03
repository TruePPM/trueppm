import { useEffect, useRef, type ReactNode } from 'react';

export interface BottomSheetProps {
  /** When false, renders nothing (parent controls open/close). */
  isOpen: boolean;
  onClose: () => void;
  /** Used for `aria-labelledby`; the id of the heading inside `children`. */
  titleId?: string;
  /** Used for `aria-label` when no `titleId` is provided. */
  ariaLabel?: string;
  /** Body content. */
  children: ReactNode;
  /**
   * Sheet height. `'auto'` (default) lets content size up to `max-h-[85vh]`.
   * `'full'` fills the viewport — appropriate for forms with a software
   * keyboard, where reserving 15vh for a "peek" gets eaten by the keyboard
   * anyway. `'large'` matches the existing 85vh convention used by other
   * mobile sheets.
   */
  size?: 'auto' | 'large' | 'full';
  /** Show the small drag handle above the content. Default true. */
  hasDragHandle?: boolean;
  /**
   * Render-only on viewports below `md` (768px). Default true. Set false to
   * render across all viewports (rare — used by callers that need a sheet
   * regardless of width, e.g. a forced mobile preview).
   */
  mobileOnly?: boolean;
}

/**
 * Mobile bottom-sheet shell — extracted from the shared pattern that emerged
 * across `RiskDrawer.tsx` and `BoardCardPopover/CardPopoverShell.tsx`. Owns
 * the scrim, slide-up transition, drag-handle, focus trap, and Escape
 * handler. Callers supply only their own content.
 *
 * The sheet is `aria-modal="true"` (focus trap active) and announces via
 * either `titleId` (preferred — points at a heading inside `children`) or
 * `ariaLabel` (fallback when no heading is in scope).
 *
 * Scrim tap and Escape both fire `onClose`. The drag-handle is decorative
 * — there is no swipe-to-dismiss gesture (scrim tap is the discoverable
 * dismiss). Adding swipe-to-dismiss is out of scope here; track if a
 * usability issue surfaces.
 */
export function BottomSheet({
  isOpen,
  onClose,
  titleId,
  ariaLabel,
  children,
  size = 'auto',
  hasDragHandle = true,
  mobileOnly = true,
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Focus trap. Tab cycles within the sheet; Shift+Tab from the first
  // focusable lands on the last; Tab from the last lands on the first.
  useEffect(() => {
    if (!isOpen) return undefined;
    function onTab(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !sheetRef.current) return;
      const focusable = sheetRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onTab);
    return () => document.removeEventListener('keydown', onTab);
  }, [isOpen]);

  if (!isOpen) return null;

  const visibilityClass = mobileOnly ? 'md:hidden' : '';
  const heightClass = size === 'full'
    ? 'inset-0 rounded-none'
    : size === 'large'
      ? 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-card'
      : 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-card';

  return (
    <>
      <div
        aria-hidden="true"
        className={[
          visibilityClass,
          'fixed inset-0 z-40 bg-neutral-overlay motion-safe:animate-scrim-fade',
        ].join(' ')}
        onPointerDown={onClose}
        data-testid="bottom-sheet-scrim"
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : ariaLabel}
        className={[
          visibilityClass,
          'fixed z-50 overflow-y-auto bg-neutral-surface border-t border-neutral-border',
          'motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out',
          heightClass,
        ].join(' ')}
      >
        {hasDragHandle && (
          <div
            aria-hidden="true"
            className="w-8 h-1 rounded-full bg-neutral-border mx-auto mt-2.5 mb-1.5 shrink-0"
            data-testid="bottom-sheet-drag-handle"
          />
        )}
        {children}
      </div>
    </>
  );
}
