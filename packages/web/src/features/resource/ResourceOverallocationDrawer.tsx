/**
 * ResourceOverallocationDrawer — slide-in drawer showing overallocation detail
 * for a specific resource on a specific date.
 *
 * Opens when the user activates (click or Enter/Space) an overallocated cell
 * (load > 100% of capacity) in the ResourceGrid.
 *
 * Design rules:
 * - Rule 89: right-side 480px drawer on desktop, 85vh bottom sheet on mobile
 * - Rule 4: focus trap — Tab/Shift+Tab stays inside drawer; Escape closes
 * - Aria: role="dialog" aria-modal aria-label={title}
 */

import { useEffect, useRef } from 'react';
import { capacityHours, loadPercent } from './resourceUtils';
import type { UtilizationDayEntry } from './resourceUtils';

export interface OverallocationTarget {
  resourceId: string;
  resourceName: string;
  iso: string; // YYYY-MM-DD
  entry: UtilizationDayEntry;
  hoursPerDay: number;
  maxUnits: number;
}

interface Props {
  target: OverallocationTarget | null;
  isOpen: boolean;
  onClose: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function ResourceOverallocationDrawer({ target, isOpen, onClose }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Focus close button on open
  useEffect(() => {
    if (isOpen) {
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Focus trap
  useEffect(() => {
    if (!isOpen) return undefined;
    function trapFocus(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [isOpen]);

  const capacity = target ? capacityHours(target.hoursPerDay, target.maxUnits) : 0;
  const pct = target ? loadPercent(target.entry.hours, capacity) : 0;
  const overHours = target ? Math.max(0, target.entry.hours - capacity) : 0;
  const drawerTitle = target
    ? `Overallocation — ${target.resourceName} on ${formatDate(target.iso)}`
    : 'Overallocation';

  const DrawerBody = () => (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-border flex-shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-neutral-text-primary">{drawerTitle}</h2>
          {target && (
            <p className="text-xs text-semantic-critical mt-0.5">
              {Math.round(pct)}% load — {overHours.toFixed(1)}h over {capacity.toFixed(1)}h capacity
            </p>
          )}
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close overallocation drawer"
          className="
            w-8 h-8 flex items-center justify-center rounded
            text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1
          "
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {!target && (
          <p className="text-xs text-neutral-text-secondary">No overallocation selected.</p>
        )}

        {target && (
          <>
            {/* Load summary */}
            <section className="mb-5">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary mb-3">
                Load summary
              </h3>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-neutral-text-secondary">Hours scheduled</dt>
                  <dd className="font-medium text-neutral-text-primary">{target.entry.hours.toFixed(1)}h</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-text-secondary">Capacity</dt>
                  <dd className="font-medium text-neutral-text-primary">{capacity.toFixed(1)}h</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-text-secondary">Overallocation</dt>
                  <dd className="font-medium text-semantic-critical">+{overHours.toFixed(1)}h</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-text-secondary">Load</dt>
                  <dd className="font-medium text-semantic-critical">{Math.round(pct)}%</dd>
                </div>
              </dl>
            </section>

            {/* Contributing tasks */}
            {target.entry.tasks.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary mb-3">
                  Contributing tasks ({target.entry.tasks.length})
                </h3>
                <ul className="space-y-1.5">
                  {target.entry.tasks.map((taskId) => (
                    <li
                      key={taskId}
                      className="text-xs text-neutral-text-primary bg-neutral-surface-raised rounded px-3 py-2 font-mono"
                    >
                      {taskId}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-neutral-text-secondary">
                  To resolve, reassign or delay one of the contributing tasks so this
                  resource is not scheduled beyond their daily capacity.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Backdrop — mobile only */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 md:hidden z-30"
          aria-hidden="true"
          onClick={onClose}
        />
      )}

      {/* Desktop: right-side drawer (rule 89) */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        className={[
          'hidden md:flex fixed inset-y-0 right-0 w-[480px] flex-col',
          'bg-neutral-surface border-l border-neutral-border z-40',
          'transition-transform duration-200',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
      >
        <DrawerBody />
      </div>

      {/* Mobile: bottom sheet (rule 89) */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        className={[
          'md:hidden fixed inset-x-0 bottom-0 z-40',
          'rounded-t-xl bg-neutral-surface border-t border-neutral-border',
          'h-[85vh] flex flex-col',
          'transition-transform duration-200',
          isOpen ? 'translate-y-0' : 'translate-y-full',
        ].join(' ')}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1 flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-neutral-border" aria-hidden="true" />
        </div>
        <DrawerBody />
      </div>
    </>
  );
}
