import { LockIcon, WarningIcon } from '@/components/Icons';
import { useEffect, useRef, useState, type SVGProps } from 'react';

import { BurnChart } from '@/features/reports/BurnChart';
import {
  daysUntil,
  forecastScopeCaption,
  formatShortDate,
  sprintDayOf,
} from '@/features/sprints/sprintMath';
import { VelocitySparkline } from '@/features/sprints/VelocitySparkline';
import { VelocityForecastLine } from '@/features/sprints/VelocityForecastLine';
import { SprintForecastChips } from '@/features/sprints/SprintForecastChips';
import { PromoteMilestoneDialog } from '@/features/sprints/PromoteMilestoneDialog';
import { SprintScopeBadge } from '@/features/sprints/SprintScopeBadge';
import { wipState } from '@/features/board/wip';
import { useActiveSprint, useProjectVelocity, useSprintMutations } from '@/hooks/useSprints';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { ROLE_SCHEDULER } from '@/lib/roles';
import type { ApiSprint, BoardCadence } from '@/types';

interface Props {
  projectId: string;
  methodology: 'WATERFALL' | 'AGILE' | 'HYBRID' | undefined;
  /**
   * Board cadence (ADR-0164, issue 410). `continuous` runs continuous-flow Kanban, which
   * hides the sprint panel entirely. `undefined` while the project query loads falls
   * back to showing the panel (the sprint-existence gate still applies).
   */
  boardCadence: BoardCadence | undefined;
}

/**
 * Active-sprint summary embedded at the top of the Board view (ADR-0073).
 *
 * Hidden entirely on WATERFALL projects (ADR-0041 tab-visibility precedent)
 * and on projects with no ACTIVE sprint. Renders a 56px header band with
 * sprint goal, dates, and days-remaining; below the band a collapsible body
 * shows the velocity/capacity/WIP cards and a pull-on-demand burndown
 * disclosure. Capacity/WIP editors are read-only for VIEWER/MEMBER and
 * inline-editable for SCHEDULER+.
 *
 * Collapsed-state default: collapsed for EVERY role (#1983) so the Kanban
 * board — the surface the team works on every standup — sits above the fold
 * on open. The header band still carries the at-a-glance signals (committed
 * points, WIP chip, "N on critical path"). A user's manual expand is
 * persisted in localStorage per project.
 */
