import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useCardPopoverPosition } from './useCardPopoverPosition';
import { BottomSheet } from '@/components/ui/BottomSheet';

export interface CardPopoverShellProps {
  /** Anchor element on desktop — the originating board card. */
  anchor: HTMLElement | null;
  /** When true, render the mobile bottom-sheet shell; else the anchored desktop popover. */
  isMobile: boolean;
  /** Stable id used for `aria-labelledby` wiring to the body's title. */
  titleId: string;
  /** Close handler — fires on Esc, click outside, scrim tap. */
  onClose: () => void;
  /** Body + footer rendered inside the shell. */
  children: ReactNode;
}

/**
 * Two shells, one body. Desktop renders an anchored, viewport-clamped
 * popover (`aria-modal="false"` — board remains keyboard-navigable). Mobile
 * (< md, 768px) renders a bottom sheet with a scrim and a focus trap
 * (`aria-modal="true"`). The body is identical across both — variation
 * pickers live in `index.tsx`.
 *
 * Closes on Escape and on `pointerdown` outside. The "click outside"
 * listener excludes both the popover content and the originating anchor
 * card — clicking the anchor would otherwise immediately re-open the
 * popover that just closed.
 */
export function CardPopoverShell({
  anchor,
  isMobile,
  titleId,
  onClose,
  children,
}: CardPopoverShellProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  // Measure popover height before showing so the position hook can clamp /
  // flip; render hidden on first frame to avoid a visible jump.
  const [measuredHeight, setMeasuredHeight] = useState(0);

  useLayoutEffect(() => {
    if (!popoverRef.current || isMobile) return;
    setMeasuredHeight(popoverRef.current.offsetHeight);
  }, [isMobile, children]);

  const position = useCardPopoverPosition(isMobile ? null : anchor, measuredHeight);

  // Esc closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Click outside (desktop): close when pointerdown lands outside the
  // popover AND outside the anchor card. Mobile uses the explicit scrim
  // owned by `<BottomSheet>`.
  useEffect(() => {
    if (isMobile) return undefined;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [anchor, isMobile, onClose]);

  // Focus trap, scrim, and Escape on mobile are owned by `<BottomSheet>` —
  // see `components/ui/BottomSheet.tsx`. This component owns only the
  // desktop anchored variant.

  if (isMobile) {
    return (
      <BottomSheet isOpen onClose={onClose} titleId={titleId}>
        <div className="relative pb-2">{children}</div>
      </BottomSheet>
    );
  }

  // Desktop: anchored, viewport-clamped popover. Hidden until the first
  // measurement settles to avoid a flash at (0,0).
  const visible = position !== null;
  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="hidden md:block fixed z-50 w-[360px] bg-neutral-surface border border-neutral-border rounded-card overflow-hidden motion-safe:transition-opacity motion-safe:duration-150"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      {children}
    </div>
  );
}
