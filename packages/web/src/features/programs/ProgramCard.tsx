import { Link } from 'react-router';
import type { Program, ProgramHealth } from '@/api/types';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { useShellStore } from '@/stores/shellStore';
import { toast } from '@/components/Toast';
import { ProgramIdentitySquare } from './ProgramIdentitySquare';

interface Props {
  program: Program;
}

/**
 * Health → circle-dot treatment + label (issue 560). Per rule 158 program health is a
 * CIRCLE dot (the identity square stays for `program.color`); the dot carries the
 * color and the word carries the meaning (rule 6/7/120). AUTO is omitted — it
 * means "defer to the rollup", and the computed worst-of-children value lives on
 * the program overview (it is not recomputed per card to keep the list cheap).
 */
const HEALTH_DOT: Record<Exclude<ProgramHealth, 'AUTO'>, { dot: string; label: string }> = {
  ON_TRACK: { dot: 'bg-semantic-on-track', label: 'On track' },
  AT_RISK: { dot: 'bg-semantic-at-risk', label: 'At risk' },
  CRITICAL: { dot: 'bg-semantic-critical', label: 'Critical' },
};

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
      return 'bg-semantic-on-track-bg text-semantic-on-track border border-semantic-on-track/40';
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
  const pinned = useShellStore((s) => s.pinnedProgramIds.includes(program.id));
  const togglePinProgram = useShellStore((s) => s.togglePinProgram);
  const health = program.health !== 'AUTO' ? HEALTH_DOT[program.health] : null;
  const targetLabel = program.target_date ? fmtUtcShort(program.target_date) : null;
  // The whole card is a single <Link>, so its aria-label REPLACES the inner text
  // for screen readers — fold the role, health, and target into it (rule 6).
  const ariaLabel = [
    program.name,
    program.my_role_label ? `your role: ${program.my_role_label}` : null,
    health ? `health: ${health.label}` : null,
    targetLabel ? `target ${targetLabel}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <li className="group relative">
      <Link
        to={`/programs/${program.id}/projects`}
        aria-label={ariaLabel}
        className="flex h-full flex-col gap-2 rounded-card border border-neutral-border bg-neutral-surface p-4
          transition-[transform,border-color] duration-fast ease-brand
          hover:border-brand-primary/40 motion-safe:hover:-translate-y-px
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <div className="flex items-start gap-2.5">
          <ProgramIdentitySquare program={program} size="lg" showLabel />
          <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
            <h2 className="min-w-0 truncate text-sm font-semibold text-neutral-text-primary">
              {program.name}
            </h2>
            {program.my_role_label && (
              <span
                className={`shrink-0 rounded-chip px-1.5 py-0.5 text-xs font-medium ${roleChipClasses(program.my_role)}`}
              >
                {program.my_role_label}
              </span>
            )}
          </div>
        </div>
        {program.description && (
          <p className="line-clamp-2 text-xs text-neutral-text-secondary">{program.description}</p>
        )}
        <div className="mt-auto flex flex-col gap-1">
          {health && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${health.dot}`} />
              <span className="text-xs text-neutral-text-secondary">{health.label}</span>
            </span>
          )}
          <p className="tppm-mono text-xs text-neutral-text-secondary">
            {program.project_count} project{program.project_count === 1 ? '' : 's'} ·{' '}
            {program.member_count} member{program.member_count === 1 ? '' : 's'} ·{' '}
            {program.methodology}
            {targetLabel ? ` · Target ${targetLabel}` : ''}
          </p>
        </div>
      </Link>
      {/* Pin toggle is a Link SIBLING (not nested — a button inside an anchor is
          invalid) positioned over the free bottom-right corner so it never
          collides with the top-right role chip. Reveals on card hover/focus; a
          pinned star stays visible (amber). 44px touch target. */}
      <button
        type="button"
        onClick={() => {
          togglePinProgram(program.id);
          toast.info(pinned ? `Unpinned ${program.name}` : `Pinned ${program.name}`);
        }}
        aria-label={pinned ? `Unpin ${program.name}` : `Pin ${program.name}`}
        aria-pressed={pinned}
        title={pinned ? 'Unpin' : 'Pin'}
        className="absolute bottom-1.5 right-1.5 z-10 flex h-11 w-11 items-center justify-center rounded-control
          opacity-0 group-hover:opacity-100 focus:opacity-100 aria-pressed:opacity-100
          hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill={pinned ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
          className={pinned ? 'text-semantic-at-risk' : 'text-neutral-text-secondary'}
        >
          <path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.8 4.2 13.3l.7-4.3-3.1-3 4.3-.6L8 1.5z" />
        </svg>
      </button>
    </li>
  );
}
