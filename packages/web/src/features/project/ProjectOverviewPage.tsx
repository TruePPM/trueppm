import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { MonteCarloResult } from '@/types';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useRunMonteCarlo } from '@/hooks/useRunMonteCarlo';
import { formatRelative } from '@/lib/formatRelative';

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

interface OverviewData {
  schedule_health: 'on_track' | 'at_risk' | 'critical' | 'unknown';
  spi: number | null;
  tasks_late_count: number;
  critical_task_count: number;
  total_tasks: number;
  complete_tasks: number;
  next_milestone: { id: string; name: string; date: string; percent_complete: number } | null;
  team_utilization_pct: number | null;
  owner_name: string | null;
  start_date: string;
  // Risk summary used by the "Open risks" KPI card and risk register summary section.
  open_risk_count?: number;
  high_risk_count?: number;
}

interface AttentionItem {
  severity: 'critical' | 'warning' | 'info';
  type: 'critical_task_late' | 'unassigned_approaching' | 'baseline_drift' | 'overallocation';
  task_id: string | null;
  task_name: string;
  assignee_name: string | null;
  date: string | null;
  detail: string;
  link_target: unknown;
}

interface MyTask {
  id: string;
  name: string;
  due: string | null;
  status: string;
  percent_complete: number;
  is_critical: boolean;
  // Optional owner display data; tolerated absent for backwards-compat with
  // older API responses. Falls back to a single-character "?" avatar.
  owner_name?: string | null;
  owner_initials?: string | null;
}

// ---------------------------------------------------------------------------
// Critical path types
// ---------------------------------------------------------------------------

