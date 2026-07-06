import { useMemo, useState, type ReactNode } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  useProjectCalendars,
  useCalendarLibrary,
  useCalendarPreview,
  useUpdateProjectCalendars,
  buildUpdatePayload,
  type CalendarRole,
} from '@/hooks/useProjectCalendars';
import { SettingsPageTitle } from '../SettingsShell';
import { EnterpriseBadge } from '@/features/settings/components/EnterpriseBadge';
import { CalendarIcon, PlusIcon, CloseIcon, ChevronRightIcon, WarningIcon } from '@/components/Icons';
import { AddCalendarPicker } from './AddCalendarPicker';
import {
  buildMonthGrids,
  classifyDay,
  countLostWorkdays,
  cellDayNumber,
  dayTypeFillStyle,
  summarizeCalendar,
  formatFullDate,
  spanWindow,
  monthWindow,
  shiftAnchor,
  DAY_TYPE_TAG,
  DOW_LABELS,
  type DayType,
  type MonthGrid,
} from './calendarDisplay';

const PANEL_HELP =
  'The days scheduling refuses to place work are the union of every calendar applied here. Row order is grouping, not priority.';

const ROLE_CHIP: Record<CalendarRole, { label: string; className: string }> = {
  project: {
    label: 'project',
    className: 'bg-brand-primary/10 text-brand-primary',
  },
  holidays: {
    label: 'holidays',
    className: 'bg-[color:var(--cal-holiday-bg)] text-[color:var(--cal-holiday-fg)]',
  },
  workspace: {
    label: 'workspace',
    className: 'bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-border/55',
  },
};

const TODAY = new Date();
const TODAY_ISO = TODAY.toISOString().slice(0, 10);

/**
 * Working calendars — project settings sub-page (ADR-0251, #906).
 *
 * Composes a project's non-working day mask from a base calendar plus overlay
 * calendars (holiday sets, workspace shutdowns) and previews the resulting
 * effective working time. Scheduler+ can edit; Viewers see the same panel
 * read-only (the server returns 403 on the PUT — the UI mirrors that gate so a
 * disallowed control never flashes).
 *
 * Layout A (side-by-side) at >= lg: the applied stack on the left, the month
 * preview on the right. Below lg the two stack; below md the preview collapses
 * to a single month with a ‹ › pager and the picker opens as a bottom sheet.
 */
