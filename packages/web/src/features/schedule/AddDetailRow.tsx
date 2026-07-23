import { useId } from 'react';
import { PlusIcon } from '@/components/Icons';

/** One revealable optional section — its stable id and resolved display label. */
export interface AddDetailItem {
  id: string;
  label: string;
}

/**
 * "Add detail" affordance for the Task-Detail Drawer v2 Details tab (ADR-0605,
 * #2315). Progressive disclosure hides optional sections that are *empty* for
 * the current task (their `isPopulated` returned false) so the drawer no longer
 * renders a wall of empty collapsed headers (the VoC blocker). This row is the
 * single place the user re-adds one: a labeled group of "+ {section}" buttons,
 * each revealing its section back into the main flow.
 *
 * Plain `<button>`s (not a popover menu) — at most a handful of optional
 * sections are ever collapsed, so a wrap row is simpler and fully
 * keyboard-operable without the anchored-popover machinery. Standalone controls
 * use `focus:` (not `focus-visible:`) per web-rule 214, meet the 44px touch
 * target (rule 5), and pair the neutral chrome with a text label — color is
 * never the only signal (rule 6).
 */
export function AddDetailRow({
  items,
  onReveal,
}: {
  items: AddDetailItem[];
  onReveal: (id: string) => void;
}) {
  const headingId = useId();
  if (items.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="border-t border-neutral-border px-4 py-3">
      <h3
        id={headingId}
        className="m-0 mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary"
      >
        Add detail
      </h3>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onReveal(item.id)}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-control
              border border-neutral-border bg-neutral-surface px-3 py-1.5
              text-sm font-medium text-neutral-text-secondary
              hover:bg-neutral-surface-raised hover:text-neutral-text-primary
              focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {item.label}
          </button>
        ))}
      </div>
    </section>
  );
}