export function SprintPanel({ projectId, methodology, boardCadence }: Props) {
  const { sprint } = useActiveSprint(projectId);
  const itl = useIterationLabel(projectId);
  const { role } = useCurrentUserRole(projectId);
  const { data: velocity, isLoading: velocityLoading } = useProjectVelocity(projectId);
  // Deduped against the board's own ['tasks', projectId] query — no extra fetch.
  const { tasks: projectTasks } = useScheduleTasks(projectId);
  const { updateSprint } = useSprintMutations(projectId);
  const isScheduler = role !== null && role >= ROLE_SCHEDULER;
  const storageKey = `trueppm.board.${projectId}.sprintPanel.open`;
  const [open, setOpen] = useState<boolean | null>(null);
  // Promote-to-milestone dialog (DA-02 / ADR-0106, #1052). Binding is a
  // schedule-authoring write, so the board entry point is SCHEDULER+ only — the
  // server enforces the same gate; this is render-gate only.
  const [promoting, setPromoting] = useState(false);

  // Restore prior choice, else default collapsed for everyone (#1983) — the
  // board must be above the fold on open, not a chart. Role no longer changes
  // the default; the effect still waits for the role so a stored choice and the
  // header's role-gated affordances resolve together.
  useEffect(() => {
    if (open !== null) return;
    if (role === null) return;
    const stored = readStoredOpen(storageKey);
    setOpen(stored ?? false);
  }, [open, role, storageKey]);

  // Hide for WATERFALL projects, continuous-flow Kanban boards (ADR-0164, issue 410),
  // and projects without an active sprint.
  if (methodology === 'WATERFALL') return null;
  if (boardCadence === 'continuous') return null;
  if (!sprint) return null;

  const handleToggle = () => {
    const next = !(open ?? false);
    setOpen(next);
    writeStoredOpen(storageKey, next);
  };

  const handleSaveCapacity = (value: number | null) => {
    updateSprint.mutate({ sprintId: sprint.id, payload: { capacity_points: value } });
  };

  const handleSaveWip = (value: number | null) => {
    updateSprint.mutate({ sprintId: sprint.id, payload: { wip_limit: value } });
  };

  const isOpen = open ?? false;

  // The header WIP chip opens (never toggles closed) the panel so its editor is
  // reachable in one click — chip → expand → WipCard inline edit (#546).
  const handleOpenForWip = () => {
    if (isOpen) return;
    setOpen(true);
    writeStoredOpen(storageKey, true);
  };

  // The reverse hybrid bridge (issue 549): how much of the active sprint sits on the
  // CPM critical path. Filtering to this sprint's tasks already excludes the
  // issue-332 trap (uncommitted backlog ideas CPM auto-marks critical) — sprint
  // membership *is* the schedule commitment — so no separate scheduled-gate is
  // needed; completed work drops out. Aggregates the per-card CP signal the board
  // already shows.
  const criticalCount = (projectTasks ?? []).filter(
    (t) => t.sprintId === sprint.id && t.isCritical && !t.isComplete,
  ).length;

  return (
    <section
      aria-label={`Active ${itl.lower} summary`}
      className="border-b border-neutral-border bg-neutral-surface-raised"
      data-testid="sprint-panel"
    >
      <Header
        sprint={sprint}
        isOpen={isOpen}
        onToggle={handleToggle}
        onWipChipClick={handleOpenForWip}
        canLinkMilestone={isScheduler && sprint.target_milestone == null}
        onLinkMilestone={() => setPromoting(true)}
        iterationLower={itl.lower}
        criticalCount={criticalCount}
      />
      <div
        id={`sprint-panel-body-${sprint.id}`}
        hidden={!isOpen}
        className="px-4 py-4 flex flex-col gap-4"
      >
        {/* Velocity / capacity / WIP as an equal-width card row (#1983). The
            burndown no longer sits here as a dominating left column — it is
            pull-on-demand below, and its full analytical view lives on
            Reports → Metrics. */}
        <div className="flex flex-col gap-3 lg:flex-row lg:gap-4">
          <div className="lg:flex-1 min-w-0">
            <VelocityCard
              projectId={projectId}
              velocity={velocity}
              isLoading={velocityLoading}
              targetMilestoneId={sprint.target_milestone}
            />
          </div>
          <div className="lg:flex-1 min-w-0">
            <CapacityCard
              sprint={sprint}
              canEdit={isScheduler}
              isSaving={updateSprint.isPending}
              onSave={handleSaveCapacity}
            />
          </div>
          <div className="lg:flex-1 min-w-0">
            <WipCard
              sprint={sprint}
              canEdit={isScheduler}
              isSaving={updateSprint.isPending}
              onSave={handleSaveWip}
            />
          </div>
        </div>
        {/* Sprint-finish + release-horizon projections (#487), both linking to
            the full backlog forecast on the overview. */}
        <SprintForecastChips projectId={projectId} sprintId={sprint.id} />
        {/* Pull-on-demand burndown (#1983): collapsed by default so it never
            dominates the board. The header sparkline is the at-a-glance
            trigger; the full cross-sprint view lives on Reports → Metrics. */}
        <BurndownDisclosure sprintId={sprint.id} storageKey={`${storageKey}.burndown`} />
      </div>
      {promoting && (
        <PromoteMilestoneDialog
          projectId={projectId}
          sprint={sprint}
          onClose={() => setPromoting(false)}
        />
      )}
    </section>
  );
}

/**
 * Pull-on-demand burndown (#1983). Collapsed by default and separately
 * persisted, so revealing the full chart on the board is an explicit opt-in
 * that never pushes the columns below the fold. The at-a-glance trigger is the
 * compact sparkline in the sibling `BoardSprintHeader` (which renders above
 * this panel on the board); this disclosure is the on-board detail view.
 * `aria-expanded`/`aria-controls` are sourced from the toggle state only
 * (rule 210 — no hover-reveal desync). The chart mounts only while open, so a
 * closed disclosure costs no fetch.
 */