export function ProjectCalendarsPage() {
  const projectId = useProjectId();
  const { role } = useCurrentUserRole(projectId ?? undefined);
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === 'sm';

  const canEdit = (role ?? -1) >= ROLE_SCHEDULER;

  const applied = useProjectCalendars(projectId);
  const library = useCalendarLibrary();

  // Preview window. Desktop shows a rolling quarter from the current month;
  // mobile shows a single month. The pager shifts the anchor and the preview
  // query re-keys on the new window (each window is a distinct cache entry).
  const [anchor, setAnchor] = useState({ year: TODAY.getUTCFullYear(), month: TODAY.getUTCMonth() });
  const months = isMobile ? 1 : 3;
  const window = isMobile ? monthWindow(anchor.year, anchor.month) : spanWindow(anchor.year, anchor.month, months);
  const preview = useCalendarPreview(projectId, window.start, window.end);

  const update = useUpdateProjectCalendars(projectId);
  const [pickerOpen, setPickerOpen] = useState(false);

  const appliedIds = useMemo(
    () => new Set((applied.data?.applied ?? []).map((a) => a.calendar.id)),
    [applied.data],
  );

  function handleAdd(ids: string[]) {
    if (!applied.data || ids.length === 0) {
      setPickerOpen(false);
      return;
    }
    update.mutate(buildUpdatePayload(applied.data, ids, []), {
      onSettled: () => setPickerOpen(false),
    });
  }

  function handleRemove(layerId: string) {
    if (!applied.data) return;
    update.mutate(buildUpdatePayload(applied.data, [], [layerId]));
  }

  // ---- Loading ----------------------------------------------------------
  if (applied.isLoading) {
    return (
      <div>
        <SettingsPageTitle title="Working calendars" subtitle="Loading calendars…" />
        <div className="px-6 pb-8">
          <PanelSkeleton />
        </div>
      </div>
    );
  }

  // ---- Error ------------------------------------------------------------
  if (applied.error || !applied.data) {
    return (
      <div>
        <SettingsPageTitle title="Working calendars" />
        <div className="px-6 pb-10">
          <div className="flex flex-col items-center py-10 text-center" role="alert">
            <div className="mb-3.5 flex h-11 w-11 items-center justify-center rounded-full bg-sem-critical-bg text-semantic-critical">
              <WarningIcon aria-hidden="true" />
            </div>
            <h2 className="mb-1.5 text-[15px] font-semibold text-neutral-text-primary">
              Couldn&apos;t load working calendars
            </h2>
            <p className="mb-4 max-w-[380px] text-[13px] leading-snug text-neutral-text-secondary">
              The scheduling service didn&apos;t respond. Your schedule is unaffected — nothing has
              changed.
            </p>
            <button
              type="button"
              onClick={() => void applied.refetch()}
              className="min-h-[44px] rounded-control border border-neutral-border bg-neutral-surface-raised px-4 text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 sm:min-h-[36px]"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const data = applied.data;
  const overlays = data.overlays;
  const hasHolidayOverlay = overlays.some((o) => o.role !== 'project');

  return (
    <div>
      <SettingsPageTitle title="Working calendars" subtitle={PANEL_HELP} />
      <div className="px-6 pb-10">
        {!canEdit && role !== null && (
          <div className="mb-4 flex items-center gap-2.5 rounded-control border border-neutral-border/55 bg-neutral-surface-sunken px-3.5 py-2.5 text-[12.5px] text-neutral-text-secondary">
            <LockGlyph />
            <span>
              You have view-only access. Ask a Project Manager to change scheduling calendars.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(300px,1fr)_minmax(360px,1.35fr)] lg:items-start">
          {/* ── Applied stack ─────────────────────────────────────────── */}
          <section aria-label="Applied calendars" className="relative">
            <SubHead>
              Applied to this project
              <span className="font-normal normal-case tracking-normal text-neutral-text-disabled">
                {data.applied.length} calendar{data.applied.length === 1 ? '' : 's'}
              </span>
            </SubHead>
            <div className="flex flex-col gap-2">
              {data.base && (
                <CalendarRow
                  name={data.base.name}
                  kind="project"
                  summary={summarizeCalendar(data.base, 'project')}
                  locked
                />
              )}
              {overlays.map((o) => (
                <CalendarRow
                  key={o.layer_id ?? o.calendar.id}
                  name={o.calendar.name}
                  kind={o.role}
                  summary={summarizeCalendar(o.calendar, o.role)}
                  onRemove={
                    canEdit && o.layer_id ? () => handleRemove(o.layer_id as string) : undefined
                  }
                  removing={update.isPending}
                />
              ))}
            </div>

            {canEdit && (
              <>
                <button
                  type="button"
                  onClick={() => setPickerOpen((v) => !v)}
                  aria-expanded={pickerOpen}
                  aria-haspopup="dialog"
                  className="mt-2 flex h-[42px] w-full items-center justify-center gap-1.5 rounded-control border border-dashed border-neutral-border text-[13px] font-medium text-neutral-text-secondary hover:border-brand-primary hover:text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  <PlusIcon aria-hidden="true" />
                  Add calendar
                </button>
                {pickerOpen && !isMobile && (
                  <AddCalendarPicker
                    variant="popover"
                    library={library.data ?? []}
                    appliedIds={appliedIds}
                    submitting={update.isPending}
                    onAdd={handleAdd}
                    onClose={() => setPickerOpen(false)}
                  />
                )}
              </>
            )}

            {/* Empty nudge — base only, no holiday/shutdown overlay applied. */}
            {canEdit && !hasHolidayOverlay && (
              <div className="mt-4 flex flex-col items-center rounded-card border border-dashed border-neutral-border bg-neutral-surface-raised px-6 py-8 text-center">
                <div className="mb-3.5 flex h-11 w-11 items-center justify-center rounded-card bg-[color:var(--cal-holiday-bg)] text-[color:var(--cal-holiday-fg)]">
                  <CalendarIcon aria-hidden="true" />
                </div>
                <h3 className="mb-1.5 text-[15px] font-semibold text-neutral-text-primary">
                  No holiday calendars applied
                </h3>
                <p className="mb-4 max-w-[400px] text-[13px] leading-relaxed text-neutral-text-secondary">
                  Work is currently scheduled straight through public holidays. Add a holidays
                  calendar so the schedule respects them.
                </p>
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-control border border-brand-primary-dark bg-brand-primary px-4 text-[13px] font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 sm:min-h-[38px]"
                >
                  <PlusIcon aria-hidden="true" />
                  Add a holidays calendar
                </button>
              </div>
            )}
          </section>

          {/* ── Effective preview ─────────────────────────────────────── */}
          <section aria-label="Effective working time">
            <PreviewStrip
              isMobile={isMobile}
              loading={preview.isFetching && !preview.data}
              grids={preview.data ? buildMonthGrids(preview.data) : []}
              rangeLabel={rangeLabel(window.start, window.end, isMobile)}
              onPrev={() => setAnchor((a) => shiftAnchor(a, -months))}
              onNext={() => setAnchor((a) => shiftAnchor(a, months))}
            />
            {preview.data && (
              <div className="mt-3.5 flex items-center gap-2.5 rounded-control border border-neutral-border bg-sem-on-track-bg px-3.5 py-2.5">
                <span className="text-[13px] text-neutral-text-primary">
                  This project loses{' '}
                  <b className="font-bold">
                    {countLostWorkdays(preview.data.days)} working day
                    {countLostWorkdays(preview.data.days) === 1 ? '' : 's'}
                  </b>{' '}
                  to non-working time in this window.
                </span>
              </div>
            )}
            {/* Applying a calendar reshapes the schedule — CPM recomputes on save. */}
            <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-snug text-neutral-text-secondary">
              <span className="mt-px shrink-0 text-semantic-warning">
                <WarningIcon aria-hidden="true" />
              </span>
              Applying this changes the schedule — adding or removing a calendar reschedules dated
              work automatically.
            </p>
          </section>
        </div>

        {/* ── Enterprise-gated capabilities ───────────────────────────── */}
        <EnterpriseTiles />
      </div>

      {pickerOpen && isMobile && canEdit && (
        <AddCalendarPicker
          variant="sheet"
          library={library.data ?? []}
          appliedIds={appliedIds}
          submitting={update.isPending}
          onAdd={handleAdd}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function SubHead({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-text-secondary">
      {children}
    </div>
  );
}

interface CalendarRowProps {
  name: string;
  kind: CalendarRole;
  summary: string;
  locked?: boolean;
  onRemove?: () => void;
  removing?: boolean;
}

function CalendarRow({ name, kind, summary, locked, onRemove, removing }: CalendarRowProps) {
  const chip = ROLE_CHIP[kind];
  return (
    <div className="flex items-center gap-3 rounded-control border border-neutral-border bg-neutral-surface-raised px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold text-neutral-text-primary">
            {name}
          </span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${chip.className}`}
          >
            {chip.label}
          </span>
        </div>
        <div className="mt-0.5 text-[12px] text-neutral-text-secondary">{summary}</div>
      </div>
      {locked ? (
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-text-secondary bg-neutral-surface-sunken border border-neutral-border/55"
          title="Base calendar — can't be removed"
        >
          Base
        </span>
      ) : (
        onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={removing}
            aria-label={`Remove ${name} from project`}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken hover:text-neutral-text-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 sm:h-8 sm:w-8"
          >
            <CloseIcon aria-hidden="true" />
          </button>
        )
      )}
    </div>
  );
}

interface PreviewStripProps {
  isMobile: boolean;
  loading: boolean;
  grids: MonthGrid[];
  rangeLabel: string;
  onPrev: () => void;
  onNext: () => void;
}

function PreviewStrip({ isMobile, loading, grids, rangeLabel, onPrev, onNext }: PreviewStripProps) {
  return (
    <div className="overflow-hidden rounded-control border border-neutral-border bg-neutral-surface">
      <div className="flex items-center gap-2.5 border-b border-neutral-border bg-neutral-surface-raised px-3.5 py-2.5">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-neutral-text-secondary">
          Effective working time
        </span>
        <span className="text-[12px] text-neutral-text-secondary">· {rangeLabel}</span>
        <div className="ml-auto flex gap-1">
          <PagerButton label={isMobile ? 'Previous month' : 'Previous quarter'} onClick={onPrev} dir="prev" />
          <PagerButton label={isMobile ? 'Next month' : 'Next quarter'} onClick={onNext} dir="next" />
        </div>
      </div>
      <div className="p-3.5">
        {loading ? (
          <GridSkeleton count={isMobile ? 1 : 3} />
        ) : (
          <div className="flex gap-4">
            {grids.map((g) => (
              <MonthView key={`${g.year}-${g.month}`} grid={g} hideName={isMobile} />
            ))}
          </div>
        )}
      </div>
      <Legend />
    </div>
  );
}

function PagerButton({ label, onClick, dir }: { label: string; onClick: () => void; dir: 'prev' | 'next' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      <span className={dir === 'prev' ? 'rotate-180' : ''}>
        <ChevronRightIcon aria-hidden="true" />
      </span>
    </button>
  );
}

function MonthView({ grid, hideName }: { grid: MonthGrid; hideName?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      {!hideName && (
        <div className="mb-2 text-center text-[12px] font-semibold text-neutral-text-primary">
          {grid.label}
        </div>
      )}
      <div className="mb-0.5 grid grid-cols-7 gap-[3px]">
        {DOW_LABELS.map((d, i) => (
          <span key={i} className="text-center text-[9px] font-semibold text-neutral-text-disabled">
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-[3px]">
        {grid.cells.map((cell, i) => (
          <DayCell key={i} cell={cell} />
        ))}
      </div>
    </div>
  );
}

function DayCell({ cell }: { cell: ReturnType<typeof classifyDay> | null }) {
  if (!cell) return <div className="aspect-square" aria-hidden="true" />;
  const num = cellDayNumber(cell);
  const isToday = cell.date === TODAY_ISO;
  const working = cell.type === 'working';
  const tag = cell.type === 'holiday' || cell.type === 'shutdown' ? DAY_TYPE_TAG[cell.type] : null;

  const title =
    cell.sources.length > 0
      ? `${formatFullDate(cell.date)} — ${cell.sources.map((s) => s.name).join(', ')}`
      : formatFullDate(cell.date);

  return (
    <div
      title={title}
      aria-label={working ? undefined : title}
      style={working ? undefined : dayTypeFillStyle(cell.type)}
      className={[
        'relative flex aspect-square items-center justify-center rounded text-[11px]',
        working
          ? 'border border-neutral-border/55 bg-neutral-surface text-neutral-text-primary'
          : 'border border-transparent font-semibold',
        isToday ? 'outline outline-2 outline-offset-1 outline-brand-primary' : '',
      ].join(' ')}
    >
      {num}
      {tag && (
        <span className="pointer-events-none absolute right-0.5 top-0.5 text-[7px] font-bold leading-none">
          {tag}
        </span>
      )}
      {/* Split corner marks a day blocked by more than one calendar. */}
      {cell.multi && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 h-0 w-0 border-b-[7px] border-l-[7px] border-b-current border-l-transparent"
        />
      )}
    </div>
  );
}

const LEGEND_ROWS: { type: DayType; label: string }[] = [
  { type: 'working', label: 'Working' },
  { type: 'weekend', label: 'Weekend' },
  { type: 'holiday', label: 'Holiday' },
  { type: 'shutdown', label: 'Shutdown' },
];

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-neutral-border bg-neutral-surface-raised px-3.5 py-2.5">
      {LEGEND_ROWS.map(({ type, label }) => (
        <span key={type} className="flex items-center gap-1.5 text-[11.5px] text-neutral-text-secondary">
          <span
            style={type === 'working' ? undefined : dayTypeFillStyle(type)}
            className="h-3 w-3 shrink-0 rounded-sm border border-neutral-border/55"
          />
          <b className="font-semibold text-neutral-text-primary">{label}</b>
        </span>
      ))}
    </div>
  );
}

const ENTERPRISE_TILES = [
  {
    title: 'Resource & PTO calendars',
    body: "Make a task's duration depend on who's assigned — per-person availability feeds cross-project resource leveling.",
  },
  {
    title: 'Cross-program calendar governance',
    body: 'Publish and enforce shared calendars across an org, with change approval.',
  },
  {
    title: 'External holiday feeds (iCal)',
    body: 'Auto-import national and regional public-holiday sets from subscribed feeds.',
  },
] as const;

function EnterpriseTiles() {
  return (
    <div className="mt-8 border-t border-neutral-border pt-6">
      <h2 className="text-[15px] font-semibold text-neutral-text-primary">
        Scheduling · beyond a single project
      </h2>
      <p className="mb-4 mt-0.5 max-w-[620px] text-[13px] leading-relaxed text-neutral-text-secondary">
        These calendar capabilities span people, programs, and external systems. They live in
        TruePPM Enterprise and appear here only as gated affordances — no Enterprise flow ships in
        the open-source build.
      </p>
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {ENTERPRISE_TILES.map((tile) => (
          <div
            key={tile.title}
            className="rounded-card border border-neutral-border bg-neutral-surface-raised p-4 opacity-90"
          >
            <div className="mb-2.5 flex items-center">
              <span className="text-[14px] font-semibold text-neutral-text-primary">{tile.title}</span>
              <EnterpriseBadge />
            </div>
            <p className="mb-3.5 text-[12.5px] leading-relaxed text-neutral-text-secondary">
              {tile.body}
            </p>
            <button
              type="button"
              disabled
              className="min-h-[36px] cursor-not-allowed rounded-control border border-neutral-border bg-neutral-surface px-3 text-[12px] font-medium text-neutral-text-secondary opacity-60"
            >
              Learn about Enterprise
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Skeletons & glyphs -------------------------------------------------

function PanelSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(300px,1fr)_minmax(360px,1.35fr)]">
      <div>
        <SubHead>Applied to this project</SubHead>
        {[0, 1, 2].map((i) => (
          <div key={i} className="mb-2 h-[60px] animate-pulse rounded-control bg-neutral-surface-sunken" />
        ))}
      </div>
      <div>
        <div className="mb-3 h-8 animate-pulse rounded bg-neutral-surface-sunken" />
        <GridSkeleton count={3} />
      </div>
    </div>
  );
}

function GridSkeleton({ count }: { count: number }) {
  return (
    <div className="flex gap-4">
      {Array.from({ length: count }).map((_, m) => (
        <div key={m} className="flex-1">
          <div className="mx-auto mb-2 h-3 w-3/5 animate-pulse rounded bg-neutral-surface-sunken" />
          <div className="grid grid-cols-7 gap-[3px]">
            {Array.from({ length: 35 }).map((_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded bg-neutral-surface-sunken" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function LockGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
      <path
        d="M4.5 7V5a3.5 3.5 0 017 0v2M3.5 7h9v6h-9z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Human range label for the preview header, e.g. "Nov 2026 – Jan 2027". */
function rangeLabel(start: string, end: string, isMobile: boolean): string {
  const fmt = (iso: string) => {
    const [y, m] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  };
  if (isMobile) return fmt(start);
  const s = fmt(start);
  const e = fmt(end);
  return s === e ? s : `${s} – ${e}`;
}
