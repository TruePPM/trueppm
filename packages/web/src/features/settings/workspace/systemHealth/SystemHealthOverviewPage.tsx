/**
 * Workspace > System Health — overview page.
 *
 * Read-only admin surface that shows the five background-service components,
 * the Celery Beat heartbeat, a reference table of scheduled tasks, the
 * dead-letter summary, and the retention policy configuration.
 *
 * Polls every 10 s (foreground only) via useSystemHealth. The operator can
 * also force-refresh manually. First-load shows an animate-pulse skeleton;
 * background refetches update in-place so the page never flickers back to a
 * loading state once data has arrived.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { SettingsPageTitle, SettingsCard, FieldRow } from '../../SettingsShell';
import {
  useSystemHealth,
  type ComponentStatus,
  type ScheduledTaskCategory,
  type SystemHealthComponent,
} from '@/hooks/useSystemHealth';
import { formatAge, formatUpdatedAgo } from './formatAge';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Small inline SVG icons (no lucide-react dependency in this package)
// ---------------------------------------------------------------------------

function ActivityIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={spinning ? 'animate-spin shrink-0' : 'shrink-0'}
    >
      <polyline points="23 4 23 10 17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="1 20 1 14 7 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="15 3 21 3 21 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function HeartPulseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-neutral-text-disabled">
      <path d="M20.42 4.58a5.4 5.4 0 0 0-7.65 0l-.77.78-.77-.78a5.4 5.4 0 0 0-7.65 7.65l1.06 1.06L12 21.23l7.77-7.94 1.06-1.06a5.4 5.4 0 0 0-.41-7.65Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="3.54 12 6 12 8 6 10 18 12 12 14 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DrainIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-neutral-text-disabled">
      <polyline points="23 4 23 10 17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="1 20 1 14 7 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PurgeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-neutral-text-disabled">
      <polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SnapshotIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-neutral-text-disabled">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function OtherDotIcon() {
  return (
    <span className="w-[13px] h-[13px] inline-flex items-center justify-center shrink-0 text-neutral-text-disabled" aria-hidden="true">
      <span className="w-2 h-2 rounded-full bg-neutral-text-disabled inline-block" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

/** Maps API component status → Tailwind color classes for the status dot. */
const STATUS_DOT_CLASS: Record<ComponentStatus, string> = {
  ok:      'bg-semantic-on-track',
  warn:    'bg-semantic-at-risk',
  crit:    'bg-semantic-critical',
  // unknown is a hollow ring — visually "not measured", never looks like an error.
  unknown: 'bg-transparent ring-1 ring-neutral-border',
};

const STATUS_DOT_ARIA: Record<ComponentStatus, string> = {
  ok:      'OK',
  warn:    'Warning',
  crit:    'Critical',
  unknown: 'Unknown',
};

