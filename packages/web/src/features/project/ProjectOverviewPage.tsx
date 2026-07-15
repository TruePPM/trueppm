import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useSurfaceVisibility } from '@/hooks/useSurfaceVisibility';
import { isTabVisibleForMethodology } from '@/features/shell/methodologyTabs';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN, ROLE_SCHEDULER } from '@/lib/roles';
import { apiClient } from '@/api/client';
import { QueryErrorState } from '@/components/QueryErrorState';
import type { PaginatedResponse, ProjectHealth } from '@/api/types';
import type { MonteCarloResult } from '@/types';
import { UpdateStatusDialog } from '@/features/project/UpdateStatusDialog';
import {
  HEALTH_LABEL as REPORTED_HEALTH_LABEL,
  HEALTH_ACTIVE as REPORTED_HEALTH_ACTIVE,
} from '@/features/project/projectHealth';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useRunMonteCarlo } from '@/hooks/useRunMonteCarlo';
import { formatRelative } from '@/lib/formatRelative';
import { BurnChart } from '@/features/reports/BurnChart';
import { MonteCarloHistogram } from '@/features/schedule/MonteCarloHistogram';
import { ImportProvenanceSection } from '@/features/project/ImportProvenanceSection';
import { SprintForecastWidget } from '@/features/project/SprintForecastWidget';
import { BlockedRollupPanel } from '@/features/blocker/BlockedRollupPanel';
import {
  rankOverviewMetrics,
  focusHeading,
  type OverviewMetric,
} from '@/features/project/overviewMetrics';

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
      const res = await apiClient.get<{ tasks: MyTask[] }>(`/projects/${projectId}/my-tasks/`);
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
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
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
  projectId: string;
}

function ProjectHeader({ overview, projectId }: ProjectHeaderProps) {
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const { data: project } = useProject(projectId);
  const { role } = useCurrentUserRole(projectId);
  // Server gates the `health` field to Admin+ (ProjectSerializer.validate); role
  // is null while the membership query loads, so gate pessimistically to avoid a
  // flash of an editable Save action.
  const canEditHealth = role !== null && role >= ROLE_ADMIN;
  // The PM's manual health override (issue 520) is a separate signal from the
  // computed schedule badge — surface it only when the PM has actually reported
  // one (non-AUTO), so the "Update Status" action has a visible effect.
  const reportedHealth: ProjectHealth = project?.health ?? 'AUTO';
  const hasReport = reportedHealth !== 'AUTO';

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
          className={`bg-transparent border rounded-chip px-2 py-0.5 text-xs font-medium ${healthBadgeClass}`}
          aria-label={`Project health: ${healthLabel}`}
        >
          {healthLabel}
        </span>
        {hasReport && (
          <span
            className={`bg-transparent border rounded-chip px-2 py-0.5 text-xs font-medium ${REPORTED_HEALTH_ACTIVE[reportedHealth]}`}
            aria-label={`Reported project health: ${REPORTED_HEALTH_LABEL[reportedHealth]}`}
            title="Status reported by the project manager — separate from the schedule signal."
          >
            Reported: {REPORTED_HEALTH_LABEL[reportedHealth]}
          </span>
        )}
        <div className="flex items-center gap-3 ml-auto">
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Report export is planned — tracked in issue 1200 (milestone 0.5)"
            className="text-xs border border-neutral-border rounded-control px-3 h-7 font-medium
              text-neutral-text-primary hover:bg-neutral-surface-raised
              disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary
              disabled:border-neutral-border/55 disabled:cursor-not-allowed disabled:hover:bg-neutral-surface-sunken
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:outline-none"
          >
            Export
          </button>
          <button
            type="button"
            onClick={() => setStatusDialogOpen(true)}
            className="text-xs bg-brand-primary text-white rounded-control px-3 h-7 font-medium
              hover:opacity-90
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:outline-none"
          >
            Update Status
          </button>
        </div>
      </div>
      <p className="text-xs text-neutral-text-secondary">{subtitle}</p>

      {statusDialogOpen && (
        <UpdateStatusDialog
          projectId={projectId}
          currentHealth={reportedHealth}
          canEdit={canEditHealth}
          onClose={() => setStatusDialogOpen(false)}
        />
      )}
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
  /** Explanatory hover/AT text (e.g. the raw SPI behind a schedule band). */
  title?: string;
  /**
   * A focus card (the top-3 risk-ranked metrics). Larger padding and a bigger
   * value clamp than the demoted secondary-strip cards.
   */
  prominent?: boolean;
  /** Drill-down route; when set the whole card is an interactive `<Link>`. */
  to?: string;
  /** Destination noun for the interactive card's `aria-label`. */
  toLabel?: string;
}

