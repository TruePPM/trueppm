import { useId, type ReactNode } from 'react';
import { useDrawerSectionStore } from '@/stores/drawerSectionStore';

interface CollapsibleSectionProps {
  /** Stable identifier — keys the section's persisted open state (#2049). */
  id: string;
  title: string;
  defaultOpen?: boolean;
  /** Body renderer — called only when the section is open (avoids initial fetch storm). */
  children: ReactNode | (() => ReactNode);
}

/**
 * Drawer section wrapper — header button toggles the body open/closed.
 *
 * ADR-0050 §Decision: Overview is the only section open by default; all
 * others start collapsed so registered sections do not fire their TanStack
 * Query hooks on initial drawer render. The body callback form lets sections
 * skip mounting their content (and queries) until the user expands.
 *
 * Open/closed is remembered per session in the drawer-section store (#2049),
 * keyed by `id`, so an expanded section (e.g. Estimates) survives the drawer
 * unmount/remount that happens on every task open. Until the user toggles it,
 * the section falls back to `defaultOpen`, preserving the lazy-load default.
 */
export function CollapsibleSection({
  id,
  title,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const override = useDrawerSectionStore((s) => s.overrides[id]);
  const setOpen = useDrawerSectionStore((s) => s.setOpen);
  const isOpen = override ?? defaultOpen;
  const headerId = useId();
  const bodyId = `${headerId}-body`;

  const body = typeof children === 'function' ? (isOpen ? children() : null) : children;

  return (
    <div
      data-section-id={id}
      className="border-t border-neutral-border first:border-t-0"
    >
      <h3 className="m-0">
        <button
          type="button"
          id={headerId}
          aria-expanded={isOpen}
          aria-controls={bodyId}
          onClick={() => setOpen(id, !isOpen)}
          className="w-full flex items-center gap-2 px-4 py-3 text-left
            min-h-[44px]
            text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary
            hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-brand-primary focus-visible:ring-offset-1
            focus-visible:rounded-chip"
        >
          <span
            aria-hidden="true"
            className={[
              'inline-block w-2 text-xs transition-transform duration-150 ease-out',
              isOpen ? 'rotate-90' : 'rotate-0',
            ].join(' ')}
          >
            ▶
          </span>
          <span>{title}</span>
        </button>
      </h3>

      <div
        id={bodyId}
        role="region"
        aria-labelledby={headerId}
        hidden={!isOpen}
        className="px-4 pb-4"
      >
        {isOpen && body}
      </div>
    </div>
  );
}
