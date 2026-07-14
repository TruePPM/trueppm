/**
 * Server-side filter controls for the board activity feed (ADR-0160, issue 1261).
 *
 * Type and time are small fixed sets (segmented toggle chips); the actor list is
 * variable so it uses a native select, populated from the actors seen in the loaded
 * pages. All three drive the `type` / `since` / `actor` query params — changing any of
 * them resets the infinite query upstream (the filter values are part of its queryKey).
 */

import {
  DEFAULT_FILTERS,
  type ActivityScope,
  type BoardActivityFilterState,
  type TimeRange,
  type TypeGroup,
} from './useBoardActivity';

const TYPE_OPTIONS: { value: TypeGroup; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'cards', label: 'Cards' },
  // The sprint-transition group is what Jordan/Alex watch (added/removed from
  // sprint). Labeled "Scope changes" so it's findable without hunting "All"
  // (ADR-0412, #1946); the underlying TypeGroup value stays 'sprint'.
  { value: 'sprint', label: 'Scope changes' },
  { value: 'comments', label: 'Comments' },
];

const SCOPE_OPTIONS: { value: ActivityScope; label: string }[] = [
  { value: 'sprint', label: 'This sprint' },
  { value: 'board', label: 'Whole board' },
];

const TIME_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

export interface ActorOption {
  id: string;
  name: string;
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'h-7 rounded-full border px-2.5 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        active
          ? 'border-brand-primary bg-brand-primary-light text-brand-primary-dark'
          : 'border-neutral-border bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

interface BoardActivityFiltersProps {
  filters: BoardActivityFilterState;
  actors: ActorOption[];
  onChange: (next: BoardActivityFilterState) => void;
  /** Whether an active sprint id is available — gates the scope toggle (ADR-0412). */
  hasSprintScope?: boolean;
}

export function BoardActivityFilters({
  filters,
  actors,
  onChange,
  hasSprintScope = false,
}: BoardActivityFiltersProps) {
  // Scope is not part of "filtered" state (it has its own toggle), so Clear resets
  // type/actor/time but preserves the sprint-vs-board scope the user is viewing in.
  const isFiltered =
    filters.typeGroup !== 'all' || filters.actorId !== null || filters.range !== 'any';

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-border px-3 py-2">
      {hasSprintScope && (
        <div role="group" aria-label="Activity scope" className="flex flex-wrap gap-1">
          {SCOPE_OPTIONS.map((o) => (
            <Chip
              key={o.value}
              label={o.label}
              active={filters.scope === o.value}
              onClick={() => onChange({ ...filters, scope: o.value })}
            />
          ))}
        </div>
      )}

      <div role="group" aria-label="Filter by event type" className="flex flex-wrap gap-1">
        {TYPE_OPTIONS.map((o) => (
          <Chip
            key={o.value}
            label={o.label}
            active={filters.typeGroup === o.value}
            onClick={() => onChange({ ...filters, typeGroup: o.value })}
          />
        ))}
      </div>

      <select
        aria-label="Filter by person"
        value={filters.actorId ?? ''}
        onChange={(e) => onChange({ ...filters, actorId: e.target.value || null })}
        className="h-7 rounded-full border border-neutral-border bg-neutral-surface px-2.5 text-xs text-neutral-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <option value="">Everyone</option>
        {actors.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>

      <div role="group" aria-label="Filter by time range" className="flex flex-wrap gap-1">
        {TIME_OPTIONS.map((o) => (
          <Chip
            key={o.value}
            label={o.label}
            active={filters.range === o.value}
            onClick={() => onChange({ ...filters, range: o.value })}
          />
        ))}
      </div>

      {isFiltered && (
        <button
          type="button"
          onClick={() => onChange({ ...DEFAULT_FILTERS, scope: filters.scope })}
          className="ml-auto rounded text-xs text-neutral-text-secondary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Clear
        </button>
      )}
    </div>
  );
}
