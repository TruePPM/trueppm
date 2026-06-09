import { useEffect, useRef, useState, type SVGProps } from 'react';

import { BurnChart } from '@/features/reports/BurnChart';
import {
  daysUntil,
  forecastScopeCaption,
  formatShortDate,
  sprintDayOf,
} from '@/features/sprints/sprintMath';
import { VelocitySparkline } from '@/features/sprints/VelocitySparkline';
import {
  useActiveSprint,
  useProjectVelocity,
  useSprintMutations,
} from '@/hooks/useSprints';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_SCHEDULER } from '@/lib/roles';
import type { ApiSprint } from '@/types';

interface Props {
  projectId: string;
  methodology: 'WATERFALL' | 'AGILE' | 'HYBRID' | undefined;
}

/**
 * Active-sprint summary embedded at the top of the Board view (ADR-0073).
 *
 * Hidden entirely on WATERFALL projects (ADR-0041 tab-visibility precedent)
 * and on projects with no ACTIVE sprint. Renders a 56px header band with
 * sprint goal, dates, and days-remaining; below the band a collapsible body
 * shows burndown, velocity sparkline, and a capacity_points editor that is
 * read-only for VIEWER/MEMBER and inline-editable for SCHEDULER+.
 *
 * Collapsed-state defaults: expanded for SCHEDULER+, collapsed for
 * VIEWER/MEMBER. Persisted in localStorage per project.
 */
export function SprintPanel({ projectId, methodology }: Props) {
  const { sprint } = useActiveSprint(projectId);
  const { role } = useCurrentUserRole(projectId);
  const { data: velocity, isLoading: velocityLoading } = useProjectVelocity(projectId);
  const { updateSprint } = useSprintMutations(projectId);
  const isScheduler = role !== null && role >= ROLE_SCHEDULER;
  const storageKey = `trueppm.board.${projectId}.sprintPanel.open`;
  const [open, setOpen] = useState<boolean | null>(null);

  // Restore prior choice or apply role-based default once we know the role.
  useEffect(() => {
    if (open !== null) return;
    if (role === null) return;
    const stored = readStoredOpen(storageKey);
    setOpen(stored ?? isScheduler);
  }, [open, role, isScheduler, storageKey]);

  // Hide for WATERFALL projects and projects without an active sprint.
  if (methodology === 'WATERFALL') return null;
  if (!sprint) return null;

  const handleToggle = () => {
    const next = !(open ?? isScheduler);
    setOpen(next);
    writeStoredOpen(storageKey, next);
  };

  const handleSaveCapacity = (value: number | null) => {
    updateSprint.mutate({ sprintId: sprint.id, payload: { capacity_points: value } });
  };

  const handleSaveWip = (value: number | null) => {
    updateSprint.mutate({ sprintId: sprint.id, payload: { wip_limit: value } });
  };

  const isOpen = open ?? isScheduler;

  // The header WIP chip opens (never toggles closed) the panel so its editor is
  // reachable in one click — chip → expand → WipCard inline edit (#546).
  const handleOpenForWip = () => {
    if (isOpen) return;
    setOpen(true);
    writeStoredOpen(storageKey, true);
  };

  return (
    <section
      aria-label="Active sprint summary"
      className="border-b border-neutral-border bg-neutral-surface-raised"
      data-testid="sprint-panel"
    >
      <Header
        sprint={sprint}
        isOpen={isOpen}
        onToggle={handleToggle}
        onWipChipClick={handleOpenForWip}
      />
      <div
        id={`sprint-panel-body-${sprint.id}`}
        hidden={!isOpen}
        className="px-4 py-4 flex flex-col gap-3 lg:flex-row lg:gap-4"
      >
        <div className="flex-1 min-w-0">
          <BurnChart sprintId={sprint.id} defaultVariant="burndown" />
        </div>
        <div className="flex flex-col gap-3 lg:w-60 flex-shrink-0">
          <VelocityCard velocity={velocity} isLoading={velocityLoading} />
          <CapacityCard
            sprint={sprint}
            canEdit={isScheduler}
            isSaving={updateSprint.isPending}
            onSave={handleSaveCapacity}
          />
          <WipCard
            sprint={sprint}
            canEdit={isScheduler}
            isSaving={updateSprint.isPending}
            onSave={handleSaveWip}
          />
        </div>
      </div>
    </section>
  );
}

interface HeaderProps {
  sprint: ApiSprint;
  isOpen: boolean;
  onToggle: () => void;
  onWipChipClick: () => void;
}