function BurndownDisclosure({ sprintId, storageKey }: { sprintId: string; storageKey: string }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
        /* storage may be unavailable (private mode) — in-memory state still works */
      }
      return next;
    });
  };
  const bodyId = `sprint-burndown-body-${sprintId}`;
  return (
    <div className="border-t border-neutral-border/60 pt-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid="sprint-burndown-toggle"
        className="flex w-full min-h-[44px] items-center gap-2 rounded-control px-1 py-1 text-left text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary hover:bg-chrome-row-hover focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
      >
        <span aria-hidden="true" className={`transition-transform ${open ? 'rotate-90' : ''}`}>
          ▸
        </span>
        Burndown
      </button>
      {/* The controlled region is always in the DOM so aria-controls never
          dangles; the chart itself mounts only when open, so a closed
          disclosure still costs no fetch. */}
      <div id={bodyId} hidden={!open}>
        {open && (
          <div className="pt-3" data-testid="sprint-burndown-body">
            <BurnChart sprintId={sprintId} defaultVariant="burndown" />
          </div>
        )}
      </div>
    </div>
  );
}

interface HeaderProps {
  sprint: ApiSprint;
  isOpen: boolean;
  onToggle: () => void;
  onWipChipClick: () => void;
  /** SCHEDULER+ and the active sprint has no bound milestone — show the promote
   *  entry point so the bridge's keystone action is reachable on the board (#1052). */
  canLinkMilestone: boolean;
  onLinkMilestone: () => void;
  iterationLower: string;
  /** In-sprint tasks on the CPM critical path (issue 549) — the reverse bridge signal. */
  criticalCount: number;
}

function Header({
  sprint,
  isOpen,
  onToggle,
  onWipChipClick,
  canLinkMilestone,
  onLinkMilestone,
  iterationLower,
  criticalCount,
}: HeaderProps) {
  const daysRemaining = Math.max(0, daysUntil(sprint.finish_date));
  const { day: dayOf, total: totalDays } = sprintDayOf(sprint.start_date, sprint.finish_date);

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="inline-block w-2 h-2 rounded-full bg-brand-primary flex-shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="flex items-baseline gap-2 truncate">
          <span className="tppm-mono text-sm font-semibold text-neutral-text-primary">
            {sprint.short_id_display}
          </span>
          <span className="text-neutral-text-secondary">·</span>
          <span className="text-sm font-medium text-neutral-text-primary truncate">
            {sprint.goal || sprint.name}
          </span>
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-neutral-text-secondary">
          <span className="tppm-mono">
            {formatShortDate(sprint.start_date)} → {formatShortDate(sprint.finish_date)}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Day <span className="tppm-mono">{dayOf}</span> of{' '}
            <span className="tppm-mono">{totalDays}</span>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <span className="tppm-mono">{daysRemaining}</span> day
            {daysRemaining === 1 ? '' : 's'} left
          </span>
          {sprint.committed_points !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tppm-mono">{sprint.committed_points} pts committed</span>
            </>
          )}
          {sprint.wip_limit != null && (
            <>
              <span aria-hidden="true">·</span>
              <WipChip
                count={sprint.wip_count ?? 0}
                limit={sprint.wip_limit}
                onClick={onWipChipClick}
              />
            </>
          )}
          {criticalCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span
                className="inline-flex items-center gap-1 rounded border border-semantic-critical/40 px-1.5 text-semantic-critical"
                title="On the critical path — a delay on any of these tasks delays the project end date"
                aria-label={`${criticalCount} ${criticalCount === 1 ? 'task' : 'tasks'} on the critical path`}
              >
                <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
                <span className="tppm-mono">{criticalCount}</span>
                <span>on critical path</span>
              </span>
            </>
          )}
        </p>
        {/* Forecast transparency (ADR-0102 §2): when pending injections exist,
            state that the committed points reflect accepted scope only. Shared
            copy (forecastScopeCaption) so the burndown caption can't word it
            differently. Neutral tone — pending is a read-state, not a warning. */}
        {forecastScopeCaption(sprint.pending_count ?? 0) && (
          <p className="mt-0.5 text-xs text-neutral-text-secondary">
            <span aria-hidden="true">○</span> {forecastScopeCaption(sprint.pending_count ?? 0)}
          </p>
        )}
        {/* #543: visible audit badge when tasks were injected after activation —
            opens the team-readable scope-change drawer (who/when/what/points). */}
        <SprintScopeBadge sprintId={sprint.id} />
      </div>
      {canLinkMilestone && (
        <button
          type="button"
          onClick={onLinkMilestone}
          className="flex-shrink-0 inline-flex items-center gap-1 rounded-control px-2.5 py-1.5 text-xs font-medium
            text-brand-primary hover:bg-chrome-row-hover
            focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1 focus-visible:outline-none"
        >
          <DiamondIcon />
          Link to milestone
        </button>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={`sprint-panel-body-${sprint.id}`}
        aria-label={isOpen ? `Collapse ${iterationLower} panel` : `Expand ${iterationLower} panel`}
        className="flex-shrink-0 w-11 h-11 rounded-control flex items-center justify-center
          text-neutral-text-secondary hover:bg-chrome-row-hover
          focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 focus-visible:outline-none"
      >
        <ChevronIcon open={isOpen} />
      </button>
    </div>
  );
}

