/**
 * Left-pane roster list showing all ProjectResource rows for a project.
 * Each row: avatar initial, name, job role, capacity bar, top-3 skill chips.
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

function capacityPercent(pr: ProjectResource): number {
  return Math.round(pr.effectiveMaxUnits * 100);
}

function isOverallocated(pr: ProjectResource): boolean {
  return pr.effectiveMaxUnits > 1.0;
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
    <ul role="listbox" aria-label="Project roster" className="flex flex-col divide-y divide-neutral-border">
      {filtered.map((pr) => {
        const isSelected = pr.id === selectedId;
        const pct = capacityPercent(pr);
        const over = isOverallocated(pr);
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
                <span
                  className={[
                    'text-xs shrink-0',
                    over ? 'text-semantic-critical' : 'text-neutral-text-secondary',
                  ].join(' ')}
                  aria-label={`${pct}% capacity${over ? ' — overallocated' : ''}`}
                >
                  {pct}%
                </span>
              </div>

              {pr.resource.jobRole && (
                <p className="text-xs text-neutral-text-secondary truncate mt-0.5">
                  {pr.resource.jobRole}
                </p>
              )}

              {/* Capacity bar */}
              <div
                className="mt-1.5 h-1 rounded-full bg-neutral-border overflow-hidden"
                aria-hidden="true"
              >
                <div
                  className={[
                    'h-full rounded-full transition-[width]',
                    over
                      ? 'bg-semantic-critical'
                      : pct >= 85
                        ? 'bg-semantic-at-risk'
                        : 'bg-semantic-on-track',
                  ].join(' ')}
                  style={{ width: `${Math.min(pct, 200) / 2}%` }}
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