function Header({ sprint, isOpen, onToggle, onWipChipClick }: HeaderProps) {
  const daysRemaining = Math.max(0, daysUntil(sprint.finish_date));
  const { day: dayOf, total: totalDays } = sprintDayOf(
    sprint.start_date,
    sprint.finish_date,
  );

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
            Day{' '}
            <span className="tppm-mono">{dayOf}</span> of{' '}
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
      </div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={`sprint-panel-body-${sprint.id}`}
        aria-label={isOpen ? 'Collapse sprint panel' : 'Expand sprint panel'}
        className="flex-shrink-0 w-11 h-11 rounded-md flex items-center justify-center
          text-neutral-text-secondary hover:bg-chrome-row-hover
          focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 focus-visible:outline-none"
      >
        <ChevronIcon open={isOpen} />
      </button>
    </div>
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
 * Header-band WIP chip (#546): "WIP {count}/{limit}". Neutral while the
 * in-flight count is within the limit; at-risk color once it exceeds it —
 * Alex's "surface WIP overload before it's a team-health problem" signal.
 * Clicking expands the panel so the inline WIP editor is reachable. Rendered
 * only when ``Sprint.wip_limit`` is set (the caller suppresses it otherwise).
 */
function WipChip({ count, limit, onClick }: WipChipProps) {
  const over = count > limit;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="sprint-wip-chip"
      aria-label={
        over
          ? `WIP over limit: ${count} in progress, limit ${limit}`
          : `WIP within limit: ${count} in progress, limit ${limit}`
      }
      className={`tppm-mono inline-flex items-center gap-1 rounded px-1 -mx-1
        focus-visible:ring-2 focus-visible:ring-brand-primary
        focus-visible:ring-offset-1 focus-visible:outline-none hover:bg-chrome-row-hover
        ${over ? 'text-semantic-at-risk font-semibold' : 'text-neutral-text-secondary'}`}
    >
      {over && <span aria-hidden="true">⚠</span>}
      WIP {count}/{limit}
    </button>
  );
}

interface VelocityCardProps {
  velocity: ReturnType<typeof useProjectVelocity>['data'];
  isLoading: boolean;
}

function VelocityCard({ velocity, isLoading }: VelocityCardProps) {
  return (
    <div className="rounded-md border border-neutral-border bg-neutral-surface p-3">
      <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
        Velocity
      </h3>
      <VelocitySparkline velocity={velocity} isLoading={isLoading} />
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

  const status = planned !== null && committed !== null
    ? capacityStatus(planned, committed)
    : null;

  return (
    <div className="rounded-md border border-neutral-border bg-neutral-surface p-3">
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
              border border-neutral-border rounded px-1 py-0.5
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
            className={`flex items-center gap-1 text-sm font-semibold rounded px-1 -mx-1
              cursor-pointer hover:bg-chrome-row-hover
              focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:outline-none
              ${planned !== null
                ? 'text-neutral-text-primary tppm-mono'
                : 'text-neutral-text-secondary'}`}
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
  const over = limit !== null && count > limit;

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
    <div className="rounded-md border border-neutral-border bg-neutral-surface p-3">
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
              border border-neutral-border rounded px-1 py-0.5
              focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:outline-none"
          />
        ) : canEdit ? (
          <button
            type="button"
            onClick={startEdit}
            aria-label={
              limit === null
                ? 'Set WIP limit'
                : `Edit WIP limit, currently ${limit}`
            }
            className={`flex items-center gap-1 text-sm font-semibold rounded px-1 -mx-1
              cursor-pointer hover:bg-chrome-row-hover
              focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:outline-none
              ${limit !== null
                ? 'text-neutral-text-primary tppm-mono'
                : 'text-neutral-text-secondary'}`}
          >
            {limit !== null ? limit : 'Not set'}
            <PencilIcon aria-hidden="true" />
          </button>
        ) : (
          <span
            className={`text-sm font-semibold ${
              limit !== null
                ? 'text-neutral-text-primary tppm-mono'
                : 'text-neutral-text-secondary'
            }`}
          >
            {limit !== null ? limit : 'Not set'}
          </span>
        )}
      </div>
      <p className="flex items-center justify-between text-xs">
        <span className="font-medium text-neutral-text-secondary">In progress</span>
        <span className="tppm-mono text-sm font-semibold text-neutral-text-primary">
          {count}
        </span>
      </p>
      {over && (
        <p
          className="mt-2 text-xs flex items-center gap-1 text-semantic-at-risk"
          aria-live="polite"
        >
          <span aria-hidden="true">⚠</span>
          <span>Over WIP by {count - (limit ?? 0)}</span>
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
