import type { GridGroupBy } from './persistence';

const GROUP_BY_LABEL: Record<GridGroupBy, string> = {
  phase: 'Phase',
  owner: 'Owner',
  status: 'Status',
  sprint: 'Sprint',
  resource: 'Resource',
};

interface GroupBySelectorProps {
  groupBy: GridGroupBy;
  onChange: (next: GridGroupBy) => void;
  /** Whether the project enables agile features — gates the Sprint option. */
  showSprint: boolean;
}

/**
 * Native select for picking the Grouped-mode dimension. Sprint option is
 * gated on `project.agile_features` so non-agile projects don't see a stale
 * field. Resource grouping intentionally duplicates multi-assignee tasks
 * (ADR-0053 § 7) — the help-icon tooltip in the toolbar carries that copy.
 */
export function GroupBySelector({ groupBy, onChange, showSprint }: GroupBySelectorProps) {
  const options: GridGroupBy[] = showSprint
    ? ['phase', 'owner', 'status', 'sprint', 'resource']
    : ['phase', 'owner', 'status', 'resource'];

  return (
    <label className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-neutral-text-secondary">Group by</span>
      <select
        value={groupBy}
        onChange={(e) => onChange(e.target.value as GridGroupBy)}
        aria-label="Group by dimension"
        className="
          h-7 px-2 pr-6 text-xs font-medium rounded border border-neutral-border
          bg-neutral-surface text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1
        "
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {GROUP_BY_LABEL[opt]}
          </option>
        ))}
      </select>
    </label>
  );
}
