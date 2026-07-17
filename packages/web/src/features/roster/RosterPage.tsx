/**
 * Project roster page — two-pane layout (list + detail) on desktop,
 * single-pane with FAB → bottom sheet on mobile.
 *
 * Route: /projects/:projectId/resources/roster
 */
import { useState } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjectResourcePool, useAddProjectResource } from '@/hooks/useProjectResourcePool';
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

      {/* Mobile add bottom sheet */}
      {showAddCombobox && (
        <div className="md:hidden fixed inset-0 z-40 flex flex-col justify-end bg-neutral-overlay">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Add team member"
            className="bg-neutral-surface rounded-t-card border-t border-neutral-border p-4 flex flex-col gap-3"
            style={{ maxHeight: '85vh' }}
          >
            <div
              aria-hidden="true"
              className="w-10 h-1 rounded-full bg-neutral-border mx-auto mb-1"
            />
            <h2 className="text-sm font-semibold text-neutral-text-primary">Add team member</h2>
            <AddToRosterCombobox
              projectId={projectId}
              onSelect={handleAdd}
              onDismiss={() => setShowAddCombobox(false)}
            />
          </div>
        </div>
      )}
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
          bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-disabled
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />

      {/* Enterprise extension slot */}
      <div data-slot="resource-pool-toolbar-end" />

      {/* Add button (desktop) */}
      <div className="relative hidden md:block">
        <button
          type="button"
          onClick={onAddClick}
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

        {showAddCombobox && (
          <div className="absolute right-0 top-full mt-1 w-72 z-40 p-2
            bg-neutral-surface border border-neutral-border rounded-card">
            <AddToRosterCombobox
              projectId={projectId}
              onSelect={onAddSelect}
              onDismiss={onAddDismiss}
            />
          </div>
        )}
      </div>
    </div>
  );
}