function StatusDot({ status }: { status: ComponentStatus }) {
  return (
    <span
      className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT_CLASS[status]}`}
      aria-label={STATUS_DOT_ARIA[status]}
      role="img"
    />
  );
}

// ---------------------------------------------------------------------------
// Category icon mapping
// ---------------------------------------------------------------------------

function CategoryIcon({ category }: { category: ScheduledTaskCategory }) {
  switch (category) {
    case 'heartbeat': return <HeartPulseIcon />;
    case 'drain':     return <DrainIcon />;
    case 'purge':     return <PurgeIcon />;
    case 'snapshot':  return <SnapshotIcon />;
    default:          return <OtherDotIcon />;
  }
}

// ---------------------------------------------------------------------------
// Component card
// ---------------------------------------------------------------------------

function ComponentCard({ component }: { component: SystemHealthComponent }) {
  return (
    <div className="rounded-lg border border-neutral-border bg-neutral-surface-raised p-3.5 flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2">
        <StatusDot status={component.status} />
        <span className="text-[13px] font-semibold text-neutral-text-primary truncate">
          {component.label}
        </span>
      </div>
      <p className={[
        'text-[12px] font-medium',
        component.status === 'ok' ? 'text-semantic-on-track' :
        component.status === 'warn' ? 'text-semantic-at-risk' :
        component.status === 'crit' ? 'text-semantic-critical' :
        'text-neutral-text-secondary',
      ].join(' ')}>
        {component.state_label}
      </p>
      <p className="text-[11px] text-neutral-text-secondary leading-snug">{component.meta}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function OverviewSkeleton() {
  return (
    <div className="px-6 py-5 space-y-5" aria-label="Loading system health" aria-busy="true">
      {/* Component cards */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-[90px] rounded-lg bg-neutral-surface-raised animate-pulse border border-neutral-border" />
        ))}
      </div>
      {/* Beat panel */}
      <div className="h-[180px] rounded-lg bg-neutral-surface-raised animate-pulse border border-neutral-border" />
      {/* Dead-letter + retention */}
      <div className="grid grid-cols-2 gap-3">
        <div className="h-[120px] rounded-lg bg-neutral-surface-raised animate-pulse border border-neutral-border" />
        <div className="h-[120px] rounded-lg bg-neutral-surface-raised animate-pulse border border-neutral-border" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

/**
 * Workspace > System Health overview.
 *
 * Requires workspace-admin access. Shows 5 component health cards, a Celery
 * Beat heartbeat panel (with a reference table of all scheduled tasks), a
 * dead-letter summary, and a retention-policy summary. All data is read-only
 * — editing retention values requires env/settings changes (ADR-0081).
 */
export function SystemHealthOverviewPage() {
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useSystemHealth();

  // Live "updated N ago" ticker — ticks every second so the display stays
  // accurate without forcing a full refetch.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // Detect 403 separately so the error message is role-aware.
  const is403 =
    error !== null &&
    axios.isAxiosError(error) &&
    error.response?.status === 403;

  // First-load skeleton (only on isLoading, not background isFetching).
  if (isLoading) {
    return <OverviewSkeleton />;
  }

  if (error !== null && data === undefined) {
    return (
      <div className="px-6 py-8 flex flex-col gap-3 items-start">
        <p className="text-[13px] text-semantic-critical">
          {is403
            ? 'Admin access required. Contact your workspace owner.'
            : "Couldn't load system health — the API may be unreachable."}
        </p>
        {!is403 && (
          <button
            type="button"
            onClick={() => void refetch()}
            className="px-3 py-1.5 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  // data is available (possibly stale if a background refetch errored — that's fine).
  const health = data!;

  const updatedLabel = formatUpdatedAgo(dataUpdatedAt);

  return (
    <div>
      <SettingsPageTitle
        title="System health"
        subtitle={`Updated ${updatedLabel}`}
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-60"
            >
              <RefreshIcon spinning={isFetching} />
              {isFetching ? 'Refreshing…' : 'Force refresh'}
            </button>
            <a
              href="/docs/administration/system-health"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Open runbook
              <ExternalLinkIcon />
            </a>
          </div>
        }
      />

      <div className="px-6 py-5 space-y-5">
        {/* ── 5 component cards ── */}
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
          aria-label="Component health"
        >
          {health.components.map((c) => (
            <ComponentCard key={c.key} component={c} />
          ))}
        </div>

        {/* ── Beat heartbeat panel ── */}
        <SettingsCard>
          <div className="px-4 py-3 border-b border-neutral-border/55 flex items-center gap-2">
            <ActivityIcon />
            <h2 className="text-[13px] font-semibold text-neutral-text-primary">
              Celery Beat heartbeat
            </h2>
            <span
              className={`ml-auto w-2 h-2 rounded-full shrink-0 ${health.beat.stale ? 'bg-semantic-critical' : 'bg-semantic-on-track'}`}
              aria-label={health.beat.stale ? 'Stale' : 'Live'}
              role="img"
            />
            <span className="text-[11px] text-neutral-text-secondary">
              {health.beat.stale ? 'Stale' : 'Live'}
            </span>
          </div>

          <div className="px-4 py-3 flex flex-col gap-1.5">
            {health.beat.seconds_since !== null ? (
              <>
                <span className="text-[32px] font-bold tppm-mono text-neutral-text-primary leading-none">
                  {formatAge(health.beat.seconds_since)}
                </span>
                <span className="text-[12px] text-neutral-text-secondary">
                  since last heartbeat · threshold {health.beat.stale_threshold_seconds}s
                </span>
              </>
            ) : (
              <>
                <span className="text-[32px] font-bold tppm-mono text-neutral-text-secondary leading-none">
                  —
                </span>
                <span className="text-[12px] text-neutral-text-secondary">
                  No heartbeat recorded yet · threshold {health.beat.stale_threshold_seconds}s
                </span>
              </>
            )}
          </div>

          {/* Scheduled-task reference table — static reference list, no per-row status */}
          <div className="border-t border-neutral-border/55">
            <h3 className="px-4 py-2 text-[10px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary bg-neutral-surface-sunken border-b border-neutral-border/55">
              Scheduled tasks ({health.scheduled_tasks.length})
            </h3>
            <div className="max-h-[320px] overflow-auto">
              <table className="w-full text-[12px]" aria-label="Scheduled tasks reference">
                <thead className="sticky top-0 bg-neutral-surface-raised z-10">
                  <tr className="border-b border-neutral-border/55">
                    <th className="px-4 py-2 text-left font-semibold text-neutral-text-secondary text-[10px] tracking-[.06em] uppercase" scope="col">Name</th>
                    <th className="px-4 py-2 text-left font-semibold text-neutral-text-secondary text-[10px] tracking-[.06em] uppercase" scope="col">Cadence</th>
                    <th className="px-4 py-2 text-center font-semibold text-neutral-text-secondary text-[10px] tracking-[.06em] uppercase w-10" scope="col">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {health.scheduled_tasks.map((task, i) => (
                    <tr
                      key={task.task}
                      className={i < health.scheduled_tasks.length - 1 ? 'border-b border-neutral-border/55' : ''}
                    >
                      <td className="px-4 py-2 text-neutral-text-primary">{task.name}</td>
                      <td className="px-4 py-2 tppm-mono text-neutral-text-secondary">{task.cadence}</td>
                      <td className="px-4 py-2 flex justify-center items-center">
                        <CategoryIcon category={task.category} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </SettingsCard>

        {/* ── Dead-letter summary + Retention (side by side on wider screens) ── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          {/* Dead-letter summary */}
          <SettingsCard>
            <div className="px-4 py-3 border-b border-neutral-border/55">
              <h2 className="text-[13px] font-semibold text-neutral-text-primary">Dead-letter queue</h2>
            </div>
            <div className="px-4 py-3 space-y-3">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[28px] font-bold tppm-mono text-neutral-text-primary leading-none">
                  {health.dead_letter.parked}
                </span>
                <span className="text-[12px] text-neutral-text-secondary">parked tasks</span>
              </div>

              {health.dead_letter.oldest_age_seconds !== null && (
                <div className="text-[12px] text-neutral-text-secondary">
                  Oldest: <span className="font-medium text-neutral-text-primary tppm-mono">{formatAge(health.dead_letter.oldest_age_seconds)}</span>
                </div>
              )}

              {health.dead_letter.top_cause !== null && (
                <div className="text-[12px] text-neutral-text-secondary">
                  Top cause: <span className="font-medium text-neutral-text-primary">{health.dead_letter.top_cause}</span>
                </div>
              )}

              {Object.keys(health.dead_letter.by_status).length > 0 && (
                <div className="text-[12px] text-neutral-text-secondary">
                  {Object.entries(health.dead_letter.by_status)
                    .map(([status, count]) => `${count} ${status}`)
                    .join(' · ')}
                </div>
              )}

              {health.dead_letter.parked === 0 && (
                <p className="text-[12px] text-semantic-on-track">
                  No parked tasks — background processing is clean.
                </p>
              )}

              <Link
                to="/settings/health/dead-letters"
                className="inline-flex items-center gap-1 text-[12px] font-semibold text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
              >
                Open inspector →
              </Link>
            </div>
          </SettingsCard>

          {/* Retention summary */}
          <SettingsCard>
            <div className="px-4 py-3 border-b border-neutral-border/55">
              <h2 className="text-[13px] font-semibold text-neutral-text-primary">Retention policy</h2>
            </div>
            <div className="px-4 py-3">
              {health.retention.map((entry) => (
                <FieldRow key={entry.key} label={entry.label}>
                  {entry.disabled ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-border">
                      Disabled
                    </span>
                  ) : (
                    <span className="text-[13px] text-neutral-text-primary tppm-mono">
                      {entry.value !== null ? `${entry.value} ${entry.unit}` : '—'}
                    </span>
                  )}
                </FieldRow>
              ))}
              <p className="mt-3 text-[11px] text-neutral-text-secondary">
                Set via env/settings · ADR-0081
              </p>
            </div>
          </SettingsCard>
        </div>
      </div>
    </div>
  );
}
