/**
 * Landing-card sections for the two System *tools* that are not config forms —
 * System health (a live monitoring console) and Trash (a data list) — rendered
 * inline on the consolidated `/settings` page (#2298).
 *
 * These are deliberately NOT the full pages: the live 10 s-polling dashboard,
 * the dead-letter inspector, and the trash list stay on their own routes so a
 * monitoring console is never wedged into a form-editing scroll page (the
 * operator VoC constraint — inlining the live dashboard was the rejected
 * option). Each card is a real scroll-reachable `<SettingsSection>` with a
 * state-coded status line, a freshness stamp, and a one-click "Open" into the
 * full tool. The status reads `useSystemHealth({ poll: false })` — one shared,
 * un-polled fetch with the inline Observability section on the same page.
 */

import { Link } from 'react-router';
import { SettingsPageTitle, SettingsCard } from '../SettingsShell';
import { useSystemHealth, type SystemHealthComponent } from '@/hooks/useSystemHealth';
import { useTrashedProjects } from '@/hooks/useProjectMutations';
import { formatUpdatedAgo } from './systemHealth/formatAge';

// Full literal class strings per level — never build these dynamically, or
// Tailwind's JIT purges the semantic color classes and the chip renders unstyled.
const HEALTH_CHIP: Record<'ok' | 'warn' | 'crit' | 'unknown', string> = {
  ok: 'bg-semantic-on-track-bg text-semantic-on-track border-semantic-on-track/40',
  warn: 'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40',
  crit: 'bg-semantic-critical-bg text-semantic-critical border-semantic-critical/40',
  unknown: 'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border',
};

// A standalone link styled as a button — use `focus:` not `focus-visible:` so the
// ring shows on pointer focus too (Firefox/desktop Safari don't match
// :focus-visible on click; web-rule 35, cf. #2263).
const OPEN_LINK_CLASS = [
  'shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-control border border-neutral-border',
  'bg-neutral-surface-raised text-[12px] font-semibold text-neutral-text-primary',
  'hover:bg-neutral-surface-sunken focus:outline-none focus:ring-2',
  'focus:ring-brand-primary focus:ring-offset-1',
].join(' ');

/** Roll the per-component statuses up into one worst-case level + a plain label. */
function overallHealth(components: SystemHealthComponent[]): {
  level: 'ok' | 'warn' | 'crit' | 'unknown';
  label: string;
} {
  const total = components.length;
  if (total === 0) return { level: 'unknown', label: 'Status unavailable' };
  const crit = components.filter((c) => c.status === 'crit').length;
  // `unknown` is not healthy, but it is not an outage either — fold it into the
  // amber "degraded" bucket so a missing signal never masquerades as green.
  const degraded = components.filter((c) => c.status === 'warn' || c.status === 'unknown').length;
  if (crit > 0) return { level: 'crit', label: `${crit} of ${total} components critical` };
  if (degraded > 0) return { level: 'warn', label: `${degraded} of ${total} components degraded` };
  return { level: 'ok', label: `All ${total} components healthy` };
}

function HealthChip({ level, label }: { level: 'ok' | 'warn' | 'crit' | 'unknown'; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-chip border px-2 py-0.5 text-[11px] font-semibold ${HEALTH_CHIP[level]}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/**
 * System health landing card. The live console (10 s poll, dead-letter
 * inspector) stays at `/settings/health`; this shows a scannable status +
 * freshness and jumps straight in. Surfaces a dead-letter token when any job is
 * parked so an operator sees trouble without opening the console (#2298).
 */
export function SystemHealthCard() {
  const { data, isLoading, error, dataUpdatedAt } = useSystemHealth({ poll: false });

  const health = data ? overallHealth(data.components) : null;
  const parked = data?.dead_letter.parked ?? 0;

  return (
    <>
      <SettingsPageTitle
        title="System health"
        subtitle="Workers, queue depth, scheduler heartbeat, and the dead-letter queue."
      />
      <div className="max-w-[720px] px-4 pb-8 pt-4 sm:px-6">
        <SettingsCard>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {isLoading ? (
                  <span className="inline-block h-[22px] w-40 animate-pulse rounded-chip bg-neutral-surface-sunken" />
                ) : health ? (
                  <HealthChip level={health.level} label={health.label} />
                ) : (
                  <HealthChip level="unknown" label="Status unavailable" />
                )}
                {parked > 0 && (
                  // A clickable token, not a static status chip — the trailing arrow
                  // + underline signal it's a link to the dead-letter inspector.
                  // `focus:` (not `focus-visible:`) per web-rule 35.
                  <Link
                    to="/settings/health/dead-letters"
                    className="inline-flex items-center gap-1 rounded-chip border border-semantic-at-risk/40 bg-semantic-at-risk-bg px-2 py-0.5 text-[11px] font-semibold text-semantic-at-risk underline decoration-semantic-at-risk/50 underline-offset-2 hover:decoration-semantic-at-risk focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                  >
                    Dead-letters: {parked} <span aria-hidden="true">→</span>
                  </Link>
                )}
              </div>
              <p className="text-[12px] text-neutral-text-secondary">
                {error && !data
                  ? "Couldn't reach the health endpoint — open the console to retry."
                  : isLoading
                    ? 'Loading current status…'
                    : `Updated ${formatUpdatedAgo(dataUpdatedAt)} · live status refreshes in the console.`}
              </p>
            </div>
            <Link to="/settings/health" className={OPEN_LINK_CLASS}>
              Open console →
            </Link>
          </div>
        </SettingsCard>
      </div>
    </>
  );
}

/**
 * Trash landing card. The recoverable-deletes list, with its per-row
 * Owner-gated Restore, stays at `/settings/trash`; this shows the count and
 * jumps in (#2298).
 */
export function TrashCard() {
  const { data: projects, isLoading } = useTrashedProjects();
  const count = projects?.length ?? 0;

  return (
    <>
      <SettingsPageTitle
        title="Trash"
        subtitle="Recently deleted projects, restorable during their retention window."
      />
      <div className="max-w-[720px] px-4 pb-8 pt-4 sm:px-6">
        <SettingsCard>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {isLoading ? (
                  <span className="inline-block h-[22px] w-24 animate-pulse rounded-chip bg-neutral-surface-sunken" />
                ) : (
                  <span className="inline-flex items-center rounded-chip border border-neutral-border bg-neutral-surface-sunken px-2 py-0.5 text-[11px] font-semibold text-neutral-text-secondary">
                    {count === 0
                      ? 'Trash is empty'
                      : `${count} deleted ${count === 1 ? 'project' : 'projects'}`}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-neutral-text-secondary">
                Restore a project before it is permanently purged.
              </p>
            </div>
            <Link to="/settings/trash" className={OPEN_LINK_CLASS}>
              Open trash →
            </Link>
          </div>
        </SettingsCard>
      </div>
    </>
  );
}
