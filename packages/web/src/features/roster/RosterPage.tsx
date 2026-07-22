/**
 * Project roster page — two-pane layout (list + detail) on desktop,
 * single-pane with FAB → bottom sheet on mobile.
 *
 * Route: /projects/:projectId/resources/roster
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjectResourcePool, useAddProjectResource } from '@/hooks/useProjectResourcePool';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { RosterList } from './RosterList';
import { RosterDetailPanel } from './RosterDetailPanel';
import { AddToRosterCombobox } from './AddToRosterCombobox';
import type { ProjectResource } from '@/types';

export function RosterPage() {
  const projectId = useProjectId() ?? '';
  const { data: roster = [], isLoading } = useProjectResourcePool(projectId);
  const addMutation = useAddProjectResource(projectId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [showAddCombobox, setShowAddCombobox] = useState(false);

  // The desktop popover (toolbar) and the mobile BottomSheet share this open
  // state but must be mutually exclusive by viewport: the BottomSheet's
  // focus-into-sheet effect runs on mount, so if it mounted (invisibly) on
  // desktop it would steal focus from the desktop popover's search input.
  const isMobile = useBreakpoint() === 'sm';

  const selectedItem: ProjectResource | undefined = roster.find((pr) => pr.id === selectedId);

  function handleAdd(resourceId: string) {
    setShowAddCombobox(false);
    addMutation.mutate(
      { projectId, resourceId },
      {
        onSuccess: (added) => {
          setSelectedId(added.id);
        },
      },
    );
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col">
        <RosterPageToolbar
          filterQuery={filterQuery}
          onFilterChange={setFilterQuery}
          onAddClick={() => setShowAddCombobox(true)}
          showAddCombobox={showAddCombobox}
          onAddDismiss={() => setShowAddCombobox(false)}
          onAddSelect={handleAdd}
          projectId={projectId}
        />
        <div className="flex-1 flex items-center justify-center">
          {/* Skeleton rows */}
          <div className="flex flex-col gap-2 w-full max-w-sm px-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <RosterPageToolbar
        filterQuery={filterQuery}
        onFilterChange={setFilterQuery}
        onAddClick={() => setShowAddCombobox(true)}
        showAddCombobox={showAddCombobox}
        onAddDismiss={() => setShowAddCombobox(false)}
        onAddSelect={handleAdd}
        projectId={projectId}
      />

      {/* Two-pane layout: list (left) + detail (right) */}
      <div className="flex-1 flex overflow-hidden">
        {/* List pane */}
        <div
          className={[
            'overflow-y-auto border-r border-neutral-border',
            // On desktop: fixed width. On mobile: full-width unless detail is open.
            selectedItem
              ? 'hidden md:block md:w-72 lg:w-80 shrink-0'
              : 'flex-1 md:w-72 lg:w-80 md:flex-none md:shrink-0',
          ].join(' ')}
        >
          <RosterList
            items={roster}
            selectedId={selectedId}
            onSelect={setSelectedId}
            filterQuery={filterQuery}
          />
        </div>

        {/* Detail pane */}
        {selectedItem ? (
          <div className="flex-1 overflow-y-auto">
            <RosterDetailPanel
              projectResource={selectedItem}
              onClose={() => setSelectedId(null)}
            />
          </div>
        ) : (
          <div className="hidden md:flex flex-1 items-center justify-center text-sm text-neutral-text-disabled">
            Select a team member to see details
          </div>
        )}
      </div>

      {/* Mobile FAB — adds to roster */}
      <button
        type="button"
        onClick={() => setShowAddCombobox(true)}
        aria-label="Add team member"
        className="md:hidden fixed bottom-16 right-4 w-14 h-14 rounded-full
          bg-brand-primary border border-brand-primary
          text-neutral-text-inverse flex items-center justify-center
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2
          z-30"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      {/* Mobile add bottom sheet — the shared BottomSheet owns the scrim-tap
          dismiss (onPointerDown), focus trap, and Escape handler. A phone has no
          Escape key, so the visible Cancel button below is the discoverable
          dismiss for touch; without either, a touch user who opened the sheet was
          trapped until they added someone (#2164). */}
      <BottomSheet
        isOpen={showAddCombobox && isMobile}
        onClose={() => setShowAddCombobox(false)}
        ariaLabel="Add team member"
      >
        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-text-primary">Add team member</h2>
            <button
              type="button"
              onClick={() => setShowAddCombobox(false)}
              className="min-h-11 px-3 -mr-1 rounded text-sm font-medium
                text-neutral-text-secondary hover:text-neutral-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Cancel
            </button>
          </div>
          <AddToRosterCombobox
            projectId={projectId}
            onSelect={handleAdd}
            onDismiss={() => setShowAddCombobox(false)}
          />
        </div>
      </BottomSheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

interface RosterPageToolbarProps {
  filterQuery: string;
  onFilterChange: (q: string) => void;
  onAddClick: () => void;
  showAddCombobox: boolean;
  onAddDismiss: () => void;
  onAddSelect: (resourceId: string) => void;
  projectId: string;
}

function RosterPageToolbar({
  filterQuery,
  onFilterChange,
  onAddClick,
  showAddCombobox,
  onAddDismiss,
  onAddSelect,
  projectId,
}: RosterPageToolbarProps) {
  // The desktop popover portals to <body>, so — unlike the `md:hidden` mobile
  // sheet — it escapes CSS viewport containment and must be gated in JS, or it
  // would render on a phone alongside the sheet.
  const isDesktop = useBreakpoint() !== 'sm';

  // Portal + outside-pointerdown dismiss for the desktop popover (rule 260) —
  // the plain `absolute` panel it replaces had no outside-click dismiss and
  // could be clipped by the page's `overflow-hidden` shell (#2164).
  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({
    open: isDesktop && showAddCombobox,
    width: 288, // w-72
    estimatedHeight: 260,
    align: 'right',
    onDismiss: onAddDismiss,
  });

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-border bg-neutral-surface shrink-0">
      {/* Filter input */}
      <input
        type="search"
        aria-label="Filter team members"
        placeholder="Filter by name or role…"
        value={filterQuery}
        onChange={(e) => onFilterChange(e.target.value)}
        className="flex-1 max-w-xs text-sm border border-neutral-border rounded px-3 py-1.5
          bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-secondary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />

      {/* Enterprise extension slot */}
      <div data-slot="resource-pool-toolbar-end" />

      {/* Add button (desktop) */}
      <div className="hidden md:block">
        <button
          ref={triggerRef}
          type="button"
          onClick={onAddClick}
          aria-haspopup="dialog"
          aria-expanded={showAddCombobox}
          className="h-8 px-3 rounded border border-neutral-border text-sm font-medium
            text-neutral-text-primary bg-neutral-surface hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
            flex items-center gap-1.5"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Add to project
        </button>

        {isDesktop &&
          showAddCombobox &&
          popoverStyle &&
          createPortal(
            <div
              ref={popoverRef}
              style={popoverStyle}
              className="z-40 p-2 bg-neutral-surface border border-neutral-border rounded-card shadow-pop"
            >
              <AddToRosterCombobox
                projectId={projectId}
                onSelect={onAddSelect}
                onDismiss={onAddDismiss}
              />
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}
