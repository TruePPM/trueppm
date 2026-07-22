interface GroupHeaderProps {
  label: string;
  count: number;
  /** 1-based grid row index; body rows are numbered from 1 (header excluded). */
  ariaRowIndex?: number;
}

/** Sticky group header rendered between groups in GroupedMode. */
export function GroupHeader({ label, count, ariaRowIndex }: GroupHeaderProps) {
  return (
    <div
      role="row"
      aria-rowindex={ariaRowIndex}
      className="flex items-center h-8 px-3 border-b border-neutral-border
        bg-neutral-surface-sunken text-xs font-semibold text-neutral-text-secondary sticky top-0 z-10"
    >
      {/* A group header spans the row as a single labelled cell so the row's only
          child is a gridcell (an ARIA row may only own cells, not bare text). */}
      <span role="gridcell" className="flex items-center">
        <span>{label}</span>
        <span className="ml-2 text-neutral-text-disabled">({count})</span>
      </span>
    </div>
  );
}