function KpiCard({
  label,
  value,
  sub,
  variant = 'neutral',
  title,
  prominent = false,
  to,
  toLabel,
}: KpiCardProps) {
  const valueColor = {
    'on-track': 'text-semantic-on-track',
    'at-risk': 'text-semantic-at-risk',
    critical: 'text-semantic-critical',
    neutral: 'text-neutral-text-primary',
  }[variant];

  // `container-type: inline-size` + `cqi` units make the value font scale with the
  // card's own width rather than the viewport, so long values (milestone names,
  // dates) stay legible when the grid track squeezes each card under ~180px
  // (#506). `break-words` is the last-resort wrap for unbreakable strings;
  // `min-w-0 overflow-hidden` allows the grid track to shrink past content width.
  // Prominent focus cards get extra padding and a larger value clamp so the
  // three risk-ranked leads read bigger than the demoted secondary strip.
  const padding = prominent ? 'p-5' : 'p-4';
  const valueClamp = prominent
    ? 'text-[clamp(1.125rem,9cqi,1.875rem)]'
    : 'text-[clamp(0.875rem,7cqi,1.5rem)]';

  const baseClass = `flex flex-col gap-1 ${padding} rounded-card border border-neutral-border bg-neutral-surface-raised min-w-0 overflow-hidden [container-type:inline-size]`;

  const body = (
    <>
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary truncate">
        {label}
      </span>
      <span
        className={`font-semibold tppm-mono break-words leading-tight ${valueClamp} ${valueColor}`}
      >
        {value}
      </span>
      {sub && <span className="text-xs text-neutral-text-disabled tppm-mono truncate">{sub}</span>}
    </>
  );

  // Interactive drill-down: the whole card is a single <Link> (matching
  // ProgramCard, rule 181 hover-lift via border+translate, never shadow). The
  // aria-label replaces the inner text so the destination is announced as one
  // action. `min-h-[44px]` guarantees the rule-5 touch target (the cards are
  // taller than that in practice, but the floor is explicit).
  if (to) {
    return (
      <Link
        to={to}
        title={title}
        aria-label={`${label}: ${value}${sub ? `, ${sub}` : ''}. View ${toLabel ?? 'details'}.`}
        className={`${baseClass} min-h-[44px] transition-[transform,border-color] motion-safe:hover:-translate-y-px hover:border-brand-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1`}
      >
        {body}
      </Link>
    );
  }

  return (
    <div title={title} className={baseClass}>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

// Two-tier skeleton mirroring the loaded layout (3 prominent focus + 3 compact
// secondary) so there is no layout shift when the ranked data arrives.
function KpiSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-28 rounded-card border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised"
          />
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-20 rounded-card border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised"
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared task-row link
// ---------------------------------------------------------------------------

// The Overview task-list panels (Attention, My tasks, Critical path) each render
// task rows that must drill into the task's full-page detail view — the same
// `/projects/:id/tasks/:taskId` route the KPI "Next milestone" card already links
// to via `KpiCard`. The affordance mirrors that card: rule-4 focus ring, rule-181
// hover-lift via border + translate (never a shadow, rule 1), and a rule-5 44px
// touch-target floor. A row whose task id is unknown (e.g. an overallocation
// attention item spanning no single task) stays a non-interactive static read.
const TASK_ROW_LINK_CLASS =
  'transition-[transform,border-color] motion-safe:hover:-translate-y-px ' +
  'hover:border-brand-primary/60 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-brand-primary focus-visible:ring-offset-1';

function taskDetailPath(projectId: string, taskId: string): string {
  return `/projects/${projectId}/tasks/${taskId}`;
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
  projectId: string;
}

// Severity dot colors mirror the design mockup (mockups-pages.jsx OverviewBody
// attention rows). The icon glyph remains as a screen-reader-friendly fallback
// when the severity color alone could fail WCAG 1.4.1.
const SEVERITY_DOT_CLASS: Record<AttentionItem['severity'], string> = {
  critical: 'bg-semantic-critical',
  warning: 'bg-semantic-at-risk',
  info: 'bg-brand-primary',
};

function AttentionPanel({ items, projectId }: AttentionPanelProps) {
  if (items.length === 0) {
    return (
      <div
        className="flex items-center gap-2 px-4 py-3 rounded-card border border-semantic-on-track/30
          bg-semantic-on-track-bg text-sm text-semantic-on-track"
        role="status"
      >
        <span aria-hidden="true">✓</span>
        No items need attention right now.
      </div>
    );
  }

  // Grid card styling is shared by the interactive (linked) and static (no
  // task_id) forms so the two read identically apart from the link affordance.
  const cardClass =
    'grid grid-cols-[10px_1fr_auto] gap-3 items-start px-4 py-3 rounded-card ' +
    'border border-neutral-border bg-neutral-surface-raised text-sm min-h-[44px]';

  return (
    <ul className="flex flex-col gap-2" aria-label="Items needing attention">
      {items.map((item, i) => {
        const body = (
          <>
            {/* Severity dot — colour conveys severity, aria-label conveys severity in words */}
            <span
              className={`mt-1.5 w-2.5 h-2.5 rounded-full ${SEVERITY_DOT_CLASS[item.severity]}`}
              role="img"
              aria-label={`${item.severity} severity`}
            />
            <span className="flex flex-col min-w-0">
              <span className="text-neutral-text-primary truncate flex items-center gap-1.5">
                <span aria-hidden="true" className="text-xs">
                  {ATTENTION_ICONS[item.type]}
                </span>
                {item.task_name}
              </span>
              <span className="text-xs text-neutral-text-secondary">{item.detail}</span>
            </span>
            {item.date && (
              <span className="text-xs text-neutral-text-secondary tppm-mono whitespace-nowrap pt-0.5">
                {item.date}
              </span>
            )}
          </>
        );

        // A single task can surface under more than one attention type
        // (e.g. critical_task_late AND baseline_drift), so task_id alone is
        // not unique — compose type + index in so keys never collide.
        return (
          <li key={`${item.task_id ?? 'none'}-${item.type}-${i}`}>
            {item.task_id ? (
              <Link
                to={taskDetailPath(projectId, item.task_id)}
                aria-label={`${item.task_name}: ${item.detail}. View task.`}
                className={`${cardClass} ${TASK_ROW_LINK_CLASS}`}
              >
                {body}
              </Link>
            ) : (
              <div className={cardClass}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// My tasks panel
// ---------------------------------------------------------------------------

interface MyTasksPanelProps {
  tasks: MyTask[];
  projectId: string;
}

function MyTasksPanel({ tasks, projectId }: MyTasksPanelProps) {
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
      case 'COMPLETE':
        return { label: 'Done', cls: 'border-semantic-on-track/40 text-semantic-on-track' };
      case 'IN_PROGRESS':
        return { label: 'In progress', cls: 'border-brand-primary/40 text-brand-primary' };
      case 'REVIEW':
        return { label: 'Review', cls: 'border-brand-accent-dark/40 text-brand-accent-dark' };
      case 'NOT_STARTED':
        return { label: 'Not started', cls: 'border-neutral-border text-neutral-text-secondary' };
      case 'BACKLOG':
        return { label: 'Backlog', cls: 'border-neutral-border text-neutral-text-secondary' };
      case 'ON_HOLD':
        return { label: 'On hold', cls: 'border-semantic-warning/40 text-semantic-warning' };
      default:
        return null;
    }
  }

  return (
    <ul className="flex flex-col gap-1" aria-label="My tasks due this week">
      {tasks.map((task) => {
        const pill = statusPill(task.status);
        const initials = task.owner_initials ?? '?';
        const ownerLabel = task.owner_name ?? 'Unassigned';
        return (
          <li key={task.id}>
            <Link
              to={taskDetailPath(projectId, task.id)}
              aria-label={`${task.name}, ${Math.round(task.percent_complete)}% complete${
                task.is_critical ? ', on the critical path' : ''
              }. View task.`}
              className={`flex items-center gap-3 px-3 py-2 rounded-card border border-neutral-border
                bg-neutral-surface-raised text-sm min-h-[44px] ${TASK_ROW_LINK_CLASS}`}
            >
              {task.is_critical && (
                <span
                  aria-label="Critical path"
                  title="This task is on the critical path"
                  className="flex-shrink-0 text-xs font-bold text-semantic-critical
                  border border-semantic-critical/50 rounded-chip px-1 leading-4"
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
                <span
                  className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-chip border ${pill.cls}`}
                >
                  {pill.label}
                </span>
              )}
              {task.due && (
                <span className="flex-shrink-0 text-xs text-neutral-text-secondary tppm-mono">
                  {task.due}
                </span>
              )}
            </Link>
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
          <li key={task.id}>
            <Link
              to={taskDetailPath(projectId, task.id)}
              aria-label={`${task.name}, ${task.duration} days, on the critical path. View task.`}
              title="This task is on the critical path — a delay here delays the project end date"
              className={`flex flex-col gap-0.5 px-3 py-2 rounded-card border border-neutral-border
                bg-neutral-surface-raised text-sm min-h-[44px] ${TASK_ROW_LINK_CLASS}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  aria-label="Critical path"
                  className="flex-shrink-0 text-xs font-bold text-semantic-critical
                    border border-semantic-critical/50 rounded-chip px-1 leading-4"
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
            </Link>
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
            focus-visible:outline-none rounded-control"
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

  // Persistent rerun affordance — outline secondary, never the primary CTA
  // (Janet's persona prefers a quiet button on Overview, #335).
  const rerunButton = (
    <button
      type="button"
      onClick={() => runMutation.mutate({})}
      disabled={runMutation.isPending}
      className="self-start text-xs border border-neutral-border bg-neutral-surface rounded-control px-3 h-7 font-medium
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
        <div className="h-20 rounded-card border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised" />
      ) : mc ? (
        <div className="flex flex-col gap-3 p-4 rounded-card border border-neutral-border bg-neutral-surface-raised">
          <div className="flex items-end gap-4 flex-wrap">
            <MonteCarloHistogram result={mc} />
            <div className="flex flex-col gap-1">
              <p className="text-xs text-neutral-text-secondary">
                8 in 10 simulations finish by{' '}
                <span className="tppm-mono font-medium text-neutral-text-primary">
                  {formatIsoDate(mc.p80)}
                </span>
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="bg-transparent border border-semantic-on-track/40 rounded-chip
                    px-2 py-0.5 text-xs tppm-mono text-semantic-on-track"
                >
                  P50 {formatIsoDate(mc.p50)}
                </span>
                <span
                  className="bg-transparent border border-semantic-at-risk/40 rounded-chip
                    px-2 py-0.5 text-xs tppm-mono text-semantic-at-risk"
                >
                  P80 {formatIsoDate(mc.p80)}
                </span>
                <span
                  className="bg-transparent border border-semantic-critical/40 rounded-chip
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
                focus-visible:outline-none rounded-control"
            >
              See full forecast
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-4 rounded-card border border-neutral-border bg-neutral-surface-raised">
          <p className="text-sm text-neutral-text-secondary">
            No forecast available. Run a simulation to see finish date probabilities.
          </p>
          <button
            type="button"
            onClick={() => runMutation.mutate({})}
            disabled={runMutation.isPending}
            className="self-start text-xs bg-brand-primary text-white rounded-control px-3 h-7 font-medium
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
// Overview metric builder
// ---------------------------------------------------------------------------

const HEALTH_LABEL: Record<OverviewData['schedule_health'], string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  critical: 'Critical',
  unknown: 'Unknown',
};

const HEALTH_VARIANT: Record<OverviewData['schedule_health'], OverviewMetric['variant']> = {
  on_track: 'on-track',
  at_risk: 'at-risk',
  critical: 'critical',
  unknown: 'neutral',
};

/**
 * Build the six Overview KPI metrics from the loaded payloads. Pre-load (no
 * `overview` yet) returns the all-neutral "—" placeholder set so the focus
 * heading reads calm ("Project health") rather than alarming. The ranking and
 * the focus/secondary split happen in the caller against this array.
 *
 * Plain-language leads only: no SPI/EVM/CPI/WBS in any label or subtitle. The
 * raw SPI rides along in the schedule card's `title` for the PM who wants it —
 * the `/overview/` payload exposes no signed day-variance, so a "+9d vs
 * baseline" subtitle would be fabricated from SPI, which rule 120 forbids.
 */
function buildOverviewMetrics(
  overview: OverviewData | undefined,
  mcData: MonteCarloResult | undefined,
  projectId: string | undefined,
  canSeeResources: boolean,
): OverviewMetric[] {
  // Drill-down targets resolve to `undefined` (static card) whenever there is no
  // project id yet — the pre-load neutral placeholder set must never be clickable.
  const base = projectId ? `/projects/${projectId}` : undefined;

  // ── Schedule health ────────────────────────────────────────────────────
  const health = overview?.schedule_health ?? 'unknown';
  const scheduleSub =
    health === 'on_track'
      ? 'On schedule'
      : health === 'at_risk' || health === 'critical'
        ? 'Behind schedule'
        : 'Not yet computed';
  const scheduleMetric: OverviewMetric = {
    key: 'schedule_health',
    label: 'Schedule health',
    value: HEALTH_LABEL[health],
    sub: scheduleSub,
    variant: HEALTH_VARIANT[health],
    title:
      overview?.spi != null ? `Schedule Performance Index: ${overview.spi.toFixed(2)}` : undefined,
    // Always actionable when a project exists — for `unknown` the schedule view
    // is where the scheduler is run, so navigation is the remedy, not a dead end.
    to: base ? `${base}/schedule` : undefined,
    toLabel: 'the schedule',
  };

  // ── Forecast finish (P80 date — informational, always neutral) ─────────
  const p80 = mcData?.p80;
  const forecastMetric: OverviewMetric = {
    key: 'forecast_finish',
    label: 'Forecast finish',
    value: p80 ? formatIsoDate(p80) : '—',
    sub: '8 in 10 finish by',
    variant: 'neutral',
    title: p80 ? undefined : 'Run the scheduler',
    to: base && p80 ? `${base}/schedule` : undefined,
    toLabel: 'the forecast',
  };

  // ── Tasks late ─────────────────────────────────────────────────────────
  const lateCount = overview?.tasks_late_count;
  const hasLate = lateCount != null && lateCount > 0;
  const tasksLateMetric: OverviewMetric = {
    key: 'tasks_late',
    label: 'Tasks late',
    value: lateCount != null ? `${lateCount} late` : '—',
    sub: overview?.total_tasks != null ? `of ${overview.total_tasks} tasks` : undefined,
    variant: hasLate ? 'at-risk' : overview ? 'on-track' : 'neutral',
    // Deep-link into the grid pre-filtered to the same "late" set the count
    // summarizes (`?due=overdue`). Real-zero stays static (rule 172).
    to: base && hasLate ? `${base}/grid?due=overdue` : undefined,
    toLabel: 'overdue tasks',
  };

  // ── Open risks ─────────────────────────────────────────────────────────
  const high = overview?.high_risk_count;
  const open = overview?.open_risk_count;
  const hasRisks = (high != null && high > 0) || (open != null && open > 0);
  const risksValue =
    high != null && high > 0 ? `${high} high` : open != null ? `${open} open` : '—';
  const openRisksMetric: OverviewMetric = {
    key: 'open_risks',
    label: 'Open risks',
    value: risksValue,
    sub: open != null ? `${open} in register` : undefined,
    variant: high != null && high > 0 ? 'at-risk' : overview ? 'on-track' : 'neutral',
    // Risk register rows already open a RiskDrawer; a high count pre-focuses the
    // High segment. Real-zero stays static (rule 172).
    to:
      base && hasRisks
        ? `${base}/risk${high != null && high > 0 ? '?severity=high' : ''}`
        : undefined,
    toLabel: 'the risk register',
  };

  // ── Team utilization ───────────────────────────────────────────────────
  const util = overview?.team_utilization_pct;
  const utilVariant: OverviewMetric['variant'] =
    util == null ? 'neutral' : util > 100 ? 'critical' : util >= 85 ? 'at-risk' : 'on-track';
  const utilizationMetric: OverviewMetric = {
    key: 'team_utilization',
    label: 'Team utilization',
    value: util != null ? `${Math.round(util)}%` : '—',
    sub: util != null ? 'of capacity' : undefined,
    variant: utilVariant,
    // The Team/Resources view is role-gated to SCHEDULER+ (rule 94), so only
    // link it when the viewer can actually see it — a Member/Viewer gets a
    // static read rather than a click into a 403.
    to: base && util != null && canSeeResources ? `${base}/resources` : undefined,
    toLabel: 'team allocation',
  };

  // ── Next milestone (informational, always neutral) ─────────────────────
  let milestoneSub: string | undefined;
  if (overview?.next_milestone?.date) {
    const days = daysFromToday(overview.next_milestone.date);
    milestoneSub = days < 0 ? `${Math.abs(days)}d ago` : days === 0 ? 'Today' : `in ${days}d`;
  }
  const milestoneId = overview?.next_milestone?.id;
  const milestoneMetric: OverviewMetric = {
    key: 'next_milestone',
    label: 'Next milestone',
    value: overview?.next_milestone?.name ?? '—',
    sub: milestoneSub,
    variant: 'neutral',
    // Open the milestone task's full-page detail view.
    to: base && milestoneId ? `${base}/tasks/${milestoneId}` : undefined,
    toLabel: 'the milestone',
  };

  return [
    scheduleMetric,
    forecastMetric,
    tasksLateMetric,
    openRisksMetric,
    utilizationMetric,
    milestoneMetric,
  ];
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

  const {
    data: overview,
    isLoading: overviewLoading,
    isError: overviewError,
    refetch: refetchOverview,
  } = useProjectOverview(projectId);
  const {
    data: attention,
    isLoading: attentionLoading,
    isError: attentionError,
    refetch: refetchAttention,
  } = useProjectAttention(projectId);
  const {
    data: myTasks,
    isLoading: myTasksLoading,
    isError: myTasksError,
    refetch: refetchMyTasks,
  } = useMyTasks(projectId);
  const {
    data: cpTasks,
    isLoading: cpTasksLoading,
    isError: cpTasksError,
    refetch: refetchCpTasks,
  } = useCriticalPathTasks(projectId);
  const { data: mcData } = useMonteCarloResult(projectId);

  // Methodology-adaptive rendering (#1765). The Overview is the landing page, so a
  // single-methodology team must not be pushed the other workflow's chrome. Gate the
  // three cross-methodology widgets exactly where the rest of the app already draws the
  // line, never inventing a new rule:
  //   • Monte Carlo → the `monte_carlo` leaf surface (ADR-0193; defaults off for AGILE,
  //     still honors an admin who turns it back on).
  //   • Critical path → the `schedule` tab (hidden for AGILE, ADR-0041) — it is a CPM
  //     artifact and its empty state literally says "Run the scheduler".
  //   • Backlog/sprint forecast → the `sprints` tab (hidden for WATERFALL) — a schedule-
  //     first PM never runs sprints, so its permanent "warming up" state is pure noise.
  // Defaults resolve to HYBRID / all-visible until the project loads, so nothing flashes
  // hidden on first paint (matching `useSurfaceVisibility`'s lossless default).
  const { data: project } = useProject(projectId);
  const surfaces = useSurfaceVisibility(projectId);
  const effectiveMethodology = project?.effective_methodology ?? 'HYBRID';
  const showMonteCarlo = surfaces.monte_carlo;
  const showCriticalPath = isTabVisibleForMethodology('schedule', effectiveMethodology);
  const showSprintForecast = isTabVisibleForMethodology('sprints', effectiveMethodology);

  // The Team utilization card only drills into the role-gated Resources view
  // (rule 94) for SCHEDULER+; lower roles get a static read (no click into a
  // 403). Pessimistic while the role loads (role null → not linkable).
  const { role } = useCurrentUserRole(projectId);
  const canSeeResources = role !== null && role >= ROLE_SCHEDULER;

  // Build the six overview metrics once, then rank them worst-first and split
  // into a 3-card focus row + a 3-card secondary strip. Plain-language
  // leads only — SPI survives only as the schedule card's `title` because the
  // `/overview/` payload has no signed day-variance field to show honestly
  // (rule 120: never fabricate a day count from SPI). Each metric also carries
  // its drill-down route (#1691) — an interactive card when actionable, a
  // static read for real-zero / no-data / role-gated cases (rule 172).
  const metrics = buildOverviewMetrics(overview, mcData, projectId, canSeeResources);
  const ranked = rankOverviewMetrics(metrics);
  const focus = ranked.slice(0, 3);
  const secondary = ranked.slice(3);
  const focusHeadingText = focusHeading(focus);

  return (
    <div className="flex flex-col gap-6 p-6 overflow-y-auto h-full bg-app-canvas">
      {/* Project header */}
      {overview && !overviewLoading && projectId && (
        <ProjectHeader overview={overview} projectId={projectId} />
      )}

      {/* KPI rows — three risk-ranked focus cards lead, three demote to a
          compact secondary strip. Worst-first ordering means the card
          a PM needs to act on is always at the top-left. Visual order ===
          DOM order: the data is sorted and rendered in that order, never CSS
          `order`, so screen-reader order matches the visual priority. */}
      {overviewError ? (
        // Without this the health row hangs on KpiSkeleton forever on a failed
        // fetch — indistinguishable from a slow load (issue #1764).
        <section aria-label="Project health">
          <QueryErrorState
            variant="inline"
            message="Couldn't load project health."
            onRetry={() => void refetchOverview()}
          />
        </section>
      ) : overviewLoading ? (
        <section aria-label="Project health">
          <KpiSkeleton />
        </section>
      ) : (
        <>
          <section aria-labelledby="overview-focus-heading">
            <h2
              id="overview-focus-heading"
              className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3"
            >
              {focusHeadingText}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {focus.map((m) => (
                <KpiCard
                  key={m.key}
                  label={m.label}
                  value={m.value}
                  sub={m.sub}
                  variant={m.variant}
                  title={m.title}
                  to={m.to}
                  toLabel={m.toLabel}
                  prominent
                />
              ))}
            </div>
          </section>

          {secondary.length > 0 && (
            <section aria-labelledby="overview-secondary-heading">
              <h2
                id="overview-secondary-heading"
                className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3"
              >
                More metrics
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {secondary.map((m) => (
                  <KpiCard
                    key={m.key}
                    label={m.label}
                    value={m.value}
                    sub={m.sub}
                    variant={m.variant}
                    title={m.title}
                    to={m.to}
                    toLabel={m.toLabel}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Blocked-task roll-up — the PM's impediment triage list (ADR-0124). */}
      {projectId && <BlockedRollupPanel scope="project" projectId={projectId} />}

      {/* Monte Carlo forecast widget (#172) — gated on the monte_carlo surface (#1765). */}
      {projectId && showMonteCarlo && <MonteCarloWidget projectId={projectId} />}

      {/* Burn-up chart */}
      {projectId && (
        <section aria-label="Burn-up chart">
          <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
            Burn-up
          </h2>
          <BurnChart projectId={projectId} defaultVariant="burnup" />
        </section>
      )}

      {/* Backlog delivery forecast — velocity Monte Carlo (#487). Sprint artifact:
         hidden on WATERFALL, where its permanent "warming up" state is noise (#1765). */}
      {projectId && showSprintForecast && <SprintForecastWidget projectId={projectId} />}

      {/* Two-column lower section — gated on projectId so the task-row links can
          address the task detail route (rows are inert until the project is known). */}
      {projectId && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Attention panel */}
          <section aria-label="Attention items">
            <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
              Needs attention
            </h2>
            {attentionError ? (
              <QueryErrorState
                variant="inline"
                message="Couldn't load attention items."
                onRetry={() => void refetchAttention()}
              />
            ) : attentionLoading ? (
              <div className="h-24 rounded-card border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised" />
            ) : (
              <AttentionPanel items={attention ?? []} projectId={projectId} />
            )}
          </section>

          {/* My tasks */}
          <section aria-label="My tasks this week">
            <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
              My tasks this week
            </h2>
            {myTasksError ? (
              <QueryErrorState
                variant="inline"
                message="Couldn't load your tasks."
                onRetry={() => void refetchMyTasks()}
              />
            ) : myTasksLoading ? (
              <div className="h-24 rounded-card border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised" />
            ) : (
              <MyTasksPanel tasks={myTasks ?? []} projectId={projectId} />
            )}
          </section>
        </div>
      )}

      {/* Critical path panel — CPM/schedule artifact, hidden on AGILE (#1765). */}
      {projectId && showCriticalPath && (
        <section aria-label="Critical path">
          <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
            Critical path
          </h2>
          {cpTasksError ? (
            <QueryErrorState
              variant="inline"
              message="Couldn't load the critical path."
              onRetry={() => void refetchCpTasks()}
            />
          ) : cpTasksLoading ? (
            <div className="h-24 rounded-card border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised" />
          ) : (
            <CriticalPathPanel tasks={cpTasks ?? []} projectId={projectId} />
          )}
        </section>
      )}

      {/* Project history (import provenance, #799). Self-hides when the
         project has no recorded imports — common case for TruePPM-authored
         projects, so no empty placeholder. */}
      {projectId && <ImportProvenanceSection projectId={projectId} />}
    </div>
  );
}