interface CpTask {
  id: string;
  name: string;
  duration: number;
  total_float: number | null;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useCriticalPathTasks(projectId: string | undefined) {
  return useQuery<CpTask[]>({
    queryKey: ['cp-tasks', projectId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<CpTask>>('/tasks/', {
        params: { project: projectId, is_critical: 'true' },
      });
      // Sort by total_float ascending (most negative = longest delay → top of list).
      // Null float tasks are placed after tasks with known float.
      return [...res.data.results].sort((a, b) => {
        if (a.total_float === null && b.total_float === null) return 0;
        if (a.total_float === null) return 1;
        if (b.total_float === null) return -1;
        return a.total_float - b.total_float;
      });
    },
    enabled: !!projectId,
  });
}

function useProjectOverview(projectId: string | undefined) {
  return useQuery<OverviewData>({
    queryKey: ['project-overview', projectId],
    queryFn: async () => {
      const res = await apiClient.get<OverviewData>(`/projects/${projectId}/overview/`);
      return res.data;
    },
    enabled: !!projectId,
  });
}

function useProjectAttention(projectId: string | undefined) {
  return useQuery<AttentionItem[]>({
    queryKey: ['project-attention', projectId],
    queryFn: async () => {
      const res = await apiClient.get<{ items: AttentionItem[] }>(
        `/projects/${projectId}/attention/`,
      );
      return res.data.items;
    },
    enabled: !!projectId,
  });
}

function useMyTasks(projectId: string | undefined) {
  return useQuery<MyTask[]>({
    queryKey: ['project-my-tasks', projectId],
    queryFn: async () => {
      const res = await apiClient.get<{ tasks: MyTask[] }>(
        `/projects/${projectId}/my-tasks/`,
      );
      return res.data.tasks;
    },
    enabled: !!projectId,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatIsoDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function daysFromToday(iso: string): number {
  const now = new Date();
  const target = new Date(iso + 'T00:00:00Z');
  return Math.round((target.getTime() - now.getTime()) / 86400000);
}

// ---------------------------------------------------------------------------
// ProjectHeader
// ---------------------------------------------------------------------------

interface ProjectHeaderProps {
  overview: OverviewData;
}

function ProjectHeader({ overview }: ProjectHeaderProps) {
  const healthBadgeClass = {
    on_track: 'border-semantic-on-track/40 text-semantic-on-track',
    at_risk: 'border-semantic-at-risk/40 text-semantic-at-risk',
    critical: 'border-semantic-critical/40 text-semantic-critical',
    unknown: 'border-neutral-border text-neutral-text-disabled',
  }[overview.schedule_health];

  const healthLabel = {
    on_track: 'On track',
    at_risk: 'At risk',
    critical: 'Critical',
    unknown: 'Unknown',
  }[overview.schedule_health];

  const subtitle = [
    `Started ${formatIsoDate(overview.start_date)}`,
    `${overview.total_tasks} task${overview.total_tasks === 1 ? '' : 's'}`,
    `${overview.critical_task_count} on critical path`,
    `Owner: ${overview.owner_name ?? '—'}`,
  ].join(' · ');

  return (
    <div className="flex flex-col gap-1 pb-2 border-b border-neutral-border">
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={`bg-transparent border rounded px-2 py-0.5 text-xs font-medium ${healthBadgeClass}`}
          aria-label={`Project health: ${healthLabel}`}
        >
          {healthLabel}
        </span>
        <div className="flex items-center gap-3 ml-auto">
          <button
            type="button"
            className="text-xs border border-neutral-border rounded px-3 h-7 font-medium
              text-neutral-text-primary hover:bg-neutral-surface-raised
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:outline-none"
          >
            Export
          </button>
          <button
            type="button"
            className="text-xs bg-brand-primary text-white rounded px-3 h-7 font-medium
              hover:opacity-90
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:outline-none"
          >
            Update Status
          </button>
        </div>
      </div>
      <p className="text-xs text-neutral-text-secondary">{subtitle}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  variant?: 'on-track' | 'at-risk' | 'critical' | 'neutral';
}

function KpiCard({ label, value, sub, variant = 'neutral' }: KpiCardProps) {
  const valueColor = {
    'on-track': 'text-semantic-on-track',
    'at-risk': 'text-semantic-at-risk',
    critical: 'text-semantic-critical',
    neutral: 'text-neutral-text-primary',
  }[variant];

  return (
    <div className="flex flex-col gap-1 p-4 rounded border border-neutral-border bg-neutral-surface-raised">
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
        {label}
      </span>
      <span className={`text-2xl font-semibold tppm-mono ${valueColor}`}>{value}</span>
      {sub && <span className="text-xs text-neutral-text-disabled tppm-mono">{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-24 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attention panel
// ---------------------------------------------------------------------------

const ATTENTION_ICONS: Record<AttentionItem['type'], string> = {
  critical_task_late: '🔴',
  unassigned_approaching: '🟡',
  baseline_drift: '🟠',
  overallocation: '🟡',
};

interface AttentionPanelProps {
  items: AttentionItem[];
}

// Severity dot colors mirror the design mockup (mockups-pages.jsx OverviewBody
// attention rows). The icon glyph remains as a screen-reader-friendly fallback
// when the severity color alone could fail WCAG 1.4.1.
const SEVERITY_DOT_CLASS: Record<AttentionItem['severity'], string> = {
  critical: 'bg-semantic-critical',
  warning:  'bg-semantic-at-risk',
  info:     'bg-brand-primary',
};

function AttentionPanel({ items }: AttentionPanelProps) {
  if (items.length === 0) {
    return (
      <div
        className="flex items-center gap-2 px-4 py-3 rounded border border-semantic-on-track/30
          bg-semantic-on-track/5 text-sm text-semantic-on-track"
        role="status"
      >
        <span aria-hidden="true">✓</span>
        No items need attention right now.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2" aria-label="Items needing attention">
      {items.map((item, i) => (
        <li
          key={i}
          className="grid grid-cols-[10px_1fr_auto] gap-3 items-start px-4 py-3 rounded
            border border-neutral-border bg-neutral-surface-raised text-sm"
        >
          {/* Severity dot — colour conveys severity, aria-label conveys severity in words */}
          <span
            className={`mt-1.5 w-2.5 h-2.5 rounded-full ${SEVERITY_DOT_CLASS[item.severity]}`}
            role="img"
            aria-label={`${item.severity} severity`}
          />
          <span className="flex flex-col min-w-0">
            <span className="text-neutral-text-primary truncate flex items-center gap-1.5">
              <span aria-hidden="true" className="text-xs">{ATTENTION_ICONS[item.type]}</span>
              {item.task_name}
            </span>
            <span className="text-xs text-neutral-text-secondary">{item.detail}</span>
          </span>
          {item.date && (
            <span className="text-xs text-neutral-text-secondary tppm-mono whitespace-nowrap pt-0.5">
              {item.date}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// My tasks panel
// ---------------------------------------------------------------------------

interface MyTasksPanelProps {
  tasks: MyTask[];
}

function MyTasksPanel({ tasks }: MyTasksPanelProps) {
  if (tasks.length === 0) {
    return (
      <p className="text-sm text-neutral-text-secondary px-1">
        No tasks assigned to you due this week.
      </p>
    );
  }

  // Map task status to a compact pill label + colour family.
  function statusPill(status: string): { label: string; cls: string } | null {
    switch (status) {
      case 'COMPLETE':    return { label: 'Done',        cls: 'border-semantic-on-track/40 text-semantic-on-track' };
      case 'IN_PROGRESS': return { label: 'In progress', cls: 'border-brand-primary/40 text-brand-primary' };
      case 'REVIEW':      return { label: 'Review',      cls: 'border-brand-accent-dark/40 text-brand-accent-dark' };
      case 'NOT_STARTED': return { label: 'Not started', cls: 'border-neutral-border text-neutral-text-secondary' };
      case 'BACKLOG':     return { label: 'Backlog',     cls: 'border-neutral-border text-neutral-text-secondary' };
      case 'ON_HOLD':     return { label: 'On hold',     cls: 'border-semantic-warning/40 text-semantic-warning' };
      default:            return null;
    }
  }

  return (
    <ul className="flex flex-col gap-1" aria-label="My tasks due this week">
      {tasks.map((task) => {
        const pill = statusPill(task.status);
        const initials = task.owner_initials ?? '?';
        const ownerLabel = task.owner_name ?? 'Unassigned';
        return (
          <li
            key={task.id}
            className="flex items-center gap-3 px-3 py-2 rounded border border-neutral-border
              bg-neutral-surface-raised text-sm"
          >
            {task.is_critical && (
              <span
                aria-label="Critical path"
                title="This task is on the critical path"
                className="flex-shrink-0 text-xs font-bold text-semantic-critical
                  border border-semantic-critical/50 rounded px-1 leading-4"
              >
                CP
              </span>
            )}
            <span
              className="flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full
                border border-neutral-border bg-neutral-surface text-xs font-semibold tppm-mono
                text-neutral-text-secondary"
              aria-label={`Owner: ${ownerLabel}`}
              title={ownerLabel}
            >
              {initials}
            </span>
            <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{task.name}</span>
            <span className="flex-shrink-0 text-xs text-neutral-text-secondary tppm-mono w-9 text-right">
              {Math.round(task.percent_complete)}%
            </span>
            {pill && (
              <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded border ${pill.cls}`}>
                {pill.label}
              </span>
            )}
            {task.due && (
              <span className="flex-shrink-0 text-xs text-neutral-text-secondary tppm-mono">{task.due}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Critical path panel
// ---------------------------------------------------------------------------

const MAX_CP_TASKS = 5;

interface CriticalPathPanelProps {
  tasks: CpTask[];
  projectId: string;
}

export function CriticalPathPanel({ tasks, projectId }: CriticalPathPanelProps) {
  const visible = tasks.slice(0, MAX_CP_TASKS);
  const remaining = tasks.length - visible.length;

  if (tasks.length === 0) {
    return (
      <p className="text-sm text-neutral-text-secondary px-1">
        No critical path tasks found. Run the scheduler to compute the critical path.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1" aria-label="Critical path tasks">
        {visible.map((task) => (
          <li
            key={task.id}
            className="flex flex-col gap-0.5 px-3 py-2 rounded border border-neutral-border
              bg-neutral-surface-raised text-sm"
            title="This task is on the critical path — a delay here delays the project end date"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                aria-label="Critical path"
                className="flex-shrink-0 text-xs font-bold text-semantic-critical
                  border border-semantic-critical/50 rounded px-1 leading-4"
              >
                CP
              </span>
              <span className="flex-1 min-w-0 truncate text-neutral-text-primary font-medium">
                {task.name}
              </span>
              <span className="flex-shrink-0 text-xs text-neutral-text-secondary tppm-mono">
                {task.duration}d
              </span>
            </div>
            <p className="text-xs text-neutral-text-secondary pl-8">
              {task.total_float !== null
                ? `Total slack: ${task.total_float}d · Any slip here slips the project end date.`
                : 'Total slack: — · Any slip here slips the project end date.'}
            </p>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between mt-1">
        {remaining > 0 && (
          <span className="text-xs text-neutral-text-disabled">
            +{remaining} more critical task{remaining === 1 ? '' : 's'}
          </span>
        )}
        <Link
          to={`/projects/${projectId}/schedule`}
          className="ml-auto text-xs text-brand-primary underline-offset-2 hover:underline
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
            focus-visible:outline-none rounded"
        >
          Show full critical path
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monte Carlo widget
// ---------------------------------------------------------------------------

interface MonteCarloWidgetProps {
  projectId: string;
}

function MonteCarloWidget({ projectId }: MonteCarloWidgetProps) {
  const { data: mc, isLoading } = useMonteCarloResult(projectId);
  const runMutation = useRunMonteCarlo(projectId);

  const svgWidth = 150;
  const svgHeight = 40;

  const renderHistogram = (result: MonteCarloResult) => {
    const buckets = result.buckets;
    if (buckets.length === 0) return null;
    const maxCount = Math.max(...buckets.map((b) => b.count), 1);
    const barWidth = svgWidth / buckets.length;

    return (
      <svg
        width={svgWidth}
        height={svgHeight}
        aria-hidden="true"
        className="flex-shrink-0"
      >
        {buckets.map((bucket, i) => {
          const barH = (bucket.count / maxCount) * svgHeight;
          const y = svgHeight - barH;
          // Color by percentile region: ≤P50 green, P50–P80 amber, >P80 red
          let fill = '#4ade80';
          if (bucket.weekStart > result.p80) fill = '#b91c1c';
          else if (bucket.weekStart > result.p50) fill = '#f59e0b';
          return (
            <rect
              key={i}
              x={i * barWidth}
              y={y}
              width={barWidth - 1}
              height={barH}
              fill={fill}
              opacity={0.5}
            />
          );
        })}
      </svg>
    );
  };

  // Persistent rerun affordance — outline secondary, never the primary CTA
  // (Janet's persona prefers a quiet button on Overview, #335).
  const rerunButton = (
    <button
      type="button"
      onClick={() => runMutation.mutate({})}
      disabled={runMutation.isPending}
      className="self-start text-xs border border-neutral-border bg-neutral-surface rounded px-3 h-7 font-medium
        text-neutral-text-primary hover:bg-neutral-surface-raised disabled:opacity-50
        focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
        focus-visible:outline-none"
    >
      {runMutation.isPending ? 'Rerunning…' : 'Rerun forecast'}
    </button>
  );

  return (
    <section aria-label="Monte Carlo forecast">
      <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
        Forecast
      </h2>

      {isLoading ? (
        <div className="h-20 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised" />
      ) : mc ? (
        <div className="flex flex-col gap-3 p-4 rounded border border-neutral-border bg-neutral-surface-raised">
          <div className="flex items-end gap-4 flex-wrap">
            {renderHistogram(mc)}
            <div className="flex flex-col gap-1">
              <p className="text-xs text-neutral-text-secondary">
                8 in 10 simulations finish by{' '}
                <span className="tppm-mono font-medium text-neutral-text-primary">
                  {formatIsoDate(mc.p80)}
                </span>
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="bg-transparent border border-semantic-on-track/40 rounded
                    px-2 py-0.5 text-xs tppm-mono text-semantic-on-track"
                >
                  P50 {formatIsoDate(mc.p50)}
                </span>
                <span
                  className="bg-transparent border border-semantic-at-risk/40 rounded
                    px-2 py-0.5 text-xs tppm-mono text-semantic-at-risk"
                >
                  P80 {formatIsoDate(mc.p80)}
                </span>
                <span
                  className="bg-transparent border border-semantic-critical/40 rounded
                    px-2 py-0.5 text-xs tppm-mono text-semantic-critical"
                >
                  P95 {formatIsoDate(mc.p95)}
                </span>
              </div>
              {mc.lastRunAt && (
                <p className="text-xs text-neutral-text-disabled mt-1">
                  Last run:{' '}
                  <span className="tppm-mono">{formatRelative(new Date(mc.lastRunAt))}</span>
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {rerunButton}
            {runMutation.isError && (
              <span className="text-xs text-semantic-critical" role="alert">
                Could not rerun. Try again.
              </span>
            )}
            <Link
              to={`/projects/${projectId}/schedule`}
              className="ml-auto text-xs text-brand-primary underline-offset-2 hover:underline
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                focus-visible:outline-none rounded"
            >
              See full forecast
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-4 rounded border border-neutral-border bg-neutral-surface-raised">
          <p className="text-sm text-neutral-text-secondary">
            No forecast available. Run a simulation to see finish date probabilities.
          </p>
          <button
            type="button"
            onClick={() => runMutation.mutate({})}
            disabled={runMutation.isPending}
            className="self-start text-xs bg-brand-primary text-white rounded px-3 h-7 font-medium
              hover:opacity-90 disabled:opacity-50
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:outline-none"
          >
            {runMutation.isPending ? 'Running…' : 'Run forecast'}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ProjectOverviewPage
// ---------------------------------------------------------------------------

/**
 * Landing page for a project. Shows KPI cards, an attention panel, and the
 * current user's tasks due this week. Slot registrations from the enterprise
 * widget registry can inject additional panels via the WidgetSlot component.
 */
export function ProjectOverviewPage() {
  const projectId = useProjectId();

  const { data: overview, isLoading: overviewLoading } = useProjectOverview(projectId);
  const { data: attention, isLoading: attentionLoading } = useProjectAttention(projectId);
  const { data: myTasks, isLoading: myTasksLoading } = useMyTasks(projectId);
  const { data: cpTasks, isLoading: cpTasksLoading } = useCriticalPathTasks(projectId);
  const { data: mcData } = useMonteCarloResult(projectId);

  const healthVariant = (() => {
    if (!overview) return 'neutral' as const;
    const map = {
      on_track: 'on-track' as const,
      at_risk: 'at-risk' as const,
      critical: 'critical' as const,
      unknown: 'neutral' as const,
    };
    return map[overview.schedule_health];
  })();

  const healthLabel = (() => {
    if (!overview) return '—';
    const map = {
      on_track: 'On track',
      at_risk: 'At risk',
      critical: 'Critical',
      unknown: 'Unknown',
    };
    return map[overview.schedule_health];
  })();

  const nextMilestoneSub = (() => {
    if (!overview?.next_milestone?.date) return undefined;
    const days = daysFromToday(overview.next_milestone.date);
    if (days < 0) return `${Math.abs(days)}d ago`;
    if (days === 0) return 'Today';
    return `in ${days}d`;
  })();

  const utilizationVariant = (() => {
    if (overview?.team_utilization_pct == null) return 'neutral' as const;
    if (overview.team_utilization_pct > 100) return 'critical' as const;
    if (overview.team_utilization_pct >= 85) return 'at-risk' as const;
    return 'on-track' as const;
  })();

  const forecastVariant = (() => {
    if (!mcData?.p80) return 'neutral' as const;
    const days = daysFromToday(mcData.p80);
    if (days < 0) return 'critical' as const;
    if (days < 14) return 'at-risk' as const;
    return 'neutral' as const;
  })();

  return (
    <div className="flex flex-col gap-6 p-6 overflow-y-auto h-full bg-neutral-surface">
      {/* Project header */}
      {overview && !overviewLoading && <ProjectHeader overview={overview} />}

      {/* KPI row — 6 cards per design spec (mockups-pages.jsx OverviewBody) */}
      <section aria-label="Project KPIs">
        {overviewLoading ? (
          <KpiSkeleton />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <KpiCard
              label="Schedule health"
              value={healthLabel}
              sub={overview?.spi != null ? `SPI ${overview.spi.toFixed(2)}` : 'SPI —'}
              variant={healthVariant}
            />
            <KpiCard
              label="Forecast finish"
              value={mcData?.p80 ? formatIsoDate(mcData.p80) : '—'}
              sub="P80 finish estimate"
              variant={forecastVariant}
            />
            <KpiCard
              label="Tasks late"
              value={overview?.tasks_late_count != null ? String(overview.tasks_late_count) : '—'}
              sub={overview?.total_tasks != null ? `of ${overview.total_tasks} total` : undefined}
              variant={overview && overview.tasks_late_count > 0 ? 'at-risk' : 'on-track'}
            />
            <KpiCard
              label="Next milestone"
              value={overview?.next_milestone?.name ?? '—'}
              sub={nextMilestoneSub}
            />
            <KpiCard
              label="Team utilization"
              value={overview?.team_utilization_pct != null ? `${Math.round(overview.team_utilization_pct)}%` : '—'}
              variant={utilizationVariant}
            />
            <KpiCard
              label="Open risks"
              value={
                overview?.high_risk_count != null && overview.high_risk_count > 0
                  ? `${overview.high_risk_count} high`
                  : overview?.open_risk_count != null
                  ? String(overview.open_risk_count)
                  : '—'
              }
              sub={
                overview?.open_risk_count != null
                  ? `${overview.open_risk_count} register total`
                  : undefined
              }
              variant={
                overview && overview.high_risk_count != null && overview.high_risk_count > 0
                  ? 'at-risk'
                  : 'on-track'
              }
            />
          </div>
        )}
      </section>

      {/* Monte Carlo forecast widget (#172) */}
      {projectId && <MonteCarloWidget projectId={projectId} />}

      {/* Burn-up chart placeholder — issue #53 */}
      <section aria-label="Burn-up chart">
        <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
          Burn-up
        </h2>
        <div
          className="flex items-center justify-center h-48 rounded border border-dashed
            border-neutral-border text-sm text-neutral-text-disabled"
          role="img"
          aria-label="Burn-up chart — coming in issue #53"
        >
          Burn-up chart — issue #53
        </div>
      </section>

      {/* Two-column lower section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Attention panel */}
        <section aria-label="Attention items">
          <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
            Needs attention
          </h2>
          {attentionLoading ? (
            <div className="h-24 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised" />
          ) : (
            <AttentionPanel items={attention ?? []} />
          )}
        </section>

        {/* My tasks */}
        <section aria-label="My tasks this week">
          <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
            My tasks this week
          </h2>
          {myTasksLoading ? (
            <div className="h-24 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised" />
          ) : (
            <MyTasksPanel tasks={myTasks ?? []} />
          )}
        </section>
      </div>

      {/* Critical path panel */}
      {projectId && (
        <section aria-label="Critical path">
          <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
            Critical path
          </h2>
          {cpTasksLoading ? (
            <div className="h-24 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised" />
          ) : (
            <CriticalPathPanel tasks={cpTasks ?? []} projectId={projectId} />
          )}
        </section>
      )}
    </div>
  );
}