/** Milestone diamond — the bridge's milestone glyph, echoing the ◆ used on the
 *  Gantt and in the forecast line so "Link to milestone" reads at a glance. */
function DiamondIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1l7 7-7 7-7-7 7-7z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={open ? '' : 'rotate-180'}
    >
      <path d="M3 10l5-5 5 5" />
    </svg>
  );
}

interface WipChipProps {
  count: number;
  limit: number;
  onClick: () => void;
}

/**
 * Header-band WIP chip (#546): "WIP {count}/{limit}". Uses the shared
 * three-band {@link wipState} so the same count/limit state reads identically
 * here and on the board column badges (#232): neutral under the limit, at-risk
 * amber AT the limit, critical red OVER it — Alex's "surface WIP overload
 * before it's a team-health problem" signal. Clicking expands the panel so the
 * inline editor is reachable. Rendered only when ``Sprint.wip_limit`` is set.
 */
function WipChip({ count, limit, onClick }: WipChipProps) {
  const state = wipState(count, limit);
  const flagged = state === 'at' || state === 'over';
  const colorClass =
    state === 'over'
      ? 'text-semantic-critical font-semibold'
      : state === 'at'
        ? 'text-semantic-at-risk font-semibold'
        : 'text-neutral-text-secondary';
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="sprint-wip-chip"
      aria-label={
        state === 'over'
          ? `WIP over limit: ${count} in progress, limit ${limit}`
          : state === 'at'
            ? `WIP at limit: ${count} in progress, limit ${limit}`
            : `WIP within limit: ${count} in progress, limit ${limit}`
      }
      className={`tppm-mono inline-flex items-center gap-1 rounded-control px-1 -mx-1
        focus-visible:ring-2 focus-visible:ring-brand-primary
        focus-visible:ring-offset-1 focus-visible:outline-none hover:bg-chrome-row-hover
        ${colorClass}`}
    >
      {flagged && <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />}
      WIP {count}/{limit}
    </button>
  );
}

interface VelocityCardProps {
  projectId: string;
  velocity: ReturnType<typeof useProjectVelocity>['data'];
  isLoading: boolean;
  targetMilestoneId: string | null;
}

