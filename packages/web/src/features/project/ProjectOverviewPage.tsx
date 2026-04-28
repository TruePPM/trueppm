import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

interface OverviewData {
  schedule_health: 'on_track' | 'at_risk' | 'critical' | 'unknown';
  spi: number | null;
  tasks_late_count: number;
  critical_task_count: number;
  next_milestone: { name: string; date: string } | null;
  team_utilization_pct: number | null;
}

interface AttentionItem {
  severity: 'critical' | 'warning' | 'info';
  type: 'critical_task_late' | 'unassigned_approaching' | 'baseline_drift';
  task_id: string | null;
  task_name: string;
  assignee_name: string | null;
  date: string | null;
  detail: string;
}

interface MyTask {
  id: string;
  name: string;
  due: string | null;
  status: string;
  percent_complete: number;
  is_critical: boolean;
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
              <span className="flex-shrink-0 text-xs text-neutral-text-secondary">
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
// KPI card
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  /** Semantic color variant for the value */
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
      <span className={`text-2xl font-semibold ${valueColor}`}>{value}</span>
      {sub && <span className="text-xs text-neutral-text-disabled">{sub}</span>}
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
};

interface AttentionPanelProps {
  items: AttentionItem[];
}

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
          className="flex items-start gap-3 px-4 py-3 rounded border border-neutral-border
            bg-neutral-surface-raised text-sm"
        >
          <span aria-hidden="true" className="flex-shrink-0 mt-0.5">
            {ATTENTION_ICONS[item.type]}
          </span>
          <span className="flex flex-col min-w-0">
            <span className="text-neutral-text-primary truncate">{item.task_name}</span>
            <span className="text-xs text-neutral-text-secondary">{item.detail}</span>
          </span>
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

  return (
    <ul className="flex flex-col gap-1" aria-label="My tasks due this week">
      {tasks.map((task) => (
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
          <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{task.name}</span>
          {task.due && (
            <span className="flex-shrink-0 text-xs text-neutral-text-secondary">{task.due}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-24 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised" />
      ))}
    </div>
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

  // Derive health variant for SPI card
  const spiVariant = (() => {
    if (!overview) return 'neutral' as const;
    const spi = overview.spi ?? 1;
    if (spi >= 0.95) return 'on-track' as const;
    if (spi >= 0.8) return 'at-risk' as const;
    return 'critical' as const;
  })();

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

  return (
    <div className="flex flex-col gap-6 p-6 overflow-y-auto h-full bg-neutral-surface">
      {/* KPI row */}
      <section aria-label="Project KPIs">
        {overviewLoading ? (
          <KpiSkeleton />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <KpiCard
              label="Schedule health"
              value={healthLabel}
              variant={healthVariant}
            />
            <KpiCard
              label="SPI"
              value={overview?.spi != null ? overview.spi.toFixed(2) : '—'}
              sub="Schedule Performance Index"
              variant={spiVariant}
            />
            <KpiCard
              label="Late tasks"
              value={overview?.tasks_late_count != null ? String(overview.tasks_late_count) : '—'}
              variant={overview && overview.tasks_late_count > 0 ? 'at-risk' : 'on-track'}
            />
            <KpiCard
              label="Critical tasks"
              value={overview?.critical_task_count != null ? String(overview.critical_task_count) : '—'}
              variant={overview && overview.critical_task_count > 0 ? 'critical' : 'neutral'}
            />
            <KpiCard
              label="Next milestone"
              value={overview?.next_milestone?.name ?? '—'}
              sub={overview?.next_milestone?.date}
            />
            <KpiCard
              label="Team utilization"
              value={overview?.team_utilization_pct != null ? `${Math.round(overview.team_utilization_pct)}%` : '—'}
              variant={
                overview?.team_utilization_pct != null
                  ? overview.team_utilization_pct > 100
                    ? 'critical'
                    : overview.team_utilization_pct >= 85
                    ? 'at-risk'
                    : 'on-track'
                  : 'neutral'
              }
            />
          </div>
        )}
      </section>

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
