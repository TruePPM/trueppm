import { useEffect, useMemo, useRef, type RefObject } from 'react';
import type { Task } from '@/types';
import { registry, type DrawerSectionRegistration } from '@/lib/widget-registry';
import { MetaRail } from './MetaRail';
import { CollapsibleSection } from './sections/CollapsibleSection';
import { SectionErrorBoundary } from './sections/SectionErrorBoundary';
import { registerOssDrawerSections } from './sections';

// Register OSS sections at module init — Enterprise registers in its own
// init module. Both must run before the first drawer render; both are
// idempotent so the order doesn't matter.
registerOssDrawerSections();

export interface TaskDetailDrawerProps {
  task: Task | null;
  projectId: string;
  onClose: () => void;
  /**
   * Optional context passed to each section's `canRender(ctx)` predicate.
   * Sections use this to hide entirely when a feature is not licensed/available;
   * pass the current user object so Enterprise sections can gate visibility.
   */
  sectionContext?: { user?: unknown };
}

/**
 * Right-side slide-in drawer hosting registry-driven sections (ADR-0050).
 *
 * Desktop ≥ md: 540px wide, sticky header + sticky 120px meta rail + scrollable
 * section list. Mobile < md: 85vh bottom sheet, stacked rail + sections.
 * Sections are wrapped in error boundaries so a buggy section cannot crash
 * the surrounding drawer chrome.
 */
export function TaskDetailDrawer({
  task,
  projectId,
  onClose,
  sectionContext,
}: TaskDetailDrawerProps) {
  const isOpen = task !== null;
  const drawerTitle = task ? `${task.wbs ? task.wbs + ' — ' : ''}${task.name}` : '';

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Move focus to Close on open so keyboard users land somewhere sensible.
  useEffect(() => {
    if (isOpen) {
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isOpen, task?.id]);

  // Esc closes — preserved from prior drawer.
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

  // Focus trap inside drawer when open — preserved from prior drawer.
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
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [isOpen]);

  // Read sections from the registry once per render. The registry sorts by
  // priority on register() so no sort here. Filter by canRender so Enterprise
  // sections that gate on license disappear cleanly.
  const sections = useMemo(() => {
    if (!task) return [];
    const ctx = { user: sectionContext?.user, task };
    return (registry.get('task_detail.section') as DrawerSectionRegistration[]).filter(
      (s) => !s.canRender || s.canRender(ctx),
    );
  }, [task, sectionContext?.user]);

  return (
    <>
      {/* Mobile backdrop — closes on click; desktop has no backdrop (drawer is non-modal-feeling) */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 md:hidden z-30"
          aria-hidden="true"
          onClick={onClose}
        />
      )}

      {/* Desktop: 540px right-side slide-in (ADR-0050 ux-design).
          aria-modal="true" because a Tab focus trap is active while the drawer is
          open (see the trapFocus effect) — keyboard focus cannot reach the canvas,
          so the drawer is modal in fact and must announce itself as such. */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        className={[
          'hidden md:flex fixed inset-y-0 right-0 w-[540px] flex-col',
          'bg-neutral-surface border-l border-neutral-border z-40',
          'transition-transform duration-200',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
      >
        {task && (
          <DrawerContent
            task={task}
            projectId={projectId}
            sections={sections}
            drawerTitle={drawerTitle}
            closeButtonRef={closeButtonRef}
            onClose={onClose}
          />
        )}
      </div>

      {/* Mobile: 85vh bottom sheet — preserves prior shell */}
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
        <div
          className="w-8 h-1 rounded-full bg-neutral-border mx-auto mt-3 mb-2 shrink-0"
          aria-hidden="true"
        />
        {task && (
          <DrawerContent
            task={task}
            projectId={projectId}
            sections={sections}
            drawerTitle={drawerTitle}
            closeButtonRef={closeButtonRef}
            onClose={onClose}
          />
        )}
      </div>
    </>
  );
}

interface DrawerContentProps {
  task: Task;
  projectId: string;
  sections: DrawerSectionRegistration[];
  drawerTitle: string;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/**
 * Shared chrome rendered inside both desktop side-panel and mobile bottom-sheet
 * shells. Holds the sticky header, the meta rail (sticky 120px on desktop,
 * stacked on mobile), and the scrollable section list. Default expansion
 * applies only to Overview (ADR-0050 ux-design); other sections start
 * collapsed so their TanStack Query hooks don't fire on drawer open.
 */
function DrawerContent({
  task,
  projectId,
  sections,
  drawerTitle,
  closeButtonRef,
  onClose,
}: DrawerContentProps) {
  return (
    <>
      {/* Sticky header — title + close + (future) prev/next nav */}
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 h-14 border-b border-neutral-border bg-neutral-surface shrink-0">
        <h2
          className="text-base font-semibold text-neutral-text-primary truncate pr-2"
          title={drawerTitle}
        >
          {drawerTitle}
        </h2>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close task detail"
          className="w-11 h-11 -mr-1.5 flex items-center justify-center rounded text-neutral-text-secondary
            hover:text-neutral-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          ×
        </button>
      </div>

      {/* Body — meta rail + section list. md+: 2-column grid (rail | sections);
          below md: stacked (rail above sections). */}
      <div className="flex-1 min-h-0 flex flex-col md:grid md:grid-cols-[120px_1fr] md:overflow-y-auto">
        <MetaRail task={task} />

        <div className="flex-1 min-w-0 md:overflow-visible overflow-y-auto">
          {sections.length === 0 ? (
            <div className="px-4 py-6 text-sm italic text-neutral-text-secondary">
              No sections registered.
            </div>
          ) : (
            sections.map((section, idx) => {
              const SectionComponent = section.component;
              return (
                <SectionErrorBoundary key={section.id} sectionTitle={section.title}>
                  <CollapsibleSection id={section.id} title={section.title} defaultOpen={idx === 0}>
                    {() => <SectionComponent taskId={task.id} projectId={projectId} />}
                  </CollapsibleSection>
                </SectionErrorBoundary>
              );
            })
          )}
        </div>
      </div>

      {/* Esc-to-close hint footer */}
      <div className="px-4 py-2 border-t border-neutral-border bg-neutral-surface-raised text-xs text-neutral-text-secondary shrink-0 hidden md:block">
        <span className="tppm-mono">Esc</span> to close
      </div>
    </>
  );
}
