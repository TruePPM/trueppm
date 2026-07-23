/**
 * Org-level resource catalog page (issue #155).
 *
 * Two-pane on desktop (≥ md): list left, detail right.
 * Single-column on mobile: list → push to detail.
 *
 * Route: /resources
 */
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useResources } from '@/hooks/useResources';
import { ResourceList, ResourceListSkeleton } from './ResourceList';
import { ResourceDetailPanel } from './ResourceDetailPanel';

export function ResourcesPage() {
  // Seed the search box from `?q=` so the command palette's people tier can
  // deep-link here pre-filtered to a name (ADR-0401/#1940). Read once on mount —
  // the field is user-owned thereafter.
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'create'>('view');
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  const { data: resources = [], isLoading, error } = useResources({ search, includeDeleted: showDeactivated });

  // Auto-select first row on initial load
  useEffect(() => {
    if (!selectedId && resources.length > 0) {
      setSelectedId(resources[0].id);
    }
  }, [resources, selectedId]);

  const selectedResource = resources.find((r) => r.id === selectedId) ?? null;

  function handleSelect(id: string) {
    setSelectedId(id);
    setMode('view');
    setMobileShowDetail(true);
  }

  function handleAddClick() {
    setSelectedId(null);
    setMode('create');
    setMobileShowDetail(true);
  }

  function handleCreated(id: string) {
    setSelectedId(id);
    setMode('view');
  }

  function handleDeactivated() {
    // Keep selected — the panel shows the deactivated state
  }

  function handleRestored() {
    // Keep selected — panel shows restored state
  }

  const showDetail = mode === 'create' || selectedResource !== null;

  return (
    <div className="flex flex-col h-full bg-app-canvas">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-neutral-border px-4 py-2 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[160px]">
          <label htmlFor="resource-search" className="sr-only">Search resources</label>
          <input
            id="resource-search"
            type="search"
            placeholder="Search resources…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-11 md:h-7 px-2.5 rounded border border-neutral-border text-xs text-neutral-text-primary placeholder-neutral-text-disabled
              bg-neutral-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-0"
          />
        </div>

        <label className="flex items-center gap-2 min-h-11 md:min-h-0 text-xs text-neutral-text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            role="switch"
            aria-label="Show deactivated resources"
            checked={showDeactivated}
            onChange={(e) => setShowDeactivated(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-brand-primary"
          />
          Show deactivated
        </label>

        {/* Slot: resources_page.toolbar_end — Enterprise injects sync button here */}
        <div data-slot="resources_page.toolbar_end" />

        <button
          type="button"
          onClick={handleAddClick}
          /* Standalone trigger button: focus: not focus-visible: — Firefox/Safari skip
             :focus-visible on pointer focus (rule 214). The search input above keeps focus-visible:. */
          className="shrink-0 min-h-11 md:min-h-7 px-3 rounded text-xs bg-brand-primary text-neutral-text-inverse hover:bg-brand-primary/90
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          + Add resource
        </button>
      </div>

      {/* Body — two-pane on md+ */}
      <div className="flex-1 flex overflow-hidden">
        {/* List pane — hidden on mobile when showing detail */}
        <div
          className={[
            'flex-shrink-0 border-r border-neutral-border overflow-y-auto',
            'w-full md:w-[420px] lg:w-[480px]',
            mobileShowDetail ? 'hidden md:flex md:flex-col' : 'flex flex-col',
          ].join(' ')}
        >
          {isLoading ? (
            <ResourceListSkeleton />
          ) : error ? (
            <div role="alert" className="px-4 py-3 text-xs text-semantic-critical">
              Couldn&apos;t load resources.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => window.location.reload()}
              >
                Retry
              </button>
            </div>
          ) : resources.length === 0 && !search ? (
            <EmptyState onAdd={handleAddClick} />
          ) : (
            <ResourceList
              resources={resources}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
          )}
        </div>

        {/* Detail pane */}
        <div
          className={[
            'flex-1 overflow-hidden',
            mobileShowDetail ? 'flex flex-col' : 'hidden md:flex md:flex-col',
          ].join(' ')}
        >
          {/* Mobile back button */}
          <div className="md:hidden shrink-0 border-b border-neutral-border px-3 py-2">
            <button
              type="button"
              onClick={() => setMobileShowDetail(false)}
              className="flex items-center gap-1 text-xs text-neutral-text-secondary
                focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
              Resources
            </button>
          </div>

          {showDetail ? (
            mode === 'create' ? (
              <ResourceDetailPanel
                mode="create"
                onCreated={handleCreated}
                onCancel={() => { setMode('view'); setMobileShowDetail(false); }}
              />
            ) : selectedResource ? (
              <ResourceDetailPanel
                mode="view"
                resource={selectedResource}
                onDeactivated={handleDeactivated}
                onRestored={handleRestored}
              />
            ) : null
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-neutral-text-disabled">Select a resource to view details.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm font-medium text-neutral-text-primary">No resources yet</p>
      <p className="text-xs text-neutral-text-secondary max-w-xs">
        Add the people on your team so they can be assigned to tasks.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-1 h-8 px-4 rounded text-xs bg-brand-primary text-neutral-text-inverse hover:bg-brand-primary/90
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        + Add your first resource
      </button>
    </div>
  );
}