function VelocityCard({ projectId, velocity, isLoading, targetMilestoneId }: VelocityCardProps) {
  // ADR-0104 §2.1: the server nulls the series and sets velocity_suppressed when
  // the reader's tier is below the velocity audience (velocity is team-private by
  // default). Render an explicit "team-private" state — not a misleading "no
  // sprints" empty — and DON'T mount the forecast line (it would pull the
  // sprints-to-complete range, which indirectly reveals the gated velocity band).
  const suppressed = velocity?.velocity_suppressed === true;
  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface p-3">
      <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
        Velocity
      </h3>
      {suppressed ? (
        <p className="text-xs text-neutral-text-secondary" data-testid="velocity-suppressed">
          <LockIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />Velocity is team-private (visible to the team).
        </p>
      ) : (
        <>
          <VelocitySparkline velocity={velocity} isLoading={isLoading} />
          <VelocityForecastLine
            projectId={projectId}
            targetMilestoneId={targetMilestoneId}
            enabled={!isLoading && !suppressed}
          />
        </>
      )}
    </div>
  );
}

interface CapacityCardProps {
  sprint: ApiSprint;
  canEdit: boolean;
  isSaving: boolean;
  onSave: (value: number | null) => void;
}

function CapacityCard({ sprint, canEdit, isSaving, onSave }: CapacityCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const committed = sprint.committed_points;
  const planned = sprint.capacity_points;

  const startEdit = () => {
    if (!canEdit) return;
    setDraft(planned !== null ? String(planned) : '');
    setEditing(true);
  };

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      onSave(null);
    } else {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n >= 0 && Number.isInteger(n)) {
        onSave(n);
      }
    }
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
    setDraft('');
  };

  const status = planned !== null && committed !== null ? capacityStatus(planned, committed) : null;

  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface p-3">
      <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
        Capacity
      </h3>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-medium text-neutral-text-secondary">Planned</span>
        {editing ? (
          <input
            ref={inputRef}
            type="number"
            min={0}
            max={999}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            placeholder="e.g. 40"
            disabled={isSaving}
            aria-label="Planned story-point capacity"
            className="tppm-mono w-16 text-right text-sm font-semibold
              border border-neutral-border rounded-control px-1 py-0.5
              focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:outline-none"
          />
        ) : canEdit ? (
          <button
            type="button"
            onClick={startEdit}
            aria-label={
              planned === null
                ? 'Set planned story-point capacity'
                : `Edit planned story-point capacity, currently ${planned}`
            }
            className={`flex items-center gap-1 text-sm font-semibold rounded-control px-1 -mx-1
              cursor-pointer hover:bg-chrome-row-hover
              focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:outline-none
              ${
                planned !== null
                  ? 'text-neutral-text-primary tppm-mono'
                  : 'text-neutral-text-secondary'
              }`}
          >
            {planned !== null ? planned : 'Not set'}
            <PencilIcon aria-hidden="true" />
          </button>
        ) : (
          <span
            className={`text-sm font-semibold ${
              planned !== null
                ? 'text-neutral-text-primary tppm-mono'
                : 'text-neutral-text-secondary'
            }`}
          >
            {planned !== null ? planned : 'Not set'}
          </span>
        )}
      </div>
      <p className="flex items-center justify-between text-xs">
        <span className="font-medium text-neutral-text-secondary">Committed</span>
        <span
          className={`tppm-mono text-sm font-semibold ${
            committed !== null ? 'text-neutral-text-primary' : 'text-neutral-text-secondary'
          }`}
        >
          {committed !== null ? committed : '—'}
        </span>
      </p>
      {status && (
        <p
          className={`mt-2 text-xs flex items-center gap-1 ${status.colorClass}`}
          aria-live="polite"
        >
          <span aria-hidden="true">{status.icon}</span>
          <span>{status.label}</span>
        </p>
      )}
    </div>
  );
}

function PencilIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M11.5 1.5l3 3-9 9-3.5.5.5-3.5 9-9z" />
    </svg>
  );
}

interface CapacityStatus {
  icon: string;
  label: string;
  colorClass: string;
}

