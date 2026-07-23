import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Risk } from '@/api/types';
import { useRisks } from '@/hooks/useRisks';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjects } from '@/hooks/useProjects';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { canEditRisk } from '@/lib/roles';
import { EmptyState } from '@/components/EmptyState';
import { QueryErrorState } from '@/components/QueryErrorState';
import { RiskImportModal } from './RiskImportModal';
import { Button } from '@/components/Button';
import { RiskIcon } from '@/components/Icons';
import { RiskChip } from './RiskChip';
import { RiskMatrix, type SelectedCell } from './RiskMatrix';
import { RiskDrawer } from './RiskDrawer';
import { RiskSegmentedFilter } from './RiskSegmentedFilter';
import { exportRisksToCSV } from './riskExport';
import {
  HIGH_SEVERITY_THRESHOLD,
  RISK_FILTERS,
  type RiskFilter,
  type SeveritySort,
  isUnmitigated,
  matchesRiskFilter,
  nextSeveritySort,
  riskFilterCounts,
  severityAriaSort,
  sortRisksByNewest,
  sortRisksBySeverity,
} from './riskFilters';
import { localTodayIso } from '@/lib/localDate';

const FILTER_EMPTY_COPY: Record<Exclude<RiskFilter, 'all'>, string> = {
  high: 'No high-severity risks.',
  unmitigated: 'No unmitigated risks — every risk is resolved, accepted, or closed.',
  mine: 'None of the risks are assigned to you.',
};

const STATUS_LABELS: Record<Risk['status'], string> = {
  OPEN: 'Open',
  MITIGATING: 'Mitigating',
  RESOLVED: 'Resolved',
  ACCEPTED: 'Accepted',
  CLOSED: 'Closed',
};

/**
 * localStorage key for the client-side severity-band visibility preference.
 * Persists the set of hidden bands so the choice survives a reload/remount.
 * Mirrors the board's `trueppm.board.*` lazy-read / write-on-change pattern.
 */
const HIDDEN_SEVERITIES_KEY = 'trueppm.riskFilters.hiddenSeverities';

/**
 * Severity bands, keyed by the lower bound of their `probability × impact`
 * score (matching the design-system severity color mapping, web-rule 86).
 * The "Display" toggle hides whole bands; LOW is the canonical hideable band
 * (low-noise risks a PM may want to collapse out of the register).
 */
type SeverityBand = 'low';

/** Inclusive score range for each hideable severity band. */
const SEVERITY_BANDS: Record<SeverityBand, { min: number; max: number }> = {
  // LOW + MINIMAL collapse into the single user-facing "low" band: score 1–5.
  low: { min: 1, max: 5 },
};

/** True when the risk's severity falls inside the given band's score range. */
function isInBand(risk: Pick<Risk, 'severity'>, band: SeverityBand): boolean {
  const { min, max } = SEVERITY_BANDS[band];
  return risk.severity >= min && risk.severity <= max;
}

/**
 * Reads the persisted hidden-band set from localStorage. Tolerates a missing,
 * empty, or malformed value by returning an empty set rather than throwing —
 * an unreadable preference must never break the register.
 */
function readHiddenSeverities(): Set<SeverityBand> {
  try {
    const raw = localStorage.getItem(HIDDEN_SEVERITIES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((b): b is SeverityBand => b === 'low'));
  } catch {
    return new Set();
  }
}

