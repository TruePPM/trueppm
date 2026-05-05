import { useEffect, useRef, useState } from 'react';
import type { Risk } from '@/api/types';
import { useRisks } from '@/hooks/useRisks';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjects } from '@/hooks/useProjects';
import { RiskChip } from './RiskChip';
import { RiskMatrix, type SelectedCell } from './RiskMatrix';
import { RiskDrawer } from './RiskDrawer';
import { exportRisksToCSV } from './riskExport';

const STATUS_LABELS: Record<Risk['status'], string> = {
  OPEN:       'Open',
  MITIGATING: 'Mitigating',
  RESOLVED:   'Resolved',
  ACCEPTED:   'Accepted',
  CLOSED:     'Closed',
};

/** Format a Risk's short_id for display: "00000007" → "R-007", "a3f1" → "R-A3F1". */
function formatRiskId(shortId: string): string {
  if (!shortId) return 'R-???';
  if (/^\d+$/.test(shortId)) {
    return `R-${String(parseInt(shortId, 10)).padStart(3, '0')}`;
  }
  return `R-${shortId.slice(0, 4).toUpperCase()}`;
}

export function RiskRegisterView() {
  const projectId = useProjectId() ?? '';
  const { risks, isLoading, error } = useRisks(projectId || null);
  const { data: projects } = useProjects();
  const [showHeatmap, setShowHeatmap] = useState(true);

  // null = drawer closed, undefined = create mode, Risk = edit mode
  const [selectedRisk, setSelectedRisk] = useState<Risk | null | undefined>(null);

  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
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
      <div className="flex h-full items-center justify-center bg-neutral-surface">
        <p className="text-sm text-neutral-text-secondary">Select a project to view risks.</p>
      </div>
    );
  }

  const isDrawerOpen = selectedRisk !== null;
  const criticalCount = risks.filter((r) => r.severity >= 20).length;
  const highCount     = risks.filter((r) => r.severity >= 12 && r.severity < 20).length;

  // When a matrix cell is selected, filter the table to that P×I coordinate.
  const displayRisks = selectedCell
    ? risks.filter((r) => r.probability === selectedCell.probability && r.impact === selectedCell.impact)
    : risks;

  // Overdue: MITIGATING status + mitigation_due_date in the past (client-side, ADR-0043)
  const todayIso = new Date().toISOString().slice(0, 10);

  // Project slug for CSV filename — derived from name since the Project type has no slug field.
  const projectSlug = (projectName ?? projectId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || projectId;

  function openCreate() { setEditMode(false); setSelectedRisk(undefined); }
  function openRisk(risk: Risk) { setEditMode(false); setSelectedRisk(risk); }
  function openRiskEdit(risk: Risk) { setEditMode(true); setSelectedRisk(risk); }
  function closeDrawer() { setEditMode(false); setSelectedRisk(null); }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-neutral-surface">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 shrink-0">
        {/* Breadcrumb + heading */}
        <div className="min-w-0 flex flex-col gap-1">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
            <span className="truncate">{projectName ?? 'Project'}</span>
            <span aria-hidden="true" className="text-neutral-text-disabled">/</span>
            <span>Risks</span>
          </nav>
          <h1 className="text-2xl font-semibold text-neutral-text-primary leading-tight">
            Risk register
          </h1>
        </div>

        {/* Desktop toolbar — count chips + heatmap toggle + new risk */}
        <div className="hidden md:flex items-center gap-2 shrink-0 pt-1">
          {!isLoading && !error && criticalCount > 0 && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
                bg-semantic-critical text-white"
              aria-label={`${criticalCount} critical risk${criticalCount !== 1 ? 's' : ''}`}
            >
              {criticalCount} critical
            </span>
          )}
          {!isLoading && !error && highCount > 0 && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
                bg-brand-accent-dark text-white"
              aria-label={`${highCount} high risk${highCount !== 1 ? 's' : ''}`}
            >
              {highCount} high
            </span>
          )}

          <button
            type="button"
            onClick={() => setShowHeatmap((v) => !v)}
            aria-pressed={showHeatmap}
            className="inline-flex items-center gap-1 h-8 px-3 rounded text-xs font-medium
              border border-neutral-border text-neutral-text-primary bg-neutral-surface
              hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-1"
          >
            Heatmap
            <span aria-hidden="true" className="text-neutral-text-disabled text-xs leading-none mt-px">▾</span>
          </button>

          {risks.length > 0 && (
            <button
              type="button"
              onClick={() => exportRisksToCSV(displayRisks, projectSlug)}
              className="inline-flex items-center gap-1 h-8 px-3 rounded text-xs font-medium
                border border-neutral-border text-neutral-text-secondary bg-neutral-surface
                hover:text-neutral-text-primary hover:bg-neutral-surface-raised
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-1"
            >
              Export CSV
            </button>
          )}

          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1 h-8 px-3 rounded text-sm font-medium
              text-neutral-text-inverse bg-brand-primary border border-brand-primary-dark
              hover:bg-brand-primary-dark
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-1"
          >
            + New risk
          </button>
        </div>

        {/* Mobile overflow menu (< md) — exposes Export CSV (ADR-0043) and other low-frequency actions */}
        {risks.length > 0 && (
          <div ref={overflowRef} className="md:hidden relative shrink-0 pt-1">
            <button
              type="button"
              onClick={() => setIsOverflowOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={isOverflowOpen}
              aria-label="More actions"
              className="inline-flex items-center justify-center w-10 h-10 rounded
                text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-1"
            >
              <span aria-hidden="true" className="text-xl leading-none">⋯</span>
            </button>
            {isOverflowOpen && (
              <div
                role="menu"
                className="absolute right-0 top-11 min-w-[180px] z-30 rounded-md
                  bg-neutral-surface border border-neutral-border py-1"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    exportRisksToCSV(displayRisks, projectSlug);
                    setIsOverflowOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-neutral-text-primary
                    hover:bg-neutral-surface-raised
                    focus-visible:outline-none focus-visible:bg-neutral-surface-raised"
                >
                  Export CSV
                </button>
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
              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
                bg-semantic-critical text-white"
              aria-label={`${criticalCount} critical risk${criticalCount !== 1 ? 's' : ''}`}
            >
              {criticalCount} critical
            </span>
          )}
          {highCount > 0 && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
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
              border border-neutral-border rounded-lg p-5
              bg-neutral-surface-raised overflow-auto"
            aria-label="Risk heatmap"
          >
            {isLoading && (
              <div className="flex-1 rounded animate-pulse bg-neutral-border/30" aria-hidden="true" />
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
                  className="h-14 rounded bg-neutral-surface-raised animate-pulse border border-neutral-border"
                  aria-hidden="true"
                />
              ))}
            </div>
          )}

          {/* Error */}
          {!isLoading && error && (
            <div
              role="alert"
              className="flex flex-col items-center justify-center gap-3 py-16 text-center"
            >
              <p className="text-sm text-semantic-critical">Failed to load risks.</p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="h-8 px-3 rounded text-sm font-medium border border-neutral-border
                  text-neutral-text-secondary hover:text-neutral-text-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                  dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-1"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty — no risks at all */}
          {!isLoading && !error && risks.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16">
              <p className="text-sm text-neutral-text-secondary">No risks recorded yet.</p>
              <button
                type="button"
                onClick={openCreate}
                className="text-sm text-brand-primary hover:underline
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                  dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-1 rounded"
              >
                + Add your first risk
              </button>
            </div>
          )}

          {/* Table */}
          {!isLoading && !error && risks.length > 0 && (
            <>
              {/* Matrix cell-filter chip */}
              {selectedCell && (
                <div className="flex items-center gap-2 mb-2 px-1 shrink-0" role="status" aria-live="polite">
                  <span className="text-xs text-neutral-text-secondary">Filtered to</span>
                  <span className="inline-flex items-center text-xs font-medium tppm-mono
                    bg-brand-primary/10 text-brand-primary border border-brand-primary/20 rounded px-2 py-0.5">
                    P{selectedCell.probability} × I{selectedCell.impact}
                  </span>
                  <span className="text-xs text-neutral-text-disabled">
                    {displayRisks.length} of {risks.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedCell(null)}
                    className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary ml-1
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                      focus-visible:ring-offset-1 rounded"
                  >
                    Clear filter
                  </button>
                </div>
              )}
            <div className="flex-1 overflow-auto rounded-lg border border-neutral-border">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-neutral-surface-raised border-b border-neutral-border">
                    <th scope="col" className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[88px]">
                      ID
                    </th>
                    <th scope="col" className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide">
                      Risk
                    </th>
                    <th scope="col" className="text-center px-3 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-10">
                      P
                    </th>
                    <th scope="col" className="text-center px-3 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-10">
                      I
                    </th>
                    <th scope="col" className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[148px]">
                      Severity
                    </th>
                    <th scope="col" className="text-center px-3 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[72px]">
                      Trend
                    </th>
                    <th scope="col" className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[180px]">
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

                    return (
                    <tr
                      key={risk.id}
                      onClick={() => openRisk(risk)}
                      className={[
                        'group h-14 border-b border-neutral-border last:border-b-0 cursor-pointer',
                        isOverdue ? 'bg-semantic-at-risk/5 hover:bg-semantic-at-risk/10' : 'hover:bg-neutral-surface-raised',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
                        'dark:focus-visible:ring-semantic-on-track focus-visible:ring-inset',
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
                      {/* ID */}
                      <td className="px-4 text-xs text-neutral-text-secondary tppm-mono">
                        {formatRiskId(risk.short_id)}
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
                              <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium
                                bg-semantic-at-risk/10 text-semantic-at-risk border border-semantic-at-risk/30"
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

                      {/* Trend — placeholder arrow (no trend data in API) */}
                      <td className="px-3 text-center" aria-label="No trend data available">
                        <span className="text-base text-neutral-text-disabled" aria-hidden="true">→</span>
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
                          <span className="text-xs text-neutral-text-disabled" aria-label="Unassigned">—</span>
                        )}
                      </td>

                      {/* Quick-edit affordance — visible on hover/focus-within (ADR-0044) */}
                      <td className="px-2 text-center">
                        <button
                          type="button"
                          aria-label={`Edit risk: ${risk.title}`}
                          onClick={(e) => { e.stopPropagation(); openRiskEdit(risk); }}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100
                            w-8 h-8 flex items-center justify-center rounded
                            text-neutral-text-secondary hover:text-neutral-text-primary
                            focus-visible:outline-none focus-visible:ring-2
                            focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                        >
                          ✎
                        </button>
                      </td>
                    </tr>
                  ); })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>

        {/* Drawer — rendered as a flex sibling so the desktop variant
            (`hidden md:flex w-[480px]`, RiskDrawer.tsx) lays out alongside
            the table column instead of stacking below the page (rule 89).
            The mobile bottom sheet uses `fixed` positioning so it is
            unaffected by participation in this flex row. */}
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
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-2
          z-20"
        aria-label="Add risk"
      >
        <span className="text-neutral-text-inverse text-2xl leading-none" aria-hidden="true">+</span>
      </button>
    </div>
  );
}