function capacityStatus(planned: number, committed: number): CapacityStatus {
  if (committed <= planned) {
    return {
      icon: '✓',
      label: 'On plan',
      colorClass: 'text-semantic-on-track',
    };
  }
  const overBy = committed - planned;
  const pct = planned > 0 ? Math.round((overBy / planned) * 100) : 100;
  if (pct <= 10) {
    return {
      icon: '⚠',
      label: `Over by ${overBy} (+${pct}%)`,
      colorClass: 'text-semantic-at-risk',
    };
  }
  return {
    icon: '⚠',
    label: `Over by ${overBy} (+${pct}%)`,
    colorClass: 'text-semantic-critical',
  };
}

interface WipCardProps {
  sprint: ApiSprint;
  canEdit: boolean;
  isSaving: boolean;
  onSave: (value: number | null) => void;
}

/**
 * Sibling to CapacityCard: edits ``Sprint.wip_limit`` and shows the live
 * in-flight count (#546). SCHEDULER+ can set/clear the limit (cleared = empty
 * input → null, which suppresses the header chip). Read-only for VIEWER/MEMBER.
 */
function WipCard({ sprint, canEdit, isSaving, onSave }: WipCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Normalize undefined (untyped fixtures) to null so every guard below reads
  // cleanly as "limit set" vs "not set".
  const limit = sprint.wip_limit ?? null;
  const count = sprint.wip_count ?? 0;
  const state = wipState(count, limit);

  const startEdit = () => {
    if (!canEdit) return;
    setDraft(limit !== null ? String(limit) : '');
    setEditing(true);
  };

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      onSave(null);
    } else {
      const n = Number(trimmed);
      // A WIP limit of 0 is meaningless (no work could ever be in flight) — treat
      // only positive integers as a valid limit, mirroring the model's
      // PositiveIntegerField.
      if (Number.isFinite(n) && n >= 1 && Number.isInteger(n)) {
        onSave(n);
      }
    }
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
    setDraft('');
  };

  return (
    <div className="rounded-card border border-neutral-border bg-neutral-surface p-3">
      <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
        Work in progress
      </h3>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-medium text-neutral-text-secondary">Limit</span>
        {editing ? (
          <input
            ref={inputRef}
            type="number"
            min={1}
            max={999}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            placeholder="e.g. 5"
            disabled={isSaving}
            aria-label="WIP limit (in-progress task ceiling)"
            className="tppm-mono w-16 text-right text-sm font-semibold
              border border-neutral-border rounded-control px-1 py-0.5
              focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:outline-none"
          />
        ) : canEdit ? (
          <button
            type="button"
            onClick={startEdit}
            aria-label={limit === null ? 'Set WIP limit' : `Edit WIP limit, currently ${limit}`}
            className={`flex items-center gap-1 text-sm font-semibold rounded-control px-1 -mx-1
              cursor-pointer hover:bg-chrome-row-hover
              focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:outline-none
              ${
                limit !== null
                  ? 'text-neutral-text-primary tppm-mono'
                  : 'text-neutral-text-secondary'
              }`}
          >
            {limit !== null ? limit : 'Not set'}
            <PencilIcon aria-hidden="true" />
          </button>
        ) : (
          <span
            className={`text-sm font-semibold ${
              limit !== null ? 'text-neutral-text-primary tppm-mono' : 'text-neutral-text-secondary'
            }`}
          >
            {limit !== null ? limit : 'Not set'}
          </span>
        )}
      </div>
      <p className="flex items-center justify-between text-xs">
        <span className="font-medium text-neutral-text-secondary">In progress</span>
        <span className="tppm-mono text-sm font-semibold text-neutral-text-primary">{count}</span>
      </p>
      {(state === 'at' || state === 'over') && (
        <p
          className={`mt-2 text-xs flex items-center gap-1 ${
            state === 'over' ? 'text-semantic-critical' : 'text-semantic-at-risk'
          }`}
          aria-live="polite"
        >
          <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
          <span>{state === 'over' ? `Over WIP by ${count - (limit ?? 0)}` : 'At WIP limit'}</span>
        </p>
      )}
    </div>
  );
}

function readStoredOpen(key: string): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function writeStoredOpen(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* ignore quota / privacy errors */
  }
}