export function RiskRegisterView() {
  const projectId = useProjectId() ?? '';
  const { risks, isLoading, error } = useRisks(projectId || null);
  const { data: projects } = useProjects();
  const { user } = useCurrentUser();
  // Risk write gate (Member+) — drives the Import CSV affordance, mirroring the
  // server's IsProjectMemberWrite on the import action (issue 223). Viewers don't see it.
  const { role } = useCurrentUserRole(projectId || undefined);
  const canImport = canEditRisk(role);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);

  // null = drawer closed, undefined = create mode, Risk = edit mode
  const [selectedRisk, setSelectedRisk] = useState<Risk | null | undefined>(null);

  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  // Segment facet (All/High/Unmitigated/Mine) and severity sort — both
  // client-side over the loaded list. Composed with the matrix-cell
  // facet below via AND. Seeded once from `?severity=high` so the Overview
  // "Open risks" card drills straight into the High segment (#1691).
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<RiskFilter>(
    searchParams.get('severity') === 'high' ? 'high' : 'all',
  );
  // `?risk=<id>` deep-link ⇄ open-drawer round-trip (issue #2046). Activity rows
  // for a risk change and the register's own drill-in navigate to
  // `/projects/:id/risk?risk=<id>`; on mount we open the drawer on that risk once
  // the register loads, and mirror the open risk back into the URL so a refresh
  // or link-copy round-trips. Create mode (`selectedRisk === undefined`) carries
  // no id, so the param is stripped.
  const initialRiskParamRef = useRef(searchParams.get('risk'));
  const riskParamConsumedRef = useRef(false);
  useEffect(() => {
    if (riskParamConsumedRef.current) return;
    const id = initialRiskParamRef.current;
    if (!id) {
      riskParamConsumedRef.current = true;
      return;
    }
    if (risks.length === 0) return; // register not loaded yet — retry next render
    const match = risks.find((r) => r.id === id);
    riskParamConsumedRef.current = true;
    if (match) setSelectedRisk(match);
  }, [risks]);
  const selectedRiskId = selectedRisk ? selectedRisk.id : null;
  useEffect(() => {
    if (!riskParamConsumedRef.current) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (selectedRiskId) next.set('risk', selectedRiskId);
        else next.delete('risk');
        return next;
      },
      { replace: true },
    );
  }, [selectedRiskId, setSearchParams]);
  const [severitySort, setSeveritySort] = useState<SeveritySort>('none');
  // "Newest" sort (issue 1230) — created_at descending. Mutually exclusive with
  // the severity column sort: turning one on resets the other, so the table is
  // never governed by two competing orderings.
  const [newestSort, setNewestSort] = useState(false);
  // Client-side severity-band visibility — seeded from localStorage so the
  // preference survives a remount. Persisted on every change. Composes with
  // the segment + matrix-cell facets below (AND): a hidden band drops its
  // rows from the table only; the heatmap and count chips stay over the full set.
  const [hiddenSeverities, setHiddenSeverities] = useState<Set<SeverityBand>>(readHiddenSeverities);

  function toggleSeverityBand(band: SeverityBand) {
    setHiddenSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(band)) next.delete(band);
      else next.add(band);
      localStorage.setItem(HIDDEN_SEVERITIES_KEY, JSON.stringify([...next]));
      return next;
    });
  }
  const isLowHidden = hiddenSeverities.has('low');
  // When true the drawer opens directly in edit mode (✎ quick-edit affordance)
  const [editMode, setEditMode] = useState(false);

  // Mobile overflow menu (… button) — exposes Export CSV on viewports < md (ADR-0043)
  const [isOverflowOpen, setIsOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOverflowOpen) return;
    function onDocClick(e: MouseEvent) {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setIsOverflowOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsOverflowOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOverflowOpen]);

  const projectName = projects?.find((p) => p.id === projectId)?.name ?? null;

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-app-canvas">
        <p className="text-sm text-neutral-text-secondary">Select a project to view risks.</p>
      </div>
    );
  }

  const isDrawerOpen = selectedRisk !== null;
  const criticalCount = risks.filter((r) => r.severity >= 20).length;
  const highCount = risks.filter((r) => r.severity >= 12 && r.severity < 20).length;
  // Header sub-line + segment-chip preview counts (issue 1230), derived over the
  // full loaded register (not the narrowed table). "High" here is high-and-above
  // (>= threshold), matching the High segment filter.
  const currentUserId = user?.id ?? null;
  const filterCounts = riskFilterCounts(risks, currentUserId);
  const highAndAboveCount = risks.filter((r) => r.severity >= HIGH_SEVERITY_THRESHOLD).length;
  const unmitigatedCount = filterCounts.unmitigated;

  // Two orthogonal facets compose with AND: the segment filter, then the matrix
  // cell coordinate, then the severity sort applied last. The heatmap matrix and
  // the count chips above always reflect the *full* set — only the table
  // consumes the facets (dimming the matrix to its own selection would be
  // circular).
  const segmentRisks = risks
    .filter((r) => matchesRiskFilter(r, filter, currentUserId))
    // Severity-band visibility: drop rows in any hidden band (client-side,
    // persisted). Applied alongside the segment facet so both narrow the table.
    .filter((r) => ![...hiddenSeverities].some((band) => isInBand(r, band)));
  const cellRisks = selectedCell
    ? segmentRisks.filter(
        (r) => r.probability === selectedCell.probability && r.impact === selectedCell.impact,
      )
    : segmentRisks;
  // One ordering wins at a time: Newest (created_at desc) overrides the severity
  // column sort when active; otherwise the severity sort applies.
  const displayRisks = newestSort
    ? sortRisksByNewest(cellRisks)
    : sortRisksBySeverity(cellRisks, severitySort);

  const isFiltered = filter !== 'all' || selectedCell !== null;
  function clearAllFilters() {
    setFilter('all');
    setSelectedCell(null);
  }

  // Overdue: MITIGATING status + mitigation_due_date in the past (client-side, ADR-0043)
  const todayIso = localTodayIso();

  // Project slug for CSV filename — derived from name since the Project type has no slug field.
  const projectSlug =
    (projectName ?? projectId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || projectId;

  function openCreate() {
    setEditMode(false);
    setSelectedRisk(undefined);
  }
  function openRisk(risk: Risk) {
    setEditMode(false);
    setSelectedRisk(risk);
  }
  function openRiskEdit(risk: Risk) {
    setEditMode(true);
    setSelectedRisk(risk);
  }
  function closeDrawer() {
    setEditMode(false);
    setSelectedRisk(null);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-app-canvas">
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 shrink-0">
        {/* Breadcrumb + heading */}
        <div className="min-w-0 flex flex-col gap-1">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
          >
            <span className="truncate">{projectName ?? 'Project'}</span>
            <span aria-hidden="true" className="text-neutral-text-disabled">
              /
            </span>
            <span>Risks</span>
          </nav>
          <h1 className="text-2xl font-semibold text-neutral-text-primary leading-tight">
            Risk register
          </h1>
          {/* At-a-glance register summary (issue 1230): total logged, high-and-above,
              and unmitigated. Suppressed while loading / on error / empty. */}
          {!isLoading && !error && risks.length > 0 && (
            <p className="text-xs text-neutral-text-secondary">
              {risks.length} in register
              <span aria-hidden="true"> · </span>
              {highAndAboveCount} high
              <span aria-hidden="true"> · </span>
              {unmitigatedCount} unmitigated
            </p>
          )}
        </div>

        {/* Desktop toolbar — count chips + heatmap toggle + new risk */}
        <div className="hidden md:flex items-center gap-2 shrink-0 pt-1">
          {!isLoading && !error && criticalCount > 0 && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-medium
                bg-semantic-critical text-white"
              aria-label={`${criticalCount} critical risk${criticalCount !== 1 ? 's' : ''}`}
            >
              {criticalCount} critical
            </span>
          )}
          {!isLoading && !error && highCount > 0 && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-medium
                bg-brand-accent-dark text-white"
              aria-label={`${highCount} high risk${highCount !== 1 ? 's' : ''}`}
            >
              {highCount} high
            </span>
          )}

          {/* Display — client-side severity-band visibility toggle (persisted).
              Hides low-severity rows from the table to declutter the register. */}
          <label
            className="inline-flex items-center gap-2 h-8 px-3 rounded-control text-xs font-medium
              border border-neutral-border text-neutral-text-primary bg-neutral-surface
              hover:bg-neutral-surface-raised cursor-pointer
              focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1"
          >
            <input
              type="checkbox"
              checked={isLowHidden}
              onChange={() => toggleSeverityBand('low')}
              className="h-3.5 w-3.5 rounded-chip border-neutral-border accent-brand-primary
                focus-visible:outline-none"
            />
            Hide low severity
          </label>

          {/* Newest sort (issue 1230) — created_at descending. A toggle, not a
              cycle: turning it on resets the severity column sort so only one
              ordering governs the table. */}
          <button
            type="button"
            onClick={() =>
              setNewestSort((v) => {
                const next = !v;
                if (next) setSeveritySort('none');
                return next;
              })
            }
            aria-pressed={newestSort}
            className={[
              'inline-flex items-center gap-1 h-8 px-3 rounded-control text-xs font-medium',
              // Standalone toggle/trigger buttons in this toolbar use focus: (not
              // focus-visible:) so the ring shows on pointer-initiated focus in
              // Firefox/Safari (rule 214, WCAG 2.4.7).
              'border focus:outline-none focus:ring-2 focus:ring-brand-primary',
              'focus:ring-offset-1',
              newestSort
                ? 'border-brand-primary/40 bg-brand-primary/10 text-brand-primary'
                : 'border-neutral-border text-neutral-text-primary bg-neutral-surface hover:bg-neutral-surface-raised',
            ].join(' ')}
          >
            Newest
          </button>

          <button
            type="button"
            onClick={() => setShowHeatmap((v) => !v)}
            aria-pressed={showHeatmap}
            className="inline-flex items-center gap-1 h-8 px-3 rounded-control text-xs font-medium
              border border-neutral-border text-neutral-text-primary bg-neutral-surface
              hover:bg-neutral-surface-raised
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1"
          >
            Heatmap
            <span
              aria-hidden="true"
              className="text-neutral-text-disabled text-xs leading-none mt-px"
            >
              ▾
            </span>
          </button>

          {/* Import CSV (issue 223) — write-gated (Member+); not gated on risks.length
              so an empty register can be seeded from a file. */}
          {canImport && (
            <button
              type="button"
              onClick={() => setIsImportOpen(true)}
              className="inline-flex items-center gap-1 h-8 px-3 rounded-control text-xs font-medium
                border border-neutral-border text-neutral-text-secondary bg-neutral-surface
                hover:text-neutral-text-primary hover:bg-neutral-surface-raised
                focus:outline-none focus:ring-2 focus:ring-brand-primary
                focus:ring-offset-1"
            >
              Import CSV
            </button>
          )}

          {risks.length > 0 && (
            <button
              type="button"
              onClick={() => exportRisksToCSV(displayRisks, projectSlug)}
              className="inline-flex items-center gap-1 h-8 px-3 rounded-control text-xs font-medium
                border border-neutral-border text-neutral-text-secondary bg-neutral-surface
                hover:text-neutral-text-primary hover:bg-neutral-surface-raised
                focus:outline-none focus:ring-2 focus:ring-brand-primary
                focus:ring-offset-1"
            >
              Export CSV
            </button>
          )}

          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1 h-8 px-3 rounded-control text-sm font-medium
              text-neutral-text-inverse bg-brand-primary border border-brand-primary-dark
              hover:bg-brand-primary-dark
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1"
          >
            + New risk
          </button>
        </div>

        {/* Mobile overflow menu (< md) — exposes Import (issue 223, Member+) and
            Export CSV (ADR-0043) and other low-frequency actions. Rendered when
            either action is available so import is reachable on an empty register. */}
        {(risks.length > 0 || canImport) && (
          <div ref={overflowRef} className="md:hidden relative shrink-0 pt-1">
            <button
              type="button"
              onClick={() => setIsOverflowOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={isOverflowOpen}
              aria-label="More actions"
              className="inline-flex items-center justify-center w-10 h-10 rounded-control
                text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised
                focus:outline-none focus:ring-2 focus:ring-brand-primary
                focus:ring-offset-1"
            >
              <span aria-hidden="true" className="text-xl leading-none">
                ⋯
              </span>
            </button>
            {isOverflowOpen && (
              <div
                role="menu"
                className="absolute right-0 top-11 min-w-[180px] z-30 rounded-card
                  bg-neutral-surface border border-neutral-border py-1"
              >
                {canImport && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsImportOpen(true);
                      setIsOverflowOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-neutral-text-primary
                      hover:bg-neutral-surface-raised
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset focus:bg-neutral-surface-raised"
                  >
                    Import CSV
                  </button>
                )}
                {risks.length > 0 && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      exportRisksToCSV(displayRisks, projectSlug);
                      setIsOverflowOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-neutral-text-primary
                      hover:bg-neutral-surface-raised
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset focus:bg-neutral-surface-raised"
                  >
                    Export CSV
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </header>

      {/* Mobile-only count pill row — desktop toolbar is hidden < md so pills surface here */}
      {!isLoading && !error && (criticalCount > 0 || highCount > 0) && (
        <div className="md:hidden flex items-center gap-2 px-6 pb-3 shrink-0">
          {criticalCount > 0 && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-medium
                bg-semantic-critical text-white"
              aria-label={`${criticalCount} critical risk${criticalCount !== 1 ? 's' : ''}`}
            >
              {criticalCount} critical
            </span>
          )}
          {highCount > 0 && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-medium
                bg-brand-accent-dark text-white"
              aria-label={`${highCount} high risk${highCount !== 1 ? 's' : ''}`}
            >
              {highCount} high
            </span>
          )}
        </div>
      )}

      {/* ── Two-column content ───────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex gap-4 px-6 pb-6 overflow-hidden">
        {/* Left — heatmap card (lg+, togglable) */}
        {showHeatmap && (
          <aside
            className="hidden lg:flex flex-col shrink-0 w-[440px]
              border border-neutral-border rounded-card p-5
              bg-neutral-surface overflow-auto"
            aria-label="Risk heatmap"
          >
            {isLoading && (
              <div
                className="flex-1 rounded-card motion-safe:animate-pulse bg-neutral-border/30"
                aria-hidden="true"
              />
            )}
            {!isLoading && !error && (
              <RiskMatrix
                risks={risks}
                selectedCell={selectedCell}
                onCellSelect={setSelectedCell}
              />
            )}
          </aside>
        )}

        {/* Right — risk table */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Loading */}
          {isLoading && (
            <div className="flex flex-col gap-1" aria-label="Loading risks" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-14 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse border border-neutral-border"
                  aria-hidden="true"
                />
              ))}
            </div>
          )}

          {/* Error */}
          {!isLoading && error && <QueryErrorState message="Failed to load risks." />}

          {/* Empty — no risks at all */}
          {!isLoading && !error && risks.length === 0 && (
            <EmptyState
              icon={RiskIcon}
              title="No risks yet"
              description="Log the things that could derail this project — then track likelihood, impact, and mitigation in one place."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button onClick={openCreate}>+ Add your first risk</Button>
                  {canImport && (
                    <Button variant="secondary" onClick={() => setIsImportOpen(true)}>
                      Import CSV
                    </Button>
                  )}
                </div>
              }
            />
          )}

          {/* Table */}
          {!isLoading && !error && risks.length > 0 && (
            <>
              {/* Segment filter — single-select facet (All/High/Unmitigated/Mine).
                  A radiogroup (pick exactly one) with roving-tabindex keyboard
                  nav, not a tablist (it filters one list, doesn't swap panels). */}
              <RiskSegmentedFilter value={filter} onChange={setFilter} counts={filterCounts} />

              {/* Active-facet status chip — renders a removable token per active
                  facet (segment and/or matrix cell), each independently
                  clearable, plus a Clear all reset. */}
              {isFiltered && (
                <div
                  className="flex flex-wrap items-center gap-2 mb-2 px-1 shrink-0"
                  role="status"
                  aria-live="polite"
                >
                  <span className="text-xs text-neutral-text-secondary">Filtered to</span>
                  {filter !== 'all' && (
                    <span
                      className="inline-flex items-center gap-1 text-xs font-medium
                      bg-brand-primary/10 text-brand-primary border border-brand-primary/20 rounded-chip px-2 py-0.5"
                    >
                      {RISK_FILTERS.find((f) => f.value === filter)?.label}
                      <button
                        type="button"
                        onClick={() => setFilter('all')}
                        aria-label="Clear severity/ownership filter"
                        className="text-brand-primary hover:text-brand-primary-dark
                          focus:outline-none focus:ring-2 focus:ring-brand-primary
                          focus:ring-offset-1 rounded-control"
                      >
                        ✕
                      </button>
                    </span>
                  )}
                  {selectedCell && (
                    <span
                      className="inline-flex items-center gap-1 text-xs font-medium tppm-mono
                      bg-brand-primary/10 text-brand-primary border border-brand-primary/20 rounded-chip px-2 py-0.5"
                    >
                      P{selectedCell.probability} × I{selectedCell.impact}
                      <button
                        type="button"
                        onClick={() => setSelectedCell(null)}
                        aria-label="Clear matrix cell filter"
                        className="text-brand-primary hover:text-brand-primary-dark
                          focus:outline-none focus:ring-2 focus:ring-brand-primary
                          focus:ring-offset-1 rounded-control"
                      >
                        ✕
                      </button>
                    </span>
                  )}
                  <span className="text-xs text-neutral-text-disabled">
                    {displayRisks.length} of {risks.length}
                  </span>
                  <button
                    type="button"
                    onClick={clearAllFilters}
                    className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary ml-1
                      focus:outline-none focus:ring-2 focus:ring-brand-primary
                      focus:ring-offset-1 rounded-control"
                  >
                    Clear all
                  </button>
                </div>
              )}

              {/* Filtered-empty — risks exist but none match the active facets */}
              {displayRisks.length === 0 && (
                <div
                  className="flex flex-col items-center justify-center gap-3 py-16"
                  role="status"
                  aria-live="polite"
                >
                  <p className="text-sm text-neutral-text-secondary">
                    {selectedCell && filter !== 'all'
                      ? 'No risks match the selected cell and filter.'
                      : filter !== 'all'
                        ? FILTER_EMPTY_COPY[filter]
                        : 'No risks match the selected cell.'}
                  </p>
                  <button
                    type="button"
                    onClick={clearAllFilters}
                    className="text-sm text-brand-primary hover:underline
                      focus:outline-none focus:ring-2 focus:ring-brand-primary
                      focus:ring-offset-1 rounded-control"
                  >
                    Show all risks
                  </button>
                </div>
              )}

              {displayRisks.length > 0 && (
                <div className="flex-1 overflow-auto rounded-card border border-neutral-border bg-neutral-surface">
                  {/* min-w-max lets the table keep its intrinsic column widths and
                      scroll horizontally inside this wrapper on a phone, rather than
                      squishing/clipping at 375px (rule 102a). */}
                  <table className="w-full min-w-max text-sm border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-neutral-surface-raised border-b border-neutral-border">
                        <th
                          scope="col"
                          className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[88px]"
                        >
                          ID
                        </th>
                        <th
                          scope="col"
                          className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide"
                        >
                          Risk
                        </th>
                        <th
                          scope="col"
                          className="text-center px-3 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-10"
                        >
                          P
                        </th>
                        <th
                          scope="col"
                          className="text-center px-3 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-10"
                        >
                          I
                        </th>
                        <th
                          scope="col"
                          aria-sort={newestSort ? 'none' : severityAriaSort(severitySort)}
                          className="px-4 py-3 w-[148px]"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              // Column sort and Newest are mutually exclusive.
                              setNewestSort(false);
                              setSeveritySort((s) => nextSeveritySort(s));
                            }}
                            className="inline-flex items-center gap-1 font-medium text-neutral-text-secondary
                            hover:text-neutral-text-primary text-xs uppercase tracking-wide
                            focus:outline-none focus:ring-2 focus:ring-brand-primary
                            focus:ring-offset-1 rounded-control"
                          >
                            Severity
                            <span aria-hidden="true" className="text-xs leading-none">
                              {severitySort === 'desc' ? '▼' : severitySort === 'asc' ? '▲' : '⇅'}
                            </span>
                          </button>
                        </th>
                        <th
                          scope="col"
                          className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[180px]"
                        >
                          Owner
                        </th>
                        {/* Quick-edit affordance column — no header */}
                        <th scope="col" className="w-10 px-2 py-3" aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {displayRisks.map((risk) => {
                        const isOverdue =
                          risk.status === 'MITIGATING' &&
                          !!risk.mitigation_due_date &&
                          risk.mitigation_due_date < todayIso;
                        // Always-on signal for live threats. Overdue is a strict
                        // subset of unmitigated, so an overdue row layers the
                        // louder bg fill over this left accent border.
                        const unmitigated = isUnmitigated(risk);

                        return (
                          <tr
                            key={risk.id}
                            onClick={() => openRisk(risk)}
                            className={[
                              'group h-14 border-b border-neutral-border last:border-b-0 cursor-pointer',
                              unmitigated ? 'border-l-2 border-l-semantic-at-risk/40' : '',
                              isOverdue
                                ? 'bg-semantic-at-risk-bg hover:bg-semantic-at-risk/10'
                                : 'hover:bg-neutral-surface-raised',
                              // Row acts as a button: focus: (not focus-visible:) so the
                              // ring shows on pointer-initiated focus in Firefox/Safari
                              // (rule 214, WCAG 2.4.7). ring-inset — row lives in a scroll area.
                              'focus:outline-none focus:ring-2 focus:ring-brand-primary',
                              'focus:ring-inset',
                            ].join(' ')}
                            tabIndex={0}
                            role="button"
                            aria-label={`Open risk: ${risk.title}${isOverdue ? ' (overdue mitigation)' : ''}`}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                openRisk(risk);
                              }
                            }}
                          >
                            {/* ID — server-formatted (#929); the client no longer
                              derives it from the raw short_id. */}
                            <td className="px-4 text-xs text-neutral-text-secondary tppm-mono">
                              {risk.short_id_display}
                            </td>

                            {/* Risk — title + status sub-label + overdue badge */}
                            <td className="px-4">
                              <div className="flex flex-col gap-0.5 min-w-0">
                                <span className="text-sm font-medium text-neutral-text-primary leading-snug truncate">
                                  {risk.title}
                                </span>
                                <span className="flex items-center gap-1.5 text-xs text-neutral-text-secondary leading-none">
                                  {STATUS_LABELS[risk.status]}
                                  {isOverdue && (
                                    <span
                                      className="inline-flex items-center rounded-chip px-1.5 py-0.5 text-xs font-medium
                                bg-semantic-at-risk-bg text-semantic-at-risk border border-semantic-at-risk/30"
                                    >
                                      Overdue
                                    </span>
                                  )}
                                </span>
                              </div>
                            </td>

                            {/* P */}
                            <td className="px-3 text-center text-xs text-neutral-text-secondary tabular-nums">
                              {risk.probability}
                            </td>

                            {/* I */}
                            <td className="px-3 text-center text-xs text-neutral-text-secondary tabular-nums">
                              {risk.impact}
                            </td>

                            {/* Severity chip */}
                            <td className="px-4">
                              <RiskChip severity={risk.severity} showScore />
                            </td>

                            {/* Owner — initials avatar + display name (design conformance) */}
                            <td className="px-4">
                              {risk.owner ? (
                                <span className="flex items-center gap-2 min-w-0">
                                  <span
                                    className="inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0
                                bg-neutral-surface-sunken border border-neutral-border
                                text-xs font-semibold text-neutral-text-primary tppm-mono"
                                    aria-hidden="true"
                                  >
                                    {risk.owner_initials ?? '?'}
                                  </span>
                                  <span className="text-xs text-neutral-text-secondary truncate">
                                    {risk.owner_name ?? 'Assigned'}
                                  </span>
                                </span>
                              ) : (
                                <span
                                  className="text-xs text-neutral-text-disabled"
                                  aria-label="Unassigned"
                                >
                                  —
                                </span>
                              )}
                            </td>

                            {/* Quick-edit affordance — visible on hover/focus-within (ADR-0044) on
                                desktop; always visible and a 44px target below `md` (touch has no
                                hover — rule 247). */}
                            <td className="px-2 text-center">
                              <button
                                type="button"
                                aria-label={`Edit risk: ${risk.title}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openRiskEdit(risk);
                                }}
                                className="opacity-0 max-md:opacity-100 group-hover:opacity-100 focus:opacity-100
                            h-11 w-11 md:h-8 md:w-8 flex items-center justify-center rounded-control
                            text-neutral-text-secondary hover:text-neutral-text-primary
                            focus:outline-none focus:ring-2
                            focus:ring-brand-primary focus:ring-offset-1"
                              >
                                ✎
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        {/* Drawer — rendered as a flex sibling so the desktop variant
            (`flex w-[480px]`, RiskDrawer.tsx) lays out alongside the table
            column instead of stacking below the page (rule 89). RiskDrawer
            renders one shell per breakpoint; the mobile bottom sheet uses
            `fixed` positioning so it is unaffected by this flex row. */}
        {isDrawerOpen && (
          <RiskDrawer
            projectId={projectId}
            risk={selectedRisk ?? null}
            isOpen={isDrawerOpen}
            onClose={closeDrawer}
            initialEditing={editMode}
          />
        )}
      </div>

      {/* Mobile FAB (rule 90) */}
      <button
        type="button"
        onClick={openCreate}
        className="md:hidden fixed bottom-16 right-4 w-14 h-14 rounded-full
          bg-brand-primary border border-brand-primary-dark
          flex items-center justify-center
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-2
          z-20"
        aria-label="Add risk"
      >
        <span className="text-neutral-text-inverse text-2xl leading-none" aria-hidden="true">
          +
        </span>
      </button>

      {/* Import-from-CSV modal (issue 223) — write-gated open trigger; the modal
          itself owns the upload → result state machine. */}
      {isImportOpen && (
        <RiskImportModal projectId={projectId} onClose={() => setIsImportOpen(false)} />
      )}
    </div>
  );
}
