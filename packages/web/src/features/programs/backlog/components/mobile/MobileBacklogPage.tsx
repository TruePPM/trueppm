/**
 * Mobile shell (< md) — a distinct component, not a responsive transform of the
 * desktop two-pane (06-mobile). Full-screen card list; the detail view, create
 * form, pull picker, and facet filters each rise as a bottom sheet. Shares the
 * controller verbatim with the desktop layout, so behavior never diverges.
 */

import { useState } from 'react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { PlusIcon } from '@/components/Icons';
import { ProgramIdentitySquare } from '@/features/programs/ProgramIdentitySquare';
import { matchesSearch } from '../../filter';
import { BACKLOG_ITEM_TYPES, type BacklogItemType } from '../../types';
import type { BacklogController } from '../../hooks/useBacklogController';
import { BacklogToasts } from '../BacklogToasts';
import { DetailCreate } from '../DetailCreate';
import { DetailView } from '../DetailView';
import type { FacetOption } from '../FacetDropdown';
import { FilterChip } from '../FilterChip';
import { NoResults } from '../NoResults';
import { PulledSectionHeader } from '../PulledSectionHeader';
import { SearchInput } from '../SearchInput';
import { FOCUS_RING } from '../styles';
import { MobileBacklogCard } from './MobileBacklogCard';
import { MobileFilterSheet } from './MobileFilterSheet';
import { MobilePullSheet } from './MobilePullSheet';

const TYPE_LABELS: Record<BacklogItemType, string> = {
  story: 'Story',
  epic: 'Epic',
  feature: 'Feature',
  task: 'Task',
  spike: 'Spike',
  chore: 'Chore',
  bug: 'Bug',
};

interface MobileBacklogPageProps {
  controller: BacklogController;
}

