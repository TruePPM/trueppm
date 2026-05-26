/**
 * Backlog toolbar: search field, single-select status chips (a radiogroup),
 * the Type / Tags multi-select facet dropdowns, and the sort label. All state
 * lives on the controller's URL state; this component only renders it and
 * routes clicks back. Counts come from the one fetched list (no extra calls).
 */

import type { RefObject } from 'react';
import { BACKLOG_ITEM_TYPES, type BacklogItemStatus } from '../types';
import type { BacklogController } from '../hooks/useBacklogController';
import { FacetDropdown, type FacetOption } from './FacetDropdown';
import { FilterChip } from './FilterChip';
import { SearchInput } from './SearchInput';

const TYPE_LABELS: Record<(typeof BACKLOG_ITEM_TYPES)[number], string> = {
  story: 'Story',
  epic: 'Epic',
  spike: 'Spike',
  chore: 'Chore',
  bug: 'Bug',
};

interface StatusChipDef {
  value: BacklogItemStatus | null;
  label: string;
  count: number;
}

interface BacklogToolbarProps {
  controller: BacklogController;
  searchInputRef: RefObject<HTMLInputElement | null>;
}

export function BacklogToolbar({ controller, searchInputRef }: BacklogToolbarProps) {
  const { url, counts, tagUniverse, matchCount } = controller;

  const statusChips: StatusChipDef[] = [
    { value: null, label: 'All', count: counts.all },
    { value: 'PROPOSED', label: 'Proposed', count: counts.proposed },
    { value: 'PULLED', label: 'Pulled', count: counts.pulled },
    { value: 'ARCHIVED', label: 'Archived', count: counts.archived },
  ];

  const typeOptions: FacetOption[] = BACKLOG_ITEM_TYPES.map((t) => ({
    value: t,
    label: TYPE_LABELS[t],
  }));
  const tagOptions: FacetOption[] = tagUniverse.map((tag) => ({ value: tag, label: tag }));

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-border/60 bg-neutral-surface px-6 py-2.5">
      <SearchInput
        value={url.query}
        onChange={url.setQuery}
        resultCount={matchCount}
        totalCount={counts.all}
        inputRef={searchInputRef}
      />

      <div role="radiogroup" aria-label="Filter by status" className="flex items-center gap-1.5">
        {statusChips.map((chip) => {
          const active = url.status === chip.value;
          return (
            <FilterChip
              key={chip.label}
              role="radio"
              aria-checked={active}
              aria-label={`${chip.label}, ${chip.count} ${chip.count === 1 ? 'item' : 'items'}`}
              label={chip.label}
              count={chip.count}
              active={active}
              onClick={() => url.setStatus(chip.value)}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-1.5">
        <FacetDropdown
          label="Type"
          options={typeOptions}
          selected={url.types}
          onChange={(next) => url.setTypes(next as (typeof BACKLOG_ITEM_TYPES)[number][])}
        />
        <FacetDropdown
          label="Tags"
          options={tagOptions}
          selected={url.tags}
          onChange={url.setTags}
          searchable
        />
      </div>

      <span className="ml-auto text-[11px] text-neutral-text-secondary">Sorted by priority</span>
    </div>
  );
}
