/**
 * Owner facet — the project roster, grouped into `On these rows` and
 * `All members`. ADR-0624, issue #2387.
 *
 * Everything structural lives in {@link MultiSelectFacet}; this file supplies
 * the roster grouping, the avatar, and the copy. The avatar is decoration only:
 * the full name is always rendered beside it, so initials never carry meaning
 * alone (rule 6 / WCAG 1.4.1) and two people with the same initials are never
 * ambiguous.
 */

import { useState } from 'react';
import type { RefObject } from 'react';
import { MultiSelectFacet, type FacetOptionGroup } from './MultiSelectFacet';
import { groupOwnerCandidates, type OwnerCandidate } from './ownerFilter';
import { initials } from '@/features/grid/ui';

interface OwnerFacetProps {
  /** The project's resource pool — everyone who could own work here. */
  candidates: OwnerCandidate[];
  /** Per-owner counts over the loaded rows. */
  counts: Record<string, number>;
  /** Selected resource ids (or legacy names from an older link). */
  selected: string[];
  onChange: (next: string[]) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  presentation?: 'popover' | 'sheet';
}

export function OwnerFacet({
  candidates,
  counts,
  selected,
  onChange,
  triggerRef,
  open: controlledOpen,
  onOpenChange,
  presentation,
}: OwnerFacetProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  const { onTheseRows, allMembers } = groupOwnerCandidates(candidates, counts);

  const toOption = (c: OwnerCandidate) => ({
    id: c.id,
    name: c.name,
    count: counts[c.id] ?? 0,
    leading: <OwnerInitials name={c.name} />,
  });

  // A single ungrouped list when nobody is on these rows (or everybody is):
  // a heading above every option and none above the other group is noise.
  const groups: FacetOptionGroup[] = [];
  const grouped = onTheseRows.length > 0 && allMembers.length > 0;
  if (onTheseRows.length > 0) {
    groups.push({
      key: 'on-rows',
      heading: grouped ? `On these rows · ${onTheseRows.length}` : undefined,
      options: onTheseRows.map(toOption),
    });
  }
  if (allMembers.length > 0) {
    groups.push({
      key: 'all',
      heading: grouped ? `All members · ${allMembers.length} more` : undefined,
      options: allMembers.map(toOption),
    });
  }

  const selectedNames = selected.map(
    (id) => candidates.find((c) => c.id === id)?.name ?? id,
  );
  let triggerLabel: string;
  if (candidates.length === 0) triggerLabel = 'Owner: none yet';
  else if (selectedNames.length === 0) triggerLabel = 'Owner: any';
  else if (selectedNames.length === 1) triggerLabel = `Owner: ${selectedNames[0]}`;
  else triggerLabel = `Owner: ${selectedNames[0]} +${selectedNames.length - 1}`;

  return (
    <MultiSelectFacet
      triggerLabel={triggerLabel}
      menuLabel="Filter by owner"
      groups={groups}
      selected={selected}
      onChange={onChange}
      clearLabel="Clear owners"
      footerHint="Any of the selected owners"
      emptyPanel={<EmptyRosterPanel />}
      searchPlaceholder="Filter people…"
      searchAriaLabel="Filter owner options"
      noMatchLabel="No people match that."
      triggerRef={triggerRef}
      open={open}
      onOpenChange={setOpen}
      presentation={presentation}
    />
  );
}

/** Initials chip. `aria-hidden` because the full name follows it in the row. */
function OwnerInitials({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full
        bg-brand-primary/20 text-xs font-semibold text-brand-primary"
    >
      {initials(name)}
    </span>
  );
}

function EmptyRosterPanel() {
  return (
    <div className="px-3 py-2">
      <p className="text-xs font-semibold text-neutral-text-primary">
        No people on this project yet
      </p>
      <p className="mt-1 text-xs text-neutral-text-secondary">
        Add people to the project&rsquo;s resource pool before you can filter by owner.
      </p>
    </div>
  );
}
