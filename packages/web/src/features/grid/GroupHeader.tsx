interface GroupHeaderProps {
  label: string;
  count: number;
}

/** Sticky group header rendered between groups in GroupedMode. */
export function GroupHeader({ label, count }: GroupHeaderProps) {
  return (
    <div
      role="row"
      className="flex items-center h-8 px-3 border-b border-neutral-border
        bg-neutral-surface-sunken text-xs font-semibold text-neutral-text-secondary sticky top-0 z-10"
    >
      <span>{label}</span>
      <span className="ml-2 text-neutral-text-disabled">({count})</span>
    </div>
  );
}
