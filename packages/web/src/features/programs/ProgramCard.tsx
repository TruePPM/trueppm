import { Link } from 'react-router';
import type { Program } from '@/api/types';

interface Props {
  program: Program;
}

/**
 * Returns the visual treatment for a program-role chip. The chip is wider than
 * a typical badge because the role label can be up to "Project Manager" (16 chars).
 */
function roleChipClasses(role: number | null): string {
  // 4=OWNER, 3=ADMIN, 2=SCHEDULER, 1=MEMBER, 0=VIEWER (mirrors Role enum ordinals).
  // Role hierarchy is conveyed by saturation, not new color tokens — limits
  // the chip to the brand-primary + on-track + neutral ramp already in use.
  switch (role) {
    case 4:
      return 'bg-brand-primary/15 text-brand-primary border border-brand-primary/40';
    case 3:
      return 'bg-brand-primary/5 text-brand-primary border border-brand-primary/30';
    case 2:
    case 1:
      return 'bg-semantic-on-track/10 text-semantic-on-track border border-semantic-on-track/40';
    case 0:
    default:
      return 'bg-neutral-surface-raised text-neutral-text-secondary border border-neutral-border';
  }
}

/**
 * Single program card on the /programs list page.
 *
 * Whole card is a `<Link>` so click anywhere navigates to the program shell.
 * Methodology, project count, and member count render in `tppm-mono` so the
 * row reads consistently with other count surfaces in the app.
 */
export function ProgramCard({ program }: Props) {
  return (
    <li>
      <Link
        to={`/programs/${program.id}/projects`}
        aria-label={`${program.name}${
          program.my_role_label ? `, your role: ${program.my_role_label}` : ''
        }`}
        className="flex h-full flex-col gap-2 rounded-lg border border-neutral-border bg-neutral-surface p-4
          hover:border-brand-primary/40
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 className="min-w-0 truncate text-sm font-semibold text-neutral-text-primary">
            {program.name}
          </h2>
          {program.my_role_label && (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${roleChipClasses(program.my_role)}`}
            >
              {program.my_role_label}
            </span>
          )}
        </div>
        {program.description && (
          <p className="line-clamp-2 text-xs text-neutral-text-secondary">{program.description}</p>
        )}
        <p className="tppm-mono mt-auto text-xs text-neutral-text-secondary">
          {program.project_count} project{program.project_count === 1 ? '' : 's'} ·{' '}
          {program.member_count} member{program.member_count === 1 ? '' : 's'} ·{' '}
          {program.methodology}
        </p>
      </Link>
    </li>
  );
}