export function MobileBacklogPage({ controller }: MobileBacklogPageProps) {
  const {
    url,
    programName,
    program,
    allItems,
    mainItems,
    pulledItems,
    memberProjects,
    counts,
    tagUniverse,
    canEdit,
    canDelete,
    matchCount,
    searchActive,
    selectedItem,
    isLoading,
  } = controller;
  const [filterSheet, setFilterSheet] = useState<'type' | 'tags' | null>(null);

  const typeOptions: FacetOption[] = BACKLOG_ITEM_TYPES.map((t) => ({
    value: t,
    label: TYPE_LABELS[t],
  }));
  const tagOptions: FacetOption[] = tagUniverse.map((t) => ({ value: t, label: t }));

  const facetsEmpty = mainItems.length === 0 && pulledItems.length === 0;
  const searchMiss = searchActive && matchCount === 0;
  const showNoResults = !isLoading && allItems.length > 0 && (facetsEmpty || searchMiss);
  const isEmpty = !isLoading && allItems.length === 0;
  const hasActiveFacets = url.types.length > 0 || url.tags.length > 0;

  const detailOpen = !!selectedItem && !url.isNew && !url.isPull;
  const pullOpen = url.isPull && selectedItem?.status === 'PROPOSED';

  function renderCard(item: (typeof mainItems)[number]) {
    return (
      <li
        key={item.id}
        className={searchActive && !matchesSearch(item, url.query) ? 'opacity-45' : ''}
      >
        <MobileBacklogCard
          item={item}
          query={url.query}
          canEdit={canEdit}
          onSelect={() => url.selectItem(item.id)}
          onPull={() => url.openPull(item.id)}
        />
      </li>
    );
  }

  return (
    <div className="flex h-full flex-col bg-app-canvas">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 border-b border-neutral-border bg-neutral-surface-raised px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* One marker for the whole board (#963), in the header — not per row. */}
          {program && <ProgramIdentitySquare program={program} size="md" />}
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-[0.06em] text-neutral-text-secondary">
              {programName ?? ' '}
            </div>
            <h1 className="text-base font-bold text-neutral-text-primary">Backlog</h1>
          </div>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={url.openCreate}
            aria-label="New backlog item"
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-primary text-white ${FOCUS_RING}`}
          >
            <PlusIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </header>

      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <h2 className="text-base font-semibold text-neutral-text-primary">
            The program backlog is empty
          </h2>
          <p className="mt-2 max-w-[300px] text-xs text-neutral-text-secondary">
            Capture cross-project ideas here. They live at the program level until pulled into a
            project.
          </p>
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div className="space-y-2 border-b border-neutral-border px-4 py-2.5">
            <SearchInput
              value={url.query}
              onChange={url.setQuery}
              resultCount={matchCount}
              totalCount={counts.all}
              fullWidth
            />
            <div
              role="radiogroup"
              aria-label="Filter by status"
              className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 pr-4"
            >
              {(
                [
                  { value: null, label: 'All', count: counts.all },
                  { value: 'PROPOSED' as const, label: 'Proposed', count: counts.proposed },
                  { value: 'PULLED' as const, label: 'Pulled', count: counts.pulled },
                  { value: 'ARCHIVED' as const, label: 'Archived', count: counts.archived },
                ] as const
              ).map((chip) => {
                const active = url.status === chip.value;
                return (
                  <FilterChip
                    key={chip.label}
                    role="radio"
                    aria-checked={active}
                    className="shrink-0"
                    label={chip.label}
                    count={chip.count}
                    active={active}
                    onClick={() => url.setStatus(chip.value)}
                  />
                );
              })}
              <FilterChip
                className="shrink-0"
                label={url.types.length ? `Type +${url.types.length}` : 'Type'}
                caret
                active={url.types.length > 0}
                aria-haspopup="dialog"
                onClick={() => setFilterSheet('type')}
              />
              <FilterChip
                className="shrink-0"
                label={url.tags.length ? `Tags +${url.tags.length}` : 'Tags'}
                caret
                active={url.tags.length > 0}
                aria-haspopup="dialog"
                onClick={() => setFilterSheet('tags')}
              />
            </div>
          </div>

          {/* Cards */}
          <div className="flex-1 overflow-y-auto px-3 py-3">
            {showNoResults ? (
              <NoResults
                query={url.query}
                totalCount={counts.all}
                hasActiveFacets={hasActiveFacets}
                onClearSearch={url.clearSearch}
                onResetFilters={url.resetFilters}
              />
            ) : (
              <>
                <ul className="space-y-2">{mainItems.map(renderCard)}</ul>
                {pulledItems.length > 0 && (
                  <div className="mt-2">
                    <PulledSectionHeader
                      count={pulledItems.length}
                      open={url.pulledOpen}
                      onToggle={() => url.setPulledOpen(!url.pulledOpen)}
                    />
                    {url.pulledOpen && (
                      <ul className="mt-2 space-y-2">{pulledItems.map(renderCard)}</ul>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* Detail drawer */}
      <BottomSheet
        isOpen={detailOpen}
        onClose={url.closeDetail}
        ariaLabel="Item details"
        size="full"
      >
        {selectedItem && (
          <DetailView
            item={selectedItem}
            tagSuggestions={tagUniverse}
            canEdit={canEdit}
            canDelete={canDelete}
            onClose={url.closeDetail}
            onSave={(patch) => void controller.updateItem(selectedItem.id, patch)}
            onArchive={() => void controller.archiveItem(selectedItem.id)}
            onRestore={() => void controller.restoreItem(selectedItem.id)}
            onDelete={() => {
              void controller.deleteItem(selectedItem.id);
              url.closeDetail();
            }}
            onSendBack={() =>
              void controller.updateItem(selectedItem.id, {
                status: 'PROPOSED',
                pulledTo: undefined,
              })
            }
            onPull={() => url.openPull(selectedItem.id)}
            onOpenLinkedTask={url.closeDetail}
          />
        )}
      </BottomSheet>

      {/* Create sheet */}
      <BottomSheet
        isOpen={url.isNew}
        onClose={url.closeDetail}
        ariaLabel="New backlog item"
        size="full"
      >
        {url.isNew && (
          <DetailCreate
            tagSuggestions={tagUniverse}
            onCancel={url.closeDetail}
            onCreate={async (input) => {
              const created = await controller.createItem(input);
              url.selectItem(created.id);
            }}
          />
        )}
      </BottomSheet>

      {/* Pull sheet */}
      <MobilePullSheet
        open={pullOpen}
        item={selectedItem}
        projects={memberProjects}
        onClose={url.closePull}
        onConfirm={(project) => selectedItem && controller.pullItem(selectedItem, project)}
      />

      {/* Filter sheets */}
      <MobileFilterSheet
        open={filterSheet === 'type'}
        title="Type"
        options={typeOptions}
        selected={url.types}
        onClose={() => setFilterSheet(null)}
        onConfirm={(next) => url.setTypes(next as BacklogItemType[])}
      />
      <MobileFilterSheet
        open={filterSheet === 'tags'}
        title="Tags"
        options={tagOptions}
        selected={url.tags}
        onClose={() => setFilterSheet(null)}
        onConfirm={url.setTags}
      />

      <BacklogToasts controller={controller} />

      <p aria-live="polite" className="sr-only">
        {controller.liveMessage}
      </p>
      <p aria-live="assertive" className="sr-only">
        {controller.alertMessage}
      </p>
    </div>
  );
}
