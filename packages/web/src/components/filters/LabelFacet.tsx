/**
 * The shared Label facet — one trigger + panel used by the Table/Grid and the
 * Product Backlog (and, once #2384 lands, the Schedule). ADR-0620, #2383.
 *
 * The trigger, panel, keyboard model and option row now live in
 * {@link MultiSelectFacet} (ADR-0624, #2387), so Owner / Status / Label are
 * literally the same control with different options. This file is what is
 * *label-specific*: the color swatch, the trigger and footer copy, and the
 * empty-catalog panel that explains where labels come from.
 *
 * Color is never the only signal: a label's name is rendered next to its swatch
 * in every state — option row, trigger label, and chip (rule 6 / WCAG 1.4.1).
 */

import { useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { FOCUS_RING } from '@/features/programs/backlog/components/styles';
import { labelDotStyle } from '@/lib/labelColors';
import { MultiSelectFacet, type FacetOptionGroup } from './MultiSelectFacet';
import type { Label } from '@/hooks/useLabels';

interface LabelFacetProps {
  /** The project's full label catalog, in palette order. */
  labels: Label[];
  /** Per-label counts over the rows the view has already loaded. */
  counts: Record<string, number>;
  /** Currently selected label ids. */
  selected: string[];
  onChange: (next: string[]) => void;
  /**
   * Navigate to the project's label settings. Rendered only in the
   * empty-catalog state, where it is the user's way out.
   */
  onOpenLabelSettings?: () => void;
  /** Extra controls above `Clear labels` — the Schedule's "Hide non-matching rows". */
  footerExtra?: ReactNode;
  /**
   * Shared with the host's chip strip so removing the last chip can return focus
   * here rather than dropping it on `body`.
   */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /**
   * Controlled open state. Hosts with sibling facets (the Grid) pass these so
   * only one panel is open at a time; hosts with a single facet (the Product
   * Backlog grooming bar) omit them and the control manages its own.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  presentation?: 'popover' | 'sheet';
}

export function LabelFacet({
  labels,
  counts,
  selected,
  onChange,
  onOpenLabelSettings,
  footerExtra,
  triggerRef,
  open: controlledOpen,
  onOpenChange,
  presentation,
}: LabelFacetProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  const isEmptyCatalog = labels.length === 0;
  const groups: FacetOptionGroup[] = [
    {
      key: 'labels',
      options: labels.map((label) => ({
        id: label.id,
        name: label.name,
        count: counts[label.id] ?? 0,
        leading: (
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={labelDotStyle(label.color)}
          />
        ),
      })),
    },
  ];

  const selectedNames = labels.filter((l) => selected.includes(l.id)).map((l) => l.name);
  let triggerLabel: string;
  if (isEmptyCatalog) triggerLabel = 'Label: none yet';
  else if (selectedNames.length === 0) triggerLabel = 'Label: any';
  else if (selectedNames.length === 1) triggerLabel = `Label: ${selectedNames[0]}`;
  else triggerLabel = `Label: ${selectedNames[0]} +${selectedNames.length - 1}`;

  return (
    <MultiSelectFacet
      triggerLabel={triggerLabel}
      menuLabel="Filter by label"
      groups={groups}
      selected={selected}
      onChange={onChange}
      clearLabel="Clear labels"
      footerHint="Any of the selected labels"
      footerExtra={footerExtra}
      emptyPanel={<EmptyCatalogPanel onOpenLabelSettings={onOpenLabelSettings} />}
      searchPlaceholder="Filter labels…"
      searchAriaLabel="Filter label options"
      noMatchLabel="No labels match that."
      triggerRef={triggerRef}
      open={open}
      onOpenChange={setOpen}
      presentation={presentation}
    />
  );
}

/**
 * The empty-catalog panel. The trigger stays present and openable rather than
 * being hidden, because "this project has no labels" is information the user
 * needs — and the panel is where we can say where labels come from. This is
 * discovery copy on the control's own surface, not a rule-231 daily-path
 * padlock advertising a feature the edition does not include.
 */
function EmptyCatalogPanel({ onOpenLabelSettings }: { onOpenLabelSettings?: () => void }) {
  return (
    <div className="px-3 py-2">
      <p className="text-xs font-semibold text-neutral-text-primary">
        No labels in this project yet
      </p>
      <p className="mt-1 text-xs text-neutral-text-secondary">
        Labels are created on a task, or in Project settings → Labels. They&rsquo;re scoped to this
        project.
      </p>
      {onOpenLabelSettings && (
        <button
          type="button"
          onClick={onOpenLabelSettings}
          className={`mt-2 h-8 rounded-control px-2 text-xs font-medium text-brand-primary
            hover:bg-neutral-surface-sunken ${FOCUS_RING}`}
        >
          Open label settings
        </button>
      )}
    </div>
  );
}
