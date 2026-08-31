/**
 * Left-pane roster list showing all ProjectResource rows for a project.
 * Each row: avatar initial, name, job role, availability bar, top-3 skill chips.
 *
 * The bar states **availability**, never load (#3235). `effectiveMaxUnits` is the
 * resource's maximum availability ceiling as a fraction of full time — the
 * `units_override` on this project, else `Resource.max_units`, which defaults to 1.0.
 * Consumed load is a different axis entirely: it is the sum of `TaskResource.units`
 * over the resource's assignments, bridged through `Resource.user`, and **no field on
 * `ProjectResource` carries it**. Nothing on this endpoint can be rendered as load.
 *
 * This row previously applied a load ramp to that ceiling — `pct >= 85` → amber
 * "at risk", `> 1.0` → red "overallocated". Because `max_units` defaults to 1.0, every
 * resource on a fresh install sat at `pct = 100` and the whole roster rendered amber,
 * while a deliberately-configured 1.5-FTE crew was announced to a screen reader as
 * "overallocated" carrying zero assignments. A Resource Manager reads this surface to
 * decide whether someone can take new work, so the ramp failed in the direction that
 * blocks staffing.
 *
 * Hence: no health ramp here. Availability is a quantity, not a verdict — a person at
 * 50% is not "healthier" than one at 100%. The fill is a neutral brand tint and the
 * three `semantic-*` health tokens are deliberately absent from this file. When a real
 * load read exists (#3155 is building the assignment-load signal), it is a **second**
 * channel on the row, not a recolor of this one.
 */
import type { ProjectResource } from '@/types';
import { AvatarInitials } from '@/components/AvatarInitials';
import { SkillChip } from './SkillChip';

interface RosterListProps {
  items: ProjectResource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Filter string applied client-side against name and job role. */
  filterQuery: string;
}

/** The resource's availability ceiling as a whole percent of full time. */
function availabilityPercent(pr: ProjectResource): number {
  return Math.round(pr.effectiveMaxUnits * 100);
}

/**
 * Bar width as a percent of the track.
 *
 * Full time fills the track. The old math divided by 2 for a 0-200% scale, which drew
 * a fully-available person at half width — the visual read was "half empty" for the
 * default every resource ships with. Anything above full time pins at 100%; the number
 * beside the bar carries the excess, because a 150% crew is not 1.5 bars of anything.
 */
function barWidthPercent(pct: number): number {
  return Math.min(pct, 100);
}

export function RosterList({ items, selectedId, onSelect, filterQuery }: RosterListProps) {
  const q = filterQuery.toLowerCase();
  const filtered = q
    ? items.filter(
        (pr) =>
          pr.resource.name.toLowerCase().includes(q) ||
          pr.resource.jobRole.toLowerCase().includes(q),
      )
    : items;

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-sm text-neutral-text-disabled">
        {filterQuery ? 'No matching team members' : 'No one on this project yet'}
      </div>
    );
  }

  return (
    <ul
      role="listbox" // dropdown-scroll-ok: in-page list inheriting its ancestor panel's overflow-y-auto (RosterPage.tsx), not a floating dropdown
      aria-label="Project roster"
      className="flex flex-col divide-y divide-neutral-border"
    >
      {filtered.map((pr) => {
        const isSelected = pr.id === selectedId;
        const pct = availabilityPercent(pr);
        const initials = pr.resource.name
          .split(' ')
          .map((w) => w[0] ?? '')
          .join('')
          .slice(0, 2)
          .toUpperCase();
        const topSkills = pr.resource.skills.slice(0, 3);
        const extraCount = pr.resource.skills.length - topSkills.length;

        return (
          <li
            key={pr.id}
            role="option"
            aria-selected={isSelected}
            onClick={() => onSelect(pr.id)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(pr.id)}
            tabIndex={0}
            className={[
              'flex items-start gap-3 px-3 py-3 cursor-pointer transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
              isSelected
                ? 'bg-brand-primary/5 border-l-2 border-brand-primary'
                : 'hover:bg-neutral-surface-raised border-l-2 border-transparent',
            ].join(' ')}
          >
            {/* Avatar */}
            <AvatarInitials initials={initials} size="lg" className="mt-0.5" />

            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 justify-between">
                <span className="text-sm font-medium text-neutral-text-primary truncate">
                  {pr.resource.name}
                </span>
                {/* The word is visible, not only in the accessible name: a bare
                    "100%" beside a filled bar reads as load to a sighted user, which
                    is the misreading this row shipped. Both channels now say the same
                    thing (web rule 287). */}
                <span
                  className="text-xs shrink-0 text-neutral-text-secondary"
                  aria-label={`${pct}% available — availability, not assigned load`}
                >
                  {pct}% available
                </span>
              </div>

              {pr.resource.jobRole && (
                <p className="text-xs text-neutral-text-secondary truncate mt-0.5">
                  {pr.resource.jobRole}
                </p>
              )}

              {/* Availability bar — decorative; the percent above is the value, so
                  the bar stays aria-hidden rather than duplicating it. */}
              <div
                className="mt-1.5 h-1 rounded-full bg-neutral-border overflow-hidden"
                aria-hidden="true"
              >
                <div
                  className="h-full rounded-full transition-[width] bg-brand-primary"
                  style={{ width: `${barWidthPercent(pct)}%` }}
                />
              </div>

              {/* Skill chips */}
              {topSkills.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {topSkills.map((s) => (
                    <SkillChip key={s.id} name={s.skill.name} proficiency={s.proficiency} />
                  ))}
                  {extraCount > 0 && (
                    <span className="text-xs text-neutral-text-disabled self-center">
                      +{extraCount} more
                    </span>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
